import { formatCents } from '../money.ts';
import type { Aspsp } from '../enablebanking/types.ts';
import type { AccountView, SessionRow, SyncRun, TransactionRow } from '../storage/types.ts';
import type { ExportResult } from '../zenmoney/export.ts';

export interface ZenSection {
  /** Couldn't reach ZenMoney (bad token, wrong server, …). */
  error: string | null;
  choices: { id: string; title: string; currency: string }[];
  rows: {
    accountKey: string;
    label: string;
    current: string | null;
    suggested: string | null;
    since: string;
    exported: number;
    waiting: number;
  }[];
  last: ExportResult | null;
}

export interface PageModel {
  now: Date;
  flash: { kind: 'ok' | 'err'; text: string } | null;
  sessions: SessionRow[];
  accounts: AccountView[];
  runs: SyncRun[];
  syncing: boolean;
  transactions: TransactionRow[];
  aspsps: Aspsp[] | null;
  aspspError: string | null;
  preferredAspsp: string;
  setupWarning: string | null;
  /** null when ZENMONEY_TOKEN isn't set. */
  zen: ZenSection | null;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

function fmtTime(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

function money(cents: number | null, currency: string | null): string {
  if (cents === null) {
    return '—';
  }
  return `${formatCents(cents)} ${e(currency ?? '')}`;
}

function maskIban(iban: string | null): string {
  if (!iban) {
    return '';
  }
  return `${iban.slice(0, 4)} … ${iban.slice(-4)}`;
}

function daysLeft(validUntil: string, now: Date): number {
  return Math.floor((Date.parse(validUntil) - now.getTime()) / 86_400_000);
}

function sessionsSection(m: PageModel): string {
  const live = m.sessions.filter((s) => s.revokedAt === null);
  if (live.length === 0) {
    return '<p class="muted">No bank connected yet.</p>';
  }
  const rows = live
    .map((s) => {
      const left = daysLeft(s.validUntil, m.now);
      const status =
        left < 0
          ? '<span class="bad">expired — reconnect</span>'
          : `until ${e(s.validUntil.slice(0, 10))} <span class="${left <= 7 ? 'bad' : 'muted'}">(${left} days)</span>`;
      return `<li><b>${e(s.aspspName)}</b> — access ${status}
        <form method="post" action="/sessions/${encodeURIComponent(s.sessionId)}/delete" class="inline"
          onsubmit="return confirm('Revoke access? Stored transactions are kept.')">
          <button class="link">disconnect</button></form></li>`;
    })
    .join('');
  return `<ul class="plain">${rows}</ul>`;
}

function accountsSection(m: PageModel): string {
  const live = m.accounts.filter((a) => a.revokedAt === null);
  if (live.length === 0) {
    return '';
  }
  const cards = live
    .map(
      (a) => `<div class="card">
        <div class="row"><b>${e(a.name ?? a.aspspName)}</b><span class="muted">${e(maskIban(a.iban))}</span></div>
        <div class="balance">${money(a.balanceCents, a.balanceCurrency)}</div>
        <div class="muted small">synced: ${fmtTime(a.lastSyncedAt)}</div>
        ${a.lastError ? `<div class="bad small">${e(a.lastError)}</div>` : ''}
      </div>`,
    )
    .join('');
  return `<div class="cards">${cards}</div>`;
}

function syncSection(m: PageModel): string {
  const runs = m.runs
    .map(
      (r) => `<li>${fmtTime(r.startedAt)} · ${e(r.trigger)} ·
        ${r.ok === null ? 'running…' : r.ok ? `ok, new: ${r.added ?? 0}` : `<span class="bad">failed</span>`}
        ${r.error ? `<div class="bad small pre">${e(r.error)}</div>` : ''}</li>`,
    )
    .join('');
  return `
    <form method="post" action="/sync">
      <button ${m.syncing ? 'disabled' : ''}>${m.syncing ? 'Sync running…' : 'Sync now'}</button>
      <div class="muted small">Banks allow ~4 unattended fetches a day — don't press it for fun.</div>
    </form>
    ${runs ? `<ul class="plain small">${runs}</ul>` : ''}`;
}

function connectSection(m: PageModel): string {
  let picker: string;
  if (m.aspsps === null) {
    picker = `<p class="bad">Could not load the bank list: ${e(m.aspspError ?? 'unknown error')}</p>`;
  } else {
    const wanted = m.preferredAspsp.toLowerCase();
    const preselected = m.aspsps.find((a) => a.name.toLowerCase().includes(wanted))?.name;
    const options = m.aspsps
      .map(
        (a) =>
          `<option value="${e(a.name)}" ${a.name === preselected ? 'selected' : ''}>${e(a.name)}${a.beta ? ' (beta)' : ''}</option>`,
      )
      .join('');
    picker = `<form method="post" action="/connect" class="row">
        <select name="aspsp">${options}</select>
        <button>Connect</button>
      </form>`;
  }
  return `${picker}
    <p class="muted small">Open this page on your phone: the bank hands the approval over to its app.</p>
    <details>
      <summary class="small">Didn't come back here after approving?</summary>
      <form method="post" action="/callback" class="stack">
        <label class="small">Paste the URL of the page the bank sent you to (it contains <code>code=</code>):</label>
        <input name="url" placeholder="https://…?state=…&amp;code=…" autocomplete="off">
        <button>Finish connecting</button>
      </form>
    </details>`;
}

function zenSection(m: PageModel): string {
  const z = m.zen;
  if (!z) {
    return '<p class="muted small">Off — set <code>ZENMONEY_TOKEN</code> to export transactions to ZenMoney.</p>';
  }
  if (z.error) {
    return `<p class="bad">Can't reach ZenMoney: ${e(z.error)}</p>`;
  }
  const rows = z.rows
    .map((r) => {
      const selected = r.current ?? r.suggested;
      const options = [
        `<option value="" ${selected ? '' : 'selected'}>— don't export —</option>`,
        ...z.choices.map(
          (c) =>
            `<option value="${e(c.id)}" ${c.id === selected ? 'selected' : ''}>${e(c.title)} (${e(c.currency)})${c.id === r.suggested && !r.current ? ' — suggested' : ''}</option>`,
        ),
      ].join('');
      const status = r.current
        ? `<span class="muted small">exported ${r.exported}${r.waiting ? `, waiting ${r.waiting}` : ''}</span>`
        : '<span class="muted small">not exporting</span>';
      return `<form method="post" action="/zenmoney/map" class="card stack">
        <div class="row"><b>${e(r.label)}</b>${status}</div>
        <input type="hidden" name="account" value="${e(r.accountKey)}">
        <label class="small muted">ZenMoney account</label>
        <select name="zm_account">${options}</select>
        <label class="small muted">Export transactions dated from</label>
        <input type="date" name="since" value="${e(r.since)}">
        <button>Save</button>
      </form>`;
    })
    .join('');
  const last = z.last
    ? `<p class="small">Last export: ${fmtTime(z.last.at)} · ${
        z.last.ok ? `ok, sent ${z.last.exported}` : `<span class="bad">failed</span>`
      }${z.last.error ? `<span class="bad pre"> — ${e(z.last.error)}</span>` : ''}</p>`
    : '';
  return `<div class="cards">${rows}</div>
    <p class="muted small">Booked transactions go to ZenMoney after every sync, with ZenMoney's own payee/category guess. Pending ones wait until the bank books them.</p>
    ${last}
    <form method="post" action="/zenmoney/export"><button>Export now</button></form>`;
}

function transactionsSection(m: PageModel): string {
  if (m.transactions.length === 0) {
    return '<p class="muted">No transactions yet.</p>';
  }
  const rows = m.transactions
    .map((t) => {
      const title = t.counterparty ?? t.description ?? '—';
      const sub = [t.txDate ?? '', t.counterparty && t.description ? t.description : ''].filter(Boolean).join(' · ');
      return `<tr class="${t.status === 'PDNG' ? 'pending' : ''}">
        <td class="desc">${e(title)}${t.status === 'PDNG' ? ' <span class="tag">pending</span>' : ''}
          <div class="muted small">${e(sub)}</div></td>
        <td class="num ${t.amountCents < 0 ? '' : 'good'}">${money(t.amountCents, t.currency)}</td>
      </tr>`;
    })
    .join('');
  return `<table>${rows}</table>
    <p class="small"><a href="/export.csv">CSV</a> · <a href="/api/transactions">JSON</a> · <a href="/api/accounts">accounts (JSON)</a></p>`;
}

export function renderPage(m: PageModel): string {
  const flash = m.flash ? `<div class="flash ${m.flash.kind}">${e(m.flash.text)}</div>` : '';
  const warning = m.setupWarning ? `<div class="flash err">${e(m.setupWarning)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bank-sync</title>
<style>
  :root { --bg:#f6f7f9; --fg:#16181d; --card:#fff; --muted:#6b7280; --line:#e5e7eb; --bad:#c0262d; --good:#13804b; --accent:#2b59c3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e6e6e6; --card:#1e2127; --muted:#8b93a1; --line:#2c313a; --bad:#ff6b6b; --good:#4cc38a; --accent:#7aa2ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font:15px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:760px; margin:0 auto; }
  h1 { font-size:1.2rem; margin:0 0 12px; }
  h2 { font-size:1rem; margin:24px 0 8px; color:var(--muted); font-weight:600; }
  a { color:var(--accent); }
  .muted { color:var(--muted); } .bad { color:var(--bad); } .good { color:var(--good); }
  .small { font-size:.85rem; } .nowrap { white-space:nowrap; } .pre { white-space:pre-wrap; }
  .flash { padding:10px 12px; border-radius:8px; margin-bottom:12px; background:var(--card); border:1px solid var(--line); }
  .flash.err { border-color:var(--bad); color:var(--bad); }
  .flash.ok { border-color:var(--good); }
  .cards { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .balance { font-size:1.4rem; font-weight:600; margin:4px 0; }
  .row { display:flex; gap:8px; align-items:center; justify-content:space-between; flex-wrap:wrap; }
  .stack { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  ul.plain { list-style:none; padding:0; margin:8px 0; } ul.plain li { padding:4px 0; }
  form.inline { display:inline; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--accent); color:#fff; cursor:pointer; }
  button[disabled] { opacity:.6; cursor:default; }
  button.link { background:none; border:none; color:var(--accent); padding:0 4px; text-decoration:underline; }
  select, input { font:inherit; padding:8px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); flex:1; min-width:0; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:10px; overflow:hidden; }
  td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.desc { overflow-wrap:anywhere; }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  tr.pending td { opacity:.7; }
  .tag { font-size:.75rem; padding:1px 6px; border-radius:6px; border:1px solid var(--line); color:var(--muted); }
  code { font-size:.85em; }
</style>
</head>
<body><main>
<h1>bank-sync</h1>
${warning}${flash}
<h2>Banks</h2>
${sessionsSection(m)}
${accountsSection(m)}
<h2>Sync</h2>
${syncSection(m)}
<h2>ZenMoney</h2>
${zenSection(m)}
<h2>Connect a bank</h2>
${connectSection(m)}
<h2>Recent transactions</h2>
${transactionsSection(m)}
</main></body>
</html>`;
}
