// Persistent-world state. Everything here is plain JSON: it is what the server saves,
// what clients receive in snapshots, and what single-player stores locally.

import type { CommanderDef } from '../sim/data/commanders';
import type { BattleSetup } from '../sim/world';
import type { OrderRecord } from '../sim/types';
import type { Size } from '../content/schema';

/** item id (see industry.ts ITEMS / EQUIPMENT / 'bp:<tech>') */
export type Res = string;
/** the three original goods (always present in a cargo record for save compatibility) */
export const RES: Res[] = ['ore', 'alloy', 'crystal'];
/** sparse item → amount map; read with qty(), never index blindly */
export type Cargo = Record<string, number>;
export interface V { x: number; y: number; z: number }

export type CompanyKind = 'player' | 'union' | 'guild' | 'pirate';

export interface Company {
  /** B-2: the company's last settled military contracts (operation P&L, shown in the contract screen) */
  milLog?: import('./military').MilLogRow[];
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
  /** A-3.1: founding background id (world/backgrounds.ts) — the company's origin; grants nothing after founding */
  background?: string;
  /** researched technologies */
  tech?: string[];
  /** research projects (one lab slot each while running) */
  research?: ResearchProject[];
  /** saved fitting presets (fitting screen) */
  fitPresets?: FitPreset[];
  /** P17.4d: saved mixed-fleet compositions (free designs; world/fleetPlan.ts) */
  fleetTemplates?: import('./fleetPlan').FleetTemplate[];
  rseq?: number;
  /** production rights (P6, contentV ≥ 3): blueprint id → holding */
  blueprints?: Record<string, BlueprintHolding>;
  /** running costs and arrears (P4, contentV ≥ 3) — see world/upkeep.ts */
  upkeep?: UpkeepState;
  /** growth: leased storage blocks at public stations (station id → blocks) */
  leases?: Record<string, number>;
  /** first-hour prepayment expiry per block; absent legacy entries accrue normally */
  leasePaidUntil?: Record<string, number[]>;
  /** recovered battle assets awaiting space at their original destination */
  pendingLoot?: Record<string, Cargo>;
  /** Growth: refundable foundation prepayments, keyed by the group carrying the order. */
  foundingEscrow?: Record<string, number>;
  /** Last sequenced market purchase, for retrying an unacknowledged transaction safely. */
  lastPurchase?: { seq: number; id: string; signature: string };
  /** Last sequenced sale or player-exchange action, for retry-safe trade. */
  lastTrade?: { seq: number; id: string; signature: string };
  /** Optional company procurement policy; absent means transport enabled and purchasing disabled. */
  procurement?: import('./procurement').ProcurementPolicy;
  /** P17.2: consent to buy field repair from other companies (price cap, hourly budget, minimum balance) */
  repairService?: import('./repairBiz').RepairService;
  /** A-3.2b (derelictV worlds): what the company has recovered by salvage — units by item, reference value, sites worked */
  salvage?: { units: number; value: number; items: Cargo; sites: string[]; first?: number };
  /** P12.5 (logisticsV worlds): false stops new automatic hauler dispatch; in-flight shipments finish */
  autoLogistics?: boolean;
  /** Company operations (works, approvals policy, cash ledger) — see world/operations.ts. Created lazily. */
  ops?: import('./operations').CompanyOps;
  /** P10 standing with each territorial faction (−100..100; absent = 0) */
  standing?: Record<string, number>;
  /** P13.3 (blackMarketV): black markets this company found, and its private trade / inspection log */
  bm?: { known: string[]; log?: import('./blackmarket').BmLog[]; customs?: import('./blackmarket').CustomsLot[] };
  /** P13.2: default answer of this company's cargo ships to a cargo demand (absent = balanced) */
  piracyPolicy?: import('./piracy').VictimPolicy;
  /** P13.4 (lawV): this company's record with the authority (wanted level, unpaid fines, recent cases) — private */
  law?: import('./law').CoLaw;
  /** P14.0 (repV): reputation bookkeeping — record per scope, recent changes, applied event keys — private */
  repx?: import('./reputation').CoRep;
  /** B-3 (sovV): this company's territory screen data — its territories, claims, wars, treaties (private) */
  sovx?: import('./sovereignty').SovX;
}

export interface BlueprintHolding { src: string; t: number; /** builds left (limited-run licence); absent = perpetual */ runs?: number }

export interface UpkeepState {
  /** credits owed but not yet paid (arrears) */
  debt: number;
  /** authoritative nano-credit debt; numeric debt is a legacy/display projection */
  debtU?: string;
  debtSince?: number;
  creditChargesU?: string;
  supplyChargesU?: string;
  paidU?: string;
  paymentWindowU?: string;
  lastPayment?: { t: number; units: string; source: 'sale' | 'manual' | 'settlement' | 'rent' };
  rent?: {
    lastMs: number; remainder: string; debtU: string; accruedU: string; prepaidU: string; paidU: string; billChargeU: string; prepaidReportedU?: string;
    sinceMs?: number;
    cancelled?: { t: number; blocks: Record<string, number> };
  };
  /** arrears stage 0..4 (1 warning, 2 resupply/maintenance delayed, 3 new departures held, 4 reserve proposed) */
  stage: number;
  /** world time arrears began (0 = none) */
  since: number;
  /** accrued but unsettled credits / supplies since the last settlement */
  acc: number;
  supplies: Record<string, number>;
  leaseAcc?: number;
  last: number;
  /** last settlement: what it cost and how it was covered (for the client) */
  bill?: { t: number; lease?: number; credits: number; supplies: number; dock: number; overhead: number; fromStore: Record<string, number>; bought: Record<string, number>; paid: number; short: number; perHour: number;
    /** P17.4a (AUD-07/08): which store gave what, emergency purchases (units, unit price, why), what went unsupplied */
    stores?: Record<string, Record<string, number>>; emergency?: Record<string, { n: number; unit: number; why: string }>; lacking?: Record<string, number> };
  /** P17.4a (AUD-08): emergency purchase credits in the trailing hour (for the hourly cap) */
  emergencyLog?: { t: number; n: number }[];
  /** P17.4a: the last settlement went without some consumables (forbidden / capped emergency purchase) — wear ×1.5 */
  supplyShort?: boolean;
  /** running totals (econsim / UI) */
  total: { credits: number; supplies: number; paid: number };
  /** let the server move idle docked ships to reserve at stage 4 (off unless the player opts in) */
  autoReserve?: boolean;
  /** P17.4a (AUD-07/08) consumable supply policy. Absent = the legacy rule (every own store, unlimited emergency
   *  purchase at 2×) — saves keep it until the player chooses. New worlds (upkeepV) give new companies a policy.
   *  source 'local': only stores in a system where one of the company's ships is; emergency: allow / cap per hour / forbid */
  policy?: { source: 'all' | 'local'; emergency: 'allow' | 'cap' | 'forbid'; capPerHour: number };
  /** A-2.1: an open recovery (회생) — started when the player first uses a recovery tool at stage ≥ 3, closed when
   *  the debt is paid. debt0 / paid0: the debt and the paid total when it started (progress for the UI) */
  recovery?: { since: number; debt0: number; paid0: number; sold?: number; swapped?: number };
  /** A-2.1: the last finished recovery */
  recovered?: { since: number; t: number; paid: number };
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
  | { k: 'haul'; from: string; to: string; res: Res; route?: string }   // res '*auto' = supply what `to` lacks, '*all' = move everything
  /** route (P12 worlds): waypoints patrolled in a loop instead of the circle around `at` */
  | { k: 'patrol'; at: V; radius: number; route?: V[] }
  /** focus: which of the target's ships to protect (absent = auto: miners on a mining op, carriers on cargo work) */
  | { k: 'escort'; group: string; focus?: import('./escort').EscortFocus }
  | { k: 'attack'; group?: string; lair?: string }
  | { k: 'build'; station: string }
  /** The server records a growth-world prepayment and the material terms of that order. */
  | { k: 'found'; at: V; name: string; size?: Size; escrowed?: boolean; foundationMats?: Cargo }
  /** growth: sweep a star system for hidden derelicts; salvage one the company has found */
  | { k: 'survey'; system: string }
  | { k: 'salvage'; site: string }
  /** P13.1 (salvageV worlds): recover from one battlefield wreck (unload when full, come back until it is empty).
   *  `illegal`: also take cargo that belongs to a non-hostile company (a crime where the law reaches) */
  | { k: 'recover'; wreck: string; illegal?: boolean }
  /** P13.1: salvage zone — the commander picks wrecks around `at`, unloads at a station and comes back, until told otherwise */
  | { k: 'salvzone'; at: V; radius: number; illegal?: boolean; /** P17.0 salvage business: no fixed zone — wrecks within
   *  SALV.bizJumps jumps of `at`'s system, worth the trip; nothing to do → wait docked at the nearest station */ biz?: boolean }
  /** P16.7: field repair — fly to one own ship and repair its hull to full (repair ships with field repair gear) */
  | { k: 'fieldrepair'; ship: string }
  /** P16.7: field repair zone — the commander picks damaged own ships around `at`, repairs them, comes back; continuing */
  | { k: 'repairzone'; at: V; radius: number }
  /** P17.2 repair business: sell field repair to damaged ships of other companies within `jumps` of `at`'s system
   *  (world/repairBiz.ts). `mul` × station price; `clients`; jobs below `minFee` skipped; `avoidRisk`: skip hostile areas */
  | { k: 'repairbiz'; at: V; jumps: number; mul: number; clients: 'all' | 'npc' | 'players'; minFee: number; avoidRisk: boolean }
  // P12 fleet operations (opsV worlds only): the order names the purpose, the commander decides how
  | { k: 'rally'; at: V }
  | { k: 'defend'; at: V; radius: number }
  /** attack-move: advance to `to`, fighting hostile fleets met on the way */
  | { k: 'amove'; to: V }
  | { k: 'intercept'; group: string }
  | { k: 'blockade'; system: string; gate: string }
  /** raid a lane: hunt vulnerable hostile targets around `at` (or along `route`) — no looting (P13) */
  | { k: 'harass'; at: V; radius: number; route?: V[]; plunder?: import('./piracy').PlunderPolicy; neutral?: boolean }
  /** P13.2 (piracyV worlds): take real cargo from a target fleet (`group`) or from cargo ships around `at`.
   *  Demands surrender at threat range; the target's cargo is jettisoned and recovered by this fleet. */
  | { k: 'plunder'; group?: string; at?: V; radius?: number; policy: import('./piracy').PlunderPolicy; demand?: 'part' | 'all' | 'item'; item?: string; neutral?: boolean }
  /** P13.2.2 (piracyV worlds): a separate recovery fleet assigned to the plunder fleet `group` of the same company.
   *  It follows the raid at a distance, recovers the containers that raid made jettison and unloads them;
   *  within PIR.tenderR of a victim its free hold counts in the victim's judgement (never its guns). */
  | { k: 'lootTender'; group: string }
  /** P13.3 (blackMarketV worlds): carry stolen / restricted goods (optionally loaded at `from`) to the black market at
   *  station `to`, through the real gates and inspections, and sell them there when `sell` */
  | { k: 'smuggle'; to: string; from?: string; items?: string[]; sell?: boolean }
  /** support a running battle (eng) or a friendly fleet (group) */
  | { k: 'reinforce'; eng?: string; group?: string }
  | { k: 'recon'; at: V; radius: number }
  /** return to base: no station in the order — the commander picks it (see docs/P12_FLEET_OPERATIONS.md) */
  | { k: 'return' }
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
  /** industrial hardpoint rules (indV worlds): this ship mines / builds / salvages only with fitted gear */
  ind?: 1;
  /** P16.7 field repair: on a repair ship — its current patient, credits run up but not yet booked, last status line;
   *  on a patient — last time it was field-repaired (automatic station repair leaves it alone meanwhile) */
  frTarget?: string; frBill?: number; frNote?: string; frAt?: number;
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
  /** P10: fraction of a unit mined from an unidentified field that has not yet become a discrete sample (owned by that field) */
  mineAcc?: { field: string; a: number };
  /** in-system high-speed travel: aligning, then warping */
  warp?: { to: V; phase: 'align' | 'warp'; t: number };
  /** world time of the last gate jump (client flash) */
  jumpT?: number;
  /** operating wear 0..1 (P4): slows mining and cruise, removed by maintenance at a capable station */
  wear?: number;
  /** growth: last time a crowded dock could not finish this ship's maintenance */
  dockWait?: number;
  /** P9.6: in-progress physical cargo handling; the goods remain in their original location. */
  cargoWork?: { station: string; key: string; amount: number; done: number; time: number };
  /** Explicit opt-in and current individual assignment for company-wide logistics. */
  logisticsPool?: boolean;
  logisticsJob?: string;
  /** P12.5 (logisticsV worlds): every idle cargo ship hauls automatically unless the player excludes it */
  logisticsExcluded?: boolean;
  /** P12.5: preferred destination for untracked cargo still aboard (e.g. a cancelled shipment's target) */
  logisticsStow?: string;
  /** AUTO-P1: an approved automatic repair: the ship flies to this station, is repaired there and returns to its work */
  repairAt?: { station: string; since: number; quote: number };
  /** P13.1 (salvageV): the part of the cargo aboard that came from wrecks — unloaded to company storage at the next dock */
  salvaged?: Cargo;
  /** P13.1: salvage work done but not yet a whole unit (per ship, the lot it was working on) */
  salvAcc?: { lot: string; a: number };
  /** P17.2: the repair business group whose paid job this ship is */
  rbBy?: string;
  /** P17.1 (salvQV): fractional recovery carried between work ticks, by item ('_intact' = intact-equipment chance) */
  salvQ?: Record<string, number>;
  /** A-3.2b: where the salvaged goods aboard came from (item key → site id → units), so a salvage contract
   *  counts only goods really recovered from its target (never goods the company already had) */
  salvSrc?: Record<string, Record<string, number>>;
  /** P13.2: the last cargo demand made to this ship (one demand per ship per PIR.redemand seconds) */
  pir?: { t: number; by: string; ev: string; act: import('./piracy').Response; dropped?: number };
  /** P13.3: inspection outcomes recorded per place and 30-minute window (a retry replays the outcome) */
  insp?: Record<string, 'pass' | 'seize'>;
  /** laid up in reserve (P4): docked, cannot depart, upkeep ×0.15. `until` = reactivation finishes */
  reserve?: { since: number; until?: number };
  /** listed for sale on a station exchange (P6): locked in place until sold or withdrawn */
  listed?: string;
  /** account-exclusive hull reconstituting after it was destroyed: docked, cannot depart until then */
  recover?: { until: number };
  /** A-2.1: named for a recovery sortie (economic work allowed while departures are held for arrears) */
  recovery?: true;
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
  /** P17.2 repair business state (repairbiz order) */
  rbiz?: import('./repairBiz').RepairBizState;
  /** scouts / vanguard: moves on its own instead of keeping station with the parent fleet */
  detached?: boolean;
  /** fleet movement state, kept on the group whose order the fleet is executing */
  march?: March;
  /** escort mission state of an escorting group (world/escort.ts) */
  escort?: import('./escort').EscortState;
  /** P12: execution state of the operation this group holds (server-side, saved) */
  opx?: import('./fleetops').OpState;
  /** state of a group that is being escorted: rally hold and the escorts it last had */
  ward?: import('./escort').WardState;
  /** P13.1: on-site automatic salvage after a battle (absent = allowed; false = never) */
  autoSalvage?: false;
  /** P13.1: salvage execution state (recover / salvage-zone orders, or an automatic on-site pickup) */
  salv?: import('./salvage').SalvState;
  /** P13.3: smuggling run state (op smuggle) */
  smug?: import('./blackmarket').SmuggleState;
  /** P13.2: plunder operation state (the group holding a plunder order, or a raiding pirate band) */
  plx?: import('./piracy').PlunderState;
  /** P13.2: this fleet's answer to cargo demands (absent = the company default) */
  piracyPolicy?: import('./piracy').VictimPolicy;
  /** P13.4: Union guard group on a law-enforcement operation (operation id; server-side) */
  lawx?: string;
  /** P13.4: a stop demand / pursuit this fleet is under (owner-only) */
  lawStop?: import('./law').LawStop;
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

/** `causal` (inherited from CommanderDef) marks the account-exclusive commander BB */
export interface WCommander extends Omit<CommanderDef, 'team'> {
  owner: string | null;       // null → available for hire
  stationId: string | null;   // where available for hire
  hireCost: number;
  xp: number;
  level: number;
  injuredUntil: number;
  battles: number;
  /** B-1 officer development (officerV worlds; created for player and recruit-pool officers only) */
  of?: import('./officers').OfficerState;
}

export interface Module {
  kind: string; progress: number; built: boolean; slot: number;
  /** Original inputs for new plans and optional core work. Old plans use historical defaults. */
  materials?: Record<string, number>;
  work?: number;
  /** Identifies a P9.6.3 facility investment for asset valuation. */
  economy?: 'p963';
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
  /** P9.6 station structure; absent for public and legacy stations with their original rules. */
  size?: Size;
  /** B-1: fractional material savings of the station director, per item (whole units are returned) */
  ofSave?: Record<string, number>;
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
  /** NPC buying budget (P4): credits the station can pay players for goods; regenerates */
  funds?: number;
  fundsMax?: number;
  /** growth: maintenance capacity left (hull-points) and when it was last refilled */
  dockCap?: { left: number; t: number };
  /** finished ships in the public yard (P6): hull id → stock and restock progress (seconds) */
  shipStock?: Record<string, { n: number; t: number; why?: string }>;
  /** player ship sale listings (ship stays docked, locked) */
  shipListings?: ShipListing[];
  /** P10: territorial faction that hosts this public market (its programs draw from this stock) */
  faction?: string;
}

export interface Site {
  id: string;
  system: string;
  pos: V;
  /** 1 modest wreck … 3 rare archive: bigger finds and longer work, independent of system security */
  tier: number;
  name: string;
  /** survey seconds each company has put into the system while the site was hidden from it */
  scan: Record<string, number>;
  /** companies that know where it is */
  seen: string[];
  /** salvage work done / needed (ship-seconds) */
  work: number;
  need: number;
  born: number;
}

export interface ShipListing { id: string; seller: string; ship: string; price: number; t: number }

export interface ShipBuild {
  id: string; classId: string; loadoutId: string;
  hull?: string; variant?: string;
  /** Growth build's yard requirement at registration; absent on pre-P9.6.3.1 plans. */
  requiredYard?: number;
  /** P9.7 regional materials fixed when the build was registered; absent on older plans. */
  regionalMaterials?: Cargo;
  /** growth builds (contentV ≥ 3): hull preset whose weapons it mounts (else the legacy loadout's) */
  preset?: string;
  /** fitting modules installed at launch */
  fit: string[];
  /** explicit launch fitting chosen at registration (hull only / standard with industrial gear / a saved
   *  company preset): its weapons and bay items are consumed with the hull parts. Absent = preset + fit. */
  hp?: Record<string, string>;
  bay?: Record<string, string>;
  /** how the launch fitting was chosen (UI label) */
  outfit?: 'hull' | 'standard' | 'preset';
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
  /** P10: unidentified deposit model (world/geology.ts). Composition is server-only; companies learn it from samples. */
  geo?: import('./geology').FieldGeo;
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
  /** P13.2: plunder carried home by its pirate bands (real goods, only what they recovered) */
  hold?: Cargo;
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
  /** Authored exploration capacity in new layouts; absent retains the legacy rules. */
  exploration?: { slots: number; tier: 1 | 2 | 3 };
  stats: { pirateKills: number; unionLosses: number; civLosses: number; raids: number; bands: number };
  /** faction influence 0..100 (factions.ts) */
  inf?: { union: number; pirates: number; guild: number };
  /** reconstruction boom after a lair falls */
  recoverUntil?: number;
  /** P10 territory (world/territory.ts): controlling faction id, absent = unclaimed */
  faction?: string;
  /** P10 region type, drives territory rules (founding, licences, patrols, demand) */
  region?: import('./territory').RegionKind;
  /** P10: false = uncharted (not on public charts; per-company exploration intel only) */
  charted?: boolean;
  /** B-3 (sovV): public territory summary (legal sovereign, claims, control leaders, war, occupation) — replicated
   *  with the system, so fog hides it together with the system */
  terr?: import('./sovereignty').TerrPub;
}

export interface Contract {
  id: string;
  stationId: string;
  kind: 'bounty' | 'delivery' | 'lair' | 'salvage' | 'mil';
  title: string;
  desc: string;
  reward: number;
  rep: number;
  target?: string;            // group id / lair id / (A-3.2b salvage) wreck id
  res?: Res;
  amount?: number;
  progress: number;
  expires: number;
  takenBy: string | null;
  done: boolean;
  /** A-3.2b salvage contract: reward reserved from the posting station's funds at acceptance (paid out on
   *  completion, returned on failure / expiry) — the money exists in exactly one place at a time */
  escrow?: number;
  /** A-3.2b: the target was made for this contract (derelicts.ts) */
  spawned?: boolean;
  /** A-3.2b: why it ended without completion (shown to the taker) */
  ended?: string;
  /** P17.4: how a taken contract ended (complete / failed / expired / void = not the taker's fault / cancelled by
   *  the taker). Set where the contract closes so the taker's work reports the real result, not "object gone". */
  outcome?: 'complete' | 'failed' | 'expired' | 'void' | 'cancelled';
  /** B-2 military contract terms, progress and settlement (kind 'mil'; world/military.ts) */
  mil?: import('./military').MilTerms;
}

export interface Engagement {
  id: string;
  pos: V;
  start: number;               // world time
  setup: BattleSetup;
  orders: OrderRecord[];
  tick: number;                // tactical ticks simulated by the authority
  /** company ids per tactical side. Legacy: two coalitions (0 = everyone but pirates, 1 = pirates).
   *  P11 (`v: 2`): one company per side, in tactical side order — sides grow as companies join. */
  sides: string[][];
  groupRefs: string[];         // strategic groups involved
  live: boolean;               // players involved (they may command); NPC-only fights run the same engine
  done: boolean;
  summary?: string;
  winner?: number;
  lairId?: string;
  stationId?: string;
  /** overload fallback only: resolved by the strength model at this time (not watchable) */
  autoEnd?: number;
  /** side display names, e.g. ['연합 관리청', '해적'] (one per side) */
  names?: string[];
  /** live progress for maps and lists: ships alive / at start, remaining strength 0..1 (one entry per side) */
  prog?: { alive: number[]; total: number[]; value: number[]; out?: (string | null)[] };
  /** P11 multi-side engagement (st.combatV 2): one side per company, reinforcements join in place */
  v?: 2;
  /** P11: damage dealt, attacker company → target company (bounty goes by damage to pirates) */
  dmg?: Record<string, Record<string, number>>;
  /** P11: strategic groups that left this battle (withdrawn / routed side) and may not rejoin it */
  left?: string[];
  /** P13.4: a law-enforcement battle — the Union and this company are enemies here only (never a stance change) */
  law?: { op: string; co: string; ships?: [string, number][] };
  /** P11: reinforcement log (the join events themselves are in `orders`) */
  joins?: { tick: number; at: number; company: string; side: number; groups: string[]; ships: number }[];
  /** P11: companies whose side already left and whose surviving ships were handed back early */
  released?: string[];
  n?: number;                  // ships involved (for clients; setup is not in snapshots)
  sys?: string;
}

export interface BattleRecord {
  id: string; sys?: string; pos: V; start: number; end: number;
  names: string[]; winner: number; summary: string; n: number;
  /** ships lost per side */
  losses: number[];
  /** P11: per-side outcome (company, status) */
  sides?: { company: string; status: string }[];
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
  /** Growth-only managed routes. Authority owns execution; replicas receive only their own routes. */
  logistics?: Record<string, import('./logistics').LogisticsRoute>;
  logisticsJobs?: Record<string, import('./autonomousLogistics').LogisticsJob>;
  procurementPlans?: Record<string, import('./procurement').ProcurementPlan>;
  /** Unified company works and goals (world/operations.ts). Owner-only replication. */
  works?: Record<string, import('./operations').Work>;
  /** Approval documents (결재) raised by works. Owner-only replication. */
  approvals?: Record<string, import('./operations').Approval>;
  contracts: Record<string, Contract>;
  engagements: Record<string, Engagement>;
  /** P11 combat (opt-in, new worlds only): multi-side engagements, reinforcements in place, PvP */
  combatV?: 2;
  /** P12 fleet operations & autonomous command (opt-in, new worlds only; implies combatV 2) */
  opsV?: 1;
  /** P12.5 automatic logistics (opt-in, new worlds only): idle haulers are dispatched without registration */
  logisticsV?: 1;
  /** P13.1 battlefield wrecks and physical salvage (new worlds only): no random derelicts, no remote battle loot */
  salvageV?: 1;
  /** P17.1 salvage quality: gear precision, officer and wreck condition decide how much of a wreck comes back intact
   *  (new industrial worlds; saves by explicit migration). Without it every unit taken is recovered whole. */
  salvQV?: 1;
  /** industrial hardpoints (world/industrialGear.ts): player ships mine, build and salvage only with fitted gear */
  indV?: 1;
  /** P15.1: combat computers stocked on public markets at creation (new growth worlds) */
  cpuV?: number;
  /** P17.3: NPC (pirate) bands field some of the P17 hulls with their makers' computers (WorldSim.create opts.npc17 — new worlds only) */
  npc17V?: number;
  /** P17.4a: new companies get a consumable supply policy (local stores, capped emergency purchase) */
  upkeepV?: number;
  /** P16.3: carrier gear market rows added (migrateCarriers; only after carriers are released) */
  carrierV?: 1;
  /** P16.7: repair gear market rows stocked (new worlds under the repair switch, or the explicit migration) */
  repairV?: 1;
  /** A-3.2b natural derelicts and salvage contracts (salvageV worlds; new standard worlds, saves by explicit migration) */
  derelictV?: 1;
  /** B-1 officer development (new standard worlds; saves by explicit migration OFFICERS_B1_MIGRATE) */
  officerV?: 1;
  /** B-2 PMC military contracts (new standard worlds; saves by explicit migration MILITARY_B2_MIGRATE) */
  milV?: 1;
  /** B-2: posting cooldowns, battles counted per company, settled results (server-side) */
  mil?: import('./military').MilState;
  /** B-3 system sovereignty, effective control and territory war (new standard worlds; saves by TERRITORY_B3_MIGRATE) */
  sovV?: 1;
  /** B-3: claims, control, policies, wars, treaties (sovereignty.ts) — internal samples hidden from clients */
  sov?: import('./sovereignty').SovState;
  /** B-1: which named officers this world has already produced (each appears at most once per world) */
  officerNamed?: Record<string, string>;
  derelicts?: import('./derelicts').DerelictState;
  /** P13.1: persistent battlefield wrecks (salvageV worlds) */
  wrecks?: Record<string, import('./wrecks').WreckSite>;
  /** P13.2 cargo raiding & jettisoned cargo (new worlds only; implies salvageV) */
  piracyV?: 1;
  /** P13.2: cargo jettisoned by ships that gave in to a demand (recovered with the P13.1 salvage engine) */
  drops?: Record<string, import('./piracy').CargoDrop>;
  /** P13.3 black markets & smuggling (new worlds only; implies piracyV) */
  blackMarketV?: 1;
  /** P13.3: hidden black markets, one per region type (replicated only to companies that found them) */
  blackMarkets?: Record<string, import('./blackmarket').BlackMarket>;
  /** P13.4 law enforcement (new worlds only; implies blackMarketV): crimes, wanted levels, guard dispatch */
  lawV?: 1;
  /** P14.0 reputation (new worlds, or an explicit migration): company credit + six independent faction trusts */
  repV?: 1;
  /** P13.4: cases and running enforcement operations — server-side, never replicated */
  law?: import('./law').LawBook;
  /** P13.2: server-side bookkeeping (truces, event log, sequence) — never replicated */
  piracy?: import('./piracy').PiracyBook;
  /** P11: per-company stance toward other player companies. Hostility is unilateral (either side's
   *  declaration makes the pair hostile); an alliance needs both. Pirates are always hostile. */
  stance?: Record<string, { hostile?: string[]; ally?: string[] }>;
  /** P11: who declared or attacked whom, when and where (newest last, capped) */
  attackLog?: { t: number; by: string; to: string; kind: 'declare' | 'attack' | 'cease' | 'ally'; sys?: string; sec?: number }[];
  /** finished tactical battles, replayable from setup + seed + orders (newest last) */
  battleLog?: BattleRecord[];
  events: WorldEvent[];        // rolling log
  eventSeq: number;
  news: string[];
  /** industry data upgrade applied (see economy.ts) */
  industryV?: number;
  /** content-model migration applied (world/migrate.ts CONTENT_VERSION) */
  contentV?: number;
  /** Layout of a freshly created world. Existing saves are never implicitly expanded. */
  worldLayout?: 'p9' | 'p10';
  /** P10 territory: faction economies (world/territory.ts, world/factionEcon.ts) */
  factions?: Record<string, import('./territory').FactionState>;
  /** P10 active border conflicts (closed gates) */
  conflicts?: Record<string, import('./territory').Conflict>;
  /** P10 per-company exploration knowledge (world/intel.ts); only the owner's entry is ever replicated */
  intel?: Record<string, import('./intel').CompanyIntel>;
  /** P10 last faction-economy cycle time */
  factionClock?: number;
  /** faction economy version: 2 = large sustained faction economies (factionEcon2.ts, opt-in); absent = v1 */
  factionEcon?: 2;
  /** P10 fog of war: uncharted systems and unidentified fields are hidden per company */
  fog?: 1;
  /** Explicit regional-resource rules; absent on older worlds until separately activated. */
  regionalV?: 1;
  /** Value-chain market pricing (econChain.ts). Absent = the world keeps its own prices (default). */
  econ?: import('./econChain').EconChainState;
  /** econ migrations applied to this save (rollback reference: previous bases) */
  econLog?: import('./econMigrate').EconMigrationRecord[];
  /** items created by migrations (asset conservation ledger) */
  grants?: import('./migrate').GrantRecord[];
  /** existing items that changed form during migrations (not new) */
  conversions?: import('./migrate').ConversionRecord[];
  /** unique blueprints: id → holders (P6) */
  uniques?: Record<string, string[]>;
  /** exploration sites (growth): derelicts and wreck fields, hidden until a company surveys them */
  sites?: Record<string, Site>;
  /** account-exclusive content ledger (world/exclusive.ts): which verified account holds BB / BB-EX */
  exclusive?: { bbex?: import('./exclusive').ExclusiveLedger };
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
