import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/storage/migrations.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { normalizeTransactions } from '../src/transactions.ts';
import { ZenMoneyClient, ZenMoneyError } from '../src/zenmoney/client.ts';
import { LAST_EXPORT_KV, suggestZenAccount, ZenExporter, zmIdFor } from '../src/zenmoney/export.ts';
import type { ZenMoneyApi, ZmAccount, ZmDiff, ZmDiffResponse, ZmSuggestion } from '../src/zenmoney/types.ts';
import { RecordingNotifier, requestBody, silentLog, tx } from './helpers.ts';

const NOW = new Date('2026-10-03T12:00:00Z');
const NOW_SEC = NOW.getTime() / 1000;

const ZM_ACCOUNTS: ZmAccount[] = [
  { id: 'zm-imagin', user: 42, instrument: 3, type: 'checking', title: 'imagin', syncID: ['4321'], archive: false },
  { id: 'zm-cash', user: 42, instrument: 3, type: 'cash', title: 'Cash', syncID: null, archive: false },
  { id: 'zm-old', user: 42, instrument: 3, type: 'ccard', title: 'Old', syncID: ['1111'], archive: true },
  { id: 'zm-debt', user: 42, instrument: 2, type: 'debt', title: 'Debts', syncID: null, archive: false },
];

class FakeZen implements ZenMoneyApi {
  readonly diffs: ZmDiff[] = [];
  suggestions: ZmSuggestion[] = [];
  failDiff: Error | null = null;

  async diff(body: ZmDiff): Promise<ZmDiffResponse> {
    if (this.failDiff) {
      throw this.failDiff;
    }
    this.diffs.push(body);
    if (body.forceFetch) {
      return {
        account: ZM_ACCOUNTS,
        instrument: [
          { id: 2, shortTitle: 'RUB' },
          { id: 3, shortTitle: 'EUR' },
        ],
      };
    }
    return {};
  }

  async suggest(items: { payee: string }[]): Promise<ZmSuggestion[]> {
    return items.map((_, i) => this.suggestions[i] ?? {});
  }

  pushed() {
    return this.diffs.flatMap((d) => d.transaction ?? []);
  }
}

let store: Store;
let zen: FakeZen;
let notifier: RecordingNotifier;
let exporter: ZenExporter;

function seed(rows: Parameters<typeof tx>[0][]) {
  store.applyTransactions('acc-A', '2026-01-01', normalizeTransactions(rows.map((r) => tx(r))), NOW.getTime());
}

beforeEach(() => {
  store = openStore(':memory:');
  zen = new FakeZen();
  notifier = new RecordingNotifier();
  exporter = new ZenExporter({ api: zen, store, notifier, log: silentLog, now: () => NOW });
  store.saveSession(
    {
      sessionId: 's1',
      aspspName: 'imagin',
      aspspCountry: 'ES',
      validUntil: '2027-04-01T00:00:00Z',
      createdAt: 0,
      revokedAt: null,
    },
    [{ accountKey: 'acc-A', uid: 'u1', iban: 'ES0000000000000000004321', name: 'Cuenta', currency: 'EUR' }],
  );
});
afterEach(() => store.close());

describe('suggestZenAccount', () => {
  it('matches the unique account whose syncID ends with the IBAN last 4', () => {
    expect(suggestZenAccount({ iban: 'ES00 0000 0000 0000 0000 4321' }, ZM_ACCOUNTS)?.id).toBe('zm-imagin');
    expect(suggestZenAccount({ iban: 'ES0000000000000000000000' }, ZM_ACCOUNTS)).toBeNull();
    expect(suggestZenAccount({ iban: null }, ZM_ACCOUNTS)).toBeNull();
  });
});

describe('zmIdFor', () => {
  it('is a stable UUID-shaped id per row', () => {
    const id = zmIdFor('acc-A', 'ref-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(zmIdFor('acc-A', 'ref-1')).toBe(id);
    expect(zmIdFor('acc-A', 'ref-2')).not.toBe(id);
  });
});

describe('ZenExporter', () => {
  it('lists only live, non-debt accounts as targets', async () => {
    const ref = await exporter.reference();
    expect(ref.accounts.map((a) => a.id)).toEqual(['zm-cash', 'zm-imagin']);
    expect(ref.currencies.get(3)).toBe('EUR');
  });

  it('does nothing for accounts without a mapping', async () => {
    seed([{ entry_reference: 'a' }]);
    const res = await exporter.run();
    expect(res).toMatchObject({ ok: true, exported: 0 });
    expect(zen.diffs).toHaveLength(0);
  });

  it('exports booked rows from the chosen date as ZenMoney transactions', async () => {
    seed([
      { entry_reference: 'old', booking_date: '2026-09-01' },
      {
        entry_reference: 'buy',
        booking_date: '2026-10-02',
        transaction_date: '2026-10-01',
        merchant_category_code: '5411',
      },
      {
        entry_reference: 'salary',
        booking_date: '2026-10-02',
        credit_debit_indicator: 'CRDT',
        transaction_amount: { currency: 'EUR', amount: '1850.00' },
        debtor: { name: 'ACME SL' },
        remittance_information: ['NOMINA'],
      },
      { entry_reference: 'pend', status: 'PDNG', booking_date: null, transaction_date: '2026-10-03' },
    ]);
    store.setZenMapping('acc-A', 'zm-imagin', '2026-09-15');
    zen.suggestions = [{ payee: 'Mercadona', merchant: 'm-1', tag: ['t-food'] }];

    const res = await exporter.run();
    expect(res).toMatchObject({ ok: true, exported: 2 });

    const [buy, salary] = zen.pushed();
    expect(buy).toMatchObject({
      id: zmIdFor('acc-A', 'buy'),
      user: 42,
      date: '2026-10-01',
      incomeAccount: 'zm-imagin',
      outcomeAccount: 'zm-imagin',
      incomeInstrument: 3,
      outcomeInstrument: 3,
      income: 0,
      outcome: 12.34,
      payee: 'Mercadona',
      originalPayee: 'MERCADONA',
      merchant: 'm-1',
      tag: ['t-food'],
      comment: 'COMPRA TARJ. 1234',
      mcc: 5411,
      deleted: false,
      viewed: false,
      changed: NOW_SEC,
    });
    expect(salary).toMatchObject({ income: 1850, outcome: 0, payee: 'ACME SL', tag: null, mcc: null });
    expect(store.exportStats('acc-A')).toEqual({ exported: 2, waiting: 0 });
  });

  it('never sends a row twice', async () => {
    seed([{ entry_reference: 'a', booking_date: '2026-10-01' }]);
    store.setZenMapping('acc-A', 'zm-imagin', '2026-10-01');
    await exporter.run();
    await exporter.run();
    expect(zen.pushed()).toHaveLength(1);
  });

  it('refuses a currency mismatch instead of writing wrong amounts', async () => {
    seed([{ entry_reference: 'a', booking_date: '2026-10-01', transaction_amount: { currency: 'USD', amount: '5' } }]);
    store.setZenMapping('acc-A', 'zm-imagin', '2026-10-01');
    const res = await exporter.run();
    expect(res.ok).toBe(false);
    expect(res.error).toContain('USD');
    expect(zen.pushed()).toHaveLength(0);
  });

  it('reports a rejected token once, then recovery', async () => {
    seed([{ entry_reference: 'a', booking_date: '2026-10-01' }]);
    store.setZenMapping('acc-A', 'zm-imagin', '2026-10-01');
    zen.failDiff = new ZenMoneyError(401, null, 'unauthorized');
    await exporter.run();
    await exporter.run();
    zen.failDiff = null;
    await exporter.run();
    expect(notifier.events).toEqual(['export-failed:auth', 'export-recovered']);
    expect(exporter.lastResult()).toMatchObject({ ok: true, exported: 1 });
  });

  it('reads a corrupt stored result as no result', () => {
    store.setKv(LAST_EXPORT_KV, '{"at":');
    expect(exporter.lastResult()).toBeNull();
    store.setKv(LAST_EXPORT_KV, JSON.stringify({ at: 1, ok: 'yes', exported: 0, error: null }));
    expect(exporter.lastResult()).toBeNull();
  });
});

describe('ZenMoneyClient', () => {
  function clientWith(response: () => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new ZenMoneyClient({
      token: 'tok',
      server: 'ru',
      now: () => NOW.getTime(),
      fetch: async (input, init = {}) => {
        calls.push({ url: input instanceof Request ? input.url : String(input), init });
        return response();
      },
    });
    return { client, calls };
  }

  it('posts with the bearer token to the chosen server and surfaces {error} bodies', async () => {
    const { client, calls } = clientWith(() =>
      Response.json({ error: { code: 'validationError', message: 'Wrong Value' } }),
    );
    const err = await client.diff({ serverTimestamp: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect(err).toHaveProperty('message', expect.stringContaining('validationError: Wrong Value'));
    expect(calls[0]?.url).toBe('https://api.zenmoney.ru/v8/diff/');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
    expect(JSON.parse(requestBody(calls[0]?.init))).toEqual({ serverTimestamp: 1, currentClientTimestamp: NOW_SEC });
  });

  it('an error of an unexpected shape with HTTP 200 still fails the write', async () => {
    const { client } = clientWith(() => Response.json({ error: { code: 7 } }));
    await expect(client.diff({ serverTimestamp: 1, transaction: [] })).rejects.toThrow(ZenMoneyError);
  });

  it('a plain-text 401 is an auth error', async () => {
    const { client } = clientWith(() => new Response('Unauthorized', { status: 401 }));
    const err = await client.suggest([{ payee: 'x' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect(err).toMatchObject({ isAuth: true, message: 'ZenMoney /v8/suggest/ → 401: Unauthorized' });
  });

  it('parses the tables the exporter reads and rejects a malformed one', async () => {
    const account = { id: 'a', user: 1, instrument: 3, type: 'ccard', title: 'Card', archive: false, balance: 5 };
    let body: unknown = { serverTimestamp: 1, account: [account], instrument: [{ id: 3, shortTitle: 'EUR' }] };
    const { client } = clientWith(() => Response.json(body));
    expect((await client.diff({ serverTimestamp: 1 })).account).toEqual([
      { id: 'a', user: 1, instrument: 3, type: 'ccard', title: 'Card', syncID: null, archive: false },
    ]);
    body = { account: [{ ...account, title: null }] };
    await expect(client.diff({ serverTimestamp: 1 })).rejects.toThrow(/unexpected response.*title/s);
  });
});

describe('migration', () => {
  it('upgrades a v1 database in place, keeping its rows', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'bank-sync-')), 'db.sqlite');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]!);
    old.exec('PRAGMA user_version = 1');
    old.exec(`INSERT INTO kv (key, value) VALUES ('k', 'v')`);
    old.close();

    const s = openStore(path);
    expect(s.getKv('k')).toBe('v');
    expect(s.listAccounts()).toEqual([]);
    s.close();
  });
});
