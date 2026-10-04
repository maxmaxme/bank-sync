# bank-sync

Self-hosted sync of bank account transactions into SQLite over
[Enable Banking](https://enablebanking.com) — the official PSD2 / open
banking API, no scraping and no bank passwords stored anywhere. Built for
one person tracking their own spending; tested target is imagin (CaixaBank
group, Spain), but any bank Enable Banking supports works the same way.

One small container:

- **web UI** — connect a bank, see balances and recent transactions,
  trigger a sync, revoke access;
- **scheduler** — pulls new transactions every few hours;
- **API** — `GET /api/transactions` (JSON) and `GET /export.csv` for
  whatever expense tracker you feed;
- **ZenMoney export** (optional) — new booked transactions are written
  straight into a ZenMoney account after every sync.

No auth of its own — put it behind your reverse proxy / SSO.

## How it works

```
phone browser ──► bank-sync /connect ──► Enable Banking ──► bank (approve in the bank app)
      ▲                                                          │
      └────────── redirect URL ?code=…&state=… ◄──────────────────┘
bank-sync: POST /sessions(code) → session + accounts → first sync
scheduler: every N hours → GET /accounts/{uid}/transactions → SQLite
```

Things worth knowing about PSD2 that shape the design:

- **Consent lasts up to ~180 days** (bank-specific). After that you
  approve again from the UI; with Telegram configured you get reminders
  in the last week.
- **~4 unattended fetches per day** per consent at many banks. The
  scheduler tracks the last sync in the DB so restarts and manual syncs
  don't burn extra quota. Default interval: 8 h.
- **Deep history is usually only available right after you approve**
  (often within the first hour). The first sync runs immediately and asks
  for two years with Enable Banking's `longest` strategy; later syncs only
  re-read the last few days.
- Accounts are keyed by Enable Banking's stable `identification_hash`,
  transactions by the bank's `entry_reference`, so re-consenting doesn't
  duplicate anything. Pending rows are replaced on every sync.

## Setup

### 1. Enable Banking application (free for your own accounts)

1. Sign up at <https://enablebanking.com/cp/> and create an application:
   environment **Production**, your redirect URL (see below). The control
   panel generates a key pair in the browser and downloads the private key
   as `<app-id>.pem`.
2. **Activate it by linking your own accounts** in the control panel
   ("restricted production"). That's the free tier: real data, but only
   from accounts you linked yourself.

### 2. Redirect URL

After you approve in the bank, the browser is sent to the redirect URL
with `?code=…&state=…`. Pick one:

- **Direct** — register `https://<where bank-sync is reachable>/callback`
  if you already serve it over HTTPS.
- **Bounce page** — publish [`docs/callback.html`](docs/callback.html)
  (e.g. GitHub Pages → `https://<user>.github.io/bank-sync/callback.html`)
  and register that. bank-sync puts its own address into `state`; the page
  forwards the browser back to `<that address>/callback`, and only to
  LAN-ish hosts (`*.home`, `*.local`, `*.lan`, `*.ts.net`, private IPs).
- **Paste** — register anything you control. When you land there, copy
  the URL from the address bar into the UI's "didn't come back?" form.

The authorization code alone is useless without the app's private key.

### 3. Run

```bash
docker run -d --name bank-sync \
  -p 8080:8080 \
  -e EB_APP_ID=<app-id> \
  -e EB_REDIRECT_URL=https://<user>.github.io/bank-sync/callback.html \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/maxmaxme/bank-sync:latest
```

Put the key at `data/enablebanking.pem` (or set `EB_PRIVATE_KEY_PATH`).
On startup the service calls `GET /application` and shows a warning in the
UI if the key, app id or redirect URL don't match.

### 4. Connect

Open the UI **on your phone**, pick the bank, approve in the bank's app.
Desktop works for most banks too, but imagin hands the approval to its
mobile app.

## ZenMoney export

ZenMoney has no self-service API keys; its docs point to
[zerro.app](https://zerro.app) instead. Sign in there, then in the browser
console copy `localStorage.zm_token` → `ZENMONEY_TOKEN` and
`localStorage.zm_server` → `ZENMONEY_SERVER` (`ru` or `app`).

Then, in the UI's **ZenMoney** section, pick the ZenMoney account for each
bank account (the one whose `syncID` ends with the IBAN's last 4 digits is
preselected) and the date to export from — anything older is assumed to
be in ZenMoney already. After that, every sync pushes the new rows:

- only **booked** transactions; pending ones wait until the bank books
  them, so nothing has to be rewritten later;
- ZenMoney's own `/suggest` fills in the normalised payee, merchant and
  category, the same guess its app makes for manual entries;
- the ZenMoney id is derived from the row key, and exported rows are
  marked in SQLite — a row is never sent twice, and a retry after a lost
  response overwrites rather than duplicates;
- transactions arrive unread (`viewed: false`), so the app shows them as
  new; transfers between your own accounts come in as plain income /
  expense — re-mark them in ZenMoney if you care.

If the token stops working you get one Telegram message; put a fresh one
into `ZENMONEY_TOKEN` and restart.

## Configuration

| Var                                      | Default                                 |                                               |
| ---------------------------------------- | --------------------------------------- | --------------------------------------------- |
| `EB_APP_ID`                              | —                                       | required                                      |
| `EB_REDIRECT_URL`                        | —                                       | required, must match a registered URL exactly |
| `EB_PRIVATE_KEY_PATH`                    | `$BANK_SYNC_DATA_DIR/enablebanking.pem` |                                               |
| `EB_COUNTRY`                             | `ES`                                    | banks listed in the picker                    |
| `EB_ASPSP`                               | `imagin`                                | preselected bank (substring match)            |
| `SYNC_INTERVAL_HOURS`                    | `8`                                     |                                               |
| `ZENMONEY_TOKEN`                         | —                                       | enables the ZenMoney export                   |
| `ZENMONEY_SERVER`                        | `ru`                                    | `ru` or `app` — where the token was issued    |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | —                                       | optional notifications                        |
| `BANK_SYNC_DATA_DIR`                     | `/app/data`                             | SQLite lives here                             |
| `PORT`                                   | `8080`                                  |                                               |
| `LOG_LEVEL`                              | `info`                                  |                                               |

See [`.env.example`](.env.example).

## API

|                                                              |                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/transactions?from=YYYY-MM-DD&to=…&account=…&raw=1` | newest first; `amount` is a signed decimal string (negative = money out), `amount_cents` the same as an integer; `raw=1` adds the bank's original record |
| `GET /export.csv?from=…&to=…`                                | same rows as CSV                                                                                                                                         |
| `GET /api/accounts`                                          | accounts, balances, consent expiry, last error                                                                                                           |
| `GET /health`                                                | liveness                                                                                                                                                 |

The SQLite file (`bank-sync.sqlite`) is yours to query directly too —
table `transactions`, `amount_cents` signed.

## Development

```bash
npm install            # also sets up the git hooks
npm run check          # format, lint, knip, typecheck, tests
cp .env.example .env   # fill in, BANK_SYNC_DATA_DIR=./data
node src/index.ts
```

Node 24 runs the TypeScript directly (type stripping) — no build step.
