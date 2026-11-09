// Ephemeral developer-lab grants. A lab cookie is never a game/PMC credential and cannot outlive
// the account session, the admin allowlist, the account password, or the configured lab hash.
import crypto from 'node:crypto';
import { AuthError, type AuthService, sessionHash, verifyPassword } from './accounts';

interface Grant { account: string; parent: string; changed: number; hash: string; expires: number }
interface Options { admins: () => readonly string[]; passwordHash: () => string | undefined; now?: () => number; ttlMs?: number }

/** Accept the account system's scrypt format with bounded parameters before invoking crypto. */
function validHash(hash: string): boolean {
  const fields = hash.split('$');
  if (fields.length !== 6 || fields[0] !== 'scrypt') return false;
  const [n, r, p] = fields.slice(1, 4).map(Number);
  if (!Number.isSafeInteger(n) || n < 16384 || n > 65536 || (n & (n - 1)) !== 0 || !Number.isSafeInteger(r) || r < 1 || r > 16 || !Number.isSafeInteger(p) || p < 1 || p > 8 || n * r > 524288) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[4]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(fields[5])) return false;
  const salt = Buffer.from(fields[4], 'base64'), key = Buffer.from(fields[5], 'base64');
  return salt.length >= 16 && salt.length <= 64 && key.length === 32;
}

export class DevCombatAuth {
  private grants = new Map<string, Grant>();
  private attempts = new Map<string, number[]>();
  private now: () => number;
  readonly ttl: number;
  constructor(private auth: AuthService, private opts: Options) {
    this.now = opts.now ?? Date.now;
    this.ttl = Math.min(30 * 60_000, Math.max(1_000, opts.ttlMs ?? 15 * 60_000));
  }

  private admit(keys: string[], t: number) {
    for (const [key, times] of this.attempts) {
      const live = times.filter(x => t - x < 15 * 60_000);
      if (live.length) this.attempts.set(key, live); else this.attempts.delete(key);
    }
    if (keys.some(key => (this.attempts.get(key)?.length ?? 0) >= 5)) throw new AuthError('RATE', '인증 실패가 너무 많습니다. 잠시 후 다시 시도하세요', 429);
    // Count before awaiting scrypt: concurrent requests cannot bypass the limit.
    for (const key of keys) this.attempts.set(key, [...(this.attempts.get(key) ?? []), t]);
  }

  private async admin(sid: string | null | undefined) {
    const parent = await this.auth.resolve(sid);
    if (!parent) throw new AuthError('NO_SESSION', '계정 로그인이 필요합니다', 401);
    if (!this.opts.admins().includes(parent.account.id)) throw new AuthError('FORBIDDEN', '관리자 계정이 필요합니다', 403);
    const account = await this.auth.store.byId(parent.account.id);
    if (!account) throw new AuthError('NO_SESSION', '계정 로그인이 필요합니다', 401);
    return { parent, account };
  }

  async login(sid: string | null, password: unknown, ip: string): Promise<{ token: string; expiresAt: number }> {
    const { parent, account } = await this.admin(sid);
    const hash = this.opts.passwordHash() ?? '';
    if (!validHash(hash)) throw new AuthError('DISABLED', '전투 실험실 인증이 설정되지 않았습니다', 503);
    const keys = [`account:${account.id}`, `ip:${ip}`], t = this.now();
    this.admit(keys, t);
    let ok = false;
    try { ok = typeof password === 'string' && password.length > 0 && password.length <= 128 && await verifyPassword(password, hash); } catch { ok = false; }
    if (!ok) throw new AuthError('BAD_PASSWORD', '전투 실험실 비밀번호가 올바르지 않습니다', 401);
    // Account or lab credentials may have changed during the asynchronous hash.
    const again = await this.admin(sid);
    if (again.parent.idHash !== parent.idHash || again.account.pwChanged !== account.pwChanged || this.opts.passwordHash() !== hash) throw new AuthError('NO_SESSION', '인증 상태가 변경되었습니다. 다시 시도하세요', 401);
    for (const key of keys) this.attempts.delete(key);
    // Rotating a grant invalidates older lab tokens for this account session as well.
    for (const [key, grant] of this.grants) if (grant.expires <= this.now() || grant.parent === parent.idHash) this.grants.delete(key);
    const token = crypto.randomBytes(32).toString('base64url'), expiresAt = this.now() + this.ttl;
    this.grants.set(sessionHash(token), { account: account.id, parent: parent.idHash, changed: account.pwChanged, hash: sessionHash(hash), expires: expiresAt });
    return { token, expiresAt };
  }

  async valid(sid: string | null, token: string | null): Promise<boolean> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const key = sessionHash(token), grant = this.grants.get(key), hash = this.opts.passwordHash() ?? '';
    if (!grant || grant.expires <= this.now() || !validHash(hash) || grant.hash !== sessionHash(hash)) { this.grants.delete(key); return false; }
    try {
      const { parent, account } = await this.admin(sid);
      if (parent.idHash !== grant.parent || account.id !== grant.account || account.pwChanged !== grant.changed) { this.grants.delete(key); return false; }
      return true;
    } catch { this.grants.delete(key); return false; }
  }

  logout(token: string | null) { if (token) this.grants.delete(sessionHash(token)); }
  revokeAccount(id: string) { for (const [key, grant] of this.grants) if (grant.account === id) this.grants.delete(key); }
}
