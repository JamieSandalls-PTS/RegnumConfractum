import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with node's built-in scrypt — no native dependencies.
 * Format: scrypt$N$r$p$saltB64$hashB64, parameters stored per-hash so they
 * can be raised later without invalidating existing accounts.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function scryptAsync(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N, r, p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const actual = await scryptAsync(password, salt, N, r, p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex');
}
