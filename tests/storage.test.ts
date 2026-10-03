import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/storage/sqlite.ts';
import { normalizeTransactions } from '../src/transactions.ts';
import type { Store } from '../src/storage/types.ts';
import { tx } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 3);
let store: Store;

function connect(sessionId: string, uid: string, validUntil = '2027-04-01T00:00:00Z') {
  store.saveSession(
    { sessionId, aspspName: 'imagin', aspspCountry: 'ES', validUntil, createdAt: T0, revokedAt: null },
    [{ accountKey: 'hash-A', uid, iban: 'ES0021000000000000000001', name: 'Cuenta', currency: 'EUR' }],
  );
}

beforeEach(() => {
  store = openStore(':memory:');
});
afterEach(() => {
  store.close();
});

describe('auth requests', () => {
  it('can be redeemed exactly once while fresh', () => {
    store.saveAuthRequest('n1', T0);
    expect(store.takeAuthRequest('n1', 3600_000, T0 + 1000)).toBe(true);
    expect(store.takeAuthRequest('n1', 3600_000, T0 + 2000)).toBe(false);
  });

  it('expire after the TTL', () => {
    store.saveAuthRequest('n1', T0);
    expect(store.takeAuthRequest('n1', 3600_000, T0 + 3600_001)).toBe(false);
  });
});

describe('sessions and accounts', () => {
  it('re-consent moves the account to the new session uid and asks for history again', () => {
    connect('s1', 'uid-1');
    store.recordAccountSync('hash-A', { ok: true, balanceCents: 100, balanceCurrency: 'EUR' }, T0);
    expect(store.activeAccounts(T0)[0]?.initialSyncDone).toBe(true);

    connect('s2', 'uid-2');
    const [acc] = store.activeAccounts(T0);
    expect(acc).toMatchObject({ uid: 'uid-2', sessionId: 's2', initialSyncDone: false, balanceCents: 100 });
  });

  it('excludes revoked and expired consents from active accounts', () => {
    connect('s1', 'uid-1', '2026-10-02T00:00:00Z');
    expect(store.activeAccounts(T0)).toHaveLength(0);
    connect('s2', 'uid-2');
    store.revokeSession('s2', T0);
    expect(store.activeAccounts(T0)).toHaveLength(0);
  });
});

describe('applyTransactions', () => {
  beforeEach(() => connect('s1', 'uid-1'));

  it('upserts and counts only unseen rows', () => {
    const batch = normalizeTransactions([tx({ entry_reference: 'a' }), tx({ entry_reference: 'b' })]);
    expect(store.applyTransactions('hash-A', '2026-09-01', batch, T0)).toBe(2);
    expect(store.applyTransactions('hash-A', '2026-09-01', batch, T0 + 1)).toBe(0);
    expect(store.queryTransactions({})).toHaveLength(2);
  });

  it('drops pending rows in the window that the bank no longer reports', () => {
    const pending = normalizeTransactions([
      tx({ entry_reference: 'p1', status: 'PDNG', booking_date: null, transaction_date: '2026-10-01' }),
    ]);
    store.applyTransactions('hash-A', '2026-09-20', pending, T0);

    const booked = normalizeTransactions([tx({ entry_reference: 'b1', booking_date: '2026-10-02' })]);
    store.applyTransactions('hash-A', '2026-09-20', booked, T0 + 1);

    expect(store.queryTransactions({}).map((r) => [r.txKey, r.status])).toEqual([['b1', 'BOOK']]);
  });

  it('keeps pending rows that fall before the re-fetched window', () => {
    const pending = normalizeTransactions([
      tx({ entry_reference: 'p1', status: 'PDNG', booking_date: null, transaction_date: '2026-09-01' }),
    ]);
    store.applyTransactions('hash-A', '2026-08-01', pending, T0);
    store.applyTransactions('hash-A', '2026-09-20', [], T0 + 1);
    expect(store.queryTransactions({})).toHaveLength(1);
  });

  it('reports the newest booked date and filters by range', () => {
    store.applyTransactions(
      'hash-A',
      '2026-01-01',
      normalizeTransactions([
        tx({ entry_reference: 'a', booking_date: '2026-09-01' }),
        tx({ entry_reference: 'b', booking_date: '2026-09-15' }),
        tx({ entry_reference: 'c', status: 'PDNG', booking_date: null, transaction_date: '2026-10-01' }),
      ]),
      T0,
    );
    expect(store.latestTxDate('hash-A')).toBe('2026-09-15');
    expect(store.queryTransactions({ from: '2026-09-10', to: '2026-09-30' }).map((r) => r.txKey)).toEqual(['b']);
  });
});

describe('kv and sync runs', () => {
  it('round-trips', () => {
    expect(store.getKv('x')).toBeNull();
    store.setKv('x', '1');
    store.setKv('x', '2');
    expect(store.getKv('x')).toBe('2');

    const id = store.startSyncRun('manual', T0);
    store.finishSyncRun(id, { ok: false, added: 0, error: 'boom' }, T0 + 5);
    expect(store.recentSyncRuns(5)).toEqual([
      { id, trigger: 'manual', startedAt: T0, finishedAt: T0 + 5, ok: false, added: 0, error: 'boom' },
    ]);
  });
});
