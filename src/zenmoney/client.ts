import * as v from 'valibot';
import { parseJson } from '../json.ts';
import {
  ZmDiffResponseSchema,
  ZmSuggestResponseSchema,
  type ZenMoneyApi,
  type ZenMoneyServer,
  type ZmDiff,
  type ZmDiffResponse,
  type ZmSuggestion,
} from './types.ts';

const SERVERS: Record<ZenMoneyServer, string> = {
  ru: 'https://api.zenmoney.ru',
  app: 'https://api.zenmoney.app',
};

const ErrorDetailsSchema = v.object({ code: v.optional(v.string()), message: v.optional(v.string()) });

// Errors come back as { error: { code, message } } (or a plain string), sometimes with HTTP 200.
// Any other non-null `error` still counts: a write must never pass for a success.
const ErrorBodySchema = v.object({
  error: v.union([v.string(), ErrorDetailsSchema, v.nonNullish(v.unknown())]),
});

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
    this.baseUrl = SERVERS[opts.server];
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  diff(body: ZmDiff): Promise<ZmDiffResponse> {
    return this.post(ZmDiffResponseSchema, '/v8/diff/', {
      ...body,
      currentClientTimestamp: Math.floor(this.now() / 1000),
    });
  }

  suggest(items: { payee: string }[]): Promise<ZmSuggestion[]> {
    return this.post(ZmSuggestResponseSchema, '/v8/suggest/', items);
  }

  private async post<S extends v.GenericSchema>(schema: S, path: string, body: unknown): Promise<v.InferOutput<S>> {
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
    // Non-JSON (a plain "Unauthorized", an error page) parses as undefined.
    const json = text ? parseJson(text) : undefined;
    const error = v.safeParse(ErrorBodySchema, json);
    if (!res.ok || error.success) {
      const { code, message } = describeError(error.success ? error.output.error : undefined);
      const what = message ?? (text.slice(0, 300) || res.statusText);
      throw new ZenMoneyError(res.status, code, `ZenMoney ${path} → ${res.status}${code ? ` ${code}` : ''}: ${what}`);
    }
    const parsed = v.safeParse(schema, json);
    if (!parsed.success) {
      const issues = v.summarize(parsed.issues);
      throw new ZenMoneyError(res.status, null, `ZenMoney ${path}: unexpected response — ${issues}`);
    }
    return parsed.output;
  }
}

function describeError(error: unknown): { code: string | null; message: string | null } {
  if (typeof error === 'string') {
    return { code: error, message: null };
  }
  const details = v.safeParse(ErrorDetailsSchema, error);
  return details.success
    ? { code: details.output.code ?? null, message: details.output.message ?? null }
    : { code: null, message: null };
}
