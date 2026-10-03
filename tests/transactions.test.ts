import { describe, expect, it } from 'vitest';
import { normalizeTransactions } from '../src/transactions.ts';
import { tx } from './helpers.ts';

describe('normalizeTransactions', () => {
  it('uses entry_reference as the key and signs the amount', () => {
    const [row] = normalizeTransactions([tx()]);
    expect(row).toMatchObject({
      txKey: 'ref-1',
      status: 'BOOK',
      txDate: '2026-09-30',
      amountCents: -1234,
      currency: 'EUR',
      counterparty: 'MERCADONA',
      description: 'COMPRA TARJ. 1234',
    });
  });

  it('falls back to transaction_id, then a content hash', () => {
    const [byId] = normalizeTransactions([tx({ entry_reference: null, transaction_id: 'tid-9' })]);
    expect(byId?.txKey).toBe('tid-9');

    const [hashed] = normalizeTransactions([tx({ entry_reference: null })]);
    expect(hashed?.txKey).toMatch(/^h:[0-9a-f]{20}#0$/);
  });

  it('keeps identical id-less transactions apart, stably across re-fetches', () => {
    const batch = [tx({ entry_reference: null }), tx({ entry_reference: null })];
    const first = normalizeTransactions(batch).map((r) => r.txKey);
    const second = normalizeTransactions(batch).map((r) => r.txKey);
    expect(first[0]).not.toBe(first[1]);
    expect(first[0]?.endsWith('#0')).toBe(true);
    expect(first[1]?.endsWith('#1')).toBe(true);
    expect(second).toEqual(first);
  });

  it('takes the payer as counterparty for incoming money', () => {
    const [row] = normalizeTransactions([
      tx({ credit_debit_indicator: 'CRDT', debtor: { name: 'ACME SL' }, creditor: { name: 'ME' } }),
    ]);
    expect(row?.counterparty).toBe('ACME SL');
    expect(row?.amountCents).toBe(1234);
  });

  it('falls back to the bank transaction code when there is no remittance info', () => {
    const [row] = normalizeTransactions([
      tx({ remittance_information: [], bank_transaction_code: { description: 'Transferencia' } }),
    ]);
    expect(row?.description).toBe('Transferencia');
  });

  it('dates pending rows by transaction date when there is no booking date', () => {
    const [row] = normalizeTransactions([
      tx({ status: 'PDNG', booking_date: null, transaction_date: '2026-10-02' }),
    ]);
    expect(row?.txDate).toBe('2026-10-02');
  });
});
