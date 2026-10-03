import pino from 'pino';
import type { Transaction } from '../src/enablebanking/types.ts';
import type { Notifier } from '../src/notify/types.ts';
import type { Logger } from '../src/logger.ts';

export const silentLog = pino({ level: 'silent' }) as unknown as Logger;

export function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    entry_reference: 'ref-1',
    transaction_amount: { currency: 'EUR', amount: '12.34' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-30',
    creditor: { name: 'MERCADONA' },
    remittance_information: ['COMPRA TARJ. 1234'],
    ...overrides,
  };
}

export class RecordingNotifier implements Notifier {
  readonly events: string[] = [];
  async syncFailed(error: string) {
    this.events.push(`failed:${error}`);
  }
  async syncRecovered() {
    this.events.push('recovered');
  }
  async consentExpiring(input: { aspsp: string; daysLeft: number }) {
    this.events.push(`expiring:${input.aspsp}:${input.daysLeft}`);
  }
  async consentExpired(input: { aspsp: string }) {
    this.events.push(`expired:${input.aspsp}`);
  }
  async exportFailed(error: string, tokenExpired: boolean) {
    this.events.push(`export-failed:${tokenExpired ? 'auth' : error}`);
  }
  async exportRecovered() {
    this.events.push('export-recovered');
  }
}
