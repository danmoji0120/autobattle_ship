// Transport-agnostic authoritative game server. Used by the Node WebSocket server (multiplayer)
// and by the in-browser LocalTransport (single player) — the same code path in both modes.

import { WorldSim } from '../world/sim';
import type { ClientMsg, ServerMsg, SaveFile, WorldView } from './protocol';
import type { WorldEvent } from '../world/types';

export interface Conn { id: string; send(msg: ServerMsg): void; company?: string; lastEvent: number; battles: Set<string> }

export interface ServerOptions {
  singleplayer: boolean;
  snapInterval: number;           // seconds of real time between snapshots
  save?: (data: SaveFile) => void;
  saveInterval?: number;
}

function token(): string {
  const a = new Uint8Array(16);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

export class GameServer {
  sim: WorldSim;
  auth: Record<string, string>;
  conns = new Map<string, Conn>();
  speed = 1;
  private snapAcc = 0;
  private saveAcc = 0;
  readonly opts: ServerOptions;
  private clock = 0;

  constructor(save: SaveFile | null, opts: ServerOptions, seed = (Date.now() & 0xffffff)) {
    this.opts = opts;
    this.sim = save ? new WorldSim(save.world) : WorldSim.create(seed);
    this.auth = save?.auth ?? {};
    for (const c of Object.values(this.sim.st.companies)) c.online = false;
    this.sim.onBattleOrder = (eng, rec) => {
      for (const c of this.conns.values()) if (c.battles.has(eng)) c.send({ t: 'border', eng, rec });
    };
  }

  snapshotFile(): SaveFile { return { v: 1, world: JSON.parse(this.sim.serialize()), auth: this.auth }; }

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
        let company = msg.token ? this.auth[msg.token] : undefined;
        let tok = msg.token;
        if (!company || !this.sim.st.companies[company]) {
          company = this.sim.addPlayer(msg.name);
          tok = token();
          this.auth[tok] = company;
        }
        c.company = company;
        const co = this.sim.st.companies[company];
        const wasOnline = co.online;
        co.online = true;
        if (!wasOnline) this.sim.ev('world', `${co.name} 접속.`);
        // only tell this client about recent events
        c.lastEvent = Math.max(0, this.sim.st.eventSeq - 40);
        c.send({ t: 'welcome', company, token: tok!, sp: this.opts.singleplayer, serverTime: this.sim.time });
        this.sendSnap(c, this.buildSnap());
        this.flushEvents(c);
        this.broadcastPlayers();
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
        const e = this.sim.st.engagements[msg.eng];
        if (!e) return c.send({ t: 'error', msg: '전투가 끝났거나 존재하지 않음' });
        c.battles.add(e.id);
        c.send({ t: 'binit', eng: e.id, setup: e.setup, orders: e.orders, tick: e.tick });
        return;
      }
      case 'border': {
        if (!c.company) return;
        const err = this.sim.battleOrder(c.company, msg.eng, msg.groupId, msg.order, msg.opts);
        c.send({ t: 'ack', id: msg.id, err });
        return;
      }
      case 'speed': {
        if (this.opts.singleplayer) this.speed = Math.max(0, Math.min(8, msg.v));
        return;
      }
      case 'ping': c.send({ t: 'pong', at: msg.at, serverTime: this.sim.time }); return;
    }
  }

  /** advance by realDt seconds of wall-clock time */
  step(realDt: number) {
    const dt = Math.min(realDt, 0.25) * this.speed;
    if (dt > 0) this.sim.update(dt);
    this.clock += realDt;
    this.snapAcc += realDt;
    if (this.snapAcc >= this.opts.snapInterval) {
      this.snapAcc = 0;
      const snap = this.buildSnap();
      for (const c of this.conns.values()) if (c.company) { this.sendSnap(c, snap); this.flushEvents(c); }
    }
    if (this.opts.save) {
      this.saveAcc += realDt;
      if (this.saveAcc >= (this.opts.saveInterval ?? 30)) { this.saveAcc = 0; this.saveNow(); }
    }
  }

  saveNow() { this.opts.save?.(this.snapshotFile()); }

  private buildSnap(): ServerMsg {
    const { events: _e, rng: _r, ...rest } = this.sim.st;
    void _e; void _r;
    // structuredClone is unnecessary for remote clients (JSON on the wire) but local clients must not alias server state
    const state: WorldView = this.opts.singleplayer ? JSON.parse(JSON.stringify(rest)) : rest;
    return { t: 'snap', at: this.sim.time, speed: this.speed, state };
  }

  private sendSnap(c: Conn, snap: ServerMsg) { c.send(snap); }

  private flushEvents(c: Conn) {
    const out: WorldEvent[] = [];
    for (const e of this.sim.st.events) if (e.id >= c.lastEvent && (!e.company || e.company === c.company)) out.push(e);
    c.lastEvent = this.sim.st.eventSeq;
    if (out.length) c.send({ t: 'events', list: out });
  }

  private broadcastPlayers() {
    const list = Object.values(this.sim.st.companies).filter(c => c.kind === 'player').map(c => ({ id: c.id, name: c.name, online: !!c.online, color: c.color }));
    for (const c of this.conns.values()) c.send({ t: 'players', list });
  }
}
