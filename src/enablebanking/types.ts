// Subset of the Enable Banking API shapes this service touches.
// Reference: https://enablebanking.com/docs/api/reference/

export interface Amount {
  currency: string;
  amount: string;
}

export interface Application {
  name: string;
  kid: string;
  /** SANDBOX | PRODUCTION */
  environment: string;
  redirect_urls: string[];
  active: boolean;
  countries?: string[];
  services?: string[];
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  /** Seconds. */
  maximum_consent_validity: number;
  psu_types?: string[];
  beta?: boolean;
  /** Headers that mark a data request as "PSU online" (all or none must be sent). */
  required_psu_headers?: string[];
}

export interface AspspRef {
  name: string;
  country: string;
}

export interface StartAuthResponse {
  url: string;
  authorization_id?: string;
}

export interface SessionAccount {
  /** Valid only within this session; changes on every re-consent. */
  uid: string;
  /** Global, stable across sessions — the right key for "same account". */
  identification_hash: string;
  account_id?: { iban?: string; other?: { identification?: string } } | null;
  name?: string | null;
  currency?: string | null;
}

export interface SessionResponse {
  session_id: string;
  accounts: SessionAccount[];
  aspsp: AspspRef;
  access: { valid_until: string };
}

export interface Party {
  name?: string;
}

export interface Transaction {
  /** ASPSP id, immutable across sessions for the same account (not globally unique). */
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: Amount;
  credit_debit_indicator: 'CRDT' | 'DBIT';
  /** BOOK | PDNG | CNCL | HOLD | OTHR | RJCT | SCHD */
  status: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: Party | null;
  debtor?: Party | null;
  remittance_information?: string[] | null;
  bank_transaction_code?: { description?: string | null } | null;
  merchant_category_code?: string | null;
  note?: string | null;
}

export interface TransactionsPage {
  transactions: Transaction[];
  continuation_key?: string | null;
}

export interface Balance {
  name?: string;
  balance_amount: Amount;
  balance_type?: string;
  reference_date?: string | null;
}

export interface BalancesResponse {
  balances: Balance[];
}

/** The part of the client that sync depends on — kept small so tests can fake it. */
export interface AccountApi {
  getTransactions(
    accountUid: string,
    opts: { dateFrom: string; continuationKey?: string; strategy?: 'default' | 'longest' },
  ): Promise<TransactionsPage>;
  getBalances(accountUid: string): Promise<BalancesResponse>;
}
