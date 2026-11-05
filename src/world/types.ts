// Persistent-world state. Everything here is plain JSON: it is what the server saves,
// what clients receive in snapshots, and what single-player stores locally.

import type { CommanderDef } from '../sim/data/commanders';
import type { BattleSetup } from '../sim/world';
import type { OrderRecord } from '../sim/types';

export type Res = 'ore' | 'alloy' | 'crystal';
export const RES: Res[] = ['ore', 'alloy', 'crystal'];
export type Cargo = Record<Res, number>;
export interface V { x: number; y: number; z: number }

export type CompanyKind = 'player' | 'union' | 'guild' | 'pirate';

export interface Company {
  id: string;
  name: string;
  kind: CompanyKind;
  color: string;
  credits: number;
  rep: number;               // standing with the Union authority (players)
  online?: boolean;
  createdAt: number;
  stats: { earned: number; mined: number; kills: number; lost: number; battlesWon: number; contracts: number };
  milestones: string[];
  homeStation: string;
}

export type Op =
  | { k: 'idle' }
  | { k: 'move'; to: V }
  | { k: 'dock'; station: string }
  | { k: 'mine'; field: string; deliver: string; sell: boolean }
  | { k: 'haul'; from: string; to: string; res: Res }
  | { k: 'patrol'; at: V; radius: number }
  | { k: 'escort'; group: string }
  | { k: 'attack'; group?: string; lair?: string }
  | { k: 'build'; station: string }
  | { k: 'found'; at: V; name: string }
  // NPC-only
  | { k: 'raid'; target?: string; home: string }
  | { k: 'trade'; route: string[]; leg: number }
  | { k: 'guard'; route: V[]; leg: number }
  | { k: 'garrison'; station: string; radius: number }
  | { k: 'respond'; home: string; target?: string };

export type OpKind = Op['k'];

export type ShipTask =
  | { k: 'none' }
  | { k: 'goto'; to: V; why?: string }
  | { k: 'mine'; field: string; rock: number }
  | { k: 'transfer'; with: string }         // hauler receiving from miner
  | { k: 'docked'; station: string; berth: number }
  | { k: 'build'; station: string }
  | { k: 'flee'; station: string };

export interface WShip {
  id: string;
  owner: string;
  classId: string;
  loadoutId: string;
  name: string;
  hp: number;                // 0..1 hull fraction (persists between battles)
  pos: V; vel: V; heading: number;
  groupId: string;
  state: 'space' | 'docked' | 'battle' | 'building';
  task: ShipTask;
  cargo: Cargo;
  engagement?: string;
  kills: number;
  /** visual hints for clients */
  fx?: { mining?: string; rock?: number; transfer?: string; welding?: string };
  /** in-system high-speed travel: aligning, then warping */
  warp?: { to: V; phase: 'align' | 'warp'; t: number };
  /** world time of the last gate jump (client flash) */
  jumpT?: number;
}

export interface WGroup {
  id: string;
  owner: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  shipIds: string[];
  commanderId: string | null;
  op: Op;
  override: boolean;          // explicit order (otherwise inherits parent op)
  status: string;             // human readable current activity
  cooldown: number;           // seconds of engagement immunity after battle
  fleeing: boolean;
  lastSay: number;
  /** NPC force bookkeeping (Union garrisons/patrols/response fleets, pirate bands) */
  npc?: NpcInfo;
}

export interface NpcInfo {
  role: 'garrison' | 'patrol' | 'qrf' | 'band' | 'rogue' | 'trader';
  sys: string;
  home: string;               // station id (union) or lair id (pirates)
  template: [string, string][];
  nextRefit: number;           // world time of the next replacement ship
  born: number;
  slot?: string;               // Union force plan slot
  homePos?: V;                 // rogue bands without a lair
}

export interface WCommander extends Omit<CommanderDef, 'team'> {
  owner: string | null;       // null → available for hire
  stationId: string | null;   // where available for hire
  hireCost: number;
  xp: number;
  level: number;
  injuredUntil: number;
  battles: number;
}

export interface Module { kind: string; progress: number; built: boolean; slot: number }

export interface Market { [res: string]: { stock: number; target: number; base: number } }

export interface Station {
  id: string;
  name: string;
  owner: string;              // company id ('union' / 'guild' for public)
  public: boolean;
  style: number;
  pos: V;
  radius: number;
  market: Market | null;
  services: { repair: boolean; shipyard: string[]; recruit: boolean; contracts: boolean; refit: boolean };
  storage: Record<string, Cargo>;  // per company
  modules: Module[];
  defenseHp: number;           // fraction for defense platform
  founded: number;
  desc: string;
  /** broker tax on sales (high-security markets are crowded and regulated) */
  tax?: number;
  /** Union presence: garrison size class 0..3 */
  garrison?: number;
}

export interface Field {
  id: string;
  name: string;
  pos: V;
  radius: number;
  res: Res;
  amount: number;
  max: number;
  regen: number;               // per second
  rocks: number;
  salvage: boolean;
  expires: number;             // salvage fields decay (0 = permanent)
  danger: number;
  /** yield multiplier (remote, lawless space is richer) */
  rich?: number;
}

export interface Lair {
  id: string;
  name: string;
  owner: string;
  pos: V;
  hp: number;                 // fraction
  alive: boolean;
  respawnAt: number;
  nextBand: number;
  maxBands: number;
  /** band strength tier (1 small … 5 warlord) */
  tier?: number;
  kind?: 'hideout' | 'lair' | 'fortress';
}

export type SysKind = 'core' | 'settled' | 'frontier' | 'danger' | 'lawless';

export interface Planet { id: string; name: string; pos: V; size: number; color: string; atmo: string; ring: boolean; moons: { name: string; pos: V; size: number }[]; desc: string }
export interface Gate { id: string; name: string; to: string; exit: string; pos: V }

export interface StarSystem {
  id: string;
  name: string;
  idx: number;
  origin: V;
  radius: number;
  kind: SysKind;
  security: number;            // base 0..100 (government control)
  heat: number;                // recent pirate activity 0..100 (lowers effective security, bounded)
  desc: string;
  star: { name: string; color: string; size: number };
  nebula: [string, string];
  map: { x: number; y: number };
  planets: Planet[];
  gates: Gate[];
  lanes: [string, string][];   // trade lanes between station/gate ids
  stats: { pirateKills: number; unionLosses: number; civLosses: number; raids: number; bands: number };
}

export interface Contract {
  id: string;
  stationId: string;
  kind: 'bounty' | 'delivery' | 'lair';
  title: string;
  desc: string;
  reward: number;
  rep: number;
  target?: string;            // group id / lair id
  res?: Res;
  amount?: number;
  progress: number;
  expires: number;
  takenBy: string | null;
  done: boolean;
}

export interface Engagement {
  id: string;
  pos: V;
  start: number;               // world time
  setup: BattleSetup;
  orders: OrderRecord[];
  tick: number;                // tactical ticks simulated by the authority
  sides: [string[], string[]]; // company ids per team
  groupRefs: string[];         // strategic groups involved
  live: boolean;               // real-time (players involved) vs instantly resolved
  done: boolean;
  summary?: string;
  winner?: number;
  lairId?: string;
  stationId?: string;
  /** NPC-only fights are auto-resolved when this world time is reached */
  autoEnd?: number;
  n?: number;                  // ships involved (for clients; setup is not in snapshots)
  sys?: string;
}

export interface WorldEvent {
  id: number;
  t: number;
  kind: 'radio' | 'info' | 'warn' | 'battle' | 'money' | 'world' | 'milestone';
  text: string;
  who?: string;
  color?: string;
  company?: string;            // undefined → broadcast to everyone
  pos?: V;
  ref?: string;
}

export interface WorldState {
  version: number;
  seed: number;
  rng: number[];
  time: number;
  nextId: number;
  companies: Record<string, Company>;
  ships: Record<string, WShip>;
  groups: Record<string, WGroup>;
  commanders: Record<string, WCommander>;
  stations: Record<string, Station>;
  fields: Record<string, Field>;
  lairs: Record<string, Lair>;
  systems: Record<string, StarSystem>;
  contracts: Record<string, Contract>;
  engagements: Record<string, Engagement>;
  events: WorldEvent[];        // rolling log
  eventSeq: number;
  news: string[];
}

export const emptyCargo = (): Cargo => ({ ore: 0, alloy: 0, crystal: 0 });
export const cargoSum = (c: Cargo) => c.ore + c.alloy + c.crystal;
