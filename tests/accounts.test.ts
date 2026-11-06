import { growthOn } from '../src/world/hullops';
import { START_CREDITS_GROWTH } from '../src/world/sim';
import { describe, it, expect } from 'vitest';
import { AuthService, AuthError, memoryStore, hashPassword, verifyPassword } from '../src/server/accounts';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg, SaveFile } from '../src/server/protocol';
import { WorldSim } from '../src/world/sim';

const fails = async (p: Promise<unknown>, code: string) => { try { await p; } catch (e) { expect(e).toBeInstanceOf(AuthError); expect((e as AuthError).code).toBe(code); return; } throw new Error('expected ' + code); };

describe('accounts: passwords, sessions, recovery', () => {
  it('passwords are stored only as salted scrypt hashes and verified in constant time', async () => {
    const h1 = await hashPassword('correct horse'), h2 = await hashPassword('correct horse');
    expect(h1).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(h1).not.toBe(h2);                      // salted
    expect(h1).not.toContain('correct');
    expect(await verifyPassword('correct horse', h1)).toBe(true);
    expect(await verifyPassword('correct hors', h1)).toBe(false);
  });

  it('sign-up validates the login ID and password, rejects duplicates case-insensitively', async () => {
    const store = memoryStore();
    const a = new AuthService(store);
    await fails(a.signup('ab', 'longenough1', 'ip'), 'LOGIN_FORMAT');
    await fails(a.signup('한글아이디', 'longenough1', 'ip'), 'LOGIN_FORMAT');
    await fails(a.signup('pilot_1', 'short', 'ip'), 'PASSWORD_WEAK');
    await fails(a.signup('pilot_1', 'xxpilot_1xx', 'ip'), 'PASSWORD_WEAK');
    const r = await a.signup('Pilot_1', 'nebula-runner-7', 'ip');
    expect(r.account.loginId).toBe('pilot_1');
    expect(r.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.recoveryCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    await fails(a.signup('PILOT_1', 'another-pass-9', 'ip'), 'DUP');
    const stored = (await store.byLogin('pilot_1'))!;
    expect(JSON.stringify(stored)).not.toContain('nebula-runner-7');
    expect(JSON.stringify(stored)).not.toContain(r.recoveryCode);
    // the session id itself is never stored, only its hash
    expect(await store.session(r.sid)).toBeNull();
    expect((await a.resolve(r.sid))!.account.id).toBe(r.account.id);
  });

  it('login: wrong password and unknown IDs give the same error; throttled after repeated failures', async () => {
    const a = new AuthService(memoryStore());
    await a.signup('captain', 'stardust-42!', 'ip0');
    await fails(a.login('captain', 'wrong-pass', 'ip1'), 'BAD_LOGIN');
    await fails(a.login('nobody', 'wrong-pass', 'ip1'), 'BAD_LOGIN');
    const ok = await a.login('CAPTAIN', 'stardust-42!', 'ip1');
    expect((await a.resolve(ok.sid))!.account.loginId).toBe('captain');
    for (let i = 0; i < 8; i++) await fails(a.login('captain', 'nope-' + i, 'ip' + i), 'BAD_LOGIN');
    await fails(a.login('captain', 'stardust-42!', 'ip9'), 'RATE');
  }, 30000);

  it('sessions expire, slide while used, and end on logout', async () => {
    let now = 1_000_000;
    const a = new AuthService(memoryStore(), { ttlMs: 3600_000, now: () => now });
    const s = await a.signup('watcher', 'long-watch-77', 'ip');
    now += 50 * 60_000;
    expect(await a.resolve(s.sid)).not.toBeNull();       // renews to now + 1h
    now += 50 * 60_000;
    expect(await a.resolve(s.sid)).not.toBeNull();       // still valid thanks to the renewal
    now += 61 * 60_000;
    expect(await a.resolve(s.sid)).toBeNull();           // idle > ttl: expired
    const l = await a.login('watcher', 'long-watch-77', 'ip');
    await a.logout(l.sid);
    expect(await a.resolve(l.sid)).toBeNull();
    expect(await a.resolve('forged-value')).toBeNull();
  });

  it('password change signs out every other session; recovery code resets the password once', async () => {
    const a = new AuthService(memoryStore());
    const s1 = await a.signup('rook', 'first-pass-11', 'ip');
    const s2 = await a.login('rook', 'first-pass-11', 'ip');
    await fails(a.changePassword(s1.sid, 'not-it-at-all', 'second-pass-22'), 'BAD_PASSWORD');
    const revoked = await a.changePassword(s1.sid, 'first-pass-11', 'second-pass-22');
    expect(revoked.length).toBe(1);
    expect(await a.resolve(s1.sid)).not.toBeNull();
    expect(await a.resolve(s2.sid)).toBeNull();
    await fails(a.login('rook', 'first-pass-11', 'ip'), 'BAD_LOGIN');
    await a.login('rook', 'second-pass-22', 'ip');
    // recovery
    await fails(a.recover('rook', 'AAAAA-BBBBB-CCCCC-DDDDD', 'third-pass-33', 'ip'), 'BAD_RECOVERY');
    const r = await a.recover('rook', s1.recoveryCode.toLowerCase().replace(/-/g, ' '), 'third-pass-33', 'ip');
    expect(r.revoked.length).toBe(2);
    expect(await a.resolve(s1.sid)).toBeNull();
    expect(r.recoveryCode).not.toBe(s1.recoveryCode);
    await fails(a.recover('rook', s1.recoveryCode, 'fourth-pass-44', 'ip'), 'BAD_RECOVERY'); // one-time
    await a.login('rook', 'third-pass-33', 'ip');
  }, 30000);
});

// ───────────────────────────────────────────── game server: account ↔ PMC, ownership

const mk = (save: SaveFile | null = null) => new GameServer(save, { singleplayer: false, accounts: true, snapInterval: 0.5 }, 7);
const conn = (id: string, account?: string) => { const inbox: ServerMsg[] = []; const c: Conn = { id, account, lastEvent: 0, battles: new Set(), send: m => inbox.push(JSON.parse(JSON.stringify(m))) }; return { c, inbox }; };
const ACC_A = '11111111-1111-4111-8111-111111111111', ACC_B = '22222222-2222-4222-8222-222222222222';
const welcome = (inbox: ServerMsg[]) => inbox.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined;

function join(srv: GameServer, id: string, account?: string, pmc?: string) {
  const x = conn(id, account); srv.connect(x.c);
  srv.handle(id, { t: 'hello', name: 'ignored', token: 'ignored' });
  if (pmc && x.inbox.some(m => m.t === 'needPmc')) srv.handle(id, { t: 'createPmc', name: pmc });
  return x;
}

describe('server: accounts own PMCs', () => {
  it('no account → no game: hello asks for login, commands and battle joins are refused', () => {
    const srv = mk();
    const x = join(srv, 'anon');
    expect(x.inbox.map(m => m.t)).toEqual(['auth']);
    srv.handle('anon', { t: 'cmd', id: 1, cmd: { c: 'renameCompany', name: 'x' } });
    srv.handle('anon', { t: 'view', sys: 'drake' });
    srv.handle('anon', { t: 'bjoin', eng: 'e1' });
    srv.handle('anon', { t: 'createPmc', name: '해킹' });
    expect((x.inbox.find(m => m.t === 'ack') as any).err).toBe('로그인 필요');
    expect(x.inbox.some(m => m.t === 'snap' || m.t === 'binit' || m.t === 'welcome')).toBe(false);
    expect(Object.values(srv.sim.st.companies).filter(c => c.kind === 'player')).toHaveLength(0);
    // a token from the old scheme does not log anyone in either
    srv.auth['a'.repeat(32)] = 'p1';
    srv.handle('anon', { t: 'hello', name: 'x', token: 'a'.repeat(32) });
    expect(welcome(x.inbox)).toBeUndefined();
  });

  it('signed-in account without a PMC creates one exactly once, even with duplicate / concurrent requests', () => {
    const srv = mk();
    const a1 = join(srv, 'a1', ACC_A), a2 = join(srv, 'a2', ACC_A);
    expect(a1.inbox.some(m => m.t === 'needPmc')).toBe(true);
    expect(a2.inbox.some(m => m.t === 'needPmc')).toBe(true);
    srv.handle('a1', { t: 'createPmc', name: 'x' });  // too short
    expect(a1.inbox.filter(m => m.t === 'pmcErr')).toHaveLength(1);
    expect(Object.values(srv.sim.st.companies).filter(c => c.kind === 'player')).toHaveLength(0);
    srv.handle('a1', { t: 'createPmc', name: 'ab' });
    srv.handle('a1', { t: 'createPmc', name: '알파 시큐리티' });
    srv.handle('a1', { t: 'createPmc', name: '알파 시큐리티' });
    srv.handle('a2', { t: 'createPmc', name: '다른 이름' });
    const players = Object.values(srv.sim.st.companies).filter(c => c.kind === 'player');
    expect(players).toHaveLength(1);
    expect(players[0].name).toBe('ab');
    expect(welcome(a1.inbox)!.company).toBe(players[0].id);
    expect(welcome(a2.inbox)!.company).toBe(players[0].id); // the other tab entered with the same PMC
    expect(Object.values(srv.sim.st.ships).filter(s => s.owner === players[0].id)).toHaveLength(5); // starting fleet once
    expect(srv.sim.st.companies[players[0].id].credits).toBe(growthOn(srv.sim.st) ? START_CREDITS_GROWTH : 7000);
    // a second account cannot take an existing company name
    const b = join(srv, 'b', ACC_B);
    srv.handle('b', { t: 'createPmc', name: 'AB' });
    expect((b.inbox.find(m => m.t === 'pmcErr') as any).msg).toMatch(/이미 존재/);
  });

  it('A and B are fully separated; A cannot touch B by sending B\'s ids', () => {
    const srv = mk();
    const a = join(srv, 'a', ACC_A, '알파'), b = join(srv, 'b', ACC_B, '베타');
    const A = welcome(a.inbox)!.company, B = welcome(b.inbox)!.company;
    expect(A).not.toBe(B);
    const sim = srv.sim;
    // give B a station and something to steal
    const bg = Object.values(sim.st.groups).find(g => g.owner === B)!;
    const bShip = Object.values(sim.st.ships).find(s => s.owner === B)!;
    const bStation = sim.st.stations.astra;
    const own = Object.values(sim.st.stations).find(s => s.public && s.market)!;
    sim.st.stations['bst'] = { ...JSON.parse(JSON.stringify(own)), id: 'bst', owner: B, public: false, modules: [], orders: [], builds: [], listings: [] };
    const bCm = Object.values(sim.st.commanders).find(c => c.owner === B)!;
    const before = JSON.stringify({ co: sim.st.companies[B], groups: Object.values(sim.st.groups).filter(g => g.owner === B), ships: Object.values(sim.st.ships).filter(s => s.owner === B), st: sim.st.stations.bst, cm: bCm });
    const attempts: any[] = [
      { c: 'setOp', group: bg.id, op: { k: 'idle' } }, { c: 'setDetached', group: bg.id, on: true }, { c: 'release', group: bg.id },
      { c: 'renameGroup', group: bg.id, name: 'pwned' }, { c: 'deleteGroup', group: bg.id }, { c: 'moveShip', ship: bShip.id, group: Object.values(sim.st.groups).find(g => g.owner === A)!.id },
      { c: 'setParent', group: bg.id, parent: null }, { c: 'assignCmd', group: bg.id, commander: null }, { c: 'dismiss', commander: bCm.id },
      { c: 'repair', ship: bShip.id }, { c: 'refit', ship: bShip.id, loadoutId: 'std' }, { c: 'fitShip', ship: bShip.id, fit: [] },
      { c: 'queueModule', station: 'bst', kind: 'refinery' }, { c: 'planOp', station: 'bst', plan: 'x', op: 'cancel' },
      { c: 'prodOrder', station: 'bst', recipe: 'metal', n: 1, mode: 'count' }, { c: 'prodOp', station: 'bst', order: 'o1', op: 'cancel' },
      { c: 'buildShip', station: 'bst', classId: 'corvette', loadoutId: 'gun' }, { c: 'buildOp', station: 'bst', build: 'b1', op: 'cancel' },
      { c: 'research', station: 'bst', tech: 'mining_lasers' }, { c: 'researchOp', project: 'r1', op: 'cancel' },
      { c: 'delist', station: bStation.id, listing: 'l1' },
      { c: 'newGroup', name: 'x', parent: bg.id, ships: [bShip.id] },
    ];
    for (const [i, cmd] of attempts.entries()) srv.handle('a', { t: 'cmd', id: 100 + i, cmd });
    const acks = a.inbox.filter(m => m.t === 'ack') as Extract<ServerMsg, { t: 'ack' }>[];
    expect(acks).toHaveLength(attempts.length);
    for (const k of acks) expect(k.err, `cmd ${JSON.stringify(attempts[k.id - 100])}`).not.toBeNull();
    const after = JSON.stringify({ co: sim.st.companies[B], groups: Object.values(sim.st.groups).filter(g => g.owner === B), ships: Object.values(sim.st.ships).filter(s => s.owner === B), st: sim.st.stations.bst, cm: bCm });
    expect(after).toBe(before);
    // the messages themselves carry no company: A's own commands act on A only
    srv.handle('a', { t: 'cmd', id: 999, cmd: { c: 'renameCompany', name: '알파2' } });
    expect(sim.st.companies[A].name).toBe('알파2');
    expect(sim.st.companies[B].name).toBe('베타');
  });

  it('restart keeps the account links and every asset; a world reset keeps accounts but asks for a new PMC', () => {
    const srv = mk();
    const a = join(srv, 'a', ACC_A, '알파');
    const A = welcome(a.inbox)!.company;
    srv.handle('a', { t: 'cmd', id: 1, cmd: { c: 'renameCompany', name: '알파 개명' } });
    for (let i = 0; i < 20; i++) srv.step(0.5);
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    expect(save.accounts).toEqual({ [ACC_A]: A });
    const srv2 = mk(save);
    const a2 = join(srv2, 'a', ACC_A);
    expect(welcome(a2.inbox)!.company).toBe(A);
    expect(srv2.sim.st.companies[A].name).toBe('알파 개명');
    expect(JSON.stringify(Object.values(srv2.sim.st.ships).filter(s => s.owner === A))).toBe(JSON.stringify(Object.values(srv.sim.st.ships).filter(s => s.owner === A)));
    // world reset: a fresh world with no links (as node.ts writes it); the account still exists elsewhere
    const fresh: SaveFile = { v: 1, world: JSON.parse(WorldSim.create(3).serialize()), auth: {}, accounts: {} };
    const srv3 = mk(fresh);
    const a3 = join(srv3, 'a', ACC_A);
    expect(a3.inbox.some(m => m.t === 'needPmc')).toBe(true);
    srv3.handle('a', { t: 'createPmc', name: '알파 재건' });
    expect(srv3.sim.st.companies[welcome(a3.inbox)!.company].name).toBe('알파 재건');
    // restoring the old backup brings the old link back with the old world, consistently
    const back = mk(save);
    expect(welcome(join(back, 'a', ACC_A).inbox)!.company).toBe(A);
  });

  it('a link whose company does not exist in this world (restored older backup) asks for a PMC instead of failing', () => {
    const w = JSON.parse(WorldSim.create(3).serialize());
    const srv = mk({ v: 1, world: w, auth: {}, accounts: { [ACC_A]: 'p999' } });
    const a = join(srv, 'a', ACC_A);
    expect(a.inbox.some(m => m.t === 'needPmc')).toBe(true);
  });

  it('legacy browser token carries an old PMC over once, never one that is already linked', () => {
    // world from before accounts: two PMCs known only by browser tokens
    const old = new GameServer(null, { singleplayer: false, snapInterval: 0.5 }, 7);
    const x = conn('x'), y = conn('y'); old.connect(x.c); old.connect(y.c);
    old.handle('x', { t: 'hello', name: '구 알파' }); old.handle('y', { t: 'hello', name: '구 베타' });
    const tokX = welcome(x.inbox)!.token, coX = welcome(x.inbox)!.company, tokY = welcome(y.inbox)!.token;
    const save = JSON.parse(JSON.stringify(old.snapshotFile())) as SaveFile;
    expect(save.accounts).toEqual({});
    const srv = mk(save);
    const a = join(srv, 'a', ACC_A);
    srv.handle('a', { t: 'createPmc', name: '', legacy: 'f'.repeat(32) });
    expect((a.inbox.find(m => m.t === 'pmcErr') as any).msg).toMatch(/찾을 수 없/);
    srv.handle('a', { t: 'createPmc', name: '', legacy: tokX });
    expect(welcome(a.inbox)!.company).toBe(coX);
    expect(srv.auth[tokX]).toBeUndefined();             // consumed
    // B tries to reuse A's old token → nothing
    const b = join(srv, 'b', ACC_B);
    srv.handle('b', { t: 'createPmc', name: '', legacy: tokX });
    expect(welcome(b.inbox)).toBeUndefined();
    expect((b.inbox.find(m => m.t === 'pmcErr') as any).msg).toBeTruthy();
    // even if a stale copy of the token map still listed it, a linked PMC cannot be claimed twice
    srv.auth[tokX] = coX;
    srv.handle('b', { t: 'createPmc', name: '', legacy: tokX });
    expect(welcome(b.inbox)).toBeUndefined();
    srv.handle('b', { t: 'createPmc', name: '', legacy: tokY });
    expect(welcome(b.inbox)!.company).not.toBe(coX);
    expect(srv.snapshotFile().accounts).toEqual({ [ACC_A]: coX, [ACC_B]: welcome(b.inbox)!.company });
  });
});

describe('accounts: long-lived game connections', () => {
  it('an open connection keeps its session alive past the idle lifetime', async () => {
    let now = 5_000_000;
    const a = new AuthService(memoryStore(), { ttlMs: 3600_000, now: () => now });
    const s = await a.signup('marathon', 'long-haul-run-5', 'ip');
    const h = (await a.resolve(s.sid))!.idHash;
    for (let i = 0; i < 5; i++) { now += 40 * 60_000; expect(await a.alive(h)).toBe(true); } // 3h20m, sweeps every 40 min
    now += 61 * 60_000;
    expect(await a.alive(h)).toBe(false);
  });
});
