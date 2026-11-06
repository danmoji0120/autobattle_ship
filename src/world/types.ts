// Persistent-world state. Everything here is plain JSON: it is what the server saves,
// what clients receive in snapshots, and what single-player stores locally.

import type { CommanderDef } from '../sim/data/commanders';
import type { BattleSetup } from '../sim/world';
import type { OrderRecord } from '../sim/types';

/** item id (see industry.ts ITEMS / EQUIPMENT / 'bp:<tech>') */
export type Res = string;
/** the three original goods (always present in a cargo record for save compatibility) */
export const RES: Res[] = ['ore', 'alloy', 'crystal'];
/** sparse item → amount map; read with qty(), never index blindly */
export type Cargo = Record<string, number>;
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
  /** researched technologies */
  tech?: string[];
  /** research projects (one lab slot each while running) */
  research?: ResearchProject[];
  /** saved fitting presets (fitting screen) */
  fitPresets?: FitPreset[];
  rseq?: number;
}

export interface FitPreset { id: string; name: string; hull: string; variant: string; hp: Record<string, string>; bay: Record<string, string> }
export interface ResearchProject { id: string; tech: string; station: string; left: number; total: number; started: boolean; paid?: number; paused?: boolean; why?: string; source?: 'lab' | 'salvage' | 'copy' }

export type Op =
  | { k: 'idle' }
  | { k: 'move'; to: V }
  | { k: 'dock'; station: string }
  /** deliver: unloading station; sell: sell there (else store in the company's storage there);
   *  auto: the server picks (and re-picks) the most suitable reachable station */
  | { k: 'mine'; field: string; deliver: string; sell: boolean; auto?: boolean }
  | { k: 'haul'; from: string; to: string; res: Res }   // res '*auto' = supply what `to` lacks, '*all' = move everything
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
  /** content registry hull + structural variant (set from contentV 1; see world/migrate.ts) */
  hull?: string;
  variant?: string;
  /** fitted equipment (player ships, contentV ≥ 2) — see world/fitting.ts */
  fitting?: import('./fitting').ShipFitting;
  name: string;
  hp: number;                // 0..1 hull fraction (persists between battles)
  pos: V; vel: V; heading: number;
  groupId: string;
  state: 'space' | 'docked' | 'battle' | 'building';
  task: ShipTask;
  cargo: Cargo;
  /** installed fitting modules (EQUIPMENT ids) */
  fit?: string[];
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
  /** scouts / vanguard: moves on its own instead of keeping station with the parent fleet */
  detached?: boolean;
  /** fleet movement state, kept on the group whose order the fleet is executing */
  march?: March;
}

/** coordinated fleet movement: rally → move as one at the slowest ship's pace → stage → attack together */
export interface March {
  key: string;
  phase: 'assemble' | 'transit' | 'arrived' | 'ready' | 'engage';
  wp: V[];
  i: number;
  /** current rally / waypoint point */
  at: V;
  since: number;
  /** all members aligned: release the warp drives together */
  warpGo: boolean;
  speed: number;
  members: number;
  inPlace: number;
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

export interface Module {
  kind: string; progress: number; built: boolean; slot: number;
  // ── construction plan (unbuilt modules). Queue order = order in Station.modules. ──
  /** stable id for queue commands */
  id?: string;
  /** paused: keeps what it has reserved, takes nothing more, no work is done */
  paused?: boolean;
  /** materials set aside for this plan (already taken out of the owner's storage, so nothing else can use them) */
  reserved?: Record<string, number>;
  /** materials already worked into the structure */
  used?: Record<string, number>;
  /** credits paid when the plan was registered (refunded pro rata on cancel) */
  paid?: number;
  /** all materials secured at least once (for the one-off notification) */
  secured?: boolean;
}

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
  // ── industry (own stations) ──
  /** production orders, served in queue order */
  orders?: import('./production').ProdOrder[];
  /** running production jobs (inputs already consumed) */
  jobs?: import('./production').ProdJob[];
  /** ship construction queue (yard slots) */
  builds?: ShipBuild[];
  /** id counter for orders/jobs/builds at this station */
  seq?: number;
  /** player sell orders listed at this station (goods held in escrow) */
  listings?: Listing[];
}

export interface ShipBuild {
  id: string; classId: string; loadoutId: string;
  hull?: string; variant?: string;
  /** fitting modules installed at launch */
  fit: string[];
  group?: string;
  /** seconds of yard work left / total; started = parts consumed */
  left: number; total: number; started: boolean;
  paid: number;
  paused?: boolean;
  why?: string;
}

export interface Listing { id: string; seller: string; item: string; qty: number; price: number; t: number }

export interface Field {
  id: string;
  name: string;
  pos: V;
  radius: number;
  res: Res;
  /** what a mined unit is made of (item → fraction); res alone when absent */
  mix?: Record<string, number>;
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
  /** faction influence 0..100 (factions.ts) */
  inf?: { union: number; pirates: number; guild: number };
  /** reconstruction boom after a lair falls */
  recoverUntil?: number;
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
  live: boolean;               // players involved (they may command); NPC-only fights run the same engine
  done: boolean;
  summary?: string;
  winner?: number;
  lairId?: string;
  stationId?: string;
  /** overload fallback only: resolved by the strength model at this time (not watchable) */
  autoEnd?: number;
  /** side display names, e.g. ['연합 관리청', '해적'] */
  names?: [string, string];
  /** live progress for maps and lists: ships alive / at start, remaining strength 0..1 */
  prog?: { alive: [number, number]; total: [number, number]; value: [number, number] };
  n?: number;                  // ships involved (for clients; setup is not in snapshots)
  sys?: string;
}

export interface BattleRecord {
  id: string; sys?: string; pos: V; start: number; end: number;
  names: [string, string]; winner: number; summary: string; n: number;
  /** ships lost per side */
  losses: [number, number];
  setup: BattleSetup; orders: OrderRecord[];
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
  /** client feedback hook (sound / toast), e.g. 'build_secured' | 'build_start' | 'build_done' */
  tag?: string;
}

export interface WorldState {
  /** sim sub-tick accumulators (restored on load) */
  clock?: { acc: number; slow: number; npcRot: number; battleAcc?: Record<string, number> };
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
  /** finished tactical battles, replayable from setup + seed + orders (newest last) */
  battleLog?: BattleRecord[];
  events: WorldEvent[];        // rolling log
  eventSeq: number;
  news: string[];
  /** industry data upgrade applied (see economy.ts) */
  industryV?: number;
  /** content-model migration applied (world/migrate.ts CONTENT_VERSION) */
  contentV?: number;
  /** items created by migrations (asset conservation ledger) */
  grants?: import('./migrate').GrantRecord[];
  /** existing items that changed form during migrations (not new) */
  conversions?: import('./migrate').ConversionRecord[];
}

export const emptyCargo = (): Cargo => ({ ore: 0, alloy: 0, crystal: 0 });
export const qty = (c: Cargo | undefined, r: string) => c?.[r] ?? 0;
export const addc = (c: Cargo, r: string, n: number) => { c[r] = (c[r] ?? 0) + n; if (Math.abs(c[r]) < 1e-9 && !RES.includes(r)) delete c[r]; };
export const cargoSum = (c: Cargo) => { let n = 0; for (const k in c) n += c[k]; return n; };
/** item ids with a positive amount */
export const cargoKeys = (c: Cargo) => Object.keys(c).filter(k => c[k] > 1e-9);
/** take up to n of r; returns what was taken */
export const takec = (c: Cargo, r: string, n: number) => { const t = Math.max(0, Math.min(n, qty(c, r))); if (t > 0) addc(c, r, -t); return t; };
/** has at least `need` of every item */
export const hasAll = (c: Cargo, need: Record<string, number>) => Object.entries(need).every(([k, n]) => qty(c, k) >= n - 1e-9);
