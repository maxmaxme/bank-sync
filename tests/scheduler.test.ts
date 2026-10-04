import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkConsentExpiry, isSyncDue } from '../src/scheduler.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { LAST_SYNC_KV } from '../src/sync.ts';
import { RecordingNotifier, silentLog } from './helpers.ts';

const HOUR = 3600_000;
let store: Store;
let notifier: RecordingNotifier;

beforeEach(() => {
  store = openStore(':memory:');
  notifier = new RecordingNotifier();
});
afterEach(() => store.close());

describe('isSyncDue', () => {
  it('is due with no history, and again only after the interval', () => {
    const t = Date.UTC(2026, 9, 3);
    expect(isSyncDue(store, t, 8 * HOUR)).toBe(true);
    store.setKv(LAST_SYNC_KV, String(t));
    expect(isSyncDue(store, t + 7 * HOUR, 8 * HOUR)).toBe(false);
    expect(isSyncDue(store, t + 8 * HOUR, 8 * HOUR)).toBe(true);
  });
});

describe('checkConsentExpiry', () => {
  function session(validUntil: string) {
    store.saveSession(
      { sessionId: 's1', aspspName: 'imagin', aspspCountry: 'ES', validUntil, createdAt: 0, revokedAt: null },
      [],
    );
  }
  const run = (iso: string) => checkConsentExpiry({ store, notifier, log: silentLog, now: () => new Date(iso) });

  it('stays quiet while the consent has more than a week left', async () => {
    session('2026-12-01T00:00:00Z');
    await run('2026-10-03T12:00:00Z');
    expect(notifier.events).toEqual([]);
  });

  it('reminds once per day in the last week, then once when it lapses', async () => {
    session('2026-10-06T00:00:00Z');
    await run('2026-10-03T09:00:00Z');
    await run('2026-10-03T18:00:00Z');
    await run('2026-10-04T09:00:00Z');
    await run('2026-10-07T09:00:00Z');
    await run('2026-10-08T09:00:00Z');
    expect(notifier.events).toEqual(['expiring:imagin:3', 'expiring:imagin:2', 'expired:imagin']);
  });

  it('ignores revoked sessions', async () => {
    session('2026-10-04T00:00:00Z');
    store.revokeSession('s1', 0);
    await run('2026-10-03T09:00:00Z');
    expect(notifier.events).toEqual([]);
  });
});
