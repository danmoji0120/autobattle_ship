// P1 world-simulation audit: shared harness. Analysis tooling only — it drives the real WorldSim headlessly
// on fresh, isolated worlds (WorldSim.create, the same path a new server world takes) and never touches
// a save file, a database or a server. See docs/P1_WORLD_SIMULATION_AUDIT.md.
import { WorldSim } from '../../src/world/sim';
import { priceOf } from '../../src/world/market';
import type { Engagement, WorldState } from '../../src/world/types';

export interface Sample {
  t: number;                                   // game seconds
  ships: Record<string, number>;               // by owner
  groups: Record<string, number>;
  sys: Record<string, { eff: number; heat: number; inf: [number, number, number]; union: number; pirates: number; guild: number; stats: [number, number, number, number, number] }>;
  lairs: number;
  /** per public station: [stock/target, sell price] for every good, funds fraction */
  mkt: Record<string, { funds: number; g: Record<string, [number, number]> }>;
  fieldFill: number;                            // sum(amount)/sum(max) over non-salvage fields
  wrecks: number;                               // live salvage (battle wreck) fields
  contractsOpen: Record<string, number>;
  playerCredits?: number;
}
export interface BattleRec { t0: number; t1: number; sys?: string; sides: [string[], string[]]; winner?: number; n?: number; lair?: string; summary?: string; live: boolean }
export interface EventRec { t: number; kind: string; text: string; company?: string }

export function sample(sim: WorldSim, player?: string): Sample {
  const st = sim.st;
  const ships: Record<string, number> = {}, groups: Record<string, number> = {};
  const perSys: Record<string, Record<string, number>> = {};
  for (const s of Object.values(st.ships)) {
    const o = st.companies[s.owner]?.kind === 'player' ? 'player' : s.owner;
    ships[o] = (ships[o] ?? 0) + 1;
    const id = sim.sysOf(s.pos)?.id; if (!id) continue;
    (perSys[id] ??= {})[o] = (perSys[id][o] ?? 0) + 1;
  }
  for (const g of Object.values(st.groups)) if (g.shipIds.length) { const o = st.companies[g.owner]?.kind === 'player' ? 'player' : g.owner; groups[o] = (groups[o] ?? 0) + 1; }
  const sys: Sample['sys'] = {};
  for (const s of Object.values(st.systems)) {
    const p = perSys[s.id] ?? {};
    sys[s.id] = { eff: +sim.effSec(s).toFixed(1), heat: +s.heat.toFixed(1), inf: [+(s.inf?.union ?? 0).toFixed(1), +(s.inf?.pirates ?? 0).toFixed(1), +(s.inf?.guild ?? 0).toFixed(1)],
      union: p.union ?? 0, pirates: p.pirates ?? 0, guild: p.guild ?? 0, stats: [s.stats.pirateKills, s.stats.unionLosses, s.stats.civLosses, s.stats.raids, s.stats.bands] };
  }
  const mkt: Sample['mkt'] = {};
  for (const x of Object.values(st.stations)) {
    if (!x.public || !x.market) continue;
    const g: Record<string, [number, number]> = {};
    for (const [k, m] of Object.entries(x.market)) if (!k.startsWith('bp:')) g[k] = [+(m.stock / m.target).toFixed(3), priceOf(m, 'sell', true)];
    mkt[x.id] = { funds: x.fundsMax ? +((x.funds ?? 0) / x.fundsMax).toFixed(3) : 1, g };
  }
  let a = 0, m = 0, wrecks = 0;
  for (const f of Object.values(st.fields)) { if (f.salvage) { if (f.amount > 0) wrecks++; continue; } a += f.amount; m += f.max; }
  const contractsOpen: Record<string, number> = {};
  for (const k of Object.values(st.contracts)) if (!k.done) contractsOpen[k.kind] = (contractsOpen[k.kind] ?? 0) + 1;
  return { t: st.time, ships, groups, sys, lairs: Object.values(st.lairs).filter(l => l.alive).length, mkt, fieldFill: m ? +(a / m).toFixed(3) : 0, wrecks, contractsOpen,
    ...(player ? { playerCredits: Math.round(st.companies[player]?.credits ?? 0) } : {}) };
}

/** run a world for `hours`, sampling every `every` game seconds; `onStep` may intervene */
export function run(sim: WorldSim, hours: number, every: number, opts: { player?: string; onStep?: (sim: WorldSim) => void; dt?: number } = {}) {
  const samples: Sample[] = [], battles: BattleRec[] = [], events: EventRec[] = [];
  const prev = sim.onBattleEnd;
  sim.onBattleEnd = (e: Engagement) => { battles.push({ t0: e.start, t1: sim.st.time, sys: e.sys, sides: e.sides, winner: e.winner, n: e.n, lair: e.lairId, summary: e.summary, live: e.live }); prev?.(e); };
  let seen = sim.st.eventSeq;
  const dt = opts.dt ?? 0.25, T = sim.st.time + hours * 3600;
  let next = sim.st.time;
  const wall0 = performance.now();
  while (sim.st.time < T) {
    if (sim.st.time >= next) { samples.push(sample(sim, opts.player)); next += every; }
    sim.update(dt);
    opts.onStep?.(sim);
    for (const e of sim.st.events) if (e.id >= seen && (e.kind === 'world' || e.kind === 'warn' || e.kind === 'battle' || e.kind === 'money' || e.kind === 'milestone')) events.push({ t: Math.round(e.t), kind: e.kind, text: e.text, company: e.company });
    seen = sim.st.eventSeq;
  }
  samples.push(sample(sim, opts.player));
  return { samples, battles, events, wallS: (performance.now() - wall0) / 1000 };
}

// --------------------------------------------------------------- analysis helpers
export const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
export const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
export const r1 = (x: number) => Math.round(x * 10) / 10;
export const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** classify each market good over a window of samples: stays at target, shortage, glut, moving */
export function marketProfile(samples: Sample[]) {
  const last = samples.at(-1)!;
  const rows: { st: string; good: string; ratio0: number; ratioEnd: number; min: number; max: number; sdLateHalf: number; price0: number; priceEnd: number }[] = [];
  for (const [stId, m] of Object.entries(last.mkt)) for (const good of Object.keys(m.g)) {
    const series = samples.map(s => s.mkt[stId]?.g[good]?.[0]).filter((x): x is number => x !== undefined);
    const prices = samples.map(s => s.mkt[stId]?.g[good]?.[1]).filter((x): x is number => x !== undefined);
    const late = series.slice(Math.floor(series.length / 2));
    rows.push({ st: stId, good, ratio0: series[0], ratioEnd: series.at(-1)!, min: Math.min(...series), max: Math.max(...series), sdLateHalf: r3(sd(late)), price0: prices[0], priceEnd: prices.at(-1)! });
  }
  return rows;
}

export function summarizeBattles(battles: BattleRec[], st: WorldState) {
  const bySys: Record<string, { n: number; unionWin: number; unionLoss: number; guild: number; lair: number; player: number }> = {};
  for (const b of battles) {
    const r = (bySys[b.sys ?? '?'] ??= { n: 0, unionWin: 0, unionLoss: 0, guild: 0, lair: 0, player: 0 });
    r.n++;
    if (b.sides[0].includes('union')) { if (b.winner === 0) r.unionWin++; else r.unionLoss++; }
    if (b.sides[0].includes('guild')) r.guild++;
    if (b.lair) r.lair++;
    if (b.sides[0].some(c => st.companies[c]?.kind === 'player')) r.player++;
  }
  return bySys;
}
