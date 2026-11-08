// Client side of the protocol. Single player runs the very same GameServer in-process
// (LocalTransport) so both modes share one code path; multiplayer uses a WebSocket.

import { GameServer, type Conn } from '../server/core';
import type { ClientMsg, ServerMsg, SaveFile, WorldView } from '../server/protocol';
import type { Cmd } from '../world/sim';
import type { WorldEvent } from '../world/types';
import type { Order, OrderRecord } from '../sim/types';
import { NetClock, MotionTrack } from './interp';

export interface Transport { send(m: ClientMsg): void; onMessage: (m: ServerMsg) => void; close(): void; readonly kind: 'local' | 'remote' }

const SP_KEY = 'siderarium.sp.v1';

export function hasLocalSave(): boolean { try { return !!localStorage.getItem(SP_KEY); } catch { return false; } }
export function clearLocalSave() { try { localStorage.removeItem(SP_KEY); } catch { /* */ } }

export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  server: GameServer;
  onMessage: (m: ServerMsg) => void = () => {};
  private timer: number;
  private conn: Conn;
  private last = performance.now();

  constructor(fresh: boolean) {
    let save: SaveFile | null = null;
    if (!fresh) { try { const raw = localStorage.getItem(SP_KEY); if (raw) save = JSON.parse(raw); } catch { save = null; } }
    this.server = new GameServer(save, {
      singleplayer: true, analytics: { maxBytes: 1048576 }, snapInterval: 0.5, movInterval: 0.1, saveInterval: 20,
      save: d => { try { localStorage.setItem(SP_KEY, JSON.stringify(d)); } catch (e) { console.warn('save failed', e); } },
    }, (Date.now() & 0xffff) + 1);
    // deliver asynchronously like a real socket so the client never aliases server objects mid-call
    this.conn = { id: 'local', lastEvent: 0, battles: new Set(), send: m => queueMicrotask(() => this.onMessage(m)) };
    this.server.connect(this.conn);
    this.timer = window.setInterval(() => {
      const now = performance.now();
      this.server.step(Math.min(0.25, (now - this.last) / 1000));
      this.last = now;
    }, 50);
    addEventListener('beforeunload', this.saveNow);
  }
  saveNow = () => { this.server.saveNow(); };
  send(m: ClientMsg) { this.server.handle('local', JSON.parse(JSON.stringify(m))); }
  close() { this.saveNow(); clearInterval(this.timer); removeEventListener('beforeunload', this.saveNow); }
}

export class WsTransport implements Transport {
  readonly kind = 'remote' as const;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: 'open' | 'closed' | 'connecting') => void = () => {};
  private ws: WebSocket | null = null;
  private queue: ClientMsg[] = [];
  private closed = false;
  private hello: ClientMsg | null = null;
  private tries = 0;
  /** decides after a drop whether to reconnect (false: the session is gone — stop and re-authenticate).
   *  Close code 4401 = the server ended the session (logout, password change, expiry). */
  shouldRetry: (code: number, reason: string) => Promise<boolean> = async () => true;
  constructor(private url: string) { this.open(); }
  private open() {
    this.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      this.onStatus('open');
      if (this.hello) ws.send(JSON.stringify(this.hello));
      for (const m of this.queue) ws.send(JSON.stringify(m));
      this.queue = [];
    };
    ws.onmessage = ev => { try { this.onMessage(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
    ws.onclose = ev => {
      this.onStatus('closed');
      if (this.closed) return;
      this.shouldRetry(ev.code, ev.reason).then(again => {
        if (!again || this.closed) { this.closed = true; return; }
        setTimeout(() => { if (!this.closed) this.open(); }, Math.min(10000, 1500 * 2 ** Math.min(3, this.tries++)));
      });
    };
  }
  send(m: ClientMsg) {
    if (m.t === 'hello') this.hello = m;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'hello') this.queue.push(m);
  }
  close() { this.closed = true; this.ws?.close(); }
}

/** Holds the latest authoritative world view and interpolation history for rendering. */
export class GameClient {
  readonly t: Transport;
  company = '';
  token = '';
  sp = false;
  state: WorldView | null = null;
  snapAt = 0;           // performance.now() when the latest snapshot arrived (battle tick estimate)
  speed = 1;
  /** time-buffered ship motion (see interp.ts) */
  clock = new NetClock();
  tracks = new Map<string, MotionTrack>();
  /** system the player is looking at (server sends ships of this system + own ships) */
  viewSys = '';
  /** diagnostics */
  net = { rtt: 0, snapBytes: 0, movCount: 0, server: null as Extract<ServerMsg, { t: 'stats' }> | null, lastMov: 0 };
  events: WorldEvent[] = [];
  players: { id: string; name: string; online: boolean; color: string }[] = [];
  onSnap: (() => void)[] = [];
  onEvents: ((e: WorldEvent[]) => void)[] = [];
  onWelcome: (() => void)[] = [];
  /** accounts: the server wants a sign-in / a PMC for this account / refused the PMC request */
  onAuthNeeded: (() => void) | null = null;
  onNeedPmc: (() => void) | null = null;
  onPmcErr: ((msg: string) => void) | null = null;
  onBattle: ((m: Extract<ServerMsg, { t: 'binit' | 'border' }>) => void) | null = null;
  private analyticsAcks = new Map<number, (m: Extract<ServerMsg, { t: 'analytics' }>) => void>();
  private acks = new Map<number, (e: string | null) => void>();
  private seq = 1;

  constructor(t: Transport) {
    this.t = t;
    t.onMessage = m => this.receive(m);
  }

  join(name: string, token?: string) { this.t.send({ t: 'hello', name, token }); }
  createPmc(name: string, legacy?: string) { this.t.send({ t: 'createPmc', name, legacy }); }

  private receive(m: ServerMsg) {
    switch (m.t) {
      case 'analytics': this.analyticsAcks.get(m.id)?.(m); this.analyticsAcks.delete(m.id); break;
      case 'welcome': this.company = m.company; this.token = m.token; this.sp = m.sp; this.onWelcome.forEach(f => f()); break;
      case 'snap': {
        this.state = m.state; this.speed = m.speed; this.snapAt = performance.now();
        if (this.t.kind === 'remote') this.net.snapBytes = JSON.stringify(m).length;
        // ships not in space (docked, in battle) are drawn from the snapshot directly
        for (const [id, tr] of this.tracks) { const s = m.state.ships[id]; if (!s || (s.state !== 'space' && s.state !== 'battle')) { tr.clear(); if (!s) this.tracks.delete(id); } }
        this.ingest(m.at, Object.values(m.state.ships).filter(s => s.state === 'space' || (s.state === 'battle' && s.hp > 0)).map(s => [s.id, s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.heading, s.warp ? (s.warp.phase === 'warp' ? 2 : 1) : 0]));
        this.onSnap.forEach(f => f());
        break;
      }
      case 'mov': {
        this.net.movCount++;
        this.ingest(m.at, m.s);
        // keep the snapshot's ship records roughly current for UI code that reads positions
        if (this.state) for (const r of m.s) { const s = this.state.ships[r[0] as string]; if (s) { s.pos = { x: r[1] as number, y: r[2] as number, z: r[3] as number }; s.vel = { x: r[4] as number, y: r[5] as number, z: r[6] as number }; s.heading = r[7] as number; } }
        break;
      }
      case 'stats': this.net.server = m; break;
      case 'pong': this.net.rtt = performance.now() - m.at; break;
      case 'events': this.events.push(...m.list); if (this.events.length > 300) this.events.splice(0, this.events.length - 300); this.onEvents.forEach(f => f(m.list)); break;
      case 'ack': this.acks.get(m.id)?.(m.err); this.acks.delete(m.id); break;
      case 'players': this.players = m.list; break;
      case 'binit': case 'border': this.onBattle?.(m); break;
      case 'error': console.warn('[server]', m.msg); break;
      case 'auth': this.onAuthNeeded?.(); break;
      case 'needPmc': this.onNeedPmc?.(); break;
      case 'pmcErr': this.onPmcErr?.(m.msg); break;
    }
  }

  analytics(scope: 'player' | 'admin', query: import('../server/analytics').AnalyticsQuery = {}): Promise<Extract<ServerMsg, { t: 'analytics' }>> {
    const id = this.seq++;
    return new Promise(resolve => {
      this.analyticsAcks.set(id, resolve); this.t.send({ t: 'analytics', id, scope, query });
      setTimeout(() => { if (this.analyticsAcks.delete(id)) resolve({ t: 'analytics', id, error: '통계 응답이 없습니다. 연결 상태를 확인하고 다시 시도하세요.' }); }, 10000);
    });
  }

  cmd(cmd: Cmd): Promise<string | null> {
    const id = this.seq++;
    return new Promise(res => { this.acks.set(id, res); this.t.send({ t: 'cmd', id, cmd }); setTimeout(() => { if (this.acks.has(id)) { this.acks.delete(id); res('응답 없음'); } }, 8000); });
  }
  battleOrder(eng: string, groupId: number, order: Order | null, opts: { retreatAt?: number; release?: boolean }): Promise<string | null> {
    const id = this.seq++;
    return new Promise(res => { this.acks.set(id, res); this.t.send({ t: 'border', id, eng, groupId, order, opts }); });
  }
  joinBattle(eng: string) { this.t.send({ t: 'bjoin', eng }); }
  setView(sys: string) { if (sys && sys !== this.viewSys) { this.viewSys = sys; this.t.send({ t: 'view', sys }); } }
  ping() { this.t.send({ t: 'ping', at: performance.now() }); }

  private ingest(at: number, rows: (string | number)[][]) {
    this.clock.onPacket(at, performance.now(), this.speed);
    for (const r of rows) {
      const id = r[0] as string;
      let tr = this.tracks.get(id);
      if (!tr) { tr = new MotionTrack(); this.tracks.set(id, tr); }
      tr.push({ t: at, x: r[1] as number, y: r[2] as number, z: r[3] as number, vx: r[4] as number, vy: r[5] as number, vz: r[6] as number, h: r[7] as number, warp: r[8] as number });
    }
  }
  setSpeed(v: number) { this.t.send({ t: 'speed', v }); }

  /** advance the render clock (once per frame) */
  frame(dtReal: number) { this.clock.frame(dtReal, performance.now()); }
}

export type { OrderRecord };
