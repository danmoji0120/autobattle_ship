// Shared fixture for P13.1 convoy battles (p131-convoy-trials.ts, tests/p131-p11-outcome.test.ts).
import { WorldSim } from '../../src/world/sim';
import type { V } from '../../src/world/types';

export interface Layout { id: string; note: string; attack: string[]; escort: string[]; dx: number; dz: number; order: 'attack' | 'intercept' }
export const LAYOUTS: Record<string, Layout> = {
  // the original real-server layout: A 1 km behind the convoy
  base: { id: 'base', note: '기존 실서버 배치 — A 구축함 6·호위함 1, B 수송선+구축함 2+초계함 1, 1km 거리', attack: ['destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer', 'destroyer', 'frigate'], escort: ['destroyer', 'destroyer', 'corvette'], dx: -1000, dz: 0, order: 'attack' },
  // fast attackers: corvettes keep up with a fleeing hauler
  fast: { id: 'fast', note: 'A 초계함 6·구축함 2 (빠른 추격), 1km', attack: ['corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'destroyer'], escort: ['destroyer', 'destroyer', 'corvette'], dx: -1000, dz: 0, order: 'attack' },
  // light escort: one corvette
  light: { id: 'light', note: 'A 초계함 4·구축함 2, B 호위 초계함 1, 1km', attack: ['corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'destroyer'], escort: ['corvette'], dx: -1000, dz: 0, order: 'attack' },
  // contact closer: the attackers start on top of the convoy
  close: { id: 'close', note: 'A 초계함 6·구축함 2, B 구축함 2+초계함 1, 300m', attack: ['corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'corvette', 'destroyer', 'destroyer'], escort: ['destroyer', 'destroyer', 'corvette'], dx: -300, dz: 0, order: 'attack' },
};

export interface Trial { layout: string; seed: number; haulerSunk: boolean; haulerFate: string; engagements: { id: string; t0: number; t1: number; reason: string; sides: { co: string; status: string; alive: number; lost: number; escaped: number }[]; summary?: string; strategicLosses?: number[] }[]; cargoInWrecks: Record<string, number>; cargoLost: Record<string, number> }

export function convoyWorld(seed: number, L: Layout) {
  const sim = WorldSim.create(seed, { salvage: 'p131' });
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  const A = sim.addPlayer('A 군사 PMC'), B = sim.addPlayer('B 운송 PMC'), C = sim.addPlayer('C 인양 PMC');
  for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
  for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
  const ast = sim.st.stations.astra, at = (dx: number, dz: number): V => ({ x: ast.pos.x + dx, y: 0, z: ast.pos.z + dz });
  const fleet = (o: string, name: string, pos: V, comp: string[]) => { const g = sim.newGroup(o, name); g.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g; };
  const conv = fleet(B, 'B 호송대', at(4000, 2500), ['hauler', ...L.escort]);
  const hauler = sim.st.ships[conv.shipIds[0]]; hauler.cargo.metal = 300; hauler.cargo.electronics = 120; hauler.logisticsExcluded = true;
  const war = fleet(A, 'A 전투단', at(4000 + L.dx, 2500 + L.dz), L.attack);
  const cg = fleet(C, 'C 인양대', at(1500, -500), ['miner']);
  for (const co of [A, B, C]) sim.st.companies[co].credits = 1e6;
  return { sim, A, B, C, conv, war, cg, hauler: hauler.id };
}

export function runTrial(seed: number, L: Layout, maxT = 900): Trial {
  const { sim, A, conv, war, hauler } = convoyWorld(seed, L);
  const flow: Record<string, number> = {};
  const err = sim.command(A, { c: 'setOp', group: war.id, op: { k: L.order, group: conv.id } } as any);
  if (err) throw Error(err);
  const battles: Map<string, any> = (sim as any).battles;
  const seenW = new Map<string, any>();
  const out: Trial = { layout: L.id, seed, haulerSunk: false, haulerFate: 'alive', engagements: [], cargoInWrecks: {}, cargoLost: {} };
  for (let t = 0; t < maxT; t += 0.5) {
    sim.update(0.5);
    for (const [id, w] of battles) seenW.set(id, w);
    if (!sim.st.ships[hauler]) { out.haulerSunk = true; out.haulerFate = 'sunk'; }
    const open = Object.values(sim.st.engagements).some(e => !e.done);
    if (out.haulerSunk && !open) break;
    if (t > 200 && !open && Object.values(sim.st.engagements).length) break;
  }
  if (!out.haulerSunk) { const h = sim.st.ships[hauler]; out.haulerFate = h ? `alive (${h.state}, hp ${h.hp.toFixed(2)})` : 'gone'; }
  for (const e of Object.values(sim.st.engagements)) {
    const w = seenW.get(e.id);
    const log = (sim.st.battleLog ?? []).find(x => x.id === e.id);
    out.engagements.push({ id: e.id, t0: e.start, t1: log?.end ?? -1, reason: w?.outcome?.reason ?? '(running)',
      sides: (w?.outcome?.sides ?? []).map((s: any) => ({ co: e.sides[s.side]?.[0], status: s.status, alive: s.alive, lost: s.lost, escaped: s.escaped })),
      summary: e.summary, strategicLosses: log?.losses });
  }
  for (const wk of Object.values(sim.st.wrecks ?? {})) for (const l of wk.lots) if (l.k === 'cargo' && wk.sources.some(s => s.ship === hauler)) out.cargoInWrecks[l.item] = (out.cargoInWrecks[l.item] ?? 0) + l.n;
  return out;
}

