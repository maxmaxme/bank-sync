import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { optionalEnv, requireEnv, type Env } from './env.ts';
import { ZenMoneyServerSchema, type ZenMoneyServer } from './zenmoney/types.ts';

export interface Config {
  dataDir: string;
  port: number;
  /** Enable Banking application id — also the JWT `kid`. */
  appId: string;
  privateKeyPem: string;
  /** Redirect URL exactly as registered for the Enable Banking application. */
  redirectUrl: string;
  /** ISO 3166 country whose banks the "connect" form lists. */
  country: string;
  /** Case-insensitive substring preselected in the bank picker. */
  preferredAspsp: string;
  syncIntervalMs: number;
  telegram: { token: string; chatId: string } | null;
  zenmoney: { token: string; server: ZenMoneyServer } | null;
}

export function loadConfig(env: Env, readFile: (path: string) => string = readUtf8): Config {
  const dataDir = requireEnv(env, 'BANK_SYNC_DATA_DIR', '/app/data');
  const keyPath = requireEnv(env, 'EB_PRIVATE_KEY_PATH', join(dataDir, 'enablebanking.pem'));

  const hours = Number(requireEnv(env, 'SYNC_INTERVAL_HOURS', '8'));
  if (!Number.isFinite(hours) || hours < 1) {
    throw new Error(`SYNC_INTERVAL_HOURS must be a number >= 1, got ${env.SYNC_INTERVAL_HOURS}`);
  }

  const zmToken = optionalEnv(env, 'ZENMONEY_TOKEN');
  const zmServer = v.safeParse(ZenMoneyServerSchema, requireEnv(env, 'ZENMONEY_SERVER', 'ru'));
  if (!zmServer.success) {
    throw new Error(
      `ZENMONEY_SERVER must be one of ${ZenMoneyServerSchema.options.join(', ')}, got ${env.ZENMONEY_SERVER}`,
    );
  }

  const token = optionalEnv(env, 'TELEGRAM_BOT_TOKEN');
  const chatId = optionalEnv(env, 'TELEGRAM_CHAT_ID');

  return {
    dataDir,
    port: Number(requireEnv(env, 'PORT', '8080')),
    appId: requireEnv(env, 'EB_APP_ID'),
    privateKeyPem: readFile(keyPath),
    redirectUrl: requireEnv(env, 'EB_REDIRECT_URL'),
    country: requireEnv(env, 'EB_COUNTRY', 'ES'),
    preferredAspsp: requireEnv(env, 'EB_ASPSP', 'imagin'),
    syncIntervalMs: hours * 3600_000,
    telegram: token && chatId ? { token, chatId } : null,
    zenmoney: zmToken ? { token: zmToken, server: zmServer.output } : null,
  };
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}
