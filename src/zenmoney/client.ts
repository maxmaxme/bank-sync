import type { ZenMoneyApi, ZmDiff, ZmSuggestion } from './types.ts';

/** A token only works on the server that issued it (zerro.app: `zm_server` in localStorage). */
export const ZENMONEY_SERVERS = {
  ru: 'https://api.zenmoney.ru',
  app: 'https://api.zenmoney.app',
} as const;

export type ZenMoneyServer = keyof typeof ZENMONEY_SERVERS;

export class ZenMoneyError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'ZenMoneyError';
    this.status = status;
    this.code = code;
  }

  /** Expired or revoked token — needs a human with a browser. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ZenMoneyClientOptions {
  token: string;
  server: ZenMoneyServer;
  fetch?: typeof fetch;
  now?: () => number;
}

export class ZenMoneyClient implements ZenMoneyApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: ZenMoneyClientOptions) {
    this.token = opts.token;
    this.baseUrl = ZENMONEY_SERVERS[opts.server];
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  diff(body: ZmDiff): Promise<ZmDiff> {
    return this.post('/v8/diff/', {
      ...body,
      currentClientTimestamp: Math.floor(this.now() / 1000),
    });
  }

  suggest(items: { payee: string }[]): Promise<ZmSuggestion[]> {
    return this.post('/v8/suggest/', items);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error page — handled below.
    }
    // Errors come back as { error: { code, message } }, sometimes with HTTP 200.
    const error = (parsed as { error?: { code?: string; message?: string } | string } | null)?.error;
    if (!res.ok || error) {
      const code = typeof error === 'object' ? (error.code ?? null) : (error ?? null);
      const message =
        (typeof error === 'object' ? error.message : undefined) ?? (text.slice(0, 300) || res.statusText);
      throw new ZenMoneyError(res.status, code, `ZenMoney ${path} → ${res.status}${code ? ` ${code}` : ''}: ${message}`);
    }
    return parsed as T;
  }
}
