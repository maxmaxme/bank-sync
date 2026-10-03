import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/** Enable Banking caps token lifetime at one hour. */
const TOKEN_TTL_SECONDS = 3600;

/**
 * RS256 JWT that authenticates the application (not the bank user) against
 * the Enable Banking API. `kid` is the application id; the key is the private
 * half of the pair registered in the Enable Banking control panel.
 */
export function signAppJwt(appId: string, privateKey: string | KeyObject, nowMs: number): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const iat = Math.floor(nowMs / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: appId };
  const payload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(input), key).toString('base64url');
  return `${input}.${signature}`;
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}
