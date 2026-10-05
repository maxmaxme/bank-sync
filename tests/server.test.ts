import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionResponse } from '../src/enablebanking/types.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { Syncer } from '../src/sync.ts';
import { normalizeTransactions } from '../src/transactions.ts';
import { createApp, toCsv } from '../src/web/server.ts';
import { RecordingNotifier, silentLog, tx } from './helpers.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const SESSION: SessionResponse = {
  session_id: 'sess-1',
  aspsp: { name: 'imagin', country: 'ES' },
  access: { valid_until: '2027-04-01T12:00:00Z' },
  accounts: [{ uid: 'uid-1', identification_hash: 'hash-A', currency: 'EUR' }],
};

let store: Store;
let server: Server;
let base: string;
let authStates: string[];

beforeEach(async () => {
  store = openStore(':memory:');
  authStates = [];
  const api = {
    getTransactions: async () => ({ transactions: [] }),
    getBalances: async () => ({ balances: [] }),
  };
  const syncer = new Syncer({ api, store, notifier: new RecordingNotifier(), log: silentLog, now: () => NOW });
  server = createApp({
    client: {
      listAspsps: async () => [
        { name: 'CaixaBank', country: 'ES', maximum_consent_validity: 15552000, beta: false },
        { name: 'imagin', country: 'ES', maximum_consent_validity: 15552000, beta: false },
      ],
      startAuth: async (input) => {
        authStates.push(input.state);
        return { url: 'https://auth.enablebanking.com/ais/start?sessionid=x' };
      },
      createSession: async () => SESSION,
      deleteSession: async () => {},
    },
    store,
    syncer,
    redirectUrl: 'https://example.com/cb',
    country: 'ES',
    preferredAspsp: 'imagin',
    setupWarning: () => null,
    zen: null,
    log: silentLog,
    now: () => NOW,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

describe('web app', () => {
  it('renders the page with the preferred bank preselected', async () => {
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('<option value="imagin" selected>');
    expect(html).toContain('No bank connected yet');
  });

  it('can hide every amount on the page: each one has a masked twin, none is printed bare', async () => {
    store.saveSession(
      {
        sessionId: 's1',
        aspspName: 'imagin',
        aspspCountry: 'ES',
        validUntil: '2027-01-01T00:00:00Z',
        createdAt: 0,
        revokedAt: null,
      },
      [{ accountKey: 'hash-A', uid: 'u', iban: null, name: null, currency: 'EUR' }],
    );
    store.recordAccountSync('hash-A', { ok: true, balanceCents: 98_765, balanceCurrency: 'EUR' }, 0);
    store.applyTransactions('hash-A', '2026-01-01', normalizeTransactions([tx()]), 0);
    const html = await (await fetch(base + '/')).text();

    const amounts = [
      ...html.matchAll(
        /<span class="money"><span class="real">([^<]*)<\/span><span class="masked">••••<\/span><\/span>/g,
      ),
    ];
    expect(amounts.map((m) => m[1])).toEqual(['987.65 EUR', '-12.34 EUR']);
    const rest = html.replaceAll(/<span class="money">.*?<\/span><\/span>/g, '');
    expect(rest).not.toMatch(/987\.65|12\.34/);
    // The eye toggles a class remembered in localStorage, applied before the first paint.
    expect(html).toMatch(/<head>[\s\S]*localStorage\.getItem\('bank-sync:hide-money'\)[\s\S]*<\/head>/);
    expect(html).toContain('id="eye"');
  });

  it('starts auth with the forwarded host encoded in state and redirects to the bank', async () => {
    const res = await post('/connect', { aspsp: 'imagin' }, { 'x-forwarded-host': 'pi.home:8085' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://auth.enablebanking.com/ais/start?sessionid=x');
    const suffix = authStates[0]?.split('.')[1] ?? '';
    expect(Buffer.from(suffix, 'base64url').toString()).toBe('http://pi.home:8085');
  });

  it('completes the connection from a pasted redirect URL', async () => {
    await post('/connect', { aspsp: 'imagin' });
    const pasted = `https://example.com/cb?state=${encodeURIComponent(authStates[0] ?? '')}&code=abc`;
    const res = await post('/callback', { url: pasted });
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('connected 1 account(s)');
    expect(store.activeAccounts(NOW.getTime())).toHaveLength(1);
  });

  it('shows a friendly error for a stale callback', async () => {
    const res = await fetch(`${base}/callback?state=nope&code=abc`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/\?err=/);
  });

  it('serves transactions as JSON and CSV', async () => {
    store.saveSession(
      {
        sessionId: 's1',
        aspspName: 'imagin',
        aspspCountry: 'ES',
        validUntil: '2027-01-01T00:00:00Z',
        createdAt: 0,
        revokedAt: null,
      },
      [{ accountKey: 'hash-A', uid: 'u', iban: null, name: null, currency: 'EUR' }],
    );
    store.applyTransactions('hash-A', '2026-01-01', normalizeTransactions([tx()]), 0);

    const json = await (await fetch(`${base}/api/transactions?from=2026-09-01`)).json();
    expect(json.transactions).toEqual([
      expect.objectContaining({ id: 'ref-1', amount: '-12.34', amount_cents: -1234, counterparty: 'MERCADONA' }),
    ]);

    const csv = await (await fetch(`${base}/export.csv`)).text();
    expect(csv.split('\r\n')[1]).toBe('2026-09-30,BOOK,-12.34,EUR,MERCADONA,COMPRA TARJ. 1234,hash-A,ref-1');
  });
});

describe('toCsv', () => {
  it('quotes cells with commas and quotes', () => {
    const [row] = normalizeTransactions([tx({ remittance_information: ['Pago "A", B'] })]);
    expect(row).toBeDefined();
    const csv = toCsv([{ ...row!, accountKey: 'k', firstSeenAt: 0, updatedAt: 0, zmId: null, zmPushedAt: null }]);
    expect(csv).toContain('"Pago ""A"", B"');
  });
});
