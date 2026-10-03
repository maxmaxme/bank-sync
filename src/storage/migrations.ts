// Applied in order; `PRAGMA user_version` records how many have run.
// Append only — never edit a migration that has shipped.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE auth_requests (
    nonce TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE accounts (
    account_key TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    iban TEXT,
    name TEXT,
    currency TEXT,
    balance_cents INTEGER,
    balance_currency TEXT,
    last_synced_at INTEGER,
    last_error TEXT,
    initial_sync_done INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE transactions (
    account_key TEXT NOT NULL REFERENCES accounts(account_key),
    tx_key TEXT NOT NULL,
    status TEXT NOT NULL,
    booking_date TEXT,
    value_date TEXT,
    transaction_date TEXT,
    tx_date TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    counterparty TEXT,
    description TEXT,
    raw TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, tx_key)
  );
  CREATE INDEX idx_transactions_date ON transactions(tx_date);

  CREATE TABLE sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    added INTEGER,
    error TEXT
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- ZenMoney export: which ZenMoney account a bank account feeds, from which
  -- date, and which rows have already been written there.
  ALTER TABLE accounts ADD COLUMN zm_account_id TEXT;
  ALTER TABLE accounts ADD COLUMN zm_since TEXT;
  ALTER TABLE transactions ADD COLUMN zm_id TEXT;
  ALTER TABLE transactions ADD COLUMN zm_pushed_at INTEGER;
  `,
];
