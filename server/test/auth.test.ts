import { describe, expect, it } from 'vitest';
import { hashPassword, newSessionToken, verifyPassword } from '@rc/server/auth';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery!', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts: same password hashes differently', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad$8$1$AA$BB')).toBe(false);
  });

  it('session tokens are long and unique', () => {
    const a = newSessionToken();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(newSessionToken());
  });
});
