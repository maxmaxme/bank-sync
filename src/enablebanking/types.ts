// Subset of the Enable Banking API shapes this service touches, as schemas:
// every response is parsed, not cast. Only the fields we read are listed;
// required vs optional follows the spec, except where noted.
// Reference: https://enablebanking.com/docs/api/reference/

import * as v from 'valibot';

/** Absent or null — the spec's "not required" fields come back both ways. */
const nullishString = v.nullish(v.string());

// Loose: nested inside a Transaction, which is stored raw (see below).
const AmountSchema = v.looseObject({
  currency: v.string(),
  amount: v.string(),
});

export const ApplicationSchema = v.object({
  name: v.string(),
  /** SANDBOX | PRODUCTION */
  environment: v.string(),
  redirect_urls: v.array(v.string()),
  active: v.boolean(),
});
export type Application = v.InferOutput<typeof ApplicationSchema>;

const AspspSchema = v.object({
  name: v.string(),
  country: v.string(),
  /** Seconds. */
  maximum_consent_validity: v.number(),
  // Required by the spec, but only shown as a label — a bank list without it is still usable.
  beta: v.optional(v.boolean()),
  /** Headers that mark a data request as "PSU online" (all or none must be sent). */
  required_psu_headers: v.nullish(v.array(v.string())),
});
export type Aspsp = v.InferOutput<typeof AspspSchema>;

export const AspspsResponseSchema = v.object({ aspsps: v.array(AspspSchema) });

const AspspRefSchema = v.object({
  name: v.string(),
  country: v.string(),
});
export type AspspRef = v.InferOutput<typeof AspspRefSchema>;

export const StartAuthResponseSchema = v.object({ url: v.string() });
export type StartAuthResponse = v.InferOutput<typeof StartAuthResponseSchema>;

// AccountResource in the spec.
const SessionAccountSchema = v.object({
  /**
   * Valid only within this session; changes on every re-consent. Absent when
   * the bank already knows the account can't be read (blocked, closed).
   */
  uid: nullishString,
  /** Global, stable across sessions — the right key for "same account". */
  identification_hash: v.string(),
  account_id: v.nullish(v.object({ iban: nullishString })),
  name: nullishString,
  // Required by the spec, but nothing breaks without it.
  currency: nullishString,
});
export type SessionAccount = v.InferOutput<typeof SessionAccountSchema>;

export const SessionResponseSchema = v.object({
  session_id: v.string(),
  accounts: v.array(SessionAccountSchema),
  aspsp: AspspRefSchema,
  access: v.object({ valid_until: v.string() }),
});
export type SessionResponse = v.InferOutput<typeof SessionResponseSchema>;

const PartySchema = v.looseObject({
  name: nullishString,
});

/**
 * Stored verbatim (`transactions.raw`) and served back by the JSON export, so
 * every object in it is loose: fields we don't model survive the parse.
 */
const TransactionSchema = v.looseObject({
  /** ASPSP id, immutable across sessions for the same account (not globally unique). */
  entry_reference: nullishString,
  transaction_id: nullishString,
  transaction_amount: AmountSchema,
  credit_debit_indicator: v.picklist(['CRDT', 'DBIT']),
  /**
   * BOOK | PDNG | CNCL | HOLD | OTHR | RJCT | SCHD. Required by the spec;
   * a missing one reads as BOOK, and an unknown value isn't worth failing the page.
   */
  status: nullishString,
  booking_date: nullishString,
  value_date: nullishString,
  transaction_date: nullishString,
  creditor: v.nullish(PartySchema),
  debtor: v.nullish(PartySchema),
  remittance_information: v.nullish(v.array(v.string())),
  bank_transaction_code: v.nullish(v.looseObject({ description: nullishString })),
  merchant_category_code: nullishString,
  note: nullishString,
});
export type Transaction = v.InferOutput<typeof TransactionSchema>;

export const TransactionsPageSchema = v.object({
  transactions: v.array(TransactionSchema),
  /** Null (or absent) on the last page. */
  continuation_key: nullishString,
});
export type TransactionsPage = v.InferOutput<typeof TransactionsPageSchema>;

const BalanceSchema = v.object({
  balance_amount: AmountSchema,
  // Required by the spec; optional here because a missing one just means "no match" in sync.
  balance_type: v.optional(v.string()),
});
export type Balance = v.InferOutput<typeof BalanceSchema>;

export const BalancesResponseSchema = v.object({ balances: v.array(BalanceSchema) });
export type BalancesResponse = v.InferOutput<typeof BalancesResponseSchema>;

/** ErrorResponse: `{ message, code (= HTTP status), error (ErrorCode), detail }`. Lenient: it only feeds a message. */
export const ErrorResponseSchema = v.object({
  message: nullishString,
  error: nullishString,
  detail: v.optional(v.unknown()),
});

/** The part of the client that sync depends on — kept small so tests can fake it. */
export interface AccountApi {
  getTransactions(
    accountUid: string,
    opts: { dateFrom: string; continuationKey?: string; strategy?: 'default' | 'longest' },
  ): Promise<TransactionsPage>;
  getBalances(accountUid: string): Promise<BalancesResponse>;
}
