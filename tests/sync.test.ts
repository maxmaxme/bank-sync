import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnableBankingError } from '../src/enablebanking/client.ts';
import type { AccountApi, BalancesResponse, TransactionsPage } from '../src/enablebanking/types.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { addDays, pickBalance, Syncer, type SyncDeps } from '../src/sync.ts';
import { RecordingNotifier, silentLog, tx } from './helpers.ts';

const NOW = new Date('2026-10-03T12:00:00Z');

type TxCall = { uid: string; dateFrom: string; continuationKey?: string; strategy?: string };

class FakeApi implements AccountApi {
  readonly txCalls: TxCall[] = [];
  pages: TransactionsPage[] = [{ transactions: [] }];
  failWith: Error | null = null;
  failOnce = false;
  balances: BalancesResponse = {
    balances: [{ balance_amount: { currency: 'EUR', amount: '150.00' }, balance_type: 'CLBD' }],
  };

  async getTransactions(uid: string, opts: Omit<TxCall, 'uid'>): Promise<TransactionsPage> {
    this.txCalls.push({ uid, ...opts });
    if (this.failWith) {
      const err = this.failWith;
      if (this.failOnce) {
        this.failWith = null;
      }
      throw err;
    }
    const idx = opts.continuationKey ? Number(opts.continuationKey) : 0;
    return this.pages[idx] ?? { transactions: [] };
  }

  async getBalances(): Promise<BalancesResponse> {
    return this.balances;
  }
}

let store: Store;
let api: FakeApi;
let notifier: RecordingNotifier;
let deps: SyncDeps;

beforeEach(() => {
  store = openStore(':memory:');
  api = new FakeApi();
  notifier = new RecordingNotifier();
  deps = { api, store, notifier, log: silentLog, now: () => NOW };
  store.saveSession(
    {
      sessionId: 's1',
      aspspName: 'imagin',
      aspspCountry: 'ES',
      validUntil: '2027-03-01T00:00:00Z',
      createdAt: NOW.getTime(),
      revokedAt: null,
    },
    [{ accountKey: 'hash-A', uid: 'uid-1', iban: null, name: null, currency: 'EUR' }],
  );
});
afterEach(() => store.close());

describe('Syncer', () => {
  it('first sync asks for two years with the longest strategy and follows pages', async () => {
    api.pages = [
      { transactions: [tx({ entry_reference: 'a' })], continuation_key: '1' },
      { transactions: [tx({ entry_reference: 'b' })], continuation_key: null },
    ];
    const summary = await new Syncer(deps).run('connect');

    expect(summary).toMatchObject({ ok: true, added: 2 });
    expect(api.txCalls).toEqual([
      { uid: 'uid-1', dateFrom: '2024-10-03', continuationKey: undefined, strategy: 'longest' },
      { uid: 'uid-1', dateFrom: '2024-10-03', continuationKey: '1', strategy: 'longest' },
    ]);
    const [acc] = store.listAccounts();
    expect(acc).toMatchObject({ initialSyncDone: true, balanceCents: 15000, lastError: null });
  });

  it('later syncs re-read from the newest booked date minus the overlap', async () => {
    api.pages = [{ transactions: [tx({ entry_reference: 'a', booking_date: '2026-09-28' })] }];
    const syncer = new Syncer(deps);
    await syncer.run('connect');
    api.txCalls.length = 0;
    await syncer.run('schedule');
    expect(api.txCalls).toEqual([
      { uid: 'uid-1', dateFrom: addDays('2026-09-28', -10), continuationKey: undefined, strategy: 'default' },
    ]);
  });

  it('falls back to 90 days when the bank rejects the long window', async () => {
    api.failWith = new EnableBankingError(400, 'WRONG_TRANSACTIONS_PERIOD', 'too far back');
    api.failOnce = true;
    const summary = await new Syncer(deps).run('connect');
    expect(summary.ok).toBe(true);
    expect(api.txCalls.map((c) => c.dateFrom)).toEqual(['2024-10-03', '2026-07-05']);
  });

  it('does not retry a rate-limited first sync', async () => {
    api.failWith = new EnableBankingError(429, 'ASPSP_RATE_LIMIT_EXCEEDED', 'slow down');
    const summary = await new Syncer(deps).run('connect');
    expect(summary.ok).toBe(false);
    expect(api.txCalls).toHaveLength(1);
    expect(store.listAccounts()[0]?.lastError).toContain('slow down');
  });

  it('notifies once on failure and once on recovery', async () => {
    const syncer = new Syncer(deps);
    api.failWith = new Error('bank down');
    await syncer.run('schedule');
    await syncer.run('schedule');
    api.failWith = null;
    await syncer.run('schedule');
    expect(notifier.events).toEqual(['failed:bank down', 'recovered']);
  });

  it('shares an in-flight run between concurrent callers', async () => {
    const syncer = new Syncer(deps);
    const [a, b] = [syncer.run('manual'), syncer.run('schedule')];
    expect(a).toBe(b);
    await a;
    expect(api.txCalls).toHaveLength(1);
    expect(store.recentSyncRuns(10)).toHaveLength(1);
  });
});

describe('pickBalance', () => {
  it('prefers interim available over booked', () => {
    const pick = pickBalance([
      { balance_amount: { currency: 'EUR', amount: '1' }, balance_type: 'CLBD' },
      { balance_amount: { currency: 'EUR', amount: '2' }, balance_type: 'ITAV' },
    ]);
    expect(pick?.balance_amount.amount).toBe('2');
  });

  it('falls back to the first balance of an unknown type', () => {
    expect(
      pickBalance([{ balance_amount: { currency: 'EUR', amount: '3' }, balance_type: 'OTHR' }])?.balance_amount.amount,
    ).toBe('3');
    expect(pickBalance([])).toBeNull();
  });
});
