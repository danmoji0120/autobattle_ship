import { describe, expect, it } from 'vitest';
import { AuthError, AuthService, hashPassword, memoryStore } from '../src/server/accounts';
import { DevCombatAuth } from '../src/server/devCombatAuth';

async function fails(p: Promise<unknown>, code: string) {
  try { await p; throw new Error('expected rejection'); }
  catch (e) { expect(e).toBeInstanceOf(AuthError); expect((e as AuthError).code).toBe(code); }
}

describe('DEV-1 server-side developer grants', () => {
  it('requires a live allowlisted account, configured scrypt hash, correct password, and rate limits concurrent failures', async () => {
    let now = 1_000_000, passwordHash: string | undefined;
    const auth = new AuthService(memoryStore(), { now: () => now });
    const admin = await auth.signup('dev_admin', 'admin-account-71', 'a'), player = await auth.signup('ordinary', 'player-account-82', 'b');
    const admins = [admin.account.id], lab = new DevCombatAuth(auth, { admins: () => admins, passwordHash: () => passwordHash, now: () => now, ttlMs: 2000 });
    await fails(lab.login(null, 'lab-secret-1', 'a'), 'NO_SESSION');
    await fails(lab.login(player.sid, 'lab-secret-1', 'b'), 'FORBIDDEN');
    await fails(lab.login(admin.sid, 'lab-secret-1', 'a'), 'DISABLED');
    passwordHash = 'not-a-valid-hash'; await fails(lab.login(admin.sid, 'lab-secret-1', 'a'), 'DISABLED');
    passwordHash = await hashPassword('lab-secret-1');
    await Promise.all(Array.from({ length: 5 }, (_, i) => fails(lab.login(admin.sid, `wrong-${i}`, 'a'), 'BAD_PASSWORD')));
    await fails(lab.login(admin.sid, 'lab-secret-1', 'a'), 'RATE');
    now += 15 * 60_000 + 1;
    const grant = await lab.login(admin.sid, 'lab-secret-1', 'a');
    expect(grant.token).toMatch(/^[\w-]{43}$/); expect(await lab.valid(admin.sid, grant.token)).toBe(true);
    expect(await lab.valid(player.sid, grant.token)).toBe(false);
    // Failed replay is revoked, even when subsequently presented by the original session.
    expect(await lab.valid(admin.sid, grant.token)).toBe(false);
    const second = await lab.login(admin.sid, 'lab-secret-1', 'a');
    now += 2001; expect(await lab.valid(admin.sid, second.token)).toBe(false);
  }, 30000);

  it('revokes on logout, account-password change, lab-password change and removal from the admin allowlist', async () => {
    let now = 2_000_000, hash = await hashPassword('lab-secret-2');
    const auth = new AuthService(memoryStore(), { now: () => now });
    const admin = await auth.signup('dev_owner', 'account-secret-1', 'a');
    const admins = [admin.account.id], lab = new DevCombatAuth(auth, { admins: () => admins, passwordHash: () => hash, now: () => now });
    const old = await lab.login(admin.sid, 'lab-secret-2', 'a'), one = await lab.login(admin.sid, 'lab-secret-2', 'a');
    expect(await lab.valid(admin.sid, old.token)).toBe(false); expect(await lab.valid(admin.sid, one.token)).toBe(true);
    lab.logout(one.token); expect(await lab.valid(admin.sid, one.token)).toBe(false);
    const two = await lab.login(admin.sid, 'lab-secret-2', 'a'); hash = await hashPassword('new-lab-secret'); expect(await lab.valid(admin.sid, two.token)).toBe(false);
    const three = await lab.login(admin.sid, 'new-lab-secret', 'a'); admins.length = 0; expect(await lab.valid(admin.sid, three.token)).toBe(false);
    admins.push(admin.account.id); const four = await lab.login(admin.sid, 'new-lab-secret', 'a');
    now++; await auth.changePassword(admin.sid, 'account-secret-1', 'new-account-secret-3');
    expect(await lab.valid(admin.sid, four.token)).toBe(false);
    const five = await lab.login(admin.sid, 'new-lab-secret', 'a'); await auth.logout(admin.sid);
    expect(await lab.valid(admin.sid, five.token)).toBe(false);
  }, 30000);
});
