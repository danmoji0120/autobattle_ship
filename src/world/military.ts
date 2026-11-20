// B-2 PMC military business: contracts a security company or a veteran outfit can live on without miners or haulers.
//
//   patrol  — fly a real route through a system for a duty time (in space, in the system, on the route)
//   escort  — take a real moving guild trader (or another company's cargo group) to its next station
//   defend  — keep combat ships on station at a station / gate for a duty time (base pay for vigilance,
//             a separate bonus for attacks repelled)
//   hunt    — destroy a real pirate band or a small lair
//   strike  — high-risk operations: big war bands, large lairs, clearing a pirate lane (pirate value destroyed in a system)
//
// Money: every military contract is paid from the issuer's real budget. A station's reward (base + full bonus) is
// reserved from its funds at acceptance (escrow); another company's escort reward is reserved from the poster's
// credits when it posts. Completion pays base + the earned part of the bonus; the rest goes back to whoever reserved
// it. Cancellation, expiry and failure return the reservation exactly. No money is created here — the pirate bounty
// of a battle (P11 settlement, unchanged) is a separate, booked flow.
// See docs/B2_MILITARY_BUSINESS.md.
import type { WorldSim } from './sim';
import type { Company, Contract, Engagement, Op, StarSystem, Station, V, WGroup, WorldState, WShip } from './types';
import { econOf, shipWorth } from './hullops';
import { effSec } from './security';
import { dist, hashId, jumps, nextGate, sysAt } from './geom';
import { coRelation } from './battleAuth';
import { shipValue } from './data';
import { emit, watchMoney } from './observe';
import { repContract, repContractFailed } from './reputation';
import { grantXp, groupFx, payroll } from './officers';
import type { Tree } from './officerData';
import { repairQuote } from './repair';
import { forecast } from './upkeep';
import { BACKGROUND } from './backgrounds';
import { book } from './operations';

type Host = WorldSim;
export type MilType = 'patrol' | 'escort' | 'defend' | 'hunt' | 'strike';

export const MIL_NAME: Record<MilType, string> = { patrol: '순찰', escort: '호위', defend: '방어', hunt: '해적 토벌', strike: '고위험 작전' };

/** tuning (docs/B2_MILITARY_BUSINESS.md §5) */
export const MIL = {
  rate: 24,                 // cr per recommended military value per hour of expected work (before the risk multiplier)
  board: 900,               // a station's posting stays on the board this long
  escortBoard: 300,         // a trader waits for an escort this long before sailing without one
  joinMax: 600,             // after acceptance the escort must reach the trader within this time
  cooldown: { patrol: 420, defend: 600, escort: 480, hunt: 360, strike: 900 } as Record<MilType, number>,
  perStation: { patrol: 1, defend: 1, escort: 1, hunt: 2, strike: 1 } as Record<MilType, number>,
  worldCap: { patrol: 10, defend: 8, hunt: 10, strike: 5, escort: 6 } as Record<MilType, number>,   // open (untaken) offers in the whole world
  fundsShare: 0.12,         // one contract never reserves more than this share of the station's funds
  huntJumps: 4,
  strikeJumps: 5,
  loops: 2,                 // every waypoint of a patrol route must be reached this many times
  wpReach: 650,             // a patrol waypoint counts when a combat ship of the fleet comes this close
  coverR: 8000,             // an escort covers its ward within this distance in the same system (a warp hop behind still answers an attack)
  coverMin: 0.6,            // share of the ward's travel time that must be covered
  detect: 2600,             // patrol threat detection (raised by the officer's detect effect)
  recentBattles: 60,        // battles remembered per company for the one-battle-one-contract rule
  history: 12,              // settled results kept per company (company.milLog)
} as const;

export interface MilShipSnap { id: string; hp: number; worth: number }
export interface MilResult {
  ok: boolean; why: string; at: number; dur: number;
  pay: number; bonus: number; refund: number;
  bounty: number; repair: number; lost: number; lostShips: number; upkeep: number; salary: number; net: number;
}
export interface MilTerms {
  type: MilType;
  sys: string;
  at?: V; radius?: number;
  route?: V[];
  dur?: number;
  /** hunt / strike target: a group id, `lair:<id>`, or (strike) `lane:<system>` */
  target?: string;
  tname?: string;
  quota?: number;
  /** escort */
  ward?: string; dest?: string; from?: string; wleg?: number;
  /** another company's escort: who posts and pays (credits reserved at posting) */
  poster?: string;
  base: number; bonus: number;
  risk: number; est: number; power: number; jumps: number;
  /** the fleet the taker committed (explicit consent) */
  group?: string;
  /** P17.4c AUD-10: the fleet's order before the contract first sent it out (restored when the contract ends);
   *  `prevFollow` = it was following its parent formation's order */
  prevOp?: Op; prevFollow?: boolean;
  /** P17.4c AUD-10: when the player last gave the fleet a manual order during the contract (then nothing is restored) */
  overridden?: number;
  t0?: number;
  duty?: number;
  visits?: number[];
  lastWp?: number;
  seen?: string[];
  battles?: string[];
  killV?: number;
  repelled?: number;
  bounty?: number;
  joined?: boolean; joinBy?: number; sailed?: number;
  cover?: [number, number];
  wardHp0?: number;
  snap?: MilShipSnap[];
  share?: number;
  /** escrow source: 'station' (reserved at acceptance) or 'poster' (reserved at posting) */
  src?: 'station' | 'poster';
  result?: MilResult;
}
export interface MilState {
  posts: Record<string, number>;
  /** company → battles already counted toward one of its contracts */
  counted: Record<string, string[]>;
}
export type MilLogRow = MilResult & { id: string; title: string; type: MilType };

export const milOn = (w: Pick<WorldState, 'milV'>) => w.milV === 1;
export const isMil = (k: Contract | undefined): k is Contract & { mil: MilTerms } => !!k && k.kind === 'mil' && !!k.mil;

/** turn military contracts on (new standard worlds; saves by MILITARY_B2_MIGRATE) — needs P11 combat and P12 ops */
export function enableMilitary(w: WorldState): { applied: boolean; reason: string } {
  if (w.milV === 1) return { applied: false, reason: '이미 적용됨' };
  if (w.combatV !== 2 || !w.opsV) return { applied: false, reason: 'P11 전투·P12 작전 월드가 아님' };
  w.milV = 1;
  w.mil ??= { posts: {}, counted: {} };
  return { applied: true, reason: '적용' };
}
/** explicit, non-destructive save migration: existing contracts are left exactly as they are */
export const migrateMilitary = enableMilitary;

const M = (w: WorldState): MilState => (w.mil ??= { posts: {}, counted: {} });
const r01 = (key: string) => (hashId(key) % 100000) / 100000;
const round = (n: number, step = 50) => Math.max(step, Math.round(n / step) * step);
const isPirate = (w: WorldState, owner: string) => owner === 'pirates' || w.companies[owner]?.kind === 'pirate';
const milShips = (h: Host, g: WGroup) => h.subtreeShips(g).filter(s => econOf(s).military);
const milValue = (ships: WShip[]) => ships.reduce((a, s) => a + shipValue(s.classId), 0);
const sysOfPos = (w: WorldState, p: V) => sysAt(w.systems, p);
const lawfulIssuer = (w: WorldState, st: Station) => st.public && !!st.services.contracts && st.funds !== undefined && st.faction !== 'pirates' && !isPirate(w, st.owner);
const inward = (p: V, o: V, d: number): V => { const dx = o.x - p.x, dz = o.z - p.z, l = Math.hypot(dx, dz) || 1; return { x: p.x + dx / l * d, y: p.y, z: p.z + dz / l * d }; };

/** pay for a job: recommended strength × expected hours × risk (+ a fixed part for the target's danger) */
function price(power: number, est: number, risk: number, extra = 0) { return MIL.rate * power * (est / 3600) * risk + extra; }

function activeOf(w: WorldState, company: string) { return Object.values(w.contracts).filter(k => isMil(k) && !k.done && k.takenBy === company) as (Contract & { mil: MilTerms })[]; }
/** the open military contract that already names this target / ward (one per target in the whole world) */
const claimed = (w: WorldState, key: string) => Object.values(w.contracts).some(k => isMil(k) && !k.done && (k.mil.target === key || k.mil.ward === key));

// ───────────────────────────────────────────────────────────── posting

function post(h: Host, st: Station, type: MilType, title: string, desc: string, m: Omit<MilTerms, 'type'>, life: number = MIL.board): string {
  // the reward a station can promise is limited by what it can actually reserve
  const cap = Math.max(400, (st.funds ?? 0) * MIL.fundsShare);
  const tot = m.base + m.bonus;
  if (tot > cap) { const f = cap / tot; m.base = round(m.base * f); m.bonus = round(m.bonus * f); }
  const id = h.offerContract({ stationId: st.id, kind: 'mil', title, desc, reward: m.base + m.bonus, rep: type === 'hunt' || type === 'strike' ? 6 : 3, ...(m.target ? { target: m.target } : {}), mil: { type, ...m, src: m.poster ? 'poster' : 'station' } }, life);
  M(h.st).posts[`${st.id}:${type}`] = h.time + MIL.cooldown[type] * (0.7 + 0.6 * r01(`${id}:cd`));
  return id;
}

/** each lawful contract station keeps a few military jobs on its board (deterministic, no world-rng draws).
 *  Caps per type for the whole world and one open patrol / defence job per system; the sweep starts at a different
 *  station each minute so every board gets its turn. */
export function postMilContracts(h: Host) {
  const w = h.st; if (!milOn(w)) return;
  const all = Object.values(w.contracts).filter(k => isMil(k) && !k.done) as (Contract & { mil: MilTerms })[];
  const open = (t: MilType) => all.filter(k => !k.takenBy && k.mil.type === t).length;
  const sts = Object.values(w.stations).filter(st => lawfulIssuer(w, st));
  if (!sts.length) return;
  const at = Math.floor(h.time / 60) % sts.length;
  for (let n = 0; n < sts.length; n++) {
    const st = sts[(at + n) % sts.length];
    const sys = sysOfPos(w, st.pos); if (!sys) continue;
    // escort offers are made when a trader docks (milTraderDocked), not by this sweep
    for (const type of ['patrol', 'defend', 'hunt', 'strike'] as MilType[]) {
      if (open(type) >= MIL.worldCap[type]) continue;
      if ((M(w).posts[`${st.id}:${type}`] ?? -Infinity) > h.time) continue;
      if (all.filter(k => k.stationId === st.id && k.mil.type === type && !k.takenBy).length >= MIL.perStation[type]) continue;
      if ((type === 'patrol' || type === 'defend') && all.some(k => k.mil.type === type && k.mil.sys === sys.id && !k.takenBy)) continue;
      const id = make(h, st, sys, type);
      if (!id) { M(w).posts[`${st.id}:${type}`] = h.time + 60; continue; }   // nothing suitable now: look again in a minute
      all.push(w.contracts[id] as Contract & { mil: MilTerms });
    }
  }
}

/** pirate strength actually present in these systems at posting time: a patrol / defence / escort there may meet the
 *  strongest band head-on, or several at once (B-2 profit runs: three bands together wiped a 0.88× escort, and an
 *  Ember lane patrol rated on security alone lost 8 ships). Hunt scale for the strongest band, 1.2× for the sum. */
function presence(h: Host, sysIds: Set<string>): number {
  const w = h.st; let sum = 0, top = 0;
  for (const g of Object.values(w.groups)) {
    if (!isPirate(w, g.owner) || !g.shipIds.length) continue;
    const p = h.groupCenter(g); const sy = p && sysOfPos(w, p); if (!sy || !sysIds.has(sy.id)) continue;
    const v = milValue(h.shipsOf(g)); sum += v; top = Math.max(top, v);
  }
  return Math.round(Math.max(top * 2.2, sum * 1.2));
}

function make(h: Host, st: Station, sys: StarSystem, type: MilType): string | null {
  const w = h.st, sec = effSec(sys), seed = `${st.id}:${type}:${Math.floor(h.time / 60)}`;
  switch (type) {
    case 'patrol': {
      // the station's approach and the system's gates (real waypoints), back to the station
      const gates = [...sys.gates].sort((a, b) => dist(a.pos, st.pos) - dist(b.pos, st.pos)).slice(0, 3);
      if (!gates.length) return null;
      const route = [inward(st.pos, sys.origin, -900), ...gates.map(g => inward(g.pos, sys.origin, 900))];
      const dur = 900 + Math.round(r01(seed) * 6) * 100;            // 15–20 min on the route
      const risk = 1 + (100 - sec) / 70, power = Math.max(135, Math.round(110 + (100 - sec) * 3), presence(h, new Set([sys.id])));
      const est = dur + 240;
      const base = round(price(power, est, risk)), bonus = round(base * 0.35);
      return post(h, st, 'patrol', `순찰: ${sys.name} 항로`, `${sys.name}의 정거장 접근로와 관문 ${gates.length}곳을 도는 순찰. 성계 안에서 항로를 실제로 돌며 ${Math.round(dur / 60)}분 근무해야 한다 — 정박 중인 시간은 근무로 치지 않는다. 적대 함대를 탐지·격퇴하면 성과 보너스.`,
        { sys: sys.id, route, at: st.pos, radius: 2500, dur, base, bonus, risk, est, power, jumps: 0 });
    }
    case 'defend': {
      // the most exposed point: a gate towards a dangerous neighbour, else the station itself
      const danger = sys.gates.map(g => ({ g, s: w.systems[g.to] })).filter(x => x.s).sort((a, b) => effSec(a.s) - effSec(b.s))[0];
      const gate = danger && effSec(danger.s) < sec - 10 ? danger.g : null;
      const at = gate ? inward(gate.pos, sys.origin, 1100) : inward(st.pos, sys.origin, -700);
      const dur = 1200 + Math.round(r01(seed) * 6) * 100;
      const risk = 1 + (100 - sec) / 60 + (gate ? (sec - effSec(danger!.s)) / 200 : 0), power = Math.max(140, Math.round(120 + (100 - sec) * 4), presence(h, new Set([sys.id, ...(gate ? [danger!.s.id] : [])])));
      const est = dur + 200;
      const base = round(price(power, est, risk) * 0.85), bonus = round(base * 0.5);
      const where = gate ? `${gate.name} 관문` : `${st.name} 정거장`;
      return post(h, st, 'defend', `방어: ${where}`, `${where} 주변 1.5km에 전투함을 ${Math.round(dur / 60)}분간 배치해 경계한다. 공격이 없어도 경계 기본 보수를 지급하고, 공격을 격퇴하면 별도 전투 보너스.`,
        { sys: sys.id, at, radius: 1500, dur, base, bonus, risk, est, power, jumps: 0, ...(gate ? { tname: gate.name } : {}) });
    }
    case 'escort': {
      // a real guild trader docked here and about to sail to its next market (normally offered the moment it docks)
      for (const g of Object.values(w.groups)) { const id = escortOffer(h, st, g); if (id) return id; }
      return null;
    }
    case 'hunt': case 'strike': {
      const maxJ = type === 'hunt' ? MIL.huntJumps : MIL.strikeJumps;
      type Cand = { key: string; name: string; value: number; pos: V; sys: StarSystem; j: number; lair?: number };
      const cands: Cand[] = [];
      for (const g of Object.values(w.groups)) {
        if (!isPirate(w, g.owner) || !g.shipIds.length || claimed(w, g.id)) continue;
        const p = h.groupCenter(g); const gs = p && sysOfPos(w, p); if (!p || !gs) continue;
        const j = gs.id === sys.id ? 0 : jumps(w.systems, sys.id, gs.id); if (!Number.isFinite(j) || j > maxJ) continue;
        const value = milValue(h.shipsOf(g).filter(s => econOf(s).military));
        if (value <= 0) continue;
        const big = g.shipIds.length >= 6 || value >= 360;
        if ((type === 'strike') !== big) continue;
        cands.push({ key: g.id, name: g.name, value, pos: p, sys: gs, j });
      }
      for (const l of Object.values(w.lairs)) {
        if (!l.alive || claimed(w, `lair:${l.id}`)) continue;
        const ls = sysOfPos(w, l.pos); if (!ls) continue;
        const j = ls.id === sys.id ? 0 : jumps(w.systems, sys.id, ls.id); if (!Number.isFinite(j) || j > maxJ) continue;
        const tier = l.tier ?? 2;
        if ((type === 'strike') !== (tier >= 3)) continue;
        cands.push({ key: `lair:${l.id}`, name: l.name, value: 140 + tier * 90, pos: l.pos, sys: ls, j, lair: tier });
      }
      if (type === 'strike') {
        // clearing a pirate lane: pirate strength destroyed in a dangerous system next to lawful space
        for (const gt of sys.gates) {
          const ns = w.systems[gt.to]; if (!ns || effSec(ns) >= 45 || claimed(w, `lane:${ns.id}`)) continue;
          const pv = Object.values(w.groups).filter(g => isPirate(w, g.owner) && g.shipIds.length).reduce((a, g) => { const p = h.groupCenter(g); return p && sysOfPos(w, p)?.id === ns.id ? a + milValue(h.shipsOf(g)) : a; }, 0);
          if (pv < 150) continue;
          cands.push({ key: `lane:${ns.id}`, name: `${ns.name} 항로`, value: Math.min(480, Math.round(pv * 0.6 / 10) * 10), pos: ns.origin, sys: ns, j: 1 });
        }
      }
      if (!cands.length) return null;
      // hunts: one of the least dangerous targets in reach (a start can find work it can survive); strikes: any
      const danger = (x: Cand) => x.value * (1 + (100 - effSec(x.sys)) / 100) + x.j * 40;
      if (type === 'hunt') cands.sort((a, b) => danger(a) - danger(b));
      const c = cands[hashId(seed) % (type === 'hunt' ? Math.min(3, cands.length) : cands.length)];
      const tsec = effSec(c.sys);
      // the way there counts: the most dangerous system on the route (pirate space on the way is part of the job)
      const worst = Math.min(tsec, ...routeSystems(w, sys.id, c.sys.id).map(x => effSec(w.systems[x])));
      const risk = 1 + c.value / (type === 'hunt' ? 420 : 360) + (100 - worst) / 150;
      // pirate bands fight well above their nominal value against small PMC fleets (scripts/b2/duel.ts: a 150 fleet
      // trades evenly with a 90 band, 210 with 215) — the recommended strength is what usually wins, not parity.
      // 8 h profit runs at 2.2×: fleets at 1.0–1.4× still lost a hull in most won hunts and were wiped twice, so 3.0×
      const power = Math.round(c.value * (c.lair ? 3.6 : 3.0) * (1 + (100 - worst) / 300));
      const est = 360 + c.j * 120 + (c.lair ? 300 : 0) + (c.key.startsWith('lane:') ? 1200 : 0);
      // a fixed part for the target's danger: combat jobs expect damage and the occasional lost hull — sized so a won
      // hunt that costs one escort-class hull (≈ 9–13k cr) roughly breaks even with the bounty
      const base = round(price(power, est, risk, c.value * (type === 'hunt' ? 40 : 50)));
      const bonus = round(c.value * (type === 'hunt' ? 16 : 20));
      const lane = c.key.startsWith('lane:');
      const what = c.lair ? `해적 소굴 ${c.name} (등급 ${c.lair})` : lane ? `${c.sys.name}의 해적 전력` : `해적 무리 ${c.name} (${w.groups[c.key]?.shipIds.length ?? 0}척)`;
      return post(h, st, type, `${type === 'hunt' ? '토벌' : lane ? '항로 확보' : '강습'}: ${c.name}`,
        lane ? `${c.sys.name}(치안 ${Math.round(tsec)})에서 해적 전력 ${c.value} 상당을 격침해 항로를 확보한다. 격침 몫은 해적에게 준 피해 비율로 계산한다.`
          : `${c.sys.name}(${c.j}회 도약, 대상 성계 치안 ${Math.round(tsec)}, 경로 최저 치안 ${Math.round(worst)}) — ${what}을(를) 격멸한다. 계약사가 실제로 참가한 전투에서 대상이 격파되어야 완수. 다른 회사가 먼저 격파하면 계약은 무효(예치금 반환, 불이익 없음).`,
        { sys: c.sys.id, target: c.key, tname: c.name, ...(lane ? { quota: c.value, at: c.sys.origin, radius: Math.min(9000, c.sys.radius * 0.6) } : {}), base, bonus, risk, est, power, jumps: c.j });
    }
  }
}

function escortOffer(h: Host, st: Station, g: WGroup): string | null {
  const w = h.st;
  if (g.owner !== 'guild' || g.op.k !== 'trade' || !g.shipIds.length || claimed(w, g.id)) return null;
  const s = w.ships[g.shipIds[0]];
  if (!s || s.state !== 'docked' || s.task.k !== 'docked' || s.task.station !== st.id) return null;
  const sys = sysOfPos(w, st.pos); if (!sys) return null;
  const op = g.op as Extract<Op, { k: 'trade' }>;
  const dest = w.stations[op.route[op.leg % op.route.length]];
  if (!dest || dest.id === st.id) return null;
  const b = sysOfPos(w, dest.pos); if (!b) return null;
  const nj = sys.id === b.id ? 0 : jumps(w.systems, sys.id, b.id);
  if (!Number.isFinite(nj) || nj > 5) return null;
  const path = routeSystems(w, sys.id, b.id), worst = Math.min(...path.map(x => effSec(w.systems[x])));
  const risk = 1 + (100 - worst) / 60, power = Math.max(110, Math.round(90 + (100 - worst) * 3), presence(h, new Set(path)));
  // real travel: the escort's approach, a warp per system and the jumps (warp drives make in-system legs short)
  const est = 150 + nj * 60 + Math.min(60, dist(st.pos, dest.pos) / 1500);
  const base = round(price(power, est, risk) + 250), bonus = round(base * 0.4);
  return post(h, st, 'escort', `호위: ${g.name} → ${dest.name}`, `길드 상선단 ${g.name}을(를) ${dest.name}까지 호위한다 (${nj}회 도약, 경로 최저 치안 ${Math.round(worst)}). 상선은 호위가 합류할 때까지 정박해 기다린다(수주 후 최대 ${Math.round(MIL.joinMax / 60)}분). 도착 시 정산 — 상선이 피해 없이 도착하고 위협을 격퇴할수록 보너스.`,
    { sys: sys.id, ward: g.id, dest: dest.id, from: st.id, wleg: op.leg % op.route.length, base, bonus, risk, est, power, jumps: nj }, MIL.escortBoard);
}
/** a guild trader has just docked at `st`: the station may offer an escort job for its next leg */
export function milTraderDocked(h: Host, g: WGroup, st: Station) {
  const w = h.st; if (!milOn(w) || !lawfulIssuer(w, st)) return;
  if ((M(w).posts[`${st.id}:escort`] ?? -Infinity) > h.time) return;
  const open = Object.values(w.contracts).filter(k => isMil(k) && !k.done && !k.takenBy && k.mil!.type === 'escort');
  if (open.length >= MIL.worldCap.escort || open.some(k => k.stationId === st.id)) return;
  escortOffer(h, st, g);
}

function routeSystems(w: WorldState, a: string, b: string): string[] {
  const out = [a]; let cur = a;
  for (let i = 0; i < 10 && cur !== b; i++) { const g = nextGate(w.systems, cur, b); if (!g) break; cur = g.to; out.push(cur); }
  return out;
}

// ───────────────────────────────────────────────────────────── commands

/** the fleet a company may commit: its own top-level or sub group with combat ships, none fighting, not on another contract */
function fleetProblem(h: Host, company: string, g: WGroup | undefined): string | null {
  if (!g || g.owner !== company) return '함대를 선택하세요 (자사 편대만 투입할 수 있습니다)';
  const mil = milShips(h, g);
  if (!mil.length) return `${g.name}에 전투함이 없습니다`;
  if (activeOf(h.st, company).some(k => k.mil.group === g.id)) return `${g.name}은(는) 이미 다른 군사 계약을 수행 중입니다`;
  return null;
}

export function acceptMil(h: Host, company: string, k: Contract & { mil: MilTerms }, groupId: unknown): string | null {
  const w = h.st, m = k.mil, co = w.companies[company];
  if (!co || co.kind !== 'player') return '수주 불가';
  if (h.time > k.expires) return '게시 기한이 지난 계약입니다';
  if (m.poster === company) return '자사가 게시한 호위 계약은 수주할 수 없습니다';
  const g = typeof groupId === 'string' ? w.groups[groupId] : undefined;
  const why = fleetProblem(h, company, g); if (why) return why;
  if (m.type === 'escort') {
    const ward = m.ward ? w.groups[m.ward] : undefined;
    if (!ward || !ward.shipIds.length) return '호위 대상이 사라졌습니다';
    if (ward.owner === company) return '자사 선단은 호위 계약 대상이 될 수 없습니다';
    if (coRelation(w, company, ward.owner) === -1) return '적대 관계인 회사의 선단은 호위할 수 없습니다';
  }
  if (m.type === 'hunt' || m.type === 'strike') {
    const t = m.target ?? '';
    if (t.startsWith('lair:')) { if (!w.lairs[t.slice(5)]?.alive) return '대상 소굴이 이미 파괴되었습니다'; }
    else if (t.startsWith('war:')) {
      // B-3 war service: only a formal, running war; never for the enemy side itself
      const war = w.sov?.wars[t.split(':')[1]];
      if (!war || war.status === 'ended') return '영토 전쟁이 이미 끝났습니다';
      const enemy = war.att === m.poster ? war.def : war.att;
      if (company === enemy || enemy === `fac:${company}`) return '교전 상대 측은 수주할 수 없습니다';
    }
    else if (!t.startsWith('lane:')) { const tg = w.groups[t]; if (!tg || !tg.shipIds.length) return '대상 해적이 이미 사라졌습니다'; if (!isPirate(w, tg.owner)) return '합법 대상이 아닙니다'; }
  }
  const st = w.stations[k.stationId];
  if (m.src === 'station') {
    const need = m.base + m.bonus;
    if (!st || (st.funds ?? 0) < need) return `${st?.name ?? '발주처'} 예산 부족 — 보수 ${need.toLocaleString()} cr를 예약할 수 없습니다`;
    watchMoney(w, 'contract_escrow', { company, station: st.id }, () => { st.funds! -= need; k.escrow = need; });
  }
  k.takenBy = company;
  m.group = g!.id; m.t0 = h.time; m.duty = 0; m.killV = 0; m.repelled = 0; m.bounty = 0; m.battles = []; m.seen = [];
  if (m.route) m.visits = m.route.map(() => 0);
  m.snap = milShips(h, g!).map(s => ({ id: s.id, hp: s.hp, worth: shipWorth(w, s) }));
  if (m.type === 'escort') {
    m.joinBy = h.time + MIL.joinMax; m.joined = false; m.cover = [0, 0];
    const wards = wardShips(h, k); m.wardHp0 = wards.length ? wards.reduce((a, s) => a + s.hp, 0) / wards.length : 1;
  }
  // the time limit: generous for the travel and the work, never open-ended
  k.expires = h.time + Math.max(1200, m.est * 2.2 + m.jumps * 120 + 600);
  emit(w, { kind: 'contract', reason: 'accept', amount: 1, company, station: k.stationId, item: `mil_${m.type}` });
  h.ev('info', `군사 계약 수주: ${k.title} — ${g!.name} 투입 (기한 ${Math.round((k.expires - h.time) / 60)}분)`, { company, pos: st?.pos });
  return null;
}

/** the order that does the job (the fleet sorties; the player may still give its own orders) */
export function milOrder(h: Host, k: Contract & { mil: MilTerms }): Op | null {
  const m = k.mil, w = h.st;
  switch (m.type) {
    case 'patrol': return { k: 'patrol', at: m.at ?? m.route![0], radius: m.radius ?? 2500, route: m.route!.map(p => ({ ...p })) };
    case 'defend': return { k: 'defend', at: { ...m.at! }, radius: m.radius ?? 1500 };
    case 'escort': return m.ward ? { k: 'escort', group: m.ward, focus: 'cargo' } : null;
    case 'hunt': case 'strike': {
      const t = m.target ?? '';
      if (t.startsWith('lair:')) return { k: 'attack', lair: t.slice(5) };
      if (t.startsWith('war:')) { const s = w.systems[m.sys]; if (!s) return null; const pts = s.gates.slice(0, 4).map(g => inward(g.pos, s.origin, 1800)); return { k: 'patrol', at: s.origin, radius: 6000, route: pts.length ? pts : [s.origin] }; }
      if (t.startsWith('lane:')) { const s = w.systems[t.slice(5)]; if (!s) return null; const pts = s.gates.slice(0, 4).map(g => inward(g.pos, s.origin, 1800)); return { k: 'patrol', at: s.origin, radius: m.radius ?? 6000, route: pts.length ? pts : [s.origin] }; }
      return w.groups[t]?.shipIds.length ? { k: 'attack', group: t } : null;
    }
  }
}

export function milDispatch(h: Host, company: string, contractId: unknown): string | null {
  const k = typeof contractId === 'string' ? h.st.contracts[contractId] : undefined;
  if (!isMil(k) || k.takenBy !== company || k.done) return '진행 중인 자사 군사 계약이 아닙니다';
  const g = k.mil.group ? h.st.groups[k.mil.group] : undefined;
  if (!g || g.owner !== company) return '투입 함대를 찾을 수 없습니다';
  const op = milOrder(h, k); if (!op) return '작전 대상이 없습니다';
  // P17.4c AUD-10: remember the order the contract interrupts (once — a re-sortie keeps the original)
  const prev = k.mil.prevOp === undefined && k.mil.prevFollow === undefined ? { op: structuredClone(g.op), follow: !g.override && !!g.parentId } : undefined;
  const err = h.command(company, { c: 'setOp', group: g.id, op });
  if (err) return err;
  if (prev) { if (prev.follow) k.mil.prevFollow = true; else k.mil.prevOp = prev.op; }
  delete k.mil.overridden;   // the contract's own sortie (and a player's re-sortie) hands the fleet back to the contract
  return null;
}

/**
 * P17.4c AUD-10: when a contract ends, its fleet goes back to the order it had before the contract — unless the
 * player gave the fleet a manual order during the contract (that order stands; the player's latest decision wins).
 * An order that can no longer be given (its target is gone) leaves the fleet idle, with the reason logged.
 */
export function restorePriorOrder(h: Host, k: Contract & { mil: MilTerms }) {
  const m = k.mil, c = k.takenBy, g = m.group ? h.st.groups[m.group] : undefined;
  if (!c || !g || g.owner !== c || (m.prevOp === undefined && !m.prevFollow)) return;
  if (m.overridden !== undefined) { h.ev('info', `${g.name}: 계약 중 내린 직접 명령을 유지합니다 (계약 전 명령으로 되돌리지 않음)`, { company: c, tag: 'mil' }); return; }
  const prev = m.prevOp, what = m.prevFollow ? '상위 편대 지휘' : prev!.k === 'idle' ? '대기' : prev!.k;
  delete m.prevOp; delete m.prevFollow;
  if (prev?.k === 'found') { h.command(c, { c: 'setOp', group: g.id, op: { k: 'idle' } }); h.ev('warn', `${g.name}: 계약 전 정거장 설립 명령은 자동으로 되살리지 않습니다 — 대기`, { company: c, tag: 'mil' }); return; }
  const err = m.prevFollow ? h.command(c, { c: 'release', group: g.id }) : h.command(c, { c: 'setOp', group: g.id, op: prev! });
  if (err) { h.command(c, { c: 'setOp', group: g.id, op: { k: 'idle' } }); h.ev('warn', `${g.name}: 계약 전 명령(${what})으로 돌아갈 수 없어 대기 — ${err}`, { company: c, tag: 'mil' }); return; }
  h.ev('info', `${g.name}: 계약 종료 — 계약 전 명령(${what})으로 복귀`, { company: c, tag: 'mil' });
}

export function milCancel(h: Host, company: string, contractId: unknown): string | null {
  const k = typeof contractId === 'string' ? h.st.contracts[contractId] : undefined;
  if (!isMil(k) || k.done) return '취소할 수 있는 계약이 아닙니다';
  // the poster may withdraw its own escort offer while nobody has taken it
  if (k.mil.poster === company && !k.takenBy) { k.done = true; k.ended = '게시자 철회'; refund(h, k); h.ev('info', `호위 의뢰 철회: ${k.title} — 예치금 반환`, { company }); return null; }
  if (k.takenBy !== company) return '자사가 수주한 계약만 취소할 수 있습니다';
  settle(h, k, false, '계약 포기', 0, true);
  return null;
}

/** another company's escort job: the poster names its own cargo group, the destination and the reward (reserved now) */
export function milPostEscort(h: Host, company: string, groupId: unknown, to: unknown, reward: unknown): string | null {
  const w = h.st, co = w.companies[company];
  if (!milOn(w) || !co || co.kind !== 'player') return '이 월드에서는 호위 의뢰를 게시할 수 없습니다';
  const g = typeof groupId === 'string' ? w.groups[groupId] : undefined;
  if (!g || g.owner !== company) return '자사 선단을 선택하세요';
  const wards = h.subtreeShips(g).filter(s => econOf(s).cargo > 0);
  if (!wards.length) return '화물선이 있는 선단만 호위를 의뢰할 수 있습니다';
  if (claimed(w, g.id)) return '이미 호위 의뢰가 걸린 선단입니다';
  const dest = typeof to === 'string' ? w.stations[to] : undefined;
  if (!dest || !h.canDock(dest, company)) return '목적지 정거장을 확인하세요';
  const pay = typeof reward === 'number' && Number.isFinite(reward) ? Math.floor(reward) : NaN;
  if (!(pay >= 500 && pay <= 200000)) return '보수는 500 ~ 200,000 cr';
  if (co.credits < pay) return `자금 부족 — 보수 ${pay.toLocaleString()} cr를 예치해야 합니다`;
  const p = h.groupCenter(g); const a = p && sysOfPos(w, p), b = sysOfPos(w, dest.pos);
  if (!p || !a || !b) return '선단 위치를 확인할 수 없습니다';
  const nj = a.id === b.id ? 0 : jumps(w.systems, a.id, b.id); if (!Number.isFinite(nj)) return '목적지까지 경로가 없습니다';
  const board = Object.values(w.stations).filter(s => s.public && s.services.contracts).sort((x, y) => h.routeDistance(x.pos, p) - h.routeDistance(y.pos, p))[0];
  if (!board) return '의뢰를 게시할 정거장이 없습니다';
  const worst = Math.min(...routeSystems(w, a.id, b.id).map(x => effSec(w.systems[x])));
  const base = Math.round(pay * 0.7), bonus = pay - base;
  let id = '';
  watchMoney(w, 'contract_escrow', { company, station: board.id }, () => {
    co.credits -= pay;
    id = h.offerContract({ stationId: board.id, kind: 'mil', title: `호위 의뢰: ${co.name} ${g.name} → ${dest.name}`, desc: `${co.name}의 ${g.name}(화물선 ${wards.length}척)을 ${dest.name}까지 호위 (${nj}회 도약, 경로 최저 치안 ${Math.round(worst)}). 보수는 의뢰사가 예치했다 — 기본 ${base.toLocaleString()} + 무사 도착 보너스 ${bonus.toLocaleString()} cr.`, reward: pay, rep: 0, escrow: pay,
      mil: { type: 'escort', sys: a.id, ward: g.id, dest: dest.id, poster: company, src: 'poster', base, bonus, risk: 1 + (100 - worst) / 60, est: 150 + nj * 60, power: Math.max(90, Math.round(90 + (100 - worst) * 3)), jumps: nj } }, 1800);
  });
  h.ev('info', `호위 의뢰 게시: ${g.name} → ${dest.name} (예치 ${pay.toLocaleString()} cr, ${board.name} 게시판)`, { company });
  return id ? null : '게시 실패';
}

/** may `company`'s fleet escort group `targetId` of another company? (only under an accepted escort contract) */
export function milEscortAllowed(w: WorldState, company: string, targetId: string): boolean {
  return milOn(w) && Object.values(w.contracts).some(k => isMil(k) && !k.done && k.takenBy === company && k.mil.type === 'escort' && k.mil.ward === targetId);
}

// ───────────────────────────────────────────────────────────── the ward (escort contracts)

function wardShips(h: Host, k: Contract & { mil: MilTerms }): WShip[] {
  const g = k.mil.ward ? h.st.groups[k.mil.ward] : undefined;
  if (!g) return [];
  return g.owner === 'guild' ? h.shipsOf(g) : h.subtreeShips(g).filter(s => econOf(s).cargo > 0);
}
/** an NPC trader with an escort contract stays docked while the offer is open and until its escort joins (bounded) */
export function milWardHold(h: Host, g: WGroup, ships: WShip[]): WShip[] {
  const w = h.st; if (!milOn(w) || g.owner !== 'guild') return [];
  const k = Object.values(w.contracts).find(x => isMil(x) && !x.done && x.mil.type === 'escort' && x.mil.ward === g.id) as (Contract & { mil: MilTerms }) | undefined;
  if (!k || k.mil.joined || k.mil.sailed !== undefined) return [];
  const held = ships.filter(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === k.mil.from);
  if (held.length) g.status = k.takenBy ? `호위 합류 대기 — ${w.groups[k.mil.group ?? '']?.name ?? '호위 함대'}` : '호위 계약 게시 중 — 출항 대기';
  return held;
}
export const milIsWard = (w: WorldState, groupId: string) => milOn(w) && Object.values(w.contracts).some(k => isMil(k) && !k.done && !!k.takenBy && k.mil.ward === groupId);

// ───────────────────────────────────────────────────────────── evaluation (every second)

export function milTick(h: Host) {
  const w = h.st; if (!milOn(w)) return;
  for (const k of Object.values(w.contracts)) {
    if (!isMil(k) || k.done) continue;
    if (!k.takenBy) {
      if (h.time > k.expires) { k.done = true; k.ended = '게시 기한 만료'; refund(h, k); if (k.mil.poster) h.ev('info', `호위 의뢰 기한 만료: ${k.title} — 수주사가 없어 예치금 반환`, { company: k.mil.poster }); }
      else if (k.mil.ward && !w.groups[k.mil.ward]?.shipIds.length) { k.done = true; k.ended = '호위 대상 소멸'; refund(h, k); }
      else if (k.mil.target && !targetAlive(h, k.mil.target)) { k.done = true; k.ended = '대상 소멸'; }
      continue;
    }
    evaluate(h, k);
  }
  postMilContracts(h);
  // bounties and later contracts can carry a start past its founding funds after the first contract
  if (Math.floor(h.time) % 10 === 0) for (const co of Object.values(w.companies)) if (co.kind === 'player') milFirstProfit(h, co);
}

function targetAlive(h: Host, t: string): boolean {
  if (t.startsWith('lair:')) return !!h.st.lairs[t.slice(5)]?.alive;
  if (t.startsWith('lane:')) return true;
  if (t.startsWith('war:')) return h.st.sov?.wars[t.split(':')[1]]?.status !== 'ended';
  return !!h.st.groups[t]?.shipIds.length;
}

function evaluate(h: Host, k: Contract & { mil: MilTerms }) {
  const w = h.st, m = k.mil;
  const g = m.group ? w.groups[m.group] : undefined;
  const mil = g ? milShips(h, g) : [];
  const fighting = mil.some(s => s.state === 'battle');
  if (!g || g.owner !== k.takenBy || (!mil.length && !fighting)) return settle(h, k, false, '투입 함대 전멸·해산', 0);
  if (h.time > k.expires) return settle(h, k, false, '기한 만료', 0);
  const inSpace = mil.filter(s => s.state === 'space');
  const fx = groupFx(w, g);
  switch (m.type) {
    case 'patrol': {
      const route = m.route ?? []; m.visits ??= route.map(() => 0);
      const inSys = inSpace.filter(s => sysOfPos(w, s.pos)?.id === m.sys);
      // on duty: combat ships flying in the system, near the route (docked ships never count)
      const near = inSys.some(s => offRoute(route, s.pos) < 2500);
      if (near) m.duty = (m.duty ?? 0) + 1;
      // a waypoint visit counts when the fleet arrives there from elsewhere (parking on one point does not farm visits)
      route.forEach((p, i) => { if (m.lastWp !== i && inSys.some(s => dist(p, s.pos) < MIL.wpReach)) { m.visits![i]++; m.lastWp = i; } });
      watch(h, k, inSys, MIL.detect * (1 + (fx.detect ?? 0)));
      const loop = m.visits.every(v => v >= MIL.loops);
      if ((m.duty ?? 0) >= (m.dur ?? 0) && loop) return settle(h, k, true, '순찰 완수', bonusFrac(m));
      return;
    }
    case 'defend': {
      const on = inSpace.some(s => dist(s.pos, m.at!) <= (m.radius ?? 1500) + 300);
      if (on) m.duty = (m.duty ?? 0) + 1;
      watch(h, k, inSpace.filter(s => dist(s.pos, m.at!) < 6000), MIL.detect * (1 + (fx.detect ?? 0)));
      if ((m.duty ?? 0) >= (m.dur ?? 0)) return settle(h, k, true, '방어 근무 완수', bonusFrac(m));
      return;
    }
    case 'escort': return evalEscort(h, k, mil, inSpace);
    case 'hunt': case 'strike': {
      const t = m.target ?? '';
      if (t.startsWith('war:')) {
        // on duty while its warships are in the war system; the war ending early pays for the time served
        if (inSpace.some(s => sysOfPos(w, s.pos)?.id === m.sys)) m.duty = (m.duty ?? 0) + 1;
        const war = w.sov?.wars[t.split(':')[1]];
        if ((m.duty ?? 0) >= (m.dur ?? 0)) return settle(h, k, true, '전쟁 계약 기간 완수', bonusFrac(m));
        if (!war || war.status === 'ended') return (m.duty ?? 0) >= (m.dur ?? 1) * 0.3 ? settle(h, k, true, '종전 — 복무 시간만큼 정산', Math.min(1, (m.duty ?? 0) / (m.dur ?? 1)) * bonusFrac(m)) : settle(h, k, false, '종전 — 계약 무효', 0, false, true);
        return;
      }
      if (t.startsWith('lane:')) { if ((m.killV ?? 0) >= (m.quota ?? 0)) return settle(h, k, true, '항로 확보 완수', Math.min(1, (m.share ?? 1))); return; }
      if (!targetAlive(h, t)) return settle(h, k, false, '다른 세력이 먼저 대상을 격파 — 계약 무효', 0, false, true);
      return;
    }
  }
}
/** distance from the closed patrol route (waypoint to waypoint, back to the first) */
function offRoute(route: V[], p: V): number {
  let best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[(i + 1) % route.length];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
}
function bonusFrac(m: MilTerms) {
  // performance: hostile fleets detected and engagements won in the area (pirate strength destroyed)
  const seen = Math.min(1, (m.seen?.length ?? 0) * 0.25), fought = Math.min(1, (m.killV ?? 0) / Math.max(60, m.power * 0.5));
  return Math.min(1, seen * 0.3 + fought * 0.7 + (m.repelled ?? 0) * 0.2);
}
/** threat detection: hostile fleets that come within sensor range of the working fleet */
function watch(h: Host, k: Contract & { mil: MilTerms }, ships: WShip[], r: number) {
  if (!ships.length) return;
  const w = h.st, m = k.mil;
  for (const g of Object.values(w.groups)) {
    if (!g.shipIds.length || m.seen?.includes(g.id) || coRelation(w, k.takenBy!, g.owner) !== -1) continue;
    const p = h.groupCenter(g); if (!p) continue;
    if (ships.some(s => dist(s.pos, p) < r)) {
      (m.seen ??= []).push(g.id); if (m.seen.length > 20) m.seen.shift();
      h.ev('warn', `${k.title}: 적대 함대 ${g.name} 탐지 (${g.shipIds.length}척)`, { company: k.takenBy!, pos: p, ref: g.id });
    }
  }
}

function evalEscort(h: Host, k: Contract & { mil: MilTerms }, mil: WShip[], inSpace: WShip[]) {
  const w = h.st, m = k.mil;
  const wards = wardShips(h, k);
  if (!wards.length) return settle(h, k, false, '보호 대상 격침', 0);
  const dest = w.stations[m.dest ?? '']; if (!dest) return settle(h, k, false, '목적지 소멸', 0, false, true);
  const wc = centroid(wards.map(s => s.pos));
  const wsys = sysOfPos(w, wc)?.id;
  // an escort warping to the ward's side counts as with it (it arrives within seconds)
  const escorted = (r: number) => mil.some(s => (s.state === 'space' || s.state === 'docked') && sysOfPos(w, s.pos)?.id === wsys && (dist(s.pos, wc) < r || (s.warp?.phase === 'warp' && dist(s.warp.to, wc) < r)));
  if (!m.joined) {
    if (escorted(1800)) { m.joined = true; h.ev('info', `${k.title}: 호위 합류 — 출항`, { company: k.takenBy!, pos: wc }); }
    else if (h.time > (m.joinBy ?? 0)) { m.sailed = h.time; return settle(h, k, false, '호위 미합류 — 보호 대상이 단독 출항', 0); }
    else return;
  }
  // arrival: an NPC trader has moved on from the destination leg; a company's cargo ships are docked there
  const ward = w.groups[m.ward ?? ''];
  let arrived = false;
  if (ward?.owner === 'guild' && ward.op.k === 'trade') arrived = ward.op.leg % ward.op.route.length !== m.wleg && wards.every(s => dist(s.pos, dest.pos) < 3500);
  else arrived = wards.every(s => s.state === 'docked' && s.task.k === 'docked' && s.task.station === dest.id);
  const moving = wards.some(s => s.state === 'space');
  // coverage is sampled while the ward can be caught: in space and not inside a warp jump
  if (moving) { m.sailed ??= h.time; if (wards.some(s => s.state === 'space' && s.warp?.phase !== 'warp')) { const c = (m.cover ??= [0, 0]); c[1]++; if (escorted(MIL.coverR)) c[0]++; } }
  watch(h, k, inSpace, MIL.detect);
  if (arrived) {
    const c = m.cover ?? [0, 0];
    const cover = c[1] ? c[0] / c[1] : 1;
    if (cover < MIL.coverMin) return settle(h, k, false, `호위 이탈 — 이동 구간의 ${Math.round(cover * 100)}%만 호위`, 0);
    const hp = wards.reduce((a, s) => a + s.hp, 0) / wards.length;
    const intact = Math.max(0, Math.min(1, 1 - Math.max(0, (m.wardHp0 ?? 1) - hp) * 2));
    return settle(h, k, true, '호위 완수 — 목적지 도착', Math.min(1, intact * 0.7 + Math.min(1, (m.killV ?? 0) / 80) * 0.3 + (m.repelled ?? 0) * 0.15));
  }
}
const centroid = (ps: V[]): V => { const c = { x: 0, y: 0, z: 0 }; for (const p of ps) { c.x += p.x; c.y += p.y; c.z += p.z; } const n = Math.max(1, ps.length); return { x: c.x / n, y: c.y / n, z: c.z / n }; };

// ───────────────────────────────────────────────────────────── battles

export interface MilBattle { players: string[]; vsPir: (c: string) => number; pirateKilled: number; bountyBy: Map<string, number>; lairKilled?: string }
/** after a battle is settled (P11): count it toward at most one military contract per company */
export function milOnBattle(h: Host, e: Engagement, b: MilBattle) {
  const w = h.st; if (!milOn(w)) return;
  const totPir = b.players.reduce((a, c) => a + b.vsPir(c), 0);
  for (const k of Object.values(w.contracts)) {
    if (!isMil(k) || k.done || !k.takenBy) continue;
    const m = k.mil, c = k.takenBy;
    // anti-abuse: a contractor that fires on the ships it is paid to protect forfeits the contract
    const ward = m.ward ? w.groups[m.ward] : undefined;
    if (ward && (e.dmg?.[c]?.[ward.owner] ?? 0) > 0 && ward.owner !== c) { settle(h, k, false, '보호 대상 공격', 0); continue; }
  }
  for (const c of b.players) {
    const mine = activeOf(w, c); if (!mine.length) continue;
    const counted = (M(w).counted[c] ??= []);
    if (counted.includes(e.id)) continue;
    const share = totPir > 0 ? b.vsPir(c) / totPir : 0;
    const refs = new Set(e.groupRefs);
    const inIt = (k: Contract & { mil: MilTerms }) => { const g = k.mil.group ? w.groups[k.mil.group] : undefined; return !!g && (refs.has(g.id) || h.subtreeShips(g).some(s => refs.has(s.groupId))) ; };
    // the contract this battle belongs to: its own target first, then the work area
    const pick = mine.filter(inIt).sort((a, z) => rank(h, a, e) - rank(h, z, e))[0];
    if (!pick || rank(h, pick, e) >= 9) continue;
    counted.push(e.id); if (counted.length > MIL.recentBattles) counted.splice(0, counted.length - MIL.recentBattles);
    const m = pick.mil;
    (m.battles ??= []).push(e.id);
    m.bounty = (m.bounty ?? 0) + (b.bountyBy.get(c) ?? 0);
    if (share > 0) { m.killV = (m.killV ?? 0) + b.pirateKilled * share; if (b.pirateKilled > 0) m.repelled = (m.repelled ?? 0) + 1; }
    const t = m.target ?? '';
    if ((m.type === 'hunt' || m.type === 'strike') && !t.startsWith('lane:') && share > 0) {
      const gone = t.startsWith('lair:') ? b.lairKilled === t.slice(5) : !w.groups[t]?.shipIds.length && refs.has(t);
      if (gone) { m.share = share; settle(h, pick, true, `${MIL_NAME[m.type]} 완수 — ${m.tname ?? '대상'} 격파`, share); }
    }
    if (t.startsWith('lane:') && share > 0) m.share = Math.max(m.share ?? 0, share);
  }
}
function rank(h: Host, k: Contract & { mil: MilTerms }, e: Engagement): number {
  const m = k.mil, t = m.target ?? '';
  if (t.startsWith('lair:') && e.lairId === t.slice(5)) return 0;
  if (t && !t.includes(':') && e.groupRefs.includes(t)) return 0;
  if (m.ward && e.groupRefs.includes(m.ward)) return 1;
  const es = e.sys ?? sysOfPos(h.st, e.pos)?.id;
  if (t.startsWith('lane:') && es === t.slice(5)) return 1;
  if (m.type === 'defend' && m.at && dist(m.at, e.pos) < (m.radius ?? 1500) + 2500) return 2;
  if (m.type === 'patrol' && es === m.sys) return 2;
  if (m.type === 'escort') return 3;
  return 9;
}

// ───────────────────────────────────────────────────────────── settlement

function refund(h: Host, k: Contract & { mil?: MilTerms }) {
  if (!k.escrow) return;
  const amt = k.escrow, poster = k.mil?.poster;
  watchMoney(h.st, 'contract_refund', { company: poster ?? k.takenBy ?? undefined, station: k.stationId }, () => {
    if (poster && h.st.companies[poster]) h.st.companies[poster].credits += amt;
    else { const st = h.st.stations[k.stationId]; if (st) st.funds = (st.funds ?? 0) + amt; }
    k.escrow = 0;
  });
}

const XP_SPLIT: Record<MilType, Partial<Record<Tree, number>>> = {
  patrol: { command: 3, intercept: 2, ew: 1 },
  defend: { command: 3, defense: 2, airdef: 1 },
  escort: { airdef: 3, command: 2, logistics: 2 },
  hunt: { gunnery: 3, intercept: 2, command: 1 },
  strike: { gunnery: 2, command: 2, support: 2 },
};

/** close a taken contract: pay (base + earned bonus) or fail; refund what is not paid; record the operation's P&L */
export function settle(h: Host, k: Contract & { mil: MilTerms }, ok: boolean, why: string, frac: number, quit = false, voided = false) {
  if (k.done) return;
  const w = h.st, m = k.mil, c = k.takenBy!, co = w.companies[c];
  k.done = true; k.ended = why; k.outcome = ok ? 'complete' : voided ? 'void' : quit ? 'cancelled' : 'failed';
  const pay = ok ? m.base : 0, bonus = ok ? Math.round(m.bonus * Math.max(0, Math.min(1, frac))) : 0;
  const escrow = k.escrow ?? 0, out = Math.min(escrow, pay + bonus);
  if (co && out > 0) watchMoney(w, 'contract_mil', { company: c, station: k.stationId }, () => { co.credits += out; co.stats.earned += out; co.stats.contracts++; k.escrow = escrow - out; });
  const back = k.escrow ?? 0;
  refund(h, k);
  if (co && out > 0) bookMil(h, c, 'mil_contract', out);
  // reputation: station work counts with the issuer's faction; a fault costs credit; a voided job costs nothing
  if (co && !m.poster) {
    if (ok) repContract(w, c, { id: k.id, kind: m.type === 'hunt' || m.type === 'strike' ? 'lair' : 'bounty', stationId: k.stationId, reward: k.reward });
    else if (!voided) repContractFailed(w, c, k);
  }
  emit(w, { kind: 'contract', reason: ok ? 'complete' : voided ? 'void' : 'fail', amount: 1, value: out, company: c, station: k.stationId, item: `mil_${m.type}` });
  // officer: duty experience for the job itself (the fighting already paid combat experience per battle), once per contract
  const g = m.group ? w.groups[m.group] : undefined, cm = g?.commanderId ? w.commanders[g.commanderId] : undefined;
  let xpTxt = '';
  if (ok && cm) { const r = grantXp(w, cm, 'contract', Math.min(400, 60 + (m.est / 60) * 4 + (m.type === 'strike' ? 80 : 0)), XP_SPLIT[m.type], `mil:${k.id}`); if (r.gain > 0) xpTxt = ` · ${cm.name} 경험 +${Math.round(r.gain)}`; for (const n of r.notes) h.ev('milestone', `${cm.rank} ${cm.name}: ${n}`, { company: c, who: cm.name, color: cm.color, tag: 'officer' }); }
  const res = pnl(h, k, ok, why, pay + bonus > 0 ? pay : 0, bonus, back);
  m.result = res;
  if (co) { const log = (co.milLog ??= []); log.push({ ...res, id: k.id, title: k.title, type: m.type }); if (log.length > MIL.history) log.splice(0, log.length - MIL.history); }
  k.expires = Math.min(k.expires, h.time);   // the board forgets it a few minutes later; the result stays in milLog
  const cr = (n: number) => Math.round(n).toLocaleString();
  if (ok) h.ev('money', `계약 완수: ${k.title} — 기본 +${cr(pay)} · 성과 +${cr(bonus)} cr (전투 현상금 별도 ${cr(res.bounty)}) · 작전 순손익 ${res.net >= 0 ? '+' : ''}${cr(res.net)} cr${xpTxt}`, { company: c, pos: w.stations[k.stationId]?.pos, tag: 'mil' });
  else h.ev(voided ? 'info' : 'warn', `계약 ${voided ? '무효' : quit ? '포기' : '실패'}: ${k.title} — ${why}${voided ? ' (예치금 반환, 신용 불이익 없음)' : m.poster ? '' : ' (신용도·발주 세력 신뢰도 하락)'} · 작전 순손익 ${res.net >= 0 ? '+' : ''}${cr(res.net)} cr`, { company: c, tag: 'mil' });
  if (m.poster && w.companies[m.poster]) h.ev(ok ? 'info' : 'warn', `호위 의뢰 ${ok ? '완료' : '종료'}: ${k.title} — ${why}${ok ? ` (지급 ${cr(out)} cr${back ? `, 반환 ${cr(back)} cr` : ''})` : back ? ` (예치금 ${cr(back)} cr 반환)` : ''}`, { company: m.poster, tag: 'mil' });
  if (ok && co && !co.milestones.includes('first_contract')) h.milestone(co, 'first_contract');
  if (ok && co && !co.milestones.includes('first_mil')) co.milestones.push('first_mil');
  if (co) milFirstProfit(h, co);
  restorePriorOrder(h, k);
}

/** B-2 first business of a security / veteran start: a completed military contract, then cash above the founding funds */
export const MIL_FIRST_BG = ['security', 'veteran'] as const;
export const milFirstOn = (co: Company | undefined) => !!co?.background && (MIL_FIRST_BG as readonly string[]).includes(co.background);
export function milFirstReached(co: Company): boolean {
  if (!milFirstOn(co) || co.milestones.includes('first_profit') || !co.milestones.includes('first_mil')) return false;
  return co.credits > (BACKGROUND[co.background!]?.credits ?? Infinity) && !(co.upkeep?.debt ?? 0);
}
export function milFirstProfit(h: Host, co: Company) {
  if (!milFirstReached(co)) return;
  co.milestones.push('first_profit');
  h.ev('milestone', `첫 사업 성공: 군사 계약으로 자금 ${Math.round(BACKGROUND[co.background!]?.credits ?? 0).toLocaleString()} → ${Math.round(co.credits).toLocaleString()} cr — 운영비를 빼고도 창업 자금보다 늘었습니다`, { company: co.id });
}

function bookMil(h: Host, owner: string, cat: string, delta: number) { book(h, owner, cat, delta); }

/** the operation's own P&L: contract pay and battle bounties against repair of the damage taken, ships lost,
 *  the fleet's share of running costs and its commander's salary for the time of the contract */
function pnl(h: Host, k: Contract & { mil: MilTerms }, ok: boolean, why: string, pay: number, bonus: number, refund: number): MilResult {
  const w = h.st, m = k.mil, c = k.takenBy!, co = w.companies[c];
  const dur = Math.max(0, h.time - (m.t0 ?? h.time)), hrs = dur / 3600;
  let repair = 0, lost = 0, lostShips = 0;
  for (const s0 of m.snap ?? []) {
    const s = w.ships[s0.id];
    if (!s || s.owner !== c) { lost += s0.worth; lostShips++; continue; }
    const now = repairQuote(w, s, co).cost, then = repairQuote(w, { ...s, hp: s0.hp }, co).cost;
    repair += Math.max(0, now - then);
  }
  let upkeep = 0, salary = 0;
  if (co) {
    const f = forecast(w, co), all = Object.values(w.ships).filter(s => s.owner === c && s.classId !== 'platform').length;
    const n = (m.snap ?? []).length - lostShips;
    upkeep = Math.round((f.perHour - f.officers) * (all ? Math.max(0, n) / all : 0) * hrs);
    const g = m.group ? w.groups[m.group] : undefined;
    const line = g?.commanderId ? payroll(w, c).lines.find(l => l.id === g.commanderId) : undefined;
    salary = Math.round((line?.perHour ?? 0) * hrs);
  }
  const bounty = Math.round(m.bounty ?? 0);
  const net = pay + bonus + bounty - repair - lost - upkeep - salary;
  return { ok, why, at: h.time, dur, pay, bonus, refund, bounty, repair: Math.round(repair), lost: Math.round(lost), lostShips, upkeep, salary, net: Math.round(net) };
}

// ───────────────────────────────────────────────────────────── views (shared with the client)

export interface MilProgress { label: string; frac: number; detail: string }
/** where a taken contract stands (pure; used by the client panel and the tests) */
export function milProgress(w: WorldState, k: Contract & { mil: MilTerms }): MilProgress {
  const m = k.mil;
  switch (m.type) {
    case 'patrol': { const v = m.visits ?? []; const need = v.length * MIL.loops, done = v.reduce((a, x) => a + Math.min(MIL.loops, x), 0); const d = m.duty ?? 0; return { label: '순찰', frac: Math.min(1, (Math.min(1, d / (m.dur || 1)) + done / Math.max(1, need)) / 2), detail: `근무 ${Math.floor(d / 60)}/${Math.round((m.dur ?? 0) / 60)}분 · 경유 ${done}/${need}회 (${MIL.loops}바퀴) · 탐지 ${m.seen?.length ?? 0} · 교전 ${m.battles?.length ?? 0}` }; }
    case 'defend': { const d = m.duty ?? 0; return { label: '방어', frac: Math.min(1, d / (m.dur || 1)), detail: `배치 ${Math.floor(d / 60)}/${Math.round((m.dur ?? 0) / 60)}분 · 탐지 ${m.seen?.length ?? 0} · 격퇴 ${m.repelled ?? 0}` }; }
    case 'escort': { const c = m.cover ?? [0, 0]; return { label: '호위', frac: m.joined ? (m.sailed ? 0.5 : 0.25) : 0.1, detail: !m.joined ? `호위 합류 대기 (보호 대상 ${w.stations[m.from ?? '']?.name ?? ''} 정박)` : `${w.stations[m.dest ?? '']?.name ?? '목적지'}로 이동 · 호위율 ${c[1] ? Math.round(c[0] / c[1] * 100) : 100}% · 격퇴 ${m.repelled ?? 0}` }; }
    case 'hunt': case 'strike': {
      if (m.target?.startsWith('lane:')) return { label: '항로 확보', frac: Math.min(1, (m.killV ?? 0) / (m.quota || 1)), detail: `격침 몫 ${Math.round(m.killV ?? 0)}/${m.quota}` };
      return { label: MIL_NAME[m.type], frac: m.battles?.length ? 0.6 : 0.2, detail: `대상 ${m.tname ?? ''} · 교전 ${m.battles?.length ?? 0}회` };
    }
  }
}

/** expected profit of a contract for a fleet of `power` (UI): pay range minus running cost for the expected time */
export function milOutlook(m: MilTerms, upkeepPerHour: number) {
  const hrs = m.est / 3600;
  const cost = Math.round(upkeepPerHour * hrs);
  return { min: m.base - cost, max: m.base + m.bonus - cost, cost, hrs, risk: m.risk < 1.3 ? '낮음' : m.risk < 1.8 ? '보통' : m.risk < 2.6 ? '높음' : '매우 높음' };
}

// ───────────────────────────────────────────────────────────── the contract screen / first-business guide (pure)

export interface MilFleet { id: string; name: string; ships: number; power: number; full: number; hp: number; where: string; sys?: string; docked: boolean; busy?: string; officer?: { name: string; level: number; top: string } }
export interface MilOffer {
  id: string; type: MilType; title: string; desc: string; station: string; sys: string; jumps: number;
  base: number; bonus: number; power: number; est: number; risk: number; riskLabel: string;
  netMin: number; netMax: number; cost: number; fit: 'ok' | 'weak' | 'danger'; poster?: string; expires: number;
  /** why the offer is riskier than its strength suggests (e.g. an escort the fleet cannot reach in time) */
  warn?: string;
}
export interface MilActive { id: string; type: MilType; title: string; group?: string; fleet?: string; fleetStatus?: string; progress: MilProgress; left: number; base: number; bonus: number; bounty: number; poster?: string }
export interface MilGuide {
  first: boolean; done: boolean; start: number; credits: number; debt: number;
  steps: { id: string; label: string; done: boolean }[];
  fleets: MilFleet[]; board: MilOffer[]; active: MilActive[]; results: MilLogRow[]; posted: { id: string; title: string; taken: string | null; escrow: number }[];
  next: string[]; warnings: string[];
  totals: { pay: number; bonus: number; bounty: number; repair: number; lost: number; upkeep: number; salary: number; net: number; ok: number; fail: number };
}
const TREE_KO: Partial<Record<Tree, string>> = { command: '작전', intercept: '요격', airdef: '방공', gunnery: '포술', support: '군수', logistics: '물류', defense: '방어', ew: '전자전', maneuver: '기동' };

/** everything the military contract screen shows for company `me` (works on the client's world view) */
export function milGuide(w: WorldState, me: string): MilGuide | null {
  const co = w.companies[me]; if (!co || !milOn(w)) return null;
  const start = BACKGROUND[co.background ?? '']?.credits ?? 0;
  const ships = Object.values(w.ships).filter(s => s.owner === me);
  const sub = (g: WGroup): WShip[] => { const out: WShip[] = []; const walk = (x: WGroup, d: number) => { if (d > 8) return; for (const id of x.shipIds) { const s = w.ships[id]; if (s) out.push(s); } for (const c of x.childIds) { const y = w.groups[c]; if (y) walk(y, d + 1); } }; walk(g, 0); return out; };
  const mine = Object.values(w.contracts).filter(k => isMil(k) && !k.done && k.takenBy === me) as (Contract & { mil: MilTerms })[];
  const fleets: MilFleet[] = Object.values(w.groups).filter(g => g.owner === me && !g.parentId).map(g => {
    const all = sub(g).filter(s => econOf(s).military);
    if (!all.length) return null;
    const docked = all.every(s => s.state === 'docked');
    const s0 = all[0], st = s0.task.k === 'docked' ? w.stations[s0.task.station] : undefined;
    const sys = sysOfPos(w, s0.pos);
    const cm = g.commanderId ? w.commanders[g.commanderId] : undefined;
    const top = cm?.of ? (Object.entries(cm.of.mastery) as [Tree, number][]).sort((a, b) => b[1] - a[1])[0] : undefined;
    return { id: g.id, name: g.name, ships: all.length, power: Math.round(all.reduce((a, s) => a + shipValue(s.classId) * (0.4 + 0.6 * s.hp), 0)), full: milValue(all), hp: all.reduce((a, s) => a + s.hp, 0) / all.length,
      where: st ? `${st.name} 정박` : sys ? `${sys.name} ${all.some(s => s.state === 'battle') ? '교전 중' : '항행'}` : '', sys: sys?.id, docked, busy: mine.find(k => k.mil.group === g.id)?.title,
      ...(cm ? { officer: { name: cm.name, level: cm.level, top: top ? `${TREE_KO[top[0]] ?? top[0]} ${Math.round(top[1])}` : '' } } : {}) };
  }).filter(Boolean) as MilFleet[];
  // running cost per hour of one fleet (company running cost spread over its ships), for the expected-profit column
  const perShip = ships.length ? Math.max(0, co.upkeep?.bill?.perHour ?? 0) / ships.length : 0;
  const rate = (n: number) => perShip > 0 ? perShip * n : n * 450;
  const best = fleets.filter(f => !f.busy).sort((a, b) => b.power - a.power)[0];
  const homeSys = sysOfPos(w, (w.stations[co.homeStation] ?? Object.values(w.stations)[0]).pos)?.id;
  const from = best?.sys ?? homeSys;
  const board: MilOffer[] = (Object.values(w.contracts).filter(k => isMil(k) && !k.done && !k.takenBy && k.mil.poster !== me && k.expires > w.time) as (Contract & { mil: MilTerms })[]).map(k => {
    const m = k.mil, st = w.stations[k.stationId];
    const j = from && m.sys ? (from === m.sys ? 0 : jumps(w.systems, from, m.sys)) : 0;
    const o = milOutlook(m, rate(best?.ships ?? 3));
    const p = best?.power ?? 0;
    // a hunt / strike is a straight fight against a fixed band: below the recommended strength it is a coin flip
    // (profit runs: 0.87× lost 2 ships, 0.92× lost the whole fleet), so only full strength counts as a fit there.
    // The same holds on a high-risk lane (risk ≥ 2.5): an escort there met three pirate bands at once at 0.88×.
    const okAt = m.type === 'hunt' || m.type === 'strike' || m.risk >= 2.5 ? 1 : 0.85;
    let fit: MilOffer['fit'] = p >= m.power * okAt ? 'ok' : p >= m.power * 0.55 ? 'weak' : 'danger', warn: string | undefined;
    // an escort must reach the docked trader before it gives up waiting (joinMax): ~90 s per jump plus the approach
    const sj = from && st ? (() => { const ss = sysOfPos(w, st.pos)?.id; return ss ? (ss === from ? 0 : jumps(w.systems, from, ss)) : 0; })() : 0;
    if (m.type === 'escort' && !m.poster && Number.isFinite(sj) && sj * 90 + 120 > MIL.joinMax * 0.8) { warn = `합류 기한 ${Math.round(MIL.joinMax / 60)}분 — 함대가 ${sj}도약 떨어져 있어 늦으면 상선이 단독 출항합니다`; if (fit === 'ok') fit = 'weak'; }
    if ((m.type === 'hunt' || m.type === 'strike') && fit !== 'danger') warn = '해적 무리와의 정면 전투는 결과 편차가 큽니다 — 권장 전력을 넘겨도 함대를 잃을 수 있습니다';
    return { id: k.id, type: m.type, title: k.title, desc: k.desc, station: st?.name ?? k.stationId, sys: w.systems[m.sys]?.name ?? m.sys, jumps: Number.isFinite(j) ? j : 99,
      base: m.base, bonus: m.bonus, power: m.power, est: m.est, risk: m.risk, riskLabel: o.risk, netMin: o.min, netMax: o.max, cost: o.cost,
      fit, ...(warn ? { warn } : {}), ...(m.poster ? { poster: w.companies[m.poster]?.name ?? m.poster } : {}), expires: k.expires } as MilOffer;
  }).sort((a, b) => (a.fit === 'ok' ? 0 : a.fit === 'weak' ? 1 : 2) - (b.fit === 'ok' ? 0 : b.fit === 'weak' ? 1 : 2) || a.jumps - b.jumps || a.risk - b.risk).slice(0, 24);
  const active: MilActive[] = mine.map(k => { const g = k.mil.group ? w.groups[k.mil.group] : undefined; return { id: k.id, type: k.mil.type, title: k.title, group: g?.id, fleet: g?.name, fleetStatus: g?.status, progress: milProgress(w, k), left: Math.max(0, k.expires - w.time), base: k.mil.base, bonus: k.mil.bonus, bounty: Math.round(k.mil.bounty ?? 0), ...(k.mil.poster ? { poster: w.companies[k.mil.poster]?.name } : {}) }; });
  const results = [...(co.milLog ?? [])].reverse();
  const totals = results.reduce((t, r) => ({ pay: t.pay + r.pay, bonus: t.bonus + r.bonus, bounty: t.bounty + r.bounty, repair: t.repair + r.repair, lost: t.lost + r.lost, upkeep: t.upkeep + r.upkeep, salary: t.salary + r.salary, net: t.net + r.net, ok: t.ok + (r.ok ? 1 : 0), fail: t.fail + (r.ok ? 0 : 1) }), { pay: 0, bonus: 0, bounty: 0, repair: 0, lost: 0, upkeep: 0, salary: 0, net: 0, ok: 0, fail: 0 });
  const posted = (Object.values(w.contracts).filter(k => isMil(k) && !k.done && k.mil.poster === me) as (Contract & { mil: MilTerms })[]).map(k => ({ id: k.id, title: k.title, taken: k.takenBy ? w.companies[k.takenBy]?.name ?? k.takenBy : null, escrow: k.escrow ?? 0 }));
  const any = results.length > 0 || active.length > 0;
  const steps = [
    { id: 'pick', label: '계약 게시판에서 계약 고르기 · 투입 함대 지정(수주)', done: any },
    { id: 'sortie', label: '출격 · 현장 도착', done: active.some(a => a.progress.frac > 0.05) || results.length > 0 },
    { id: 'work', label: '임무 수행 (순찰·호위·방어·토벌)', done: results.some(r => r.ok) },
    { id: 'settle', label: '정산 — 보수·현상금·수리비·운영비', done: co.milestones.includes('first_mil') },
    { id: 'profit', label: '운영비를 뺀 첫 순이익 (창업 자금 초과)', done: co.milestones.includes('first_profit') },
  ];
  const next: string[] = [], warnings: string[] = [];
  for (const f of fleets) {
    if (f.hp < 0.75) next.push(`${f.name} 손상 (선체 평균 ${Math.round(f.hp * 100)}%) — 수리 시설이 있는 정거장에 정박해 수리한 뒤 재출격하세요. 손상된 함대는 전투력이 떨어집니다.`);
    else if (!f.busy && f.docked) next.push(`${f.name} 대기 중 — 전력 ${f.power} 이하 권장 계약을 고르면 안정적입니다.`);
  }
  const lost = results.filter(r => r.lostShips > 0);
  if (lost.length) {
    const yard = Object.values(w.stations).filter(s => s.public && s.services.shipyard.length).sort((a, b) => (sysOfPos(w, a.pos)?.id === homeSys ? 0 : 1) - (sysOfPos(w, b.pos)?.id === homeSys ? 0 : 1))[0];
    if (!fleets.length) next.push(`전투함을 모두 잃었습니다 — ${yard ? `${yard.name} 조선소에서` : '조선소에서'} 초계함(약 9,300 cr)이나 호위함(약 13,500 cr)을 사서 저위험 순찰·방어부터 다시 시작하세요. 자금이 부족하면 회사 본부의 회생 절차를 확인하세요.`);
    else next.push(`최근 작전에서 함선 ${lost.reduce((a, r) => a + r.lostShips, 0)}척 손실 — 남은 전력에 맞는 저위험 계약(순찰·방어·근거리 호위)으로 자금을 회복한 뒤 ${yard ? `${yard.name}에서` : ''} 보충하세요.`);
  }
  if (!active.length && board.some(b => b.fit === 'ok')) next.push(`지금 함대로 맡을 수 있는 계약 ${board.filter(b => b.fit === 'ok').length}건 — 위험이 낮은 순찰·방어는 수입이 안정적이고, 토벌·강습은 보수와 현상금이 크지만 손실 위험도 큽니다.`);
  if ((co.upkeep?.debt ?? 0) > 0) warnings.push(`운영비 미납 ${Math.round(co.upkeep!.debt).toLocaleString()} cr — 계약 보수에서 먼저 정산됩니다`);
  if (totals.fail >= 2 && totals.fail > totals.ok) warnings.push('실패한 계약이 많습니다 — 실패는 신용도와 발주 세력 신뢰도를 깎습니다. 권장 전력 이하의 계약은 피하세요.');
  return { first: milFirstOn(co), done: co.milestones.includes('first_profit'), start, credits: co.credits, debt: co.upkeep?.debt ?? 0, steps, fleets, board, active, results, posted, next, warnings, totals };
}
