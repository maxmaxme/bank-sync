import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { defaultEnvCandidates, loadEnvFiles } from './env.ts';
import { EnableBankingClient } from './enablebanking/client.ts';
import { NullNotifier, TelegramNotifier } from './notify/telegram.ts';
import { startScheduler } from './scheduler.ts';
import { openStore } from './storage/sqlite.ts';
import { Syncer } from './sync.ts';
import { createApp } from './web/server.ts';
import { ZenMoneyClient } from './zenmoney/client.ts';
import { ZenExporter } from './zenmoney/export.ts';
import { createLogger } from './logger.ts';

const log = createLogger('index');

// Auto-load .env when running outside the container. In production the file
// is injected by docker-compose's `env_file`, so this is a no-op.
loadEnvFiles(defaultEnvCandidates(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });

  const now = () => new Date();
  const store = openStore(join(config.dataDir, 'bank-sync.sqlite'));
  const client = new EnableBankingClient({ appId: config.appId, privateKeyPem: config.privateKeyPem });
  const notifier = config.telegram ? new TelegramNotifier(config.telegram) : new NullNotifier();
  const zen = config.zenmoney
    ? new ZenExporter({
        api: new ZenMoneyClient(config.zenmoney),
        store,
        notifier,
        log: createLogger('zenmoney'),
        now,
      })
    : null;
  const syncer = new Syncer({
    api: client,
    store,
    notifier,
    log: createLogger('sync'),
    now,
    afterRun: zen ? () => zen.run() : undefined,
  });

  // Self-check: catches a wrong key / app id / redirect URL before the first
  // bank login instead of halfway through it.
  let setupWarning: string | null = null;
  try {
    const app = await client.getApplication();
    log.info({ name: app.name, environment: app.environment, active: app.active }, 'enable banking app');
    if (!app.redirect_urls.includes(config.redirectUrl)) {
      setupWarning =
        `EB_REDIRECT_URL (${config.redirectUrl}) is not among the Enable Banking app's redirect URLs: ` +
        `${app.redirect_urls.join(', ') || '—'}`;
    } else if (!app.active) {
      setupWarning = 'The Enable Banking app is not active — link your own accounts in the Control Panel.';
    }
  } catch (err) {
    setupWarning = `Could not check the Enable Banking app: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (setupWarning) {
    log.warn(setupWarning);
  }

  const server = createApp({
    client,
    store,
    syncer,
    redirectUrl: config.redirectUrl,
    country: config.country,
    preferredAspsp: config.preferredAspsp,
    setupWarning: () => setupWarning,
    zen,
    log: createLogger('web'),
    now,
  });
  server.listen(config.port, () => log.info({ port: config.port }, 'listening'));

  const stopScheduler = startScheduler({
    syncer,
    store,
    notifier,
    log: createLogger('scheduler'),
    now,
    intervalMs: config.syncIntervalMs,
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    stopScheduler();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'fatal');
  process.exit(1);
});
