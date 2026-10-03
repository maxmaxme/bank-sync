export interface SessionRow {
  sessionId: string;
  aspspName: string;
  aspspCountry: string;
  /** ISO timestamp — the consent stops working after this. */
  validUntil: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface AccountInput {
  /**
   * Stable identity across re-consents (IBAN when the bank gives one). The
   * Enable Banking `uid` changes every time the consent is renewed, so it
   * can't key transactions.
   */
  accountKey: string;
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
}

export interface AccountRow extends AccountInput {
  sessionId: string;
  balanceCents: number | null;
  balanceCurrency: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  initialSyncDone: boolean;
}

export interface AccountView extends AccountRow {
  aspspName: string;
  validUntil: string;
  revokedAt: number | null;
}

export interface NewTransaction {
  txKey: string;
  /** BOOK (posted) | PDNG (pending) | … */
  status: string;
  bookingDate: string | null;
  valueDate: string | null;
  transactionDate: string | null;
  /** The best date we have, used for ordering and window queries. */
  txDate: string | null;
  /** Signed: negative = money out. */
  amountCents: number;
  currency: string;
  counterparty: string | null;
  description: string | null;
  raw: string;
}

export interface TransactionRow extends NewTransaction {
  accountKey: string;
  firstSeenAt: number;
  updatedAt: number;
}

export interface TransactionQuery {
  from?: string;
  to?: string;
  accountKey?: string;
  limit?: number;
}

export interface SyncRun {
  id: number;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  added: number | null;
  error: string | null;
}

export interface Store {
  saveAuthRequest(nonce: string, now: number): void;
  /** Consumes the request: returns true at most once per nonce, and only while fresh. */
  takeAuthRequest(nonce: string, maxAgeMs: number, now: number): boolean;

  saveSession(session: SessionRow, accounts: AccountInput[]): void;
  revokeSession(sessionId: string, now: number): void;
  listSessions(): SessionRow[];

  /** Accounts whose consent is neither revoked nor expired. */
  activeAccounts(now: number): AccountRow[];
  listAccounts(): AccountView[];
  recordAccountSync(
    accountKey: string,
    result:
      | { ok: true; balanceCents: number | null; balanceCurrency: string | null }
      | { ok: false; error: string },
    now: number,
  ): void;

  latestTxDate(accountKey: string): string | null;
  /**
   * Upsert a freshly fetched window. Pending rows from `dateFrom` on are
   * dropped first — a pending card payment often reappears as a booked row
   * under a different key. Returns how many rows were not seen before.
   */
  applyTransactions(accountKey: string, dateFrom: string, txs: NewTransaction[], now: number): number;
  queryTransactions(q: TransactionQuery): TransactionRow[];

  startSyncRun(trigger: string, now: number): number;
  finishSyncRun(id: number, result: { ok: boolean; added: number; error: string | null }, now: number): void;
  recentSyncRuns(limit: number): SyncRun[];

  getKv(key: string): string | null;
  setKv(key: string, value: string): void;

  close(): void;
}
