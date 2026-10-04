import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnableBankingClient, EnableBankingError } from '../src/enablebanking/client.ts';
import { signAppJwt } from '../src/enablebanking/jwt.ts';
import { normalizeTransactions } from '../src/transactions.ts';
import { requestBody } from './helpers.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('signAppJwt', () => {
  it('produces a verifiable RS256 token with the claims Enable Banking expects', () => {
    const jwt = signAppJwt('app-123', pem, NOW);
    expect(jwt.split('.')).toHaveLength(3);
    const [h = '', p = '', s = ''] = jwt.split('.');
    expect(decode(h)).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' });
    expect(decode(p)).toEqual({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('EnableBankingClient', () => {
  function clientWith(handler: (url: URL, init: RequestInit) => Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const client = new EnableBankingClient({
      appId: 'app-123',
      privateKeyPem: pem,
      now: () => NOW,
      fetch: async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : input);
        calls.push({ url, init });
        return handler(url, init);
      },
    });
    return { client, calls };
  }

  it('sends date_from, continuation_key and strategy, omitting unset params', async () => {
    const { client, calls } = clientWith(() => Response.json({ transactions: [], continuation_key: null }));
    await client.getTransactions('acc-1', { dateFrom: '2026-01-01', strategy: 'longest' });
    const url = calls[0]?.url;
    expect(url?.pathname).toBe('/accounts/acc-1/transactions');
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      date_from: '2026-01-01',
      strategy: 'longest',
    });
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toMatch(/^Bearer ey/);
  });

  it('posts the auth request in the documented shape', async () => {
    const { client, calls } = clientWith(() => Response.json({ url: 'https://bank/x', authorization_id: 'a' }));
    await client.startAuth({
      aspsp: { name: 'imagin', country: 'ES' },
      validUntil: new Date(NOW + 1000),
      state: 's',
      redirectUrl: 'https://example.com/cb',
    });
    expect(JSON.parse(requestBody(calls[0]?.init))).toEqual({
      access: { valid_until: new Date(NOW + 1000).toISOString() },
      aspsp: { name: 'imagin', country: 'ES' },
      state: 's',
      redirect_url: 'https://example.com/cb',
      psu_type: 'personal',
    });
  });

  it('turns ErrorResponse bodies into EnableBankingError', async () => {
    const { client } = clientWith(() =>
      Response.json(
        { message: 'ASPSP Rate limit exceeded', code: 429, error: 'ASPSP_RATE_LIMIT_EXCEEDED', detail: null },
        { status: 429 },
      ),
    );
    const err = await client.getBalances('acc-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnableBankingError);
    expect(err).toMatchObject({ status: 429, code: 'ASPSP_RATE_LIMIT_EXCEEDED' });
    expect(err).toHaveProperty('message', expect.stringContaining('ASPSP Rate limit exceeded'));
  });

  it('keeps transaction fields it does not model, nested ones too — they are stored raw', async () => {
    const bankTx = {
      entry_reference: 'ref-1',
      transaction_amount: { currency: 'EUR', amount: '12.34' },
      credit_debit_indicator: 'DBIT',
      status: 'BOOK',
      creditor: { name: 'SHOP', postal_address: { country: 'ES' } },
      balance_after_transaction: { currency: 'EUR', amount: '100.00' },
    };
    const { client } = clientWith(() => Response.json({ transactions: [bankTx], continuation_key: null }));
    const page = await client.getTransactions('acc-1', { dateFrom: '2026-01-01' });
    expect(JSON.parse(normalizeTransactions(page.transactions)[0]?.raw ?? '')).toEqual(bankTx);
  });

  it('a response that does not match the spec is an EnableBankingError, not a crash further down', async () => {
    const bad = { transaction_amount: { currency: 'EUR', amount: 12.34 }, credit_debit_indicator: 'DBIT' };
    const { client } = clientWith(() => Response.json({ transactions: [bad] }));
    const err = await client.getTransactions('acc-1', { dateFrom: '2026-01-01' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnableBankingError);
    expect(err).toMatchObject({ status: 200, code: null });
    expect(err).toHaveProperty(
      'message',
      expect.stringMatching(/\/accounts\/acc-1\/transactions .*unexpected response.*amount/s),
    );
  });

  it('keeps the raw body of an error that is not an ErrorResponse', async () => {
    const { client } = clientWith(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await client.getBalances('acc-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: null });
    expect(err).toHaveProperty('message', expect.stringContaining('<html>Bad Gateway</html>'));
  });
});
