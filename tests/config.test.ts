import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

const read = (path: string) => `PEM from ${path}`;

describe('loadConfig', () => {
  it('applies defaults and reads the key from the data dir', () => {
    const c = loadConfig({ EB_APP_ID: 'app', EB_REDIRECT_URL: 'https://x/cb' }, read);
    expect(c).toMatchObject({
      dataDir: '/app/data',
      port: 8080,
      appId: 'app',
      privateKeyPem: 'PEM from /app/data/enablebanking.pem',
      country: 'ES',
      preferredAspsp: 'imagin',
      syncIntervalMs: 8 * 3600_000,
      telegram: null,
    });
  });

  it('enables Telegram only when both token and chat id are set', () => {
    const base = { EB_APP_ID: 'app', EB_REDIRECT_URL: 'https://x/cb' };
    expect(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 't' }, read).telegram).toBeNull();
    expect(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }, read).telegram).toEqual({
      token: 't',
      chatId: '1',
    });
  });

  it('rejects missing required vars and silly intervals', () => {
    expect(() => loadConfig({ EB_REDIRECT_URL: 'https://x/cb' }, read)).toThrow(/EB_APP_ID/);
    expect(() =>
      loadConfig({ EB_APP_ID: 'a', EB_REDIRECT_URL: 'https://x/cb', SYNC_INTERVAL_HOURS: '0.5' }, read),
    ).toThrow(/SYNC_INTERVAL_HOURS/);
  });
});
