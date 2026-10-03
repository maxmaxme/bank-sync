import { LAST_SYNC_KV, type Syncer } from './sync.ts';
import type { Store } from './storage/types.ts';
import type { Notifier } from './notify/types.ts';
import type { Logger } from './logger.ts';

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 30_000;
const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SchedulerDeps {
  syncer: Syncer;
  store: Store;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  intervalMs: number;
}

/**
 * Due-ness is measured from the last sync of any kind, persisted in SQLite,
 * so container restarts and manual syncs don't burn extra bank quota
 * (many ASPSPs allow ~4 unattended fetches a day).
 */
export function isSyncDue(store: Store, nowMs: number, intervalMs: number): boolean {
  const last = Number(store.getKv(LAST_SYNC_KV) ?? 0);
  return nowMs - last >= intervalMs;
}

/** One daily reminder per session in the last week, plus one notice once it lapses. */
export async function checkConsentExpiry(deps: Omit<SchedulerDeps, 'syncer' | 'intervalMs'>): Promise<void> {
  const now = deps.now();
  const today = now.toISOString().slice(0, 10);
  for (const s of deps.store.listSessions()) {
    if (s.revokedAt !== null) {
      continue;
    }
    const msLeft = Date.parse(s.validUntil) - now.getTime();
    if (msLeft <= 0) {
      const key = `consent_expired_notice:${s.sessionId}`;
      if (!deps.store.getKv(key)) {
        await deps.notifier.consentExpired({ aspsp: s.aspspName });
        deps.store.setKv(key, today);
      }
      continue;
    }
    if (msLeft <= EXPIRY_WARNING_DAYS * DAY_MS) {
      const key = `consent_expiring_notice:${s.sessionId}`;
      if (deps.store.getKv(key) !== today) {
        await deps.notifier.consentExpiring({
          aspsp: s.aspspName,
          validUntil: s.validUntil,
          daysLeft: Math.ceil(msLeft / DAY_MS),
        });
        deps.store.setKv(key, today);
      }
    }
  }
}

export function startScheduler(deps: SchedulerDeps): () => void {
  const tick = async () => {
    try {
      await checkConsentExpiry(deps);
    } catch (err) {
      deps.log.error({ err }, 'consent expiry check failed');
    }
    const nowMs = deps.now().getTime();
    if (deps.store.activeAccounts(nowMs).length === 0 || !isSyncDue(deps.store, nowMs, deps.intervalMs)) {
      return;
    }
    try {
      await deps.syncer.run('schedule');
    } catch (err) {
      deps.log.error({ err }, 'scheduled sync crashed');
    }
  };

  const first = setTimeout(tick, FIRST_TICK_MS);
  const timer = setInterval(tick, TICK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
