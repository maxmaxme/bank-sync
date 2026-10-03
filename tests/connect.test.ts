import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  accountKeyOf,
  completeConnect,
  ConnectError,
  encodeState,
  startConnect,
  stateNonce,
  type ConnectDeps,
} from '../src/connect.ts';
import type { SessionResponse } from '../src/enablebanking/types.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { silentLog } from './helpers.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const SESSION: SessionResponse = {
  session_id: 'sess-1',
  aspsp: { name: 'imagin', country: 'ES' },
  access: { valid_until: '2027-04-01T12:00:00Z' },
  accounts: [
    {
      uid: 'uid-1',
      identification_hash: 'hash-A',
      account_id: { iban: 'ES0021000000000000000001' },
      name: 'Cuenta imagin',
      currency: 'EUR',
    },
  ],
};

let store: Store;
let startAuthArgs: unknown[];
let syncs: string[];
let deps: ConnectDeps;

beforeEach(() => {
  store = openStore(':memory:');
  startAuthArgs = [];
  syncs = [];
  deps = {
    client: {
      startAuth: async (input) => {
        startAuthArgs.push(input);
        return { url: 'https://auth.enablebanking.com/ais/start?sessionid=x' };
      },
      createSession: async () => SESSION,
    },
    store,
    syncer: { run: async (trigger: string) => (syncs.push(trigger), { ok: true, added: 0, accounts: [] }) },
    redirectUrl: 'https://example.github.io/bank-sync/callback.html',
    log: silentLog,
    now: () => NOW,
  };
});
afterEach(() => store.close());

describe('state', () => {
  it('carries the nonce and the return base', () => {
    const state = encodeState('nonce-1', 'http://pi.home:8085');
    expect(stateNonce(state)).toBe('nonce-1');
    const suffix = state.slice(state.indexOf('.') + 1);
    expect(Buffer.from(suffix, 'base64url').toString()).toBe('http://pi.home:8085');
  });
});

describe('accountKeyOf', () => {
  it('prefers the stable identification hash, then IBAN, then uid', () => {
    expect(accountKeyOf({ uid: 'u', identification_hash: 'h', account_id: { iban: 'I' } })).toBe('h');
    expect(accountKeyOf({ uid: 'u', identification_hash: '', account_id: { iban: 'I' } })).toBe('I');
    expect(accountKeyOf({ uid: 'u', identification_hash: '' })).toBe('u');
  });
});

describe('connect flow', () => {
  async function start(): Promise<string> {
    await startConnect(
      deps,
      { name: 'imagin', country: 'ES', maximum_consent_validity: 180 * 86400 },
      'http://pi.home:8085',
    );
    return (startAuthArgs[0] as { state: string }).state;
  }

  it('requests the bank maximum consent minus a margin', async () => {
    await start();
    const { validUntil } = startAuthArgs[0] as { validUntil: Date };
    const days = (validUntil.getTime() - NOW.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(179.9);
    expect(days).toBeLessThan(180);
  });

  it('creates the session, stores accounts and kicks off a sync', async () => {
    const state = await start();
    const res = await completeConnect(deps, new URLSearchParams({ code: 'c', state }));
    expect(res).toEqual({ aspsp: 'imagin', accounts: 1 });
    expect(store.activeAccounts(NOW.getTime())).toMatchObject([
      { accountKey: 'hash-A', uid: 'uid-1', iban: 'ES0021000000000000000001' },
    ]);
    expect(syncs).toEqual(['connect']);
  });

  it('refuses a replayed or unknown state', async () => {
    const state = await start();
    await completeConnect(deps, new URLSearchParams({ code: 'c', state }));
    await expect(completeConnect(deps, new URLSearchParams({ code: 'c', state }))).rejects.toThrow(ConnectError);
    await expect(
      completeConnect(deps, new URLSearchParams({ code: 'c', state: 'forged.eA' })),
    ).rejects.toThrow(/expired or was already used/);
  });

  it('surfaces the bank error from the redirect', async () => {
    await expect(
      completeConnect(
        deps,
        new URLSearchParams({ error: 'access_denied', error_description: 'Cancelled by user' }),
      ),
    ).rejects.toThrow('access_denied — Cancelled by user');
  });
});
