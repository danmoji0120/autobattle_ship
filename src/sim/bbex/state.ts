// BB-EX — runtime state carried by the ship (`Ship.ex`) and the events its systems emit.
// Everything is part of the deterministic simulation: clients re-run it from the battle setup, so
// none of this is ever sent over the network frame by frame.
import type { Vec3 } from '../math';

export type FunnelMode = 'dock' | 'halo' | 'hunt' | 'guard' | 'lock' | 'wing';
export type Formation = 'halo' | 'hunt' | 'lock' | 'wing';

export interface Funnel {
  i: number;
  pos: Vec3; prevPos: Vec3; vel: Vec3; fwd: Vec3;
  hp: number;
  alive: boolean;
  /** seconds until REGENESIS has rebuilt a lost funnel */
  rebuild: number;
  /** sim time it leaves the hull (staggered ejection); < 0 = already out */
  launchAt: number;
  mode: FunnelMode;
  /** where it wants to be */
  slot: Vec3;
  targetId: number;
  cooldown: number;
  /** orbit phase around its hunt target */
  orbit: number;
  /** DCP node it carries this shot (-1 = none) */
  node: number;
}

/** one reflection facet of the fractal mirror */
export interface DcpNode {
  pos: Vec3;
  /** facet normal (bisector of the incoming and the mean outgoing direction) */
  n: Vec3;
  parent: number;
  depth: number;
  /** funnel carrying or projecting the facet (-1 = free space facet) */
  funnel: number;
  /** outgoing beams */
  out: number;
  /** aim points of beams that leave the lattice here (no further facet) */
  ends: Vec3[];
}
export interface DcpSeg { a: Vec3; b: Vec3; gen: number; w: number; from: number; to: number }

export interface DcpState {
  state: 'idle' | 'lock' | 'charge' | 'fire' | 'cool';
  t: number;
  /** mount index of the DCP-Ω emitter (-1 = removed / never fitted) */
  mount: number;
  nodes: DcpNode[];
  segs: DcpSeg[];
  /** ships held by the dimension lock for this shot */
  locked: number[];
  pulse: number;
  shots: number;
  over: boolean;
  replan: number;
}

export interface ExState {
  phase: 'inbound' | 'descent' | 'combat';
  arriveAt: number;
  arrivePos: Vec3;
  funnels: Funnel[];
  form: Formation;
  /** 0..1 wing spread (drives the wing / halo geometry on both sides of the wire) */
  spread: number;
  paradox: { energy: number; max: number; overload: number; load: number; hits: number; displaced: number; absorbed: number; overloads: number };
  dcp: DcpState;
  blackout: { next: number; n: number };
  well: { next: number; pos: Vec3; until: number; n: number };
  shift: { next: number; n: number };
  causal: { on: boolean; vetoes: number; next: number; used: number; rewrites: number; denyNext: number; denies: number };
  over: { next: number; until: number; n: number };
  /** heading of the standing orbit around the enemy mass */
  orbit: number;
  stats: ExStats;
}

export interface ExWeaponStat { dmg: number; hits: number; kills: number; shots: number }
export interface ExStats {
  weapon: Record<string, ExWeaponStat>;
  funnelsLost: number; funnelsRebuilt: number; intercepts: number;
  regen: number; arrivedAt: number;
}

type P = Vec3;
export type ExEvent =
  /** the rift opens: the hull is still elsewhere */
  | { t: 'exRift'; ship: number; pos: P; dur: number }
  /** the hull emerges; funnels will follow */
  | { t: 'exDescent'; ship: number; pos: P; dur: number }
  | { t: 'exFunnel'; ship: number; i: number; e: 'launch' | 'lost' | 'rebuilt'; pos: P }
  | { t: 'exForm'; ship: number; form: Formation }
  /** a funnel shot (hitscan): from → to */
  | { t: 'exBeam'; ship: number; i: number; from: P; to: P; target: number; hit: boolean }
  /** a funnel swatted a munition */
  | { t: 'exSwat'; ship: number; i: number; from: P; to: P }
  /** PARADOX reacted at `pos` (incoming direction `dir`) */
  | { t: 'exParadox'; ship: number; pos: P; dir: P; mode: 'displace' | 'absorb'; dmg: number; heavy: boolean }
  | { t: 'exOverload'; ship: number; on: boolean }
  /** dimension lock + charge: the facets unfold at `nodes` */
  | { t: 'exDcpCharge'; ship: number; dur: number; nodes: { pos: P; n: P; funnel: number }[]; locked: number[]; over: boolean }
  /** the cut: every segment listed is both drawn and damaging */
  | { t: 'exDcpFire'; ship: number; dur: number; segs: { a: P; b: P; gen: number; w: number }[]; nodes: { pos: P; n: P; split: number; funnel: number }[]; over: boolean; seq: number }
  | { t: 'exDcpEnd'; ship: number }
  | { t: 'exBlackout'; ship: number; pos: P; radius: number; jammed: number }
  | { t: 'exWell'; ship: number; pos: P; radius: number; dur: number }
  | { t: 'exShift'; ship: number; from: P; to: P }
  /** causality interference: 'veto' = the destruction of BB-EX is rejected, 'deny' = a hit that had landed
   *  on the hull is struck from the record, 'rewrite' = a glancing shot of BB-EX is made to have bitten.
   *  `dir` = the direction the affected shot travelled, `from` = where it was fired from. */
  | { t: 'exCausal'; ship: number; what: 'veto' | 'deny' | 'rewrite'; pos: P; dir?: P; from?: P; target?: number }
  | { t: 'exGameOver'; ship: number; on: boolean; dur: number }
  /** a pierce-through (ABYSS-LANCE leaving a hull) */
  | { t: 'exPierce'; pos: P; dir: P; target: number }
  /** a munition skipped through space */
  | { t: 'exPhase'; from: P; to: P }
  | { t: 'exRegen'; ship: number; funnel: number };
