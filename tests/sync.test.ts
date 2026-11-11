// Protocol 2 replication must give every client exactly the state the original full snapshots gave it.
// The oracle below is the per-client snapshot code of the production server before the change
// (src/server/core.ts sendSnap/snapBase at ff69c74), copied verbatim apart from being a free function.
import { describe, expect, it } from 'vitest';
import { GameServer, type Conn } from '../src/server/core';
import { applyPatch, applySync, legacyView, makePatch, SYNC_PROTO, type SyncMsg } from '../src/server/sync';
import type { ServerMsg, WorldView } from '../src/server/protocol';
import type { WorldState, Station } from '../src/world/types';
import { surveyStep, SCAN_NEED } from '../src/world/explore';

function originalView(st: WorldState, sysOf: (p: any) => { id: string } | undefined, c: { company?: string; view?: string }): WorldView {
  const snapBase = () => {
    const { events: _e, rng: _r, ships: _s, engagements, battleLog, ...rest } = st;
    void _e; void _r; void _s;
    const eng: Record<string, any> = {};
    for (const [id, e] of Object.entries(engagements)) { const { setup: _x, orders: _o, ...lite } = e; void _x; void _o; eng[id] = lite; }
    const log = (battleLog ?? []).map(({ setup: _x, orders: _o, ...lite }) => { void _x; void _o; return lite; });
    return { ...rest, engagements: eng, battleLog: log } as Omit<WorldView, 'ships'>;
  };
  const viewOf = () => {
    if (c.view) return c.view;
    const co = c.company ? st.companies[c.company] : null;
    const home = co ? st.stations[co.homeStation] : null;
    return (home && sysOf(home.pos)?.id) || 'astra';
  };
  const visibleShips = () => {
    const view = st.systems[viewOf()];
    const out: WorldView['ships'] = {};
    for (const s of Object.values(st.ships)) {
      if (s.owner === c.company || (view && Math.round((s.pos.x - view.origin.x) / 250000) === 0)) out[s.id] = s;
    }
    return out;
  };
  const base = snapBase();
  const companies = Object.fromEntries(Object.entries(base.companies).map(([id, co]) => [id, id === c.company || co.kind !== 'player' ? co : { id, name: co.name, kind: co.kind, color: co.color, online: co.online, createdAt: co.createdAt, homeStation: co.homeStation, credits: 0, rep: 0, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [] }]));
  const stations = Object.fromEntries(Object.entries(base.stations).map(([id, st]) => [id, { ...st, storage: { ...(c.company && st.storage[c.company] ? { [c.company]: st.storage[c.company] } : {}) }, ...(st.owner === c.company ? {} : { builds: undefined, orders: undefined, jobs: undefined, modules: st.modules.map(m => ({ kind: m.kind, progress: m.progress, built: m.built, slot: m.slot })) }) }]));
  const groups = Object.fromEntries(Object.entries(base.groups).map(([id, g]) => [id, g.owner === c.company || base.companies[g.owner]?.kind !== 'player' ? g : { ...g, op: { k: 'idle' as const }, status: '운항 중', commanderId: null, march: undefined }]));
  const ships = Object.fromEntries(Object.entries(visibleShips()).map(([id, s]) => [id, s.owner === c.company ? s : { ...s, cargo: {}, cargoWork: undefined, logisticsPool: undefined, logisticsJob: undefined, fitting: undefined, fit: undefined }]));
  return { ...base, companies, stations, ships, groups, logistics: base.logistics ? Object.fromEntries(Object.entries(base.logistics).filter(([, r]) => r.owner === c.company)) : undefined, logisticsJobs: base.logisticsJobs ? Object.fromEntries(Object.entries(base.logisticsJobs).filter(([, j]) => j.owner === c.company)) : undefined, procurementPlans: base.procurementPlans ? Object.fromEntries(Object.entries(base.procurementPlans).filter(([, p]) => p.owner === c.company)) : undefined, grants: undefined, conversions: undefined, sites: base.sites ? Object.fromEntries(Object.entries(base.sites).filter(([, s]) => !!c.company && s.seen.includes(c.company)).map(([id, s]) => [id, { ...s, scan: c.company && s.scan[c.company] !== undefined ? { [c.company]: s.scan[c.company] } : {}, seen: c.company ? [c.company] : [] }])) : undefined } as WorldView;
}

const wire = (x: unknown) => JSON.parse(JSON.stringify(x));
/** collection key order as a client iterates it */
const order = (v: any) => Object.fromEntries(Object.entries(v).filter(([, m]) => m && typeof m === 'object' && !Array.isArray(m)).map(([k, m]) => [k, Object.keys(m as object)]));

interface Client { conn: Conn; inbox: ServerMsg[]; state: WorldView | null; texts: number; bytes: number }
function connect(g: GameServer, id: string, proto: number | undefined): Client {
  const cl: Client = { conn: null!, inbox: [], state: null, texts: 0, bytes: 0 };
  cl.conn = {
    id, lastEvent: 0, battles: new Set(),
    send: m => { cl.inbox.push(wire(m)); if (m.t === 'snap') cl.state = wire(m.state); },
    sendText: s => { cl.texts++; cl.bytes += s.length; const m = JSON.parse(s); cl.inbox.push(m); if (m.t === 'sd') cl.state = applySync(cl.state, m as SyncMsg); else if (m.t === 'snap') cl.state = m.state; },
  };
  g.connect(cl.conn);
  g.handle(id, { t: 'hello', name: `PMC ${id}`, proto });
  return cl;
}

describe('protocol 2 state replication', () => {
  it('legacyView equals the original per-client snapshot', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 11);
    const a = connect(g, 'a', undefined), b = connect(g, 'b', undefined);
    for (let i = 0; i < 20 * 120; i++) g.step(0.05);
    for (const c of [a.conn, b.conn, { company: a.conn.company, view: 'nova' }]) {
      const sysOf = (p: any) => g.sim.sysOf(p);
      const sys = (c.view ?? '') || (g as any).viewOf(c);
      expect(wire(legacyView(g.sim.st, c, sys))).toEqual(wire(originalView(g.sim.st, sysOf, c)));
    }
  });

  it('a protocol 2 client always holds exactly what the original snapshot would have shown it', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1, movInterval: 0.2 }, 7);
    const sim = g.sim, st = sim.st;
    const A = connect(g, 'a', SYNC_PROTO), B = connect(g, 'b', SYNC_PROTO), L = connect(g, 'legacy', undefined), V = connect(g, 'viewer', SYNC_PROTO);
    expect(L.texts).toBe(0);
    const pa = A.conn.company!, pb = B.conn.company!;
    // fleets at work (commands go through the server like a client's)
    let seq = 1;
    for (const [cl, p] of [[A, pa], [B, pb]] as const) {
      const gs = Object.values(st.groups).filter(x => x.owner === p);
      const miners = gs.find(x => x.name === '제1 채굴반')!, guard = gs.find(x => x.name === '경비대')!;
      g.handle(cl.conn.id, { t: 'cmd', id: seq++, cmd: { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } });
      g.handle(cl.conn.id, { t: 'cmd', id: seq++, cmd: { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } } });
    }
    // A owns a private station with company logistics (owner-only collections) and has surveyed a site
    const co = st.companies[pa]; co.credits = 1e7;
    const astra = st.stations.astra; astra.storage[pa].ore = 400;
    const priv: Station = { ...structuredClone(astra), id: 'sync_priv', name: 'sync_priv', public: false, owner: pa, pos: { ...astra.pos, x: astra.pos.x + 500 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [pa]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) } as Station;
    st.stations[priv.id] = priv;
    const haulers = sim.newGroup(pa, '수송');
    const ships = [0, 1].map(() => { const s = sim.spawnShip(pa, 'hauler', 'std', haulers.id, astra.pos); (sim as any).dockShip(s, astra); return s; });
    expect(sim.command(pa, { c: 'poolShips', ships: ships.map(s => s.id), on: true })).toBeNull();
    for (let i = 0; i < 3; i++) expect(sim.command(pa, { c: 'poolCreate', request: { from: 'astra', to: priv.id, item: 'ore', kind: 'transfer', amount: 20, priority: 5, repeat: false } })).toBeNull();
    const site = Object.values(st.sites ?? {})[0];
    if (site) surveyStep(st, pa, site.system, SCAN_NEED[site.tier]);

    const views = Object.keys(st.systems);
    let checks = 0, sdMsgs = 0;
    const check = () => {
      for (const cl of [A, B, V, L]) {
        const want = wire(originalView(st, p => sim.sysOf(p), cl.conn));
        expect(wire(cl.state)).toEqual(want);
        expect(order(cl.state)).toEqual(order(want));
      }
      checks++;
    };
    const SECONDS = 1800;
    for (let i = 1; i <= SECONDS * 20; i++) {
      const before = A.inbox.length + V.inbox.length;
      g.step(0.05);
      if (i % 20 === 7) {
        // events that insert, delete and reorder entities while clients hold older state
        const t = i / 20;
        if (t % 97 < 1) g.handle('viewer', { t: 'view', sys: views[(t / 97 | 0) % views.length] });
        if (t % 211 < 1) { const victim = Object.values(st.ships).find(s => s.owner === pb && s.state === 'docked'); if (victim) { delete st.ships[victim.id]; for (const gr of Object.values(st.groups)) gr.shipIds = gr.shipIds.filter(x => x !== victim.id); } }
        if (t % 300 < 1) g.handle('a', { t: 'cmd', id: seq++, cmd: { c: 'poolCreate', request: { from: 'astra', to: priv.id, item: 'ore', kind: 'transfer', amount: 10, priority: 5, repeat: false } } });
      }
      if (A.inbox.length + V.inbox.length > before && i % 100 === 0) check();
    }
    sdMsgs = A.inbox.filter(m => m.t === 'sd').length;
    check();
    expect(checks).toBeGreaterThan(100);
    expect(sdMsgs).toBeGreaterThan(SECONDS * 0.9);
    // the world moved: ships were deleted, logistics jobs finished, engagements and views changed
    expect(Object.values(st.logisticsJobs ?? {}).some(j => j.state === 'complete')).toBe(true);
    // deltas are much smaller than full snapshots
    const fullBytes = JSON.stringify({ t: 'snap', at: 0, speed: 1, state: originalView(st, p => sim.sysOf(p), A.conn) }).length;
    expect(A.bytes / sdMsgs).toBeLessThan(fullBytes / 3);
  }, 300_000);

  it('keeps the server order of a collection when entities reappear', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 3);
    const A = connect(g, 'a', SYNC_PROTO);
    g.step(1.01);
    const st = g.sim.st;
    const ids = Object.keys(st.companies);
    // remove the first company, then restore it at its original place
    const first = st.companies[ids[0]];
    delete st.companies[ids[0]]; g.step(1.01);
    expect(Object.keys(A.state!.companies)).not.toContain(ids[0]);
    const rest = { ...st.companies }; for (const id of Object.keys(st.companies)) delete st.companies[id];
    st.companies[ids[0]] = first; Object.assign(st.companies, rest);
    g.step(1.01);
    expect(Object.keys(A.state!.companies)).toEqual(ids);
    expect(wire(A.state)).toEqual(wire(originalView(st, p => g.sim.sysOf(p), A.conn)));
  });

  it('an old client (no protocol in hello) still receives full snapshots', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 5);
    const L = connect(g, 'old', undefined);
    g.step(1.01);
    expect(L.inbox.some(m => m.t === 'snap')).toBe(true);
    expect(L.inbox.some(m => m.t === 'sd')).toBe(false);
  });

  it('resync sends the whole state again', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 5);
    const A = connect(g, 'a', SYNC_PROTO);
    g.step(1.01); g.step(1.01);
    const n = A.inbox.length;
    g.resync('a'); g.step(0.05);
    const m = A.inbox.slice(n).find(x => x.t === 'sd') as SyncMsg;
    expect(m.full).toBe(1);
    expect(wire(A.state)).toEqual(wire(originalView(g.sim.st, p => g.sim.sysOf(p), A.conn)));
  });

  it('field patches reproduce the target exactly, including key order (fuzz)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const val = (d: number): unknown => { const r = rnd(); if (d > 0 && r < 0.25) return obj(d - 1); if (r < 0.35) return [rnd(), 'x']; if (r < 0.5) return 'v' + Math.floor(rnd() * 4); if (r < 0.55) return null; if (r < 0.6) return undefined; return Math.floor(rnd() * 5) + (rnd() < 0.3 ? rnd() : 0); };
    const keys = ['a', 'b', 'c', 'd', 'e', '1', '20', 'storage', 'market'];
    const obj = (d: number): Record<string, unknown> => { const o: Record<string, unknown> = {}; for (const k of keys) if (rnd() < 0.6) o[k] = val(d); return o; };
    const mutate = (o: any, d: number) => {
      for (const k of keys) {
        const r = rnd();
        if (r < 0.1) delete o[k]; else if (r < 0.2) { delete o[k]; o[k] = val(d); } else if (r < 0.35) o[k] = val(d);
        else if (r < 0.5 && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) mutate(o[k], d - 1);
      }
    };
    const deepOrder = (x: any): unknown => x && typeof x === 'object' && !Array.isArray(x) ? Object.entries(x).map(([k, v]) => [k, deepOrder(v)]) : x;
    let patched = 0;
    for (let i = 0; i < 4000; i++) {
      const a = obj(2), from = JSON.stringify(a); const b = structuredClone(a); mutate(b, 2); const to = JSON.stringify(b);
      const p = makePatch(from, to);
      if (p === null) continue;
      patched++;
      const got = applyPatch(JSON.parse(from), JSON.parse(p));
      expect(JSON.stringify(got)).toBe(to);
      expect(deepOrder(got)).toEqual(deepOrder(JSON.parse(to)));
    }
    expect(patched).toBeGreaterThan(1000);
  });

  it('shared mov rows carry exactly the ships the per-client rows did', () => {
    const g = new GameServer(null, { singleplayer: false, snapInterval: 1 }, 9);
    const cls = ['a', 'b', 'c'].map(id => connect(g, id, SYNC_PROTO));
    g.handle('c', { t: 'view', sys: Object.keys(g.sim.st.systems)[1] });
    for (const co of Object.values(g.sim.st.companies)) if (co.kind === 'player') {
      const gs = Object.values(g.sim.st.groups).filter(x => x.owner === co.id);
      g.sim.command(co.id, { c: 'setOp', group: gs.find(x => x.name === '제1 채굴반')!.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
    }
    let compared = 0;
    for (let i = 0; i < 20 * 300; i++) {
      g.step(0.05);
      if (i % 37) continue;
      (g as any).movRows.clear(); (g as any).movSys.clear(); (g as any).movOwn = null;
      for (const cl of cls) {
        const shared = JSON.parse((g as any).movText(cl.conn)).s as unknown[][];
        const own = ((g as any).buildMov(cl.conn) as { s: unknown[][] }).s;
        const key = (r: unknown[]) => JSON.stringify(r);
        expect(shared.map(key).sort()).toEqual(own.map(key).sort());
        compared += own.length;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
