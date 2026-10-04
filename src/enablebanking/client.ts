import { createPrivateKey, type KeyObject } from 'node:crypto';
import * as v from 'valibot';
import { parseJson } from '../json.ts';
import { signAppJwt } from './jwt.ts';
import {
  ApplicationSchema,
  AspspsResponseSchema,
  BalancesResponseSchema,
  ErrorResponseSchema,
  SessionResponseSchema,
  StartAuthResponseSchema,
  TransactionsPageSchema,
  type AccountApi,
  type Application,
  type Aspsp,
  type AspspRef,
  type BalancesResponse,
  type SessionResponse,
  type StartAuthResponse,
  type TransactionsPage,
} from './types.ts';

export const DEFAULT_BASE_URL = 'https://api.enablebanking.com';

export class EnableBankingError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'EnableBankingError';
    this.status = status;
    this.code = code;
  }
}

export interface EnableBankingClientOptions {
  appId: string;
  privateKeyPem: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Query = Record<string, string | undefined>;

export class EnableBankingClient implements AccountApi {
  private readonly appId: string;
  private readonly key: KeyObject;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: EnableBankingClientOptions) {
    this.appId = opts.appId;
    // Parse once up front so a broken key fails at startup, not on first sync.
    this.key = createPrivateKey(opts.privateKeyPem);
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** The application this key belongs to — handy for checking setup (environment, redirect URLs). */
  getApplication(): Promise<Application> {
    return this.request(ApplicationSchema, 'GET', '/application');
  }

  async listAspsps(country: string): Promise<Aspsp[]> {
    const res = await this.request(AspspsResponseSchema, 'GET', '/aspsps', {
      query: { country, psu_type: 'personal' },
    });
    return res.aspsps;
  }

  startAuth(input: {
    aspsp: AspspRef;
    validUntil: Date;
    state: string;
    redirectUrl: string;
  }): Promise<StartAuthResponse> {
    return this.request(StartAuthResponseSchema, 'POST', '/auth', {
      body: {
        access: { valid_until: input.validUntil.toISOString() },
        aspsp: input.aspsp,
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: 'personal',
      },
    });
  }

  createSession(code: string): Promise<SessionResponse> {
    return this.request(SessionResponseSchema, 'POST', '/sessions', { body: { code } });
  }

  async deleteSession(sessionId: string): Promise<void> {
    // SuccessResponse — nothing in it we need.
    await this.request(v.unknown(), 'DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getTransactions(
    accountUid: string,
    opts: { dateFrom: string; continuationKey?: string; strategy?: 'default' | 'longest' },
  ): Promise<TransactionsPage> {
    return this.request(TransactionsPageSchema, 'GET', `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
      query: {
        date_from: opts.dateFrom,
        continuation_key: opts.continuationKey,
        strategy: opts.strategy,
      },
    });
  }

  getBalances(accountUid: string): Promise<BalancesResponse> {
    return this.request(BalancesResponseSchema, 'GET', `/accounts/${encodeURIComponent(accountUid)}/balances`);
  }

  private async request<S extends v.GenericSchema>(
    schema: S,
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<v.InferOutput<S>> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${signAppJwt(this.appId, this.key, this.now())}`,
      accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw toError(method, path, res.status, text);
    }
    const parsed = v.safeParse(schema, text ? parseJson(text) : undefined);
    if (!parsed.success) {
      // Fails here, with the path, rather than as a TypeError somewhere in sync.
      throw new EnableBankingError(
        res.status,
        null,
        `Enable Banking ${method} ${path} → ${res.status}: unexpected response — ${v.summarize(parsed.issues)}`,
      );
    }
    return parsed.output;
  }
}

function toError(method: string, path: string, status: number, body: string): EnableBankingError {
  let code: string | null = null;
  let detail = body.slice(0, 500);
  const parsed = v.safeParse(ErrorResponseSchema, parseJson(body));
  // Not an ErrorResponse (a proxy's HTML page, say) — keep the raw (truncated) body.
  if (parsed.success) {
    const { message, error, detail: more } = parsed.output;
    code = error ?? null;
    const extra =
      more === undefined || more === null ? '' : ` (${typeof more === 'string' ? more : JSON.stringify(more)})`;
    detail = `${message ?? ''}${extra}`.trim() || detail;
  }
  return new EnableBankingError(
    status,
    code,
    `Enable Banking ${method} ${path} → ${status}${code ? ` ${code}` : ''}: ${detail}`,
  );
}
