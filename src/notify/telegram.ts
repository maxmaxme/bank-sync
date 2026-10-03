import type { Notifier } from './types.ts';

export interface TelegramNotifierOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
}

export class TelegramNotifier implements Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramNotifierOptions) {
    this.token = opts.token;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  syncFailed(error: string): Promise<void> {
    return this.send(`✗ bank-sync: sync failed.\n${error}`);
  }

  syncRecovered(): Promise<void> {
    return this.send('✓ bank-sync: sync is working again.');
  }

  consentExpiring(input: { aspsp: string; validUntil: string; daysLeft: number }): Promise<void> {
    return this.send(
      `⚠ bank-sync: access to ${input.aspsp} expires in ${input.daysLeft} day(s) ` +
        `(${input.validUntil.slice(0, 10)}). Reconnect the bank in the web UI.`,
    );
  }

  consentExpired(input: { aspsp: string }): Promise<void> {
    return this.send(
      `⛔ bank-sync: access to ${input.aspsp} has expired, no new transactions will arrive. ` +
        `Reconnect the bank in the web UI.`,
    );
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<no body>');
      throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
    }
  }
}

/** Used when Telegram isn't configured. */
export class NullNotifier implements Notifier {
  async syncFailed(): Promise<void> {}
  async syncRecovered(): Promise<void> {}
  async consentExpiring(): Promise<void> {}
  async consentExpired(): Promise<void> {}
}
