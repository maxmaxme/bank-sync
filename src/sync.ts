import { EnableBankingError } from './enablebanking/client.ts';
import type { AccountApi, Balance, Transaction } from './enablebanking/types.ts';
import { parseAmountToCents } from './money.ts';
import { normalizeTransactions } from './transactions.ts';
import type { AccountRow, Store } from './storage/types.ts';
import type { Notifier } from './notify/types.ts';
import type { Logger } from './logger.ts';

/** First sync after a consent asks for this much; banks clamp it to what they keep. */
const INITIAL_HISTORY_DAYS = 730;
/** Fallback when a bank rejects the long window outright. */
const FALLBACK_HISTORY_DAYS = 90;
/** Re-read this many days before the newest booked row: late bookings, pending → booked. */
const OVERLAP_DAYS = 10;
const MAX_PAGES = 200;

/** Preference order when a bank reports several balance types. */
const BALANCE_PREFERENCE = ['ITAV', 'CLAV', 'XPCD', 'ITBD', 'CLBD', 'OPAV', 'OPBD'];

export const LAST_SYNC_KV = 'last_sync_at';
const LAST_SYNC_OK_KV = 'last_sync_ok';

export interface SyncDeps {
  api: AccountApi;
  store: Store;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  /** Runs after every sync, e.g. pushing new rows on to ZenMoney. Its failures don't fail the sync. */
  afterRun?: () => Promise<unknown>;
}

interface AccountSyncResult {
  accountKey: string;
  added: number;
  error: string | null;
}

export interface SyncSummary {
  ok: boolean;
  added: number;
  accounts: AccountSyncResult[];
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function pickBalance(balances: readonly Balance[]): Balance | null {
  for (const type of BALANCE_PREFERENCE) {
    const hit = balances.find((b) => b.balance_type === type);
    if (hit) {
      return hit;
    }
  }
  return balances[0] ?? null;
}

async function fetchAllTransactions(
  api: AccountApi,
  uid: string,
  dateFrom: string,
  strategy: 'default' | 'longest',
): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let continuationKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api.getTransactions(uid, { dateFrom, continuationKey, strategy });
    all.push(...res.transactions);
    if (!res.continuation_key) {
      return all;
    }
    continuationKey = res.continuation_key;
  }
  throw new Error(`Gave up after ${MAX_PAGES} pages of transactions`);
}

/** Fetch, store and return how many rows were new for one account. */
async function syncAccount(deps: SyncDeps, account: AccountRow): Promise<number> {
  const now = deps.now();
  const today = isoDate(now);
  const latest = deps.store.latestTxDate(account.accountKey);
  const initial = !account.initialSyncDone || latest === null;

  let dateFrom = initial ? addDays(today, -INITIAL_HISTORY_DAYS) : addDays(latest, -OVERLAP_DAYS);
  let txs: Transaction[];
  try {
    txs = await fetchAllTransactions(deps.api, account.uid, dateFrom, initial ? 'longest' : 'default');
  } catch (err) {
    const rejected = err instanceof EnableBankingError && err.status >= 400 && err.status < 500;
    const rateLimited = err instanceof EnableBankingError && err.code === 'ASPSP_RATE_LIMIT_EXCEEDED';
    if (!initial || !rejected || rateLimited) {
      throw err;
    }
    deps.log.warn({ err, accountKey: account.accountKey }, 'long history rejected, retrying with 90 days');
    dateFrom = addDays(today, -FALLBACK_HISTORY_DAYS);
    txs = await fetchAllTransactions(deps.api, account.uid, dateFrom, 'default');
  }

  const added = deps.store.applyTransactions(account.accountKey, dateFrom, normalizeTransactions(txs), now.getTime());

  // Balance is nice-to-have: a failure here shouldn't throw away the transactions.
  let balanceCents: number | null = null;
  let balanceCurrency: string | null = null;
  try {
    const balance = pickBalance((await deps.api.getBalances(account.uid)).balances);
    if (balance) {
      balanceCents = parseAmountToCents(balance.balance_amount.amount);
      balanceCurrency = balance.balance_amount.currency;
    }
  } catch (err) {
    deps.log.warn({ err, accountKey: account.accountKey }, 'balance fetch failed');
  }

  deps.store.recordAccountSync(account.accountKey, { ok: true, balanceCents, balanceCurrency }, now.getTime());
  deps.log.info({ accountKey: account.accountKey, dateFrom, fetched: txs.length, added, initial }, 'account synced');
  return added;
}

/**
 * Runs every active account once. Concurrent callers share the in-flight run
 * instead of starting a second one — each run spends the bank's daily quota.
 */
export class Syncer {
  private readonly deps: SyncDeps;
  private running: Promise<SyncSummary> | null = null;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  run(trigger: string): Promise<SyncSummary> {
    if (!this.running) {
      this.running = this.doRun(trigger).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doRun(trigger: string): Promise<SyncSummary> {
    const { store, log, notifier } = this.deps;
    const startedAt = this.deps.now().getTime();
    store.setKv(LAST_SYNC_KV, String(startedAt));
    const runId = store.startSyncRun(trigger, startedAt);

    const results: AccountSyncResult[] = [];
    for (const account of store.activeAccounts(startedAt)) {
      try {
        const added = await syncAccount(this.deps, account);
        results.push({ accountKey: account.accountKey, added, error: null });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error({ err, accountKey: account.accountKey }, 'account sync failed');
        store.recordAccountSync(account.accountKey, { ok: false, error }, this.deps.now().getTime());
        results.push({ accountKey: account.accountKey, added: 0, error });
      }
    }

    const failures = results.filter((r) => r.error !== null);
    const summary: SyncSummary = {
      ok: failures.length === 0,
      added: results.reduce((n, r) => n + r.added, 0),
      accounts: results,
    };
    store.finishSyncRun(
      runId,
      {
        ok: summary.ok,
        added: summary.added,
        error: failures.map((f) => `${f.accountKey}: ${f.error}`).join('\n') || null,
      },
      this.deps.now().getTime(),
    );

    // Notify on transitions only, so a bank outage is one message, not one per run.
    const wasOk = store.getKv(LAST_SYNC_OK_KV) !== '0';
    store.setKv(LAST_SYNC_OK_KV, summary.ok ? '1' : '0');
    try {
      if (wasOk && !summary.ok) {
        await notifier.syncFailed(failures.map((f) => f.error ?? '').join('\n'));
      } else if (!wasOk && summary.ok) {
        await notifier.syncRecovered();
      }
    } catch (err) {
      log.error({ err }, 'notification failed');
    }

    if (this.deps.afterRun) {
      try {
        await this.deps.afterRun();
      } catch (err) {
        log.error({ err }, 'post-sync hook failed');
      }
    }

    return summary;
  }
}
