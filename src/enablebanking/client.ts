import { createPrivateKey, type KeyObject } from 'node:crypto';
import { signAppJwt } from './jwt.ts';
import type {
  AccountApi,
  Application,
  Aspsp,
  AspspRef,
  BalancesResponse,
  SessionResponse,
  StartAuthResponse,
  TransactionsPage,
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
    return this.request('GET', '/application');
  }

  async listAspsps(country: string): Promise<Aspsp[]> {
    const res = await this.request<{ aspsps: Aspsp[] }>('GET', '/aspsps', {
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
    return this.request('POST', '/auth', {
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
    return this.request('POST', '/sessions', { body: { code } });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getTransactions(
    accountUid: string,
    opts: { dateFrom: string; continuationKey?: string; strategy?: 'default' | 'longest' },
  ): Promise<TransactionsPage> {
    return this.request('GET', `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
      query: {
        date_from: opts.dateFrom,
        continuation_key: opts.continuationKey,
        strategy: opts.strategy,
      },
    });
  }

  getBalances(accountUid: string): Promise<BalancesResponse> {
    return this.request('GET', `/accounts/${encodeURIComponent(accountUid)}/balances`);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, v);
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
    return (text ? JSON.parse(text) : {}) as T;
  }
}

function toError(method: string, path: string, status: number, body: string): EnableBankingError {
  let code: string | null = null;
  let detail = body.slice(0, 500);
  try {
    // ErrorResponse: { message, code (= HTTP status), error (ErrorCode), detail }
    const parsed = JSON.parse(body) as { message?: string; error?: string; detail?: unknown };
    code = parsed.error ?? null;
    const extra =
      parsed.detail === undefined || parsed.detail === null
        ? ''
        : ` (${typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail)})`;
    detail = `${parsed.message ?? ''}${extra}`.trim() || detail;
  } catch {
    // Not JSON — keep the raw (truncated) body.
  }
  return new EnableBankingError(
    status,
    code,
    `Enable Banking ${method} ${path} → ${status}${code ? ` ${code}` : ''}: ${detail}`,
  );
}
