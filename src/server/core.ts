// Transport-agnostic authoritative game server. Used by the Node WebSocket server (multiplayer)
// and by the in-browser LocalTransport (single player) — the same code path in both modes.

import { Analytics, type AnalyticsOptions } from './analytics';
import { pruneLogisticsJobs } from '../world/retention';
import { WorldSim } from '../world/sim';
import type { ClientMsg, ServerMsg, SaveFile, WorldView } from './protocol';
import type { WorldEvent, WShip } from '../world/types';
import { ClientSync, SyncHub, SYNC_PROTO, legacyView, shipVisible, syncMessage, viewSystem, type SyncFrame } from './sync';

export interface Conn { id: string; send(msg: ServerMsg): void; company?: string; lastEvent: number; battles: Set<string>; view?: string; bytes?: number;
  /** account UUID, set by the transport after it verified the session (never taken from a message) */
  account?: string;
  /** transports that can take pre-serialized JSON text (enables protocol 2 replication) */
  sendText?(json: string): void;
  /** replication protocol the client asked for in `hello` (1 = full snapshots, 2 = deltas) */
  proto?: number;
  sync?: ClientSync;
  /** send this client its state changes at the next step (after its own command, a view change, a resync) */
  prompt?: boolean;
  /** transport back-pressure: true while the client is too far behind to receive state updates */
  congested?(): boolean }

export interface ServerOptions {
  singleplayer: boolean;
  /** multiplayer with accounts: a connection controls exactly the PMC linked to its verified account */
  accounts?: boolean;
  snapInterval: number;           // seconds of real time between full snapshots
  movInterval?: number;           // seconds between compact ship-motion packets (default 0.2)
  save?: (data: SaveFile) => void;
  /** called instead of `save` when the autosave is due; the host serializes with saveText()/analyticsText() */
  onSaveDue?: () => void;
  saveInterval?: number;
  /** apply the content-model migration to an older save (default true; the production server keeps it
   *  off until approved and only dry-runs it — see node.ts CONTENT_MIGRATE) */
  migrateContent?: boolean;
  analytics?: AnalyticsOptions;
  /** keep only this many finished logistics jobs per company (see world/retention.ts); unset = keep all */
  logisticsJobRetain?: number;
  /** Verified account UUIDs, configured only by the server administrator. Empty = disabled. */
  adminAccounts?: string[];
  /** Verified account UUID that owns the account-exclusive content (commander BB, ship BB-EX).
   *  Set only by the server operator (SIDERARIUM_BB_OWNER_ACCOUNT). Unset = nobody is granted it. */
  exclusiveOwner?: string;
  /** Defer automatic exclusive grant until the host has verified restoration/migration conservation. */
  deferExclusiveGrant?: boolean;
}

function token(): string {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export class GameServer {
  sim: WorldSim;
  analytics: Analytics | null;
  private inactiveAnalytics?: import('./analytics').AnalyticsStore;
  private analyticsRequests = new Map<string, number>();
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
  private hub = new SyncHub();
  /** an old (protocol 1) client's command succeeded: broadcast at the next step, as before */
  private legacyPrompt = false;
  private promptAt = -1;
  private pruneAcc = 0;
  /** finished logistics jobs removed by the retention policy since start */
  pruned = 0;
  /** replication cost and volume since start (see status()) */
  readonly net = { frames: 0, frameMs: 0, sendMs: 0, msgs: 0, bytes: 0, skippedCongested: 0, entities: 0 };
  /** transport counters, filled by the Node WebSocket layer (node.ts) */
  /** whole-step durations (simulation + analytics + replication) of the last minute, for status() */
  private stepMs = new Float64Array(1200);
  private stepN = 0;
  private lastRate = 1;
  readonly wsNet = { opened: 0, closed: 0, inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, dropped: 0, floodClosed: 0, slowTerminated: 0, heartbeatTerminated: 0, errors: 0, handleErrors: 0 };

  constructor(save: SaveFile | null, opts: ServerOptions, seed = (Date.now() & 0xffffff)) {
    this.opts = opts;
    this.sim = save ? new WorldSim(save.world, { migrateContent: opts.migrateContent }) : WorldSim.create(seed);
    this.analytics = opts.analytics?.enabled === false ? null : new Analytics(this.sim, save?.analytics, opts.analytics);
    if (!this.analytics && save?.analytics) { this.inactiveAnalytics = structuredClone(save.analytics); this.inactiveAnalytics.pausedAt ??= this.sim.time; }
    this.auth = save?.auth ?? {};
    this.accounts = save?.accounts ?? {};
    for (const c of Object.values(this.sim.st.companies)) c.online = false;
    if (!opts.deferExclusiveGrant) this.grantExclusive();
    this.sim.onBattleOrder = (eng, rec) => {
      for (const c of this.conns.values()) if (c.battles.has(eng)) c.send({ t: 'border', eng, rec });
    };
  }

  /**
   * The save as JSON text, built once: equal to JSON.stringify(snapshotFile()) when analytics are included,
   * without parsing the world back into objects and serializing it again.
   * `analytics: false` leaves the analytics history out (it is then saved separately, see analyticsText).
   */
  saveText(opts: { analytics?: boolean } = {}): string {
    const parts = [`"v":1`, `"world":${this.sim.serialize()}`];
    const auth = JSON.stringify(this.auth), accounts = JSON.stringify(this.accounts);
    if (auth !== undefined) parts.push(`"auth":${auth}`);
    if (accounts !== undefined) parts.push(`"accounts":${accounts}`);
    if (opts.analytics !== false) {
      const a = this.analytics ? this.analytics.snapshotText() : this.inactiveAnalytics ? JSON.stringify(this.inactiveAnalytics) : undefined;
      if (a !== undefined) parts.push(`"analytics":${a}`);
    }
    return '{' + parts.join(',') + '}';
  }
  /**
   * The analytics history on its own (saved less often than the world). It is stamped as paused at this
   * moment: if the world is restored from a later save, the analytics record the unobserved interval as a
   * gap (the same mechanism as a server running with analytics disabled) instead of mixing periods.
   */
  analyticsText(): string | null {
    const a = this.analytics ? this.analytics.snapshotText() : this.inactiveAnalytics ? JSON.stringify(this.inactiveAnalytics) : null;
    if (a === null || a[0] !== '{') return a;
    const inner = a.slice(1, -1);
    return this.analytics ? `{${inner}${inner ? ',' : ''}"pausedAt":${JSON.stringify(this.sim.time)}}` : a;
  }

  snapshotFile(): SaveFile { return { v: 1, world: JSON.parse(this.sim.serialize()), auth: this.auth, accounts: this.accounts, ...(this.analytics ? { analytics: this.analytics.snapshot() } : this.inactiveAnalytics ? { analytics: structuredClone(this.inactiveAnalytics) } : {}) }; }

  /** Bind BB / BB-EX to the configured owner account's PMC. Called at start, when that account's PMC
   *  is created and whenever it enters; idempotent (world/exclusive.ts) — never a second copy, never
   *  another account. Returns what happened, for the operator's log and the tests. */
  grantExclusive(): string {
    const owner = this.opts.exclusiveOwner;
    if (!owner) return 'unconfigured';
    if (!this.opts.accounts && !this.opts.singleplayer) return 'unconfigured';
    const company = this.opts.singleplayer ? this.localCompany() : this.companyOf(owner);
    if (!company) return 'no-company';
    const r = this.sim.grantExclusive(owner, company);
    if (r === 'granted' || r === 'repaired') this.saveNow();
    if (r === 'bound-elsewhere') console.warn('[siderarium] BB/BB-EX는 이미 다른 계정에 귀속되어 있습니다 — 소유권은 이전되지 않습니다 (SIDERARIUM_BB_OWNER_ACCOUNT 확인 필요).');
    return r;
  }
  /** single-player worlds have one PMC and no accounts: an explicit `exclusiveOwner` binds to it (dev / local play only) */
  private localCompany(): string | null {
    return Object.values(this.sim.st.companies).find(c => c.kind === 'player')?.id ?? null;
  }

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
    if (c.proto === SYNC_PROTO) { (c.sync ??= new ClientSync()).reset(); this.syncNow(c); }
    else this.sendSnap(c, this.snapBase());
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
    if (c.account === this.opts.exclusiveOwner) this.grantExclusive();
    this.saveNow(); // the link and the starting assets are persisted together right away
    // every open tab of this account enters with the same PMC
    for (const o of this.conns.values()) if (o.account === c.account && !o.company) this.enter(o, company, '');
    return null;
  }

  connect(conn: Conn) { this.conns.set(conn.id, conn); }

  disconnect(id: string) {
    const c = this.conns.get(id);
    this.conns.delete(id);
    this.analyticsRequests.delete(id);
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
      case 'analytics': {
        const admin = !!(this.opts.singleplayer || this.opts.accounts && c.account && this.opts.adminAccounts?.includes(c.account));
        if (!c.company) return c.send({ t: 'analytics', id: msg.id, error: '로그인이 필요합니다' });
        if (msg.scope !== 'player' && msg.scope !== 'admin') return c.send({ t: 'analytics', id: msg.id, error: '잘못된 조회 범위' });
        if (msg.scope === 'admin' && !admin) return c.send({ t: 'analytics', id: msg.id, error: '관리자 권한이 없습니다. 서버의 관리자 계정 설정이 필요합니다.', admin: false });
        if (!this.analytics) return c.send({ t: 'analytics', id: msg.id, error: '통계 수집이 비활성화되어 있습니다', admin });
        const last = this.analyticsRequests.get(c.id);
        if (last !== undefined && this.clock - last < .5) return c.send({ t: 'analytics', id: msg.id, error: '조회가 너무 빠릅니다. 잠시 후 새로고침하세요.', admin });
        this.analyticsRequests.set(c.id, this.clock);
        const query = msg.query && typeof msg.query === 'object' ? msg.query : {};
        return c.send({ t: 'analytics', id: msg.id, data: this.analytics.query(msg.scope, c.company, query), admin });
      }
      case 'hello': {
        c.proto = msg.proto === SYNC_PROTO && c.sendText ? SYNC_PROTO : 1;
        if (this.opts.accounts) {
          // identity is the verified account only; tokens and names in the message are ignored
          if (!c.account) return c.send({ t: 'auth', need: 'login' });
          const company = this.companyOf(c.account);
          if (!company) return c.send({ t: 'needPmc' });
          if (c.account === this.opts.exclusiveOwner) this.grantExclusive();
          return this.enter(c, company, '');
        }
        let company = msg.token ? this.auth[msg.token] : undefined;
        let tok = msg.token;
        if (!company || !this.sim.st.companies[company]) {
          company = this.sim.addPlayer(msg.name);
          tok = token();
          this.auth[tok] = company;
        }
        if (this.opts.singleplayer && this.opts.exclusiveOwner) this.grantExclusive();
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
        // push the result promptly to the commanding client (everyone else sees it with the next broadcast)
        if (!err) { if (c.proto === SYNC_PROTO) c.prompt = true; else this.legacyPrompt = true; }
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
      case 'view': if (c.company && typeof msg.sys === 'string' && Object.hasOwn(this.sim.st.systems, msg.sys)) { const changed = c.view !== msg.sys; c.view = msg.sys; if (changed) { if (c.proto === SYNC_PROTO) c.prompt = true; else this.sendSnap(c, this.snapBase()); } } return;
    }
  }

  /** advance by realDt seconds of wall-clock time */
  step(realDt: number) {
    // multiplayer catches up after a stall (up to 1 s) so world time keeps pace with the wall clock
    const dt = Math.min(realDt, this.opts.singleplayer ? 0.25 : 1) * this.speed;
    const t0 = performance.now();
    if (dt > 0) this.sim.update(dt);
    this.analytics?.step(realDt);
    this.tickCost.push(performance.now() - t0);
    this.clock += realDt;
    this.snapAcc += realDt;
    this.movAcc += realDt;
    this.statAcc += realDt;
    const legacyPrompt = this.legacyPrompt; this.legacyPrompt = false;
    const n0 = performance.now();
    if (this.snapAcc >= this.opts.snapInterval || legacyPrompt) {
      this.snapAcc = 0; this.movAcc = 0;
      let frame: SyncFrame | undefined;
      for (const c of this.conns.values()) if (c.company) {
        if (c.congested?.()) { this.net.skippedCongested++; continue; }
        if (c.proto === SYNC_PROTO) this.syncTo(c, frame ??= this.makeFrame(), true);
        else this.sendSnap(c);
        this.flushEvents(c);
      }
      if (frame) this.retire(frame);
    } else {
      // command results reach the commanding client within ~0.1 s; prompt frames are batched (at most 10/s)
      let frame: SyncFrame | undefined;
      if (this.clock - this.promptAt >= 0.1) for (const c of this.conns.values()) if (c.prompt && c.company && c.proto === SYNC_PROTO && !c.congested?.()) this.syncTo(c, frame ??= this.makeFrame());
      if (frame) { this.retire(frame); this.promptAt = this.clock; }
      if (this.movAcc >= (this.opts.movInterval ?? 0.2)) {
        this.movAcc = 0;
        this.movRows.clear(); this.movSys.clear(); this.movOwn = null;
        for (const c of this.conns.values()) if (c.company) {
          if (c.congested?.()) { this.net.skippedCongested++; continue; }
          if (c.sendText) { const m = this.movText(c); c.sendText(m); this.net.msgs++; this.net.bytes += m.length; }
          else c.send(this.buildMov(c));
        }
      }
    }
    this.net.sendMs += performance.now() - n0;
    if (this.statAcc >= 2) {
      const span = this.clock - this.rateMark.clock;
      const rate = span > 0 ? (this.sim.time - this.rateMark.time) / span : 0;
      this.lastRate = rate;
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
    if (this.opts.logisticsJobRetain !== undefined && (this.pruneAcc += realDt) >= 60) { this.pruneAcc = 0; this.pruned += pruneLogisticsJobs(this.sim.st, this.opts.logisticsJobRetain); }
    const ms = performance.now() - t0;
    this.stepMs[this.stepN++ % this.stepMs.length] = ms;
    if (this.opts.save) {
      this.saveAcc += realDt;
      if (this.saveAcc >= (this.opts.saveInterval ?? 30)) { this.saveAcc = 0; this.saveNow(); }
    } else if (this.opts.onSaveDue) {
      this.saveAcc += realDt;
      if (this.saveAcc >= (this.opts.saveInterval ?? 30)) { this.saveAcc = 0; this.opts.onSaveDue(); }
    }
  }

  saveNow() { this.opts.save?.(this.snapshotFile()); }

  /** everything except ships (filtered per client); battles without their heavy setup/orders */
  private snapBase(): Omit<WorldView, 'ships'> {
    const { events: _e, rng: _r, ships: _s, engagements, battleLog, exclusive: _x0, ...rest } = this.sim.st;
    void _e; void _r; void _s; void _x0;   // the exclusive ledger holds an account id: server-only
    const eng: Record<string, any> = {};
    for (const [id, e] of Object.entries(engagements)) { const { setup: _x, orders: _o, ...lite } = e; void _x; void _o; eng[id] = lite; }
    const log = (battleLog ?? []).map(({ setup: _x, orders: _o, ...lite }) => { void _x; void _o; return lite; });
    return { ...rest, engagements: eng, battleLog: log } as Omit<WorldView, 'ships'>;
  }

  /** the system a client is looking at (defaults to where its company is based) */
  private viewOf(c: Conn): string { return viewSystem(this.sim.st, c, p => this.sim.sysOf(p)); }

  /** interest management: your own ships anywhere + everything in the system you are viewing */
  private visibleShips(c: Conn): WorldView['ships'] {
    const origin = this.sim.st.systems[this.viewOf(c)]?.origin;
    const out: WorldView['ships'] = {};
    for (const s of Object.values(this.sim.st.ships)) if (shipVisible(s, c.company, origin)) out[s.id] = s;
    return out;
  }

  // ── protocol 2 replication (see sync.ts)
  private makeFrame(): SyncFrame { this.net.frames++; return this.hub.frame(this.sim.st, this.sim.time, this.speed); }
  private retire(f: SyncFrame) { this.net.entities += f.stringified; this.hub.done(f); }
  private syncTo(c: Conn, f: SyncFrame, broadcast = false) {
    const t = performance.now();
    const msg = syncMessage(f, c.sync ??= new ClientSync(), c, this.viewOf(c), broadcast);
    c.prompt = false;
    if (msg) { c.sendText!(msg); this.net.msgs++; this.net.bytes += msg.length; }
    this.net.frameMs += performance.now() - t;
  }
  /** bring one protocol-2 client up to date right now (on entering the world) */
  private syncNow(c: Conn) { const f = this.makeFrame(); this.syncTo(c, f, true); this.retire(f); }
  /** operator status (no player data): tick cost percentiles over the last minute, simulation rate, replication */
  status() {
    const n = Math.min(this.stepN, this.stepMs.length), a = Array.from(this.stepMs.subarray(0, n)).sort((x, y) => x - y);
    const q = (p: number) => n ? +a[Math.min(n - 1, Math.floor(n * p))].toFixed(2) : 0;
    let players = 0, proto2 = 0;
    for (const c of this.conns.values()) { if (c.company) players++; if (c.proto === SYNC_PROTO) proto2++; }
    return {
      time: +this.sim.time.toFixed(1), speed: this.speed,
      tick: { samples: n, p50: q(.5), p95: q(.95), p99: q(.99), max: n ? +a[n - 1].toFixed(1) : 0, budgetMs: 50, over50: a.filter(x => x > 50).length, simRate: +this.lastRate.toFixed(3), npcBattleMs: +(this.sim.npcBattleMs ?? 0).toFixed(2) },
      world: { ships: Object.keys(this.sim.st.ships).length, companies: Object.keys(this.sim.st.companies).length, battles: this.sim.battles.size, logisticsJobs: Object.keys(this.sim.st.logisticsJobs ?? {}).length, logisticsJobsPruned: this.pruned },
      conns: { total: this.conns.size, inWorld: players, proto2 },
      net: { ...this.net, frameMs: +this.net.frameMs.toFixed(1), sendMs: +this.net.sendMs.toFixed(1) },
      ws: { ...this.wsNet },
      analytics: this.analytics ? { cpuMs: +this.analytics.cpuMs.toFixed(0) } : null,
    };
  }
  /** resend everything to a client on its next update (e.g. after its transport dropped messages) */
  resync(connId: string) { const c = this.conns.get(connId); if (c?.sync) { c.sync.reset(); c.prompt = true; } }

  /** protocol 1: the whole visible world (old clients, tests) */
  private sendSnap(c: Conn, _base?: Omit<WorldView, 'ships'>) {
    const state = legacyView(this.sim.st, c, this.viewOf(c));
    // local clients must not alias server state; remote ones get JSON anyway
    c.send({ t: 'snap', at: this.sim.time, speed: this.speed, state: this.opts.singleplayer ? JSON.parse(JSON.stringify(state)) : state });
  }

  /** per mov tick: one serialized row per ship, and one joined block per viewed system, shared by every client */
  private movRows = new Map<string, string>();
  private movSys = new Map<string, { text: string; ids: Set<string> }>();
  private movOwn: Map<string, WShip[]> | null = null;
  private movRow(s: WShip): string {
    let r = this.movRows.get(s.id);
    if (r === undefined) {
      const r1 = (n: number) => Math.round(n * 10) / 10;
      this.movRows.set(s.id, r = JSON.stringify([s.id, r1(s.pos.x), r1(s.pos.y), r1(s.pos.z), r1(s.vel.x), r1(s.vel.y), r1(s.vel.z), Math.round(s.heading * 1000) / 1000, s.warp ? (s.warp.phase === 'warp' ? 2 : 1) : 0]));
    }
    return r;
  }
  private movText(c: Conn): string {
    // battle ships too: their positions mirror the server's tactical sim, so the map shows the fight
    const moving = (s: WShip) => s.state === 'space' || (s.state === 'battle' && s.hp > 0);
    const sysId = this.viewOf(c);
    let sys = this.movSys.get(sysId);
    if (!sys) {
      const origin = this.sim.st.systems[sysId]?.origin, rows: string[] = [], ids = new Set<string>();
      if (origin) for (const s of Object.values(this.sim.st.ships)) if (shipVisible(s, undefined, origin) && moving(s)) { rows.push(this.movRow(s)); ids.add(s.id); }
      this.movSys.set(sysId, sys = { text: rows.join(','), ids });
    }
    // own ships elsewhere (the same visibility rule as snapshots: your ships anywhere + everything in view)
    if (!this.movOwn) { this.movOwn = new Map(); for (const s of Object.values(this.sim.st.ships)) { let l = this.movOwn.get(s.owner); if (!l) this.movOwn.set(s.owner, l = []); l.push(s); } }
    let extra = '';
    if (c.company) for (const s of this.movOwn.get(c.company) ?? []) if (!sys.ids.has(s.id) && moving(s)) extra += (extra || sys.text ? ',' : '') + this.movRow(s);
    return `{"t":"mov","at":${JSON.stringify(this.sim.time)},"s":[${sys.text}${extra}]}`;
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
