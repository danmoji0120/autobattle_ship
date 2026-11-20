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
export type CpuArch = 'basic' | 'swarm' | 'picket' | 'line' | 'artillery' | 'siege' | 'carrier' | 'support' | 'missile' | 'flank';
export const CPU_ARCHS: CpuArch[] = ['basic', 'swarm', 'picket', 'line', 'artillery', 'siege', 'carrier', 'support', 'missile', 'flank'];
/** archetypes with a working behaviour in this build */
export const CPU_ACTIVE: CpuArch[] = ['swarm', 'picket', 'line', 'artillery', 'siege', 'carrier', 'support', 'missile', 'flank'];

/** P17.3f: product tuning of one archetype. Behaviour only — never a hull / weapon stat:
 *  range  — multiplier on the distance the archetype fights at (long-range vs close-assault products)
 *  volley — missile control: a ready launcher waits up to this many seconds for the ship's other
 *           launchers so the missiles leave together (one saturating wave instead of a trickle)
 *  guide  — missile control: mid-course guidance, multiplier on the turn rate of this ship's missiles
 *  cover  — air defence: radius (m) within which this ship's PD guards friends' incoming rounds
 *  energy — energy management: below this shield fraction the ship backs out of range to recharge */
export interface CpuTune { range?: number; volley?: number; guide?: number; cover?: number; energy?: number }

/** what a battle needs to know about a fitted computer (ShipSpec.cpu): serialised with the setup, so a
 *  replay never depends on the content tables. Product id and archetype are separate on purpose. */
export interface CpuSpec {
  /** product (EQUIPMENT id) — labels and statistics only */
  id: string;
  arch: CpuArch;
  /** re-decision interval in seconds (cheap computers react slower); default 1 */
  react?: number;
  /** P17.3f product tuning (CpuTune) */
  tune?: CpuTune;
}

export const CPU_NAME: Record<CpuArch, string> = { basic: '기본 제어', swarm: '군집·돌격', picket: '초계', line: '전열', artillery: '포격', siege: '공성·뇌격', carrier: '항모', support: '지원·수리', missile: '미사일 관제', flank: '측면 기동' };
/** one-line tactic summary (fitting UI) */
export const CPU_TACTIC: Record<CpuArch, string> = {
  basic: '함대 대형·지휘관 교전 거리를 그대로 따름',
  swarm: '주무장 최단 사거리 안쪽까지 접근, 표적 주위를 선회하며 재접근',
  picket: '유효 사거리 중앙값 · 보호 함선 곁에서 근접 위협·미사일·초계함 우선 대응',
  line: '유효 사거리 중앙값 · 전열 정렬과 화력각 유지, 같은 표적에 지속 사격',
  artillery: '주무장 최장 사거리 · 접근당하면 거리를 벌리고 측방 이동',
  siege: '대형함에 어뢰 사거리까지 돌입, 측후방 발사각 확보 후 이탈·재진입',
  carrier: '적 함포 사거리 밖·비행대 작전 반경 안을 유지, 접근·유도탄에 회피, 호위 함대와 이격 제한 (함재기 없으면 기본 제어)',
  support: '전열 뒤편에서 수리할 아군 곁(수리 사거리 안)을 유지, 적 함포 사거리에 들면 후퇴 (수리 장비 없으면 기본 제어)',
  missile: '미사일 최장 사거리 근처를 유지하며 접근당하면 이탈, 발사기를 맞춰 일제 발사 (미사일 없으면 기본 제어)',
  flank: '표적의 측면·후방 사분면으로 크게 돌아 들어가 약한 장갑면을 노림',
};
/** which band of the usable weapons sets the range (UI) */
export const CPU_BAND: Record<CpuArch, string> = { basic: '함대 기준', swarm: '최소', picket: '중앙값', line: '중앙값', artillery: '최대', siege: '어뢰', carrier: '작전 반경', support: '수리 사거리', missile: '미사일', flank: '중앙값' };

/** usable weapon ranges of a ship right now. min / median / max are taken over the attack weapons
 *  (shell, missile, torpedo) that can still fire and bear forward, weighted by damage per second;
 *  a band only counts weapons carrying a real share (≥ 20 %) of that firepower, so one small long-range
 *  mount does not decide where a ship fights. */
export interface Bands { min: number; med: number; max: number; pd: number; torp: number; dps: number; unguided: boolean; offset: number; /** share of attack firepower bearing on a beam */ broad: number; /** P17.3f longest missile range */ msl: number }

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
  /** P17.3.1 flank state machine (created on the first flank steer only, so no other computer changes) */
  fl?: FlankState;
}
/** P17.3.1 flank manoeuvre: approach → circle (persistent side, waypoints re-planned on a beat, not every tick) →
 *  engage on the beam / stern quarter; if the target turns its bow onto the flanker it either fights from the beam
 *  or opens the range and re-enters (reattack). Also its statistics (time by target aspect, attempts, failures). */
export interface FlankState {
  phase: 'approach' | 'circle' | 'engage' | 'reattack' | 'standoff';
  /** committed side of the target (+1 = its left / port, -1 = starboard) */
  side: number;
  /** current waypoint and when it is re-planned */
  wp: Vec3; replan: number;
  /** target yaw on the last look and its smoothed turn rate (rad/s) */
  tyaw: number; trate: number; at: number;
  /** time the phase began; time the target has kept its bow on us */
  since: number; faced: number;
  /** engage goal angle off the target's bow (rad): 135° stern quarter, 90° beam when settling for the side */
  goal: number;
  /** statistics: seconds with the flanker in the target's front / side / rear sector, seconds engaged */
  tFront: number; tSide: number; tRear: number; tEngage: number;
  /** circling attempts, successes (reached the quarter), failures by reason, waypoint re-plans, side switches */
  attempts: number; reached: number; fails: { faced: number; timeout: number }; replans: number; switches: number;
  /** target was busy with someone else while we closed (exploited distractions) */
  distracted: number;
  /** tightening steps of the circle after it failed against a target we can out-turn; target they apply to;
   *  gave up out-turning it (fights from the beam) */
  shrink: number; tid: number; noOut: boolean;
  /** stand-off fallback (no circle gets behind this target alone): times entered, seconds in it, of which
   *  fought bow-on at the median band (favourable) / held at the long band (unfavourable); flank attempts
   *  resumed from it (an ally drew the target's guns, or we gained the speed / turn edge); the target turn rate
   *  when out-turning it was given up (a slower target since then re-opens the try) */
  stands: number; tStand: number; tHead: number; tHold: number; resumes: number; noOutW: number;
  /** stand-off: fighting bow-on at the median band (favourable) rather than holding at the long band */
  head?: boolean;
  /** stand-off range held and when the stand-off assessment is next re-made */
  sr: number; sAt: number;
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
  const atk = rows.filter(r => r.w.kind !== 'pd' && r.w.kind !== 'craft' && r.w.kind !== 'repair');
  for (const off of [0, 60 * DEG, -60 * DEG, 90 * DEG, -90 * DEG]) {
    let d = 0; for (const r of atk) if (bearsAt(r.f, r.arc, off)) d += dpsOf(r.w);
    if (d > bestDps * 1.15) { bestDps = d; offset = off; }
    if (Math.abs(off) > 80 * DEG) beam = Math.max(beam, d);
  }
  for (const r of atk) all += dpsOf(r.w);
  const list: { r: number; d: number }[] = [];
  let pd = 0, torp = 0, total = 0, ung = false, msl = 0;
  for (const r of rows) {
    if (r.w.kind === 'pd') { pd = Math.max(pd, r.w.range); continue; }
    if (r.w.kind === 'missile') msl = Math.max(msl, r.w.range);
    if (r.w.kind === 'craft' || r.w.kind === 'repair') continue;   // P16: strike craft (P16.7: repair rigs) are not a gun band
    if (!bearsAt(r.f, r.arc, offset) && r.arc < 170) continue;
    const d = dpsOf(r.w);
    if (r.w.kind === 'torpedo') { torp = Math.max(torp, r.w.range); if (unguided(r.w)) ung = true; }
    list.push({ r: r.w.range, d }); total += d;
  }
  if (!list.length) return { min: 0, med: 0, max: 0, pd, torp: 0, dps: 0, unguided: false, offset: 0, broad: 0, msl };
  list.sort((a, b) => a.r - b.r);
  const real = list.filter(x => x.d >= total * 0.2);
  const band = real.length ? real : list;
  let acc = 0, med = band[band.length - 1].r;
  const bt = band.reduce((a, x) => a + x.d, 0);
  for (const x of band) { acc += x.d; if (acc >= bt / 2) { med = x.r; break; } }
  return { min: band[0].r, med, max: band[band.length - 1].r, pd, torp, dps: total, unguided: ung, offset, broad: all > 0 ? beam / all : 0, msl };
}

/** weapon bands from the mounts a ship can use now (see Bands) */
export function weaponBands(w: World, s: Ship): Bands {
  const rows: BandRow[] = [];
  for (const m of s.mounts) if (usable(m)) rows.push({ w: m.weapon, f: Math.atan2(m.facingLocal.x, m.facingLocal.z), arc: m.def.arc });
  return bandsOf(rows, x => w.unguided(x));
}

/** the distance a computer aims to fight at with these bands (UI and the behaviours below agree) */
export function cpuRange(arch: CpuArch, b: Bands, k = 1): number | null {
  const r = baseRange(arch, b);
  return r === null ? null : r * k;
}
function baseRange(arch: CpuArch, b: Bands): number | null {
  switch (arch) {
    case 'missile': return b.msl > 0 ? b.msl * 0.82 : null;
    case 'flank': return b.dps > 0 ? b.med * 0.8 : null;
    case 'swarm': return b.dps > 0 ? b.min * 0.6 : null;
    case 'line': return b.dps > 0 ? b.med * 0.88 : null;
    case 'picket': return b.dps > 0 ? b.med * 0.85 : b.pd > 0 ? b.pd * 0.45 : null;
    case 'artillery': return b.dps > 0 ? b.max * 0.9 : null;
    case 'siege': return b.torp > 0 ? b.torp * (b.unguided ? 0.55 : 0.85) : null;
    default: return null;
  }
}

/** compact UI line for a fitted computer on a set of weapons: tactic, aim distance, band */
export function cpuSummary(arch: CpuArch, mounts: { weapon: string; facing: number; arc: number }[], weapons: Record<string, WeaponDef>, react?: number, tune?: CpuTune): string {
  const b = bandsOf(mounts.filter(m => weapons[m.weapon]).map(m => ({ w: weapons[m.weapon], f: m.facing * DEG, arc: m.arc })), x => !!x.p15?.unguided);
  const r = cpuRange(arch, b, tune?.range ?? 1);
  const pace = react !== undefined && react !== 1 ? ` · 판단 ${react}초` : '';
  if (arch === 'basic' || arch === 'carrier' || arch === 'support') return `${CPU_NAME[arch]} — ${CPU_TACTIC[arch]}`;
  if (r === null) return `${CPU_NAME[arch]} — 맞는 무장 없음: 기본 제어로 동작`;
  return `${CPU_NAME[arch]} · 교전 ≈${Math.round(r)}m (${CPU_BAND[arch]}${arch === 'siege' ? '' : ` ${Math.round(arch === 'swarm' ? b.min : arch === 'artillery' ? b.max : arch === 'missile' ? b.msl : b.dps > 0 ? b.med : b.pd)}m`})${pace}${tuneText(tune)} — ${CPU_TACTIC[arch]}`;
}
/** UI words for a product's tuning */
export function tuneText(t?: CpuTune): string {
  if (!t) return '';
  const p: string[] = [];
  if (t.range !== undefined && t.range !== 1) p.push(`거리 ×${t.range}`);
  if (t.volley) p.push(`일제 발사 대기 ${t.volley}초`);
  if (t.guide) p.push(`유도 선회 ×${t.guide}`);
  if (t.cover) p.push(`방공 엄호 ${t.cover}m`);
  if (t.energy) p.push(`실드 ${Math.round(t.energy * 100)}% 미만 시 재충전 후퇴`);
  return p.length ? ` · ${p.join(' · ')}` : '';
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
    case 'escort': return arch === 'picket' || arch === 'support';
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
  const cov = s.cpu?.spec.tune?.cover;
  if (cov) return { radius: cov, bonus: 140 + cov * 0.04 };   // P17.3f air-defence products guard whatever their order
  return s.cpu?.acting === 'picket' ? { radius: 1100, bonus: 140 } : null;
}

/** P17.3f missile control: should this ready launcher wait for the ship's other launchers (volley)? */
export function cpuVolleyHold(s: Ship, m: Mount): boolean {
  const v = s.cpu?.spec.tune?.volley; if (!v) return false;
  for (const o of s.mounts) {
    if (o === m || o.weapon.kind !== 'missile' || !usable(o)) continue;
    if (o.cooldown > 0 && o.cooldown <= v) return true;
  }
  return false;
}
/** P17.3f missile control: turn-rate multiplier of this ship's guided rounds */
export const cpuGuide = (s: Ship): number => s.cpu?.spec.tune?.guide ?? 1;

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
    // P16.7: a support computer steers only a ship that carries combat repair rigs
    if (c.arch === 'support') { if (support(w, s)) c.acting = 'support'; continue; }
    if (c.arch === 'siege' && b.torp <= 0) continue;
    if (c.arch === 'missile' && b.msl <= 0) continue;
    // P17.3f energy management: a shielded ship whose shield runs low steps out of range to recharge
    if (c.spec.tune?.energy && s.maxShield && (s.shield ?? 0) < s.maxShield * c.spec.tune.energy) {
      const t0 = targetOf(w, s);
      if (t0 && recharge(w, s, t0, b)) { c.acting = c.arch; continue; }
    }
    if (c.arch !== 'picket' && c.arch !== 'missile' && b.dps <= 0) continue;
    if (c.arch === 'picket' && b.dps <= 0 && b.pd <= 0) continue;
    const t = targetOf(w, s);
    switch (c.arch) {
      case 'swarm': if (t) { swarm(w, s, t, b); c.acting = 'swarm'; } break;
      case 'artillery': if (t) { artillery(w, s, t, b, cpuRange('artillery', b, rk(s))!); c.acting = 'artillery'; } break;
      case 'missile': if (t) { artillery(w, s, t, b, cpuRange('missile', b, rk(s))!); c.acting = 'missile'; } break;
      // (battles recorded before P17.3.1 — BattleSetup.cpuV absent — re-run with the flank they were fought with)
      case 'flank': if (t) { if (w.cpuV >= 1) flank(w, s, t, b, o); else flankLegacy(w, s, t, b); c.acting = 'flank'; } break;
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

const rk = (s: Ship) => s.cpu?.spec.tune?.range ?? 1;

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
  const R = Math.max(t.radius + s.radius + 60, cpuRange('swarm', b, rk(s))!);
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
function artillery(w: World, s: Ship, t: Ship, b: Bands, R: number) {
  const c = s.cpu!;
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
  const R = Math.min(...mates.map(x => x.cpu!.bands!.med * rk(x))) * 0.88;
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
  for (const m of e.mounts) if (usable(m) && m.weapon.kind !== 'pd' && m.weapon.kind !== 'craft' && m.weapon.kind !== 'repair' && m.weapon.range > r) r = m.weapon.range;
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

// ---------------------------------------------------------------- support
// P16.7. A combat repair ship keeps behind its own line, near the friend its repair rigs are working on (or the one
// that needs it most), inside the rigs' reach but never in front of the friendly centre toward the enemy. Inside
// some enemy's gun reach it backs off (it carries almost no guns and is a priority target).
const SUPPORT_BACK = 160;
function support(w: World, s: Ship): boolean {
  let reach = 0;
  for (const m of s.mounts) if (m.weapon.kind === 'repair' && m.disabled <= 0 && m.weapon.range > reach) reach = m.weapon.range;
  if (!reach) return false;
  const foes = w.aliveEnemyShips(s.team);
  if (!foes.length) return false;
  const friends = w.ships.filter(f => f !== s && f.team === s.team && f.state === 'alive');
  if (!friends.length) return false;
  const F = w.centroid(friends, tmp3);
  let near: Ship = foes[0], nd = Infinity, pressed = false;
  const push = tmp.set(0, 0, 0);
  // back off only when exposed: inside an enemy's gun reach AND either in front of our own line (nearer that
  // enemy than the friendly centre is) or hit in the last few seconds. Behind the line it stays to work.
  const hitNow = w.time - (s.hitAt ?? -99) <= 3;
  for (const e of foes) {
    const d = e.pos.distTo(s.pos), gr = gunReach(e);
    if (d < nd) { nd = d; near = e; }
    if (d < gr + 60 && (hitNow || d < e.pos.distTo(F) - 50)) { pressed = true; push.addScaled(tmp2.subVectors(s.pos, e.pos).normalize(), 1 + (gr - d) / Math.max(1, gr)); }
  }
  // the axis from the enemy toward our own line
  const axis = tmp2.subVectors(F, near.pos); axis.y = 0;
  if (axis.lengthSq() < 1) axis.copy(w.sides[s.team].home);
  axis.normalize();
  if (pressed) {
    const away = push.lengthSq() > 1e-6 ? push.normalize() : axis;
    s.ai.moveTo.copy(s.pos).addScaled(away, 500); s.ai.moveTo.y = s.pos.y;
    s.ai.faceTo = null; s.ai.speedCap = s.maxSpeed; s.ai.run = null;
    return true;
  }
  // the friend to stay with: the rigs' current patient, else the most damaged friend
  let T = s.repTarget !== undefined ? w.shipById.get(s.repTarget) : undefined;
  if (!T || T.state !== 'alive' || T.team !== s.team) {
    let worst = -1;
    for (const f of friends) { const need = 1 - f.hp / f.maxHp + (f.crit.fire > 0 ? 0.3 : 0) + (f.crit.engine > 0 || f.crit.bridge > 0 ? 0.15 : 0); if (need > worst) { worst = need; T = f; } }
  }
  const P = s.ai.moveTo.copy(T!.pos).addScaled(axis, reach * 0.55);
  // never ahead of the friendly centre (toward the enemy)
  const ahead = (P.x - F.x) * -axis.x + (P.z - F.z) * -axis.z + SUPPORT_BACK;
  if (ahead > 0) P.addScaled(axis, ahead);
  P.y = s.pos.y * 0.5 + T!.pos.y * 0.5;
  s.ai.faceTo = null; s.ai.speedCap = s.maxSpeed; s.ai.run = null;
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
  const L = cpuRange('siege', b, rk(s))!;
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

// ------------------------------------------------------------------ flank (P17.3f, P17.3.1 rework)
// A state machine instead of one fixed aim point (the old one chased a point 135° off the target's bow, which a
// target that turns simply kept in front of itself):
//   approach  — close to about 1.4 × the band on the committed side's beam (never down the target's bow);
//   circle    — run round the target toward its beam / stern quarter on the committed side. The circle is
//               planned on the target's *predicted* heading (its measured turn rate × our travel time) and the
//               waypoint is re-planned on a beat (0.8 s), not every tick, so the ship does not dither;
//   engage    — hold the quarter at the band, guns on the target (broadside offset kept);
//   reattack  — the target turned its bow onto us: if we are already roughly abeam we settle for the beam;
//               otherwise open the range outward on our side and re-enter, switching side only when the target is
//               turning toward the side we were on.
// A target busy with an ally (its target is someone else) is approached tighter and straight for the stern.
// Nothing here changes speed, turn rate, the enemy, or how facing is judged (World.applyHit); orders gate it.
const FL_REPLAN = 0.8, FL_CIRCLE_MAX = 28, FL_FACED = 3, FL_REATTACK = 9, FL_STAND_MIN = 4;
function flank(w: World, s: Ship, t: Ship, b: Bands, o?: Order) {
  const c = s.cpu!;
  const R = Math.max(t.radius + s.radius + 80, cpuRange('flank', b, rk(s))!);
  let f = c.fl;
  if (!f) {
    f = c.fl = { phase: 'approach', side: c.side, wp: new Vec3().copy(s.pos), replan: 0, tyaw: t.yaw, trate: 0, at: w.time, since: w.time, faced: 0, goal: 135 * DEG,
      tFront: 0, tSide: 0, tRear: 0, tEngage: 0, attempts: 0, reached: 0, fails: { faced: 0, timeout: 0 }, replans: 0, switches: 0, distracted: 0, shrink: 0, tid: t.id, noOut: false,
      stands: 0, tStand: 0, tHead: 0, tHold: 0, resumes: 0, noOutW: 0, sr: 0, sAt: 0 };
  }
  // a commander's flank order names the side
  if (o?.type === 'flank' && f.side !== o.side) { f.side = o.side; f.switches++; }
  // target turn rate (smoothed) and heading
  let dy = t.yaw - f.tyaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI;
  // (the commander steers every few ticks: rates and times use the time since the last steer)
  const el = Math.max(1e-3, w.time - f.at); f.at = w.time;
  f.tyaw = t.yaw; f.trate += (dy / el - f.trate) * Math.min(1, el * 2);
  const tf = tmp.copy(t.fwd); tf.y = 0; if (tf.lengthSq() < 1e-6) tf.set(0, 0, 1); tf.normalize();
  const tl = tmp2.crossVectors(UP, tf).normalize();            // the target's left
  const rx = s.pos.x - t.pos.x, rz = s.pos.z - t.pos.z, d = Math.hypot(rx, rz) || 1;
  const fwdC = (rx * tf.x + rz * tf.z) / d, lefC = (rx * tl.x + rz * tl.z) / d;
  // our angle off the target's bow: 0 = dead ahead, ±π = astern, sign = the target's left (+) / right (−)
  const ang = Math.atan2(lefC, fwdC);
  // statistics: where we are relative to the target's armour sectors (World.applyHit judges by the same bow cosine)
  if (fwdC > 0.5) f.tFront += el; else if (fwdC < -0.5) f.tRear += el; else f.tSide += el;
  if (f.phase === 'engage') f.tEngage += el;
  // is the target busy with someone else (its guns and bow on an ally)?
  const busy = t.ai.targetId >= 0 && t.ai.targetId !== s.id;
  // the target holds its bow on us
  f.faced = fwdC > 0.8 && d < R * 2 ? f.faced + el : 0;
  const set = (p: FlankState['phase']) => { f!.phase = p; f!.since = w.time; f!.replan = 0; };
  // can we out-turn it? Round a target our angular speed is v / r; it keeps its bow on us while its turn rate is
  // the larger. The tight radius where we win is v / (ω_t · 1.4) (margin for its drift and our losses in the turn) — usable if our own turning circle and the hulls
  // allow it. Otherwise no circle gets behind it: we fight from the beam and re-enter when it turns onto us.
  // (effective now: our engine hit halves our speed, a bridge hit slows its turning — World.moveShip)
  const vS = Math.max(1, s.maxSpeed * (s.crit.engine > 0 ? 0.5 : 1)), wT = Math.max(1e-3, t.state === 'alive' ? t.turnRate * (t.crit.bridge > 0 ? 0.6 : 1) : 0);
  // the floor: our own turning circle and the battle's hull separation distance (World.moveShip pushes ships apart inside it)
  const rTight = vS / (wT * 1.4), rFloor = Math.max((s.radius + t.radius) * 2.6 + 34, vS / Math.max(1e-3, s.turnRate) * 1.1);
  if (f.tid !== t.id) { f.tid = t.id; f.shrink = 0; f.noOut = false; f.noOutW = 0; }
  // (three tightened circles all failed against this target: it out-turns us in practice — unless it has since
  //  lost a good part of its turn rate)
  const canOut = rTight >= rFloor && (!f.noOut || wT < f.noOutW * 0.8);
  // no circle gets behind it alone: after a failed try the flanker stands off instead of trying again and again
  const stand = () => { set('standoff'); f!.stands++; f!.sAt = 0; };
  const rCircle = busy ? R * 0.9 : canOut ? Math.min(R, Math.max(rFloor, rTight * (1 - 0.15 * f.shrink))) : R;
  if (!canOut && !busy && f.goal > 100 * DEG && f.phase !== 'engage') f.goal = 90 * DEG;

  switch (f.phase) {
    case 'approach':
      if (d < R * 1.6) {
        // committing to a side: if we arrive ahead of the target's beam on the other side, take that side rather
        // than cross its bow (a commander's flank order keeps its side)
        if (o?.type !== 'flank' && Math.sign(ang) !== f.side && Math.abs(ang) < 100 * DEG) { f.side = -f.side; f.switches++; }
        set('circle'); f.attempts++; if (busy) f.distracted++;
      }
      break;
    case 'circle': {
      const err = Math.abs(ang - f.side * (busy ? 160 * DEG : f.goal));
      if (Math.sign(ang) === f.side && err < 30 * DEG && d < Math.max(R, rCircle) * 1.35) { set('engage'); f.reached++; break; }
      // a circle needs time: it has failed only when the target has held its bow on us for a while well into it
      if (!busy && f.faced > FL_FACED && w.time - f.since > 10) {
        f.fails.faced++;
        // we can out-turn it: keep circling, tighter (no running away from a target we can get behind)
        if (canOut && f.shrink >= 2) { f.noOut = true; f.noOutW = wT; stand(); }
        else if (canOut) { f.shrink++; f.attempts++; f.since = w.time; f.faced = 0; }
        else stand();
        break;
      }
      if (w.time - f.since > FL_CIRCLE_MAX) { f.fails.timeout++; if (canOut || busy) set('reattack'); else stand(); }
      break;
    }
    case 'engage':
      // the target has turned onto us: settle for the beam if we are abeam, else come round again
      if (!busy && f.faced > FL_FACED) {
        if (Math.abs(ang) > 60 * DEG && f.goal > 100 * DEG) { f.goal = 90 * DEG; f.faced = 0; }
        else { f.fails.faced++; if (canOut) { set('circle'); f.attempts++; } else stand(); }
      } else if (f.goal < 100 * DEG && canOut && fwdC < -0.2) f.goal = 135 * DEG;   // it turned away again: back to the quarter
      if (d > Math.max(R, rCircle) * 1.9) set('approach');
      break;
    case 'standoff':
      // back to flanking only when it can work: an ally has drawn the target's guns, or we have gained the edge
      // (its turning slowed / our speed back). Not within the first seconds, so the ship does not dither.
      if (w.time - f.since > FL_STAND_MIN && (busy || canOut)) {
        f.resumes++; f.goal = canOut ? 135 * DEG : 90 * DEG;
        set('circle'); f.attempts++; if (busy) f.distracted++;
      }
      break;
    case 'reattack':
      if (w.time - f.since > FL_REATTACK || d > R * 1.6) {
        // switch side only if the target is swinging toward the side we were on (its bow would meet us there)
        if (f.trate * f.side > 0.05) { f.side = -f.side; f.switches++; }
        f.goal = canOut ? 135 * DEG : 90 * DEG;
        set('circle'); f.attempts++; if (busy) f.distracted++;
      }
      break;
  }

  // waypoint: re-planned on a beat (or at a phase change)
  if (w.time >= f.replan) {
    f.replan = w.time + FL_REPLAN; f.replans++;
    const travel = Math.min(5, d / Math.max(30, s.maxSpeed));
    const yawAhead = clamp(f.trate * travel, -1.2, 1.2);   // where the target's bow will be when we get there
    const at = (a: number, r: number) => {
      // a point at angle `a` off the predicted bow, radius r
      const h = a;
      const cy = Math.cos(yawAhead), sy = Math.sin(yawAhead);
      // the target's bow turned on by yawAhead (fwd = (sin yaw, cos yaw))
      const fx = tf.x * cy + tf.z * sy, fz = -tf.x * sy + tf.z * cy;
      const lx = fz, lz = -fx;   // UP × fwd
      return f!.wp.set(t.pos.x + (fx * Math.cos(h) + lx * Math.sin(h)) * r + t.vel.x * travel * 0.5, t.pos.y, t.pos.z + (fz * Math.cos(h) + lz * Math.sin(h)) * r + t.vel.z * travel * 0.5);
    };
    const goal = f.side * (busy ? 160 * DEG : f.goal);
    switch (f.phase) {
      case 'approach': at(f.side * 95 * DEG, R * 1.4); break;
      case 'circle': {
        // run round toward the goal angle
        // (the side was chosen so that the short way round does not cross the target's bow, see below)
        let delta = goal - ang;
        while (delta > Math.PI) delta -= 2 * Math.PI; while (delta < -Math.PI) delta += 2 * Math.PI;
        // orbit carrot: a point ~2.6 s of travel ahead along the circle's tangent from where we are now, pulled
        // onto the circle radius (the mover slows near its point and when the point is off its bow, so a carrot
        // on the tangent keeps full speed round the turn), plus the target's own drift over that time
        const r0 = !canOut && !busy && Math.abs(ang) < 70 * DEG ? R * 1.25 : rCircle;
        if (Math.abs(delta) < 4 * DEG) { at(goal, r0); break; }
        const dir = Math.sign(delta), L = vS * 2.6;
        const tx = (-Math.sin(ang) * tf.x + Math.cos(ang) * tl.x) * dir, tz = (-Math.sin(ang) * tf.z + Math.cos(ang) * tl.z) * dir;
        const ux = rx / d, uz = rz / d, lt = L / vS;
        f.wp.set(t.pos.x + ux * r0 + tx * L + t.vel.x * lt, t.pos.y, t.pos.z + uz * r0 + tz * L + t.vel.z * lt);
        break;
      }
      case 'engage': at(goal, busy ? R * 0.85 : rCircle); break;
      case 'reattack': at(f.side * 115 * DEG, R * 1.5); break;
    }
  }
  if (f.phase === 'standoff') standoff(w, s, t, b, f, R, d, rx, rz, el);
  else s.ai.moveTo.copy(f.wp);
  // circling, the bow follows the travel (a ship crabbing sideways at its guns is slow); engaged / standing off,
  // the guns' facing
  s.ai.faceTo = f.phase === 'engage' || f.phase === 'standoff' ? faceWithOffset(s, t.pos, b.offset, c.face) : null;
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  c.mode = f.phase === 'reattack' ? 'break' : 'approach';
  c.side = f.side;
}

// ------------------------------------------------------------------ flank, P17.3f (battles recorded before P17.3.1)
// Kept verbatim for replays: BattleSetup.cpuV absent/0 re-runs a recorded battle with the flank it was fought with.
// swing wide round the target to its beam / stern quarter (thinner side and rear armour), holding the
// median band there; the swing goes out through the beam so the ship never runs down the target's bow.
function flankLegacy(w: World, s: Ship, t: Ship, b: Bands) {
  const c = s.cpu!;
  const R = Math.max(t.radius + s.radius + 80, cpuRange('flank', b, rk(s))!);
  const tf = tmp.copy(t.fwd); tf.y = 0; if (tf.lengthSq() < 1e-6) tf.set(0, 0, 1); tf.normalize();
  const beam = tmp2.crossVectors(UP, tf).normalize().scale(c.side);
  // aim point: 135° off the target's bow on our side
  const goal = tmp3.copy(beam).scale(0.71).addScaled(tf, -0.71);
  const rel = new Vec3().subVectors(s.pos, t.pos); rel.y = 0;
  const d = rel.length();
  const bowCos = d > 1 ? (rel.x * tf.x + rel.z * tf.z) / d : 0;
  if (bowCos > 0.2) {
    // in front of the target: out through the beam first, wider than the band
    s.ai.moveTo.copy(t.pos).addScaled(beam, R * 1.25).addScaled(tf, R * 0.2);
    c.mode = 'break';
  } else {
    s.ai.moveTo.copy(t.pos).addScaled(goal, R).addScaled(t.vel, 2);
    if (c.mode === 'break') { c.mode = 'approach'; c.reentries++; }
  }
  s.ai.moveTo.y = t.pos.y;
  s.ai.faceTo = faceWithOffset(s, t.pos, b.offset, c.face);
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  // reached the quarter but the target swung its bow onto us: go round the other side (not while still swinging out)
  if (c.mode === 'approach' && w.time >= c.timer && bowCos > 0.6 && d < R * 1.4) { c.side = -c.side; c.timer = w.time + 12; c.mode = 'break'; }
}

/** P17.3.1 stand-off fallback of the flank computer (a target it cannot get behind alone): a steady gun fight
 *  instead of circling again and again. Favourable — we would kill it clearly sooner than it kills us, and we are
 *  not badly hurt — it closes to the median band (R) and fights it out; otherwise it holds at the long band, just
 *  outside the target's reach when we outrange it, and never charges in. The range is held with a slow sideways
 *  drift on the committed side (spoils the enemy's aim, keeps it off the bow line); nothing else changes. */
function standoff(w: World, s: Ship, t: Ship, b: Bands, f: FlankState, R: number, d: number, rx: number, rz: number, el: number) {
  f.tStand += el;
  if (w.time >= f.sAt) {
    f.sAt = w.time + FL_REPLAN * 2;
    const tb = weaponBands(w, t);
    // seconds each side needs to kill the other at the present rates (hull + shield over sustained fire)
    const ours = (t.hp + (t.shield ?? 0)) / Math.max(1, b.dps), theirs = (s.hp + (s.shield ?? 0)) / Math.max(1, tb.dps);
    const hurt = s.hp < s.maxHp * (f.head ? 0.35 : 0.45);
    f.head = !hurt && ours < theirs * (f.head ? 1 : 0.8);
    // long band: stay out of its reach if our guns outrange it; otherwise at our own long band
    const far = b.max > tb.max * 1.05 ? Math.min(b.max * 0.95, Math.max(tb.max * 1.08, R)) : Math.max(R, b.max * 0.9);
    f.sr = f.head ? R : far;
  }
  if (f.head) f.tHead += el; else f.tHold += el;
  const r = f.sr, ux = rx / d, uz = rz / d;
  // sideways drift on the committed side: a point a quarter of the range round from where we are
  const lx = -uz * f.side, lz = ux * f.side;
  s.ai.moveTo.set(t.pos.x + ux * r + lx * r * 0.25, t.pos.y, t.pos.z + uz * r + lz * r * 0.25);
  s.cpu!.mode = 'approach';
}

/** P17.3.1 flank statistics of a ship (tests / tuning) */
export function flankStats(s: Ship): FlankState | undefined { return s.cpu?.fl; }

// --------------------------------------------------------- energy recharge (P17.3f)
// back straight out to past the enemy's reach, bow (and so the thick front) toward it, until the shield refills.
function recharge(w: World, s: Ship, t: Ship, b: Bands): boolean {
  const away = tmp.subVectors(s.pos, t.pos); away.y *= 0.3;
  const d = away.length(); if (d < 1) return false;
  away.scale(1 / d);
  const reach = Math.max(b.max, t.mounts.reduce((a, m) => Math.max(a, m.weapon.kind === 'pd' ? 0 : m.weapon.range), 0));
  if (d > reach * 1.1) return false;
  s.ai.moveTo.copy(t.pos).addScaled(away, reach * 1.2);
  s.ai.faceTo = s.cpu!.face.copy(t.pos);
  s.ai.speedCap = s.maxSpeed;
  s.ai.run = null;
  return true;
}
