import type { Vec3 } from './math';
import type { ShipClassDef, LoadoutDef, MountDef, Role } from './data/ships';
import type { WeaponDef } from './data/weapons';
import type { CommanderDef } from './data/commanders';

/** a battle side (index into World.sides). Ordinary battles have two (0, 1); P11 battles any number.
 *  Side ≠ company ≠ owner: several companies can share a side, relations are per side pair. */
export type Team = number;
/** relation between two sides: -1 hostile, 0 neutral, 1 allied (symmetric) */
export type Relation = -1 | 0 | 1;

/** a new side created by a reinforcement (P11) */
export interface SideSpec { key?: string; name?: string; /** relation to every existing side (by index); missing = hostile */ rel?: Relation[] }

/** server-stamped battle events carried in the order log (P11): they are applied at their tick on the
 *  authority and on every client, so a reinforcement or a change of relations is part of the replay */
export type BattleEvent =
  | { k: 'join'; fleet: import('./fleet').FleetSpec; /** existing side index or a new side */ side: number | SideSpec;
      /** formation centre (battle-local) and the direction it faces (default: toward the centre) */ entry: { x: number; z: number; fx?: number; fz?: number } }
  | { k: 'rel'; a: number; b: number; v: Relation }
  | { k: 'withdraw'; side: number };

export type Order =
  | { type: 'engage' }
  | { type: 'attack'; targetGroup: number; targetShip?: number }
  | { type: 'flank'; side: -1 | 1; targetGroup?: number; waitFor?: number }
  | { type: 'escort'; guardGroup: number }
  | { type: 'move'; point: { x: number; y: number; z: number } }
  | { type: 'hold'; point?: { x: number; y: number; z: number } }
  | { type: 'reserve' }
  | { type: 'retreat' };

export type OrderType = Order['type'];

export interface Mount {
  index: number;
  def: MountDef;
  weapon: WeaponDef;
  facingLocal: Vec3;    // unit dir of mount center in ship-local frame
  aim: Vec3;            // current world aim direction
  cooldown: number;
  salvoLeft: number;
  salvoTimer: number;
  targetId: number;     // ship id or projectile id
  targetIsMunition: boolean;
  retarget: number;
  disabled: number;
  lastFire: number;     // sim time
  ammo: number;         // salvos left
}

export interface ShipStats {
  dmgDealt: number; dmgTaken: number; kills: number; killValue: number;
  shots: number; hits: number; ricochets: number; intercepts: number;
  torpHits: number; rearHits: number;
}

export interface RunState { mode: 'approach' | 'break'; point: Vec3; timer: number; side: number }

export interface ShipAI {
  moveTo: Vec3;
  faceTo: Vec3 | null;
  speedCap: number;
  targetId: number;     // primary target assigned by commander
  run: RunState | null; // raider attack run state
  jink: number;
  lastRetarget: number;
}

export interface Ship {
  /** BB-EX exotic systems (funnels, PARADOX, DCP-Ω …); absent on every other ship */
  ex?: import('./bbex/state').ExState;
  /** BLACKOUT: fire control and missile guidance are jammed until this sim time */
  jamUntil?: number;
  /** DIMENSION LOCK / GRAVITY WELL: movement is held until this sim time (strength 0..1) */
  holdUntil?: number; hold?: number;
  /** the weapon that last damaged the ship (kill attribution for BB-EX statistics) */
  lastWeapon?: string;
  /** fitted ECM / evasive drives: widens incoming shell dispersion */
  evasion?: number;
  id: number;
  team: Team;
  name: string;
  cls: ShipClassDef;
  loadout: LoadoutDef;
  role: Role;
  groupId: number;
  pos: Vec3; prevPos: Vec3; vel: Vec3;
  yaw: number; pitch: number; prevYaw: number; prevPitch: number;
  fwd: Vec3;
  hp: number; maxHp: number;
  /** P5 shields (growth fittings; 0 for every c0 ship) */
  shield?: number; maxShield?: number; shieldRegen?: number; shieldHitAt?: number;
  armor: { front: number; side: number; rear: number };
  maxSpeed: number; accel: number; turnRate: number; lateral: number;
  radius: number; halfLen: number;
  mounts: Mount[];
  /** 'inbound' = not yet in the battle space (BB-EX before its spatial transfer): untargetable,
   *  not simulated, but counted as present for the outcome */
  state: 'alive' | 'dying' | 'dead' | 'escaped' | 'inbound';
  dyingTimer: number;
  deathTime: number;
  crit: { engine: number; fire: number; bridge: number };
  ai: ShipAI;
  stats: ShipStats;
  gunnery: number;      // accuracy factor (from commander)
  pdBonus: number;
  value: number;
  recentDamage: number; // decaying
  lastAttacker: number;
  throttle: number;     // 0..1 for visuals
  killedBy: number;
  ref?: string;
  /** B-1 officer effects of the commanding officer (absent without one: every rule below is skipped) */
  ofx?: Record<string, number>;
  /** B-1: last hull hit and emergency repair done (regen) */
  ofHit?: number; ofHeal?: number;
}

export interface Munition {
  id: number;
  kind: 'shell' | 'missile' | 'torpedo';
  team: Team;
  ownerId: number;
  weapon: WeaponDef;
  pos: Vec3; prevPos: Vec3; vel: Vec3;
  life: number;
  targetId: number;
  hp: number;
  age: number;
  dead: boolean;
  ricochet?: boolean;
  /** pierce: ships this shell already went through */
  through?: number[];
  /** phase: the munition already made its spatial skip / is untouchable until this age */
  phased?: boolean; ghost?: number;
  /** B-1: guidance multiplier from the launching officer; lost lock (decoy) */
  gm?: number; lost?: boolean; decoyed?: boolean;
}

export interface GroupAI {
  nextThink: number;
  mainTarget: number;          // enemy group id
  shipTarget: number;          // focus ship id
  phase: 'transit' | 'staging' | 'strike' | 'none';
  waypoint: Vec3 | null;
  goal: Vec3;
  face: Vec3 | null;
  preferredRange: number;
  lastRadio: number;
  threatGroup: number;
  lastOrderKey: string;
  committedAt: number;
  kiting: boolean;
  confused: number;            // time until which the commander misreads orders
  reactDelay: number;          // pending reaction delay
  hpHistory: number[];         // sampled once per think
  announcedEngage: boolean;
  routed: boolean;
  orderIssuedAt: number;
  holdPoint: Vec3 | null;
}

export interface Group {
  id: number;
  team: Team;
  name: string;
  parentId: number | null;
  childIds: number[];
  shipIds: number[];
  commander: CommanderDef;
  hasCommander: boolean;
  order: Order;
  playerOverride: boolean;
  retreatAt: number;
  initialHp: number;
  initialValue: number;
  ai: GroupAI;
  stats: { kills: number; killValue: number; lost: number; dmgDealt: number };
  depth: number;
  escortHint: string | null;
  role: Role;
  ref?: string;
  /** P11: a top-level group of another company under a shared side root — the root AI never orders it */
  independent?: boolean;
}

export type SimEvent =
  | { t: 'fire'; ship: number; mount: number; kind: string; weapon: string; pos: Vec3; dir: Vec3 }
  | { t: 'pd'; ship: number; mount: number; from: Vec3; to: Vec3; hit: boolean }
  | { t: 'hit'; target: number; attacker: number; pos: Vec3; dir: Vec3; dmg: number; result: 'pen' | 'ricochet' | 'blocked' | 'shield' | 'cut' | 'paradox'; weapon: string; facing: 'front' | 'side' | 'rear' }
  | { t: 'intercept'; pos: Vec3; kind: string; by: number }
  | { t: 'munitionExpire'; pos: Vec3; kind: string }
  | { t: 'crit'; ship: number; crit: 'engine' | 'weapon' | 'fire' | 'bridge'; pos: Vec3 }
  | { t: 'dying'; ship: number }
  | { t: 'destroyed'; ship: number; killer: number; pos: Vec3; magazine: boolean }
  | { t: 'secondary'; ship: number; pos: Vec3 }
  | { t: 'escaped'; ship: number }
  | { t: 'radio'; msg: RadioMsg }
  | { t: 'highlight'; h: Highlight }
  | { t: 'end'; outcome: Outcome }
  | { t: 'join'; side: number; groups: number[]; ships: number[] }
  | { t: 'rel'; a: number; b: number; v: Relation }
  | { t: 'sideOut'; side: number; status: SideStatus }
  | import('./bbex/state').ExEvent;

export interface RadioMsg {
  id: number;
  time: number;
  team: Team;
  groupId: number;
  who: string;
  rank: string;
  color: string;
  text: string;
  priority: 0 | 1 | 2;   // 2 = critical
  pos: { x: number; y: number; z: number } | null;
  shipId?: number;
}

export interface Highlight {
  time: number;
  score: number;
  title: string;
  text: string;
  pos: { x: number; y: number; z: number };
  shipId: number;
  team: Team;
}

export type SideStatus = 'victor' | 'survived' | 'withdrawn' | 'routed' | 'destroyed';
export interface SideResult { side: number; status: SideStatus; alive: number; lost: number; escaped: number; value: number }
export interface Outcome {
  /** the single winning side, or -1 (draw, stalemate, or several sides still standing) */
  winner: Team | -1;
  reason: string;
  time: number;
  /** per side (every battle): what became of it */
  sides?: SideResult[];
}

export interface OrderRecord { tick: number; groupId: number; order: Order | null; retreatAt?: number; release?: boolean; /** P11 battle event (groupId -1) */ ev?: BattleEvent }
