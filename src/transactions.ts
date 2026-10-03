import { createHash } from 'node:crypto';
import { signedCents } from './money.ts';
import type { Transaction } from './enablebanking/types.ts';
import type { NewTransaction } from './storage/types.ts';

/**
 * Map raw PSD2 transactions to rows. The row key is the bank's own
 * `entry_reference` / `transaction_id` when present; otherwise a content hash
 * plus an occurrence counter, so two identical coffees on the same day stay
 * two rows. The counter is stable across re-fetches because the bank returns
 * the same transactions in the same order for an overlapping date window.
 */
export function normalizeTransactions(txs: readonly Transaction[]): NewTransaction[] {
  const occurrences = new Map<string, number>();

  return txs.map((tx) => {
    const status = tx.status ?? 'BOOK';
    const counterparty = counterpartyOf(tx);
    const description = descriptionOf(tx);
    const amountCents = signedCents(tx.transaction_amount.amount, tx.credit_debit_indicator);
    const bookingDate = tx.booking_date ?? null;
    const valueDate = tx.value_date ?? null;
    const transactionDate = tx.transaction_date ?? null;

    let txKey = tx.entry_reference || tx.transaction_id || null;
    if (!txKey) {
      const base =
        'h:' +
        createHash('sha256')
          .update(
            JSON.stringify([
              status,
              bookingDate,
              valueDate,
              transactionDate,
              amountCents,
              tx.transaction_amount.currency,
              counterparty,
              description,
            ]),
          )
          .digest('hex')
          .slice(0, 20);
      const n = occurrences.get(base) ?? 0;
      occurrences.set(base, n + 1);
      txKey = `${base}#${n}`;
    }

    return {
      txKey,
      status,
      bookingDate,
      valueDate,
      transactionDate,
      txDate: bookingDate ?? transactionDate ?? valueDate,
      amountCents,
      currency: tx.transaction_amount.currency,
      counterparty,
      description,
      raw: JSON.stringify(tx),
    };
  });
}

function counterpartyOf(tx: Transaction): string | null {
  // Money out → who we paid (creditor); money in → who paid us (debtor).
  const party = tx.credit_debit_indicator === 'CRDT' ? tx.debtor : tx.creditor;
  return party?.name?.trim() || null;
}

function descriptionOf(tx: Transaction): string | null {
  const parts = (tx.remittance_information ?? []).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' ');
  }
  return tx.bank_transaction_code?.description?.trim() || tx.note?.trim() || null;
}
