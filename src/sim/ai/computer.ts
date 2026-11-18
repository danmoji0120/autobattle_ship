// P15.1 combat computers (BattleSetup.rules ≥ 2): the fitted computer drives one ship's own behaviour —
// engagement range, approach / withdrawal, line keeping, torpedo runs, cover — inside the order its
// commander (or the player) gave the group. The commander still decides the operation, target group,
// retreat, flanking and coordination; nothing here overrides move / hold / reserve / retreat, a flank's
// transit / staging or an escort assignment (a picket computer guards *within* an escort order).
//
// A ship without a computer (or with the built-in basic one, or a computer whose behaviour its weapons
// cannot carry out) keeps the legacy steering of commander.ts. Engagement ranges come from the weapons a
// ship can actually use right now (ammunition, disabled mounts, arcs) as explicit min / median / max bands,
// never a plain average. docs/P15_1_COMBAT_COMPUTERS.md
import { Vec3, UP, clamp } from '../math';
import type { World } from '../world';
import type { Group, Ship, Order, Mount } from '../types';
import type { WeaponDef } from '../data/weapons';

/** behaviour archetypes. 'carrier' (P16.3) needs strike craft in the battle (rules ≥ 3); without them it fights as basic. */
export type CpuArch = 'basic' | 'swarm' | 'picket' | 'line' | 'artillery' | 'siege' | 'carrier';
export const CPU_ARCHS: CpuArch[] = ['basic', 'swarm', 'picket', 'line', 'artillery', 'siege', 'carrier'];
/** archetypes with a working behaviour in this build */
export const CPU_ACTIVE: CpuArch[] = ['swarm', 'picket', 'line', 'artillery', 'siege', 'carrier'];

/** what a battle needs to know about a fitted computer (ShipSpec.cpu): serialised with the setup, so a
 *  replay never depends on the content tables. Product id and archetype are separate on purpose. */
export interface CpuSpec {
  /** product (EQUIPMENT id) — labels and statistics only */
  id: string;
  arch: CpuArch;
  /** re-decision interval in seconds (cheap computers react slower); default 1 */
  react?: number;
}

export const CPU_NAME: Record<CpuArch, string> = { basic: '기본 제어', swarm: '군집·돌격', picket: '초계', line: '전열', artillery: '포격', siege: '공성·뇌격', carrier: '항모' };
/** one-line tactic summary (fitting UI) */
export const CPU_TACTIC: Record<CpuArch, string> = {
  basic: '함대 대형·지휘관 교전 거리를 그대로 따름',
  swarm: '주무장 최단 사거리 안쪽까지 접근, 표적 주위를 선회하며 재접근',
  picket: '유효 사거리 중앙값 · 보호 함선 곁에서 근접 위협·미사일·초계함 우선 대응',
  line: '유효 사거리 중앙값 · 전열 정렬과 화력각 유지, 같은 표적에 지속 사격',
  artillery: '주무장 최장 사거리 · 접근당하면 거리를 벌리고 측방 이동',
  siege: '대형함에 어뢰 사거리까지 돌입, 측후방 발사각 확보 후 이탈·재진입',
  carrier: '적 함포 사거리 밖·비행대 작전 반경 안을 유지, 접근·유도탄에 회피, 호위 함대와 이격 제한 (함재기 없으면 기본 제어)',
};
/** which band of the usable weapons sets the range (UI) */
export const CPU_BAND: Record<CpuArch, string> = { basic: '함대 기준', swarm: '최소', picket: '중앙값', line: '중앙값', artillery: '최대', siege: '어뢰', carrier: '작전 반경' };

/** usable weapon ranges of a ship right now. min / median / max are taken over the attack weapons
 *  (shell, missile, torpedo) that can still fire and bear forward, weighted by damage per second;
 *  a band only counts weapons carrying a real share (≥ 20 %) of that firepower, so one small long-range
 *  mount does not decide where a ship fights. */
export interface Bands { min: number; med: number; max: number; pd: number; torp: number; dps: number; unguided: boolean; offset: number; /** share of attack firepower bearing on a beam */ broad: number }

interface CpuState {
  spec: CpuSpec;
  arch: CpuArch;
  react: number;
  /** next re-decision (targets, threats, bands) */
  next: number;
  bands: Bands | null;
  sig: number;
  /** swarm orbit / siege attack side */
  side: number;
  /** siege state machine */
  mode: 'approach' | 'break';
  point: Vec3;
  timer: number;
  /** siege: the tubes were loaded on the last look (a launch is loaded → empty) */
  armed: boolean;
  /** facing point owned by this computer (no allocation per steer) */
  face: Vec3;
  /** picket: protected ship and the threat it is facing */
  guard: number; threat: number;
  /** last computer-chosen target (statistics) */
  pick: number;
  /** behaviour actually applied on the last steer (statistics / UI): the archetype or 'basic' (fallback / order) */
  acting: CpuArch;
  /** siege statistics */
  launches: number; breaks: number; reentries: number;
  /** P16.3 carrier: evasive turns (pressed by guns or a guided round inbound) and the stand-off distance chosen */
  evades: number; standoff: number;
}
export type ShipCpu = CpuState;

export function initCpu(spec: CpuSpec, id: number): ShipCpu {
  return {
    spec, arch: spec.arch, react: clamp(spec.react ?? 1, 0.3, 4), next: 0, bands: null, sig: -1,
    side: id % 2 ? 1 : -1, mode: 'approach', point: new Vec3(), timer: 0, armed: false, face: new Vec3(), guard: -1, threat: -1, pick: -1, acting: 'basic',
    launches: 0, breaks: 0, reentries: 0, evades: 0, standoff: 0,
  };
}

const tmp = new Vec3(), tmp2 = new Vec3(), tmp3 = new Vec3();
const DEG = Math.PI / 180;

/** does a weapon facing `f` (rad, ship frame) with traverse `arc` (deg, half-angle) bear when the bow
 *  turns `offset` radians away from the target bearing */
function bearsAt(f: number, arc: number, offset: number): boolean {
  let a = Math.abs(f - offset) % (2 * Math.PI); if (a > Math.PI) a = 2 * Math.PI - a;
  return a <= arc * DEG + 0.1;
}
const usable = (m: Mount) => m.disabled <= 0 && m.ammo > 0 && !m.weapon.special;
const dpsOf = (w: WeaponDef) => w.damage * w.salvo / Math.max(0.05, w.reload);

/** one weapon as the band calculation sees it */
interface BandRow { w: WeaponDef; f: number; arc: number }
/** min / median / max bands over attack weapons (see Bands); `unguided` marks straight-running torpedoes */
export function bandsOf(rows: BandRow[], unguided: (w: WeaponDef) => boolean): Bands {
  // best facing: the bow offset (0, ±60°, ±90°) that brings the most attack firepower to bear
  let offset = 0, bestDps = -1, beam = 0, all = 0;
  const atk = rows.filter(r => r.w.kind !== 'pd' && r.w.kind !== 'craft');
  for (const off of [0, 60 * DEG, -60 * DEG, 90 * DEG, -90 * DEG]) {
    let d = 0; for (const r of atk) if (bearsAt(r.f, r.arc, off)) d += dpsOf(r.w);
    if (d > bestDps * 1.15) { bestDps = d; offset = off; }
    if (Math.abs(off) > 80 * DEG) beam = Math.max(beam, d);
  }
  for (const r of atk) all += dpsOf(r.w);
  const list: { r: number; d: number }[] = [];
  let pd = 0, torp = 0, total = 0, ung = false;
  for (const r of rows) {
    if (r.w.kind === 'pd') { pd = Math.max(pd, r.w.range); continue; }
    if (r.w.kind === 'craft') continue;   // P16: strike craft are not a gun band
    if (!bearsAt(r.f, r.arc, offset) && r.arc < 170) continue;
    const d = dpsOf(r.w);
    if (r.w.kind === 'torpedo') { torp = Math.max(torp, r.w.range); if (unguided(r.w)) ung = true; }
    list.push({ r: r.w.range, d }); total += d;
  }
  if (!list.length) return { min: 0, med: 0, max: 0, pd, torp: 0, dps: 0, unguided: false, offset: 0, broad: 0 };
  list.sort((a, b) => a.r - b.r);
  const real = list.filter(x => x.d >= total * 0.2);
  const band = real.length ? real : list;
  let acc = 0, med = band[band.length - 1].r;
  const bt = band.reduce((a, x) => a + x.d, 0);
  for (const x of band) { acc += x.d; if (acc >= bt / 2) { med = x.r; break; } }
  return { min: band[0].r, med, max: band[band.length - 1].r, pd, torp, dps: total, unguided: ung, offset, broad: all > 0 ? beam / all : 0 };
}

/** weapon bands from the mounts a ship can use now (see Bands) */
export function weaponBands(w: World, s: Ship): Bands {
  const rows: BandRow[] = [];
  for (const m of s.mounts) if (usable(m)) rows.push({ w: m.weapon, f: Math.atan2(m.facingLocal.x, m.facingLocal.z), arc: m.def.arc });
  return bandsOf(rows, x => w.unguided(x));
}

/** the distance a computer aims to fight at with these bands (UI and the behaviours below agree) */
export function cpuRange(arch: CpuArch, b: Bands): number | null {
  switch (arch) {
    case 'swarm': return b.dps > 0 ? b.min * 0.6 : null;
    case 'line': return b.dps > 0 ? b.med * 0.88 : null;
    case 'picket': return b.dps > 0 ? b.med * 0.85 : b.pd > 0 ? b.pd * 0.45 : null;
    case 'artillery': return b.dps > 0 ? b.max * 0.9 : null;
    case 'siege': return b.torp > 0 ? b.torp * (b.unguided ? 0.55 : 0.85) : null;
    default: return null;
  }
}

/** compact UI line for a fitted computer on a set of weapons: tactic, aim distance, band */
export function cpuSummary(arch: CpuArch, mounts: { weapon: string; facing: number; arc: number }[], weapons: Record<string, WeaponDef>, react?: number): string {
  const b = bandsOf(mounts.filter(m => weapons[m.weapon]).map(m => ({ w: weapons[m.weapon], f: m.facing * DEG, arc: m.arc })), x => !!x.p15?.unguided);
  const r = cpuRange(arch, b);
  const pace = react !== undefined && react !== 1 ? ` · 판단 ${react}초` : '';
  if (arch === 'basic' || arch === 'carrier') return `${CPU_NAME[arch]} — ${CPU_TACTIC[arch]}`;
  if (r === null) return `${CPU_NAME[arch]} — 맞는 무장 없음: 기본 제어로 동작`;
  return `${CPU_NAME[arch]} · 교전 ≈${Math.round(r)}m (${CPU_BAND[arch]}${arch === 'siege' ? '' : ` ${Math.round(arch === 'swarm' ? b.min : arch === 'artillery' ? b.max : b.dps > 0 ? b.med : b.pd)}m`})${pace} — ${CPU_TACTIC[arch]}`;
}

/** a cheap signature of the usable mounts: bands are recomputed when it changes */
function mountSig(s: Ship): number {
  let h = 0; s.mounts.forEach((m, i) => { if (usable(m)) h = (h * 31 + i + 1) | 0; }); return h;
}

/** may the computer move this ship under the group's current order? (orders always come first) */
export function orderAllows(g: Group, o: Order, arch: CpuArch): boolean {
  switch (o.type) {
    case 'engage': case 'attack': return true;
    case 'flank': return g.ai.phase === 'strike';
    case 'escort': return arch === 'picket';
    default: return false;   // move / hold / reserve / retreat
  }
}

/** torpedo launch distance factor of a siege computer (World.torpRangeFactor) */
export function cpuLaunchFactor(s: Ship): number | undefined {
  if (s.cpu?.acting !== 'siege') return undefined;
  return s.cpu.bands?.unguided ? 0.55 : 0.85;
}

/** do this ship's guns pick their own targets (threat-first) instead of following the assigned target? */
export function cpuOwnGuns(s: Ship, legacy: boolean): boolean {
  switch (s.cpu?.acting) {
    case 'picket': return true;                  // every gun covers: threats first
    case 'swarm': return false;                  // everything on the assigned target
    default: return legacy;
  }
}
/** PD cover radius / bonus for rounds aimed at a friend (picket computers guard their neighbours) */
export function cpuPdCover(s: Ship): { radius: number; bonus: number } | null {
  return s.cpu?.acting === 'picket' ? { radius: 1100, bonus: 140 } : null;
}

/** P15.1: apply the fitted computers of a group's ships after the legacy steering (rules ≥ 2) */
export function steerComputers(w: World, g: Group, ships: Ship[], o: Order) {
  // usable-weapon bands: on every re-decision and whenever a mount runs dry / is knocked out / recovers
  for (const s of ships) {
    const c = s.cpu; if (!c) continue;
    const sig = mountSig(s);
    if (sig !== c.sig || !c.bands || w.time >= c.next) { c.bands = weaponBands(w, s); c.sig = sig; }
  }
  let lineShips: Ship[] | null = null;
  for (const s of ships) {
    const c = s.cpu;
    if (!c) continue;
    c.acting = 'basic';
    const decide = w.time >= c.next;
    if (decide) c.next = w.time + c.react;
    if (!orderAllows(g, o, c.arch)) continue;
    const b = c.bands!;
    // fallbacks: no weapons for this behaviour → the legacy steering already set this tick stays
    if (c.arch === 'basic') continue;
    // P16.3: a carrier computer runs only when the battle flies this ship's strike craft (rules ≥ 3)
    if (c.arch === 'carrier') { if (carrier(w, g, s, decide)) c.acting = 'carrier'; continue; }
    if (c.arch === 'siege' && b.torp <= 0) continue;
    if (c.arch !== 'picket' && b.dps <= 0) continue;
    if (c.arch === 'picket' && b.dps <= 0 && b.pd <= 0) continue;
    const t = targetOf(w, s);
    switch (c.arch) {
      case 'swarm': if (t) { swarm(w, s, t, b); c.acting = 'swarm'; } break;
      case 'artillery': if (t) { artillery(w, s, t, b); c.acting = 'artillery'; } break;
      case 'line': {
        lineShips ??= ships.filter(x => x.cpu?.arch === 'line' && x.cpu.bands!.dps > 0);
        if (line(w, g, s, lineShips, b)) c.acting = 'line';
        break;
      }
      case 'picket': if (picket(w, g, s, o, b, decide)) c.acting = 'picket'; break;
      case 'siege': if (siege(w, g, s, o, b, decide)) c.acting = 'siege'; break;
    }
  }
}

function targetOf(w: World, s: Ship): Ship | null {
  const t = w.shipById.get(s.ai.targetId);
  return t && t.state === 'alive' && w.hostile(s.team, t.team) ? t : null;
}

/** the facing that brings the computed bow offset onto the target */
function faceWithOffset(s: Ship, at: Vec3, offset: number, out: Vec3): Vec3 {
  if (!offset) return out.copy(at);
  const dx = at.x - s.pos.x, dz = at.z - s.pos.z;
  const c = Math.cos(-offset), n = Math.sin(-offset);
  // rotate the bearing about UP so the side battery, not the bow, points at the target
  return out.set(s.pos.x + dx * c + dz * n, at.y, s.pos.z - dx * n + dz * c);
}

// ------------------------------------------------------------------ swarm
// close inside the shortest real weapon band and keep moving there — never a straight ram. Ships whose
// guns bear on the beam circle the target (alternating direction); bow-armed ships make strafing passes:
// run in past the target's side with the guns on it, extend out, turn and come again from the other side.
function swarm(w: World, s: Ship, t: Ship, b: Bands) {
  const c = s.cpu!;
  const R = Math.max(t.radius + s.radius + 60, cpuRange('swarm', b)!);
  const to = tmp.subVectors(s.pos, t.pos); to.y *= 0.3;
  const d = to.length();
  if (d < 1) to.copy(t.fwd).scale(-1); else to.scale(1 / d);
  const tang = tmp2.crossVectors(UP, to).normalize().scale(c.side);
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  if (b.broad >= 0.5) {
    if (d > R * 1.6) s.ai.moveTo.copy(t.pos).addScaled(to, R).addScaled(tang, R * 0.8);          // slanted approach onto the orbit
    else if (d < R * 0.55) {                                                                       // pressed: extend and come round
      s.ai.moveTo.copy(t.pos).addScaled(to, R * 1.4).addScaled(tang, R * 0.6);
      if (w.time >= c.timer) { c.side = -c.side; c.timer = w.time + 8; }
    } else s.ai.moveTo.copy(t.pos).addScaled(to, R).addScaled(tang, R * 0.9);                     // orbit: a point ahead on the circle
    s.ai.moveTo.y = t.pos.y + c.side * 20;
    s.ai.faceTo = null;   // bow along the orbit: the beam batteries bear
    return;
  }
  if (c.mode === 'approach') {
    if (d > R * 1.7) {
      s.ai.moveTo.copy(t.pos).addScaled(to, R).addScaled(tang, R * 0.5);
      s.ai.faceTo = t.pos;
    } else {
      // strafing run: aim just beside the target so the bow guns bear the whole way in
      s.ai.moveTo.copy(t.pos).addScaled(t.vel, d / 500).addScaled(tang, t.radius + s.radius + 30);
      s.ai.faceTo = c.face.copy(t.pos).addScaled(t.vel, d / 900);
    }
    if (d < Math.max(R * 0.3, t.radius + s.radius + 50) || (c.timer > 0 && w.time >= c.timer)) {
      c.mode = 'break'; c.breaks++; c.timer = w.time + 7;
      const out = tmp3.copy(s.vel); out.y = 0; if (out.lengthSq() < 1) out.copy(s.fwd); out.normalize();
      c.point.copy(t.pos).addScaled(out, R * 1.25).addScaled(tmp2.crossVectors(out, UP).normalize(), c.side * R * 0.6);
      c.point.y = t.pos.y + c.side * 30;
    }
  } else {
    s.ai.moveTo.copy(c.point);
    s.ai.faceTo = null;
    if (s.pos.distTo(c.point) < 120 || w.time >= c.timer) { c.mode = 'approach'; c.side = -c.side; c.reentries++; c.timer = w.time + 25; }
  }
}

// -------------------------------------------------------------- artillery
// hold at the longest real band; when the enemy closes, turn away to open the range and sidestep, then
// turn back to fire.
function artillery(w: World, s: Ship, t: Ship, b: Bands) {
  const c = s.cpu!;
  const R = cpuRange('artillery', b)!;
  const away = tmp.subVectors(s.pos, t.pos); away.y *= 0.3;
  const d = away.length();
  if (d < 1) away.copy(t.fwd); else away.scale(1 / d);
  const side = tmp2.crossVectors(UP, away).normalize().scale(c.side);
  // the closest enemy matters, not just the assigned target
  let near = d;
  for (const e of w.ships) if (e.state === 'alive' && w.hostile(s.team, e.team)) { const de = e.pos.distTo(s.pos); if (de < near) near = de; }
  if (near < R * (c.mode === 'break' ? 0.92 : 0.78)) {
    // pressed: open the range at full speed, slanted sideways (no turning to shoot until clear)
    c.mode = 'break';
    s.ai.moveTo.copy(s.pos).addScaled(away, R * 0.8).addScaled(side, R * 0.45);
    s.ai.faceTo = null;
  } else if (d > R * 1.08) {
    c.mode = 'approach';
    s.ai.moveTo.copy(t.pos).addScaled(away, R).addScaled(side, 40);
    s.ai.faceTo = faceWithOffset(s, t.pos, b.offset, c.face);
  } else {
    // in the band: hold and drift sideways to spoil the enemy's solution
    c.mode = 'approach';
    s.ai.moveTo.copy(t.pos).addScaled(away, R).addScaled(side, R * 0.25);
    s.ai.faceTo = faceWithOffset(s, t.pos, b.offset, c.face);
    if (w.time >= c.timer) { c.side = -c.side; c.timer = w.time + 14; }
  }
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
}

// ------------------------------------------------------------------- line
// line ships of the group form one line abreast at their median band from the target group, keep
// station at the pace of the slowest line ship, and keep their best firing arc on the line's target.
function line(w: World, g: Group, s: Ship, mates: Ship[], b: Bands): boolean {
  const T = g.ai.mainTarget >= 0 ? w.groupById.get(g.ai.mainTarget) : undefined;
  const ts = T ? w.subtreeShips(T) : [];
  if (!ts.length) return false;
  const Tc = w.centroid(ts, new Vec3());
  const C = w.centroid(mates, new Vec3());
  // P15.1.1: a mixed line stands where EVERY member's median band reaches (the shortest median), not at
  // the middle value — that left shorter-ranged members holding station out of their own gun range
  const R = Math.min(...mates.map(x => x.cpu!.bands!.med)) * 0.88;
  const away = tmp.subVectors(C, Tc); away.y *= 0.3;
  if (away.lengthSq() < 1) away.copy(w.sides[s.team].home);
  away.normalize();
  const right = tmp2.crossVectors(away, UP).normalize();
  const spacing = Math.max(...mates.map(x => x.radius)) * 7 + 40;
  const sorted = mates.slice().sort((a, b2) => (a.pos.x - C.x) * right.x + (a.pos.z - C.z) * right.z - ((b2.pos.x - C.x) * right.x + (b2.pos.z - C.z) * right.z));
  const i = sorted.indexOf(s);
  const lat = (i - (sorted.length - 1) / 2) * spacing;
  s.ai.moveTo.copy(Tc).addScaled(away, R).addScaled(right, lat);
  s.ai.moveTo.y = Tc.y * 0.3 + C.y * 0.7;
  // station keeping: the line moves at its slowest ship's pace unless a ship is far out of its slot
  const pace = Math.min(...mates.map(x => x.maxSpeed * (x.crit.engine > 0 ? 0.5 : 1)));
  s.ai.speedCap = s.pos.distTo(s.ai.moveTo) > 350 ? s.maxSpeed : pace * 1.02;
  const t = targetOf(w, s);
  s.ai.faceTo = faceWithOffset(s, t ? t.pos : Tc, b.offset, s.cpu!.face);
  s.ai.run = null;
  return true;
}

// ----------------------------------------------------------------- picket
// stay beside the ship it protects (the escort order's charge, else the most valuable friend nearby),
// between it and the closest threat; engage the threat (raiders, torpedo craft, anything closing) first.
function picket(w: World, g: Group, s: Ship, o: Order, b: Bands, decide: boolean): boolean {
  const c = s.cpu!;
  const reach = b.dps > 0 ? b.med : b.pd;
  if (decide || !w.shipById.get(c.guard) || w.shipById.get(c.guard)!.state !== 'alive') {
    c.guard = guardOf(w, s, o)?.id ?? -1;
    const at = w.shipById.get(c.guard) ?? s;
    c.threat = threatNear(w, s, at, reach)?.id ?? -1;
  }
  const guard = w.shipById.get(c.guard);
  const threat = w.shipById.get(c.threat);
  const thr = threat && threat.state === 'alive' ? threat : null;
  const assigned = targetOf(w, s);
  const playerTarget = o.type === 'attack' && o.targetShip !== undefined;
  if (thr && !playerTarget) { s.ai.targetId = thr.id; c.pick = thr.id; }
  const t = targetOf(w, s) ?? assigned;
  if (guard && guard.state === 'alive') {
    // between the protected ship and the threat, inside own PD / gun cover of it
    const toward = thr ?? t;
    const dir = toward ? tmp.subVectors(toward.pos, guard.pos) : tmp.copy(w.sides[s.team].face);
    dir.y = 0; if (dir.lengthSq() < 1) dir.copy(w.sides[s.team].face); dir.normalize();
    const side = tmp2.crossVectors(dir, UP).normalize().scale(c.side);
    const stand = guard.radius * 2.5 + clamp((b.pd || reach) * 0.45, 80, 320);
    s.ai.moveTo.copy(guard.pos).addScaled(dir, stand).addScaled(side, guard.radius * 2 + 40);
    s.ai.faceTo = toward ? toward.pos : null;
    s.ai.speedCap = s.maxSpeed;
  } else if (t) {
    // nothing to guard: hold the median band against the nearest threat
    const away = tmp.subVectors(s.pos, t.pos); away.y *= 0.3; if (away.lengthSq() < 1) away.copy(t.fwd); away.normalize();
    s.ai.moveTo.copy(t.pos).addScaled(away, Math.max(120, reach * 0.85));
    s.ai.faceTo = t.pos;
    s.ai.speedCap = s.maxSpeed;
  } else return false;
  s.ai.run = null;
  void g;
  return true;
}

/** the ship a picket protects: the escort order's charge (its most valuable ship), else the most
 *  valuable friendly ship within 1500 m that is worth more than the picket itself and is not a picket */
function guardOf(w: World, s: Ship, o: Order): Ship | null {
  let best: Ship | null = null, bv = s.value;
  if (o.type === 'escort') {
    const gg = w.groupById.get(o.guardGroup);
    for (const f of gg ? w.subtreeShips(gg) : []) if (f.value > (best?.value ?? -1)) best = f;
    if (best) return best;
  }
  for (const f of w.ships) {
    if (f === s || f.team !== s.team || f.state !== 'alive' || f.cpu?.arch === 'picket') continue;
    if (f.value <= bv || f.pos.distTo(s.pos) > 1500) continue;
    bv = f.value; best = f;
  }
  return best;
}

/** the most pressing enemy near a protected ship: raiders and torpedo carriers count as closer */
function threatNear(w: World, s: Ship, at: Ship, reach: number): Ship | null {
  let best: Ship | null = null, bd = Infinity;
  const lim = Math.max(700, reach * 1.6) + at.radius;
  for (const e of w.ships) {
    if (e.state !== 'alive' || !w.hostile(s.team, e.team)) continue;
    let d = e.pos.distTo(at.pos);
    if (d > lim) continue;
    if (e.role === 'raider') d *= 0.6;
    if (e.mounts.some(m => m.weapon.kind === 'torpedo' && m.ammo > 0)) d *= 0.7;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// ---------------------------------------------------------------- carrier
// P16.3. Keep out of every enemy's gun reach (+ a margin) while the enemy stays inside the air wing's operating
// radius, close to the friendly fleet (limited separation from the escorts). Pressed — an enemy has the carrier
// inside its reach, or a guided round is homing on it — the carrier turns away at full speed (evasion) and
// sidesteps a round's line of approach; back clear of reach it returns to its station.
const CARRIER_MARGIN = 220, CARRIER_SEP = 1100;
/** furthest a ship can hit with its usable guns, missiles and torpedoes (not point defence or craft) */
function gunReach(e: Ship): number {
  let r = 0;
  for (const m of e.mounts) if (usable(m) && m.weapon.kind !== 'pd' && m.weapon.kind !== 'craft' && m.weapon.range > r) r = m.weapon.range;
  return r;
}
function carrier(w: World, g: Group, s: Ship, decide: boolean): boolean {
  const c = s.cpu!;
  const wing = w.craft?.wings.find(x => x.ship === s);
  if (!wing) return false;
  // the radius the strike squadrons work in (interceptors stay close anyway)
  const strike = wing.squads.filter(q => q.cs.role !== 'interceptor');
  const R = Math.min(...(strike.length ? strike : wing.squads).map(q => q.cs.radius));
  const foes = w.aliveEnemyShips(s.team);
  if (!foes.length) return false;
  // pressed: inside some enemy's reach, or a guided round homing on this carrier close by
  let push = tmp.set(0, 0, 0), pressed = false, maxReach = 0, near: Ship | null = null, nd = Infinity;
  for (const e of foes) {
    const reach = gunReach(e), d = e.pos.distTo(s.pos);
    if (reach > maxReach) maxReach = reach;
    if (d < nd) { nd = d; near = e; }
    if (d < reach + (c.mode === 'break' ? CARRIER_MARGIN : 40)) { pressed = true; push.addScaled(tmp2.subVectors(s.pos, e.pos).normalize(), 1 + (reach - d) / Math.max(1, reach)); }
  }
  let inbound: { x: number; z: number } | null = null;
  for (const mu of w.munitions) {
    if (mu.dead || mu.kind === 'shell' || mu.targetId !== s.id || !w.hostile(s.team, mu.team)) continue;
    if (mu.pos.distTo(s.pos) < 900) { inbound = { x: mu.vel.x, z: mu.vel.z }; break; }
  }
  if (pressed || inbound) {
    if (c.mode !== 'break') { c.mode = 'break'; c.evades++; c.side = -c.side; }
    const away = push.lengthSq() > 1e-6 ? push.normalize() : tmp.subVectors(s.pos, near!.pos).normalize();
    away.y = 0;
    const side = tmp3.crossVectors(UP, away).normalize().scale(c.side);
    s.ai.moveTo.copy(s.pos).addScaled(away, 600).addScaled(side, inbound ? 450 : 200);
    if (inbound) {
      // beam the round: run across its line of approach
      const l = Math.hypot(inbound.x, inbound.z) || 1;
      s.ai.moveTo.x += -inbound.z / l * 350 * c.side; s.ai.moveTo.z += inbound.x / l * 350 * c.side;
    }
    s.ai.moveTo.y = s.pos.y;
    s.ai.faceTo = null;
    s.ai.speedCap = s.maxSpeed;
    s.ai.run = null;
    return true;
  }
  c.mode = 'approach';
  // station: the commander's target group (or the nearest enemy), at stand-off D, toward home
  const T = g.ai.mainTarget >= 0 ? w.groupById.get(g.ai.mainTarget) : undefined;
  const ts = T ? w.subtreeShips(T) : [];
  const ref = ts.length ? w.centroid(ts, new Vec3()) : near!.pos.clone();
  if (decide || !c.standoff) c.standoff = Math.max(500, Math.min(maxReach + CARRIER_MARGIN, R * 0.85));
  const away = tmp.subVectors(s.pos, ref); away.y = 0;
  if (away.lengthSq() < 1) away.copy(w.sides[s.team].home); away.y = 0; away.normalize();
  const P = s.ai.moveTo.copy(ref).addScaled(away, c.standoff);
  // keep within reach of the escorts: the friendly ships of the side, without the carrier itself
  const friends = w.ships.filter(f => f !== s && f.team === s.team && f.state === 'alive' && f.cpu?.arch !== 'carrier');
  if (friends.length) {
    const F = w.centroid(friends, new Vec3());
    const dx = P.x - F.x, dz = P.z - F.z, d = Math.hypot(dx, dz);
    if (d > CARRIER_SEP) { P.x = F.x + dx / d * CARRIER_SEP; P.z = F.z + dz / d * CARRIER_SEP; }
    // never pulled back inside the nearest enemy's reach by the escort limit
    const ne = near!, dn = Math.hypot(P.x - ne.pos.x, P.z - ne.pos.z), rn = gunReach(ne) + CARRIER_MARGIN * 0.5;
    if (dn < rn) { const k = rn / Math.max(1, dn); P.x = ne.pos.x + (P.x - ne.pos.x) * k; P.z = ne.pos.z + (P.z - ne.pos.z) * k; }
  }
  P.y = s.pos.y * 0.6 + ref.y * 0.4;
  s.ai.faceTo = s.pos.distTo(P) < 250 ? (near ? near.pos : null) : null;
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  return true;
}

// ------------------------------------------------------------------ siege
// pick the biggest hull in reach, run in to torpedo range on its beam / rear quarter (a solution the
// straight-running plasma torpedo can hit), point the tubes, launch, break away and re-enter when the
// tubes are loaded again. Magazine empty → basic steering.
function siege(w: World, g: Group, s: Ship, o: Order, b: Bands, decide: boolean): boolean {
  const c = s.cpu!;
  const tubes = s.mounts.filter(m => m.weapon.kind === 'torpedo' && m.disabled <= 0 && m.ammo > 0);
  if (!tubes.length) return false;
  const playerTarget = o.type === 'attack' && o.targetShip !== undefined;
  if (decide && !playerTarget) {
    const T = g.ai.mainTarget >= 0 ? w.groupById.get(g.ai.mainTarget) : undefined;
    let pool = T ? w.subtreeShips(T) : [];
    if (!pool.length) pool = w.aliveEnemyShips(s.team);
    let best: Ship | null = null, bs = -Infinity;
    for (const e of pool) {
      if (e.state !== 'alive') continue;
      const sc = e.value * (e.cls.structure ? 1.5 : 1) / (e.pos.distTo(s.pos) + 800);
      if (sc > bs) { bs = sc; best = e; }
    }
    if (best) { s.ai.targetId = best.id; c.pick = best.id; }
  }
  const t = targetOf(w, s);
  if (!t) return false;
  const L = cpuRange('siege', b)!;
  const ready = tubes.some(m => m.cooldown <= 0.4 || m.salvoLeft > 0);
  const d = s.pos.distTo(t.pos);
  const tLeft = tmp2.crossVectors(UP, t.fwd).normalize();
  // P15.1.1: leave the waiting station when the tubes will be loaded by the time the boat reaches launch
  // distance (not after they are loaded), so no time is spent running in with loaded tubes
  const reload = Math.min(...tubes.map(m => m.salvoLeft > 0 ? 0 : m.cooldown));
  const soon = ready || reload - 0.4 <= Math.max(0, d - L) / Math.max(1, s.maxSpeed * 0.6);
  if (c.mode === 'approach') {
    if (!soon && d > L * 1.4) {
      // tubes reloading: wait outside the run-in, on the chosen side
      s.ai.moveTo.copy(t.pos).addScaled(tLeft, c.side * L * 1.7).addScaled(t.fwd, -L * 0.4);
      s.ai.faceTo = t.pos;
    } else if (d > L * 1.25) {
      // run in toward the beam / rear quarter
      const q = tmp.copy(t.fwd).scale(-0.45).addScaled(tLeft, c.side).normalize();
      s.ai.moveTo.copy(t.pos).addScaled(q, L * 0.9);
      s.ai.faceTo = null;
    } else {
      // final run: point the tubes at the lead position
      const lead = d / Math.max(60, tubes[0].weapon.speed);
      s.ai.moveTo.copy(t.pos).addScaled(t.vel, lead);
      s.ai.faceTo = c.face.copy(s.ai.moveTo);
    }
    const fired = c.armed && !ready;
    c.armed = ready;
    if (fired || d < Math.max(140, L * 0.35)) {
      if (fired) c.launches++;
      // P15.1.1: break across the target's line of fire and outward on the boat's own side, not onward along
      // the run-in heading (which carried boats across the target's bow or stern into its secondary guns) and
      // not straight away (no crossing motion: an easy shot for the guns)
      c.mode = 'break'; c.breaks++; c.timer = w.time + 9;
      const away = tmp3.copy(s.pos).sub(t.pos); away.y = 0; if (away.lengthSq() < 1) away.copy(s.fwd).scale(-1); away.normalize();
      const lat = tmp.crossVectors(UP, away).normalize();
      if (lat.dot(tLeft) * c.side < 0) lat.scale(-1);
      c.point.copy(t.pos).addScaled(away, L * 1.1).addScaled(lat, L * 1.3);
      c.point.y = t.pos.y;
    }
  } else {
    c.armed = false;
    s.ai.moveTo.copy(c.point);
    s.ai.faceTo = null;
    // the break ends once the boat is clear of the launch band (or at the point / after the timer)
    if (d > L * 1.45 || s.pos.distTo(c.point) < 160 || w.time >= c.timer) { c.mode = 'approach'; c.side = -c.side; c.reentries++; }
  }
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  return true;
}
