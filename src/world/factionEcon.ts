// P10 faction economies. Runs once a minute on worlds with `factions`.
//
// Demand comes from what a faction is actually doing, and is paid for with goods that physically
// exist in the stock of its own public markets (stock that players and NPC industry put there):
//   shipbuilding  — while fleet strength is below its doctrine target (losses in a conflict raise it)
//   construction  — while infrastructure is below its target, then a limited outpost expansion
//   upkeep        — every cycle, proportional to fleet strength; unpaid upkeep erodes strength
// Withdrawn goods are held in faction.stock until a whole unit can be built, so nothing disappears
// without becoming an asset, and nothing is created: strength/infra only grow from consumed goods.
// Rates are fixed per cycle, markets keep a reserve, so demand is bounded and saturates.
import type { Cargo, StarSystem, WorldState, WorldEvent } from './types';
import { addc, qty } from './types';
import { FACTIONS, REGION_RULES, factionStations, type Conflict, type FactionState } from './territory';
import { P10_FRONTS } from './worldgen-p10';
import { emit } from './observe';

export interface EconHost { rng: { chance(p: number): boolean; range(a: number, b: number): number }; ev(kind: WorldEvent['kind'], text: string, o?: Partial<WorldEvent>): void }

/** doctrine: target strength/infra and recipes by faction kind */
const DOCTRINE: Record<string, { strength: number; infra: number; ship: Cargo; shipRate: number }> = {
  government: { strength: 70, infra: 60, ship: { alloy: 40, structure: 6, electronics: 2 }, shipRate: .3 },
  commerce: { strength: 30, infra: 55, ship: { alloy: 30, structure: 4, machinery: 2 }, shipRate: .2 },
  industrial: { strength: 40, infra: 70, ship: { alloy: 40, structure: 8, machinery: 2 }, shipRate: .2 },
  mining: { strength: 30, infra: 45, ship: { alloy: 30, structure: 4, machinery: 3 }, shipRate: .2 },
  military: { strength: 100, infra: 60, ship: { alloy: 40, structure: 6, weapon_parts: 2, armor_plate: 2, electronics: 1 }, shipRate: .4 },
  pirate: { strength: 60, infra: 20, ship: { alloy: 30, weapon_parts: 1 }, shipRate: .2 },
};
export const INFRA_RECIPE: Cargo = { structure: 10, alloy: 20, machinery: 2 };
export const OUTPOST_RECIPE: Cargo = { structure: 60, alloy: 120, machinery: 10 };
const INFRA_RATE = .2;
/** markets keep this share of target stock for local use */
export const RESERVE = .3;

export const doctrineOf = (id: string) => DOCTRINE[FACTIONS[id]?.kind ?? 'commerce'];
export const upkeepOf = (f: FactionState): Cargo => {
  const kind = FACTIONS[f.id]?.kind;
  const u: Cargo = { chemicals: f.strength * .02 };
  if (kind === 'military' || kind === 'pirate') u.weapon_parts = f.strength * .002;
  if (kind === 'mining' || kind === 'industrial') u.machinery = f.infra * .006;
  return u;
};

/** draw up to `want` of an item from the faction's markets above their reserve; returns what was drawn */
function draw(w: WorldState, f: FactionState, item: string, want: number, reason: string): number {
  if (want <= 1e-9) return 0;
  let got = 0;
  for (const st of factionStations(w, f.id)) {
    const m = st.market?.[item]; if (!m) continue;
    const take = Math.min(want - got, Math.max(0, m.stock - m.target * RESERVE));
    if (take <= 1e-9) continue;
    m.stock -= take; got += take;
    emit(w, { kind: 'consume', amount: take, station: st.id, item, reason, ref: f.id });
    if (got >= want - 1e-9) break;
  }
  if (got > 0) addc(f.stock, item, got);
  return got;
}

/** how many whole units of a recipe the held stock covers */
const covers = (stock: Cargo, recipe: Cargo) => Math.min(...Object.entries(recipe).map(([k, n]) => qty(stock, k) / n));
function spend(stock: Cargo, recipe: Cargo, k: number) { for (const [i, n] of Object.entries(recipe)) addc(stock, i, -n * k); }

/** fill the held stock toward `k` units of a recipe, then convert whole units; returns units built */
function program(w: WorldState, f: FactionState, recipe: Cargo, k: number, reason: string): number {
  if (k <= 0) return 0;
  for (const [i, n] of Object.entries(recipe)) draw(w, f, i, Math.max(0, n * k - qty(f.stock, i)), reason);
  const units = Math.floor(Math.min(k, covers(f.stock, recipe)) * 1000) / 1000;
  if (units > 0) spend(f.stock, recipe, units);
  return units;
}

function conflictAt(w: WorldState, a: string, b: string): Conflict | undefined {
  return Object.values(w.conflicts ?? {}).find(c => !c.ended && ((c.a === a && c.b === b) || (c.a === b && c.b === a)));
}
export const atWar = (w: WorldState, fid: string | undefined) => !!fid && Object.values(w.conflicts ?? {}).some(c => !c.ended && (c.a === fid || c.b === fid));
/** production slowdown in a system whose faction is at war (supply convoys disrupted) */
export const warSupply = (w: WorldState, sys: StarSystem | undefined) => sys?.faction && atWar(w, sys.faction) ? (sys.region === 'border' ? .5 : .8) : 1;

function gatesOf(w: WorldState, edges: [string, string][]): string[] {
  const out: string[] = [];
  for (const [a, b] of edges) for (const [x, y] of [[a, b], [b, a]]) { const g = w.systems[x]?.gates.find(g => g.to === y); if (g) out.push(g.id); }
  return out;
}

function expand(host: EconHost, w: WorldState, f: FactionState) {
  const d = doctrineOf(f.id);
  if (FACTIONS[f.id]?.hostile || (f.claimed?.length ?? 0) >= 1 || f.infra < d.infra || f.strength < d.strength * .8) return;
  const own = Object.values(w.systems).filter(s => s.faction === f.id);
  const target = own.flatMap(s => s.gates.map(g => w.systems[g.to])).find(s => s && !s.faction && s.charted !== false && s.region !== 'uncharted');
  if (!target) return;
  const built = program(w, f, OUTPOST_RECIPE, 1, 'faction_outpost');
  if (built >= 1) {
    target.faction = f.id; target.region = 'border';
    (f.claimed ??= []).push(target.id);
    for (const st of Object.values(w.stations)) if (st.public && st.market && Math.abs(st.pos.x - target.origin.x) < target.radius + 20000) st.faction = f.id;
    host.ev('world', `${FACTIONS[f.id].name}이(가) ${target.name}에 전초기지를 세우고 영역에 편입했다 (${REGION_RULES.border.name}).`, { ref: target.id });
  }
}

/** one faction-economy cycle (dt seconds, normally 60) */
export function factionEconStep(host: EconHost, w: WorldState, dt = 60) {
  if (!w.factions) return;
  const k = dt / 60;
  for (const f of Object.values(w.factions)) {
    const d = doctrineOf(f.id);
    // upkeep first: a fleet that is not supplied degrades
    const up = upkeepOf(f);
    let short = 0;
    for (const [item, n] of Object.entries(up)) {
      const need = n * k;
      draw(w, f, item, Math.max(0, need - qty(f.stock, item)), 'faction_upkeep');
      const paid = Math.min(need, qty(f.stock, item));
      addc(f.stock, item, -paid);
      if (paid < need - 1e-9) short = Math.max(short, 1 - paid / need);
      f.made.upkeep += paid;
    }
    if (short > 0) f.strength = Math.max(0, f.strength * (1 - .001 * short * k));
    if (f.strength < d.strength) {
      const n = program(w, f, d.ship, Math.min(d.shipRate * k, d.strength - f.strength), 'faction_shipbuilding');
      if (n > 0) { f.strength += n; f.made.ships += n; }
    }
    if (f.infra < d.infra) {
      const n = program(w, f, INFRA_RECIPE, Math.min(INFRA_RATE * k, d.infra - f.infra), 'faction_construction');
      if (n > 0) { f.infra += n; f.made.infra += n; }
    } else expand(host, w, f);
  }
  conflicts(host, w, k);
}

/** optional hooks used by the v2 faction economy (factionEcon2.ts); absent = the v1 rules exactly */
export interface ConflictMods {
  /** multiplier on the losses `victim` takes from `attacker` (supply/readiness) */
  lossMul?(victim: FactionState, attacker: FactionState): number;
  /** strength actually lost by a side this cycle */
  onLoss?(f: FactionState, lost: number, c: Conflict): void;
  onEnd?(c: Conflict): void;
}

export function conflicts(host: EconHost, w: WorldState, k: number, mods?: ConflictMods) {
  const F = w.factions!; const C = (w.conflicts ??= {});
  for (const c of Object.values(C)) {
    if (c.ended) continue;
    const A = F[c.a], B = F[c.b];
    // attrition: each side loses a share of the other's strength (deterministic world RNG)
    const la = Math.min(A.strength, (.4 + B.strength * .012) * host.rng.range(.7, 1.3) * k * (mods?.lossMul?.(A, B) ?? 1));
    const lb = Math.min(B.strength, (.4 + A.strength * .012) * host.rng.range(.7, 1.3) * k * (mods?.lossMul?.(B, A) ?? 1));
    A.strength -= la; B.strength -= lb;
    if (mods?.onLoss) { mods.onLoss(A, la, c); mods.onLoss(B, lb, c); }
    c.lost[c.a] = (c.lost[c.a] ?? 0) + la; c.lost[c.b] = (c.lost[c.b] ?? 0) + lb;
    for (const s of Object.values(w.systems)) if ((s.faction === c.a || s.faction === c.b) && s.region === 'border') s.heat = Math.min(100, s.heat + 2 * k);
    const age = w.time - c.since;
    if (age > 2 * 3600 || A.strength < 10 || B.strength < 10 || (age > 1800 && host.rng.chance(.02 * k))) {
      c.ended = w.time;
      mods?.onEnd?.(c);
      A.rel[c.b] = Math.min(100, (A.rel[c.b] ?? 0) + 15); B.rel[c.a] = Math.min(100, (B.rel[c.a] ?? 0) + 15);
      host.ev('world', `${FACTIONS[c.a].name}–${FACTIONS[c.b].name} 국경 분쟁 종료 — 봉쇄 해제 (손실 ${Math.round(c.lost[c.a])} / ${Math.round(c.lost[c.b])})`, { ref: c.id });
    }
  }
  // drop old records (keep the latest 20)
  const ended = Object.values(C).filter(c => c.ended).sort((a, b) => b.ended! - a.ended!);
  for (const c of ended.slice(20)) delete C[c.id];
  for (const front of P10_FRONTS) {
    if (conflictAt(w, front.a, front.b)) continue;
    const A = F[front.a], B = F[front.b]; if (!A || !B) continue;
    const rel = Math.min(A.rel[front.b] ?? 0, B.rel[front.a] ?? 0);
    // relations slowly recover toward their hostile baseline; tension builds while both are strong
    A.rel[front.b] = Math.max(-100, (A.rel[front.b] ?? 0) - .15 * k); B.rel[front.a] = Math.max(-100, (B.rel[front.a] ?? 0) - .15 * k);
    if (rel > -60 || A.strength < 20 || B.strength < 20) continue;
    if (!host.rng.chance(.006 * k)) continue;
    startConflict(host, w, front.a, front.b, front.edges);
  }
}

export function startConflict(host: EconHost, w: WorldState, a: string, b: string, edges: [string, string][]): Conflict {
  const id = `war_${a}_${b}_${Math.floor(w.time)}`;
  const c: Conflict = { id, a, b, gates: gatesOf(w, edges), since: w.time, lost: {} };
  (w.conflicts ??= {})[id] = c;
  const names = edges.map(([x, y]) => `${w.systems[x]?.name}–${w.systems[y]?.name}`).join(', ');
  host.ev('warn', `${FACTIONS[a].name}–${FACTIONS[b].name} 국경 분쟁 발발 — ${names} 관문 봉쇄. 우회 항로를 이용하세요.`, { ref: id });
  return c;
}
