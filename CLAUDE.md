# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Long-running Node/TS service that pulls bank transactions over the
Enable Banking PSD2 API into SQLite. One process: a `node:http` web UI
(connect bank / status / manual sync / JSON + CSV export) plus an
in-process scheduler. Optionally pushes booked transactions into ZenMoney
after every sync. Personal use, restricted-production Enable Banking app
(free, own accounts only). Primary bank: imagin (Spain).

CI publishes `ghcr.io/maxmaxme/bank-sync:latest` (and `:sha-<short>`,
arm64) on every push to `main`. Deployment is someone else's job.

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run
npx vitest run tests/sync.test.ts -t "name"
node src/index.ts                 # needs EB_APP_ID, EB_REDIRECT_URL, key file
```

`.env` next to `package.json` is auto-loaded. No lint/format script —
`typecheck` + `test` are the verification path.

## Critical conventions

**Node 24 native TypeScript stripping, no build step.** Relative imports
use `.ts`; no `enum` / `namespace` / parameter properties / decorators
(`erasableSyntaxOnly` enforces it). Declare class fields explicitly.

**Zero native deps.** SQLite is the built-in `node:sqlite`
(`DatabaseSync`), JWT signing is `node:crypto`, HTTP is `node:http`. Only
runtime dep is `pino`. Keep it that way — the image is cross-built for
arm64 under QEMU.

**API shapes come from the real spec**, <https://enablebanking.com/docs/api/reference/>
(server-rendered; grep it rather than trusting summaries). Notable:
errors are `{message, code, error, detail}`; `credit_debit_indicator` is
`CRDT|DBIT`; `strategy` is `default|longest`; `maximum_consent_validity`
is seconds; `continuation_key` is null on the last page.

**Identity across re-consents.** Account `uid` changes with every
session → accounts are keyed by `identification_hash`
(`connect.ts::accountKeyOf`). Transactions are keyed by
`entry_reference`, falling back to `transaction_id`, then a content hash
with an occurrence counter (`transactions.ts`). Changing either key
scheme orphans existing rows — needs a migration.

**Bank quota.** Many ASPSPs allow ~4 unattended fetches/day. The
scheduler measures due-ness from `kv.last_sync_at` (set by every run,
any trigger) so restarts don't spend quota. `Syncer.run` de-duplicates
concurrent calls. Don't add retries that hit the bank in a loop.

**First sync is special.** Banks serve deep history only shortly after
consent: `initial_sync_done = 0` (reset on every re-consent) → 730 days
with `strategy=longest`, falling back to 90 days on a 4xx (not on rate
limit). Later syncs re-read from newest booked date − `OVERLAP_DAYS`.
Pending rows in the re-read window are deleted and re-inserted.

**Redirect flow.** `state = <nonce>.<base64url(returnBase)>`. The nonce
is the CSRF check (`auth_requests`, one-shot, 1 h TTL). The suffix exists
only for `docs/callback.html`, a static GitHub-Pages bounce page that
forwards to `<returnBase>/callback` for LAN-ish hosts. `POST /callback`
accepts a pasted URL as the manual fallback.

**ZenMoney export** (`src/zenmoney/`). API reference:
<https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API>. Everything goes
through `POST /v8/diff/`; we send `serverTimestamp = now` so the server
doesn't stream the user's whole history back, with `forceFetch` for the
account/instrument tables. Token comes from zerro.app (`zm_token`) and is
bound to one server (`zm_server`: ru | app). Invariants: only `BOOK` rows,
never pending; ZenMoney ids are `zmIdFor(accountKey, txKey)` (deterministic,
so retries can't duplicate); a row is marked `zm_pushed_at` only after the
diff call succeeds; currency mismatch is an error, never a silent
conversion. Account mapping + start date live in `accounts.zm_account_id /
zm_since`, set from the UI. Runs as `Syncer`'s `afterRun` hook.

**This repo is public.** Keep host names, deployment paths and other
infra specifics out of code, docs and commit messages.

## Architecture

```
src/index.ts              # entry — config, self-check (GET /application), server, scheduler
src/config.ts             # env → Config
src/env.ts                # requireEnv / optionalEnv / .env loading
src/enablebanking/
  client.ts               # REST client + EnableBankingError
  jwt.ts                  # RS256 app JWT (kid = app id, 1 h TTL)
  types.ts                # API shapes (subset)
src/connect.ts            # start auth / complete auth (state, session → accounts)
src/sync.ts               # Syncer: per-account fetch → normalize → store; notifications on transitions
src/transactions.ts       # PSD2 transaction → row (key, signed cents, counterparty, description)
src/money.ts              # decimal string ↔ integer cents
src/scheduler.ts          # 10-min tick: consent-expiry reminders + due sync
src/storage/              # node:sqlite store; migrations tracked in PRAGMA user_version (append-only)
src/notify/               # Telegram (optional) / NullNotifier
src/zenmoney/             # ZenMoney client (diff, suggest) + exporter
src/web/                  # node:http routes + server-rendered HTML
docs/callback.html        # optional HTTPS bounce page for the redirect URL
tests/                    # vitest, one file per module
```
