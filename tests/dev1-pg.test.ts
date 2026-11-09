import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { AuthService, hashPassword, pgAccountStore } from '../src/server/accounts';
import { DevCombatAuth } from '../src/server/devCombatAuth';

// The helper starts a disposable loopback-only container. Never point this at a real database.
const url = process.env.DEV1_PG_TEST_URL;
const disposable = process.env.DEV1_DISPOSABLE_DB === '1' && !!url && (() => {
  try { const u = new URL(url); return u.hostname === '127.0.0.1' && u.username === 'dev1_test' && u.pathname === '/siderarium_dev1_test'; } catch { return false; }
})();

describe.skipIf(!disposable)('DEV-1 disposable PostgreSQL account authentication', () => {
  it('uses existing PostgreSQL account sessions without persisting lab grants; restart and password change revoke access', async () => {
    const pool = new pg.Pool({ connectionString: url });
    try {
      const store = await pgAccountStore(pool), auth = new AuthService(store);
      const admin = await auth.signup('lab_pg_admin', 'pg-account-pass-71', 'local');
      const player = await auth.signup('lab_pg_player', 'pg-player-pass-82', 'local');
      const hash = await hashPassword('pg-lab-pass-93'), opts = { admins: () => [admin.account.id], passwordHash: () => hash };
      const lab = new DevCombatAuth(auth, opts), grant = await lab.login(admin.sid, 'pg-lab-pass-93', 'local');
      expect(await lab.valid(admin.sid, grant.token)).toBe(true);
      await expect(lab.login(player.sid, 'pg-lab-pass-93', 'local')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const sessions = await pool.query('SELECT id_hash FROM siderarium_sessions');
      expect(sessions.rows).toHaveLength(2); expect(JSON.stringify(sessions.rows)).not.toContain(grant.token);
      const restarted = new DevCombatAuth(new AuthService(await pgAccountStore(pool)), opts);
      expect(await restarted.valid(admin.sid, grant.token)).toBe(false);
      const second = await restarted.login(admin.sid, 'pg-lab-pass-93', 'local');
      await auth.changePassword(admin.sid, 'pg-account-pass-71', 'pg-account-new-94');
      expect(await restarted.valid(admin.sid, second.token)).toBe(false);
    } finally { await pool.end(); }
  }, 30000);
});
