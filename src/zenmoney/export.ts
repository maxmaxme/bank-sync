import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { ZenMoneyError } from './client.ts';
import type { ZenMoneyApi, ZmAccount, ZmSuggestion, ZmTransaction } from './types.ts';
import { parseJson } from '../json.ts';
import type { AccountRow, AccountView, Store, TransactionRow } from '../storage/types.ts';
import type { Notifier } from '../notify/types.ts';
import type { Logger } from '../logger.ts';

const BATCH = 100;
const MAX_BATCHES_PER_ACCOUNT = 20;
const REFERENCE_CACHE_MS = 10 * 60_000;
/** Ids written to rows we deliberately never send (zero amounts). */
export const SKIPPED_ZM_ID = 'skipped';
export const LAST_EXPORT_KV = 'zm_last_export';
const LAST_EXPORT_OK_KV = 'zm_last_export_ok';

export interface ExportDeps {
  api: ZenMoneyApi;
  store: Store;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
}

export interface ZenReference {
  /** Non-archived, non-debt accounts — the ones a bank account can export into. */
  accounts: ZmAccount[];
  /** Instrument id → ISO currency code. */
  currencies: Map<number, string>;
}

// Stored as JSON in kv; a value that doesn't fit reads as "no result yet".
const ExportResultSchema = v.object({
  at: v.number(),
  ok: v.boolean(),
  exported: v.number(),
  error: v.nullable(v.string()),
});
export type ExportResult = v.InferOutput<typeof ExportResultSchema>;

/** The one field of the stored PSD2 transaction the export needs. */
const MccSchema = v.object({ merchant_category_code: v.nullish(v.string()) });

/** A bank account with a ZenMoney target and start date chosen in the UI. */
type MappedAccount = AccountRow & { zmAccountId: string; zmSince: string };

/**
 * ZenMoney transaction id derived from our own row key, so a retry after a
 * lost response overwrites the same object instead of creating a duplicate.
 */
export function zmIdFor(accountKey: string, txKey: string): string {
  const h = createHash('sha256').update(`bank-sync:${accountKey}:${txKey}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** ZenMoney's own bank imports keep the last 4 digits of the account number in `syncID`. */
export function suggestZenAccount(bank: Pick<AccountRow, 'iban'>, accounts: readonly ZmAccount[]): ZmAccount | null {
  const last4 = bank.iban?.replace(/\s/g, '').slice(-4);
  if (!last4) {
    return null;
  }
  const hits = accounts.filter((a) => a.syncID?.some((id) => id.endsWith(last4)));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

function mccOf(row: TransactionRow): number | null {
  const parsed = v.safeParse(MccSchema, parseJson(row.raw));
  const mcc = Number.parseInt((parsed.success && parsed.output.merchant_category_code) || '', 10);
  return Number.isFinite(mcc) ? mcc : null;
}

export function toZmTransaction(
  row: TransactionRow,
  account: ZmAccount,
  instrument: number,
  suggestion: ZmSuggestion | undefined,
  nowSec: number,
): ZmTransaction {
  const amount = Math.abs(row.amountCents) / 100;
  const isOutcome = row.amountCents < 0;
  const original = row.counterparty;
  return {
    id: zmIdFor(row.accountKey, row.txKey),
    changed: nowSec,
    created: nowSec,
    user: account.user,
    deleted: false,
    hold: false,
    // Shows up as "new" in the app, so it gets a glance and a category check.
    viewed: false,
    // Non-transfer: both sides point at the same account, one amount is 0.
    incomeInstrument: instrument,
    incomeAccount: account.id,
    income: isOutcome ? 0 : amount,
    outcomeInstrument: instrument,
    outcomeAccount: account.id,
    outcome: isOutcome ? amount : 0,
    tag: suggestion?.tag?.length ? suggestion.tag : null,
    merchant: suggestion?.merchant ?? null,
    payee: suggestion?.payee || original,
    originalPayee: original,
    comment: row.description && row.description !== original ? row.description : null,
    // The day the money actually moved (card purchase), not when the bank posted it.
    date: row.transactionDate ?? row.bookingDate ?? row.txDate ?? '',
    mcc: mccOf(row),
    reminderMarker: null,
    opIncome: null,
    opIncomeInstrument: null,
    opOutcome: null,
    opOutcomeInstrument: null,
    latitude: null,
    longitude: null,
    incomeBankID: null,
    outcomeBankID: null,
    qrCode: null,
  };
}

export class ZenExporter {
  private readonly deps: ExportDeps;
  private cache: { at: number; ref: ZenReference } | null = null;
  private running: Promise<ExportResult> | null = null;

  constructor(deps: ExportDeps) {
    this.deps = deps;
  }

  /** Accounts and currencies, fetched without pulling the whole transaction history. */
  async reference(): Promise<ZenReference> {
    const now = this.deps.now().getTime();
    if (this.cache && now - this.cache.at < REFERENCE_CACHE_MS) {
      return this.cache.ref;
    }
    // serverTimestamp = now: "nothing to catch up on", plus the forced reference tables.
    const diff = await this.deps.api.diff({
      serverTimestamp: Math.floor(now / 1000),
      forceFetch: ['instrument', 'user', 'account'],
    });
    const ref: ZenReference = {
      accounts: (diff.account ?? [])
        .filter((a) => !a.archive && a.type !== 'debt')
        .sort((a, b) => a.title.localeCompare(b.title)),
      currencies: new Map((diff.instrument ?? []).map((i) => [i.id, i.shortTitle])),
    };
    this.cache = { at: now, ref };
    return ref;
  }

  lastResult(): ExportResult | null {
    const raw = this.deps.store.getKv(LAST_EXPORT_KV);
    const parsed = v.safeParse(ExportResultSchema, raw ? parseJson(raw) : undefined);
    return parsed.success ? parsed.output : null;
  }

  run(): Promise<ExportResult> {
    if (!this.running) {
      this.running = this.doRun().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doRun(): Promise<ExportResult> {
    const { store, log } = this.deps;
    const at = this.deps.now().getTime();
    let exported = 0;
    const errors: string[] = [];
    let authError = false;

    const mapped = store
      .listAccounts()
      .filter((a): a is AccountView & MappedAccount => Boolean(a.zmAccountId && a.zmSince));
    for (const account of mapped) {
      try {
        exported += await this.exportAccount(account);
      } catch (err) {
        authError ||= err instanceof ZenMoneyError && err.isAuth;
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, accountKey: account.accountKey }, 'zenmoney export failed');
        errors.push(`${account.name ?? account.iban ?? account.accountKey}: ${message}`);
      }
    }

    const result: ExportResult = { at, ok: errors.length === 0, exported, error: errors.join('\n') || null };
    store.setKv(LAST_EXPORT_KV, JSON.stringify(result));
    if (exported > 0) {
      log.info({ exported }, 'exported to zenmoney');
    }
    await this.notifyTransition(result, authError);
    return result;
  }

  private async exportAccount(account: MappedAccount): Promise<number> {
    const { store, api } = this.deps;
    let exported = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_ACCOUNT; batch++) {
      const rows = store.unexportedTransactions(account.accountKey, account.zmSince, BATCH);
      if (rows.length === 0) {
        break;
      }
      const ref = await this.reference();
      const target = ref.accounts.find((a) => a.id === account.zmAccountId);
      if (!target || target.instrument === null) {
        throw new Error('the chosen ZenMoney account no longer exists (or is archived) — pick another one');
      }
      const instrument = target.instrument;
      const currency = ref.currencies.get(instrument);

      const nowMs = this.deps.now().getTime();
      const sendable: TransactionRow[] = [];
      for (const row of rows) {
        if (row.amountCents === 0) {
          store.markExported(account.accountKey, row.txKey, SKIPPED_ZM_ID, nowMs);
        } else if (row.currency !== currency) {
          throw new Error(`transaction in ${row.currency}, but the ZenMoney account is in ${currency ?? '?'}`);
        } else {
          sendable.push(row);
        }
      }
      if (sendable.length === 0) {
        continue;
      }

      const suggestions = await this.suggest(sendable);
      const nowSec = Math.floor(nowMs / 1000);
      const sent = sendable.map((row, i) => ({
        row,
        zm: toZmTransaction(row, target, instrument, suggestions[i], nowSec),
      }));
      await api.diff({ serverTimestamp: nowSec, transaction: sent.map((s) => s.zm) });

      for (const { row, zm } of sent) {
        store.markExported(account.accountKey, row.txKey, zm.id, nowMs);
      }
      exported += sendable.length;
    }
    return exported;
  }

  /** ZenMoney's own payee → merchant/category guess. Best effort: no suggestion is fine. */
  private async suggest(rows: readonly TransactionRow[]): Promise<(ZmSuggestion | undefined)[]> {
    const withPayee = rows.flatMap((r, i) => (r.counterparty ? [{ i, payee: r.counterparty }] : []));
    if (withPayee.length === 0) {
      return [];
    }
    try {
      const res = await this.deps.api.suggest(withPayee.map((x) => ({ payee: x.payee })));
      const out: (ZmSuggestion | undefined)[] = [];
      withPayee.forEach((x, j) => {
        out[x.i] = res[j];
      });
      return out;
    } catch (err) {
      if (err instanceof ZenMoneyError && err.isAuth) {
        throw err;
      }
      this.deps.log.warn({ err }, 'zenmoney suggest failed, exporting without categories');
      return [];
    }
  }

  private async notifyTransition(result: ExportResult, authError: boolean): Promise<void> {
    const { store, notifier, log } = this.deps;
    const wasOk = store.getKv(LAST_EXPORT_OK_KV) !== '0';
    store.setKv(LAST_EXPORT_OK_KV, result.ok ? '1' : '0');
    try {
      if (wasOk && !result.ok) {
        await notifier.exportFailed(result.error ?? '', authError);
      } else if (!wasOk && result.ok) {
        await notifier.exportRecovered();
      }
    } catch (err) {
      log.error({ err }, 'notification failed');
    }
  }
}
