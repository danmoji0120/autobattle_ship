// Transport-agnostic authoritative game server. Used by the Node WebSocket server (multiplayer)
// and by the in-browser LocalTransport (single player) — the same code path in both modes.

import { WorldSim } from '../world/sim';
import type { ClientMsg, ServerMsg, SaveFile, WorldView } from './protocol';
import type { WorldEvent } from '../world/types';

export interface Conn { id: string; send(msg: ServerMsg): void; company?: string; lastEvent: number; battles: Set<string>; view?: string; bytes?: number;
  /** account UUID, set by the transport after it verified the session (never taken from a message) */
  account?: string }

export interface ServerOptions {
  singleplayer: boolean;
  /** multiplayer with accounts: a connection controls exactly the PMC linked to its verified account */
  accounts?: boolean;
  snapInterval: number;           // seconds of real time between full snapshots
  movInterval?: number;           // seconds between compact ship-motion packets (default 0.2)
  save?: (data: SaveFile) => void;
  saveInterval?: number;
  /** apply the content-model migration to an older save (default true; the production server keeps it
   *  off until approved and only dry-runs it — see node.ts CONTENT_MIGRATE) */
  migrateContent?: boolean;
}

function token(): string {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export class GameServer {
  sim: WorldSim;
  auth: Record<string, string>;
  /** account UUID → company */
  accounts: Record<string, string>;
  conns = new Map<string, Conn>();
  speed = 1;
  private snapAcc = 0;
  private saveAcc = 0;
  readonly opts: ServerOptions;
  private clock = 0;
  private movAcc = 0;
  private statAcc = 0;
  private tickCost: number[] = [];
  private rateMark = { clock: 0, time: 0 };

  constructor(save: SaveFile | null, opts: ServerOptions, seed = (Date.now() & 0xffffff)) {
    this.opts = opts;
    this.sim = save ? new WorldSim(save.world, { migrateContent: opts.migrateContent }) : WorldSim.create(seed);
    this.auth = save?.auth ?? {};
    this.accounts = save?.accounts ?? {};
    for (const c of Object.values(this.sim.st.companies)) c.online = false;
    this.sim.onBattleOrder = (eng, rec) => {
      for (const c of this.conns.values()) if (c.battles.has(eng)) c.send({ t: 'border', eng, rec });
    };
  }

  snapshotFile(): SaveFile { return { v: 1, world: JSON.parse(this.sim.serialize()), auth: this.auth, accounts: this.accounts }; }

  /** the company an account controls in this world (null: none yet, or its PMC is gone) */
  companyOf(account: string): string | null {
    const id = this.accounts[account];
    return id && this.sim.st.companies[id]?.kind === 'player' ? id : null;
  }

  /** a connection enters the world as `company` */
  private enter(c: Conn, company: string, tok: string) {
    c.company = company;
    const co = this.sim.st.companies[company];
    const wasOnline = co.online;
    co.online = true;
    if (!wasOnline) this.sim.ev('world', `${co.name} 접속.`);
    // only tell this client about recent events
    c.lastEvent = Math.max(0, this.sim.st.eventSeq - 40);
    c.send({ t: 'welcome', company, token: tok, sp: this.opts.singleplayer, serverTime: this.sim.time });
    this.sendSnap(c, this.snapBase());
    this.flushEvents(c);
    this.broadcastPlayers();
  }

  /** PMC creation for an account: exactly once (the check and the link happen in one synchronous step,
   *  so duplicate or concurrent requests from several tabs all land on the same company) */
  private createPmc(c: Conn, name: string, legacy?: string): string | null {
    if (!c.account) return '로그인이 필요합니다';
    const have = this.companyOf(c.account);
    if (have) { this.enter(c, have, ''); return null; }
    const n = String(name ?? '').normalize('NFKC').replace(/[\u0000-\u001f<>]/g, '').trim();
    let company: string | null = null;
    if (legacy) {
      // carry over a PMC created before accounts existed: the old random browser token proves possession;
      // it is consumed, and a PMC already linked to some account can never be claimed
      const id = typeof legacy === 'string' && /^[0-9a-f]{32}$/.test(legacy) ? this.auth[legacy] : undefined;
      if (!id || this.sim.st.companies[id]?.kind !== 'player') return '이 브라우저의 이전 PMC 정보를 찾을 수 없습니다 (월드가 초기화되었거나 이미 이전됨)';
      if (Object.values(this.accounts).includes(id)) { delete this.auth[legacy]; return '이미 다른 계정으로 이전된 PMC입니다'; }
      delete this.auth[legacy];
      company = id;
      this.sim.ev('world', `${this.sim.st.companies[id].name}이(가) 정식 계정으로 이전되었다.`);
    } else {
      if (n.length < 2 || n.length > 20) return 'PMC 이름은 2~20자입니다';
      const taken = Object.values(this.sim.st.companies).some(o => o.name.toLowerCase() === n.toLowerCase());
      if (taken) return '이미 존재하는 회사 이름입니다';
      company = this.sim.addPlayer(n);
    }
    this.accounts[c.account] = company;
    this.saveNow(); // the link and the starting assets are persisted together right away
    // every open tab of this account enters with the same PMC
    for (const o of this.conns.values()) if (o.account === c.account && !o.company) this.enter(o, company, '');
    return null;
  }

  connect(conn: Conn) { this.conns.set(conn.id, conn); }

  disconnect(id: string) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (c?.company && ![...this.conns.values()].some(o => o.company === c.company)) {
      const co = this.sim.st.companies[c.company];
      if (co) { co.online = false; this.sim.ev('world', `${co.name} 접속 종료 — 함대는 지휘관들이 계속 운용한다.`); }
      this.broadcastPlayers();
    }
  }

  handle(connId: string, msg: ClientMsg) {
    const c = this.conns.get(connId);
    if (!c) return;
    switch (msg.t) {
      case 'hello': {
        if (this.opts.accounts) {
          // identity is the verified account only; tokens and names in the message are ignored
          if (!c.account) return c.send({ t: 'auth', need: 'login' });
          const company = this.companyOf(c.account);
          if (!company) return c.send({ t: 'needPmc' });
          return this.enter(c, company, '');
        }
        let company = msg.token ? this.auth[msg.token] : undefined;
        let tok = msg.token;
        if (!company || !this.sim.st.companies[company]) {
          company = this.sim.addPlayer(msg.name);
          tok = token();
          this.auth[tok] = company;
        }
        return this.enter(c, company, tok!);
      }
      case 'createPmc': {
        if (!this.opts.accounts) return;
        const err = this.createPmc(c, msg.name, msg.legacy);
        if (err) c.send({ t: 'pmcErr', msg: err });
        return;
      }
      case 'cmd': {
        if (!c.company) return c.send({ t: 'ack', id: msg.id, err: '로그인 필요' });
        let err: string | null;
        try { err = this.sim.command(c.company, msg.cmd); } catch (e) { err = '서버 오류: ' + (e as Error).message; }
        c.send({ t: 'ack', id: msg.id, err });
        if (!err) this.snapAcc = this.opts.snapInterval; // push the result promptly
        return;
      }
      case 'bjoin': {
        if (!c.company) return c.send({ t: 'error', msg: '로그인 필요' });
        const e = this.sim.st.engagements[msg.eng];
        const rec = this.sim.st.battleLog?.find(r => r.id === msg.eng);
        // a running battle: join live; a finished one: replay it from its record
        if (e && !e.done && e.autoEnd === undefined) {
          c.battles.add(e.id);
          return c.send({ t: 'binit', eng: e.id, setup: e.setup, orders: e.orders, tick: e.tick, names: e.names });
        }
        if (rec) return c.send({ t: 'binit', eng: rec.id, setup: rec.setup, orders: rec.orders, tick: 0, replay: true, names: rec.names });
        return c.send({ t: 'error', msg: e?.autoEnd !== undefined ? '원거리 판정 전투라 관전할 수 없음' : '전투 기록이 없음' });
      }
      case 'border': {
        if (!c.company) return c.send({ t: 'ack', id: msg.id, err: '로그인 필요' });
        const err = this.sim.battleOrder(c.company, msg.eng, msg.groupId, msg.order, msg.opts);
        c.send({ t: 'ack', id: msg.id, err });
        return;
      }
      case 'speed': {
        if (this.opts.singleplayer) this.speed = Math.max(0, Math.min(8, msg.v));
        return;
      }
      case 'ping': c.send({ t: 'pong', at: msg.at, serverTime: this.sim.time }); return;
      case 'view': if (c.company && this.sim.st.systems[msg.sys]) { const changed = c.view !== msg.sys; c.view = msg.sys; if (changed) this.sendSnap(c, this.snapBase()); } return;
    }
  }

  /** advance by realDt seconds of wall-clock time */
  step(realDt: number) {
    // multiplayer catches up after a stall (up to 1 s) so world time keeps pace with the wall clock
    const dt = Math.min(realDt, this.opts.singleplayer ? 0.25 : 1) * this.speed;
    const t0 = performance.now();
    if (dt > 0) this.sim.update(dt);
    this.tickCost.push(performance.now() - t0);
    this.clock += realDt;
    this.snapAcc += realDt;
    this.movAcc += realDt;
    this.statAcc += realDt;
    if (this.snapAcc >= this.opts.snapInterval) {
      this.snapAcc = 0; this.movAcc = 0;
      const base = this.snapBase();
      for (const c of this.conns.values()) if (c.company) { this.sendSnap(c, base); this.flushEvents(c); }
    } else if (this.movAcc >= (this.opts.movInterval ?? 0.2)) {
      this.movAcc = 0;
      for (const c of this.conns.values()) if (c.company) c.send(this.buildMov(c));
    }
    if (this.statAcc >= 2) {
      const span = this.clock - this.rateMark.clock;
      const rate = span > 0 ? (this.sim.time - this.rateMark.time) / span : 0;
      this.rateMark = { clock: this.clock, time: this.sim.time };
      const avg = this.tickCost.reduce((a, b) => a + b, 0) / Math.max(1, this.tickCost.length);
      const max = Math.max(0, ...this.tickCost);
      this.tickCost = [];
      for (const c of this.conns.values()) if (c.company) {
        c.send({ t: 'stats', tickMs: avg, tickMax: max, rate, bytes: (c.bytes ?? 0) / this.statAcc, ships: Object.keys(this.sim.st.ships).length, conns: this.conns.size, battles: this.sim.battles.size, battleMs: this.sim.npcBattleMs });
        c.bytes = 0;
      }
      this.statAcc = 0;
    }
    if (this.opts.save) {
      this.saveAcc += realDt;
      if (this.saveAcc >= (this.opts.saveInterval ?? 30)) { this.saveAcc = 0; this.saveNow(); }
    }
  }

  saveNow() { this.opts.save?.(this.snapshotFile()); }

  /** everything except ships (filtered per client); battles without their heavy setup/orders */
  private snapBase(): Omit<WorldView, 'ships'> {
    const { events: _e, rng: _r, ships: _s, engagements, battleLog, ...rest } = this.sim.st;
    void _e; void _r; void _s;
    const eng: Record<string, any> = {};
    for (const [id, e] of Object.entries(engagements)) { const { setup: _x, orders: _o, ...lite } = e; void _x; void _o; eng[id] = lite; }
    const log = (battleLog ?? []).map(({ setup: _x, orders: _o, ...lite }) => { void _x; void _o; return lite; });
    return { ...rest, engagements: eng, battleLog: log } as Omit<WorldView, 'ships'>;
  }

  /** the system a client is looking at (defaults to where its company is based) */
  private viewOf(c: Conn): string {
    if (c.view) return c.view;
    const co = c.company ? this.sim.st.companies[c.company] : null;
    const home = co ? this.sim.st.stations[co.homeStation] : null;
    return (home && this.sim.sysOf(home.pos)?.id) || 'astra';
  }

  /** interest management: your own ships anywhere + everything in the system you are viewing */
  private visibleShips(c: Conn): WorldView['ships'] {
    const view = this.sim.st.systems[this.viewOf(c)];
    const out: WorldView['ships'] = {};
    for (const s of Object.values(this.sim.st.ships)) {
      if (s.owner === c.company || (view && Math.round((s.pos.x - view.origin.x) / 250000) === 0)) out[s.id] = s;
    }
    return out;
  }

  private sendSnap(c: Conn, base: Omit<WorldView, 'ships'>) {
    const state = { ...base, ships: this.visibleShips(c) } as WorldView;
    // local clients must not alias server state; remote ones get JSON anyway
    c.send({ t: 'snap', at: this.sim.time, speed: this.speed, state: this.opts.singleplayer ? JSON.parse(JSON.stringify(state)) : state });
  }

  private buildMov(c: Conn): ServerMsg {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const out: (string | number)[][] = [];
    for (const s of Object.values(this.visibleShips(c))) {
      // battle ships too: their positions mirror the server's tactical sim, so the map shows the fight
      if (s.state !== 'space' && !(s.state === 'battle' && s.hp > 0)) continue;
      out.push([s.id, r1(s.pos.x), r1(s.pos.y), r1(s.pos.z), r1(s.vel.x), r1(s.vel.y), r1(s.vel.z), Math.round(s.heading * 1000) / 1000, s.warp ? (s.warp.phase === 'warp' ? 2 : 1) : 0]);
    }
    return { t: 'mov', at: this.sim.time, s: out };
  }

  private flushEvents(c: Conn) {
    const out: WorldEvent[] = [];
    for (const e of this.sim.st.events) if (e.id >= c.lastEvent && (!e.company || e.company === c.company)) out.push(e);
    c.lastEvent = this.sim.st.eventSeq;
    if (out.length) c.send({ t: 'events', list: out });
  }

  private broadcastPlayers() {
    const list = Object.values(this.sim.st.companies).filter(c => c.kind === 'player').map(c => ({ id: c.id, name: c.name, online: !!c.online, color: c.color }));
    for (const c of this.conns.values()) if (c.company) c.send({ t: 'players', list });
  }
}
