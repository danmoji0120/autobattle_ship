// P14.0 reputation simulation (game time, not real time): six scenario companies act in ONE real P10 world for 24 game
// hours, through the real rules:
//   - market sales/purchases: the real `sell` / `buy` commands (prices walk, station budgets bound sales)
//   - contracts: contracts the world itself posts (sim.contracts()), completed through the real completeContract path
//     (cargo travel is not simulated: the cadence below stands for it)
//   - pirate battles: real pirate bands present in the world are removed and settled with the real rule
//     (repV: repBattle — the function the battle settlement calls; legacy: the legacy settlement formula)
//   - lairs: the real destroyLair path (contract completion, influence, reconstruction, reputation)
//   - crimes: repOffense (the function salvage / piracy / black market / law call) — legacy: the legacy formula
// The cadence (how many of each per game hour) is an assumption about a mid-game company with one fleet, written in
// SCEN below; it is the same for both rule sets, so the comparison is fair.
//   npx vite-node scripts/rep/p14-sim.ts <p14|legacy> <out.json> [hours=24]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import type { WorldState, Company } from '../../src/world/types';
import { repBattle, repOffense, repBlackMarket, bandOf, CREDIT } from '../../src/world/reputation';
import { bumpStanding } from '../../src/world/territory';
import { shipValue } from '../../src/world/data';

const mode = process.argv[2] === 'legacy' ? 'legacy' : 'p14';
const out = process.argv[3] ?? `p14-sim-${mode}.json`;
const HOURS = Number(process.argv[4] ?? 24);
const sim = WorldSim.create(14, { layout: 'p10', ...(mode === 'p14' ? { rep: 'p14' as const } : {}) });
const w: WorldState = sim.st;
const S = sim as any;

type Scen = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
const NAME: Record<Scen, string> = { A: '산업형', B: '전투형', C: '물류형', D: '세력 집중형(철갑)', E: '해적 친화형', F: '악용 시도' };
const co: Record<Scen, string> = {} as any;
for (const k of Object.keys(NAME) as Scen[]) { co[k] = sim.addPlayer(`${k} ${NAME[k]}`); w.companies[co[k]].credits = 5e6; }
const C = (k: Scen) => w.companies[co[k]];
const facOfSt = (id: string) => w.stations[id]?.faction;
const stationsOf = (fs: string[]) => Object.values(w.stations).filter(s => s.public && s.market && s.faction && fs.includes(s.faction)).map(s => s.id);
const sysOfFaction = (fs: string[]) => Object.values(w.systems).filter(s => s.faction && fs.includes(s.faction)).map(s => s.id);
const count: Record<Scen, Record<string, number>> = { A: {}, B: {}, C: {}, D: {}, E: {}, F: {} };
const inc = (k: Scen, what: string, n = 1) => { count[k][what] = (count[k][what] ?? 0) + n; };
const rng = (() => { let s = 99; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();

// ── activities ─────────────────────────────────────────────────────────────────────────────
function sell(k: Scen, station: string, res: string, value: number): number {
  const st = w.stations[station]; if (!st?.market?.[res]) return 0;
  const unit = Math.max(1, S.price(st, res, 'sell'));
  const n = Math.max(1, Math.floor(value / unit));
  ((st.storage[co[k]] ??= {} as any) as any)[res] = ((st.storage[co[k]] as any)[res] ?? 0) + n;
  const before = C(k).credits;
  const err = sim.command(co[k], { c: 'sell', station, res, amount: n } as any);
  if (err) return 0;
  inc(k, 'sales'); inc(k, 'sold_cr', C(k).credits - before);
  return C(k).credits - before;
}
function buy(k: Scen, station: string, res: string, value: number): number {
  const st = w.stations[station]; if (!st?.market?.[res]) return 0;
  const unit = Math.max(1, S.price(st, res, 'buy'));
  const n = Math.max(1, Math.min(Math.floor(st.market[res].stock), Math.floor(value / unit)));
  (S.leaseFor ? 0 : 0);
  (C(k).leases ??= {})[station] = Math.max(C(k).leases![station] ?? 0, 400);
  const before = C(k).credits;
  const err = sim.command(co[k], { c: 'buy', station, res, amount: n } as any);
  if (err) { inc(k, 'buy_refused'); return 0; }
  inc(k, 'buys'); return before - C(k).credits;
}
function contract(k: Scen, stations: string[], kinds: string[]): boolean {
  const kk = Object.values(w.contracts).find(x => !x.done && !x.takenBy && kinds.includes(x.kind) && stations.includes(x.stationId) && x.kind !== 'lair');
  if (!kk) return false;
  kk.takenBy = co[k];
  if (kk.kind === 'bounty' && kk.target) { const g = w.groups[kk.target]; while (g && g.shipIds.length) battle(k, g.id); }
  if (!kk.done) { S.completeContract(kk); inc(k, `contract_${kk.kind}`); }
  return true;
}
const legacyBattle = (c: Company, sys: string | undefined, n: number) => {
  c.rep += n;
  if (w.factions && n) { const f = w.systems[sys ?? '']?.faction; if (f && f !== 'pirates') bumpStanding(w, c.id, f, n * .5); bumpStanding(w, c.id, 'pirates', -n); }
  c.stats.kills += n;
};
/** destroy a real pirate band (its ships leave the world) and settle the battle under this world's rules */
function battle(k: Scen, groupId: string, costOverride?: number[]): boolean {
  const g = w.groups[groupId]; if (!g || g.owner !== 'pirates' || !g.shipIds.length) return false;
  const sys = S.sysOf(w.ships[g.shipIds[0]]?.pos ?? { x: 0, y: 0, z: 0 })?.id;
  // one fleet engages part of a band (at most 4 hulls per battle); the rest of the band stays in the world
  const hit = g.shipIds.slice(0, costOverride ? costOverride.length : 4);
  const costs = costOverride ?? hit.map(id => shipValue(w.ships[id]?.classId ?? 'corvette'));
  for (const id of hit) delete w.ships[id];
  g.shipIds = g.shipIds.filter(id => !hit.includes(id));
  const eid = `sim-${k}-${groupId}-${Math.round(w.time)}`;
  if (mode === 'p14') repBattle(w, co[k], eid, w.systems[sys ?? ''], costs, 1); else legacyBattle(C(k), sys, costs.length);
  inc(k, 'battles'); inc(k, 'pirates_killed', costs.length);
  // bounty contracts on this band, taken by this company
  if (!g.shipIds.length) for (const kk of Object.values(w.contracts)) if (!kk.done && kk.kind === 'bounty' && kk.target === groupId && kk.takenBy === co[k]) { S.completeContract(kk); inc(k, 'contract_bounty'); }
  return true;
}
function pirateBand(sysIds: string[]): string | undefined {
  const gs = Object.values(w.groups).filter(g => g.owner === 'pirates' && g.shipIds.length && w.ships[g.shipIds[0]] && sysIds.includes(S.sysOf(w.ships[g.shipIds[0]].pos)?.id));
  return gs.length ? gs[Math.floor(rng() * gs.length)].id : undefined;
}
function lair(k: Scen, sysIds: string[], minTier = 1): boolean {
  const l = Object.values(w.lairs).find(x => x.alive && (x.tier ?? 2) >= minTier && sysIds.includes(S.sysOf(x.pos)?.id));
  if (!l) return false;
  const kk = Object.values(w.contracts).find(x => !x.done && x.kind === 'lair' && x.target === l.id);
  if (kk && !kk.takenBy) kk.takenBy = co[k];
  const e = { id: `simlair-${l.id}-${Math.round(w.time)}`, sides: [[co[k]], ['pirates']], dmg: { [co[k]]: { pirates: 1000 } }, sys: S.sysOf(l.pos)?.id, pos: l.pos } as any;
  S.destroyLair(l, e);
  if (mode === 'legacy') { /* destroyLair already applied +15 on the legacy branch */ }
  inc(k, `lair_t${l.tier ?? 2}`);
  return true;
}
function crime(k: Scen, kind: 'extortion' | 'strike' | 'resist', sys: string, value: number) {
  const f = w.systems[sys]?.faction;
  if (mode === 'p14') repOffense(w, co[k], f, kind, value, `sim:${kind}:${k}:${Math.round(w.time)}`, kind);
  else if (kind === 'extortion') { // legacy (piracy.ts): rep −value×1/2000×sec/100, standing −value/1000×sec/100
    const sec = w.systems[sys]?.security ?? 50; C(k).rep = Math.max(0, C(k).rep - value / 2000 * sec / 100);
    if (w.factions && f && f !== 'pirates') bumpStanding(w, co[k], f, -value / 1000 * sec / 100);
  } // legacy: strike / resist have no reputation effect at all
  inc(k, `crime_${kind}`);
}

// ── scenario cadence (per game hour) ───────────────────────────────────────────────────────
const IND = stationsOf(['ceres', 'miners']), GUILD = stationsOf(['guild']), IRON = stationsOf(['iron']), UNION = stationsOf(['union']);
const IRONSYS = sysOfFaction(['iron']), WARSYS = sysOfFaction(['union', 'iron']), UNIONSYS = sysOfFaction(['union']);
const IRON_NEAR = [...IRONSYS, ...Object.values(w.systems).filter(s => s.region === 'border' || s.region === 'lawless').map(s => s.id)];
const ALL = Object.keys(w.systems);
const GOODS_IND = ['alloy', 'structure', 'machinery', 'metal'], GOODS_ALL = ['alloy', 'electronics', 'machinery', 'chemicals', 'structure'];
const GOODS_IRON = ['armor_plate', 'weapon_parts', 'structure'];

/** activities of one 10-minute slot: an hourly count n is spread over the six slots of the hour */
function slotOf(k: Scen, h: number, slot: number) {
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const n = (perHour: number) => Math.floor((slot + 1) * perHour / 6) - Math.floor(slot * perHour / 6);
  const rep = (perHour: number, f: () => void) => { for (let i = 0; i < n(perHour); i++) f(); };
  const band = (pref: string[]) => pirateBand(pref.filter(x => w.systems[x]?.faction && w.systems[x].faction !== 'pirates')) ?? pirateBand(pref) ?? pirateBand(ALL);
  switch (k) {
    case 'A': rep(8, () => sell('A', pick(IND), pick(GOODS_IND), 7500)); rep(2, () => contract('A', IND, ['delivery'])); break;
    case 'B': rep(3, () => { const g = band(WARSYS); if (g) battle('B', g); }); rep(1, () => contract('B', [...UNION, ...IRON], ['bounty'])); if (h % 3 === 2 && slot === 3) lair('B', ALL); break;
    case 'C': rep(12, () => sell('C', pick(GUILD), pick(GOODS_ALL), 8000)); rep(3, () => contract('C', GUILD, ['delivery'])); break;
    case 'D': rep(2, () => contract('D', IRON, ['delivery', 'bounty'])); rep(4, () => sell('D', pick(IRON), pick(GOODS_IRON), 6000));
      rep(2, () => { const g = band(IRON_NEAR); if (g) battle('D', g); }); if (h % 4 === 3 && slot === 3) lair('D', IRON_NEAR, 3);
      if (h === 12 && slot === 0) { crime('D', 'strike', IRONSYS[0], 0); crime('D', 'resist', IRONSYS[0], 0); } break;
    case 'E': rep(6, () => sell('E', 'rustport', pick(['weapon_parts', 'chemicals', 'electronics', 'alloy']), 7000)); rep(6, () => { if (mode === 'p14') repBlackMarket(w, co.E, 5000); inc('E', 'bm_cr', 5000); });
      rep(2, () => contract('E', ['rustport'], ['delivery'])); if (h % 2 === 1 && slot === 2) crime('E', 'extortion', UNIONSYS[0], 25000); break;
    case 'F': // exploits: buy/sell loop at one market, weak-pirate farming (one corvette per "battle")
      rep(20, () => { buy('F', 'astra', 'electronics', 20000); sell('F', 'astra', 'electronics', 20000); });
      rep(12, () => { const g = pirateBand(ALL); if (g) battle('F', g, [45]); });
      break;
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────────────
const snaps: any[] = [];
const MARK = [1, 4, 8, 16, 24].filter(x => x <= HOURS);
const reach: Record<string, Record<string, number>> = {};
const snap = (h: number) => {
  const row: any = { h };
  for (const k of Object.keys(NAME) as Scen[]) {
    const c = C(k);
    row[k] = { credit: +c.rep.toFixed(3), standing: Object.fromEntries(Object.entries(c.standing ?? {}).map(([f, v]) => [f, +v.toFixed(3)])), counts: { ...count[k] } };
  }
  snaps.push(row);
};
const track = () => {
  for (const k of Object.keys(NAME) as Scen[]) {
    const c = C(k);
    for (const [s, v] of [[CREDIT, c.rep] as [string, number], ...Object.entries(c.standing ?? {})]) for (const t of [10, 25, 40, 60, 80]) {
      const key = `${k}:${s}:${t}`;
      if (v >= t && reach[key] === undefined) (reach[k] ??= {})[`${s}≥${t}`] ??= +(w.time / 3600).toFixed(2), reach[key] = 1 as any;
    }
  }
};
const t0 = Date.now();
sim.update(1);
const start = w.time;
for (let h = 0; h < HOURS; h++) {
  for (let slot = 0; slot < 6; slot++) {
    for (const k of Object.keys(NAME) as Scen[]) slotOf(k, h, slot);
    for (let s = 0; s < 600; s++) sim.update(1);
    track();
  }
  track();
  if (MARK.includes(h + 1)) { snap(h + 1); console.error(`[${mode}] ${h + 1}h (${Math.round((Date.now() - t0) / 1000)}s)`); }
}
const result = {
  mode, hours: HOURS, gameStart: start, gameEnd: w.time, realSeconds: Math.round((Date.now() - t0) / 1000),
  scenarios: NAME, snaps, reach: Object.fromEntries(Object.entries(reach).filter(([k]) => !k.includes(':'))),
  bands: Object.fromEntries((Object.keys(NAME) as Scen[]).map(k => [k, { credit: bandOf(C(k).rep).name, ...Object.fromEntries(Object.entries(C(k).standing ?? {}).map(([f, v]) => [f, bandOf(v).name])) }])),
  log: mode === 'p14' ? Object.fromEntries((Object.keys(NAME) as Scen[]).map(k => [k, (C(k).repx?.log ?? []).slice(-12)])) : undefined,
};
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ mode, end: snaps[snaps.length - 1], reach: result.reach }, null, 0).slice(0, 4000));
process.exit(0);
