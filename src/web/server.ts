import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { formatCents } from '../money.ts';
import { completeConnect, ConnectError, startConnect, type ConnectDeps } from '../connect.ts';
import { renderPage, type ZenSection } from './html.ts';
import { suggestZenAccount, type ZenExporter } from '../zenmoney/export.ts';
import { isoDate } from '../sync.ts';
import type { EnableBankingClient } from '../enablebanking/client.ts';
import type { Aspsp } from '../enablebanking/types.ts';
import type { TransactionRow } from '../storage/types.ts';
import type { Syncer } from '../sync.ts';
import type { Logger } from '../logger.ts';

const ASPSP_CACHE_MS = 24 * 3600_000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ServerDeps extends ConnectDeps {
  client: Pick<EnableBankingClient, 'startAuth' | 'createSession' | 'listAspsps' | 'deleteSession'>;
  syncer: Syncer;
  country: string;
  preferredAspsp: string;
  /** Shown on the page when the startup self-check found a problem. */
  setupWarning: () => string | null;
  /** null when ZenMoney export isn't configured. */
  zen: Pick<ZenExporter, 'reference' | 'run' | 'lastResult'> | null;
  log: Logger;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Where this instance is reachable from the browser that's talking to it. */
function returnBaseOf(req: IncomingMessage): string {
  const proto =
    String(req.headers['x-forwarded-proto'] ?? 'http')
      .split(',')[0]
      ?.trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost')
    .split(',')[0]
    ?.trim();
  return `${proto}://${host}`;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    // No encoding is set on the request, so chunks are Buffers.
    if (!Buffer.isBuffer(chunk)) {
      throw new HttpError(400, 'Unexpected request body');
    }
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

function flashRedirect(res: ServerResponse, kind: 'ok' | 'err', text: string): void {
  redirect(res, `/?${kind}=${encodeURIComponent(text)}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function txQuery(url: URL) {
  return {
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    accountKey: url.searchParams.get('account') ?? undefined,
  };
}

function txJson(t: TransactionRow, withRaw: boolean) {
  return {
    account: t.accountKey,
    id: t.txKey,
    status: t.status,
    date: t.txDate,
    booking_date: t.bookingDate,
    value_date: t.valueDate,
    transaction_date: t.transactionDate,
    amount: formatCents(t.amountCents),
    amount_cents: t.amountCents,
    currency: t.currency,
    counterparty: t.counterparty,
    description: t.description,
    ...(withRaw ? { raw: JSON.parse(t.raw) as unknown } : {}),
  };
}

function csvCell(v: string | number | null): string {
  const s = v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: readonly TransactionRow[]): string {
  const header = ['date', 'status', 'amount', 'currency', 'counterparty', 'description', 'account', 'id'];
  const lines = rows.map((t) =>
    [t.txDate, t.status, formatCents(t.amountCents), t.currency, t.counterparty, t.description, t.accountKey, t.txKey]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n') + '\r\n';
}

export function createApp(deps: ServerDeps): Server {
  let aspspCache: { at: number; list: Aspsp[] } | null = null;

  async function aspsps(): Promise<Aspsp[]> {
    const now = deps.now().getTime();
    if (!aspspCache || now - aspspCache.at > ASPSP_CACHE_MS) {
      const list = await deps.client.listAspsps(deps.country);
      list.sort((a, b) => a.name.localeCompare(b.name));
      aspspCache = { at: now, list };
    }
    return aspspCache.list;
  }

  async function zenSection(): Promise<ZenSection | null> {
    if (!deps.zen) {
      return null;
    }
    const accounts = deps.store.listAccounts().filter((a) => a.revokedAt === null);
    const base = {
      last: deps.zen.lastResult(),
      rows: [] as ZenSection['rows'],
      choices: [] as ZenSection['choices'],
    };
    try {
      const ref = await deps.zen.reference();
      base.choices = ref.accounts.map((a) => ({
        id: a.id,
        title: a.title,
        currency: (a.instrument !== null && ref.currencies.get(a.instrument)) || '?',
      }));
      base.rows = accounts.map((a) => {
        const own = deps.store.queryTransactions({ accountKey: a.accountKey });
        const earliest = own.at(-1)?.txDate ?? isoDate(deps.now());
        return {
          accountKey: a.accountKey,
          label: `${a.name ?? a.aspspName} · ${a.iban ? `…${a.iban.slice(-4)}` : ''}`,
          current: a.zmAccountId,
          suggested: suggestZenAccount(a, ref.accounts)?.id ?? null,
          since: a.zmSince ?? earliest,
          ...deps.store.exportStats(a.accountKey),
        };
      });
      return { ...base, error: null };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function page(url: URL, res: ServerResponse): Promise<void> {
    let list: Aspsp[] | null = null;
    let aspspError: string | null = null;
    try {
      list = await aspsps();
    } catch (err) {
      aspspError = err instanceof Error ? err.message : String(err);
    }
    const ok = url.searchParams.get('ok');
    const err = url.searchParams.get('err');
    const html = renderPage({
      now: deps.now(),
      flash: err ? { kind: 'err', text: err } : ok ? { kind: 'ok', text: ok } : null,
      sessions: deps.store.listSessions(),
      accounts: deps.store.listAccounts(),
      runs: deps.store.recentSyncRuns(5),
      syncing: deps.syncer.isRunning(),
      transactions: deps.store.queryTransactions({ limit: 100 }),
      aspsps: list,
      aspspError,
      preferredAspsp: deps.preferredAspsp,
      setupWarning: deps.setupWarning(),
      zen: await zenSection(),
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  async function finishConnect(params: URLSearchParams, res: ServerResponse): Promise<void> {
    try {
      const r = await completeConnect(deps, params);
      flashRedirect(res, 'ok', `${r.aspsp}: connected ${r.accounts} account(s). Loading history…`);
    } catch (err) {
      if (err instanceof ConnectError) {
        flashRedirect(res, 'err', err.message);
        return;
      }
      throw err;
    }
  }

  async function connect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const name = form.get('aspsp');
    const aspsp = (await aspsps()).find((a) => a.name === name);
    if (!aspsp) {
      throw new HttpError(400, `Unknown bank: ${name}`);
    }
    redirect(res, await startConnect(deps, aspsp, returnBaseOf(req)));
  }

  /** Manual fallback for the redirect: the user pastes wherever the bank sent them. */
  async function pastedCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pasted = ((await readForm(req)).get('url') ?? '').trim();
    const query = pasted.includes('?') ? pasted.slice(pasted.indexOf('?') + 1) : pasted;
    await finishConnect(new URLSearchParams(query.split('#')[0]), res);
  }

  function sync(res: ServerResponse): void {
    deps.syncer.run('manual').catch((err: unknown) => deps.log.error({ err }, 'manual sync crashed'));
    flashRedirect(res, 'ok', 'Sync started — refresh the page in a minute.');
  }

  function exportToZen(zen: NonNullable<ServerDeps['zen']>): void {
    zen.run().catch((err: unknown) => deps.log.error({ err }, 'zenmoney export crashed'));
  }

  async function mapZenAccount(zen: NonNullable<ServerDeps['zen']>, req: IncomingMessage, res: ServerResponse) {
    const form = await readForm(req);
    const accountKey = form.get('account') ?? '';
    const zmAccount = form.get('zm_account') || null;
    const since = form.get('since') || null;
    if (zmAccount && !(since && /^\d{4}-\d{2}-\d{2}$/.test(since))) {
      throw new HttpError(400, 'Pick the date to export from.');
    }
    if (!deps.store.listAccounts().some((a) => a.accountKey === accountKey)) {
      throw new HttpError(400, 'Unknown account.');
    }
    deps.store.setZenMapping(accountKey, zmAccount, zmAccount ? since : null);
    if (zmAccount) {
      exportToZen(zen);
    }
    flashRedirect(
      res,
      'ok',
      zmAccount ? 'Saved — exporting to ZenMoney now.' : 'ZenMoney export turned off for this account.',
    );
  }

  async function revokeSession(sessionId: string, res: ServerResponse): Promise<void> {
    try {
      await deps.client.deleteSession(sessionId);
    } catch (err) {
      // Already expired/revoked on their side is fine — we still forget it locally.
      deps.log.warn({ err, sessionId }, 'remote session delete failed');
    }
    deps.store.revokeSession(sessionId, deps.now().getTime());
    flashRedirect(res, 'ok', 'Access revoked.');
  }

  function accountsJson(res: ServerResponse): void {
    sendJson(res, 200, {
      accounts: deps.store.listAccounts().map((a) => ({
        account: a.accountKey,
        bank: a.aspspName,
        name: a.name,
        iban: a.iban,
        currency: a.currency,
        balance: a.balanceCents === null ? null : formatCents(a.balanceCents),
        balance_cents: a.balanceCents,
        balance_currency: a.balanceCurrency,
        last_synced_at: a.lastSyncedAt === null ? null : new Date(a.lastSyncedAt).toISOString(),
        last_error: a.lastError,
        consent_valid_until: a.validUntil,
        revoked: a.revokedAt !== null,
      })),
    });
  }

  function csv(url: URL, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="transactions.csv"',
    });
    res.end(toCsv(deps.store.queryTransactions(txQuery(url))));
  }

  type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void;

  const zen = deps.zen;
  const routes = new Map<string, Handler>([
    ['GET /health', (_req, res) => sendJson(res, 200, { ok: true })],
    ['GET /', (_req, res, url) => page(url, res)],
    ['POST /connect', connect],
    ['GET /callback', (_req, res, url) => finishConnect(url.searchParams, res)],
    ['POST /callback', pastedCallback],
    ['POST /sync', (_req, res) => sync(res)],
    ['GET /api/accounts', (_req, res) => accountsJson(res)],
    [
      'GET /api/transactions',
      (_req, res, url) => {
        const withRaw = url.searchParams.get('raw') === '1';
        sendJson(res, 200, { transactions: deps.store.queryTransactions(txQuery(url)).map((t) => txJson(t, withRaw)) });
      },
    ],
    ['GET /export.csv', (_req, res, url) => csv(url, res)],
    // Only when ZenMoney export is configured; otherwise these are 404s.
    ...(zen
      ? ([
          ['POST /zenmoney/map', (req, res) => mapZenAccount(zen, req, res)],
          [
            'POST /zenmoney/export',
            (_req, res) => {
              exportToZen(zen);
              flashRedirect(res, 'ok', 'Export started — refresh in a few seconds.');
            },
          ],
        ] satisfies [string, Handler][])
      : []),
  ]);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const handler = routes.get(`${method} ${url.pathname}`);
    if (handler) {
      await handler(req, res, url);
      return;
    }
    const del = /^\/sessions\/([^/]+)\/delete$/.exec(url.pathname);
    if (method === 'POST' && del) {
      await revokeSession(decodeURIComponent(del[1] ?? ''), res);
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) {
        deps.log.error({ err, url: req.url }, 'request failed');
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Browser-driven actions land back on the page with the error shown;
      // API clients get a plain status code.
      const browserAction = req.method === 'POST' || (req.url ?? '').startsWith('/callback');
      if (browserAction && status !== 404) {
        flashRedirect(res, 'err', message);
        return;
      }
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
  });
}
