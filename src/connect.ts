import { randomUUID } from 'node:crypto';
import type { EnableBankingClient } from './enablebanking/client.ts';
import type { Aspsp, SessionAccount } from './enablebanking/types.ts';
import type { AccountInput, Store } from './storage/types.ts';
import type { Syncer } from './sync.ts';
import type { Logger } from './logger.ts';

/** How long a started-but-unfinished bank login stays redeemable. */
const AUTH_REQUEST_TTL_MS = 60 * 60_000;
/** Ask for a little less than the bank's maximum so clock skew can't push us over it. */
const CONSENT_MARGIN_MS = 10 * 60_000;

export interface ConnectDeps {
  client: Pick<EnableBankingClient, 'startAuth' | 'createSession'>;
  store: Store;
  syncer: Pick<Syncer, 'run'>;
  redirectUrl: string;
  log: Logger;
  now: () => Date;
}

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectError';
  }
}

/**
 * `state` is `<nonce>.<base64url(returnBase)>`. The nonce is what we verify;
 * the suffix tells an optional static bounce page (see docs/callback.html)
 * where this instance lives, so the registered redirect URL can be any HTTPS
 * page while the service itself stays on the LAN.
 */
export function encodeState(nonce: string, returnBase: string): string {
  return `${nonce}.${Buffer.from(returnBase).toString('base64url')}`;
}

export function stateNonce(state: string): string {
  return state.split('.', 1)[0] ?? '';
}

/** An account the bank will serve data for: it has a `uid` in this session. */
type ReadableAccount = SessionAccount & { uid: string };

export function accountKeyOf(a: ReadableAccount): string {
  return a.identification_hash || a.account_id?.iban || a.uid;
}

/** Returns the bank URL to send the user to. */
export async function startConnect(deps: ConnectDeps, aspsp: Aspsp, returnBase: string): Promise<string> {
  const now = deps.now();
  const nonce = randomUUID();
  deps.store.saveAuthRequest(nonce, now.getTime());
  const validUntil = new Date(now.getTime() + aspsp.maximum_consent_validity * 1000 - CONSENT_MARGIN_MS);
  const res = await deps.client.startAuth({
    aspsp: { name: aspsp.name, country: aspsp.country },
    validUntil,
    state: encodeState(nonce, returnBase),
    redirectUrl: deps.redirectUrl,
  });
  deps.log.info({ aspsp: aspsp.name, validUntil }, 'auth started');
  return res.url;
}

/**
 * Accepts the query string the bank redirected to (directly on /callback, or
 * pasted by hand). Creates the session, stores its accounts and kicks off the
 * first sync right away — banks tend to serve deep history only shortly after
 * the user authorises.
 */
export async function completeConnect(
  deps: ConnectDeps,
  params: URLSearchParams,
): Promise<{ aspsp: string; accounts: number }> {
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description');
    throw new ConnectError(`The bank returned an error: ${error}${description ? ` — ${description}` : ''}`);
  }
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    throw new ConnectError('The URL has no code and state parameters.');
  }
  const now = deps.now().getTime();
  if (!deps.store.takeAuthRequest(stateNonce(state), AUTH_REQUEST_TTL_MS, now)) {
    throw new ConnectError('This connection attempt has expired or was already used — start again.');
  }

  const session = await deps.client.createSession(code);
  // No uid: the bank already knows it can't serve the account (blocked, closed).
  const readable = session.accounts.filter((a): a is ReadableAccount => Boolean(a.uid));
  if (readable.length < session.accounts.length) {
    deps.log.warn({ skipped: session.accounts.length - readable.length }, 'accounts without uid skipped');
  }
  const accounts: AccountInput[] = readable.map((a) => ({
    accountKey: accountKeyOf(a),
    uid: a.uid,
    iban: a.account_id?.iban ?? null,
    name: a.name ?? null,
    currency: a.currency ?? null,
  }));
  deps.store.saveSession(
    {
      sessionId: session.session_id,
      aspspName: session.aspsp.name,
      aspspCountry: session.aspsp.country,
      validUntil: session.access.valid_until,
      createdAt: now,
      revokedAt: null,
    },
    accounts,
  );
  deps.log.info(
    { sessionId: session.session_id, aspsp: session.aspsp.name, accounts: accounts.length },
    'session created',
  );

  deps.syncer.run('connect').catch((err: unknown) => deps.log.error({ err }, 'initial sync crashed'));
  return { aspsp: session.aspsp.name, accounts: accounts.length };
}
