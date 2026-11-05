// SIDERARIUM accounts: login ID + password, server-side sessions.
//
// Why not Supabase Auth: it identifies users by e-mail (or phone). A login-ID-only account would need
// a made-up address, and without a custom SMTP server Supabase only delivers confirmation / recovery
// mail to the project's own team members, so ordinary players could never confirm or recover. The game
// server therefore owns authentication itself, with standard primitives:
//   - passwords: scrypt (node:crypto), OWASP parameters N=2^15 r=8 p=3, 16-byte random salt, stored as
//     `scrypt$N$r$p$salt$hash` so parameters can be raised later; compared in constant time
//   - sessions: 256-bit random id handed to the browser only as an HttpOnly cookie; the database keeps
//     its SHA-256, never the id itself; sliding expiry, revoked on logout / password change / recovery
//   - recovery: a 100-bit one-time recovery code shown once at sign-up (stored as SHA-256), replaced on use
//   - throttling of failed logins / recoveries per login ID and per client address
// Accounts live in their own tables; a world reset or a world backup never touches them.

import crypto from 'node:crypto';

export interface Account {
  id: string;            // permanent UUID — an identifier, never a credential
  loginId: string;       // normalised (lower-case) login ID, unique
  pwHash: string;
  recoveryHash: string | null;
  email: string | null;  // reserved for e-mail recovery once an SMTP sender exists; not collected now
  createdAt: number;
  lastLogin: number | null;
  pwChanged: number;
}
export interface Session { idHash: string; accountId: string; createdAt: number; expiresAt: number; lastSeen: number }

export interface AccountStore {
  name: string;
  /** must fail with { code: 'DUP' } when the login ID exists (enforced by a unique constraint) */
  insertAccount(a: Account): Promise<void>;
  byLogin(loginId: string): Promise<Account | null>;
  byId(id: string): Promise<Account | null>;
  updateAccount(id: string, patch: Partial<Pick<Account, 'pwHash' | 'recoveryHash' | 'lastLogin' | 'pwChanged'>>): Promise<void>;
  insertSession(s: Session): Promise<void>;
  session(idHash: string): Promise<Session | null>;
  touchSession(idHash: string, expiresAt: number, lastSeen: number): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  /** removes every session of the account except `keep`; returns the removed hashes */
  deleteSessionsOf(accountId: string, keep?: string): Promise<string[]>;
}

export class AuthError extends Error { constructor(public code: string, msg: string, public status = 400) { super(msg); } }

const SCRYPT = { N: 1 << 15, r: 8, p: 3 };
const scryptAsync = (pw: string, salt: Buffer, N: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) => crypto.scrypt(pw.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (e, k) => e ? rej(e) : res(k)));

// at most two hashes at once: each scrypt call holds 128·N·r bytes (32 MB)
let running = 0; const waiting: (() => void)[] = [];
async function limited<T>(f: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>(r => waiting.push(r));
  running++;
  try { return await f(); } finally { running--; waiting.shift()?.(); }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const k = await limited(() => scryptAsync(pw, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${k.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await limited(() => scryptAsync(pw, Buffer.from(salt, 'base64'), Number(N), Number(r), Number(p)));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const eqHex = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
export const sessionHash = sha256;

const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
function recoveryCode(): string {
  const out: string[] = [];
  for (let g = 0; g < 4; g++) { let s = ''; for (let i = 0; i < 5; i++) s += B32[crypto.randomInt(B32.length)]; out.push(s); }
  return out.join('-'); // 20 symbols of 31 → ~99 bits
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{5})(?=.)/g, '$1-');

export const LOGIN_RE = /^[a-z0-9_]{3,20}$/;
export function normLogin(s: unknown): string { return typeof s === 'string' ? s.normalize('NFKC').trim().toLowerCase() : ''; }
export function checkPassword(pw: unknown, loginId: string): string | null {
  if (typeof pw !== 'string') return '비밀번호를 입력하세요';
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 합니다';
  if (pw.length > 128) return '비밀번호는 128자 이하여야 합니다';
  if (pw.toLowerCase().includes(loginId)) return '비밀번호에 로그인 ID를 넣을 수 없습니다';
  if (/^(.)\1+$/.test(pw) || ['12345678', 'password', 'qwertyui', '11111111', 'abcd1234', 'password1', '123456789'].includes(pw.toLowerCase())) return '너무 쉬운 비밀번호입니다';
  return null;
}

/** sliding-window counter of failures; memory only (a restart resets it, which is acceptable) */
class Throttle {
  private m = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  blocked(k: string, now: number): number { const a = (this.m.get(k) ?? []).filter(t => now - t < this.windowMs); this.m.set(k, a); return a.length >= this.max ? Math.ceil((a[0] + this.windowMs - now) / 60000) : 0; }
  hit(k: string, now: number) { const a = (this.m.get(k) ?? []).filter(t => now - t < this.windowMs); a.push(now); this.m.set(k, a); if (this.m.size > 50000) this.m.clear(); }
  clear(k: string) { this.m.delete(k); }
}

export interface AuthOptions { ttlMs?: number; now?: () => number }
export interface PublicAccount { id: string; loginId: string; createdAt: number; lastLogin: number | null }
const pub = (a: Account): PublicAccount => ({ id: a.id, loginId: a.loginId, createdAt: a.createdAt, lastLogin: a.lastLogin });

export class AuthService {
  readonly ttl: number;
  private now: () => number;
  private failLogin = new Throttle(8, 10 * 60_000);
  private failIp = new Throttle(30, 10 * 60_000);
  private signups = new Throttle(10, 60 * 60_000);
  private dummy: Promise<string>;
  constructor(readonly store: AccountStore, o: AuthOptions = {}) {
    this.ttl = o.ttlMs ?? 14 * 24 * 3600_000;
    this.now = o.now ?? Date.now;
    this.dummy = hashPassword(crypto.randomBytes(12).toString('hex'));
  }

  private async newSession(accountId: string): Promise<string> {
    const id = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    await this.store.insertSession({ idHash: sha256(id), accountId, createdAt: t, expiresAt: t + this.ttl, lastSeen: t });
    return id;
  }

  async signup(loginRaw: unknown, password: unknown, ip: string): Promise<{ sid: string; account: PublicAccount; recoveryCode: string }> {
    const loginId = normLogin(loginRaw);
    if (!LOGIN_RE.test(loginId)) throw new AuthError('LOGIN_FORMAT', '로그인 ID는 영문 소문자·숫자·밑줄(_) 3~20자입니다');
    const bad = checkPassword(password, loginId); if (bad) throw new AuthError('PASSWORD_WEAK', bad);
    const wait = this.signups.blocked(ip, this.now()); if (wait) throw new AuthError('RATE', `가입 요청이 너무 많습니다. ${wait}분 후 다시 시도하세요`, 429);
    if (await this.store.byLogin(loginId)) throw new AuthError('DUP', '이미 사용 중인 로그인 ID입니다', 409);
    const code = recoveryCode();
    const t = this.now();
    const a: Account = { id: crypto.randomUUID(), loginId, pwHash: await hashPassword(password as string), recoveryHash: sha256(normCode(code)), email: null, createdAt: t, lastLogin: t, pwChanged: t };
    try { await this.store.insertAccount(a); } catch (e) { if ((e as { code?: string }).code === 'DUP') throw new AuthError('DUP', '이미 사용 중인 로그인 ID입니다', 409); throw e; }
    this.signups.hit(ip, t);
    return { sid: await this.newSession(a.id), account: pub(a), recoveryCode: code };
  }

  async login(loginRaw: unknown, password: unknown, ip: string): Promise<{ sid: string; account: PublicAccount }> {
    const loginId = normLogin(loginRaw);
    const t = this.now();
    const wait = Math.max(this.failLogin.blocked(loginId, t), this.failIp.blocked(ip, t));
    if (wait) throw new AuthError('RATE', `로그인 실패가 너무 많습니다. ${wait}분 후 다시 시도하세요`, 429);
    const a = LOGIN_RE.test(loginId) ? await this.store.byLogin(loginId) : null;
    // unknown IDs still cost one hash so response time does not reveal which IDs exist
    const ok = typeof password === 'string' && password.length <= 128 && (a ? await verifyPassword(password, a.pwHash) : (await verifyPassword(password, await this.dummy), false));
    if (!a || !ok) { this.failLogin.hit(loginId, t); this.failIp.hit(ip, t); throw new AuthError('BAD_LOGIN', '로그인 ID 또는 비밀번호가 올바르지 않습니다', 401); }
    this.failLogin.clear(loginId);
    await this.store.updateAccount(a.id, { lastLogin: t });
    return { sid: await this.newSession(a.id), account: pub({ ...a, lastLogin: t }) };
  }

  /** resolves a session cookie value; renews the sliding expiry (at most once a minute) */
  async resolve(sid: string | undefined | null): Promise<{ account: PublicAccount; idHash: string } | null> {
    if (!sid || sid.length > 100) return null;
    const h = sha256(sid);
    const s = await this.store.session(h);
    const t = this.now();
    if (!s) return null;
    if (s.expiresAt <= t) { await this.store.deleteSession(h); return null; }
    const a = await this.store.byId(s.accountId);
    if (!a) return null;
    if (t - s.lastSeen > 60_000) await this.store.touchSession(h, t + this.ttl, t);
    return { account: pub(a), idHash: h };
  }
  /** still-valid check for long-lived sockets; an open game connection keeps its session alive (sliding) */
  async alive(idHash: string): Promise<boolean> {
    const s = await this.store.session(idHash); const t = this.now();
    if (!s || s.expiresAt <= t) return false;
    if (t - s.lastSeen > 60_000) await this.store.touchSession(idHash, t + this.ttl, t);
    return true;
  }

  async logout(sid: string | undefined | null): Promise<string | null> {
    if (!sid) return null; const h = sha256(sid); await this.store.deleteSession(h); return h;
  }

  /** changes the password; every other session of the account is signed out */
  async changePassword(sid: string, current: unknown, next: unknown): Promise<string[]> {
    const r = await this.resolve(sid); if (!r) throw new AuthError('NO_SESSION', '세션이 만료되었습니다. 다시 로그인하세요', 401);
    const a = (await this.store.byId(r.account.id))!;
    if (typeof current !== 'string' || !(await verifyPassword(current, a.pwHash))) throw new AuthError('BAD_PASSWORD', '현재 비밀번호가 올바르지 않습니다', 403);
    const bad = checkPassword(next, a.loginId); if (bad) throw new AuthError('PASSWORD_WEAK', bad);
    if (next === current) throw new AuthError('PASSWORD_SAME', '현재 비밀번호와 다른 비밀번호를 입력하세요');
    await this.store.updateAccount(a.id, { pwHash: await hashPassword(next as string), pwChanged: this.now() });
    return this.store.deleteSessionsOf(a.id, r.idHash);
  }

  /** recovery with the one-time code: new password, new code, all sessions revoked, then signed in */
  async recover(loginRaw: unknown, code: unknown, next: unknown, ip: string): Promise<{ sid: string; account: PublicAccount; recoveryCode: string; revoked: string[] }> {
    const loginId = normLogin(loginRaw);
    const t = this.now();
    const wait = Math.max(this.failLogin.blocked('r:' + loginId, t), this.failIp.blocked(ip, t));
    if (wait) throw new AuthError('RATE', `시도가 너무 많습니다. ${wait}분 후 다시 시도하세요`, 429);
    const a = LOGIN_RE.test(loginId) ? await this.store.byLogin(loginId) : null;
    const ok = !!a?.recoveryHash && typeof code === 'string' && eqHex(sha256(normCode(code)), a.recoveryHash);
    if (!a || !ok) { this.failLogin.hit('r:' + loginId, t); this.failIp.hit(ip, t); throw new AuthError('BAD_RECOVERY', '로그인 ID 또는 복구 코드가 올바르지 않습니다', 401); }
    const bad = checkPassword(next, a.loginId); if (bad) throw new AuthError('PASSWORD_WEAK', bad);
    const fresh = recoveryCode();
    await this.store.updateAccount(a.id, { pwHash: await hashPassword(next as string), recoveryHash: sha256(normCode(fresh)), pwChanged: t, lastLogin: t });
    const revoked = await this.store.deleteSessionsOf(a.id);
    this.failLogin.clear('r:' + loginId);
    return { sid: await this.newSession(a.id), account: pub({ ...a, lastLogin: t }), recoveryCode: fresh, revoked };
  }
}

// ───────────────────────────────────────────────────────────── stores

/** in-memory store, optionally mirrored to a JSON file (local development / tests without Postgres) */
export function memoryStore(file?: { read(): string | null; write(s: string): void }): AccountStore {
  const db: { accounts: Record<string, Account>; sessions: Record<string, Session> } = { accounts: {}, sessions: {} };
  if (file) { try { const raw = file.read(); if (raw) Object.assign(db, JSON.parse(raw)); } catch { /* fresh */ } }
  const flush = () => file?.write(JSON.stringify(db));
  return {
    name: file ? 'file' : 'memory',
    async insertAccount(a) { if (Object.values(db.accounts).some(x => x.loginId === a.loginId)) throw Object.assign(new Error('dup'), { code: 'DUP' }); db.accounts[a.id] = { ...a }; flush(); },
    async byLogin(l) { const a = Object.values(db.accounts).find(x => x.loginId === l); return a ? { ...a } : null; },
    async byId(id) { return db.accounts[id] ? { ...db.accounts[id] } : null; },
    async updateAccount(id, p) { if (db.accounts[id]) Object.assign(db.accounts[id], p); flush(); },
    async insertSession(s) { db.sessions[s.idHash] = { ...s }; flush(); },
    async session(h) { return db.sessions[h] ? { ...db.sessions[h] } : null; },
    async touchSession(h, e, l) { const s = db.sessions[h]; if (s) { s.expiresAt = e; s.lastSeen = l; flush(); } },
    async deleteSession(h) { delete db.sessions[h]; flush(); },
    async deleteSessionsOf(id, keep) { const out = Object.values(db.sessions).filter(s => s.accountId === id && s.idHash !== keep).map(s => s.idHash); for (const h of out) delete db.sessions[h]; flush(); return out; },
  };
}

type Pool = { query(q: string, v?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> };

/** Postgres store. The tables have row-level security enabled with no policies, so Supabase's public
 *  API roles (anon / authenticated) cannot read them; the game server's own role owns them. */
export async function pgAccountStore(pool: Pool): Promise<AccountStore> {
  await pool.query(`CREATE TABLE IF NOT EXISTS siderarium_accounts (
    id UUID PRIMARY KEY, login_id TEXT NOT NULL UNIQUE CHECK (login_id ~ '^[a-z0-9_]{3,20}$'), pw_hash TEXT NOT NULL,
    recovery_hash TEXT, email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_login TIMESTAMPTZ,
    pw_changed TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS siderarium_sessions (
    id_hash TEXT PRIMARY KEY, account_id UUID NOT NULL REFERENCES siderarium_accounts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query('CREATE INDEX IF NOT EXISTS siderarium_sessions_account ON siderarium_sessions (account_id)');
  for (const t of ['siderarium_accounts', 'siderarium_sessions']) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
  const ms = (d: Date | null) => d ? new Date(d).getTime() : null;
  const acc = (r: any): Account | null => r ? { id: r.id, loginId: r.login_id, pwHash: r.pw_hash, recoveryHash: r.recovery_hash, email: r.email, createdAt: ms(r.created_at)!, lastLogin: ms(r.last_login), pwChanged: ms(r.pw_changed)! } : null;
  const ts = (n: number) => new Date(n).toISOString();
  return {
    name: 'postgres',
    async insertAccount(a) {
      try {
        await pool.query('INSERT INTO siderarium_accounts (id, login_id, pw_hash, recovery_hash, email, created_at, last_login, pw_changed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [a.id, a.loginId, a.pwHash, a.recoveryHash, a.email, ts(a.createdAt), a.lastLogin ? ts(a.lastLogin) : null, ts(a.pwChanged)]);
      } catch (e) { if ((e as { code?: string }).code === '23505') throw Object.assign(new Error('dup'), { code: 'DUP' }); throw e; }
    },
    async byLogin(l) { return acc((await pool.query('SELECT * FROM siderarium_accounts WHERE login_id = $1', [l])).rows[0]); },
    async byId(id) { return acc((await pool.query('SELECT * FROM siderarium_accounts WHERE id = $1', [id])).rows[0]); },
    async updateAccount(id, p) {
      const cols: string[] = [], vals: unknown[] = [id];
      const map: Record<string, string> = { pwHash: 'pw_hash', recoveryHash: 'recovery_hash', lastLogin: 'last_login', pwChanged: 'pw_changed' };
      for (const [k, v] of Object.entries(p)) { vals.push(k === 'lastLogin' || k === 'pwChanged' ? (v ? ts(v as number) : null) : v); cols.push(`${map[k]} = $${vals.length}`); }
      if (cols.length) await pool.query(`UPDATE siderarium_accounts SET ${cols.join(', ')} WHERE id = $1`, vals);
    },
    async insertSession(s) { await pool.query('INSERT INTO siderarium_sessions (id_hash, account_id, created_at, expires_at, last_seen) VALUES ($1,$2,$3,$4,$5)', [s.idHash, s.accountId, ts(s.createdAt), ts(s.expiresAt), ts(s.lastSeen)]); },
    async session(h) { const r = (await pool.query('SELECT * FROM siderarium_sessions WHERE id_hash = $1', [h])).rows[0]; return r ? { idHash: r.id_hash, accountId: r.account_id, createdAt: ms(r.created_at)!, expiresAt: ms(r.expires_at)!, lastSeen: ms(r.last_seen)! } : null; },
    async touchSession(h, e, l) { await pool.query('UPDATE siderarium_sessions SET expires_at = $2, last_seen = $3 WHERE id_hash = $1', [h, ts(e), ts(l)]); },
    async deleteSession(h) { await pool.query('DELETE FROM siderarium_sessions WHERE id_hash = $1', [h]); },
    async deleteSessionsOf(id, keep) { const r = await pool.query('DELETE FROM siderarium_sessions WHERE account_id = $1 AND id_hash <> $2 RETURNING id_hash', [id, keep ?? '']); return r.rows.map(x => x.id_hash); },
  };
}
