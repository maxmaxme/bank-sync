import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { MIGRATIONS } from './migrations.ts';
import type { AccountRow, AccountView, SessionRow, Store, SyncRun, TransactionRow } from './types.ts';

// Rows as SQLite hands them back. Parsed, not cast: a migration that drifts
// from these shapes fails loudly at the query instead of leaking undefined.
const text = v.string();
const textOrNull = v.nullable(v.string());
const int = v.number();
const intOrNull = v.nullable(v.number());

const DbSessionSchema = v.object({
  session_id: text,
  aspsp_name: text,
  aspsp_country: text,
  valid_until: text,
  created_at: int,
  revoked_at: intOrNull,
});
type DbSession = v.InferOutput<typeof DbSessionSchema>;

const DbAccountSchema = v.object({
  account_key: text,
  uid: text,
  session_id: text,
  iban: textOrNull,
  name: textOrNull,
  currency: textOrNull,
  balance_cents: intOrNull,
  balance_currency: textOrNull,
  last_synced_at: intOrNull,
  last_error: textOrNull,
  initial_sync_done: int,
  zm_account_id: textOrNull,
  zm_since: textOrNull,
});
type DbAccount = v.InferOutput<typeof DbAccountSchema>;

const DbAccountViewSchema = v.object({
  ...DbAccountSchema.entries,
  aspsp_name: text,
  valid_until: text,
  revoked_at: intOrNull,
});

const DbTransactionSchema = v.object({
  account_key: text,
  tx_key: text,
  status: text,
  booking_date: textOrNull,
  value_date: textOrNull,
  transaction_date: textOrNull,
  tx_date: textOrNull,
  amount_cents: int,
  currency: text,
  counterparty: textOrNull,
  description: textOrNull,
  raw: text,
  first_seen_at: int,
  updated_at: int,
  zm_id: textOrNull,
  zm_pushed_at: intOrNull,
});
type DbTransaction = v.InferOutput<typeof DbTransactionSchema>;

const DbSyncRunSchema = v.object({
  id: int,
  trigger: text,
  started_at: int,
  finished_at: intOrNull,
  ok: intOrNull,
  added: intOrNull,
  error: textOrNull,
});

function all<S extends v.GenericSchema>(schema: S, rows: unknown[]): v.InferOutput<S>[] {
  return v.parse(v.array(schema), rows);
}

function one<S extends v.GenericSchema>(schema: S, row: unknown): v.InferOutput<S> | undefined {
  return row === undefined ? undefined : v.parse(schema, row);
}

function toSession(r: DbSession): SessionRow {
  return {
    sessionId: r.session_id,
    aspspName: r.aspsp_name,
    aspspCountry: r.aspsp_country,
    validUntil: r.valid_until,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  };
}

function toAccount(r: DbAccount): AccountRow {
  return {
    accountKey: r.account_key,
    uid: r.uid,
    sessionId: r.session_id,
    iban: r.iban,
    name: r.name,
    currency: r.currency,
    balanceCents: r.balance_cents,
    balanceCurrency: r.balance_currency,
    lastSyncedAt: r.last_synced_at,
    lastError: r.last_error,
    initialSyncDone: r.initial_sync_done === 1,
    zmAccountId: r.zm_account_id,
    zmSince: r.zm_since,
  };
}

function toTransaction(r: DbTransaction): TransactionRow {
  return {
    accountKey: r.account_key,
    txKey: r.tx_key,
    status: r.status,
    bookingDate: r.booking_date,
    valueDate: r.value_date,
    transactionDate: r.transaction_date,
    txDate: r.tx_date,
    amountCents: r.amount_cents,
    currency: r.currency,
    counterparty: r.counterparty,
    description: r.description,
    raw: r.raw,
    firstSeenAt: r.first_seen_at,
    updatedAt: r.updated_at,
    zmId: r.zm_id,
    zmPushedAt: r.zm_pushed_at,
  };
}

function migrate(db: DatabaseSync): void {
  const row = v.parse(v.object({ user_version: int }), db.prepare('PRAGMA user_version').get());
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  function inTransaction<T>(fn: () => T): T {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const upsertTx = db.prepare(
    `INSERT INTO transactions (
       account_key, tx_key, status, booking_date, value_date, transaction_date, tx_date,
       amount_cents, currency, counterparty, description, raw, first_seen_at, updated_at
     ) VALUES (
       @account_key, @tx_key, @status, @booking_date, @value_date, @transaction_date, @tx_date,
       @amount_cents, @currency, @counterparty, @description, @raw, @now, @now
     )
     ON CONFLICT (account_key, tx_key) DO UPDATE SET
       status = excluded.status,
       booking_date = excluded.booking_date,
       value_date = excluded.value_date,
       transaction_date = excluded.transaction_date,
       tx_date = excluded.tx_date,
       amount_cents = excluded.amount_cents,
       currency = excluded.currency,
       counterparty = excluded.counterparty,
       description = excluded.description,
       raw = excluded.raw,
       updated_at = excluded.updated_at`,
  );

  return {
    saveAuthRequest(nonce, now) {
      db.prepare('INSERT INTO auth_requests (nonce, created_at) VALUES (?, ?)').run(nonce, now);
    },

    takeAuthRequest(nonce, maxAgeMs, now) {
      // Opportunistic cleanup so abandoned connect attempts don't pile up.
      db.prepare('DELETE FROM auth_requests WHERE created_at < ?').run(now - maxAgeMs);
      const res = db.prepare('DELETE FROM auth_requests WHERE nonce = ?').run(nonce);
      return Number(res.changes) === 1;
    },

    saveSession(session, accounts) {
      inTransaction(() => {
        db.prepare(
          `INSERT INTO sessions (session_id, aspsp_name, aspsp_country, valid_until, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT (session_id) DO UPDATE SET valid_until = excluded.valid_until`,
        ).run(session.sessionId, session.aspspName, session.aspspCountry, session.validUntil, session.createdAt);
        const upsertAccount = db.prepare(
          `INSERT INTO accounts (account_key, uid, session_id, iban, name, currency)
           VALUES (@account_key, @uid, @session_id, @iban, @name, @currency)
           ON CONFLICT (account_key) DO UPDATE SET
             uid = excluded.uid,
             session_id = excluded.session_id,
             iban = excluded.iban,
             name = excluded.name,
             currency = excluded.currency,
             last_error = NULL,
             -- Fresh consent: banks typically serve deep history only right after
             -- authorisation, so take another long look back.
             initial_sync_done = 0`,
        );
        for (const a of accounts) {
          upsertAccount.run({
            account_key: a.accountKey,
            uid: a.uid,
            session_id: session.sessionId,
            iban: a.iban,
            name: a.name,
            currency: a.currency,
          });
        }
      });
    },

    revokeSession(sessionId, now) {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE session_id = ?').run(now, sessionId);
    },

    listSessions() {
      const rows = all(DbSessionSchema, db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all());
      return rows.map(toSession);
    },

    activeAccounts(now) {
      const rows = all(
        DbAccountSchema,
        db
          .prepare(
            `SELECT a.* FROM accounts a JOIN sessions s USING (session_id)
           WHERE s.revoked_at IS NULL AND s.valid_until > ?
           ORDER BY a.account_key`,
          )
          .all(new Date(now).toISOString()),
      );
      return rows.map(toAccount);
    },

    listAccounts() {
      const rows = all(
        DbAccountViewSchema,
        db
          .prepare(
            `SELECT a.*, s.aspsp_name, s.valid_until, s.revoked_at
           FROM accounts a JOIN sessions s USING (session_id)
           ORDER BY a.account_key`,
          )
          .all(),
      );
      return rows.map((r): AccountView => ({
        ...toAccount(r),
        aspspName: r.aspsp_name,
        validUntil: r.valid_until,
        revokedAt: r.revoked_at,
      }));
    },

    recordAccountSync(accountKey, result, now) {
      if (result.ok) {
        db.prepare(
          `UPDATE accounts SET
             balance_cents = COALESCE(?, balance_cents),
             balance_currency = COALESCE(?, balance_currency),
             last_synced_at = ?, last_error = NULL, initial_sync_done = 1
           WHERE account_key = ?`,
        ).run(result.balanceCents, result.balanceCurrency, now, accountKey);
      } else {
        db.prepare('UPDATE accounts SET last_error = ? WHERE account_key = ?').run(result.error, accountKey);
      }
    },

    setZenMapping(accountKey, zmAccountId, since) {
      db.prepare('UPDATE accounts SET zm_account_id = ?, zm_since = ? WHERE account_key = ?').run(
        zmAccountId,
        since,
        accountKey,
      );
    },

    unexportedTransactions(accountKey, since, limit) {
      const rows = all(
        DbTransactionSchema,
        db
          .prepare(
            `SELECT * FROM transactions
           WHERE account_key = ? AND status = 'BOOK' AND zm_pushed_at IS NULL AND tx_date >= ?
           ORDER BY tx_date, first_seen_at
           LIMIT ?`,
          )
          .all(accountKey, since, limit),
      );
      return rows.map(toTransaction);
    },

    markExported(accountKey, txKey, zmId, now) {
      db.prepare('UPDATE transactions SET zm_id = ?, zm_pushed_at = ? WHERE account_key = ? AND tx_key = ?').run(
        zmId,
        now,
        accountKey,
        txKey,
      );
    },

    exportStats(accountKey) {
      const row = one(
        v.object({ exported: intOrNull, waiting: intOrNull }),
        db
          .prepare(
            `SELECT
               SUM(zm_pushed_at IS NOT NULL) AS exported,
               SUM(zm_pushed_at IS NULL AND status = 'BOOK' AND tx_date >= COALESCE(a.zm_since, '9999')) AS waiting
             FROM transactions t JOIN accounts a USING (account_key)
             WHERE t.account_key = ?`,
          )
          .get(accountKey),
      );
      return { exported: row?.exported ?? 0, waiting: row?.waiting ?? 0 };
    },

    latestTxDate(accountKey) {
      const row = one(
        v.object({ d: textOrNull }),
        db
          .prepare(`SELECT MAX(tx_date) AS d FROM transactions WHERE account_key = ? AND status = 'BOOK'`)
          .get(accountKey),
      );
      return row?.d ?? null;
    },

    applyTransactions(accountKey, dateFrom, txs, now) {
      return inTransaction(() => {
        const existing = new Set(
          all(
            v.object({ tx_key: text }),
            db
              .prepare(
                `SELECT tx_key FROM transactions
                   WHERE account_key = ? AND (tx_date IS NULL OR tx_date >= ?)`,
              )
              .all(accountKey, dateFrom),
          ).map((r) => r.tx_key),
        );
        db.prepare(
          `DELETE FROM transactions
           WHERE account_key = ? AND status = 'PDNG' AND (tx_date IS NULL OR tx_date >= ?)`,
        ).run(accountKey, dateFrom);

        let added = 0;
        for (const t of txs) {
          if (!existing.has(t.txKey)) {
            added++;
          }
          upsertTx.run({
            account_key: accountKey,
            tx_key: t.txKey,
            status: t.status,
            booking_date: t.bookingDate,
            value_date: t.valueDate,
            transaction_date: t.transactionDate,
            tx_date: t.txDate,
            amount_cents: t.amountCents,
            currency: t.currency,
            counterparty: t.counterparty,
            description: t.description,
            raw: t.raw,
            now,
          });
        }
        return added;
      });
    },

    queryTransactions(q) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.from) {
        where.push('tx_date >= ?');
        params.push(q.from);
      }
      if (q.to) {
        where.push('tx_date <= ?');
        params.push(q.to);
      }
      if (q.accountKey) {
        where.push('account_key = ?');
        params.push(q.accountKey);
      }
      const sql =
        `SELECT * FROM transactions` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY tx_date DESC, first_seen_at DESC` +
        (q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : '');
      const rows = all(DbTransactionSchema, db.prepare(sql).all(...params));
      return rows.map(toTransaction);
    },

    startSyncRun(trigger, now) {
      const res = db.prepare('INSERT INTO sync_runs (trigger, started_at) VALUES (?, ?)').run(trigger, now);
      return Number(res.lastInsertRowid);
    },

    finishSyncRun(id, result, now) {
      db.prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, added = ?, error = ? WHERE id = ?').run(
        now,
        result.ok ? 1 : 0,
        result.added,
        result.error,
        id,
      );
    },

    recentSyncRuns(limit) {
      const rows = all(DbSyncRunSchema, db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit));
      return rows.map((r): SyncRun => ({
        id: r.id,
        trigger: r.trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        ok: r.ok === null ? null : r.ok === 1,
        added: r.added,
        error: r.error,
      }));
    },

    getKv(key) {
      const row = one(v.object({ value: text }), db.prepare('SELECT value FROM kv WHERE key = ?').get(key));
      return row?.value ?? null;
    },

    setKv(key, value) {
      db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },

    close() {
      db.close();
    },
  };
}
