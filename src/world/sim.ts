// Authoritative persistent-world simulation. Runs identically on the Node server (multiplayer)
// and inside the browser (single player). All state lives in `st` (plain JSON).

import { emit, emitMetric, metricBatch, observing, watchMoney, observedWork, observationCostMs } from './observe';
import { putRoute, controlRoutes, manualRoutes, pauseManualRoutes, maintainRoutes, stepRouteShip, usableRouteGate, withdrawRouteCargo, type RouteConfig } from './logistics';
import { createPoolJob, controlPoolJob, setPoolShips, interruptPoolShips, dispatchPool, maintainPool, stepPoolShip, type PoolRequest } from './autonomousLogistics';
import { planProcurement, setProcurementPolicy, setProcurementSource, stopProcurement, defaultProcurementPolicy, type ProcurementSettings, type ProcurementKind } from './procurement';
import { registerCommand, snapshot as opsSnapshot, stepOperations, workOp, createGoal, decideApproval, setOpsPolicy, book, bookedSoFar, CMD_CATEGORY, type GoalSpec, type WorkOp, type ApprovalScope, type OpsPolicy } from './operations';
import { Rng } from '../sim/rng';
import { World } from '../sim/world';
import { SHIP_CLASSES, getLoadout, SHIP_NAMES } from '../sim/data/ships';
import { ACTING_CAPTAIN, type CommanderDef } from '../sim/data/commanders';
import type { FleetSpec, GroupSpec, ShipSpec } from '../sim/fleet';
import type { Order, OrderRecord } from '../sim/types';
import type { March, WorldState, WShip, WGroup, Op, V, Res, Station, Field, Cargo, Engagement, WorldEvent, Contract, WCommander, Company, StarSystem, Gate, Lair } from './types';
import { emptyCargo, cargoSum, RES, qty, addc, takec, cargoKeys } from './types';
import { ECON, MODULES, MAX_MODULES, FOUND_COST, RES_NAME, generateCommander, MILESTONES, shipValue } from './data';
import { newWorld, migrateWorld, WORLD_VERSION } from './worldgen';
import { expandFreshWorld } from './worldgen-p9';
import { migrateContent, syncShipContent, FITTING_V, type MigrationReport } from './migrate';
import { checkFitting, fittingFromLegacy, fittingItems, shipLoadout, bayModules, placeModules, legacySig, loadoutLabel, matchingPreset, itemDelta, normFitting, type ShipFitting } from './fitting';
import { CONTENT, legacyOf, contentAvail } from '../content/registry';
import { normPlan, allocate, advance, activePlan, cancelRefund, plans, queueShortfall, missing, isSecured, prereqBuilt, planMats } from './construction';
import { stepProduction, storageCap, stationPower, stationSupportOnline, stationNeeds, stepBuilds, buildNeeds, fitUnits, yardSlots, hullName, YARD_NAME, type ProdOrder } from './production';
import { RECIPES, ITEMS, TECHS, EQUIPMENT, HULLS, facilityBuild, facilityTech, techUnlocks, techFx, fitFx, growthFx, loadoutEquipment, recipeFor, itemPrice as itemPriceOf } from './industry';
import { normalizeRegionalOrders, regionalHullMaterials, regionalMarketRequired } from './regional';
import { upgradeIndustry, npcMarketStep, SALVAGE_MIX, PROFILES, targetFor } from './economy';
import { factionStep, bump, supplyMul, LAIR_FOOTHOLD, RECOVERY_TIME, ensureInfluence } from './factions';
import { canQueue, stepResearch, learnBlueprint, projectCredits, projectTime, wreckLoot, unlockSummary } from './research';
const techName = (id: string) => TECHS[id]?.name ?? id;
import { STATION_CREW_RATE } from './data';
import { econOf, miningCargoCapacity, hullEcon, hullBuild, hullSale, hullStock, yardHulls, berthFits, berthNeed, berthOf, wearMul, growthOn, hullIdOf, shipWorth } from './hullops';
import { assetReferenceValue, regionalShipValueAdjustment, yardRestockNeed, valueOf, hullPrice, yardFee } from './valuation';
import { STARTER_BLUEPRINTS, grantBlueprint, rightsProblem, hullBlueprint, variantBlueprint, holds, useRun, buyBlueprint, assembleBlueprint, wreckFragments, contractAwards, bpName } from './blueprints';
import { payDebt, payFromSale } from './money';
import { stepUpkeep, departureHeld, maintainOnDock, upkeepOf, shipRate, REACTIVATE_S } from './upkeep';
import { enforceExclusive, exclusiveGuard, exclusiveLost, stepExclusive, isExclusiveShip, isExclusiveEquip, grantExclusive } from './exclusive';
import { BBEX_CLASS } from '../sim/bbex/data';
import { priceOf, driftV3, fundsStep, fundsIn, seedFunds } from './market';
import { publicCap, storeUsed, reservedSpace, listedSpace, logisticsReservedSpace, setLease, takesSpace, constructionRoom, serviceOf } from './storage';
import { surveyStep, surveyLeft, salvageLoot, retireSite, siteActive, knows } from './explore';
import type { Size } from '../content/schema';
import { effSec, secAt } from './security';
import { expandP10 } from './worldgen-p10';
import { repairQuote } from './repair';
import { ESCORT, pickWards, convoySlot, ringSlot, coverSlot, escortStatus, unit, type EscortPhase } from './escort';
import { expandedLayout, gateOpen, foundingRule, dockRefused, bumpStanding, FACTIONS } from './territory';
import { visit, surveyIntel, recordSample, believedMix, knowsField } from './intel';
import { mineGeo, releaseAcc } from './geology';
import { factionEconStep, warSupply } from './factionEcon';
import { dist, dist2, rockPos, miningSpot, berthPos, hashId, sysAt, nextGate, jumps } from './geom';
import { STATION_SIZES, foundingMaterials, validStationSize, facilityProblem, moduleMaterials, moduleWork, moduleUnlocks, stationSize, stationBerths, occupiedBerths, stationCargoRate } from './stations';

export const STRAT_DT = 0.25;
/** NPC-only battles share this much wall time per update (ms); beyond it they just run a bit slower */
const NPC_BATTLE_BUDGET_MS = 8;
/** safety valve: ships in concurrent NPC battles above this fall back to the strength model */
const NPC_BATTLE_CAP = 160;
const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** per-tick escort picture (world/escort.ts phases) */
interface EscortPlan { phase: EscortPhase; name: string; wc: V | null; heading: [number, number] | null; threat: V | null; ring: { at: V; r: number } | null; n: number; ids: string[]; extra: string }
const ENGAGE_R = 420;
const JOIN_R = 1700;
const WARP_MIN = 6000;      // trips longer than this use the in-system warp drive
const WARP_V = 7000;
const WARP_EXIT = 700;
const SCRAMBLE_R = 3000;   // hostile warships this close prevent warping out
const ALIGN: Record<string, number> = { corvette: 3, frigate: 3.5, destroyer: 4, light_cruiser: 5, cruiser: 6, battlecruiser: 7, battleship: 8, dreadnought: 11, miner: 5, hauler: 6, constructor: 7 };

/** outcome of a battle, from the tactical engine or the NPC auto-resolver */
interface BattleResult { winner: number; ships: { ref: string; dead: boolean; hp: number; escaped: boolean; dmg: number }[]; groupKills: Map<string, number> }

export type Cmd =
  | { c: 'setOp'; group: string; op: Op }
  | { c: 'setDetached'; group: string; on: boolean }
  | { c: 'release'; group: string }
  | { c: 'newGroup'; name: string; parent?: string | null; ships?: string[] }
  | { c: 'renameGroup'; group: string; name: string }
  | { c: 'deleteGroup'; group: string }
  | { c: 'moveShip'; ship: string; group: string }
  | { c: 'setParent'; group: string; parent: string | null }
  | { c: 'assignCmd'; group: string; commander: string | null }
  /** contentV ≥ 3: `hull` (+ `preset`) picks a hull from the yard's stock; classId/loadoutId stay for older clients */
  | { c: 'buyShip'; station: string; classId: string; loadoutId: string; group?: string; hull?: string; variant?: string; preset?: string; request?: { seq: number; id: string } }
  | { c: 'sell'; station: string; res: Res; amount: number; request?: { seq: number; id: string } }
  | { c: 'buy'; station: string; res: Res; amount: number; /** growth: load straight into this docked ship's hold */ ship?: string; request?: { seq: number; id: string } }
  | { c: 'lease'; station: string; blocks: number }
  | { c: 'repair'; ship: string; /** the cost the client showed; refused when the server charge differs */ quote?: number }
  | { c: 'refit'; ship: string; loadoutId: string }
  | { c: 'hire'; commander: string }
  | { c: 'dismiss'; commander: string }
  | { c: 'accept'; contract: string }
  | { c: 'queueModule'; station: string; kind: string }
  | { c: 'removeModule'; station: string; slot: number }
  | { c: 'planOp'; station: string; plan: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'prodOrder'; station: string; recipe: string; mode: 'count' | 'stock'; n: number }
  | { c: 'prodOp'; station: string; order: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' | 'set'; n?: number }
  | { c: 'list'; station: string; item: string; qty: number; price: number; request?: { seq: number; id: string } }
  | { c: 'delist'; station: string; listing: string; request?: { seq: number; id: string } }
  | { c: 'buyListing'; station: string; listing: string; qty: number; request?: { seq: number; id: string } }
  | { c: 'buildShip'; station: string; classId: string; loadoutId: string; fit?: string[]; group?: string; hull?: string; variant?: string; preset?: string }
  | { c: 'buildOp'; station: string; build: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'fitShip'; ship: string; fit: string[] }
  /** Fitting V2: set hardpoint weapons and bay modules (and optionally the structural variant).
   *  `buy` lets a public station sell missing items at 1.2× market price. */
  | { c: 'fit'; ship: string; variant?: string; hp: Record<string, string>; bay: Record<string, string>; buy?: boolean; preset?: string }
  | { c: 'savePreset'; name: string; variant: string; hp: Record<string, string>; bay: Record<string, string> }
  | { c: 'delPreset'; id: string }
  | { c: 'research'; station: string; tech: string; source?: 'lab' | 'salvage' | 'copy' }
  | { c: 'researchOp'; project: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'learnBlueprint'; station: string; tech: string }
  | { c: 'renameCompany'; name: string }
  // ── growth P4/P6 (contentV ≥ 3)
  | { c: 'buyBlueprint'; station: string; blueprint: string }
  | { c: 'assembleBlueprint'; station: string; blueprint: string }
  | { c: 'listShip'; ship: string; price: number }
  | { c: 'delistShip'; station: string; listing: string }
  | { c: 'buyShipListing'; station: string; listing: string; group?: string; request?: { seq: number; id: string } }
  | { c: 'reserve'; ship: string; on: boolean }
  | { c: 'autoReserve'; on: boolean }
  | { c: 'payArrears' }
  | { c: 'unloadCargo'; ship: string }
  | { c: 'putRoute'; group: string; config: RouteConfig; route?: string }
  | { c: 'routeControl'; routes: string[]; action: 'pause' | 'resume' | 'cancel' }
  | { c: 'poolShips'; ships: string[]; on: boolean }
  | { c: 'poolCreate'; request: PoolRequest }
  | { c: 'poolControl'; job: string; action: 'pause' | 'resume' | 'cancel' }
  | { c: 'procPolicy'; settings: ProcurementSettings }
  | { c: 'procSource'; station: string; kind: ProcurementKind; source: string; enabled: boolean; priority?: number }
  // ── company operations (world/operations.ts)
  | { c: 'workOp'; work: string; op: WorkOp; value?: number; price?: number }
  | { c: 'workCreate'; goal: GoalSpec; title?: string; priority?: number; budget?: number; maxPrice?: number }
  | { c: 'approvalDecide'; approval: string; option: string; scope?: ApprovalScope; value?: number }
  | { c: 'opsPolicy'; policy: Partial<OpsPolicy> & { autoBuyItem?: string; autoBuyPrice?: number } };

const PLAYER_COLORS = ['#5fd4ff', '#7dffb0', '#ffb35f', '#d79fff'];
/** "창살급 구축함" */
const hullLabel = (s: { classId: string; hull?: string }) => `${CONTENT.hulls[hullIdOf(s)]?.name ?? SHIP_CLASSES[s.classId]?.name ?? s.classId} ${SHIP_CLASSES[s.classId]?.type ?? ''}`.trim();

/** A request identity is optional for legacy clients; the latest committed request survives saves. */
function tradeRequest(last: Company['lastTrade'], request: { seq: number; id: string }, signature: string): { receipt?: NonNullable<Company['lastTrade']>; duplicate?: true; error?: string } {
  if (!request || !Number.isSafeInteger(request.seq) || request.seq < 1 || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.id)) return { error: '거래 요청 식별자가 올바르지 않습니다' };
  if (last && request.seq <= last.seq) {
    if (request.seq === last.seq && request.id === last.id && signature === last.signature) return { duplicate: true };
    return { error: '이미 지난 거래 요청입니다 — 거래 내역과 자사 보관함을 확인한 뒤 다시 시도하세요' };
  }
  if (request.seq !== (last?.seq ?? 0) + 1) return { error: '다른 거래가 먼저 처리되었거나 이전 요청이 대기 중입니다 — 시장을 새로 확인하세요' };
  return { receipt: { seq: request.seq, id: request.id, signature } };
}
/** Avoid inherited object keys and only escrow actual finite, owned inventory. */
const safeCargoItem = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && !Object.hasOwn(Object.prototype, id);

const vadd = (a: V, b: V, k = 1): V => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const vlerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** growth (rev 2): hulls cost what they take to make, so a new company starts with enough for one
 *  small hull on top of its starter fleet */
export { START_CREDITS_GROWTH } from './econConfig';
import { START_CREDITS_GROWTH } from './econConfig';

export class WorldSim {
  st: WorldState;
  rng: Rng;
  /** live tactical battles (transient; rebuilt from setup+orders on load) */
  battles = new Map<string, World>();
  private battleAcc = new Map<string, number>();
  /** per-tick escort caches (never saved: rebuilt from the groups' orders every tick) */
  private speedCap = new Map<string, number>();
  private escortPlans = new Map<string, EscortPlan>();
  private escortIdx: Map<string, WGroup[]> | null = null;
  private npcRot = 0;
  /** wall time spent stepping NPC battles (diagnostics) */
  npcBattleMs = 0;
  private acc = 0;
  private slow = 0;
  private poolDispatchAt = 0;
  private procurementAt = 0;
  /** what the content migration did on load (null = not run) */
  contentReport: MigrationReport | null = null;
  /** hooks for the server */
  /** true only while world/exclusive.ts spawns the account-exclusive hull */
  exclusiveSpawn = false;
  onBattleOrder?: (eng: string, rec: OrderRecord) => void;
  onBattleEnd?: (eng: Engagement) => void;

  /** `migrateContent: false` keeps a save on the content version it has (server default until a
   *  migration is approved); a save that is already partly migrated is kept consistent *at its own
   *  version* (repairs only — it is never moved forward without the flag) */
  constructor(st: WorldState, opts: { migrateContent?: boolean } = {}) {
    if ((st.version ?? 0) < WORLD_VERSION) st = migrateWorld(st);
    if (opts.migrateContent !== false) this.contentReport = migrateContent(st);
    else if ((st.contentV ?? 0) >= 1) this.contentReport = migrateContent(st, st.contentV);
    this.st = st;
    normalizeRegionalOrders(st);
    // Before P9.5 every player founding order was charged on issue. Preserve that already-paid
    // amount as a refundable prepayment when an old in-flight order is restored.
    if (growthOn(st)) for (const g of Object.values(st.groups)) {
      const co = st.companies[g.owner];
      if (co?.kind === 'player' && g.op.k === 'found' && !g.op.escrowed) {
        (co.foundingEscrow ??= {})[g.id] ??= FOUND_COST.credits;
        g.op.escrowed = true;
      }
    }
    this.rng = new Rng(st.seed).restore(st.rng.length ? st.rng : new Rng(st.seed).state());
    // industry: field compositions, NPC markets for the new goods, legacy facility kinds (idempotent)
    upgradeIndustry(st);
    // construction plans: give pre-plan saves their bookkeeping (idempotent)
    for (const x of Object.values(st.stations)) for (const m of x.modules) normPlan(m, () => this.id('pl'));
    // rebuild live battles
    for (const e of Object.values(st.engagements)) {
      if (e.done || e.autoEnd !== undefined) continue;
      const w = new World(e.setup);
      w.scheduleReplay(e.orders.map(o => ({ ...o })));
      while (w.tick < e.tick && !w.outcome) w.step();
      this.battles.set(e.id, w);
    }
    enforceExclusive(st);
    const c = st.clock;
    if (c) { this.acc = c.acc; this.slow = c.slow; this.npcRot = c.npcRot; for (const [k, v] of Object.entries(c.battleAcc ?? {})) if (this.battles.has(k)) this.battleAcc.set(k, v); }
  }

  /** New worlds use the P9 layout; P10 (40 systems, territory, fog) is opt-in. Saves are never converted. */
  static create(seed = 1, opts: { layout?: 'p9' | 'p10' } = {}): WorldSim {
    const sim = new WorldSim(newWorld(seed));
    expandFreshWorld(sim.st);
    if (opts.layout === 'p10') expandP10(sim.st);
    return sim;
  }

  serialize(): string {
    this.st.rng = this.rng.state();
    // sub-tick accumulators, so a restored world continues exactly where it stopped
    this.st.clock = { acc: this.acc, slow: this.slow, npcRot: this.npcRot, battleAcc: Object.fromEntries(this.battleAcc) };
    return JSON.stringify(this.st);
  }

  // ===================================================================== helpers

  id(prefix: string) { return `${prefix}${this.st.nextId++}`; }
  get time() { return this.st.time; }

  ev(kind: WorldEvent['kind'], text: string, o: Partial<WorldEvent> = {}) {
    const e: WorldEvent = { id: this.st.eventSeq++, t: this.st.time, kind, text, ...o };
    this.st.events.push(e);
    if (this.st.events.length > 400) this.st.events.splice(0, this.st.events.length - 400);
    return e;
  }

  say(g: WGroup, text: string, kind: WorldEvent['kind'] = 'radio', gap = 6) {
    if (this.time - g.lastSay < gap) return;
    g.lastSay = this.time;
    const c = this.cmdr(g);
    const pos = this.groupCenter(g);
    this.ev(kind, text, { who: `${c.rank ? c.rank + ' ' : ''}${c.name} · ${g.name}`, color: c.color, company: g.owner, pos: pos ?? undefined, ref: g.id });
  }

  cmdr(g: WGroup): CommanderDef {
    const c = g.commanderId ? this.st.commanders[g.commanderId] : null;
    if (c && c.injuredUntil <= this.time) return { ...c, team: 0 };
    return { ...ACTING_CAPTAIN, name: c ? `${c.name} (부상)` : '선임 함장' };
  }

  shipsOf(g: WGroup): WShip[] { return g.shipIds.map(id => this.st.ships[id]).filter(Boolean); }
  groupCenter(g: WGroup): V | null {
    const s = this.shipsOf(g).filter(x => x.state !== 'battle');
    if (!s.length) return null;
    const c = { x: 0, y: 0, z: 0 };
    for (const x of s) { c.x += x.pos.x; c.y += x.pos.y; c.z += x.pos.z; }
    return { x: c.x / s.length, y: c.y / s.length, z: c.z / s.length };
  }
  /** the group whose order `g` is executing (itself if it has an explicit order or no parent) */
  opOwner(g: WGroup): WGroup {
    let cur: WGroup = g;
    while (!cur.override && cur.parentId && this.st.groups[cur.parentId]) cur = this.st.groups[cur.parentId];
    return cur;
  }
  opOf(g: WGroup): Op {
    let cur: WGroup | undefined = g;
    while (cur && !cur.override && cur.parentId) cur = this.st.groups[cur.parentId];
    return cur ? cur.op : g.op;
  }
  groupValue(g: WGroup, military?: boolean): number {
    return this.shipsOf(g).filter(s => s.state !== 'battle' && (military === undefined || econOf(s).military === military)).reduce((a, s) => a + shipValue(s.classId) * (0.4 + 0.6 * s.hp), 0);
  }
  storage(st: Station, company: string): Cargo { return st.storage[company] ??= emptyCargo(); }
  hasModule(st: Station, kind: string) { return st.modules.some(m => m.kind === kind && m.built); }
  /** P9 system origins are storage coordinates, not a measure of travel distance. */
  private routeDistance(a: V, b: V): number {
    if (!expandedLayout(this.st)) return dist(a, b);
    const from = sysAt(this.st.systems, a), to = sysAt(this.st.systems, b);
    if (!from || !to || from.id === to.id) return dist(a, b);
    const n = jumps(this.st.systems, from.id, to.id);
    return n >= 99 ? Infinity : n * 200000 + dist(a, from.origin) + dist(b, to.origin);
  }
  /** why a station can't take this mining delivery (null = fine) */
  deliverProblem(st: Station | undefined, company: string, sell: boolean, berth: Size = 'S'): string | null {
    if (!st) return '하역 정거장이 사라짐';
    if (!this.canDock(st, company)) return st.owner === company ? '정거장 핵심 모듈 미완성' : '하역 권한 없음';
    if (sell && !st.market) return '시장이 없는 정거장 (자동 판매 불가 — 창고 보관을 선택하세요)';
    if (growthOn(this.st) && !berthFits(st, berth)) return `정박 시설 규모 부족 — ${berth}급 선체는 ${berth} 이상 정박 시설이 필요 (이 정거장 ${berthOf(st)})`;
    return null;
  }
  /** the largest berth a group's working ships need (growth: L/XL industrial hulls) */
  berthOfGroup(g: WGroup): Size { return growthOn(this.st) ? berthNeed(this.subtreeShips(g)) : 'S'; }

  /** best station to unload a field's ore: same system first, own stations preferred for storage */
  autoDeliver(company: string, fieldId: string, sell: boolean, berth: Size = 'S', cargo?: Cargo): string | null {
    const f = this.st.fields[fieldId]; if (!f) return null;
    const fs = sysAt(this.st.systems, f.pos)?.id;
    const goods = cargo && cargoKeys(cargo).length ? cargo : believedMix(this.st, company, f);
    let best: string | null = null, bd = Infinity;
    for (const st of Object.values(this.st.stations)) {
      if (this.deliverProblem(st, company, sell, berth) || this.intakeProblem(st, company, sell, expandedLayout(this.st) ? goods : cargo ?? f.mix ?? { [f.res]: 1 })) continue;
      if (expandedLayout(this.st) && sell && !cargoKeys(goods).some(k => st.market?.[k])) continue;
      const ss = sysAt(this.st.systems, st.pos)?.id;
      const j = !expandedLayout(this.st) && fs && ss ? jumps(this.st.systems, fs, ss) : 0;
      const d = (expandedLayout(this.st) ? this.routeDistance(f.pos, st.pos) : Math.hypot(st.pos.x - f.pos.x, st.pos.z - f.pos.z) + j * 200000) * (!sell && st.owner === company ? 0.6 : 1);
      if (d < bd) { bd = d; best = st.id; }
    }
    return best;
  }

  /** Intake for one item; unfinished construction is never a general warehouse. */
  intakeRoom(st: Station, company: string, item: string, construction = false): number {
    if (growthOn(this.st) && st.owner === company && !this.hasModule(st, 'core')) return constructionRoom(st, item, true);
    if (construction && growthOn(this.st) && st.owner === company && takesSpace(item)) {
      const cap = storageCap(st);
      return Math.min(constructionRoom(st, item, true), cap > 0 ? Math.max(0, cap - storeUsed(st.storage[company]) - logisticsReservedSpace(this.st, st.id, company)) : Infinity);
    }
    return takesSpace(item) ? this.room(st, company) : Infinity;
  }

  private deliveryCargo(g: WGroup, field: string, orderRoot = false): Cargo {
    const cargo: Cargo = {};
    for (const s of this.subtreeShipsInOp(g, orderRoot)) for (const k of cargoKeys(s.cargo)) addc(cargo, k, s.cargo[k]);
    if (!cargoKeys(cargo).length) { const f = this.st.fields[field]; if (f) Object.assign(cargo, believedMix(this.st, g.owner, f)); }
    return cargo;
  }

  private intakeProblem(st: Station | undefined, company: string, sell: boolean, cargo: Cargo): string | null {
    if (!st || !growthOn(this.st)) return null;
    for (const k of cargoKeys(cargo)) {
      if (this.intakeRoom(st, company, k) > 0.01) return null;
      if (sell && st.market?.[k] && (st.funds === undefined || st.funds >= this.price(st, k, 'sell') * (1 - (st.tax ?? 0)))) return null;
      if (Object.values(this.st.contracts).some(c => !c.done && c.takenBy === company && c.kind === 'delivery' && c.stationId === st.id && c.res === k && (c.amount ?? 0) > c.progress)) return null;
    }
    return sell ? '창고 가득 · 판매 가능한 품목의 구매 예산 부족 — 임대·재고 판매·다른 하역지 지정 필요' : '창고 가득 — 임대·재고 이동·창고 증설 필요';
  }

  /** strategic cruise speed: hull, fitted drives, propulsion research */
  cruiseOf(s: WShip): number {
    const co = this.st.companies[s.owner];
    const e = econOf(s);
    if (!co || co.kind !== 'player') return e.cruise;
    return e.cruise * techFx(co.tech).cruiseMul * (s.fit?.length ? fitFx(s.fit, undefined).speedMul : 1) * (growthOn(this.st) ? wearMul(s) : 1);
  }
  /** combat effects of a ship's fitting + its company's research and armouries */
  shipFxOf(s: WShip) {
    const co = this.st.companies[s.owner];
    const armory = Object.values(this.st.stations).some(x => x.owner === s.owner && this.hasModule(x, 'armory') && stationSupportOnline(x));
    const fx = fitFx(s.fit, co?.tech, armory);
    if (!growthOn(this.st)) return fx;
    // P5: shield modules and research combat effects
    const g = growthFx(s.fit, co?.tech);
    const o: ReturnType<typeof fitFx> & import('../sim/fleet').ShipFx = fx;
    for (const k of ['hpMul', 'armorMul', 'speedMul', 'accMul', 'pdMul'] as const) if (g[k] !== undefined) o[k] *= g[k]!;
    if (g.evasion) o.evasion += g.evasion;
    if (g.shield) { o.shield = g.shield; o.shieldRegen = g.shieldRegen; }
    if (g.fam) o.fam = g.fam;
    return o;
  }

  // ------------------------------------------------------------------ fitting V2 (growth P2)

  /** does this ship use Fitting V2? (player ships once the save reached FITTING_V) */
  fitsV2(s: WShip): boolean {
    return (this.st.contentV ?? 0) >= FITTING_V && this.st.companies[s.owner]?.kind === 'player';
  }

  /** (re)build a ship's fitting from its legacy loadout + modules. Returns modules that found no bay
   *  (the caller puts them in storage — nothing is dropped). */
  private legacyFitting(s: WShip): string[] {
    const r = fittingFromLegacy(s.classId, s.loadoutId, s.fit); if (!r) return [];
    s.hull = r.hull; s.variant = r.variant; s.fitting = r.fitting;
    s.fit = bayModules(r.variant, r.fitting);
    r.fitting.sig = legacySig(s.loadoutId, s.fit);
    return r.unplaced;
  }

  /** combat-engine fitting of a V2 ship: mounts from its hardpoints, hull mods from its variant */
  fittingSpec(s: WShip): ShipSpec['fit'] | undefined {
    if (!s.fitting || !s.variant) return undefined;
    // same synthesis the renderers use (shipLoadout), so what is drawn is what fights
    const l = shipLoadout(s);
    return { name: l.name, mounts: l.mounts, hpMul: l.hpMul, armorMul: l.armorMul, speedMul: l.speedMul, ...(l.mesh ? { mesh: l.mesh } : {}) };
  }

  /** move a docked V2 ship to a new fitting: rules → inventory (all or nothing) → fees → apply.
   *  Removed items go to the company's storage at that station; added items come from it, or are
   *  bought (public stations, `buy`). Returns an error message, or null. */
  private applyFitting(company: string, s: WShip, variant: string, nf: ShipFitting, o: { buy?: boolean; preset?: string; what: string }): string | null {
    if (isExclusiveShip(s)) return 'BB-EX의 전용 장비는 분리하거나 교체할 수 없습니다';
    if ([...Object.values(nf.hp), ...Object.values(nf.bay)].some(isExclusiveEquip)) return 'BB-EX 전용 장비는 다른 함선에 장착할 수 없습니다';
    const co = this.st.companies[company];
    if (!s.fitting || !s.variant || !s.hull) return '이 함선은 아직 피팅 V2가 적용되지 않았습니다';
    if (s.task.k !== 'docked') return '정박 중이어야 함';
    const st = this.st.stations[s.task.station];
    const ownFit = st.owner === company && (this.hasModule(st, 'fitting') || yardSlots(st).length > 0);
    const pub = !!(st.public && st.services.refit);
    if (!ownFit && !pub) return '피팅 시설이 없는 정거장';
    if (ownFit && !stationSupportOnline(st)) return '전력 부족 — 발전시설을 증설한 뒤 피팅하세요';
    const v = Object.hasOwn(CONTENT.variants, variant) ? CONTENT.variants[variant] : undefined;
    if (!v || v.hull !== s.hull) return '이 선체의 변형이 아님';
    if (variant !== s.variant && !contentAvail(variant, this.st.contentV)) return `${v.name}: 이 월드에서는 아직 사용할 수 없는 구조`;
    if (variant !== s.variant && growthOn(this.st)) { const nt = (v.needs?.tech ?? []).find(t => !co.tech?.includes(t)); if (nt) return `${v.name}: 연구 필요 (${techName(nt)})`; }
    // blueprint-graded variants: changing *to* one needs its blueprint (P6); a ship that already is
    // that variant (built or bought) keeps it without one
    if (variant !== s.variant && v.blueprint !== 'common') {
      const vb = variantBlueprint(variant);
      if (!growthOn(this.st)) return `${v.name}: 설계도 필요 (아직 획득 경로 없음)`;
      if (!vb || !holds(co, vb)) return `${v.name}: 변형 설계도 필요 (${vb ? bpName(vb) : '판매되지 않음'})`;
    }
    const rep = checkFitting(variant, nf);
    if (rep.errors.length) return rep.errors[0] + (rep.errors.length > 1 ? ` 외 ${rep.errors.length - 1}건` : '');
    const delta = itemDelta(fittingItems(s.fitting), fittingItems(nf));
    const store = this.storage(st, company);
    const buyList: [string, number, number, boolean][] = [];
    for (const [k, n] of Object.entries(delta)) {
      if (n <= 0) continue;
      const short = n - Math.floor(qty(store, k) + 1e-9);
      if (short <= 0) continue;
      const e = EQUIPMENT[k];
      if (!o.buy || !pub) return `${e?.name ?? k} ${short}개 부족 (보관함에 ${Math.floor(qty(store, k))})${pub ? '' : ' — 자사 시설은 장비를 판매하지 않음'}`;
      if (e?.tech && !co.tech?.includes(e.tech)) return `${e.name}: 연구 필요 (${techName(e.tech)}) — 구매 불가`;
      const actualMarket = regionalMarketRequired(this.st, k);
      const m = actualMarket && st.market && Object.hasOwn(st.market, k) ? st.market[k] : undefined;
      if (actualMarket && (!m || !Number.isFinite(m.stock) || m.stock < short)) return `${e?.name ?? k}: 시장 재고 부족 — 실제 재고가 있는 시장이나 플레이어 거래소를 이용하세요`;
      const unit = actualMarket ? this.price(st, k, 'buy') : itemPriceOf(k) * 1.2;
      if (!Number.isFinite(unit) || unit <= 0) return `${e?.name ?? k}: 유효하지 않은 시장 가격`;
      buyList.push([k, short, unit, actualMarket]);
    }
    const buyCost = Math.round(buyList.reduce((a, [, n, unit, market]) => a + (market ? 0 : n * unit), 0))
      + buyList.reduce((a, [, n, unit, market]) => a + (market ? n * unit : 0), 0);
    const changed = Object.keys(delta).length;
    const varFee = variant !== s.variant && !ownFit ? Math.round(shipWorth(this.st, s) * 0.15) : 0;
    const fee = ownFit ? 0 : (changed ? 400 + changed * 300 : 0) + varFee;
    if (!changed && variant === s.variant) return '변경 사항 없음';
    if (co.credits < fee + buyCost) return `자금 부족 — ${(fee + buyCost).toLocaleString()} cr 필요`;
    const extra = -Object.entries(delta).reduce((n, [k, amount]) => n + (takesSpace(k) ? amount : 0), 0)
      + buyList.reduce((n, [k, amount]) => n + (takesSpace(k) ? amount : 0), 0);
    if (growthOn(this.st) && extra > 0 && this.overCap(st, company, extra)) return '창고 용량 부족 — 해제할 장비를 보관할 공간을 확보하세요';
    // all checks passed: from here nothing can fail
    co.credits -= fee + buyCost;
    for (const [k, n, unit, market] of buyList) {
      if (market) { st.market![k].stock -= n; fundsIn(st, n * unit); emit(this.st, { kind: 'market', reason: 'buy', amount: n, value: n * unit, company, station: st.id, item: k }); }
      addc(store, k, n);
    }
    for (const [k, n] of Object.entries(delta)) addc(store, k, -n);
    const pid = o.preset ?? matchingPreset(variant, nf);
    s.variant = variant;
    s.fitting = { hp: { ...nf.hp }, bay: { ...nf.bay }, ...(pid ? { preset: pid } : {}) };
    s.fit = bayModules(variant, s.fitting);
    s.loadoutId = loadoutLabel(s.classId, variant, s.fitting);
    s.fitting.sig = legacySig(s.loadoutId, s.fit);
    const cost = fee + buyCost;
    this.ev('money', `${s.name} ${o.what}${buyList.length ? ` · 장비 ${buyList.reduce((a, x) => a + x[1], 0)}개 구매` : ''}${cost ? ` -${cost.toLocaleString()} cr` : ''} (빠진 장비는 보관함으로)`, { company, pos: st.pos });
    return null;
  }

  /** free warehouse space for a company at a station (public stations: unlimited) */
  room(st: Station, company: string): number {
    // growth: a public station gives each company a limited allowance (+ leased blocks)
    if (st.public && growthOn(this.st)) return Math.max(0, publicCap(this.st.companies[company], st) - storeUsed(st.storage[company]) - listedSpace(st, company) - logisticsReservedSpace(this.st, st.id, company));
    if (st.owner !== company) return Infinity;
    const cap = storageCap(st);
    if (growthOn(this.st) && !this.hasModule(st, 'core')) return Object.keys(queueShortfall(st)).reduce((n, k) => n + constructionRoom(st, k, true), 0);
    const held = growthOn(this.st) ? reservedSpace(st) + listedSpace(st, company) + logisticsReservedSpace(this.st, st.id, company) : 0;
    return cap > 0 ? Math.max(0, cap - (growthOn(this.st) ? storeUsed(st.storage[company]) + held : cargoSum(this.storage(st, company)))) : Infinity;
  }
  overCap(st: Station, company: string, add: number) { return this.room(st, company) < add; }
  /** why a public warehouse refused goods, and what the player can do about it */
  storageFullMsg(st: Station, company: string, add: number): string {
    const co = this.st.companies[company];
    const used = Math.round(storeUsed(st.storage[company])), cap = publicCap(co, st), listed = Math.ceil(listedSpace(st, company));
    return `${st.name} 창고 한도 초과 — 사용 ${used.toLocaleString()}/${cap.toLocaleString()}${listed ? ` · 매물 반환 공간 ${listed.toLocaleString()}` : ''}, ${Math.round(add).toLocaleString()} 추가 불가. 창고 구획을 임대하거나, 정박한 함선 화물칸으로 바로 구매하거나, 재고를 팔거나 옮기세요 (자체 정거장의 용량은 규모와 창고 시설에 따라 다릅니다)`;
  }
  /** public markets and own stations with a trade hub host a player exchange */
  hasExchange(st: Station) { return (st.public && !!st.market) || this.hasModule(st, 'trade_hub') && stationSupportOnline(st); }

  /** what a hauler loads at `a` for this haul order, in priority order */
  private haulPick(op: Extract<Op, { k: 'haul' }>, a: Station, b: Station, store: Cargo): [string, number][] {
    if (op.res === '*all') return cargoKeys(store).map(k => [k, store[k]] as [string, number]);
    if (op.res === '*auto') {
      // what the destination's production orders and construction plans are short of
      const need = stationNeeds(b, this.st);
      for (const m of plans(b)) if (!m.paused) for (const r of planMats(m)) { const x = missing(m, r) - qty(this.storage(b, b.owner), r); if (x > 0) need[r] = Math.max(need[r] ?? 0, x); }
      return Object.entries(need).filter(([k]) => qty(store, k) >= 1).sort((x, y) => y[1] * (ITEMS[y[0]]?.price ?? 50) - x[1] * (ITEMS[x[0]]?.price ?? 50));
    }
    return [[op.res, qty(store, op.res)]];
  }

  private npcMarket(s: Station, m: import('./types').Market, dt: number) {
    const sys = this.sysOf(s.pos);
    const v3 = growthOn(this.st);
    npcMarketStep(s, m, dt, sys?.heat ?? 0, supplyMul(sys, this.time) * (this.st.conflicts ? warSupply(this.st, sys) : 1), !v3);
    if (v3) driftV3(s, m, dt, Math.max(0.15, 1 - (sys?.heat ?? 0) / 120) * supplyMul(sys, this.time));
  }

  canDock(st: Station, company: string) { return st.public ? !dockRefused(this.st, st, company) : st.owner === company && this.hasModule(st, 'core'); }

  price(st: Station, res: Res, side: 'sell' | 'buy'): number {
    return priceOf(st.market?.[res], side, growthOn(this.st));
  }

  // ===================================================================== creation

  spawnShip(owner: string, classId: string, loadoutId: string, groupId: string, pos: V, name?: string): WShip {
    if (classId === BBEX_CLASS && !this.exclusiveSpawn) throw new Error('account-exclusive hull: only the server grant creates it');
    const id = this.id('s');
    const names = SHIP_NAMES[owner === 'pirates' ? 1 : 0];
    const civ: Record<string, string> = { miner: '곡괭이', hauler: '짐꾼', constructor: '석공' };
    const nm = name ?? (civ[classId] ? `${civ[classId]} ${this.st.nextId % 100}호` : `${this.rng.pick(names)}${this.rng.chance(0.4) ? ' ' + ['II', 'III', 'IV', 'V'][this.rng.int(4)] : ''}`);
    const s: WShip = { id, owner, classId, loadoutId, name: nm, hp: 1, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, heading: this.rng.range(0, 6.28), groupId, state: 'space', task: { k: 'none' }, cargo: emptyCargo(), kills: 0 };
    syncShipContent(this.st, s);
    if (this.fitsV2(s)) this.legacyFitting(s);
    this.st.ships[id] = s;
    this.st.groups[groupId].shipIds.push(id);
    return s;
  }

  newGroup(owner: string, name: string, parentId: string | null = null, op: Op = { k: 'idle' }): WGroup {
    const g: WGroup = { id: this.id('g'), owner, name, parentId, childIds: [], shipIds: [], commanderId: null, op, override: !parentId, status: '대기', cooldown: 0, fleeing: false, lastSay: -99 };
    this.st.groups[g.id] = g;
    if (parentId) this.st.groups[parentId].childIds.push(g.id);
    return g;
  }

  newCommander(owner: string | null, tier: number, stationId: string | null = null): WCommander {
    const c: WCommander = { id: this.id('c'), owner, stationId, ...generateCommander(this.rng, tier) };
    this.st.commanders[c.id] = c;
    return c;
  }

  /** server-only: bind BB / BB-EX to the PMC of a verified account (idempotent — world/exclusive.ts) */
  grantExclusive(account: string, company: string) { return grantExclusive(this, account, company); }

  addPlayer(name: string): string { return watchMoney(this.st, 'company_creation', {}, () => this.createPlayer(name)); }

  private createPlayer(name: string): string {
    const n = Object.values(this.st.companies).filter(c => c.kind === 'player').length;
    const id = this.id('p');
    this.st.companies[id] = {
      id, name: name.slice(0, 20) || `PMC-${id}`, kind: 'player', color: PLAYER_COLORS[n % PLAYER_COLORS.length], credits: 7000, rep: 0,
      createdAt: this.time, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [], homeStation: 'astra', tech: [], research: [],
    };
    if (growthOn(this.st)) { const co = this.st.companies[id]; co.credits = START_CREDITS_GROWTH; for (const b of STARTER_BLUEPRINTS) grantBlueprint(this.st, co, b, 'starter', this.time); upkeepOf(co).last = this.time; }
    for (const s of Object.values(this.st.stations)) s.storage[id] = emptyCargo();
    const astra = this.st.stations.astra;
    const mining = this.newGroup(id, '제1 채굴반');
    const guard = this.newGroup(id, '경비대');
    const cm = this.newCommander(id, 1);
    cm.skill = Math.max(cm.skill, 0.5);
    guard.commanderId = cm.id;
    const dock = (s: WShip, i: number) => { s.state = 'docked'; const b = (i + n * 5) % 28; s.task = { k: 'docked', station: 'astra', berth: b }; s.pos = berthPos(astra, b); };
    let i = 0;
    dock(this.spawnShip(id, 'miner', 'std', mining.id, astra.pos), i++);
    dock(this.spawnShip(id, 'miner', 'std', mining.id, astra.pos), i++);
    dock(this.spawnShip(id, 'destroyer', 'aa', guard.id, astra.pos), i++);
    dock(this.spawnShip(id, 'corvette', 'gun', guard.id, astra.pos), i++);
    dock(this.spawnShip(id, 'corvette', 'gun', guard.id, astra.pos), i++);
    this.ev('world', `신생 PMC "${this.st.companies[id].name}"가 아스트라 자유항에 등록했다.`);
    this.ev('info', '아스트라 자유항에 정박 중. 채굴반을 소행성 지대로 보내 첫 수익을 올려 보자.', { company: id });
    return id;
  }

  // ===================================================================== commands

  command(company: string, cmd: Cmd): string | null {
    const meta = { company, ...('station' in cmd ? { station: cmd.station } : {}), ...('group' in cmd && typeof cmd.group === 'string' ? { group: cmd.group } : {}), ...('ship' in cmd && typeof cmd.ship === 'string' ? { ship: cmd.ship, group: this.st.ships[cmd.ship]?.groupId } : {}) };
    const manual = growthOn(this.st) && ['setOp', 'release', 'setParent', 'deleteGroup', 'moveShip', 'listShip', 'unloadCargo'].includes(cmd.c) ? manualRoutes(this, company, 'group' in cmd ? cmd.group : undefined, 'ship' in cmd ? cmd.ship : undefined) : [];
    if (cmd.c === 'setParent' && cmd.parent && growthOn(this.st)) manual.push(...manualRoutes(this, company, cmd.parent));
    const poolManual: WShip[] = [];
    if (growthOn(this.st)) {
      if (['setOp', 'release', 'setParent', 'setDetached', 'deleteGroup', 'putRoute'].includes(cmd.c) && 'group' in cmd && typeof cmd.group === 'string') {
        const g = this.st.groups[cmd.group]; if (g?.owner === company) poolManual.push(...this.subtreeShipsInOp(g, true));
      }
      if (['moveShip', 'listShip', 'unloadCargo', 'reserve', 'fit', 'fitShip', 'refit', 'buy'].includes(cmd.c) && 'ship' in cmd && typeof cmd.ship === 'string') {
        const s = this.st.ships[cmd.ship]; if (s?.owner === company) poolManual.push(s);
      }
      if (cmd.c === 'routeControl' && cmd.action === 'resume' && Array.isArray(cmd.routes)) for (const id of cmd.routes) {
        const r = this.st.logistics?.[id], g = r && this.st.groups[r.group]; if (r?.owner === company && g) poolManual.push(...this.subtreeShipsInOp(g, true));
      }
    }
    const opsBefore = growthOn(this.st) ? opsSnapshot(this, company, cmd) : undefined, bookedBefore = bookedSoFar(this.st, company);
    return watchMoney(this.st, cmd.c, meta, () => {
      const err = this.executeCommand(company, cmd);
      if (!err && opsBefore) {
        const co = this.st.companies[company];
        // cash ledger: what this command moved, minus what nested paths (market sales) already booked
        if (co) book(this, company, CMD_CATEGORY[cmd.c] ?? (cmd.c === 'sell' ? 'sales' : 'other'), co.credits - opsBefore.credits - (bookedSoFar(this.st, company) - bookedBefore));
        registerCommand(this, company, cmd, opsBefore);
      }
      if (!err && manual.length) pauseManualRoutes(this, manual);
      if (!err && poolManual.length) interruptPoolShips(this, poolManual, '수동 명령 우선 — 기존 화물은 함선에 보존');
      if (!err && growthOn(this.st)) {
        this.reconcileFoundEscrows(company);
        if (['queueModule', 'prodOrder', 'buildShip'].includes(cmd.c)) this.st.companies[company].procurement ??= defaultProcurementPolicy();
        if (cmd.c === 'procPolicy' && !cmd.settings.enabled) stopProcurement(this, company, 'paused');
        if (cmd.c === 'procSource' && !cmd.enabled) stopProcurement(this, company, 'paused', cmd.station, cmd.kind, cmd.source);
        if (cmd.c === 'planOp' && (cmd.op === 'pause' || cmd.op === 'cancel')) stopProcurement(this, company, cmd.op === 'pause' ? 'paused' : 'closed', cmd.station, 'construction', cmd.plan);
        if (cmd.c === 'prodOp' && (cmd.op === 'pause' || cmd.op === 'cancel')) stopProcurement(this, company, cmd.op === 'pause' ? 'paused' : 'closed', cmd.station, 'production', cmd.order);
        if (cmd.c === 'buildOp' && (cmd.op === 'pause' || cmd.op === 'cancel')) stopProcurement(this, company, cmd.op === 'pause' ? 'paused' : 'closed', cmd.station, 'ship', cmd.build);
      }
      if (!err && ['poolCreate', 'poolControl', 'poolShips'].includes(cmd.c)) this.poolDispatchAt = 0;
      if (!err && ['poolCreate', 'poolControl', 'poolShips', 'procPolicy', 'procSource', 'queueModule', 'planOp', 'prodOrder', 'prodOp', 'buildShip', 'buildOp'].includes(cmd.c)) this.procurementAt = 0;
      if (!err && cmd.c === 'setOp') emit(this.st, { kind: 'logistics', reason: 'resumed', amount: 0, company, group: cmd.group });
      return err;
    });
  }

  private executeCommand(company: string, cmd: Cmd): string | null {
    const co = this.st.companies[company];
    if (!co || co.kind !== 'player') return '알 수 없는 회사';
    // account-exclusive content (BB / BB-EX) is checked on the server for every command
    const xerr = exclusiveGuard(this.st, company, cmd as unknown as Record<string, unknown> & { c: string }); if (xerr) return xerr;
    const G = (id: string) => { const g = this.st.groups[id]; return g && g.owner === company ? g : null; };
    const S = (id: string) => this.st.stations[id];
    switch (cmd.c) {
      case 'setDetached': {
        const g = G(cmd.group); if (!g) return '부대를 찾을 수 없음';
        if (!g.parentId) return '최상위 함대는 이미 독립 기동';
        g.detached = cmd.on; g.march = undefined;
        const top = this.marchOwner(this.st.groups[g.parentId] ?? g); top.march = undefined;
        this.say(g, cmd.on ? '독립 기동 — 정찰·선봉 임무로 본대보다 앞서 움직입니다.' : '본대 합류 — 함대 진형을 유지합니다.', 'radio', 0);
        return null;
      }
      case 'setOp': {
        const g = G(cmd.group); if (!g) return '부대를 찾을 수 없음';
        // automatic unloading: resolve the station now (and again whenever it stops being usable)
        if (cmd.op.k === 'mine' && cmd.op.auto) {
          const berth = this.berthOfGroup(g), cargo = this.deliveryCargo(g, cmd.op.field, true);
          const deliver = this.autoDeliver(company, cmd.op.field, cmd.op.sell, berth, cargo);
          if (!deliver && growthOn(this.st) && this.st.fields[cmd.op.field] && this.subtreeShips(g).some(s => econOf(s).mine > 0)) {
            const causes = new Map<string, number>();
            for (const station of Object.values(this.st.stations)) if (station.public || station.owner === company) {
              const why = this.deliverProblem(station, company, cmd.op.sell, berth) ?? this.intakeProblem(station, company, cmd.op.sell, cargo);
              if (why) causes.set(why, (causes.get(why) ?? 0) + 1);
            }
            return `자동 하역 가능한 정거장이 없습니다 — ${[...causes].map(([why, n]) => `${why} (${n}곳)`).join('; ')}. 구획 임대·재고 이동·구매 예산 회복·정박 규격을 확인하세요. 화물은 함선에 보존됩니다.`;
          }
          cmd.op = { ...cmd.op, deliver: deliver ?? '' };
        }
        const err = this.validateOp(company, g, cmd.op);
        if (err) return err;
        if (cmd.op.k === 'found') {
          if (growthOn(this.st)) {
            // New commands always select a size, including commands from older clients.
            // Previously saved in-flight founding orders are left untouched on load.
            cmd.op = { ...cmd.op, size: cmd.op.size ?? 'S' };
            const held = co.foundingEscrow?.[g.id] ?? 0;
            const spec = STATION_SIZES[cmd.op.size!];
            const prior = held > 0 && g.op.k === 'found' && g.op.escrowed && g.op.size === cmd.op.size ? g.op : undefined;
            const price = prior ? held : spec.credits;
            const materials = prior ? foundingMaterials(cmd.op.size!, held, prior.foundationMats) : spec.mats;
            const difference = price - held;
            if (difference > 0 && co.credits < difference) return `${difference.toLocaleString()} cr 필요`;
            // Only the constructor's actual cargo and its current dock's free stock can travel
            // with it. A market elsewhere never moves resources into this hold.
            const con = this.shipsOf(g).find(s => s.classId === 'constructor')!;
            const at = con.state === 'docked' && con.task.k === 'docked' ? this.st.stations[con.task.station] : undefined;
            if (at && this.canDock(at, company)) {
              let room = Math.max(0, Math.floor(econOf(con).cargo * techFx(co.tech).cargoMul - cargoSum(con.cargo)));
              for (const [item, needed] of Object.entries(materials)) {
                const n = takec(this.storage(at, company), item, Math.min(room, Math.max(0, needed - qty(con.cargo, item))));
                if (n > 0) { addc(con.cargo, item, n); room -= n; }
              }
            }
            co.credits -= difference; (co.foundingEscrow ??= {})[g.id] = price;
            // Both the prepayment marker and the material terms are server-authoritative.
            cmd.op = { ...cmd.op, escrowed: true, foundationMats: { ...materials } };
          } else {
            const e2 = this.prepareFound(company, g);
            if (e2) return e2;
          }
        }
        for (const s of this.subtreeShipsInOp(g, true)) delete s.cargoWork;
        g.op = cmd.op; g.override = true; g.fleeing = false; g.march = undefined;
        for (const s of this.shipsOf(g)) if (s.state !== 'battle' && s.state !== 'docked') s.task = { k: 'none' };
        this.ackOp(g, cmd.op);
        return null;
      }
      case 'release': {
        const g = G(cmd.group); if (!g || !g.parentId) return '상위 부대가 없음';
        g.override = false; this.say(g, '지휘권 위임 확인. 상위 부대 작전에 합류합니다.', 'radio', 0);
        return null;
      }
      case 'newGroup': {
        if (cmd.parent && !G(cmd.parent)) return '상위 부대 없음';
        const g = this.newGroup(company, cmd.name.slice(0, 18) || '새 편대', cmd.parent ?? null);
        for (const sid of cmd.ships ?? []) this.command(company, { c: 'moveShip', ship: sid, group: g.id });
        return null;
      }
      case 'renameGroup': { const g = G(cmd.group); if (!g) return '부대 없음'; g.name = cmd.name.slice(0, 18) || g.name; return null; }
      case 'deleteGroup': {
        const g = G(cmd.group); if (!g) return '부대 없음';
        const target = g.parentId ? G(g.parentId) : Object.values(this.st.groups).find(x => x.owner === company && x.id !== g.id && !x.parentId);
        if (g.shipIds.length && !target) return '함선을 옮길 부대가 없음';
        for (const sid of [...g.shipIds]) this.command(company, { c: 'moveShip', ship: sid, group: target!.id });
        for (const cid of [...g.childIds]) { const c = this.st.groups[cid]; c.parentId = g.parentId; if (g.parentId) this.st.groups[g.parentId].childIds.push(cid); else c.override = true; }
        if (g.parentId) { const p = this.st.groups[g.parentId]; p.childIds = p.childIds.filter(x => x !== g.id); }
        delete this.st.groups[g.id];
        return null;
      }
      case 'moveShip': {
        const s = this.st.ships[cmd.ship]; const g = G(cmd.group);
        if (!s || s.owner !== company || !g) return '대상 없음';
        if (s.state === 'battle') return '전투 중인 함선';
        const old = this.st.groups[s.groupId];
        if (old) old.shipIds = old.shipIds.filter(x => x !== s.id);
        s.groupId = g.id; g.shipIds.push(s.id);
        if (s.state !== 'docked') s.task = { k: 'none' };
        return null;
      }
      case 'setParent': {
        const g = G(cmd.group); if (!g) return '부대 없음';
        if (cmd.parent) {
          const p = G(cmd.parent); if (!p || p.id === g.id) return '상위 부대 오류';
          let a: WGroup | undefined = p; while (a) { if (a.id === g.id) return '순환 구조 불가'; a = a.parentId ? this.st.groups[a.parentId] : undefined; }
        }
        if (g.parentId) { const op = this.st.groups[g.parentId]; op.childIds = op.childIds.filter(x => x !== g.id); }
        g.parentId = cmd.parent; if (cmd.parent) { this.st.groups[cmd.parent].childIds.push(g.id); g.override = false; } else g.override = true;
        return null;
      }
      case 'assignCmd': {
        const g = G(cmd.group); if (!g) return '부대 없음';
        if (cmd.commander) {
          const c = this.st.commanders[cmd.commander]; if (!c || c.owner !== company) return '지휘관 없음';
          for (const o of Object.values(this.st.groups)) if (o.commanderId === c.id) o.commanderId = null;
        }
        g.commanderId = cmd.commander;
        if (cmd.commander) this.say(g, `${g.name} 지휘를 맡겠습니다.`, 'radio', 0);
        return null;
      }
      case 'buyShip': {
        if (growthOn(this.st)) {
          let receipt: Company['lastTrade'];
          if (cmd.request !== undefined) {
            const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['buyShip', cmd.station, cmd.classId, cmd.loadoutId, cmd.group ?? null, cmd.hull ?? null, cmd.variant ?? null, cmd.preset ?? null]));
            if (checked.error) return checked.error;
            if (checked.duplicate) return null;
            receipt = checked.receipt;
          }
          const err = this.buyHull(co, cmd, G);
          if (!err && receipt) co.lastTrade = receipt;
          return err;
        }
        const st = S(cmd.station); const cls = SHIP_CLASSES[cmd.classId]; const ec = ECON[cmd.classId];
        if (!st || !cls || !ec) return '구매 불가';
        if (st.owner === company) return '자사 조선소는 부품으로 직접 건조합니다 — 조선소 탭의 건조 대기열을 쓰세요';
        const own = false;
        if (!(st.public && st.services.shipyard.includes(cmd.classId))) return '이 정거장에서 건조하지 않는 함급';
        if (!own && co.rep < ec.rep) return `연합 평판 ${ec.rep} 필요`;
        const price = own ? Math.round(ec.price * 0.5) : ec.price;
        if (co.credits < price) return '자금 부족';
        if (own && qty(this.storage(st, company), 'alloy') < ec.alloy) return `합금 ${ec.alloy} 필요`;
        co.credits -= price;
        if (own) addc(this.storage(st, company), 'alloy', -ec.alloy);
        let g = cmd.group ? G(cmd.group) : null;
        if (!g) g = this.newGroup(company, ec.military ? '신규 편대' : `${cls.type}반`);
        const s = this.spawnShip(company, cmd.classId, getLoadout(cmd.classId, cmd.loadoutId).id, g.id, st.pos);
        this.dockShip(s, st);
        this.ev('money', `${cls.name} ${cls.type} "${s.name}" 인수 (-${price.toLocaleString()} cr)`, { company, pos: st.pos });
        return null;
      }
      case 'sell': case 'buy': {
        if (typeof cmd.amount !== 'number' || !Number.isFinite(cmd.amount)) return '거래 수량이 올바르지 않습니다';
        let saleReceipt: Company['lastTrade'];
        if (cmd.c === 'sell' && growthOn(this.st) && cmd.request !== undefined) {
          const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['sell', cmd.station, cmd.res, cmd.amount]));
          if (checked.error) return checked.error;
          if (checked.duplicate) return null;
          saleReceipt = checked.receipt;
        }
        let receipt: Company['lastPurchase'];
        if (cmd.c === 'buy' && growthOn(this.st) && cmd.request !== undefined) {
          const request = cmd.request, last = co.lastPurchase;
          if (!request || !Number.isSafeInteger(request.seq) || request.seq < 1 || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.id)) return '구매 요청 식별자가 올바르지 않습니다';
          const signature = JSON.stringify([cmd.station, cmd.res, cmd.amount, cmd.ship ?? null]);
          if (last && request.seq <= last.seq) {
            if (request.seq === last.seq && request.id === last.id && signature === last.signature) return null;
            return '이미 지난 구매 요청입니다 — 시장 재고와 자사 보관함을 확인한 뒤 다시 시도하세요';
          }
          if (request.seq !== (last?.seq ?? 0) + 1) return '다른 구매가 먼저 처리되었거나 이전 요청이 대기 중입니다 — 시장을 새로 확인하세요';
          receipt = { seq: request.seq, id: request.id, signature };
        }
        const st = S(cmd.station); if (!st?.market || typeof cmd.res !== 'string' || !Object.hasOwn(st.market, cmd.res)) return '거래 불가';
        const store = this.storage(st, company);
        const amt = Math.floor(Math.max(0, cmd.amount));
        if (cmd.c === 'sell') {
          const a = Math.min(amt, Math.floor(qty(store, cmd.res))); if (a <= 0) return '창고에 자원 없음';
          const r = this.sellAt(st, company, cmd.res, a); addc(store, cmd.res, -r.sold);
          if (r.sold <= 0) return `${st.name}의 구매 예산이 바닥났습니다 — 예산은 시간이 지나면 회복됩니다 (현재 ${Math.round(st.funds ?? 0).toLocaleString()} cr)`;
          if (saleReceipt) co.lastTrade = saleReceipt;
          this.ev('money', `${RES_NAME[cmd.res]} ${Math.round(r.sold)} 판매 +${Math.round(r.value).toLocaleString()} cr${r.sold < a ? ` — 정거장 구매 예산 소진, ${Math.round(a - r.sold)}은(는) 보관함에 남음` : ''}`, { company, pos: st.pos });
        } else {
          const m = st.market[cmd.res]; const a = Math.min(amt, Math.floor(m.stock)); const cost = a * this.price(st, cmd.res, 'buy');
          if (a <= 0) return '재고 없음'; if (co.credits < cost) return '자금 부족';
          // growth: buy straight into a docked ship's hold (no warehouse needed — e.g. for a new station's materials)
          const ship = cmd.ship && growthOn(this.st) ? this.st.ships[cmd.ship] : undefined;
          if (cmd.ship && growthOn(this.st)) {
            if (!ship || ship.owner !== company || ship.task.k !== 'docked' || ship.task.station !== st.id) return '이 정거장에 정박 중인 자사 함선이 아님';
            const free = Math.floor(econOf(ship).cargo - cargoSum(ship.cargo));
            if (free < a) return `화물칸 부족 — ${ship.name} 여유 ${Math.max(0, free)}`;
          } else if (growthOn(this.st) && st.public) {
            if (this.overCap(st, company, a)) return this.storageFullMsg(st, company, a);
          } else if ((st.owner !== company || growthOn(this.st)) && this.overCap(st, company, takesSpace(cmd.res) ? a : 0)) return '창고 용량 부족';
          emit(this.st, { kind: 'market', reason: 'buy', amount: a, value: cost, company, station: st.id, item: cmd.res });
          co.credits -= cost; m.stock -= a; addc(ship ? ship.cargo : store, cmd.res, a);
          if (growthOn(this.st) && st.public) fundsIn(st, cost);
          if (receipt) co.lastPurchase = receipt;
          this.ev('money', `${RES_NAME[cmd.res]} ${a} 구매 -${Math.round(cost).toLocaleString()} cr`, { company, pos: st.pos });
        }
        return null;
      }
      case 'repair': {
        const s = this.st.ships[cmd.ship];
        const q = s ? repairQuote(this.st, s, co) : null;
        if (!s || !q) return '정박 중인 함선만 수리 가능';
        if (q.why) return q.why;
        // the client shows a quote; if the charge changed since (hp, research, hull value), refuse rather than surprise
        if (typeof cmd.quote === 'number' && Number.isFinite(cmd.quote) && Math.round(cmd.quote) !== q.cost) return `수리비가 바뀌었습니다 (${Math.round(cmd.quote).toLocaleString()} → ${q.cost.toLocaleString()} cr) — 견적을 확인한 뒤 다시 시도하세요`;
        const st = S(s.task.k === 'docked' ? s.task.station : '');
        co.credits -= q.cost; emit(this.st, { kind: 'cost', reason: 'repair', amount: q.cost, company, group: s.groupId, ship: s.id, station: st.id }); s.hp = 1;
        this.ev('money', `${s.name} 수리 완료 -${q.cost.toLocaleString()} cr`, { company });
        return null;
      }
      case 'refit': {
        const s = this.st.ships[cmd.ship]; if (!s || s.owner !== company || s.task.k !== 'docked') return '정박 중이어야 함';
        if (s.fitting) {
          // V2: a loadout is a hull preset — its weapons on the hardpoints, current modules kept
          const m = legacyOf(s.classId, getLoadout(s.classId, cmd.loadoutId).id); const p = m && CONTENT.presets[m.preset];
          if (!p) return '알 수 없는 무장 구성';
          let bay = s.fitting.bay;
          if (p.variant !== s.variant) {
            const pl = placeModules(p.variant, s.fit ?? []);
            if (pl.unplaced.length) return '이 구성으로는 장착 모듈을 모두 수용할 수 없음';
            bay = pl.bay;
          }
          return this.applyFitting(company, s, p.variant, { hp: { ...p.weapons }, bay: { ...bay } }, { buy: true, preset: p.id, what: `무장 구성 변경: ${p.name}` });
        }
        const st = S(s.task.station);
        const ownFit = st.owner === company && (this.hasModule(st, 'fitting') || yardSlots(st).length > 0);
        if (!st.services.refit && !ownFit) return '개조 시설 없음';
        if (ownFit && !stationSupportOnline(st)) return '전력 부족 — 발전시설을 증설한 뒤 피팅하세요';
        if (ownFit) {
          // own facility: the new weapons come from storage, the old ones go back into it
          const cur = loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts), nxt = loadoutEquipment(getLoadout(s.classId, cmd.loadoutId).mounts);
          const store = this.storage(st, company);
          for (const [k, n] of Object.entries(nxt)) if (n > (cur[k] ?? 0) && qty(store, k) < n - (cur[k] ?? 0)) return `${RES_NAME[k]} ${n - (cur[k] ?? 0)} 필요 (보관함에 ${Math.floor(qty(store, k))})`;
          for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt)])) addc(store, k, (cur[k] ?? 0) - (nxt[k] ?? 0));
          s.loadoutId = getLoadout(s.classId, cmd.loadoutId).id;
          syncShipContent(this.st, s);
          this.ev('money', `${s.name} 무장 교체: ${getLoadout(s.classId, s.loadoutId).name} (기존 무장은 창고로)`, { company });
          return null;
        }
        const cost = Math.round(shipWorth(this.st, s) * 0.15);
        if (co.credits < cost) return '자금 부족';
        co.credits -= cost; s.loadoutId = getLoadout(s.classId, cmd.loadoutId).id;
        syncShipContent(this.st, s);
        this.ev('money', `${s.name} 개조: ${getLoadout(s.classId, s.loadoutId).name} -${cost.toLocaleString()} cr`, { company });
        return null;
      }
      case 'hire': {
        const c = this.st.commanders[cmd.commander]; if (!c || c.owner) return '고용 불가';
        if (co.credits < c.hireCost) return '자금 부족';
        co.credits -= c.hireCost; c.owner = company; c.stationId = null;
        this.ev('money', `${c.rank} ${c.name} 영입 -${c.hireCost.toLocaleString()} cr`, { company, who: c.name, color: c.color });
        return null;
      }
      case 'dismiss': {
        const c = this.st.commanders[cmd.commander]; if (!c || c.owner !== company) return '대상 없음';
        for (const g of Object.values(this.st.groups)) if (g.commanderId === c.id) g.commanderId = null;
        delete this.st.commanders[c.id];
        return null;
      }
      case 'accept': {
        const k = this.st.contracts[cmd.contract]; if (!k || k.takenBy || k.done) return '수주 불가';
        if (Object.values(this.st.contracts).filter(x => x.takenBy === company && !x.done).length >= 3) return '동시 계약은 3건까지';
        emit(this.st, { kind: 'contract', reason: 'accept', amount: 1, company, station: k.stationId, item: k.kind });
        k.takenBy = company; k.expires = this.time + (k.kind === 'lair' ? 1800 : 1200);
        this.ev('info', `계약 수주: ${k.title}`, { company, pos: S(k.stationId).pos });
        return null;
      }
      case 'queueModule': {
        const st = S(cmd.station); const md = typeof cmd.kind === 'string' && Object.hasOwn(MODULES, cmd.kind) ? MODULES[cmd.kind] : undefined;
        if (!st || st.owner !== company || !md || (md.growth && !growthOn(this.st))) return '건설 불가';
        const growth = growthOn(this.st), cost = facilityBuild(md, growth);
        if (md.kind === 'core') return '도킹 허브는 정거장 설립 시 함께 건설됨';
        if (st.modules.length >= MAX_MODULES) return `시설 슬롯 부족 (${st.modules.length}/${MAX_MODULES})`;
        if (md.requires && !st.modules.some(m => m.kind === md.requires)) return `${MODULES[md.requires].name} 필요`;
        const tech = facilityTech(md, growth);
        if (tech && !co.tech?.includes(tech)) return `연구 필요: ${techName(tech)}`;
        const problem = facilityProblem(st, md.kind); if (problem) return problem;
        if (md.max !== undefined && st.modules.filter(m => m.kind === md.kind).length >= md.max) return md.max === 1 ? '이미 보유하거나 계획된 시설 (정거장당 1개)' : `정거장당 최대 ${md.max}개`;
        // credits are paid now; materials may arrive later — the plan waits for them
        if (co.credits < cost.credits) return `자금 부족 — ${Math.ceil(cost.credits - co.credits).toLocaleString()} cr 더 필요`;
        co.credits -= cost.credits;
        const m = normPlan({ kind: md.kind, progress: 0, built: false, slot: this.freeSlot(st), paid: cost.credits, ...(growth ? { materials: { ...cost.mats }, economy: 'p963' as const } : {}) }, () => this.id('pl'));
        st.modules.push(m);
        // take what is already in storage right away so the panel shows it immediately
        allocate(st, this.storage(st, company));
        const short = planMats(m).filter(r => missing(m, r) > 1e-6).map(r => `${RES_NAME[r]} ${Math.ceil(missing(m, r))}`);
        this.ev('info', `${st.name}: ${md.name} 건설 계획 등록 — ${short.length ? `자재 대기 (${short.join(', ')} 부족)` : '자재 확보 완료'}`, { company, pos: st.pos, tag: 'build_plan' });
        return null;
      }
      case 'removeModule': {
        const st = S(cmd.station);
        if (!growthOn(this.st) || !st || st.owner !== company) return '자사 정거장에서만 시설을 철거할 수 있습니다';
        if (!Number.isSafeInteger(cmd.slot)) return '시설을 선택하세요';
        const m = st.modules.find(x => x.slot === cmd.slot && x.built);
        if (!m || m.kind === 'core') return '철거할 수 없는 시설입니다';
        const md = MODULES[m.kind]; if (!md) return '알 수 없는 시설입니다';
        const remaining = st.modules.filter(x => x !== m);
        if (remaining.some(o => MODULES[o.kind]?.requires === m.kind) && !remaining.some(o => o.kind === m.kind && o.built)) return '이 시설이 필요한 다른 시설 또는 건설 계획이 있습니다';
        const activeJobs = (st.jobs ?? []).filter(j => j.fac === m.kind).length;
        if (activeJobs > remaining.filter(x => x.kind === m.kind && x.built).length * (md.lines ?? 1)) return '해당 시설의 생산 작업이 끝난 뒤 철거하세요';
        if (md.yard && (st.builds ?? []).some(b => b.started)) return '진행 중인 함선 건조가 끝난 뒤 철거하세요';
        if (md.lab && (co.research ?? []).some(p => p.station === st.id && p.started)) return '진행 중인 연구가 끝난 뒤 철거하세요';
        if (m.kind === 'logistics' && Object.values(this.st.logistics ?? {}).some(r => r.owner === company && r.state === 'running' && r.config.mode === 'supply' && [r.config.from, r.config.to].includes(st.id) && ![r.config.from, r.config.to].some(id => id !== st.id && this.st.stations[id]?.owner === company && this.hasModule(this.st.stations[id], 'logistics')))) return '이 물류센터를 사용하는 생산 공급 노선을 먼저 중단하세요';
        if (m.kind === 'trade_hub' && !remaining.some(o => o.kind === 'trade_hub' && o.built) && ((st.listings?.length ?? 0) > 0 || (st.shipListings?.length ?? 0) > 0)) return '거래소의 매물을 모두 회수한 뒤 철거하세요';
        const after = { ...st, modules: remaining };
        const limit = stationBerths(after);
        if (limit !== undefined && occupiedBerths(this.st, st.id) > limit) return '정박 함선이 많습니다 — 출항 후 철거하세요';
        const recovered = Object.fromEntries(Object.entries(moduleMaterials(m)).map(([item, n]) => [item, Math.floor(n * 0.5)] as const).filter(([, n]) => n > 0));
        const store = this.storage(st, company), room = storageCap(after) - storeUsed(store) - reservedSpace(after) - listedSpace(after, company) - logisticsReservedSpace(this.st, st.id, company);
        if (Object.entries(recovered).reduce((n, [item, amount]) => n + (takesSpace(item) ? amount : 0), 0) > room + 1e-9) return '회수 자재를 보관할 공간이 부족합니다 — 먼저 재고를 옮기세요';
        st.modules = remaining;
        for (const [item, amount] of Object.entries(recovered)) {
          addc(store, item, amount);
          emit(this.st, { kind: 'produce', reason: 'facility_demolition', amount, company, station: st.id, item });
        }
        allocate(st, store);
        this.ev('info', `${st.name}: ${md.name} 철거 — 자재 50% 회수, 크레딧 환급 없음`, { company, pos: st.pos });
        return null;
      }
      case 'planOp': {
        const st = S(cmd.station);
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        const m = st.modules.find(x => x.id === cmd.plan && !x.built);
        if (!m) return '해당 건설 계획이 없음';
        const md = MODULES[m.kind];
        const store = this.storage(st, company);
        switch (cmd.op) {
          case 'pause': m.paused = true; break;
          case 'resume': m.paused = false; allocate(st, store); break;
          case 'cancel': {
            if (m.kind === 'core') return '도킹 허브는 취소할 수 없음';
            if (st.modules.some(o => o !== m && MODULES[o.kind].requires === m.kind && !st.modules.some(x => x !== m && x.kind === m.kind && x.built))) return `${md.name}이(가) 필요한 다른 계획이 있음`;
            const back = cancelRefund(m);
            for (const [k, n] of Object.entries(back.mats)) addc(store, k, n);
            co.credits += back.credits;
            st.modules.splice(st.modules.indexOf(m), 1);
            allocate(st, store); // freed materials go to the next plan in line
            const overflow = growthOn(this.st) ? Math.max(0, storeUsed(store) - storageCap(st)) : 0;
            this.ev('info', `${st.name}: ${md.name} 계획 취소 — 환불 ${back.credits.toLocaleString()} cr, 예약 자재 반환 (${Object.entries(back.mats).map(([k, n]) => `${RES_NAME[k]} ${Math.round(n)}`).join(', ') || '없음'})${m.progress > 0 ? ` · 투입된 자재는 회수 불가` : ''}${overflow > 1e-9 ? ` · 초과 보관 ${Math.ceil(overflow).toLocaleString()} — 신규 입고 불가` : ''}`, { company, pos: st.pos });
            return null;
          }
          case 'up': case 'down': case 'top': {
            const q = st.modules.filter(x => !x.built);
            const i = q.indexOf(m);
            const j = cmd.op === 'top' ? 0 : cmd.op === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= q.length || j === i) return null;
            q.splice(i, 1); q.splice(j, 0, m);
            st.modules = [...st.modules.filter(x => x.built), ...q];
            break;
          }
        }
        return null;
      }
      case 'prodOrder': {
        const st = S(cmd.station); const r = recipeFor(this.st, cmd.recipe);
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        if (!r || (r.growth && !growthOn(this.st))) return '알 수 없는 레시피';
        if (r.tech && !co.tech?.includes(r.tech)) return `연구 필요: ${techName(r.tech)}`;
        if (!st.modules.some(m => m.kind === r.fac)) return `${MODULES[r.fac].name}이(가) 없습니다 — 먼저 건설하세요`;
        const n = Math.floor(cmd.n);
        if (!(n >= 1 && n <= 1e6)) return '수량 오류';
        if ((st.orders ?? []).length >= 40) return '생산 주문은 정거장당 40개까지';
        st.seq = (st.seq ?? 0) + 1;
        (st.orders ??= []).push({ id: `o${st.seq}`, recipe: r.id, mode: cmd.mode === 'stock' ? 'stock' : 'count', n, done: 0 });
        stepProduction(st, co, 0, this.st);
        return null;
      }
      case 'prodOp': {
        const st = S(cmd.station);
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        const q = st.orders ?? []; const o = q.find(x => x.id === cmd.order);
        if (!o) return '주문 없음';
        const i = q.indexOf(o);
        switch (cmd.op) {
          case 'pause': o.paused = true; break;
          case 'resume': o.paused = false; break;
          // running batches finish (their inputs are already spent); nothing new starts
          case 'cancel': q.splice(i, 1); break;
          case 'set': { const n = Math.floor(cmd.n ?? 0); if (!(n >= 1 && n <= 1e6)) return '수량 오류'; o.n = n; break; }
          case 'up': case 'down': case 'top': {
            const j = cmd.op === 'top' ? 0 : cmd.op === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= q.length || j === i) return null;
            q.splice(i, 1); q.splice(j, 0, o);
          }
        }
        stepProduction(st, co, 0, this.st);
        return null;
      }
      // ── player market: goods are held in escrow at the station until sold or withdrawn ──
      case 'list': {
        let receipt: Company['lastTrade'];
        if (growthOn(this.st) && cmd.request !== undefined) {
          const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['list', cmd.station, cmd.item, cmd.qty, cmd.price]));
          if (checked.error) return checked.error;
          if (checked.duplicate) return null;
          receipt = checked.receipt;
        }
        const st = S(cmd.station); if (!st) return '정거장 없음';
        if (!this.hasExchange(st)) return '이 정거장에는 거래소가 없습니다';
        const n = Math.floor(cmd.qty), price = Math.round(cmd.price * 10) / 10;
        if (typeof cmd.qty !== 'number' || !Number.isFinite(cmd.qty) || !(n >= 1) || !(price > 0 && price < 1e8)) return '수량·가격 오류';
        if (!safeCargoItem(cmd.item)) return '알 수 없는 품목';
        const store = this.storage(st, company);
        if (!Object.hasOwn(store, cmd.item) || !Number.isFinite(store[cmd.item]) || store[cmd.item] < n) return '보관함에 수량 부족';
        if ((st.listings ?? []).filter(l => l.seller === company).length >= 20) return '정거장당 매물은 20개까지';
        addc(store, cmd.item, -n);
        st.seq = (st.seq ?? 0) + 1;
        (st.listings ??= []).push({ id: `l${st.seq}`, seller: company, item: cmd.item, qty: n, price, t: this.time });
        if (receipt) co.lastTrade = receipt;
        this.ev('world', `${co.name}이(가) ${st.name} 거래소에 ${RES_NAME[cmd.item]} ${n}을(를) 개당 ${price.toLocaleString()} cr에 내놓았다.`, { pos: st.pos, ref: st.id });
        return null;
      }
      case 'delist': {
        let receipt: Company['lastTrade'];
        if (growthOn(this.st) && cmd.request !== undefined) {
          const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['delist', cmd.station, cmd.listing]));
          if (checked.error) return checked.error;
          if (checked.duplicate) return null;
          receipt = checked.receipt;
        }
        const st = S(cmd.station); const l = st?.listings?.find(x => x.id === cmd.listing);
        if (!st || !l || l.seller !== company) return '매물 없음';
        if (!safeCargoItem(l.item) || !Number.isFinite(l.qty) || l.qty <= 0) return '유효하지 않은 매물입니다 — 관리자 확인이 필요합니다';
        addc(this.storage(st, company), l.item, l.qty);
        st.listings!.splice(st.listings!.indexOf(l), 1);
        if (receipt) co.lastTrade = receipt;
        return null;
      }
      case 'buyListing': {
        let receipt: Company['lastTrade'];
        if (growthOn(this.st) && cmd.request !== undefined) {
          const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['buyListing', cmd.station, cmd.listing, cmd.qty]));
          if (checked.error) return checked.error;
          if (checked.duplicate) return null;
          receipt = checked.receipt;
        }
        const st = S(cmd.station); const l = st?.listings?.find(x => x.id === cmd.listing);
        if (!st || !l) return '매물이 이미 팔렸거나 내려갔습니다';
        if (!safeCargoItem(l.item) || !Number.isFinite(l.qty) || l.qty < 1 || !Number.isFinite(l.price) || l.price <= 0) return '유효하지 않은 매물입니다';
        if (typeof cmd.qty !== 'number' || !Number.isFinite(cmd.qty)) return '수량 오류';
        if (stationSize(st) && !stationSupportOnline(st)) return '전력 부족 — 거래소 복구 대기';
        if (l.seller === company) return '자기 매물';
        const n = Math.min(Math.floor(cmd.qty), l.qty);
        if (!(n >= 1)) return '수량 오류';
        const cost = n * l.price;
        if (co.credits < cost) return `자금 부족 — ${Math.ceil(cost - co.credits).toLocaleString()} cr 더 필요`;
        if (this.overCap(st, company, takesSpace(l.item) ? n : 0)) return growthOn(this.st) && st.public ? this.storageFullMsg(st, company, n) : '창고 용량 부족';
        const seller = this.st.companies[l.seller];
        if (!seller) return '판매 회사를 찾을 수 없어 거래할 수 없습니다';
        co.credits -= cost;
        const net = cost * (1 - (st.tax ?? 0.02));
        if (seller) { seller.credits += net; seller.stats.earned += net; payFromSale(this.st, seller, net); }
        emit(this.st, { kind: 'market', reason: 'player_exchange', amount: n, value: cost, company, station: st.id, item: l.item });
        if (seller) emit(this.st, { kind: 'market.seller', reason: 'player_exchange', amount: n, value: net, company: seller.id, station: st.id, item: l.item });
        addc(this.storage(st, company), l.item, n);
        l.qty -= n;
        if (l.qty <= 0) st.listings!.splice(st.listings!.indexOf(l), 1);
        if (receipt) co.lastTrade = receipt;
        this.ev('money', `${st.name} 거래소: ${RES_NAME[l.item]} ${n} 구매 -${Math.round(cost).toLocaleString()} cr`, { company, pos: st.pos });
        if (seller) this.ev('money', `${st.name} 거래소: ${co.name}이(가) ${RES_NAME[l.item]} ${n} 구매 +${Math.round(net).toLocaleString()} cr`, { company: l.seller, pos: st.pos });
        return null;
      }
      case 'buildShip': {
        if (growthOn(this.st)) return this.buildHull(co, cmd, G);
        const st = S(cmd.station); const h = HULLS[cmd.classId]; const cls = SHIP_CLASSES[cmd.classId];
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        if (!h || !cls) return '건조할 수 없는 함급';
        if (h.tech && !co.tech?.includes(h.tech)) return `설계 연구 필요: ${techName(h.tech)}`;
        if (!yardSlots(st).some(y => y.size >= h.yard)) return `${YARD_NAME[h.yard]} 이상 조선소가 필요합니다`;
        const lo = getLoadout(cmd.classId, cmd.loadoutId);
        const fit = (cmd.fit ?? []).filter(k => EQUIPMENT[k]?.kind === 'module' && !EQUIPMENT[k].growth);
        if (fitUnits(fit) > h.slots) return `피팅 슬롯 초과 (${fitUnits(fit)}/${h.slots})`;
        if ((st.builds ?? []).length >= 20) return '건조 대기열은 20척까지';
        if (co.credits < h.credits) return `자금 부족 — ${Math.ceil(h.credits - co.credits).toLocaleString()} cr 더 필요`;
        const g = cmd.group ? G(cmd.group) : null;
        co.credits -= h.credits;
        st.seq = (st.seq ?? 0) + 1;
        const nb: import('./types').ShipBuild = { id: `b${st.seq}`, classId: cmd.classId, loadoutId: lo.id, fit, group: g?.id, left: h.time, total: h.time, started: false, paid: h.credits };
        syncShipContent(this.st, nb);
        (st.builds ??= []).push(nb);
        stepBuilds(st, co, 0, this.st);
        this.ev('info', `${st.name}: ${hullName(cmd.classId)} 건조 등록 (${lo.name})`, { company, pos: st.pos, tag: 'build_plan' });
        return null;
      }
      case 'buildOp': {
        const st = S(cmd.station);
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        const q = st.builds ?? []; const b = q.find(x => x.id === cmd.build);
        if (!b) return '건조 항목 없음';
        const i = q.indexOf(b);
        switch (cmd.op) {
          case 'pause': b.paused = true; break;
          case 'resume': b.paused = false; break;
          case 'cancel': {
            // before the keel is laid nothing is spent but credits; after, parts are already in the hull
            const back = Math.round(b.paid * (b.started ? Math.max(0, b.left / b.total) : 1));
            co.credits += back; q.splice(i, 1);
            this.ev('info', `${st.name}: ${hullName(b.classId)} 건조 취소 — 환불 ${back.toLocaleString()} cr${b.started ? ' · 투입된 부품은 회수 불가' : ''}`, { company, pos: st.pos });
            break;
          }
          case 'up': case 'down': case 'top': {
            const j = cmd.op === 'top' ? 0 : cmd.op === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= q.length || j === i) return null;
            q.splice(i, 1); q.splice(j, 0, b);
          }
        }
        stepBuilds(st, co, 0, this.st);
        return null;
      }
      case 'research': {
        const st = S(cmd.station);
        if (!st) return '정거장 없음';
        const src = cmd.source ?? 'lab';
        if (TECHS[cmd.tech]?.growth && !growthOn(this.st)) return '알 수 없는 연구';
        const err = canQueue(co, st, cmd.tech, src);
        if (err) return err;
        if ((co.research ?? []).length >= 30) return '연구 대기열은 30개까지';
        const cr = projectCredits(cmd.tech, src), time = projectTime(cmd.tech, src);
        co.credits -= cr;
        co.rseq = (co.rseq ?? 0) + 1;
        emit(this.st, { kind: 'research', reason: 'queue', amount: 1, company, station: st.id, item: cmd.tech, ref: `r${co.rseq}` });
        (co.research ??= []).push({ id: `r${co.rseq}`, tech: cmd.tech, station: st.id, left: time, total: time, started: false, paid: cr, source: src });
        stepResearch(this.st, co, 0);
        this.ev('info', `${st.name}: ${src === 'copy' ? '설계도 복제' : src === 'salvage' ? '노획품 분석' : '연구'} 등록 — ${techName(cmd.tech)}`, { company, pos: st.pos, tag: 'research_plan' });
        return null;
      }
      case 'researchOp': {
        const q = co.research ?? []; const r = q.find(x => x.id === cmd.project);
        if (!r) return '연구 항목 없음';
        const i = q.indexOf(r);
        switch (cmd.op) {
          case 'pause': r.paused = true; break;
          case 'resume': r.paused = false; break;
          case 'cancel': {
            // materials are spent when the project starts; credits come back for the unfinished part
            const back = Math.round((r.paid ?? 0) * (r.started ? Math.max(0, r.left / r.total) : 1));
            emit(this.st, { kind: 'research', reason: 'cancel', amount: 1, company, item: r.tech, ref: r.id, station: r.station });
            co.credits += back; q.splice(i, 1);
            this.ev('info', `연구 취소: ${techName(r.tech)} — 환불 ${back.toLocaleString()} cr${r.started ? ' · 소모된 재료는 회수 불가' : ''}`, { company });
            break;
          }
          case 'up': case 'down': case 'top': {
            const j = cmd.op === 'top' ? 0 : cmd.op === 'up' ? i - 1 : i + 1;
            if (j < 0 || j >= q.length || j === i) return null;
            q.splice(i, 1); q.splice(j, 0, r);
          }
        }
        stepResearch(this.st, co, 0);
        return null;
      }
      case 'learnBlueprint': {
        const st = S(cmd.station);
        if (!st) return '정거장 없음';
        const err = learnBlueprint(co, st, cmd.tech);
        if (err) return err;
        emit(this.st, { kind: 'research', reason: 'blueprint', amount: 1, company, station: st.id, item: cmd.tech });
        this.ev('milestone', `설계도 습득: ${techName(cmd.tech)} — ${techUnlocks(cmd.tech, growthOn(this.st))}`, { company, pos: st.pos });
        return null;
      }
      case 'fitShip': {
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company || s.task.k !== 'docked') return '정박 중인 자사 함선만 장비를 바꿀 수 있습니다';
        if (s.fitting) {
          // V2: modules go into bays (typed bays first), weapons stay
          const mods = (Array.isArray(cmd.fit) ? cmd.fit : []).filter(k => EQUIPMENT[k]?.kind === 'module').slice(0, 16);
          const pl = placeModules(s.variant!, mods);
          if (pl.unplaced.length) return `내부 베이 부족 — ${pl.unplaced.map(k => EQUIPMENT[k].name).join(', ')} 장착 불가`;
          return this.applyFitting(company, s, s.variant!, { hp: { ...s.fitting.hp }, bay: pl.bay }, { what: '모듈 변경' });
        }
        const st = S(s.task.station);
        const ownFit = st.owner === company && (this.hasModule(st, 'fitting') || yardSlots(st).length > 0);
        if (!ownFit && !(st.public && st.services.refit)) return '피팅 시설이 없는 정거장';
        if (ownFit && !stationSupportOnline(st)) return '전력 부족 — 발전시설을 증설한 뒤 피팅하세요';
        const fit = cmd.fit.filter(k => EQUIPMENT[k]?.kind === 'module' && (growthOn(this.st) || !EQUIPMENT[k].growth));
        const slots = HULLS[s.classId]?.slots ?? 1;
        if (fitUnits(fit) > slots) return `피팅 슬롯 초과 (${fitUnits(fit)}/${slots})`;
        // the difference moves between the ship and this station's storage, all or nothing
        const cur: Record<string, number> = {}, nxt: Record<string, number> = {};
        for (const k of s.fit ?? []) cur[k] = (cur[k] ?? 0) + 1;
        for (const k of fit) nxt[k] = (nxt[k] ?? 0) + 1;
        const store = this.storage(st, company);
        for (const [k, n] of Object.entries(nxt)) if (n > (cur[k] ?? 0) && qty(store, k) < n - (cur[k] ?? 0)) return `${RES_NAME[k]} 부족 (보관함에 ${Math.floor(qty(store, k))})`;
        const fee = ownFit ? 0 : 400 + Object.keys(nxt).length * 300;
        if (co.credits < fee) return '자금 부족';
        const extra = Object.values(cur).reduce((a, b) => a + b, 0) - Object.values(nxt).reduce((a, b) => a + b, 0);
        if (growthOn(this.st) && extra > 0 && this.overCap(st, company, extra)) return '창고 용량 부족 — 해제할 장비를 보관할 공간을 확보하세요';
        co.credits -= fee;
        for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt)])) addc(store, k, (cur[k] ?? 0) - (nxt[k] ?? 0));
        s.fit = fit;
        this.ev('money', `${s.name} 장비 변경: ${fit.map(k => EQUIPMENT[k].name).join(', ') || '없음'}${fee ? ` -${fee.toLocaleString()} cr` : ''}`, { company, pos: st.pos });
        return null;
      }
      case 'fit': {
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company) return '자사 함선이 아님';
        if (!s.fitting) return '이 함선은 아직 피팅 V2가 적용되지 않았습니다';
        const obj = (x: unknown) => typeof x === 'object' && x !== null && !Array.isArray(x);
        if (!obj(cmd.hp) || !obj(cmd.bay)) return '잘못된 피팅 데이터';
        const variant = typeof cmd.variant === 'string' ? cmd.variant : s.variant!;
        const preset = typeof cmd.preset === 'string' && (Object.hasOwn(CONTENT.presets, cmd.preset) || co.fitPresets?.some(x => x.id === cmd.preset)) ? cmd.preset : undefined;
        if (!growthOn(this.st)) { const gx = [...Object.values(cmd.hp), ...Object.values(cmd.bay)].find(k => EQUIPMENT[k as string]?.growth); if (gx) return `${EQUIPMENT[gx as string].name}: 이 월드에서는 아직 사용할 수 없는 장비`; }
        return this.applyFitting(company, s, variant, normFitting(cmd), { buy: !!cmd.buy, preset, what: '피팅 변경' });
      }
      case 'savePreset': {
        const v = typeof cmd.variant === 'string' && Object.hasOwn(CONTENT.variants, cmd.variant) ? CONTENT.variants[cmd.variant] : undefined; if (!v) return '알 수 없는 선체 변형';
        const nf = normFitting(cmd);
        const rep = checkFitting(cmd.variant, nf); if (rep.errors.length) return `저장 불가 — ${rep.errors[0]}`;
        const list = (co.fitPresets ??= []);
        const name = String(cmd.name ?? '').trim().slice(0, 24) || '내 피팅';
        const same = list.find(x => x.name === name && x.hull === v.hull);
        if (!same && list.length >= 20) return '피팅 프리셋은 20개까지 저장할 수 있습니다';
        const p = { id: same?.id ?? this.id('fp'), name, hull: v.hull, variant: cmd.variant, hp: nf.hp, bay: nf.bay };
        if (same) Object.assign(same, p); else list.push(p);
        this.ev('info', `피팅 프리셋 저장: ${name}`, { company });
        return null;
      }
      case 'delPreset': {
        const list = co.fitPresets ?? []; const i = list.findIndex(x => x.id === cmd.id);
        if (i < 0) return '프리셋 없음';
        list.splice(i, 1);
        return null;
      }
      case 'renameCompany': co.name = cmd.name.slice(0, 20) || co.name; return null;
      // ── growth P4/P6
      case 'lease': {
        const st = S(cmd.station); if (!st || !growthOn(this.st)) return '임대할 수 없는 정거장';
        const before = this.st.companies[company].leases?.[st.id] ?? 0;
        const e = setLease(this.st, co, st, cmd.blocks); if (e) return e;
        const now = co.leases?.[st.id] ?? 0;
        this.ev('money', `${st.name} 창고 임대 ${before} → ${now}구획 (용량 ${publicCap(co, st).toLocaleString()})${now > before ? ` · 첫 1시간 ${(now - before) * serviceOf(st).lease} cr 선납` : ' · 선납 환불 없음, 발생한 미정산 요금 유지'}`, { company, pos: st.pos });
        return null;
      }
      case 'buyBlueprint': case 'assembleBlueprint': {
        if (!growthOn(this.st)) return '설계도 시스템이 아직 적용되지 않은 월드';
        const st = S(cmd.station); if (!st) return '정거장 없음';
        const bp = String(cmd.blueprint);
        const err = cmd.c === 'buyBlueprint' ? buyBlueprint(this.st, co, st, bp) : assembleBlueprint(this.st, co, st, bp);
        if (err) return err;
        this.ev('milestone', `설계도 확보: ${bpName(bp)}${cmd.c === 'assembleBlueprint' ? ' (잔해 조각 복원)' : ''}`, { company, pos: st.pos, tag: 'blueprint' });
        return null;
      }
      case 'listShip': {
        if (!growthOn(this.st)) return '함선 거래는 아직 열리지 않았습니다';
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company) return '자사 함선이 아님';
        if (s.state !== 'docked' || s.task.k !== 'docked') return '정박 중인 함선만 매물로 내놓을 수 있습니다';
        const st = S(s.task.station);
        if (!this.hasExchange(st)) return '이 정거장에는 거래소가 없습니다';
        if (s.listed) return '이미 매물로 등록됨';
        if (s.reserve) return '예비역 함선은 먼저 재취역해야 합니다';
        if (cargoKeys(s.cargo).length) return '화물을 먼저 하역하세요';
        if (Object.values(this.st.ships).filter(x => x.owner === company && x.classId !== 'platform').length <= 1) return '마지막 함선은 팔 수 없습니다';
        const price = Math.round(cmd.price);
        if (!(price >= 100 && price < 1e9)) return '가격 오류 (100 cr 이상)';
        if ((st.shipListings ?? []).filter(l => l.seller === company).length >= 5) return '정거장당 함선 매물은 5척까지';
        st.seq = (st.seq ?? 0) + 1;
        const l = { id: `sl${st.seq}`, seller: company, ship: s.id, price, t: this.time };
        (st.shipListings ??= []).push(l);
        s.listed = l.id;
        // the ship leaves its working group: it waits at the exchange in a holding group
        const hold = this.newGroup(company, `매물: ${s.name}`, null, { k: 'dock', station: st.id });
        this.moveShipTo(s, hold);
        this.ev('world', `${co.name}이(가) ${st.name} 거래소에 ${hullLabel(s)} "${s.name}"을(를) ${price.toLocaleString()} cr에 내놓았다.`, { pos: st.pos, ref: st.id });
        return null;
      }
      case 'delistShip': {
        const st = S(cmd.station); const l = st?.shipListings?.find(x => x.id === cmd.listing);
        if (!st || !l || l.seller !== company) return '매물 없음';
        st.shipListings!.splice(st.shipListings!.indexOf(l), 1);
        const s = this.st.ships[l.ship]; if (s) delete s.listed;
        return null;
      }
      case 'buyShipListing': {
        let receipt: Company['lastTrade'];
        if (growthOn(this.st) && cmd.request !== undefined) {
          const checked = tradeRequest(co.lastTrade, cmd.request, JSON.stringify(['buyShipListing', cmd.station, cmd.listing, cmd.group ?? null]));
          if (checked.error) return checked.error;
          if (checked.duplicate) return null;
          receipt = checked.receipt;
        }
        const st = S(cmd.station); const l = st?.shipListings?.find(x => x.id === cmd.listing);
        if (!st || !l) return '매물이 이미 팔렸거나 내려갔습니다';
        if (!Number.isFinite(l.price) || l.price <= 0) return '유효하지 않은 매물입니다';
        if (stationSize(st) && !stationSupportOnline(st)) return '전력 부족 — 거래소 복구 대기';
        if (l.seller === company) return '자기 매물';
        const s = this.st.ships[l.ship];
        if (!s || s.owner !== l.seller || s.listed !== l.id || s.task.k !== 'docked' || s.task.station !== st.id) { st.shipListings!.splice(st.shipListings!.indexOf(l), 1); if (s?.listed === l.id) delete s.listed; return '매물이 더 이상 유효하지 않습니다'; }
        if (cargoKeys(s.cargo).length) return '매물 함선에 화물이 남아 있습니다 — 판매자가 매물을 회수하고 하역해야 합니다';
        if (co.credits < l.price) return `자금 부족 — ${Math.ceil(l.price - co.credits).toLocaleString()} cr 더 필요`;
        const seller = this.st.companies[l.seller];
        if (!seller) return '판매 회사를 찾을 수 없어 거래할 수 없습니다';
        co.credits -= l.price;
        const net = l.price * (1 - (st.tax ?? 0.02));
        if (seller) { seller.credits += net; seller.stats.earned += net; payFromSale(this.st, seller, net); }
        st.shipListings!.splice(st.shipListings!.indexOf(l), 1);
        // the ship changes hands with its fitted equipment; no blueprint or research is needed to own it
        const old = this.st.groups[s.groupId];
        delete s.listed; delete s.reserve;
        s.owner = company;
        let g = cmd.group ? G(cmd.group) : null;
        if (!g) g = this.newGroup(company, `인수 함선`, null, { k: 'idle' });
        this.moveShipTo(s, g);
        if (old && !old.shipIds.length && !old.childIds.length && old.name.startsWith('매물:')) { this.dropGroup(old); }
        if (receipt) co.lastTrade = receipt;
        this.ev('money', `${st.name} 거래소: ${hullLabel(s)} "${s.name}" 인수 -${l.price.toLocaleString()} cr`, { company, pos: st.pos });
        if (seller) this.ev('money', `${st.name} 거래소: "${s.name}" 매각 +${Math.round(net).toLocaleString()} cr (${co.name})`, { company: l.seller, pos: st.pos });
        return null;
      }
      case 'reserve': {
        if (!growthOn(this.st)) return '예비역 제도는 아직 적용되지 않은 월드';
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company) return '자사 함선이 아님';
        if (cmd.on) {
          if (s.state !== 'docked') return '정박 중인 함선만 예비역으로 돌릴 수 있습니다';
          if (s.reserve) return '이미 예비역';
          if (s.listed) return '매물 함선';
          s.reserve = { since: this.time };
          this.ev('info', `${s.name} 예비역 전환 — 운영비 85% 절감, 출항 불가 (재취역 ${REACTIVATE_S / 60}분)`, { company, tag: 'reserve' });
          return null;
        }
        if (!s.reserve) return '예비역이 아님';
        if (s.reserve.until) return '이미 재취역 중';
        const fee = Math.round(shipRate(this.st, { ...s, reserve: undefined }).credits * 2);
        if (co.credits < fee) return `재취역 비용 ${fee.toLocaleString()} cr 필요`;
        co.credits -= fee;
        s.reserve.until = this.time + REACTIVATE_S;
        this.ev('info', `${s.name} 재취역 시작 — ${REACTIVATE_S / 60}분 후 출항 가능 (-${fee.toLocaleString()} cr)`, { company, tag: 'reserve' });
        return null;
      }
      case 'unloadCargo': {
        if (!growthOn(this.st)) return '이 월드에서는 수동 화물 하역을 사용할 수 없습니다';
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company) return '자사 함선이 아닙니다';
        if (s.state !== 'docked' || s.task.k !== 'docked') return '정박한 함선만 창고로 하역할 수 있습니다';
        const st = this.st.stations[s.task.station]; if (!st || !this.canDock(st, company)) return '이용 가능한 정거장이 아닙니다';
        if (stationCargoRate(st) !== undefined) {
          if (!cargoSum(s.cargo)) return '하역할 화물이 없습니다';
          if (!cargoKeys(s.cargo).some(item => this.intakeRoom(st, company, item) > 1e-9)) return '창고에 빈 공간이 없습니다 — 재고 이동 후 다시 하역하세요';
          const permit = this.cargoPermit(s, st, 'manual-unload', cargoSum(s.cargo));
          if (permit !== null) { this.unloadStored(s, st, permit); return null; }
          const g = this.st.groups[s.groupId]; if (g) g.status = `${st.name}: 화물 하역 중`;
          return null;
        }
        const moved = this.unloadStored(s, st);
        if (!moved) return cargoSum(s.cargo) > 0 ? '창고에 빈 공간이 없습니다 — 임대·재고 이동 후 다시 하역하세요' : '하역할 화물이 없습니다';
        return null;
      }
      case 'putRoute': return putRoute(this, company, cmd.group, cmd.config, cmd.route);
      case 'routeControl': return controlRoutes(this, company, cmd.routes, cmd.action);
      case 'poolShips': return setPoolShips(this, company, cmd.ships, cmd.on);
      case 'poolCreate': return createPoolJob(this, company, cmd.request);
      case 'poolControl': return controlPoolJob(this, company, cmd.job, cmd.action);
      case 'procPolicy': return setProcurementPolicy(this, company, cmd.settings);
      case 'procSource': return setProcurementSource(this, company, cmd.station, cmd.kind, cmd.source, cmd.enabled, cmd.priority);
      case 'workOp': return growthOn(this.st) ? workOp(this, company, cmd.work, cmd.op, cmd.value, cmd.price) : '이 세계에서는 회사 업무를 사용할 수 없습니다';
      case 'workCreate': return createGoal(this, company, cmd.goal, { title: typeof cmd.title === 'string' ? cmd.title.slice(0, 60) : undefined, priority: cmd.priority, budget: cmd.budget, maxPrice: cmd.maxPrice });
      case 'approvalDecide': return growthOn(this.st) ? decideApproval(this, company, cmd.approval, cmd.option, cmd.scope ?? 'once', cmd.value) : '결재 없음';
      case 'opsPolicy': return setOpsPolicy(this, company, cmd.policy);
      case 'payArrears': {
        if (!growthOn(this.st)) return '이 월드에는 운영비 미납금이 없습니다';
        const paid = payDebt(this.st, co, 'manual');
        if (!paid) return co.upkeep?.debt ? '납부할 크레딧이 없습니다' : '미납금이 없습니다';
        this.ev('money', `미납금 ${paid.toLocaleString(undefined, { maximumFractionDigits: 9 })} cr 납부`, { company });
        return null;
      }
      case 'autoReserve': upkeepOf(co).autoReserve = !!cmd.on; return null;
    }
    return '알 수 없는 명령';
  }

  // ------------------------------------------------------------------ growth: hulls, stock, builds (P3/P6)

  private moveShipTo(s: WShip, g: WGroup) {
    const old = this.st.groups[s.groupId];
    if (old) old.shipIds = old.shipIds.filter(x => x !== s.id);
    s.groupId = g.id; g.shipIds.push(s.id);
  }
  private dropGroup(g: WGroup) {
    if (g.parentId) { const p = this.st.groups[g.parentId]; if (p) p.childIds = p.childIds.filter(x => x !== g.id); }
    delete this.st.groups[g.id];
  }

  /** a ship of a specific content hull with a preset's weapons. mk1 hulls take the legacy path (same
   *  ship as before); growth hulls get their fitting directly (they have no legacy loadout). */
  spawnHull(owner: string, hullId: string, variantId: string, presetId: string | undefined, groupId: string, pos: V, name?: string): WShip {
    const h = CONTENT.hulls[hullId];
    const leg = Object.values(CONTENT.legacy).find(l => l.hull === hullId && l.variant === variantId && (!presetId || l.preset === presetId));
    if (leg) return this.spawnShip(owner, leg.classId, leg.loadoutId, groupId, pos, name);
    const s = this.spawnShip(owner, h.classId, getLoadout(h.classId, '').id, groupId, pos, name);
    const p = (presetId && CONTENT.presets[presetId]?.variant === variantId ? CONTENT.presets[presetId] : undefined) ?? Object.values(CONTENT.presets).find(x => x.variant === variantId);
    s.hull = hullId; s.variant = variantId;
    if (this.fitsV2(s)) {
      s.fitting = { hp: { ...(p?.weapons ?? {}) }, bay: {}, ...(p ? { preset: p.id } : {}) };
      s.fit = [];
      s.loadoutId = loadoutLabel(h.classId, variantId, s.fitting);
      s.fitting.sig = legacySig(s.loadoutId, s.fit);
    }
    return s;
  }

  /** the content (hull, variant, preset) a buy/build command asks for */
  private hullChoice(cmd: { classId: string; loadoutId: string; hull?: string; variant?: string; preset?: string }): { hull: string; variant: string; preset?: string } | string {
    if (cmd.hull !== undefined && (typeof cmd.hull !== 'string' || !Object.hasOwn(CONTENT.hulls, cmd.hull))) return '알 수 없는 선체';
    if (cmd.hull && CONTENT.hulls[cmd.hull].dev) return '개발용 선체 — 구매·건조할 수 없음';
    if (cmd.classId === BBEX_CLASS || (cmd.hull && CONTENT.hulls[cmd.hull].exclusive)) return 'BB-EX는 건조하거나 구매할 수 없습니다 (세계 유일 · 설계도 없음)';
    if (cmd.preset !== undefined && (typeof cmd.preset !== 'string' || !Object.hasOwn(CONTENT.presets, cmd.preset))) return '알 수 없는 무장 프리셋';
    if (cmd.variant !== undefined && (typeof cmd.variant !== 'string' || !Object.hasOwn(CONTENT.variants, cmd.variant))) return '알 수 없는 선체 변형';
    if (!cmd.hull) {
      const m = legacyOf(cmd.classId, getLoadout(cmd.classId, cmd.loadoutId)?.id ?? '');
      if (!m) return '알 수 없는 함급';
      return { hull: m.hull, variant: cmd.variant ?? m.variant, preset: cmd.preset ?? (cmd.variant && cmd.variant !== m.variant ? undefined : m.preset) };
    }
    const p = cmd.preset ? CONTENT.presets[cmd.preset] : undefined;
    const variant = cmd.variant ?? p?.variant ?? `${cmd.hull}_std`;
    if (CONTENT.variants[variant]?.hull !== cmd.hull) return '이 선체의 변형이 아님';
    if (!contentAvail(variant, this.st.contentV)) return '이 월드에서는 아직 사용할 수 없는 구조';
    if (p && (p.hull !== cmd.hull || p.variant !== variant)) return '이 선체 변형의 프리셋이 아님';
    return { hull: cmd.hull, variant, preset: p?.id ?? Object.values(CONTENT.presets).find(x => x.variant === variant)?.id };
  }

  /** public-yard price: rises as the yard's stock runs down */
  shipPrice(st: Station, hullId: string): number {
    const sale = hullSale(hullId); if (!sale) return 0;
    const n = st.shipStock?.[hullId]?.n ?? 0;
    return Math.round(sale.price * (1.25 - 0.25 * Math.min(1, n / Math.max(1, sale.stock))) / 10) * 10;
  }

  private buyHull(co: Company, cmd: Extract<Cmd, { c: 'buyShip' }>, G: (id: string) => WGroup | null): string | null {
    const st = this.st.stations[cmd.station];
    if (!st) return '정거장 없음';
    if (st.owner === co.id) return '자사 조선소는 부품으로 직접 건조합니다 — 조선소 탭의 건조 대기열을 쓰세요';
    if (!st.public) return '공영 조선소가 아님';
    const ch = this.hullChoice(cmd); if (typeof ch === 'string') return ch;
    const h = CONTENT.hulls[ch.hull];
    if (!yardHulls(st).includes(ch.hull)) return '이 조선소에서 판매하지 않는 선체';
    // NPC yards sell standard builds: common variants only (special structures are built from blueprints)
    if (CONTENT.variants[ch.variant]?.blueprint !== 'common') return '공영 조선소는 표준 구조만 판매합니다 — 특수 변형은 설계도로 건조';
    const preset = ch.preset ? CONTENT.presets[ch.preset] : Object.values(CONTENT.presets).find(p => p.variant === ch.variant);
    if (preset && Object.values(preset.weapons).some(id => regionalMarketRequired(this.st, id))) return '지역 희귀 소재가 필요한 장비 프리셋은 공영 조선소에서 판매하지 않습니다 — 일반 함선 구매 후 피팅하세요';
    const sale = hullSale(ch.hull)!;
    // a hull that joined the yard's list after the c3 seeding (content update) starts at its base stock
    const stock = (st.shipStock ??= {})[ch.hull] ??= { n: sale.stock, t: 0 };
    if (stock.n < 1) return `재고 없음 — 이 조선소가 다음 ${h.name}을(를) 건조 중 (${Math.round(100 * stock.t / sale.restock)}%${stock.why ? `, ${stock.why}` : ''})`;
    if (co.rep < (sale.rep ?? 0)) return `연합 평판 ${sale.rep} 필요`;
    const price = this.shipPrice(st, ch.hull);
    if (co.credits < price) return `자금 부족 — ${price.toLocaleString()} cr 필요`;
    co.credits -= price;
    stock.n--;
    fundsIn(st, price * 0.3);
    let g = cmd.group ? G(cmd.group) : null;
    const cls = SHIP_CLASSES[h.classId];
    if (!g) g = this.newGroup(co.id, econOf({ classId: h.classId, hull: h.id }).military ? '신규 편대' : `${cls.type}반`);
    const s = this.spawnHull(co.id, ch.hull, ch.variant, ch.preset, g.id, st.pos);
    this.dockShip(s, st);
    this.ev('money', `${h.name} ${cls.type} "${s.name}" 인수 (-${price.toLocaleString()} cr · ${st.name} 재고 ${stock.n})`, { company: co.id, pos: st.pos });
    return null;
  }

  private buildHull(co: Company, cmd: Extract<Cmd, { c: 'buildShip' }>, G: (id: string) => WGroup | null): string | null {
    const st = this.st.stations[cmd.station];
    if (!st || st.owner !== co.id) return '자사 정거장이 아님';
    const ch = this.hullChoice(cmd); if (typeof ch === 'string') return ch;
    const h = CONTENT.hulls[ch.hull];
    if (h.classId === 'platform') return '건조할 수 없는 선체';
    const err = rightsProblem(co, ch.hull, ch.variant); if (err) return err;
    const b = hullBuild(ch.hull, ch.variant);
    if (!yardSlots(st).some(y => y.size >= b.yard)) return `${YARD_NAME[b.yard]} 이상 조선소가 필요합니다`;
    const missingFac = (b.facilities ?? []).filter(f => !this.hasModule(st, f));
    if (missingFac.length) return `필요 시설: ${missingFac.map(f => MODULES[f]?.name ?? f).join(', ')}`;
    const berth = hullEcon(ch.hull).berth;
    if (!berthFits(st, berth)) return `${berth}급 선체를 수용할 정박 시설이 없습니다 (하역시설 증설 필요, 현재 ${berthOf(st)})`;
    const p = ch.preset ? CONTENT.presets[ch.preset] : undefined;
    const fit = (Array.isArray(cmd.fit) ? cmd.fit : []).filter(k => EQUIPMENT[k]?.kind === 'module').slice(0, 16);
    const pl = placeModules(ch.variant, fit);
    if (pl.unplaced.length) return `내부 베이 부족 — ${pl.unplaced.map(k => EQUIPMENT[k].name).join(', ')} 장착 불가`;
    const rep = checkFitting(ch.variant, { hp: { ...(p?.weapons ?? {}) }, bay: pl.bay });
    if (rep.errors.length) return rep.errors[0];
    if ((st.builds ?? []).length >= 20) return '건조 대기열은 20척까지';
    // own yards pay their own dock time (econConfig YARD_FEE): the real cost of a large hull
    const pay = b.credits + yardFee(b);
    if (co.credits < pay) return `자금 부족 — ${Math.ceil(pay - co.credits).toLocaleString()} cr 더 필요 (인건비 ${b.credits.toLocaleString()} + 조선소 운영비 ${yardFee(b).toLocaleString()})`;
    const g = cmd.group ? G(cmd.group) : null;
    co.credits -= pay;
    useRun(co, hullBlueprint(ch.hull));
    st.seq = (st.seq ?? 0) + 1;
    const label = p ? loadoutLabel(h.classId, ch.variant, { hp: p.weapons, bay: {} }) : getLoadout(h.classId, '').id;
    const regionalMaterials = regionalHullMaterials(this.st, ch.hull);
    const nb: import('./types').ShipBuild = { id: `b${st.seq}`, classId: h.classId, loadoutId: label, hull: ch.hull, variant: ch.variant, preset: p?.id, fit, group: g?.id, left: b.time, total: b.time, started: false, paid: pay, requiredYard: b.yard, ...(regionalMaterials ? { regionalMaterials } : {}) };
    (st.builds ??= []).push(nb);
    stepBuilds(st, co, 0, this.st);
    this.ev('info', `${st.name}: ${h.name} 건조 등록 (${CONTENT.variants[ch.variant]?.name ?? ''}${p ? ` · ${p.name}` : ''})`, { company: co.id, pos: st.pos, tag: 'build_plan' });
    return null;
  }

  /** public yards rebuild their ship stock from regional materials (no material, no new ship) */
  private restockYards(st: Station, dt: number) {
    const hulls = yardHulls(st);
    if (!hulls.length) return;
    const sys = this.sysOf(st.pos);
    const supply = Math.max(0.2, 1 - (sys?.heat ?? 0) / 120) * supplyMul(sys, this.time);
    for (const id of hulls) {
      const sale = hullStock(id); if (!sale) continue;
      const k = (st.shipStock ??= {})[id] ??= { n: sale.stock, t: 0 };
      if (k.n >= sale.stock) { k.t = 0; delete k.why; continue; }
      k.t += dt * supply;
      if (k.t < sale.restock) continue;
      // one ship's worth of hull material comes out of the station's market
      const need = yardRestockNeed(id, st);
      const m = st.market;
      const short = Object.entries(need).filter(([r, n]) => m?.[r] && m[r].stock < n);
      if (short.length) { k.t = sale.restock; k.why = `자재 부족 (${short.map(([r]) => RES_NAME[r]).join(', ')})`; continue; }
      for (const [r, n] of Object.entries(need)) if (m?.[r]) { m[r].stock -= n; emit(this.st, { kind: 'consume', reason: 'npc_ship_construction', amount: n, station: st.id, item: r }); }
      k.n++; k.t = 0; delete k.why;
    }
  }

  /** construction at an owned station: free storage → waiting plans, then the hub's own crew works */
  private stationWorks(st: Station, dt: number) {
    if (!st.modules.some(m => !m.built)) return;
    const store = this.storage(st, st.owner);
    for (const m of allocate(st, store)) {
      const act = activePlan(st) === m;
      this.ev('info', `${st.name}: ${MODULES[m.kind].name} 자재 확보 완료${act ? ' — 건설 시작' : ' — 건설 순서 대기'}`, { company: st.owner, pos: st.pos, tag: 'build_secured' });
    }
    const m = activePlan(st);
    if (m && m.kind !== 'core' && this.hasModule(st, 'core')) this.workOn(st, m, dt / MODULES[m.kind].work * STATION_CREW_RATE * techFx(this.st.companies[st.owner]?.tech).constructMul, null);
  }

  /** progress a secured plan; announces start and completion */
  private workOn(st: Station, m: import('./types').Module, rate: number, g: WGroup | null) {
    const md = MODULES[m.kind];
    if (m.progress <= 0 && rate > 0) this.ev('info', `${st.name}: ${md.name} 건설 시작`, { company: st.owner, pos: st.pos, tag: 'build_start' });
    const progress = m.progress;
    const finished = advance(m, rate);
    if (m.progress > progress) for (const [item, n] of Object.entries(moduleMaterials(m))) emit(this.st, { kind: 'consume', reason: 'facility_construction', amount: n * (m.progress - progress), company: st.owner, station: st.id, item });
    if (finished) {
      // rounding crumbs go back; completed modules carry no plan bookkeeping
      const store = this.storage(st, st.owner);
      for (const [r, n] of Object.entries(m.reserved ?? {})) if (n > 0) addc(store, r, n);
      delete m.reserved; delete m.used; delete m.paused; delete m.secured;
      this.ev('world', `${this.st.companies[st.owner]?.name ?? ''}: ${st.name}에 ${md.name} 완공!`, { pos: st.pos, ref: st.id });
      this.ev('info', `${st.name}: ${md.name} 완공 — ${moduleUnlocks(st, m.kind)}`, { company: st.owner, pos: st.pos, tag: 'build_done' });
      if (g) this.say(g, `${md.name} 완공했습니다.`, 'radio', 0);
    }
  }

  /** a finished hull leaves the yard: docked at the station, in its assigned group */
  private launchBuild(st: Station, b: import('./types').ShipBuild) {
    const company = st.owner;
    const cls = SHIP_CLASSES[b.classId];
    let g = b.group ? this.st.groups[b.group] : undefined;
    if (!g || g.owner !== company) g = this.newGroup(company, ECON[b.classId]?.military ? '신조함 편대' : `${cls.type}반`);
    const s = b.preset && b.hull && b.variant ? this.spawnHull(company, b.hull, b.variant, b.preset, g.id, st.pos) : this.spawnShip(company, b.classId, b.loadoutId, g.id, st.pos);
    s.fit = [...b.fit];
    const legacyHull = !s.hull || Object.values(CONTENT.legacy).some(l => l.hull === s.hull);
    if (this.fitsV2(s) && legacyHull) for (const m of this.legacyFitting(s)) addc(this.storage(st, company), m, 1);
    else if (this.fitsV2(s) && s.fitting && s.variant) {
      // growth hull: the modules go into its bays; anything without a bay goes to storage (nothing is lost)
      const pl = placeModules(s.variant, b.fit);
      s.fitting.bay = pl.bay; s.fit = bayModules(s.variant, s.fitting); s.fitting.sig = legacySig(s.loadoutId, s.fit);
      for (const m of pl.unplaced) addc(this.storage(st, company), m, 1);
    }
    this.dockShip(s, st);
    this.ev('world', `${this.st.companies[company]?.name}: ${st.name} 조선소에서 ${cls.name} ${cls.type} "${s.name}" 진수!`, { pos: st.pos, ref: st.id });
    this.ev('info', `${st.name}: ${hullName(b.classId)} "${s.name}" 진수 — ${g.name}에 배속`, { company, pos: st.pos, tag: 'ship_done' });
  }

  private freeSlot(st: Station) { const used = new Set(st.modules.map(m => m.slot)); for (let i = 1; i < MAX_MODULES; i++) if (!used.has(i)) return i; return 0; }

  validateOp(company: string, g: WGroup, op: Op): string | null {
    const ships = this.shipsOf(g);
    const sub = this.subtreeShips(g);
    switch (op.k) {
      case 'mine': {
        const f = this.st.fields[op.field]; const st = this.st.stations[op.deliver];
        if (!f || (this.st.fog && !knowsField(this.st, company, f))) return '소행성 지대 없음';
        if (!st) return op.auto ? '하역 가능한 정거장이 없음' : '하역 정거장 없음';
        if (!sub.some(s => econOf(s).mine > 0)) return '채굴선이 없음';
        return this.deliverProblem(st, company, op.sell, this.berthOfGroup(g));
      }
      case 'haul': {
        if (op.route) return '관리형 운송 노선은 물류 관리 화면에서 설정하거나 재개하세요';
        const a = this.st.stations[op.from], b = this.st.stations[op.to];
        if (!a || !b || a === b || !this.canDock(a, company) || !this.canDock(b, company)) return '운송 경로 오류';
        if (!sub.some(s => econOf(s).cargo > 0)) return '화물 적재 함선이 없음';
        if (growthOn(this.st)) { const need = this.berthOfGroup(g); if (!berthFits(a, need) || !berthFits(b, need)) return `정박 시설 규모 부족 — ${need}급 선체가 이용할 수 없는 정거장 (${a.name} ${berthOf(a)} · ${b.name} ${berthOf(b)})`; }
        if (op.res === '*auto' && ![a, b].some(x => x.owner === company && x.modules.some(m => m.kind === 'logistics' && m.built))) return '자동 보급에는 물류센터가 필요 (출발지나 목적지)';
        if (op.res !== '*auto' && op.res !== '*all' && !ITEMS[op.res] && !EQUIPMENT[op.res] && !op.res.startsWith('bp:')) return '알 수 없는 품목';
        return null;
      }
      case 'dock': { const st = this.st.stations[op.station]; return st && this.canDock(st, company) ? null : '정박 불가'; }
      case 'escort': {
        const t = this.st.groups[op.group];
        if (op.focus !== undefined && !['auto', 'work', 'cargo', 'all'].includes(op.focus)) return '호위 보호 대상 오류';
        // an escort cannot protect itself, its own subgroups (they move with it) or a group it commands
        for (let x: WGroup | undefined = t, i = 0; x && i < 12; x = x.parentId ? this.st.groups[x.parentId] : undefined, i++) if (x.id === g.id) return '호위 대상 오류 — 자기 편대나 하위 편대는 호위할 수 없습니다';
        return t && t.owner === company && t.id !== g.id ? null : '호위 대상 오류';
      }
      case 'attack': {
        if (op.lair) return this.st.lairs[op.lair]?.alive ? null : '대상 없음';
        const t = op.group ? this.st.groups[op.group] : null;
        if (!t || this.st.companies[t.owner]?.kind !== 'pirate') return '공격할 수 없는 대상 (현재는 해적만 공격 가능)';
        return null;
      }
      case 'build': {
        const st = this.st.stations[op.station]; if (!st || st.owner !== company) return '자사 정거장이 아님';
        // An overridden child does not execute this order, even if it owns the only cargo ship.
        const working = growthOn(this.st) ? this.subtreeShipsInOp(g, true) : sub;
        return working.some(s => s.classId === 'constructor' || growthOn(this.st) && econOf(s).cargo > 0 && cargoSum(s.cargo) > 0) ? null : growthOn(this.st) ? '명령을 수행할 공작선 또는 자재를 실은 화물선이 필요' : '공작선이 필요';
      }
      case 'found': {
        if (growthOn(this.st) && (typeof op.name !== 'string' || !op.at || !Number.isFinite(op.at.x) || !Number.isFinite(op.at.y) || !Number.isFinite(op.at.z))) return '정거장 이름과 부지 좌표를 확인하세요';
        if (op.size !== undefined && (!growthOn(this.st) || !validStationSize(op.size))) return '정거장 규모를 확인하세요';
        if (!ships.some(s => s.classId === 'constructor')) return '공작선이 이 부대에 직접 있어야 함';
        for (const s of Object.values(this.st.stations)) if (dist2(s.pos, op.at) < 2600) return '다른 정거장과 너무 가깝다 (2,600 이상)';
        for (const l of Object.values(this.st.lairs)) if (dist2(l.pos, op.at) < 3000) return '해적 은신처와 너무 가깝다';
        const sys = this.sysOf(op.at);
        if (!sys || Math.hypot(op.at.x - sys.origin.x, op.at.z - sys.origin.z) > sys.radius * 0.95) return '성계 관제 범위를 벗어남';
        if (sys.security >= 90) return `${sys.name}은(는) 연합 핵심 성계 — 민간 정거장 건설 허가가 나지 않는다`;
        const rule = foundingRule(this.st, sys, company);
        if (!rule.ok) return rule.why;
        if (Math.hypot(op.at.x - sys.origin.x, op.at.z - sys.origin.z) < sys.star.size * 2.5) return '항성에 너무 가깝다';
        for (const pl of sys.planets) if (dist2(pl.pos, op.at) < pl.size * 1.8) return `${pl.name}에 너무 가깝다`;
        return null;
      }
      case 'survey': {
        const sys = this.st.systems[op.system];
        if (!this.st.sites) return '이 세계에는 탐사 지점이 없습니다 (성장 콘텐츠 v4 이후)';
        if (!sys) return '성계 없음';
        if (sys.kind === 'core' || sys.security >= 90) return `${sys.name}은(는) 연합이 정리한 핵심 성계 — 숨은 잔해가 없다`;
        if (!sub.some(s => econOf(s).cruise > 0)) return '기동 가능한 함선이 없음';
        return null;
      }
      case 'salvage': {
        const site = this.st.sites?.[op.site];
        if (!site || !siteActive(site, this.st.time)) return '인양 지점이 없거나 이미 인양됨';
        if (!knows(site, company)) return '아직 발견하지 못한 지점 — 먼저 그 성계를 탐사하세요';
        if (!sub.some(s => econOf(s).cargo > 0)) return '인양물을 실을 화물칸이 있는 함선이 필요 (채굴선·수송선·공작선)';
        return null;
      }
      default: return null;
    }
  }

  private prepareFound(company: string, g: WGroup): string | null {
    const co = this.st.companies[company];
    const con = this.shipsOf(g).find(s => s.classId === 'constructor')!;
    if (con.cargo.alloy >= FOUND_COST.alloy) return co.credits >= FOUND_COST.credits ? (co.credits -= FOUND_COST.credits, null) : `${FOUND_COST.credits} cr 필요`;
    const need = FOUND_COST.alloy - con.cargo.alloy;
    // use stored alloy at the docked station, otherwise buy at the nearest public market
    const at = con.task.k === 'docked' ? this.st.stations[con.task.station] : null;
    let cost = FOUND_COST.credits;
    let fromStore = 0;
    if (at) fromStore = Math.min(need, Math.floor(qty(this.storage(at, company), 'alloy')));
    const market = Object.values(this.st.stations).filter(s => s.market?.alloy).sort((a, b) => this.routeDistance(a.pos, con.pos) - this.routeDistance(b.pos, con.pos))[0];
    const buy = need - fromStore;
    if (buy > 0) { if (!market || market.market!.alloy.stock < buy) return '합금 재고 부족'; cost += buy * this.price(market, 'alloy', 'buy'); }
    if (co.credits < cost) return `자금 부족 (설립비+합금 ${Math.round(cost).toLocaleString()} cr)`;
    co.credits -= cost;
    if (at) addc(this.storage(at, company), 'alloy', -fromStore);
    if (buy > 0) market.market!.alloy.stock -= buy;
    con.cargo.alloy += need;
    this.ev('money', `정거장 설립 자금 및 합금 확보 -${Math.round(cost).toLocaleString()} cr`, { company });
    return null;
  }

  /** Refund once when an order is replaced, delegated, disbanded or loses its constructors. */
  private reconcileFoundEscrows(company?: string) {
    const companies = company ? [this.st.companies[company]].filter(Boolean) : Object.values(this.st.companies);
    for (const co of companies) for (const [id, amount] of Object.entries(co.foundingEscrow ?? {})) {
      const g = this.st.groups[id];
      const valid = g?.owner === co.id && g.override && g.op.k === 'found' && g.op.escrowed && this.shipsOf(g).some(s => s.owner === co.id && s.classId === 'constructor');
      if (valid) continue;
      watchMoney(this.st, 'foundation_refund', { company: co.id, group: id }, () => {
        delete co.foundingEscrow![id]; if (!Object.keys(co.foundingEscrow!).length) delete co.foundingEscrow;
        co.credits += amount;
        if (g?.owner === co.id && g.op.k === 'found' && g.op.escrowed) { g.op = { k: 'idle' }; g.status = '정거장 설립 중단 — 선납금 환급'; }
        this.ev('money', `정거장 설립 중단 — 선납 ${Math.round(amount).toLocaleString()} cr 환급`, { company: co.id, ref: id });
      });
    }
  }

  private ackOp(g: WGroup, op: Op) {
    const name = (id?: string) => (id && (this.st.stations[id]?.name ?? this.st.fields[id]?.name ?? this.st.groups[id]?.name ?? this.st.lairs[id]?.name)) || '';
    const t: Record<string, string> = {
      idle: '현 위치에서 대기합니다.', move: '지정 좌표로 이동합니다.',
      dock: `${name((op as any).station)}에 입항합니다.`,
      mine: `${name((op as any).field)}에서 채굴 작전을 시작합니다. 하역지는 ${name((op as any).deliver)}.`,
      haul: `${name((op as any).from)} → ${name((op as any).to)} 운송 개시.`,
      patrol: '순찰 구역으로 향합니다. 해적이 보이면 요격합니다.',
      escort: `${name((op as any).group)} 호위에 들어갑니다.`,
      attack: `${name((op as any).group ?? (op as any).lair)} 공격 개시!`,
      build: `${name((op as any).station)} 건설 작업에 착수합니다.`,
      found: `신규 정거장 "${(op as any).name}" 부지로 향합니다.`,
      survey: `${this.st.systems[(op as any).system]?.name ?? ''} 성계 탐사를 시작합니다. 숨은 잔해·유적을 찾습니다.`,
      salvage: `${this.st.sites?.[(op as any).site]?.name ?? ''} 인양 작업을 시작합니다.`,
    };
    this.say(g, t[op.k] ?? '명령 수신.', 'radio', 0);
  }

  subtreeShips(g: WGroup): WShip[] {
    const out = this.shipsOf(g);
    for (const c of g.childIds) { const cg = this.st.groups[c]; if (cg) out.push(...this.subtreeShips(cg)); }
    return out;
  }

  // ===================================================================== update

  /** advance world time; dt in seconds (scaled by game speed in single player) */
  update(dt: number) {
    // tactical battles step at 30 Hz with the deterministic engine — the same one every spectator
    // re-runs locally, so what anyone watches is exactly what the server decides. Battles with
    // players come first; NPC-only fights share a wall-time budget (if it runs out they simply fall
    // a little behind real time; the outcome does not depend on timing).
    const t0 = clockMs(), observerStart = observationCostMs();
    const ids = [...this.battles.keys()];
    const npcIds = ids.filter(id => !this.st.engagements[id]?.live);
    const rot = npcIds.length ? this.npcRot++ % npcIds.length : 0;
    const order = [...ids.filter(id => this.st.engagements[id]?.live), ...npcIds.slice(rot), ...npcIds.slice(0, rot)];
    let npcSpent = 0;
    for (const id of order) {
      const w = this.battles.get(id)!, e = this.st.engagements[id];
      if (!e) { this.battles.delete(id); continue; }
      const npc = !e.live;
      let acc = (this.battleAcc.get(id) ?? 0) + dt;
      if (npc) acc = Math.min(acc, Math.max(1.5, dt * 2));
      const s0 = clockMs();
      while (acc >= w.dt && !w.outcome) {
        if (npc && clockMs() - t0 - (observationCostMs() - observerStart) > NPC_BATTLE_BUDGET_MS) break;
        w.step(); acc -= w.dt;
        if (observing(this.st)) observedWork(() => { for (const hit of w.events) if (hit.t === 'hit') {
          const attacker = w.shipById.get(hit.attacker), ship = attacker?.ref ? this.st.ships[attacker.ref] : undefined;
          if (ship) emit(this.st, { kind: 'combat.weapon', amount: hit.dmg, value: 1, company: ship.owner, group: ship.groupId, ship: ship.id, system: e.sys, item: hit.weapon, reason: hit.result });
        } });
      }
      if (npc) npcSpent += clockMs() - s0;
      this.battleAcc.set(id, acc);
      e.tick = w.tick;
      this.mirrorBattle(e, w);
      if (w.outcome) { this.finishEngagement(e, this.resultFromWorld(w), true); this.battles.delete(id); this.battleAcc.delete(id); }
    }
    this.npcBattleMs = this.npcBattleMs * 0.9 + npcSpent * 0.1;
    this.acc += dt;
    while (this.acc >= STRAT_DT) { this.acc -= STRAT_DT; this.tick(STRAT_DT); }
  }

  /** strategic ships follow their tactical counterparts, so the map shows the fight as it happens */
  private mirrorBattle(e: Engagement, w: World) {
    const st = this.st;
    const alive: [number, number] = [0, 0], total: [number, number] = [0, 0];
    for (const ts of w.ships) {
      total[ts.team]++;
      if (ts.state === 'alive') alive[ts.team]++;
      if (!ts.ref || ts.ref.includes(':')) continue;
      const s = st.ships[ts.ref];
      if (!s || s.engagement !== e.id) continue;
      s.pos = { x: e.pos.x + ts.pos.x, y: e.pos.y + ts.pos.y, z: e.pos.z + ts.pos.z };
      s.vel = { x: ts.vel.x, y: ts.vel.y, z: ts.vel.z };
      s.heading = Math.atan2(ts.fwd.x, ts.fwd.z);
      s.hp = ts.state === 'dead' || ts.state === 'dying' ? 0 : ts.hp / ts.maxHp;
    }
    e.prog = { alive, total, value: [Math.round(w.teamValueFrac(0) * 100) / 100, Math.round(w.teamValueFrac(1) * 100) / 100] };
  }

  tick(dt: number) {
    const st = this.st;
    st.time += dt;
    this.slow += dt;
    this.economy(dt);
    this.npcs(dt);
    if (this.slow >= 1 && growthOn(st)) { this.reconcileFoundEscrows(); if (st.logistics) maintainRoutes(this); if (st.logisticsJobs) maintainPool(this); if (st.logisticsJobs && this.time >= this.poolDispatchAt) { dispatchPool(this); this.poolDispatchAt = this.time + 5; } if (this.time >= this.procurementAt) { planProcurement(this); this.procurementAt = this.time + 10; } stepOperations(this); }
    this.speedCap.clear(); this.escortPlans.clear(); this.escortIdx = null;
    for (const g of Object.values(st.groups)) {
      if (g.cooldown > 0) g.cooldown -= dt;
      this.runGroup(g, dt);
    }
    if (this.slow >= 1) {
      this.slow = 0;
      if (growthOn(st)) for (const co of Object.values(st.companies)) if (co.pendingLoot) this.recoverLoot(co);
      this.npcSlow();
      this.detectEngagements();
      this.resolveAuto();
      this.contracts();
      this.milestones();
      this.cleanup();
    }
  }

  /** survey: sweep the system in wide circles; every ship in it adds scan time (sensor research ×1.5) */
  private behaveSurvey(s: WShip, g: WGroup, op: Extract<Op, { k: 'survey' }>, dt: number, speed: number) {
    const sys = this.st.systems[op.system];
    if (!sys) { g.status = '성계 소실'; return; }
    const a = this.time * 0.012 + hashId(g.id) + g.shipIds.indexOf(s.id) * 0.9;
    const r = sys.radius * (0.45 + 0.25 * Math.sin(this.time * 0.003 + hashId(s.id)));
    this.moveTo(s, { x: sys.origin.x + Math.cos(a) * r, y: 0, z: sys.origin.z + Math.sin(a) * r }, speed * 0.8, dt, 80);
    if (this.sysOf(s.pos) !== sys) { g.status = `${sys.name}로 이동 (탐사)`; return; }
    const co = this.st.companies[g.owner];
    const power = dt * (co.tech?.includes('long_sensors') ? 1.5 : 1);
    if (this.st.fog && g.shipIds[0] === s.id) {
      const r = surveyIntel(this.st, g.owner, sys.id, power * g.shipIds.length);
      for (const f of r.fields) this.ev('info', `${sys.name}: 미확인 광구 "${f.name}" 발견 — 시험 채굴로 성분을 확인해야 합니다`, { company: g.owner, pos: f.pos, ref: f.id });
      if (r.done) this.ev('info', `${sys.name} 정밀 탐사 완료`, { company: g.owner, ref: sys.id });
    }
    for (const site of surveyStep(this.st, g.owner, sys.id, power)) {
      this.say(g, `탐사 성과: ${site.name} 발견 (${['', '얕은', '깊은', '심층'][site.tier]} 유적). 인양 작전을 지시할 수 있습니다.`, 'info', 0);
      this.ev('info', `${sys.name}: ${site.name} 발견 — 등급 ${site.tier} 인양 지점`, { company: g.owner, pos: site.pos, ref: site.id });
    }
    const left = surveyLeft(this.st, g.owner, sys.id);
    if (!left && g.shipIds[0] === s.id) {
      g.status = '탐사 완료';
      if (g.override) { g.op = { k: 'idle' }; this.say(g, `${sys.name} 탐사 완료 — 더 숨은 지점이 없습니다. 대기합니다.`, 'radio', 0); }
    } else g.status = `${sys.name} 탐사 중 (다음 발견까지 약 ${Math.ceil(left / Math.max(1, g.shipIds.length) / 60)}분)`;
  }

  /** P10 fog: every player ship marks the system it is in as visited (1 Hz). */
  private exploreStep() {
    const seen = new Set<string>();
    for (const s of Object.values(this.st.ships)) {
      const co = this.st.companies[s.owner]; if (co?.kind !== 'player' || s.state === 'battle') continue;
      const sys = this.sysOf(s.pos); if (!sys) continue;
      const key = s.owner + '\u0000' + sys.id; if (seen.has(key)) continue; seen.add(key);
      if (this.st.intel?.[s.owner]?.sys[sys.id]) continue;
      const r = visit(this.st, s.owner, sys.id);
      if (r.first && sys.charted === false) this.ev('info', `미개척 성계 ${sys.name}에 처음 도달했습니다 — 회사 전용 성도에 기록`, { company: s.owner, ref: sys.id });
      for (const f of r.fields) this.ev('info', `${sys.name}: 미확인 광구 "${f.name}" 발견 — 시험 채굴로 성분을 확인해야 합니다`, { company: s.owner, pos: f.pos, ref: f.id });
    }
  }

  /** P10: record a company's own mined units from an unidentified deposit; report first sightings */
  private sampled(owner: string, f: Field, units: Cargo) {
    const before = this.st.intel?.[owner]?.fields[f.id]?.first ?? {};
    const fresh = Object.keys(units).filter(k => before[k] === undefined);
    recordSample(this.st, owner, f, units);
    if (fresh.length && (this.st.intel?.[owner]?.fields[f.id]?.n ?? 0) > fresh.length)
      this.ev('info', `${f.name}: 새 성분 ${fresh.map(k => ITEMS[k]?.name ?? k).join(', ')} 첫 채굴 (누적 표본 ${this.st.intel![owner].fields[f.id].n})`, { company: owner, pos: f.pos, ref: f.id });
  }

  /** salvage: work a found site; cutters and holds count double. Loot goes into the group's holds. */
  private behaveSalvage(s: WShip, g: WGroup, op: Extract<Op, { k: 'salvage' }>, dt: number, speed: number) {
    const site = this.st.sites?.[op.site];
    if (!site || !siteActive(site, this.st.time)) { g.status = '인양 지점 소실'; if (g.override) g.op = { k: 'idle' }; return; }
    const spot = this.formationSlot(s, g, site.pos, 90);
    if (!this.moveTo(s, spot, speed, dt, 40) && dist(s.pos, site.pos) > 320) { g.status = `${site.name}로 이동 (${Math.round(dist(s.pos, site.pos))}m)`; return; }
    const w = s.classId === 'miner' || s.classId === 'constructor' ? 2 : 1;
    site.work += dt * w * (s.hp > 0.5 ? 1 : 0.5);
    g.status = `${site.name} 인양 ${Math.min(99, Math.floor(site.work / site.need * 100))}%`;
    if (site.work < site.need) return;
    const co = this.st.companies[g.owner];
    const haul = salvageLoot(this.st, co, site, () => this.rng.next());
    const holds = this.shipsOf(g).filter(x => econOf(x).cargo > 0);
    let lost = 0;
    for (const [k, n0] of Object.entries(haul.cargo)) {
      let n = n0;
      if (k.startsWith('bpf:')) { addc((holds[0] ?? s).cargo, k, n); continue; }   // archive records weigh nothing
      for (const h of holds) { const room = econOf(h).cargo - cargoSum(h.cargo); const put = Math.min(n, Math.max(0, Math.floor(room))); if (put > 0) { addc(h.cargo, k, put); n -= put; } if (n <= 0) break; }
      lost += n;
    }
    const sys = this.st.systems[site.system];
    if (sys) sys.heat = Math.min(100, sys.heat + 4 * site.tier);       // word gets around: pirates come looking
    retireSite(this.st, site);
    const got = Object.entries(haul.cargo).map(([k, n]) => `${RES_NAME[k] ?? k} ${n}`).join(', ');
    this.ev('money', `${site.name} 인양 완료: ${got}${lost ? ` (화물칸 부족으로 ${lost}단위 포기)` : ''}`, { company: g.owner, pos: site.pos, tag: 'salvage' });
    for (const b of haul.blueprints) this.ev('world', `${co.name}이(가) ${site.name}의 기록고에서 ${bpName(b)}을(를) 복원했다.`, { company: g.owner, pos: site.pos });
    this.say(g, `인양 완료. 화물을 정거장에 하역하세요.${haul.blueprints.length ? ` 설계도 확보: ${haul.blueprints.map(bpName).join(', ')}` : ''}`, 'info', 0);
    g.op = { k: 'idle' };
  }

  /** salvage_ops: recovered parts and captured equipment go to the nearest station the company can store at */
  private salvageWrecks(co: Company, wrecks: Record<string, number>[], share: number, pos: V, classes: string[] = []) {
    const loot: Record<string, number> = {};
    const rng = () => this.rng.next();
    for (const w of wrecks) { if (rng() > share) continue; for (const [k, n] of Object.entries(wreckLoot(rng, w))) loot[k] = (loot[k] ?? 0) + n; }
    // growth P6: blueprint fragments from the wrecks of the classes they describe
    if (growthOn(this.st) && classes.length) for (const f of wreckFragments(rng, classes.filter(() => rng() < share))) loot[f] = (loot[f] ?? 0) + 1;
    if (!Object.keys(loot).length) return;
    for (const [item, amount] of Object.entries(loot)) emit(this.st, { kind: 'produce', reason: 'battle_recovery', amount, company: co.id, system: this.sysOf(pos)?.id, item });
    const sys = sysAt(this.st.systems, pos);
    let best: Station | null = null, bd = Infinity;
    for (const x of Object.values(this.st.stations)) {
      if (!(x.public || x.owner === co.id)) continue;
      const d = dist(x.pos, pos) + (sysAt(this.st.systems, x.pos) === sys ? 0 : 1e7) - (x.owner === co.id ? 5000 : 0);
      if (d < bd) { bd = d; best = x; }
    }
    if (!growthOn(this.st)) {
      if (!best) return;
      for (const [k, n] of Object.entries(loot)) addc(this.storage(best, co.id), k, n);
      this.ev('money', `전장 회수: ${Object.entries(loot).map(([k, n]) => `${RES_NAME[k]} ${n}`).join(', ')} → ${best.name} 창고`, { company: co.id, pos: best.pos, tag: 'salvage' });
      return;
    }
    const destination = best?.id ?? '';
    const pending = ((co.pendingLoot ??= {})[destination] ??= {});
    for (const [k, n] of Object.entries(loot)) addc(pending, k, n);
    this.recoverLoot(co);
    if (cargoKeys(pending).length) this.ev('warn', `전장 회수품 ${Math.ceil(cargoSum(pending))}단위 안전 보관 중 — ${best?.name ?? '정거장'} 창고에 공간이 생기면 자동 입고됩니다. 임대·재고 이동으로 공간을 확보하세요.`, { company: co.id, tag: 'storage_full' });
  }

  private recoverLoot(co: Company) {
    for (const [id, pending] of Object.entries(co.pendingLoot ?? {})) {
      const st = this.st.stations[id];
      if (!st || !(st.public || st.owner === co.id)) continue;
      let moved = 0;
      for (const k of cargoKeys(pending)) {
        const n = takec(pending, k, this.intakeRoom(st, co.id, k));
        if (n > 0) { addc(this.storage(st, co.id), k, n); moved += n; }
      }
      if (moved) this.ev('info', `${st.name}: 보존 중인 전장 회수품 ${Math.ceil(moved)}단위 입고`, { company: co.id, tag: 'salvage' });
      if (!cargoKeys(pending).length) delete co.pendingLoot![id];
    }
  }

  // ===================================================================== economy

  private marketObservations = new WeakMap<Station, { before: Record<string, number>; identities: Record<string, [import('./observe').Observation, import('./observe').Observation]>; budget: [import('./observe').Observation, import('./observe').Observation] }>();
  private economy(dt: number) {
    const st = this.st;
    for (const s of Object.values(st.stations)) {
      if (s.market) {
        // stations consume/produce so prices recover over time
        const m = s.market;
        const collect = observing(st);
        let observed = collect ? this.marketObservations.get(s) : undefined;
        if (collect && !observed) { observed = { before: {}, identities: {}, budget: [{ kind: 'currency.create', reason: 'regional_budget', amount: 0, to: `st:${s.id}`, station: s.id }, { kind: 'currency.destroy', reason: 'regional_budget', amount: 0, from: `st:${s.id}`, station: s.id }] }; this.marketObservations.set(s, observed); }
        if (observed) for (const item in m) observed.before[item] = m[item].stock;
        this.npcMarket(s, m, dt);
        if (observed) metricBatch(st, () => { for (const item in m) { const delta = m[item].stock - (observed!.before[item] ?? 0); if (!delta) continue; const identities = observed!.identities[item] ??= [{ kind: 'market.net_supply', reason: 'npc_economy', amount: 0, item, station: s.id }, { kind: 'market.net_consumption', reason: 'npc_economy', amount: 0, item, station: s.id }]; emitMetric(st, identities[delta > 0 ? 0 : 1], Math.abs(delta)); } });
        if (growthOn(st) && s.public) { const before = s.funds ?? 0; fundsStep(s, dt); const delta = (s.funds ?? 0) - before; if (delta && observed) metricBatch(st, () => emitMetric(st, observed!.budget[delta > 0 ? 0 : 1], Math.abs(delta))); this.restockYards(s, dt); }
      }
      if (!s.public) {
        if (this.hasModule(s, 'defense') && stationSupportOnline(s) && s.defenseHp < 1) s.defenseHp = Math.min(1, s.defenseHp + dt * 0.004);
        this.stationWorks(s, dt);
        for (const b of stepBuilds(s, st.companies[s.owner], dt, st)) this.launchBuild(s, b);
        for (const e of stepProduction(s, st.companies[s.owner], dt, st)) {
          if (e.kind === 'finished') this.ev('info', `${s.name}: 생산 주문 완료 — ${RECIPES[e.recipe].name}`, { company: s.owner, pos: s.pos, tag: 'prod_done' });
        }
      }
    }
    if (growthOn(st)) for (const co of Object.values(st.companies)) {
      if (co.kind !== 'player') continue;
      const before = co.credits;
      for (const e of stepUpkeep(st, co, dt)) this.ev(e.kind, e.text, { company: co.id, tag: e.tag });
      if (co.credits !== before) book(this, co.id, 'upkeep', co.credits - before);
    }
    for (const co of Object.values(st.companies)) {
      if (co.kind !== 'player' || !co.research?.length) continue;
      for (const p of stepResearch(st, co, dt)) {
        const t = TECHS[p.tech];
        if (p.source === 'copy') this.ev('info', `설계도 복제 완료: ${t.name} — ${st.stations[p.station]?.name ?? ''} 창고`, { company: co.id, tag: 'research_done' });
        else this.ev('milestone', `연구 완료: ${t.name} — ${techUnlocks(p.tech, growthOn(this.st))}${growthOn(this.st) ? unlockSummary(p.tech) : ''}`, { company: co.id, tag: 'research_done' });
      }
    }
    for (const f of Object.values(st.fields)) {
      f.amount = Math.min(f.max, f.amount + f.regen * dt);
    }
  }

  // ===================================================================== NPC factions

  private npcs(dt: number) {
    // fast part: lair repair; everything else runs once per second in npcSlow()
    for (const l of Object.values(this.st.lairs)) if (l.alive && l.hp < 1) l.hp = Math.min(1, l.hp + dt * 0.002);
  }

  /** once per second: security drift, Union force upkeep, pirate activity, trade */
  private npcSlow() {
    const st = this.st;
    for (const sys of Object.values(st.systems)) {
      // government response pushes pirate activity back down; strong in the core, weak on the rim
      sys.heat = Math.max(0, Math.min(100, sys.heat - (0.002 + sys.security / 100 * 0.012)));
    }
    factionStep(st, 1);
    if (st.fog) this.exploreStep();
    if (st.factions && st.time - (st.factionClock ?? 0) >= 60) { st.factionClock = st.time; factionEconStep(this, st, 60); }
    this.unionForces();
    this.pirateForces();
    const traders = Object.values(st.groups).filter(g => g.owner === 'guild' && g.shipIds.length);
    if (traders.length < 5 && (st.time < 3 || this.rng.chance(0.02))) this.spawnTrader();
  }

  // ------------------------------------------------------------------ Union

  private unionPlan(): { slot: string; role: 'garrison' | 'patrol' | 'qrf'; sys: StarSystem; home: Station; template: [string, string][] }[] {
    const out: ReturnType<WorldSim['unionPlan']> = [];
    const T = {
      g3: [['cruiser', 'multi'], ['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'gun'], ['corvette', 'torp']],
      g2: [['cruiser', 'multi'], ['destroyer', 'aa'], ['corvette', 'gun'], ['corvette', 'gun']],
      g1: [['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'gun']],
      g1weak: [['destroyer', 'strike'], ['corvette', 'gun'], ['corvette', 'gun']],
      pCore: [['cruiser', 'multi'], ['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'gun'], ['corvette', 'torp']],
      pSettled: [['cruiser', 'multi'], ['destroyer', 'aa'], ['corvette', 'gun'], ['corvette', 'torp']],
      pFrontier: [['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'gun']],
      qCore: [['battleship', 'std'], ['cruiser', 'gun'], ['cruiser', 'missile'], ['destroyer', 'aa']],
      qSettled: [['cruiser', 'gun'], ['cruiser', 'multi'], ['destroyer', 'aa'], ['destroyer', 'strike'], ['corvette', 'torp']],
      qFrontier: [['cruiser', 'multi'], ['destroyer', 'aa'], ['destroyer', 'strike']],
    } as Record<string, [string, string][]>;
    for (const sys of Object.values(this.st.systems)) {
      if (sys.security < 15) continue;
      const stations = Object.values(this.st.stations).filter(x => x.public && (x.garrison ?? 0) > 0 && this.sysOf(x.pos)?.id === sys.id);
      for (const x of stations) {
        const t = x.garrison! >= 3 ? T.g3 : x.garrison === 2 ? T.g2 : sys.security < 40 ? T.g1weak : T.g1;
        out.push({ slot: `garrison:${x.id}`, role: 'garrison', sys, home: x, template: t });
      }
      const main = stations.filter(x => x.owner === 'union').sort((a, b) => (b.garrison ?? 0) - (a.garrison ?? 0))[0] ?? stations[0];
      if (!main) continue;
      const patrols = sys.security >= 70 ? 2 : sys.security >= 40 ? 1 : 0;
      for (let i = 0; i < patrols; i++) out.push({ slot: `patrol:${sys.id}:${i}`, role: 'patrol', sys, home: main, template: sys.security >= 90 ? T.pCore : sys.security >= 70 ? T.pSettled : T.pFrontier });
      if (sys.security >= 40) out.push({ slot: `qrf:${sys.id}`, role: 'qrf', sys, home: main, template: sys.security >= 90 ? T.qCore : sys.security >= 70 ? T.qSettled : T.qFrontier });
    }
    return out;
  }

  /** seconds to replace one lost warship / to rebuild a destroyed force, by system security */
  private refitTime(sys: StarSystem) { return sys.security >= 90 ? 45 : sys.security >= 70 ? 90 : sys.security >= 40 ? 200 : 420; }
  private respawnTime(sys: StarSystem) { return sys.security >= 90 ? 120 : sys.security >= 70 ? 240 : sys.security >= 40 ? 600 : 1200; }

  private patrolRoute(sys: StarSystem, i: number): V[] {
    const pts: V[] = [];
    const node = (id: string) => this.st.stations[id]?.pos ?? sys.gates.find(g => g.id === id)?.pos;
    for (const [a, b] of sys.lanes) { const pa = node(a), pb = node(b); if (pa && !pts.some(p => dist2(p, pa) < 500)) pts.push(pa); if (pb && !pts.some(p => dist2(p, pb) < 500)) pts.push(pb); }
    const fields = Object.values(this.st.fields).filter(f => !f.salvage && this.sysOf(f.pos)?.id === sys.id);
    for (const f of fields) pts.push({ x: f.pos.x + f.radius + 300, y: f.pos.y, z: f.pos.z });
    // two patrols walk the circuit in opposite directions, offset by half
    const r = pts.slice(); if (i % 2) r.reverse();
    const k = Math.floor(r.length / 2) * (i % 2);
    return [...r.slice(k), ...r.slice(0, k)];
  }

  private unionForces() {
    const st = this.st;
    const plan = this.unionPlan();
    const bySlot = new Map<string, WGroup>();
    for (const g of Object.values(st.groups)) if (g.owner === 'union' && g.npc?.slot) bySlot.set(g.npc.slot, g);
    for (const p of plan) {
      let g = bySlot.get(p.slot);
      const names = { garrison: `${p.home.name} 주둔함대`, patrol: `${p.sys.name} 순찰대 ${p.slot.endsWith('1') ? '2' : '1'}`, qrf: `${p.sys.name} 신속대응함대` };
      if (!g) {
        const op: Op = p.role === 'garrison' ? { k: 'garrison', station: p.home.id, radius: p.sys.security >= 90 ? 9000 : p.sys.security >= 70 ? 6500 : 4500 }
          : p.role === 'patrol' ? { k: 'guard', route: this.patrolRoute(p.sys, Number(p.slot.split(':')[2] ?? 0)), leg: 0 }
          : { k: 'respond', home: p.home.id };
        g = this.newGroup('union', names[p.role], null, op);
        g.npc = { role: p.role, sys: p.sys.id, home: p.home.id, template: p.template, nextRefit: 0, born: this.time, slot: p.slot };
        const c = this.newCommander('union', p.sys.security >= 90 ? 2.5 : p.sys.security >= 70 ? 2 : 1.2);
        c.rank = p.role === 'qrf' ? '준장' : p.role === 'garrison' ? '중령' : '경감'; c.color = '#7fb0ff'; c.voice = 'formal';
        g.commanderId = c.id;
        for (const [cl, lo] of p.template) this.spawnUnion(g, cl, lo, p.home);
        continue;
      }
      const ships = this.shipsOf(g);
      const home = st.stations[g.npc!.home] ?? p.home;
      const c = this.groupCenter(g);
      const atHome = !c || dist(c, home.pos) < 3500;
      // field repairs at the home base
      if (c && atHome) for (const s of ships) if (s.state === 'space' && s.hp < 1) s.hp = Math.min(1, s.hp + 0.012);
      if (this.time < g.npc!.nextRefit || ships.some(s => s.state === 'battle')) continue;
      if (!ships.length) {
        for (const [cl, lo] of p.template) this.spawnUnion(g, cl, lo, home);
        g.npc!.nextRefit = this.time + this.refitTime(p.sys);
        if (p.sys.security >= 40) this.ev('world', `${home.name}: ${g.name} 재편성 완료, 작전 재개.`, { pos: home.pos });
        continue;
      }
      if (!atHome || ships.length >= p.template.length) continue;
      // replace one missing hull from the template
      const have = ships.map(s => s.classId);
      const miss = p.template.find(([cl]) => { const i = have.indexOf(cl); if (i >= 0) { have.splice(i, 1); return false; } return true; });
      if (miss) { this.spawnUnion(g, miss[0], miss[1], home); g.npc!.nextRefit = this.time + this.refitTime(p.sys); }
    }
  }

  private spawnUnion(g: WGroup, cl: string, lo: string, home: Station) {
    const a = this.rng.range(0, Math.PI * 2);
    return this.spawnShip('union', cl, lo, g.id, { x: home.pos.x + Math.cos(a) * (home.radius + 500), y: home.pos.y + this.rng.range(-40, 40), z: home.pos.z + Math.sin(a) * (home.radius + 500) });
  }

  // ------------------------------------------------------------------ pirates

  private bandComp(tier: number): [string, string][] {
    const r = this.rng;
    const c: [string, string][] = [['corvette', 'gun'], ['corvette', 'torp']];
    if (tier >= 2) c.push(['corvette', 'torp'], ['destroyer', 'strike']);
    if (tier >= 3) { c.push(['corvette', 'gun'], ['destroyer', 'aa']); if (r.chance(0.6)) c.push(['cruiser', 'gun']); }
    if (tier >= 4) c.push(['corvette', 'gun'], ['destroyer', 'strike'], ['cruiser', r.chance(0.5) ? 'missile' : 'gun']);
    if (tier >= 5) c.push(['battleship', 'std'], ['destroyer', 'aa']);
    return c;
  }

  private spawnBand(name: string, comp: [string, string][], at: V, info: Omit<NonNullable<WGroup['npc']>, 'template' | 'nextRefit' | 'born'>, op: Op, tier: number): WGroup {
    const g = this.newGroup('pirates', name, null, op);
    g.npc = { ...info, template: comp, nextRefit: 0, born: this.time };
    const cm = this.newCommander('pirates', tier * 0.5);
    cm.voice = 'savage'; cm.aggression = Math.max(cm.aggression, 0.7); cm.color = '#ff7050';
    g.commanderId = cm.id;
    for (const [c, lo] of comp) this.spawnShip('pirates', c, lo, g.id, vadd(at, { x: this.rng.range(-150, 150), y: 0, z: this.rng.range(-150, 150) }));
    const sys = this.st.systems[info.sys]; if (sys) sys.stats.bands++;
    return g;
  }

  private pirateForces() {
    const st = this.st;
    const pirateShips = Object.values(st.ships).filter(s => s.owner === 'pirates').length;
    const bandName = () => `${this.rng.pick(['갈퀴', '송곳니', '독수리', '하이에나', '피의 달', '녹슨 칼', '자갈', '까마귀', '굶주린 늑대'])} 무리`;
    for (const l of Object.values(st.lairs)) {
      const sys = this.sysOf(l.pos); if (!sys) continue;
      if (!l.alive) {
        if (st.time >= l.respawnAt && ensureInfluence(st, sys, st.time).pirates < LAIR_FOOTHOLD) { l.respawnAt = st.time + 300; continue; }
        if (st.time >= l.respawnAt) {
          l.alive = true; l.hp = 1; l.nextBand = st.time + 240;
          this.ev('world', `${sys.name}: ${l.name}이(가) 재건되었다. 해적 활동이 다시 시작된다.`, { pos: l.pos });
        }
        continue;
      }
      if (st.time < l.nextBand) continue;
      l.nextBand = st.time + (l.kind === 'hideout' ? 380 : 280) + this.rng.range(0, 180);
      const bands = Object.values(st.groups).filter(g => g.owner === 'pirates' && g.npc?.home === l.id && g.shipIds.length);
      if (bands.length >= l.maxBands || pirateShips > 70) continue;
      // pirates grow bolder while the government is busy elsewhere
      const tier = Math.max(1, Math.min(5, (l.tier ?? 2) + (sys.heat > 60 || (sys.inf?.pirates ?? 0) > 70 ? 1 : 0)));
      const comp = this.bandComp(tier);
      const g = this.spawnBand(bandName(), comp, l.pos, { role: 'band', sys: sys.id, home: l.id }, { k: 'raid', home: l.id }, tier);
      sys.heat = Math.min(100, sys.heat + 1);
      this.ev('warn', `${sys.name}: ${l.name}에서 해적 무리가 출격했다 (${comp.length}척).`, { pos: l.pos, ref: g.id });
      this.postBounty(g, comp, sys);
    }
    // settled systems without a lair: occasional rogue bands drift in on the rim, then move on
    for (const sys of Object.values(st.systems)) {
      // Raising a frontier's security in a test or future control update does not turn an empty
      // system into a settled trade lane. P9 keeps rogue traffic in the authored settled regions.
      if (expandedLayout(st) && sys.kind !== 'settled') continue;
      if (sys.security >= 90 || sys.security < 70) continue;
      const rogues = Object.values(st.groups).filter(g => g.owner === 'pirates' && g.npc?.role === 'rogue' && g.npc.sys === sys.id);
      for (const g of rogues) {
        if (this.time - g.npc!.born > 900 && !this.shipsOf(g).some(s => s.state === 'battle')) {
          for (const s of this.shipsOf(g)) delete st.ships[s.id];
          g.shipIds = [];
          this.ev('world', `${sys.name}: 떠돌이 해적 ${g.name}이(가) 성계를 떠났다.`);
        }
      }
      if (rogues.some(g => g.shipIds.length) || !this.rng.chance(1 / 1100)) continue;
      // find a dark corner: low local security, far from stations
      let spot: V | null = null;
      for (let k = 0; k < 12 && !spot; k++) {
        const a = this.rng.range(0, Math.PI * 2), r = sys.radius * this.rng.range(0.7, 0.95);
        const p = { x: sys.origin.x + Math.cos(a) * r, y: 0, z: sys.origin.z + Math.sin(a) * r };
        if (this.secAt(p) < 68) spot = p;
      }
      if (!spot) continue;
      const comp: [string, string][] = [['corvette', 'gun'], ['corvette', 'torp']];
      if (this.rng.chance(0.5)) comp.push(['corvette', 'gun']);
      const g = this.spawnBand(`떠돌이 ${bandName()}`, comp, spot, { role: 'rogue', sys: sys.id, home: '', homePos: spot }, { k: 'raid', home: '' }, 1);
      sys.heat = Math.min(100, sys.heat + 2);
      this.ev('warn', `${sys.name} 외곽에 떠돌이 해적 ${comp.length}척이 출몰했다. 연합 순찰대가 대응 중.`, { pos: spot, ref: g.id });
      this.postBounty(g, comp, sys);
    }
  }

  private postBounty(g: WGroup, comp: [string, string][], sys: StarSystem) {
    const host = Object.values(this.st.stations).filter(x => x.public && x.services.contracts && this.sysOf(x.pos)?.id === sys.id)[0] ?? this.st.stations.astra;
    const risk = 1 + (100 - sys.security) / 120;
    this.offerContract({ stationId: host.id, kind: 'bounty', title: `현상금: ${g.name}`, desc: `${sys.name}에서 활동하는 해적 ${comp.length}척을 격멸하라.`, reward: Math.round((comp.reduce((a, [c]) => a + shipValue(c), 0) * 40 * risk + 2500) / 100) * 100, rep: 3, target: g.id });
  }

  private spawnTrader() {
    const ids = ['astra', 'nova', 'barcaco', 'exchange', 'helios', 'drakeout', 'cinderco', ...(expandedLayout(this.st) ? ['p9_lyra_port', 'p9_ceres_works', 'p9_forge_works', 'p9_anvil_port', 'p9_harbor_port', 'p9_junction_port'] : []), ...(this.st.worldLayout === 'p10' ? ['p10_crossroads_bazaar', 'p10_meridian_port', 'p10_kiln_works', 'p10_bulwark_yard', 'p10_arsenal_works'] : [])].filter(x => this.st.stations[x]);
    const start = this.rng.pick(ids);
    const route = [start];
    while (route.length < 4) { const n = this.rng.pick(ids); if (n !== route[route.length - 1]) route.push(n); }
    const g = this.newGroup('guild', `길드 상선단`, null, { k: 'trade', route, leg: 1 });
    g.npc = { role: 'trader', sys: this.sysOf(this.st.stations[start].pos)?.id ?? 'astra', home: start, template: [], nextRefit: 0, born: this.time };
    this.spawnShip('guild', 'hauler', 'std', g.id, vadd(this.st.stations[start].pos, { x: this.rng.range(-300, 300), y: 0, z: this.rng.range(-300, 300) }), `${this.rng.pick(['황금', '은빛', '푸른', '느린'])} ${this.rng.pick(['거북', '낙타', '고래', '돛'])}호`);
  }

  // ===================================================================== group behaviour

  private runGroup(g: WGroup, dt: number) {
    let ships = this.shipsOf(g).filter(s => s.state !== 'battle');
    if (!ships.length) return;
    for (const s of ships) if (s.cargoWork?.key === 'manual-unload') {
      const st = s.state === 'docked' && s.task.k === 'docked' ? this.st.stations[s.task.station] : undefined;
      if (!st || st.id !== s.cargoWork.station || !this.canDock(st, s.owner)) { delete s.cargoWork; continue; }
      const permit = this.cargoPermit(s, st, 'manual-unload', cargoSum(s.cargo));
      if (permit === null) { g.status = `${st.name}: 화물 하역 중`; ships = ships.filter(x => x !== s); }
      else if (!this.unloadStored(s, st, permit)) g.status = `${st.name}: 창고 공간 부족 — 화물 보존`;
    }
    if (!ships.length) return;
    // growth P4/P6: reserve, sale listings and stage-3 arrears keep docked ships where they are
    if (growthOn(this.st) && this.st.companies[g.owner]?.kind === 'player') {
      const held = ships.filter(s => s.state === 'docked' && departureHeld(this.st, s));
      if (held.length) { ships = ships.filter(s => !held.includes(s)); if (!ships.length) { g.status = departureHeld(this.st, held[0])!; return; } }
    }
    const op = this.opOf(g);
    const c = this.cmdr(g);
    // ---- commander threat assessment for civilian work
    if (this.st.companies[g.owner]?.kind === 'player' || g.owner === 'guild') this.threatCheck(g, ships, op, c);
    for (const s of ships) { s.fx = undefined; }
    if (g.fleeing) {
      for (const s of ships) {
        if (econOf(s).military && op.k !== 'mine' && op.k !== 'haul') { this.behave(s, g, op, dt, c); continue; }
        const st = this.nearestDock(s.pos, g.owner);
        if (st) this.goDock(s, st, dt, this.cruiseOf(s) * 1.1);
      }
      g.status = '해적 회피 — 대피 중';
      return;
    }
    const ward = this.st.companies[g.owner]?.kind === 'player' ? this.wardControl(g, ships, op) : null;
    if (ward?.hold.size) {
      for (const s of ward.hold) if (s.state === 'space') { s.vel.x *= 0.85; s.vel.z *= 0.85; s.pos = vadd(s.pos, s.vel, dt); }
      ships = ships.filter(s => !ward.hold.has(s));
    }
    if ((op.k === 'move' || op.k === 'attack') && this.st.companies[g.owner]?.kind === 'player') {
      const m = this.fleetMarch(g, op, dt);
      if (m) { for (const s of ships) this.marchShip(s, g, op, m, dt, c); if (ward?.note) g.status = ward.note; return; }
    }
    for (const s of ships) this.behave(s, g, op, dt, c);
    if (ward?.note) g.status = ward.note;
  }

  // -------------------------------------------------- escort missions (pure parts in escort.ts)

  /** escorting groups (the ones holding the escort order) by target group id, rebuilt once per tick */
  private escortsTargeting(id: string): WGroup[] {
    if (!this.escortIdx) {
      this.escortIdx = new Map();
      for (const e of Object.values(this.st.groups)) {
        if (e.op.k !== 'escort' || (e.parentId && !e.override)) continue;
        const list = this.escortIdx.get(e.op.group) ?? []; list.push(e); this.escortIdx.set(e.op.group, list);
      }
    }
    return this.escortIdx.get(id) ?? [];
  }
  /** the ships of a target group an escort protects */
  private wardsOf(t: WGroup, focus: Extract<Op, { k: 'escort' }>['focus']): WShip[] {
    return pickWards(this.opOf(t), focus ?? 'auto', this.subtreeShips(t).filter(s => econOf(s).cruise > 0), s => econOf(s).mine > 0, s => econOf(s).cargo > 0);
  }
  private centroidOf(ps: V[]): V | null {
    if (!ps.length) return null;
    const c = { x: 0, y: 0, z: 0 }; for (const p of ps) { c.x += p.x; c.y += p.y; c.z += p.z; }
    return { x: c.x / ps.length, y: c.y / ps.length, z: c.z / ps.length };
  }
  /** can ships in `from` reach `to` through open gates? */
  private reachable(from: V, to: V): boolean {
    const a = this.sysOf(from), b = this.sysOf(to);
    if (!a || !b || a.id === b.id) return true;
    return !!nextGate(this.st.systems, a.id, b.id, this.st.conflicts ? gate => gateOpen(this.st, gate) : undefined);
  }
  private escortEta(from: V, to: V, speed: number): number {
    const a = this.sysOf(from), b = this.sysOf(to);
    // long in-system legs use the warp drive (WARP_MIN); each jump is roughly one warp to the next gate
    const leg = (d: number) => d > WARP_MIN ? 8 + d / 4000 + WARP_EXIT / Math.max(1, speed) : d / Math.max(1, speed);
    if (!a || !b || a.id === b.id) return leg(dist(from, to));
    return jumps(this.st.systems, a.id, b.id) * 30 + 15;
  }
  private escortShips(e: WGroup): WShip[] { return this.subtreeShipsInOp(e, true).filter(s => s.state !== 'battle' && econOf(s).cruise > 0); }

  /**
   * The protected side: wait for a far escort at a safe place (bounded), keep to the escort's pace,
   * and report an escort that was lost or withdrawn. Returns ships to hold this tick and a status note.
   */
  private wardControl(g: WGroup, ships: WShip[], op: Op): { hold: Set<WShip>; note: string | null } | null {
    // escorts may target this group or the group whose order it executes
    let tg: WGroup | undefined = g, escorts: WGroup[] = [];
    for (let i = 0; tg && i < 6 && !escorts.length; i++) { escorts = this.escortsTargeting(tg.id); if (!escorts.length) tg = tg.parentId && !tg.override ? this.st.groups[tg.parentId] : undefined; }
    const W = g.ward;
    const live = escorts.map(e => ({ e, ships: this.escortShips(e), mil: this.escortShips(e).filter(s => econOf(s).military) })).filter(x => x.mil.length);
    // report escorts that disappeared since the last tick (once)
    if (W?.escorts?.length || live.length) {
      const now = live.map(x => ({ id: x.e.id, name: x.e.name }));
      for (const old of W?.escorts ?? []) if (!now.some(x => x.id === old.id)) {
        const eg = this.st.groups[old.id];
        const destroyed = !eg || !this.subtreeShips(eg).some(s => econOf(s).military);
        if (eg && destroyed && eg.op.k === 'escort') { eg.status = `${g.name} 호위 — 호위 전력 상실 (전투 함선 없음)`; eg.escort = { phase: 'lost', since: this.time }; }
        this.ev(destroyed ? 'warn' : 'info', destroyed
          ? `${g.name}: 호위 전력 상실 (${old.name}) — 무호위 상태로 작업을 계속합니다. 대체 호위를 지정하거나 철수 명령을 내리세요.`
          : `${g.name}: ${old.name}의 호위가 해제되었습니다 — 무호위 상태로 작업을 계속합니다.`, { company: g.owner, who: g.name, ref: g.id });
      }
      if (now.length) (g.ward ??= {}).escorts = now; else if (g.ward) { delete g.ward.escorts; delete g.ward.waitSince; delete g.ward.gaveUp; }
    }
    if (!live.length || !tg) return null;
    const focus = (escorts[0].op as Extract<Op, { k: 'escort' }>).focus;
    const wardSet = new Set(this.wardsOf(tg, focus).map(s => s.id));
    const wards = ships.filter(s => wardSet.has(s.id));
    if (!wards.length) return null;
    const wc = this.centroidOf(wards.map(s => s.pos))!;
    // the nearest escort with combat ships decides
    const best = live.map(x => ({ ...x, c: this.centroidOf(x.mil.map(s => s.pos))! })).sort((a, b) => (this.sysOf(a.c) === this.sysOf(wc) ? dist(a.c, wc) : 1e12) - (this.sysOf(b.c) === this.sysOf(wc) ? dist(b.c, wc) : 1e12))[0];
    const sameSys = this.sysOf(best.c)?.id === this.sysOf(wc)?.id, d = sameSys ? dist(best.c, wc) : Infinity;
    const escortSpeed = Math.min(...best.mil.map(s => this.cruiseOf(s) * (0.6 + 0.4 * s.hp)));
    const near = d < ESCORT.joined * 1.6;
    // travelling together: the wards keep to the escort's pace (never slower than a third of their own)
    if (near) for (const s of wards) this.speedCap.set(s.id, Math.max(escortSpeed * ESCORT.pace, this.cruiseOf(s) * 0.33));
    const ward = (g.ward ??= {});
    if (d <= ESCORT.joined) { delete ward.waitSince; delete ward.gaveUp; return { hold: new Set(), note: null }; }
    // far escort: wait only at a safe place, before setting out, for a reachable escort, for a bounded time
    const field = op.k === 'mine' ? this.st.fields[op.field] : undefined;
    const atWork = field ? dist(wc, field.pos) < field.radius + 1500 : false;
    // a safe place: docked / next to a dockable station, or just through a gate the escort is one jump behind (regroup after a jump)
    const wsys = this.sysOf(wc), esys = this.sysOf(best.c);
    const goal = wards.map(s => s.task.k === 'goto' ? s.task.to : null).find(Boolean) ?? (field?.pos ?? (op.k === 'move' ? op.to : null));
    const gsys = goal ? this.sysOf(goal) : undefined;
    const headingBack = !!wsys && !!gsys && !!esys && gsys.id !== wsys.id && nextGate(this.st.systems, wsys.id, gsys.id)?.to === esys.id;
    const afterJump = !!wsys && !!esys && wsys.id !== esys.id && !headingBack && jumps(this.st.systems, esys.id, wsys.id) === 1 && wsys.gates.some(gt => gt.to === esys.id && dist(gt.pos, wc) < 2500);
    const safe = afterJump || wards.every(s => s.state === 'docked' || Object.values(this.st.stations).some(st => this.canDock(st, g.owner) && dist(st.pos, s.pos) < ESCORT.safeR));
    const reach = this.reachable(best.c, wc);
    if (!reach) return { hold: new Set(), note: null };
    if (atWork || !safe || g.fleeing || ward.gaveUp) return { hold: new Set(), note: null };
    const eta = Math.round(this.escortEta(best.c, wc, escortSpeed));
    ward.waitSince ??= this.time;
    const waited = this.time - ward.waitSince;
    if (waited > ESCORT.waitMax || eta > ESCORT.etaMax) {
      ward.gaveUp = true;
      this.ev('warn', `${g.name}: 호위 합류 지연 (${best.e.name} 약 ${eta}초) — 단독 출발합니다. 호위가 따라붙으면 진형을 다시 갖춥니다.`, { company: g.owner, who: g.name, ref: g.id });
      return { hold: new Set(), note: null };
    }
    // hold only ships with nothing left to unload (docked miners finish unloading first)
    const hold = new Set(wards.filter(s => s.state === 'space' || cargoSum(s.cargo) < 1));
    return { hold, note: `${afterJump ? '점프 후 재집결' : '호위 집결'} 대기 — ${best.e.name} 합류까지 약 ${eta}초 (최대 ${Math.max(0, Math.round(ESCORT.waitMax - waited))}초 대기)` };
  }

  /** the escort's picture of its wards this tick, shared by all its ships */
  private escortPlan(g: WGroup, op: Extract<Op, { k: 'escort' }>, c: CommanderDef): EscortPlan {
    const cached = this.escortPlans.get(g.id); if (cached) return cached;
    const plan = this.makeEscortPlan(g, op, c);
    this.escortPlans.set(g.id, plan);
    // phase changes: radio and the one-off reports a player needs
    const prev = g.escort?.phase;
    if (prev !== plan.phase) {
      g.escort = { phase: plan.phase, since: this.time };
      const t = this.st.groups[op.group];
      if (plan.phase === 'intercept') this.say(g, `${t?.name ?? '보호 대상'} 쪽으로 접근하는 적대 함선 포착 — 요격한다.`, 'warn', 0);
      else if (plan.phase === 'cover') this.say(g, '보호 대상이 후퇴한다. 엄호 위치로!', 'warn', 0);
      else if (prev === 'intercept' && plan.phase !== 'lost') this.say(g, '위협 해소. 보호 위치로 복귀한다.', 'radio', 0);
      else if (plan.phase === 'blocked') this.ev('warn', `${g.name}: 호위 불가능 — ${t?.name ?? '호위 대상'}까지 가는 관문이 모두 막혀 있습니다. 경로가 열리면 다시 합류합니다. 다른 편대를 호위로 지정하거나 대기 명령을 내릴 수 있습니다.`, { company: g.owner, who: g.name, ref: g.id });
      else if (plan.phase === 'lost') this.ev('warn', `${g.name}: 호위 대상이 사라졌습니다 — 새 호위 대상을 지정하세요.`, { company: g.owner, who: g.name, ref: g.id });
    }
    return plan;
  }

  private makeEscortPlan(g: WGroup, op: Extract<Op, { k: 'escort' }>, c: CommanderDef): EscortPlan {
    const t = this.st.groups[op.group];
    const own = this.escortShips(g);
    const ec = this.centroidOf(own.filter(s => s.state === 'space').map(s => s.pos)) ?? this.centroidOf(own.map(s => s.pos));
    const none: EscortPlan = { phase: 'lost', name: t?.name ?? '', wc: null, heading: null, threat: null, ring: null, n: own.length, ids: own.map(s => s.id), extra: '' };
    if (!t || !ec) return none;
    const all = this.wardsOf(t, op.focus);
    // wards already fighting: go to that battle
    const live = all.filter(s => s.state !== 'battle');
    if (!live.length) {
      const fighting = all.find(s => s.state === 'battle');
      const e = fighting && Object.values(this.st.engagements).find(x => !x.done && !!fighting.groupId && x.groupRefs.includes(fighting.groupId));
      const at = e?.pos ?? fighting?.pos;
      return at ? { ...none, phase: 'intercept', wc: at, threat: at, extra: ' (교전 지원)' } : none;
    }
    const wc = this.centroidOf(live.map(s => s.pos))!;
    const name = t.name;
    if (!this.reachable(ec, wc)) return { ...none, phase: 'blocked', name, wc };
    const sameSys = this.sysOf(ec)?.id === this.sysOf(wc)?.id, d = sameSys ? dist(ec, wc) : Infinity;
    // where the wards are heading
    const tOp = this.opOf(t);
    const field = tOp.k === 'mine' ? this.st.fields[tOp.field] : undefined;
    const goingTo = live.map(s => s.task.k === 'goto' ? s.task.to : null).find(Boolean) ?? (tOp.k === 'move' ? tOp.to : tOp.k === 'dock' ? this.st.stations[tOp.station]?.pos : field?.pos) ?? null;
    // working the deposit: mining, or inside it with no errand leading out of it
    const inField = (q: V) => !!field && dist(q, field.pos) < field.radius + 900;
    const atField = !!field && (inField(wc) || live.every(s => s.task.k === 'mine')) && !live.some(s => s.task.k === 'goto' && !inField(s.task.to));
    const v = live.reduce((a, s) => ({ x: a.x + s.vel.x, z: a.z + s.vel.z }), { x: 0, z: 0 });
    const spd = Math.hypot(v.x, v.z) / live.length;
    const crossSys = goingTo && this.sysOf(goingTo)?.id !== this.sysOf(wc)?.id;
    const toward = goingTo && !atField ? (crossSys ? (() => { const a = this.sysOf(wc), b = this.sysOf(goingTo); const gt = a && b ? nextGate(this.st.systems, a.id, b.id) : null; return gt?.pos ?? goingTo; })() : goingTo) : null;
    const heading = toward && dist(toward, wc) > 300 ? unit(toward.x - wc.x, toward.z - wc.z) : spd > 15 ? unit(v.x, v.z) : null;
    const moving = !atField && (spd > 15 || (!!toward && dist(toward, wc) > 1500 && live.some(s => s.state === 'space')));
    // threats: the attacker closest to a ward, within detection, never beyond the leash
    const detect = ESCORT.detect + c.skill * ESCORT.detectSkill;
    let threat: V | null = null, best = Infinity;
    for (const p of Object.values(this.st.groups)) {
      if (this.st.companies[p.owner]?.kind !== 'pirate' || p.cooldown > 0 || !p.shipIds.length) continue;
      const pc = this.groupCenter(p); if (!pc || dist(pc, wc) > ESCORT.leash) continue;
      const dw = Math.min(...live.map(s => dist(pc, s.pos)));
      if (dw < detect || dist(pc, ec) < ESCORT.detectEscort) if (dw < best) { best = dw; threat = pc; }
    }
    const ring = atField ? { at: field!.pos, r: Math.max(ESCORT.ringMin, field!.radius + ESCORT.ringPad) } : null;
    const base = { name, wc, heading, threat, ring, n: own.length, ids: own.map(s => s.id) };
    if (t.fleeing && d < ESCORT.far) return { ...base, phase: 'cover', extra: '' };
    if (threat && d < ESCORT.far) return { ...base, phase: 'intercept', extra: ` (위협까지 ${Math.round(best)}m)` };
    if (d > ESCORT.far) return { ...base, phase: 'far', extra: sameSys ? ` (${Math.round(d)}m)` : ` (${this.sysOf(wc)?.name ?? '다른 성계'})` };
    if (d > ESCORT.joined) return { ...base, phase: 'join', extra: ` (${Math.round(d)}m)` };
    if (atField) return { ...base, phase: 'guard', extra: '' };
    if (moving) return { ...base, phase: 'convoy', extra: '' };
    return { ...base, phase: 'standby', extra: '' };
  }

  private behaveEscort(s: WShip, g: WGroup, op: Extract<Op, { k: 'escort' }>, dt: number, speed: number, c: CommanderDef) {
    const owner = this.opOwner(g);
    const p = this.escortPlan(owner, op, c);
    g.status = escortStatus(p.phase, p.name, p.extra);
    if (owner !== g) owner.status = g.status;
    const i = Math.max(0, p.ids.indexOf(s.id));
    const drift = () => { if (s.state === 'space') { s.vel.x *= 0.9; s.vel.z *= 0.9; s.pos = vadd(s.pos, s.vel, dt); } };
    if (!p.wc) return drift();
    switch (p.phase) {
      case 'lost': case 'blocked': return drift();
      case 'intercept': this.moveTo(s, this.formationSlot(s, g, p.threat!, 50), speed, dt, 10); return;
      case 'cover': this.moveTo(s, coverSlot(i, p.wc, p.threat), speed, dt, 25); return;
      case 'guard': {
        const pir = this.nearestHostile(p.ring!.at, g.owner, 9000, p.ring!.at, 9000);
        this.moveTo(s, ringSlot(i, p.n, p.ring!.at, p.ring!.r, pir ? unit(pir.x - p.ring!.at.x, pir.z - p.ring!.at.z) : null, this.time), speed * 0.7, dt, 30);
        return;
      }
      case 'convoy': case 'join': case 'far':
        // head for the screen position ahead of the wards, not for where they were
        this.moveTo(s, p.heading ? convoySlot(i, p.n, p.wc, p.heading) : ringSlot(i, p.n, p.wc, 420, null, this.time), speed, dt, 30);
        return;
      case 'standby': this.moveTo(s, ringSlot(i, p.n, p.wc, 420, null, this.time), speed * 0.7, dt, 30); return;
    }
  }

  // -------------------------------------------------- coordinated fleet movement
  //
  // A fleet (the group holding the order plus every subordinate that inherits it, minus groups
  // explicitly detached as scouts/vanguard) moves as one: it first rallies, then advances at the pace
  // of its slowest ship, warps only when every hull is aligned, regroups on each side of a jump gate,
  // and for an attack stops at a staging point short of the target until it is assembled — only then
  // does it go in. Commanders set how tight the formation is and how long they wait for stragglers.

  /** ships that move with this fleet (not detached, not fighting) */
  private fleetMembers(owner: WGroup): { ships: WShip[]; groups: WGroup[] } {
    const groups: WGroup[] = [], ships: WShip[] = [];
    const walk = (x: WGroup) => {
      groups.push(x);
      for (const id of x.shipIds) { const s = this.st.ships[id]; if (s && s.state !== 'battle' && econOf(s).cruise > 0) ships.push(s); }
      for (const cid of x.childIds) { const c = this.st.groups[cid]; if (c && !c.override && !c.detached) walk(c); }
    };
    walk(owner);
    return { ships, groups };
  }

  private fleetSlot(s: WShip, members: WShip[], at: V, toward: V | null): V {
    // line abreast across the axis of travel, heavier ships in the middle row
    const idx = members.indexOf(s);
    const n = members.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 2)));
    const row = Math.floor(idx / cols), col = idx % cols - (cols - 1) / 2;
    let fx = 0, fz = 1;
    if (toward) { const dx = toward.x - at.x, dz = toward.z - at.z, l = Math.hypot(dx, dz); if (l > 1) { fx = dx / l; fz = dz / l; } }
    const gap = 110;
    return { x: at.x + (-fz) * col * gap - fx * row * gap, y: at.y + ((idx % 3) - 1) * 20, z: at.z + fx * col * gap - fz * row * gap };
  }

  private marchRoute(from: V, to: V): V[] {
    const out: V[] = [];
    let here = this.sysOf(from);
    const there = this.sysOf(to);
    for (let k = 0; k < 8 && here && there && here.id !== there.id; k++) {
      const gate = nextGate(this.st.systems, here.id, there.id, this.st.conflicts ? gt => gateOpen(this.st, gt) : undefined); if (!gate) break;
      const inward = (p: V, o: V, d: number) => { const dx = o.x - p.x, dz = o.z - p.z, l = Math.hypot(dx, dz) || 1; return { x: p.x + dx / l * d, y: p.y, z: p.z + dz / l * d }; };
      out.push(inward(gate.pos, here.origin, 650));                       // regroup before the gate
      const dest = this.st.systems[gate.to]; const exit = dest?.gates.find(x => x.id === gate.exit);
      if (!dest || !exit) break;
      out.push(inward(exit.pos, dest.origin, 900));                       // and after it
      here = dest;
    }
    out.push(to);
    return out;
  }

  private attackTarget(op: Op): V | null {
    if (op.k !== 'attack') return null;
    if (op.lair) { const l = this.st.lairs[op.lair]; return l?.alive ? l.pos : null; }
    if (op.group) { const t = this.st.groups[op.group]; return t && t.shipIds.length ? this.groupCenter(t) : null; }
    return null;
  }

  /** update (once per tick) and return the fleet's march state; null → no coordinated move */
  private fleetMarch(g: WGroup, op: Op, dt: number): March | null {
    const owner = this.marchOwner(g);
    if ((owner as any)._marchT === this.time && owner.march) return owner.march;
    (owner as any)._marchT = this.time;
    const { ships } = this.fleetMembers(owner);
    (owner as any)._members = ships;
    if (!ships.length) return null;
    const c = this.cmdr(owner);
    const target = this.attackTarget(op);
    if (op.k === 'attack' && !target) return null;
    const key = op.k === "move" ? `m:${Math.round(op.to.x)}:${Math.round(op.to.z)}` : op.k === "attack" ? `a:${op.lair ?? op.group}` : "";
    const cen = this.centroid(ships);
    let m = owner.march;
    if (!m || m.key !== key) {
      const dest = op.k === 'move' ? op.to : target!;
      m = owner.march = { key, phase: 'assemble', wp: this.marchRoute(cen, dest), i: 0, at: cen, since: this.time, warpGo: false, speed: 0, members: ships.length, inPlace: 0 };
      if (ships.length > 1) this.say(owner, `함대 집결 — ${ships.length}척, 가장 느린 함선에 맞춰 함께 이동한다.`, 'radio', 5);
    }
    // the slowest hull sets the pace; a skilled commander keeps the line tighter and moves a bit faster
    m.speed = Math.min(...ships.map(s => this.cruiseOf(s) * (0.6 + 0.4 * s.hp))) * (0.92 + c.skill * 0.08);
    m.members = ships.length;
    const leash = 260 + 70 * Math.sqrt(ships.length) * (1.25 - c.skill * 0.4);
    const patience = 60 + c.skill * 120 - c.aggression * 40;     // seconds before stragglers are left behind
    const near = (p: V) => ships.filter(s => dist(s.pos, p) < leash + 120 + Math.sqrt(ships.length) * 60).length;
    const warn = (txt: string) => this.say(owner, txt, 'warn', 30);
    // stage short of an attack target; aggressive commanders stage closer
    const stage = (t: V, from: V): V => { const d = 2600 - c.aggression * 900; const dx = from.x - t.x, dz = from.z - t.z, l = Math.hypot(dx, dz) || 1; return l <= d ? from : { x: t.x + dx / l * d, y: t.y, z: t.z + dz / l * d }; };
    if (ships.some(s => s.engagement) && op.k === 'attack') m.phase = 'engage';
    switch (m.phase) {
      case 'assemble': {
        m.inPlace = near(m.at);
        if (m.inPlace >= ships.length || this.time - m.since > patience) {
          if (m.inPlace < ships.length) warn(`낙오 함선 ${ships.length - m.inPlace}척 — 더 기다리지 않고 출발한다.`);
          m.phase = 'transit'; m.since = this.time;
        }
        break;
      }
      case 'transit': {
        const last = m.i >= m.wp.length - 1;
        if (last && target) m.wp[m.i] = stage(target, this.centroid(ships));
        const wp = m.wp[m.i];
        m.at = wp;
        m.inPlace = near(wp);
        // all ships aligned (or not warping) → release the drives together
        m.warpGo = ships.every(s => !s.warp || s.warp.phase === 'warp' || s.warp.t >= (ALIGN[s.classId] ?? 5)) || this.time - m.since > patience;
        if (m.inPlace >= ships.length || (m.inPlace >= ships.length * 0.75 && this.time - m.since > patience * 3)) {
          if (!last) { m.i++; m.since = this.time; m.warpGo = false; break; }
          m.phase = op.k === 'move' ? 'arrived' : 'ready'; m.since = this.time;
          if (op.k === 'attack') this.say(owner, `집결 완료 (${m.inPlace}/${ships.length}척). 전 함대 교전 준비 — 공격 개시!`, 'radio', 0);
          else this.say(owner, `함대 전원 목적지 도착 (${m.inPlace}/${ships.length}척).`, 'radio', 0);
        }
        break;
      }
      case 'ready': if (this.time - m.since > 2) m.phase = 'engage'; break;
    }
    if (op.k === 'move' && m.phase === 'arrived') m.at = op.to;
    return m;
  }

  private centroid(ships: WShip[]): V {
    let x = 0, y = 0, z = 0; for (const s of ships) { x += s.pos.x; y += s.pos.y; z += s.pos.z; }
    const n = ships.length || 1; return { x: x / n, y: y / n, z: z / n };
  }

  /** the fleet a group moves with: up the inheritance chain, stopping at detached scouts/vanguards */
  marchOwner(g: WGroup): WGroup {
    let cur: WGroup = g;
    while (!cur.override && !cur.detached && cur.parentId && this.st.groups[cur.parentId]) cur = this.st.groups[cur.parentId];
    return cur;
  }

  private marchShip(s: WShip, g: WGroup, op: Op, m: March, dt: number, c: CommanderDef) {
    const owner = this.marchOwner(g);
    const members: WShip[] = (owner as any)._members ?? this.fleetMembers(owner).ships;
    const own = this.cruiseOf(s) * (0.6 + 0.4 * s.hp);
    (s as any)._holdWarp = !m.warpGo;
    if (m.phase === 'engage') { (s as any)._holdWarp = false; this.behave(s, g, op, dt, c); g.status = `${g.status} (함대 공격)`; return; }
    const next = m.wp[Math.min(m.i + 1, m.wp.length - 1)];
    const slot = this.fleetSlot(s, members, m.at, m.phase === 'assemble' ? m.wp[0] : next);
    // rallying ships may hurry; once moving, nobody outruns the slowest
    const speed = m.phase === 'assemble' ? own : Math.min(own, m.speed);
    this.moveTo(s, slot, speed, dt, 30);
    const n = `${m.inPlace}/${m.members}척`;
    g.status = m.phase === 'assemble' ? `함대 집결 중 (${n})`
      : m.phase === 'transit' ? `함대 이동 — 속도 ${Math.round(m.speed)} (최저속 함선 기준 · ${m.i + 1}/${m.wp.length} 구간 · ${n})`
      : m.phase === 'ready' ? `집결 완료 — 공격 준비 (${n})` : op.k === 'move' ? '목적지 도착' : '공격';
  }

  private threatCheck(g: WGroup, ships: WShip[], op: Op, c: CommanderDef) {
    const civ = ships.filter(s => !econOf(s).military && s.state === 'space');
    if (!civ.length && !g.fleeing) return;
    const detect = 900 + c.skill * 2300;
    let threat = 0, nearest = Infinity;
    for (const p of Object.values(this.st.groups)) {
      if (p.owner !== 'pirates' || !p.shipIds.length) continue;
      const pc = this.groupCenter(p); if (!pc) continue;
      for (const s of (civ.length ? civ : ships)) { const d = dist(pc, s.pos); if (d < detect) { threat += this.groupValue(p); nearest = Math.min(nearest, d); break; } }
    }
    if (!g.fleeing && threat > 0) {
      // friendly protection around: own military in group + nearby escort/patrol groups
      let guard = this.groupValue(g, true);
      const gc = this.groupCenter(g)!;
      for (const o of Object.values(this.st.groups)) {
        if (o === g || (o.owner !== g.owner && o.owner !== 'union')) continue;
        const oc = this.groupCenter(o); if (oc && dist(oc, gc) < 1800) guard += this.groupValue(o, true);
      }
      if (guard < threat * (1.15 - c.aggression * 0.4)) {
        g.fleeing = true;
        (g as any)._safeSince = this.time;
        this.say(g, c.skill > 0.6 ? `해적 접근 포착 (${Math.round(nearest)}m)! 작업 중단, 정거장으로 철수한다.` : '해, 해적이다! 도망쳐!', 'warn', 3);
      }
    } else if (g.fleeing) {
      if (threat > 0) (g as any)._safeSince = this.time;
      else if (this.time - ((g as any)._safeSince ?? 0) > 12) { g.fleeing = false; this.say(g, '위협 해제. 작업을 재개합니다.', 'radio', 3); }
    }
    void op;
  }

  nearestDock(p: V, company: string): Station | null {
    let best: Station | null = null, bd = Infinity;
    for (const s of Object.values(this.st.stations)) { if (!this.canDock(s, company)) continue; const d = this.routeDistance(s.pos, p); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  // -------------------------------------------------- motion primitives

  sysOf(p: V): StarSystem | undefined { return sysAt(this.st.systems, p); }

  effSec(sys: StarSystem): number { return effSec(sys); }
  secAt(p: V): number { return secAt(this.st, p); }

  /** move toward `to`, routing through jump gates when it lies in another system */
  private moveTo(s: WShip, to: V, speed: number, dt: number, arrive = 40, managed = false): boolean {
    if (s.state === 'docked') this.undock(s);
    const here = this.sysOf(s.pos), there = this.sysOf(to);
    if (here && there && here.id !== there.id) {
      const job = s.logisticsJob ? this.st.logisticsJobs?.[s.logisticsJob] : undefined;
      const maxRisk = managed && job?.procurement ? this.st.companies[s.owner]?.procurement?.maxRisk ?? 100 : undefined;
      const open = this.st.conflicts ? (gate: Gate) => gateOpen(this.st, gate) : undefined;
      const gate = nextGate(this.st.systems, here.id, there.id, managed ? gate => usableRouteGate(this.st, gate) && (maxRisk === undefined || 100 - effSec(this.st.systems[gate.to]) <= maxRisk) : open);
      if (!gate) { s.vel.x *= 0.9; s.vel.z *= 0.9; return false; }
      if (!s.warp && dist(s.pos, gate.pos) < 180) { this.jump(s, gate); return false; }
      this.fly(s, gate.pos, speed, dt, 10);
      return false;
    }
    return this.fly(s, to, speed, dt, arrive);
  }

  private jump(s: WShip, gate: Gate) {
    const dest = this.st.systems[gate.to];
    const exit = dest?.gates.find(g => g.id === gate.exit);
    if (!dest || !exit) return;
    if (!gateOpen(this.st, gate)) return;   // a blockaded gate refuses transit
    // emerge a little inward of the exit gate, toward the star
    const ix = dest.origin.x - exit.pos.x, iz = dest.origin.z - exit.pos.z, l = Math.hypot(ix, iz) || 1;
    const a = this.rng.range(-0.6, 0.6);
    const r = 320 + this.rng.range(0, 160);
    const dx = ix / l, dz = iz / l;
    s.pos = { x: exit.pos.x + (dx * Math.cos(a) - dz * Math.sin(a)) * r, y: exit.pos.y + this.rng.range(-30, 30), z: exit.pos.z + (dx * Math.sin(a) + dz * Math.cos(a)) * r };
    s.vel = { x: dx * 40, y: 0, z: dz * 40 };
    s.heading = Math.atan2(dx, dz);
    s.jumpT = this.time; s.warp = undefined;
  }

  /** hostile warships close enough to block a warp-out */
  private scrambled(s: WShip): boolean {
    const pirate = s.owner === 'pirates';
    for (const g of Object.values(this.st.groups)) {
      const k = this.st.companies[g.owner]?.kind;
      if (pirate ? k === 'pirate' || k === 'guild' : k !== 'pirate') continue;
      for (const id of g.shipIds) {
        const o = this.st.ships[id];
        if (!o || o.state !== 'space' || !econOf(o).military || o.warp?.phase === 'warp') continue;
        if (Math.abs(o.pos.x - s.pos.x) < SCRAMBLE_R && dist(o.pos, s.pos) < SCRAMBLE_R) return true;
      }
    }
    return false;
  }

  /** in-system flight: warp for long legs (align → warp → drop out), sublight otherwise */
  private fly(s: WShip, to: V, speed: number, dt: number, arrive: number): boolean {
    let d = dist(s.pos, to);
    if (!s.warp && d > WARP_MIN && econOf(s).cruise > 0 && !this.scrambled(s)) s.warp = { to: { ...to }, phase: 'align', t: 0 };
    if (s.warp) {
      const w = s.warp;
      w.to = { ...to };
      const dx = to.x - s.pos.x, dy = to.y - s.pos.y, dz = to.z - s.pos.z;
      if (w.phase === 'align') {
        if (d < WARP_MIN * 0.6 || this.scrambled(s)) { s.warp = undefined; return false; }
        w.t += dt;
        const want = Math.atan2(dx, dz);
        let dh = want - s.heading; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
        s.heading += dh * Math.min(1, dt * 1.2);
        // drift forward slowly while the drive spools
        const fv = Math.min(speed * 0.5, 30 + w.t * 10);
        s.vel = { x: Math.sin(s.heading) * fv, y: 0, z: Math.cos(s.heading) * fv };
        s.pos = vadd(s.pos, s.vel, dt);
        // fleet warps wait until every ship is aligned, then go together
        if (w.t >= (ALIGN[s.classId] ?? 5) && !(s as any)._holdWarp) { w.phase = 'warp'; w.t = 0; }
        return false;
      }
      w.t += dt;
      if (d <= WARP_EXIT) {
        s.warp = undefined;
        const k = speed / Math.max(1, d);
        s.vel = { x: dx * k, y: dy * k, z: dz * k };
        return false;
      }
      const v = Math.min(WARP_V, 300 + 2600 * w.t * w.t, Math.max(speed * 2, (d - WARP_EXIT) * 1.6 + speed));
      const step = Math.min(v * dt, d - WARP_EXIT * 0.8);
      s.vel = { x: dx / d * v, y: dy / d * v, z: dz / d * v };
      s.pos = { x: s.pos.x + dx / d * step, y: s.pos.y + dy / d * step, z: s.pos.z + dz / d * step };
      s.heading = Math.atan2(dx, dz);
      d -= step;
      return false;
    }
    const dx = to.x - s.pos.x, dy = to.y - s.pos.y, dz = to.z - s.pos.z;
    if (d < arrive) { s.vel.x *= 0.7; s.vel.y *= 0.7; s.vel.z *= 0.7; s.pos = vadd(s.pos, s.vel, dt); return true; }
    const want = Math.min(speed, d * 0.9 + 8);
    const tx = dx / d * want, ty = dy / d * want, tz = dz / d * want;
    const acc = Math.max(20, speed * 0.7) * dt;
    const ex = tx - s.vel.x, ey = ty - s.vel.y, ez = tz - s.vel.z;
    const el = Math.hypot(ex, ey, ez);
    const k = el > acc ? acc / el : 1;
    s.vel = { x: s.vel.x + ex * k, y: s.vel.y + ey * k, z: s.vel.z + ez * k };
    s.pos = vadd(s.pos, s.vel, dt);
    if (Math.hypot(s.vel.x, s.vel.z) > 3) s.heading = Math.atan2(s.vel.x, s.vel.z);
    return false;
  }

  undock(s: WShip) { s.state = 'space'; delete s.cargoWork; if (s.task.k === 'docked') s.task = { k: 'none' }; }

  /** Returns the quantity handled, or null while work is still in progress. */
  cargoPermit(s: WShip, st: Station, key: string, amount: number): number | null {
    const rate = stationCargoRate(st);
    if (rate === undefined || amount <= 1e-9) { delete s.cargoWork; return amount; }
    let w = s.cargoWork;
    if (!w || w.station !== st.id || w.key !== key || this.time - w.time > STRAT_DT + 1e-6) {
      w = s.cargoWork = { station: st.id, key, amount, done: 0, time: this.time };
      return null;
    }
    w.done += Math.max(0, this.time - w.time) * rate * stationPower(st).factor; w.time = this.time;
    const target = Math.min(w.amount, amount);
    if (w.done + 1e-9 < target) return null;
    delete s.cargoWork;
    return target;
  }

  dockShip(s: WShip, st: Station): boolean {
    const limit = stationBerths(st);
    if (limit !== undefined && (!berthFits(st, econOf(s).berth) || occupiedBerths(this.st, st.id, s.id) >= limit)) return false;
    const used = new Set(Object.values(this.st.ships).filter(o => o.task.k === 'docked' && o.task.station === st.id).map(o => (o.task as any).berth));
    let b = hashId(s.id) % (BERTH_MAX); let n = 0; while (used.has(b) && n++ < BERTH_MAX) b = (b + 1) % BERTH_MAX;
    s.state = 'docked'; s.task = { k: 'docked', station: st.id, berth: b }; s.pos = berthPos(st, b); s.vel = { x: 0, y: 0, z: 0 };
    s.heading = Math.atan2(st.pos.x - s.pos.x, st.pos.z - s.pos.z) + Math.PI / 2;
    // growth P4: automatic maintenance wherever the station can do it (no order needed)
    if (!growthOn(this.st)) return true;
    const capable = st.services.repair || (st.owner === s.owner && (this.hasModule(st, 'repair') || this.hasModule(st, 'hangar')));
    if (s.wear) watchMoney(this.st, 'maintenance_accrual', { company: s.owner, ship: s.id, group: s.groupId, station: st.id }, () => maintainOnDock(this.st, s, st, capable));
    // a mining group's miners hand their ore to the hauler at the field and never dock themselves: the
    // hauler brings their service parts back on each run, so automated mining is maintained too
    const g = this.st.groups[s.groupId];
    if (capable && s.classId === 'hauler' && g?.op?.k === 'mine')
      for (const m of this.shipsOf(g)) if (m !== s && m.state === 'space' && m.wear) watchMoney(this.st, 'maintenance_accrual', { company: m.owner, ship: m.id, group: m.groupId, station: st.id }, () => maintainOnDock(this.st, m, st, true));
    return true;
  }

  /** returns true once docked */
  goDock(s: WShip, st: Station, dt: number, speed: number, managed = false, berthChecked = false): boolean {
    if (s.state === 'docked' && s.task.k === 'docked' && s.task.station === st.id) return true;
    const limit = stationBerths(st);
    if (!berthChecked && limit !== undefined && (!berthFits(st, econOf(s).berth) || occupiedBerths(this.st, st.id, s.id) >= limit)) {
      const g = this.st.groups[s.groupId];
      if (g) g.status = !berthFits(st, econOf(s).berth) ? `${st.name}: 정박 규격 부족` : `${st.name}: 정박 공간 대기`;
      return false;
    }
    const approach = berthPos(st, hashId(s.id) % BERTH_MAX);
    if (this.moveTo(s, approach, speed, dt, 45, managed)) return this.dockShip(s, st);
    return false;
  }

  /** Approach an owned construction site without inventing a completed docking facility. */
  goConstruction(s: WShip, st: Station, dt: number, speed: number): boolean {
    const a = (hashId(s.id) % 628) / 100;
    return this.moveTo(s, { x: st.pos.x + Math.cos(a) * (st.radius + 120), y: st.pos.y + 30, z: st.pos.z + Math.sin(a) * (st.radius + 120) }, speed, dt, 70, true);
  }

  private formationSlot(s: WShip, g: WGroup, center: V, spread = 70): V {
    const idx = g.shipIds.indexOf(s.id);
    const a = idx * 2.4;
    const r = idx === 0 ? 0 : spread * (0.6 + Math.floor(idx / 6) * 0.6);
    return { x: center.x + Math.cos(a) * r, y: center.y + ((idx % 3) - 1) * 18, z: center.z + Math.sin(a) * r };
  }

  private groupSpeed(g: WGroup, military: boolean): number {
    const s = this.shipsOf(g).filter(x => x.state !== 'battle' && econOf(x).military === military);
    return s.length ? Math.min(...s.map(x => this.cruiseOf(x) * (0.6 + 0.4 * x.hp))) : 100;
  }

  // -------------------------------------------------- per-ship behaviour

  private behave(s: WShip, g: WGroup, op: Op, dt: number, c: CommanderDef) {
    const ec = econOf(s);
    if (ec.cruise <= 0) return;
    let speed = this.cruiseOf(s) * (0.6 + 0.4 * s.hp) * (c.specialty === 'maneuver' ? 1.08 : 1);
    // an escorted ship does not outrun its escort (set by wardControl for this tick)
    const cap = this.speedCap.get(s.id); if (cap !== undefined) speed = Math.min(speed, cap);
    const st = this.st;
    if (s.logisticsJob && stepPoolShip(this, s, g, dt, speed)) return;
    switch (op.k) {
      case 'idle': {
        if (s.state === 'space') { s.vel.x *= 0.9; s.vel.z *= 0.9; s.pos = vadd(s.pos, s.vel, dt); }
        g.status = s.state === 'docked' ? '정박 대기' : '대기';
        break;
      }
      case 'move': {
        const arrived = this.moveTo(s, this.formationSlot(s, g, op.to), ec.military ? Math.min(speed, this.groupSpeed(g, true)) : speed, dt);
        g.status = arrived ? '목적지 도착' : '이동 중';
        break;
      }
      case 'dock': {
        const sta = st.stations[op.station];
        g.status = this.goDock(s, sta, dt, speed) ? `${sta.name} 정박` : `${sta.name}로 이동`;
        break;
      }
      case 'mine': this.behaveMine(s, g, op, dt, speed, c); break;
      case 'haul': this.behaveHaul(s, g, op, dt, speed); break;
      case 'patrol': {
        if (!ec.military) { this.moveTo(s, this.formationSlot(s, g, op.at, 90), speed, dt); break; }
        const hostile = this.nearestHostile(s.pos, g.owner, op.radius + 900, op.at, op.radius + 1200);
        if (hostile) { this.moveTo(s, this.formationSlot(s, g, hostile, 60), speed, dt, 10); g.status = '해적 요격!'; if (!(g as any)._interceptSaid || this.time - (g as any)._interceptSaid > 30) { (g as any)._interceptSaid = this.time; this.say(g, '순찰 구역에 해적 진입. 요격한다!', 'warn', 0); } }
        else {
          const a = this.time * 0.05 + hashId(g.id);
          const p = { x: op.at.x + Math.cos(a) * op.radius * 0.7, y: op.at.y, z: op.at.z + Math.sin(a) * op.radius * 0.7 };
          this.moveTo(s, this.formationSlot(s, g, p, 60), Math.min(speed, this.groupSpeed(g, true)) * 0.6, dt);
          g.status = '순찰 중';
        }
        break;
      }
      case 'escort': this.behaveEscort(s, g, op, dt, speed, c); break;
      case 'attack': {
        let target: V | null = null;
        let name = '';
        if (op.lair) { const l = st.lairs[op.lair]; if (l?.alive) { target = l.pos; name = l.name; } }
        else if (op.group) { const t = st.groups[op.group]; if (t && t.shipIds.length) { target = this.groupCenter(t); name = t.name; } }
        if (!target) { g.status = '목표 소멸 — 대기'; if (g.override && op.k === 'attack') { g.op = { k: 'idle' }; this.say(g, '목표가 사라졌습니다. 대기합니다.', 'radio', 0); } break; }
        if (!ec.military) { this.moveTo(s, this.formationSlot(s, g, vlerp(target, s.pos, 0.6), 80), speed, dt); break; }
        this.moveTo(s, this.formationSlot(s, g, target, 60), Math.min(speed, this.groupSpeed(g, true)), dt, 10);
        g.status = `${name} 공격 기동`;
        break;
      }
      case 'build': this.behaveBuild(s, g, op.station, dt, speed, c); break;
      case 'found': {
        if (s.classId !== 'constructor') { this.moveTo(s, this.formationSlot(s, g, op.at, 120), speed, dt); break; }
        if (this.moveTo(s, op.at, speed, dt, 60)) {
          if (growthOn(this.st) && op.escrowed) {
            // Inherited/stale orders cannot create duplicate sites or charge a second time.
            if (g.op !== op) break;
            const co = this.st.companies[g.owner];
            const invalid = this.validateOp(g.owner, g, op);
            if (invalid) { g.status = `설립 대기: ${invalid} — 자재·화물 보존`; break; }
            const paid = co.foundingEscrow?.[g.id];
            if (!paid) { g.op = { k: 'idle' }; g.status = '설립 선납금 없음 — 다시 명령하세요'; break; }
            delete co.foundingEscrow![g.id]; if (!Object.keys(co.foundingEscrow!).length) delete co.foundingEscrow;
            this.foundStation(g, s, op, paid);
          } else this.foundStation(g, s, op);
        }
        else g.status = `정거장 부지로 이동 (${Math.round(dist(s.pos, op.at))}m)`;
        break;
      }
      case 'survey': this.behaveSurvey(s, g, op, dt, speed); break;
      case 'salvage': this.behaveSalvage(s, g, op, dt, speed); break;
      case 'raid': this.behaveRaid(s, g, op, dt, speed); break;
      case 'trade': this.behaveTrade(s, g, op, dt, speed); break;
      case 'guard': {
        if (this.unionRepair(s, g, speed, dt)) break;
        const wp = op.route[op.leg % op.route.length];
        if (!wp) break;
        const hostile = this.nearestHostile(s.pos, g.owner, 4000, wp, 9000);
        if (hostile) { this.moveTo(s, this.formationSlot(s, g, hostile, 50), speed, dt, 10); g.status = '해적 추격'; break; }
        const gc = this.groupCenter(g)!;
        if (dist(gc, wp) < 400 && g.shipIds[0] === s.id) op.leg = (op.leg + 1) % op.route.length;
        this.moveTo(s, this.formationSlot(s, g, wp, 70), Math.min(speed, this.groupSpeed(g, true)) * 0.8, dt, 60);
        g.status = '연합 정기 순찰';
        break;
      }
      case 'garrison': {
        if (this.unionRepair(s, g, speed, dt)) break;
        const home = st.stations[op.station]; if (!home) break;
        const hostile = this.nearestHostile(home.pos, g.owner, op.radius, home.pos, op.radius + 2000);
        if (hostile) { this.moveTo(s, this.formationSlot(s, g, hostile, 50), speed, dt, 10); g.status = '주둔군 요격'; break; }
        const a = this.time * 0.02 + hashId(g.id);
        const r = home.radius + 700;
        this.moveTo(s, this.formationSlot(s, g, { x: home.pos.x + Math.cos(a) * r, y: home.pos.y + 60, z: home.pos.z + Math.sin(a) * r }, 70), Math.min(speed, this.groupSpeed(g, true)) * 0.5, dt, 40);
        g.status = `${home.name} 주둔 경계`;
        break;
      }
      case 'respond': {
        if (this.unionRepair(s, g, speed, dt)) break;
        const home = st.stations[op.home]; if (!home) break;
        if (g.shipIds[0] === s.id && (!(g as any)._nextPick || this.time >= (g as any)._nextPick)) {
          (g as any)._nextPick = this.time + 4;
          const prev = op.target;
          op.target = this.pickResponse(g, home);
          if (op.target && op.target !== prev) {
            const t = st.groups[op.target];
            const sys = this.sysOf(home.pos);
            if (t && sys) this.ev('world', `${sys.name}: ${g.name} 출동 — ${t.name} 요격에 나섰다.`, { pos: this.groupCenter(t) ?? home.pos, ref: op.target });
          }
        }
        const t = op.target ? st.groups[op.target] : null;
        const tc = t ? this.groupCenter(t) : null;
        if (tc) { this.moveTo(s, this.formationSlot(s, g, tc, 50), Math.min(speed, this.groupSpeed(g, true)), dt, 10); g.status = `신속대응: ${t!.name} 추격`; break; }
        const r = home.radius + 900;
        this.moveTo(s, this.formationSlot(s, g, { x: home.pos.x - r, y: home.pos.y + 80, z: home.pos.z }, 80), speed * 0.6, dt, 40);
        g.status = `${home.name} 대기 (출동 준비)`;
        break;
      }
    }
  }

  private nearestHostile(p: V, owner: string, r: number, anchor: V, leash: number): V | null {
    const enemyKind = owner === 'pirates' ? null : 'pirate';
    let best: V | null = null, bd = r;
    for (const g of Object.values(this.st.groups)) {
      const k = this.st.companies[g.owner]?.kind;
      if (enemyKind ? k !== enemyKind : k === 'pirate') continue;
      if (g.cooldown > 0) continue;
      const c = this.groupCenter(g); if (!c) continue;
      const d = dist(c, p);
      if (d < bd && dist(c, anchor) < leash) { bd = d; best = c; }
    }
    return best;
  }

  private behaveMine(s: WShip, g: WGroup, op: Extract<Op, { k: 'mine' }>, dt: number, speed: number, c: CommanderDef) {
    const st = this.st;
    const f = st.fields[op.field];
    if (!f) { g.status = '작전 대상 소멸'; return; }
    const dock = this.mineDock(g, op);
    const ec = econOf(s);
    const groupShips = this.subtreeShipsInOp(g);
    const haulers = groupShips.filter(x => x.classId === 'hauler' && x.state !== 'battle');
    if (ec.mine > 0) {
      const cap = miningCargoCapacity(st, s, st.companies[s.owner]?.tech);
      if (s.state === 'docked') {
        if (cargoSum(s.cargo) > 0 && dock && s.task.k === 'docked' && s.task.station === dock.id && !this.unloadWhenReady(s, dock, op.sell)) { g.status = `${dock.name}: 화물 하역 중`; return; }
        this.undock(s);
      }
      const full = cargoSum(s.cargo) >= cap * 0.98;
      if (!dock && (full || (s.task as any).why === 'deliver')) {
        // nowhere valid to unload: hold the ore (never sell it somewhere the player didn't choose)
        s.task = { k: 'none' }; s.vel.x *= 0.8; s.vel.z *= 0.8;
        g.status = '하역지 사용 불가 — 화물 보관 중, 목적지 재지정 필요'; return;
      }
      if (full && dock && (!haulers.length || (s.task as any).why === 'deliver')) {
        if ((s.task as any).why !== 'deliver') emit(this.st, { kind: 'logistics', reason: 'depart', amount: 1, company: s.owner, group: g.id, ship: s.id, ref: s.id });
        s.task = { k: 'goto', to: dock.pos, why: 'deliver' };
        if (this.goDock(s, dock, dt, speed)) { if (!this.unloadWhenReady(s, dock, op.sell)) { g.status = `${dock.name}: 화물 하역 중`; return; } this.undock(s); s.task = { k: 'none' }; }
        g.status = '광석 운반 중';
        return;
      }
      if (full) {
        const w = ((s as any)._waitFull = ((s as any)._waitFull ?? 0) + dt);
        // a capable commander doesn't let miners idle: go deliver yourself if the hauler is late
        if (w > 40 - c.skill * 25 && dock) { s.task = { k: 'goto', to: dock.pos, why: 'deliver' }; (s as any)._waitFull = 0; }
        g.status = '수송선 대기 (화물칸 가득)'; s.vel.x *= 0.8; s.vel.z *= 0.8; return;
      }
      (s as any)._waitFull = 0;
      if (f.amount < 1) {
        g.status = `${f.name} 고갈 — 재생 대기`;
        if (cargoSum(s.cargo) > 0 && dock) { s.task = { k: 'goto', to: dock.pos, why: 'deliver' }; if (this.goDock(s, dock, dt, speed)) { if (!this.unloadWhenReady(s, dock, op.sell)) { g.status = `${dock.name}: 화물 하역 중`; return; } this.undock(s); s.task = { k: 'none' }; } }
        return;
      }
      const rock = hashId(s.id) % f.rocks;
      const spot = miningSpot(f, rock);
      if (this.moveTo(s, spot, speed, dt, 18)) {
        // growth: worn equipment mines slower; big hulls work small fields at half efficiency
        const g3 = growthOn(this.st);
        const rate = ec.mine * (0.8 + c.skill * 0.4) * (0.5 + 0.5 * s.hp) * (f.rich ?? 1) * (g3 ? wearMul(s) * (ec.minField && f.max < ec.minField ? 0.5 : 1) : 1);
        const a = Math.min(rate * dt * techFx(this.st.companies[g.owner]?.tech).mineMul, f.amount, cap - cargoSum(s.cargo));
        f.amount -= a;
        if (f.geo) {
          // unidentified deposit: discrete units drawn from the local (zone, depth) composition; the company learns only these
          const units = mineGeo(f, s, a, rock, this.st.fields);
          for (const [k, n] of Object.entries(units)) { addc(s.cargo, k, n); emit(st, { kind: 'produce', amount: n, company: s.owner, group: g.id, ship: s.id, system: this.sysOf(f.pos)?.id, item: k, reason: 'mining', ref: f.id }); }
          if (cargoKeys(units).length) this.sampled(s.owner, f, units);
        } else {
          for (const [k, w] of Object.entries(f.mix ?? { [f.res]: 1 })) { addc(s.cargo, k, a * w); if (a > 0) emit(st, { kind: 'produce', amount: a * w, company: s.owner, group: g.id, ship: s.id, system: this.sysOf(f.pos)?.id, item: k, reason: f.salvage ? 'wreck_mining' : 'mining', ref: f.id }); }
          if (this.st.intel && a > 0 && !f.salvage) recordSample(this.st, s.owner, f, Object.fromEntries(Object.entries(f.mix ?? { [f.res]: 1 }).map(([k, w]) => [k, a * w])));
        }
        s.task = { k: 'mine', field: f.id, rock };
        s.fx = { mining: f.id, rock };
        const r = rockPos(f, rock); s.heading = Math.atan2(r.x - s.pos.x, r.z - s.pos.z);
        this.st.companies[g.owner] && (this.st.companies[g.owner].stats.mined += a);
        g.status = `${f.name} 채굴 중`;
      } else { s.task = { k: 'goto', to: spot, why: 'field' }; g.status = `${f.name}로 이동`; }
      return;
    }
    if (ec.cargo > 0 && s.classId === 'hauler') {
      const cap = miningCargoCapacity(st, s, st.companies[s.owner]?.tech);
      if (s.state === 'docked') { if (cargoSum(s.cargo) > 0 && dock && s.task.k === 'docked' && s.task.station === dock.id && !this.unloadWhenReady(s, dock, op.sell)) { g.status = `${dock.name}: 화물 하역 중`; return; } this.undock(s); }
      const miners = groupShips.filter(x => econOf(x).mine > 0 && x.state === 'space');
      const load = cargoSum(s.cargo);
      // stick with the current donor until it's empty, otherwise pick the fullest miner
      let donor = s.task.k === 'transfer' ? miners.find(m => m.id === (s.task as any).with && cargoSum(m.cargo) >= 1) : undefined;
      if (!donor) donor = miners.filter(m => cargoSum(m.cargo) >= 25).sort((a, b) => cargoSum(b.cargo) - cargoSum(a.cargo))[0];
      const delivering = (s.task as any).why === 'deliver';
      if (!delivering && load < cap * 0.92 && donor) {
        const near = vadd(donor.pos, { x: 0, y: 26, z: 0 });
        s.task = { k: 'transfer', with: donor.id };
        if (this.moveTo(s, near, speed, dt, 40)) {
          const amt = Math.min(30 * dt, cargoSum(donor.cargo), cap - load);
          let left = amt;
          for (const r of cargoKeys(donor.cargo)) { const t = takec(donor.cargo, r, left); addc(s.cargo, r, t); if (t > 0 && growthOn(this.st)) withdrawRouteCargo(this, donor.owner, donor.id, r, t); left -= t; if (left <= 1e-9) break; }
          s.fx = { transfer: donor.id };
          if ((donor.task as any).why === 'deliver') donor.task = { k: 'none' };
        }
        return;
      }
      if (!dock && (load > cap * 0.5 || delivering)) { s.task = { k: 'none' }; this.moveTo(s, this.formationSlot(s, g, vadd(f.pos, { x: 0, y: 60, z: 0 }), 120), speed, dt); return; }
      if (dock && (load > cap * 0.5 || (load > 0 && !donor) || delivering)) {
        if ((s.task as any).why !== 'deliver') emit(this.st, { kind: 'logistics', reason: 'depart', amount: 1, company: s.owner, group: g.id, ship: s.id, ref: s.id });
        s.task = { k: 'goto', to: dock.pos, why: 'deliver' };
        if (this.goDock(s, dock, dt, speed)) { if (!this.unloadWhenReady(s, dock, op.sell)) { g.status = `${dock.name}: 화물 하역 중`; return; } this.undock(s); s.task = { k: 'none' }; }
        return;
      }
      this.moveTo(s, this.formationSlot(s, g, vadd(f.pos, { x: 0, y: 60, z: 0 }), 120), speed, dt);
      return;
    }
    if (ec.military) {
      // escorts orbit the field and intercept intruders
      const hostile = this.nearestHostile(f.pos, g.owner, f.radius + 1600, f.pos, f.radius + 2000);
      if (hostile) { this.moveTo(s, this.formationSlot(s, g, hostile, 50), speed, dt, 10); return; }
      const a = this.time * 0.07 + (g.shipIds.indexOf(s.id) * 0.8);
      this.moveTo(s, { x: f.pos.x + Math.cos(a) * (f.radius + 150), y: f.pos.y + 50, z: f.pos.z + Math.sin(a) * (f.radius + 150) }, speed * 0.5, dt);
      return;
    }
    this.moveTo(s, this.formationSlot(s, g, f.pos, 150), speed, dt);
  }

  /** the station this mining op unloads at right now, or null (and one warning) if it can't be used */
  private mineDock(g: WGroup, op: Extract<Op, { k: 'mine' }>): Station | null {
    let st: Station | undefined = this.st.stations[op.deliver];
    const berth = this.berthOfGroup(g);
    const cargo = this.deliveryCargo(g, op.field);
    let why = this.deliverProblem(st, g.owner, op.sell, berth) ?? this.intakeProblem(st, g.owner, op.sell, cargo);
    if (why && op.auto) {
      const alt = this.autoDeliver(g.owner, op.field, op.sell, berth, cargo);
      if (alt) { op.deliver = alt; st = this.st.stations[alt]; why = null; this.say(g, `자동 하역지 변경: ${st.name}.`, 'radio', 0.3); }
    }
    const warned = (g as any)._dockWarn as string | undefined;
    if (!why) { if (warned) { delete (g as any)._dockWarn; emit(this.st, { kind: 'logistics', reason: 'resumed', amount: 0, company: g.owner, group: g.id }); } return st!; }
    if (warned !== op.deliver + why) {
      (g as any)._dockWarn = op.deliver + why;
      emit(this.st, { kind: 'logistics', reason: `blocked:${why}`, amount: 0, company: g.owner, group: g.id, station: st?.id });
      const co = this.st.companies[g.owner];
      if (co?.kind === 'player') this.ev('warn', `${g.name}: ${st ? `하역지 ${st.name} 사용 불가 — ${why}` : '하역 정거장이 사라졌습니다'}. 화물은 판매하지 않고 보관 중입니다. 하역 목적지를 다시 지정하세요.`, { company: g.owner, who: g.name, pos: st?.pos });
    }
    return null;
  }

  /** ships that share this group's effective op: the group plus delegated children */
  private subtreeShipsInOp(g: WGroup, orderRoot = false): WShip[] {
    let root = g;
    while (!orderRoot && root.parentId && !root.override) root = this.st.groups[root.parentId];
    const out: WShip[] = [];
    const walk = (x: WGroup) => { out.push(...this.shipsOf(x)); for (const c of x.childIds) { const cg = this.st.groups[c]; if (cg && !cg.override) walk(cg); } };
    walk(root);
    return out;
  }

  private behaveHaul(s: WShip, g: WGroup, op: Extract<Op, { k: 'haul' }>, dt: number, speed: number) {
    if (growthOn(this.st) && op.route) { const route = this.st.logistics?.[op.route]; if (route) stepRouteShip(this, route, s, g, dt, speed); else g.status = '운송 노선 없음 — 화물 보존'; return; }
    const a = this.st.stations[op.from], b = this.st.stations[op.to];
    const ec = econOf(s);
    if (!a || !b) return;
    if (ec.cargo <= 0) {
      // warships escort the cargo ships of the operation
      const carriers = this.subtreeShipsInOp(g).filter(x => econOf(x).cargo > 0 && x.state === 'space');
      if (carriers.length) {
        const c = carriers[0].pos;
        const hostile = this.nearestHostile(c, g.owner, 1500, c, 1700);
        this.moveTo(s, this.formationSlot(s, g, hostile ?? c, 90), speed, dt, 20);
      } else this.goDock(s, a, dt, speed);
      return;
    }
    const label = op.res === '*auto' ? '자동 보급' : op.res === '*all' ? '전 품목' : RES_NAME[op.res];
    if (cargoSum(s.cargo) > 0.5) {
      if (growthOn(this.st) && this.intakeProblem(b, s.owner, false, s.cargo)) { emit(this.st, { kind: 'logistics', reason: 'blocked:목적지 창고 용량 부족', amount: 0, company: s.owner, group: g.id, station: b.id }); g.status = `${b.name}: 창고 가득 — 화물 보존·하역 대기 (재고 이동/증설 필요)`; return; }
      emit(this.st, { kind: 'logistics', reason: 'resumed', amount: 0, company: s.owner, group: g.id });
      g.status = `${b.name}로 ${label} 운송`;
      if (this.goDock(s, b, dt, speed)) {
        if (!this.unloadWhenReady(s, b, false)) { g.status = `${b.name}: 화물 하역 중`; return; }
        if (cargoSum(s.cargo) > 0.5) g.status = `${b.name} 창고 가득 — 하역 대기`; else this.undock(s);
      }
      return;
    }
    if (this.goDock(s, a, dt, speed)) {
      const store = this.storage(a, s.owner);
      const cap = ec.cargo * techFx(this.st.companies[s.owner]?.tech).cargoMul;
      const free = Math.max(0, cap - cargoSum(s.cargo));
      const pick = this.haulPick(op, a, b, store);
      const total = Math.min(free, pick.reduce((n, [, want]) => n + Math.floor(want), 0));
      const permit = this.cargoPermit(s, a, `haul:${g.id}:load`, total);
      if (permit === null) { g.status = `${a.name}: 화물 적재 중`; return; }
      let room = Math.min(free, permit);
      for (const [k, want] of pick) { const t = takec(store, k, Math.min(room, Math.floor(want))); addc(s.cargo, k, t); room -= t; if (room < 1) break; }
      if (Math.min(free, permit) - room > 0) { const loaded = Math.min(free, permit) - room; emit(this.st, { kind: 'logistics', reason: 'depart', amount: loaded, company: s.owner, group: g.id, ship: s.id, ref: s.id, station: a.id }); g.status = `${a.name}에서 적재 완료 (${Math.round(loaded)})`; this.undock(s); }
      else g.status = op.res === '*auto' ? `${b.name}에 부족한 원료가 ${a.name} 창고에 없음 — 대기` : `${a.name} 창고에 ${label} 없음 — 대기`;
    } else g.status = `${a.name}로 적재하러 이동`;
  }

  private behaveBuild(s: WShip, g: WGroup, stationId: string, dt: number, speed: number, c: CommanderDef) {
    const st = this.st.stations[stationId];
    if (!st || growthOn(this.st) && st.owner !== s.owner) { if (growthOn(this.st)) g.status = '건설 현장을 이용할 수 없음 — 화물 보존'; return; }
    if (s.classId !== 'constructor') {
      if (growthOn(this.st) && cargoSum(s.cargo) > 0) {
        if (!this.goConstruction(s, st, dt, speed)) { g.status = `${st.name} 건설 현장으로 자재 운송`; return; }
        const desired = cargoKeys(s.cargo).reduce((n, r) => n + Math.min(qty(s.cargo, r), constructionRoom(st, r, true), this.intakeRoom(st, s.owner, r, true)), 0);
        const permit = this.cargoPermit(s, st, `build:${st.id}`, desired);
        if (permit === null) { g.status = `${st.name}: 건설 자재 반입 중`; return; }
        let remaining = permit;
        let moved = 0;
        for (const r of cargoKeys(s.cargo)) {
          const n = takec(s.cargo, r, Math.min(remaining, constructionRoom(st, r, true), this.intakeRoom(st, s.owner, r, true)));
          if (n > 0) { remaining -= n; addc(this.storage(st, s.owner), r, n); moved += n; withdrawRouteCargo(this, s.owner, s.id, r, n); emit(this.st, { kind: 'logistics', reason: 'unload', amount: n, company: s.owner, group: g.id, ship: s.id, station: st.id, item: r }); }
        }
        if (moved) this.stationWorks(st, 0);
        g.status = moved ? `${st.name}: 건설 자재 ${Math.round(moved)} 반입` : `${st.name}: 필요한 자재 없음 — 남은 화물 보존`;
      } else if (this.canDock(st, s.owner)) this.goDock(s, st, dt, speed); else this.moveTo(s, this.formationSlot(s, g, st.pos, 250), speed, dt);
      return;
    }
    const store = this.storage(st, s.owner);
    const waiting = plans(st);
    const active = activePlan(st);
    const orbitA = this.time * 0.15 + hashId(s.id);
    if (!waiting.length) {
      g.status = `${st.name}: 건설 계획 없음`;
      if (this.canDock(st, s.owner)) this.goDock(s, st, dt, speed);
      return;
    }
    const spot = vadd(st.pos, { x: Math.cos(orbitA) * 210, y: 40, z: Math.sin(orbitA) * 210 });
    if (!this.moveTo(s, spot, speed, dt, 90)) { g.status = `${st.name}로 이동 중 (건설)`; return; }
    // the constructor unloads what it carries into the station's storage; plans take it from there
    const buildRoom = (r: string) => Math.max(this.intakeRoom(st, s.owner, r), this.intakeRoom(st, s.owner, r, true));
    const desired = cargoKeys(s.cargo).reduce((n, r) => n + Math.min(qty(s.cargo, r), buildRoom(r)), 0);
    const permit = this.cargoPermit(s, st, `builder:${st.id}`, desired);
    if (permit === null) { g.status = `${st.name}: 건설 자재 반입 중`; return; }
    let remaining = permit;
    let unloaded = false;
    for (const r of cargoKeys(s.cargo)) {
      const n = takec(s.cargo, r, Math.min(remaining, buildRoom(r)));
      if (n > 0) {
        remaining -= n; addc(store, r, n); unloaded = true;
        if (growthOn(this.st)) { withdrawRouteCargo(this, s.owner, s.id, r, n); emit(this.st, { kind: 'logistics', reason: 'unload', amount: n, company: s.owner, group: g.id, ship: s.id, station: st.id, item: r }); }
      }
    }
    if (unloaded) this.stationWorks(st, 0);
    if (active) {
      const md = MODULES[active.kind];
      this.workOn(st, active, dt / moduleWork(active) * (0.8 + c.skill * 0.5) * techFx(this.st.companies[s.owner]?.tech).constructMul * (growthOn(this.st) ? econOf(s).build * wearMul(s) : 1), g);
      s.fx = { welding: `${st.id}:${active.slot}` };
      g.status = active.built ? `${md.name} 완공` : `${md.name} 건설 ${Math.round(active.progress * 100)}%`;
      return;
    }
    // nothing buildable: say exactly what is missing (alloy and crystal reported separately)
    const first = waiting.find(m => !m.paused && prereqBuilt(st, m)) ?? waiting[0];
    const md = MODULES[first.kind];
    if (first.paused) { g.status = `${md.name} — 일시 정지됨`; return; }
    if (!isSecured(first)) {
      const short = planMats(first).filter(r => missing(first, r) > 1e-6).map(r => `${RES_NAME[r] ?? r} ${Math.ceil(missing(first, r))} 부족`);
      g.status = `${md.name} — 자재 대기 (${short.join(', ')})`;
      this.say(g, `${md.name} 자재 대기 중: ${short.join(', ')}. ${st.name} 창고로 운송하거나 하역해 주십시오.`, 'warn', 90);
    } else g.status = `${md.name} — 선행 시설 대기`;
  }

  private foundStation(g: WGroup, s: WShip, op: Extract<Op, { k: 'found' }>, paid = 0) {
    const co = this.st.companies[g.owner];
    if (this.st.factions) {
      const rule = foundingRule(this.st, this.sysOf(op.at), g.owner);
      const fee = rule.ok ? Math.round(rule.feeShare * STATION_SIZES[op.size ?? 'S'].credits) : 0;
      if (fee > 0) {
        if (co.credits < fee) {
          // keep the order and the prepayment; the licence is paid on arrival
          if (paid) (co.foundingEscrow ??= {})[g.id] = paid;
          g.status = `설립 허가료 ${fee.toLocaleString()} cr 부족 — 대기`; return;
        }
        watchMoney(this.st, 'territory_licence', { company: g.owner, system: this.sysOf(op.at)?.id }, () => { co.credits -= fee; });
        this.ev('info', `${FACTIONS[(rule as any).faction]?.name ?? '세력'} 정거장 설립 허가료 ${fee.toLocaleString()} cr 납부`, { company: g.owner, pos: op.at });
      }
    }
    const id = this.id('st');
    const station: Station = {
      id, name: op.name.slice(0, 18) || `${co.name} 기지`, owner: g.owner, public: false, ...(op.size ? { size: op.size } : {}), style: 3, pos: { ...op.at, y: 0 }, radius: 180,
      market: null, services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false },
      storage: {}, modules: [normPlan({ kind: 'core', progress: 0, built: false, slot: 0, paid, ...(op.size ? { materials: { ...foundingMaterials(op.size, paid, op.foundationMats) }, work: STATION_SIZES[op.size].work } : {}) }, () => this.id('pl'))], defenseHp: 1, founded: this.time,
      desc: `${co.name}의 자체 정거장.`,
    };
    for (const cid of Object.keys(this.st.companies)) station.storage[cid] = emptyCargo();
    this.st.stations[id] = station;
    const store = station.storage[g.owner];
    for (const r of cargoKeys(s.cargo)) {
      const n = takec(s.cargo, r, this.intakeRoom(station, g.owner, r));
      addc(store, r, n);
      if (n > 0 && growthOn(this.st)) { withdrawRouteCargo(this, g.owner, s.id, r, n); emit(this.st, { kind: 'logistics', reason: 'unload', amount: n, company: g.owner, group: g.id, ship: s.id, station: id, item: r }); }
    }
    g.op = { k: 'build', station: id }; g.override = true;
    this.ev('world', `${co.name}이(가) 새 정거장 "${station.name}" 건설에 착수했다.`, { pos: station.pos, ref: id });
    this.say(g, '부지 도착. 골조 조립을 시작합니다.', 'radio', 0);
  }

  // -------------------------------------------------- unloading / trade

  private unloadStored(s: WShip, st: Station, limit = Infinity): number {
    let moved = 0, remaining = limit;
    for (const item of cargoKeys(s.cargo)) {
      const n = takec(s.cargo, item, Math.min(remaining, this.intakeRoom(st, s.owner, item)));
      if (n > 0) { addc(this.storage(st, s.owner), item, n); moved += n; remaining -= n; withdrawRouteCargo(this, s.owner, s.id, item, n); emit(this.st, { kind: 'logistics', reason: 'unload', amount: n, company: s.owner, group: s.groupId, ship: s.id, station: st.id, item }); }
    }
    if (moved) this.ev('info', `${s.name}: ${moved.toLocaleString()}단위 자사 창고로 하역 (판매·계약 소비 없음)`, { company: s.owner, pos: st.pos });
    return moved;
  }

  private unloadWhenReady(s: WShip, st: Station, sell: boolean): boolean {
    if (stationCargoRate(st) === undefined) { this.unload(s, st, sell); return true; }
    const permit = this.cargoPermit(s, st, `unload:${sell ? 'sell' : 'store'}`, cargoSum(s.cargo));
    if (permit === null) return false;
    this.unload(s, st, sell, permit);
    return true;
  }

  private unload(s: WShip, st: Station, sell: boolean, limit = Infinity) {
    const co = this.st.companies[s.owner];
    if (!co) return;
    const loadBefore = cargoSum(s.cargo);
    const trackedBefore = growthOn(this.st) && co.kind === 'player' && Object.values(this.st.logistics ?? {}).some(r => r.owner === s.owner && !!r.manifests[s.id]) ? { ...s.cargo } : null;
    let msg = '';
    const epsilon = growthOn(this.st) ? 1e-9 : 0.01;
    // an own station only takes what fits in its warehouse; the rest stays aboard
    let room = st.owner === s.owner || (st.public && growthOn(this.st)) ? this.room(st, s.owner) : Infinity;
    let held = 0;
    for (const r of cargoKeys(s.cargo)) {
      let amt = Math.min(limit, qty(s.cargo, r)); limit -= amt;
      if (amt <= epsilon) continue;
      // Delivery contracts consume cargo directly; a full warehouse must not block them.
      if (growthOn(this.st)) for (const k of Object.values(this.st.contracts)) {
        if (k.done || k.takenBy !== s.owner || k.kind !== 'delivery' || k.stationId !== st.id || k.res !== r) continue;
        const use = Math.min(amt, Math.max(0, (k.amount ?? 0) - k.progress));
        if (use > 0) emit(this.st, { kind: 'consume', reason: 'contract_delivery', amount: use, company: s.owner, station: st.id, item: r });
        k.progress += use; amt -= takec(s.cargo, r, use);
        if (k.progress >= (k.amount ?? 0) - epsilon) this.completeContract(k);
      }
      const toStore = !(sell && st.market?.[r]) && co.kind === 'player';
      const itemRoom = growthOn(this.st) ? (takesSpace(r) ? Math.min(room, this.intakeRoom(st, s.owner, r)) : Infinity) : room;
      if (toStore && amt > itemRoom) { held += amt - Math.max(0, itemRoom); amt = Math.max(0, itemRoom); }
      takec(s.cargo, r, amt);
      if (toStore && (!growthOn(this.st) || takesSpace(r))) room -= amt;
      if (amt <= epsilon) continue;
      // contracts first
      for (const k of Object.values(this.st.contracts)) {
        if (k.done || k.takenBy !== s.owner || k.kind !== 'delivery' || k.stationId !== st.id || k.res !== r) continue;
        const use = Math.min(amt, (k.amount ?? 0) - k.progress);
        if (use > 0) emit(this.st, { kind: 'consume', reason: 'contract_delivery', amount: use, company: s.owner, station: st.id, item: r });
        k.progress += use; amt -= use;
        if (k.progress >= (k.amount ?? 0) - epsilon) this.completeContract(k);
      }
      if (amt <= epsilon) continue;
      if (co.kind !== 'player') { if (st.market?.[r]) st.market[r].stock += amt; continue; }
      if (sell && st.market?.[r]) {
        const v = watchMoney(this.st, 'market_sale', { company: s.owner, group: s.groupId, ship: s.id, station: st.id, item: r }, () => this.sellAt(st, s.owner, r, amt));
        msg += `${RES_NAME[r]} ${Math.round(v.sold)} → +${Math.round(v.value).toLocaleString()} cr `;
        // the station ran out of budget: the rest is kept in the company's storage there (never dumped)
        let left = amt - v.sold;
        if (left > epsilon && growthOn(this.st)) {
          // growth: only what fits in the warehouse is kept; the rest stays aboard
          const put = Math.max(0, Math.min(left, room)); room -= put;
          if (left - put > epsilon) { addc(s.cargo, r, left - put); held += left - put; }
          left = put;
        }
        if (left > epsilon) { addc(this.storage(st, s.owner), r, left); msg += `(구매 예산 소진 — ${Math.round(left)} 보관) `; }
      }
      else { addc(this.storage(st, s.owner), r, amt); msg += `${RES_NAME[r]} ${Math.round(amt)} 입고 `; }
    }
    if (trackedBefore) for (const [item, amount] of Object.entries(trackedBefore)) {
      const removed = Math.max(0, amount - qty(s.cargo, item));
      if (removed > 0) withdrawRouteCargo(this, s.owner, s.id, item, removed);
    }
    const unloaded = loadBefore - cargoSum(s.cargo);
    if (unloaded > 0) emit(this.st, { kind: 'logistics', reason: 'unload', amount: unloaded, company: s.owner, group: s.groupId, ship: s.id, station: st.id });
    if (held > 0.5) emit(this.st, { kind: 'logistics', reason: 'blocked:창고 용량 부족', amount: 0, company: s.owner, group: s.groupId });
    if (held > 0.5 && co.kind === 'player') this.ev('warn', st.public && growthOn(this.st)
      ? `${st.name} 공용 창고 한도 초과 — ${s.name}이(가) 화물 ${Math.round(held)}을(를) 싣고 있음. 구획을 임대하거나 재고를 팔거나, 자체 정거장으로 옮기세요.`
      : `${st.name} 창고 가득 — ${s.name}이(가) 화물 ${Math.round(held)}을(를) 하역하지 못함. 창고를 증설하거나 재고를 옮기세요.`, { company: s.owner, pos: st.pos, tag: 'storage_full' });
    if (msg && co.kind === 'player') {
      const g = this.st.groups[s.groupId];
      this.ev('money', `${s.name} @ ${st.name}: ${msg.trim()}`, { company: s.owner, pos: st.pos, who: g?.name, color: co.color });
    }
  }

  /** sell to the station's NPC market; returns credits paid and units sold (contentV ≥ 3: limited
   *  by the station's buying budget — what it cannot pay for is not sold) */
  sellAt(st: Station, company: string, r: Res, amt: number): { value: number; sold: number } {
    return watchMoney(this.st, 'market_sale', { company, station: st.id, item: r }, () => this.sellAtObserved(st, company, r, amt));
  }
  private sellAtObserved(st: Station, company: string, r: Res, amt: number): { value: number; sold: number } {
    // sell in chunks so large dumps walk the price down
    let total = 0, left = amt, sold = 0;
    const m = st.market![r];
    const tax = 1 - (st.tax ?? 0);
    const budget = growthOn(this.st) && st.public && st.funds !== undefined;
    while (left > 0.01) {
      let chunk = Math.min(left, 50);
      const p = this.price(st, r, 'sell');
      if (budget) { const can = p > 0 ? (st.funds ?? 0) / (p * tax) : 0; if (can < chunk) chunk = Math.max(0, Math.floor(can)); if (chunk <= 0) break; st.funds! -= chunk * p * tax; }
      total += chunk * p; m.stock += chunk; left -= chunk; sold += chunk;
    }
    total *= tax;
    const co = this.st.companies[company];
    co.credits += total; co.stats.earned += total;
    book(this, company, 'sales', total, r);
    const beforeDebt = co.credits; payFromSale(this.st, co, total);
    if (co.credits !== beforeDebt) book(this, company, 'upkeep', co.credits - beforeDebt);
    if (sold > 0 && !co.milestones.includes('first_sale')) this.milestone(co, 'first_sale');
    if (sold) emit(this.st, { kind: 'market', reason: 'sell', amount: sold, value: total, company, station: st.id, item: r });
    // P10: supplying a faction's market slowly improves standing with it (bounded per sale)
    if (sold && st.faction && this.st.factions) bumpStanding(this.st, company, st.faction, Math.min(2, total / 25000));
    return { value: total, sold };
  }

  private behaveTrade(s: WShip, g: WGroup, op: Extract<Op, { k: 'trade' }>, dt: number, speed: number) {
    let target = this.st.stations[op.route[op.leg % op.route.length]];
    // A removed market must not crash the world. Keep cargo and skip only unavailable NPC stops.
    for (let n = 0; n < op.route.length && !target?.market; n++) { op.leg = (op.leg + 1) % op.route.length; target = this.st.stations[op.route[op.leg]]; }
    if (!target?.market) { g.status = '교역 가능한 시장 없음 — 화물 보존'; return; }
    g.status = `${target.name}로 교역`;
    if (this.goDock(s, target, dt, speed * 0.8)) {
      const m = target.market!;
      for (const r of cargoKeys(s.cargo)) { const n = takec(s.cargo, r, s.cargo[r]); if (m[r]) m[r].stock += n; }
      // take the most abundant good that the next stop is short of (real arbitrage between regions)
      const next = this.st.stations[op.route[(op.leg + 1) % op.route.length]]?.market;
      let best: Res = 'alloy', bv = -Infinity;
      for (const r of Object.keys(m)) {
        if (r.startsWith('bp:')) continue;
        const here = m[r].stock / m[r].target, there = next?.[r] ? next[r].stock / next[r].target : 1;
        const v = here - there;
        if (v > bv) { bv = v; best = r; }
      }
      const unit = Math.max(1, ITEMS[best]?.price ?? 50);
      const amt = Math.min(250 * 30 / unit + 5, m[best].stock * 0.15);
      m[best].stock -= amt; addc(s.cargo, best, amt);
      op.leg = (op.leg + 1) % op.route.length;
      (s as any)._wait = 6;
    }
  }

  private behaveRaid(s: WShip, g: WGroup, op: Extract<Op, { k: 'raid' }>, dt: number, speed: number) {
    const home = this.st.lairs[op.home];
    const homePos = home?.pos ?? g.npc?.homePos ?? s.pos;
    const ships = this.shipsOf(g);
    const hpAvg = ships.reduce((a, x) => a + x.hp, 0) / ships.length;
    const bandSpeed = Math.min(speed, this.groupSpeed(g, true));
    if (hpAvg < 0.45 || (home && !home.alive)) {
      g.status = '은신처로 귀환';
      if (this.moveTo(s, this.formationSlot(s, g, homePos, 80), bandSpeed, dt, 30)) s.hp = Math.min(1, s.hp + 0.02 * dt);
      return;
    }
    // (re)choose target every few seconds, once per group
    if (g.shipIds[0] === s.id && (!(g as any)._nextPick || this.time >= (g as any)._nextPick)) {
      (g as any)._nextPick = this.time + 5;
      op.target = this.pickRaidTarget(g, homePos);
    }
    const t = op.target ? this.st.groups[op.target] : null;
    const tc = t ? this.groupCenter(t) : null;
    if (tc) {
      this.moveTo(s, this.formationSlot(s, g, tc, 40), bandSpeed, dt, 5);
      g.status = `${t!.name} 사냥 중`;
    } else {
      // prowl: lurk at a spot (a field, a lane, the lair) for a while, then move on
      const pr = (g as any)._prowl as { p: V; until: number } | undefined;
      if (g.shipIds[0] === s.id && (!pr || this.time > pr.until)) {
        const sys = this.sysOf(homePos);
        const spots = Object.values(this.st.fields).filter(x => !x.salvage && sys && this.sysOf(x.pos)?.id === sys.id && dist(x.pos, homePos) < sys.radius * 1.4 && this.secAt(x.pos) < 60).map(x => x.pos);
        spots.push(homePos);
        const pick = this.rng.pick(spots);
        (g as any)._prowl = { p: { x: pick.x + this.rng.range(-1500, 1500), y: pick.y, z: pick.z + this.rng.range(-1500, 1500) }, until: this.time + this.rng.range(120, 260) };
      }
      const pp = ((g as any)._prowl as { p: V } | undefined)?.p ?? homePos;
      const a = this.time * 0.05 + hashId(g.id);
      this.moveTo(s, this.formationSlot(s, g, { x: pp.x + Math.cos(a) * 600, y: pp.y, z: pp.z + Math.sin(a) * 600 }, 70), bandSpeed * 0.6, dt);
      g.status = '배회 중';
    }
  }

  private pickRaidTarget(g: WGroup, home: V): string | undefined {
    let best: string | undefined, bs = 0;
    const myVal = this.groupValue(g);
    const boldness = 52 + Math.min(22, myVal / 40);
    for (const o of Object.values(this.st.groups)) {
      const k = this.st.companies[o.owner]?.kind;
      if (!k || k === 'pirate' || o.cooldown > 0) continue;
      const c = this.groupCenter(o); if (!c) continue;
      const sh = this.shipsOf(o).filter(x => x.state === 'space');
      if (!sh.length) continue;
      if (this.sysOf(c) !== this.sysOf(home) || dist(c, home) > (this.sysOf(home)?.radius ?? 40000) * 1.5) continue;
      // pirates stay out of policed space; bigger bands push further in
      if (this.secAt(c) > boldness) continue;
      const civ = this.groupValue(o, false), mil = this.groupValue(o, true);
      if (mil > myVal * 1.3) continue;
      if (this.unionNear(c, 4500) > myVal * 0.8) continue;
      const score = (civ * 2 + 60) / (mil + 80) / (dist(c, this.groupCenter(g) ?? home) + 1200) * (k === 'guild' ? 0.35 : 1);
      if (score > bs) { bs = score; best = o.id; }
    }
    return best;
  }

  /** Union warship strength near a point */
  unionNear(p: V, r: number): number {
    let v = 0;
    for (const g of Object.values(this.st.groups)) {
      if (g.owner !== 'union' || !g.shipIds.length) continue;
      const c = this.groupCenter(g); if (c && Math.abs(c.x - p.x) < r && dist(c, p) < r) v += this.groupValue(g, true);
    }
    return v;
  }

  /** damaged Union forces fall back to their base for repairs; returns true while doing so */
  private unionRepair(s: WShip, g: WGroup, speed: number, dt: number): boolean {
    if (!g.npc) return false;
    const ships = this.shipsOf(g).filter(x => x.state !== 'battle');
    const hp = ships.reduce((a, x) => a + x.hp, 0) / Math.max(1, ships.length);
    const f = (g as any)._repair as boolean | undefined;
    if (!f && hp < 0.5) (g as any)._repair = true;
    if (f && hp > 0.92) (g as any)._repair = false;
    if (!(g as any)._repair) return false;
    const home = this.st.stations[g.npc.home]; if (!home) return false;
    this.moveTo(s, this.formationSlot(s, g, { x: home.pos.x + home.radius + 600, y: home.pos.y, z: home.pos.z }, 70), speed, dt, 40);
    g.status = '손상 — 기지 귀환 수리';
    return true;
  }

  /** response fleets go after bands inside government space, or ones attacking someone nearby */
  private pickResponse(g: WGroup, home: Station): string | undefined {
    const sys = this.sysOf(home.pos); if (!sys) return undefined;
    const reach = sys.security >= 90 ? sys.radius * 1.1 : sys.security >= 70 ? sys.radius * 0.85 : sys.radius * 0.5;
    const myVal = this.groupValue(g, true);
    let best: string | undefined, bs = 0;
    for (const p of Object.values(this.st.groups)) {
      if (p.owner !== 'pirates' || !p.shipIds.length || p.cooldown > 0) continue;
      const c = this.groupCenter(p); if (!c || this.sysOf(c)?.id !== sys.id) continue;
      if (dist(c, home.pos) > reach) continue;
      const pv = this.groupValue(p);
      // don't fling a small force at a war band; wait for the garrison and patrols
      if (pv > myVal * 1.6) continue;
      const lairNear = Object.values(this.st.lairs).some(l => l.alive && dist2(l.pos, c) < 6000);
      if (lairNear) continue;
      const score = (this.secAt(c) + 20) * (pv + 50) / (dist(c, home.pos) + 3000);
      if (score > bs) { bs = score; best = p.id; }
    }
    return best;
  }

  // ===================================================================== engagements

  private detectEngagements() {
    const st = this.st;
    const groups = Object.values(st.groups).filter(g => g.shipIds.length && g.cooldown <= 0);
    const kind = (g: WGroup) => st.companies[g.owner]?.kind;
    const pir = groups.filter(g => kind(g) === 'pirate');
    const others = groups.filter(g => kind(g) !== 'pirate');
    const used = new Set<string>();
    const tryEngage = (pos: V, lairId?: string) => {
      const A: WGroup[] = [], B: WGroup[] = [];
      for (const g of groups) {
        if (used.has(g.id)) continue;
        const ss = this.shipsOf(g).filter(s => s.state === 'space' && s.warp?.phase !== 'warp');
        if (!ss.length) continue;
        if (!ss.some(s => dist(s.pos, pos) < JOIN_R)) continue;
        (kind(g) === 'pirate' ? A : B).push(g);
      }
      const lair = lairId ? st.lairs[lairId] : Object.values(st.lairs).find(l => l.alive && dist(l.pos, pos) < JOIN_R);
      if (!B.length || (!A.length && !lair)) return;
      for (const g of [...A, ...B]) used.add(g.id);
      this.createEngagement(pos, A, B, lair ?? undefined);
    };
    for (const p of pir) {
      if (used.has(p.id)) continue;
      const pc = this.shipsOf(p).filter(s => s.state === 'space' && s.warp?.phase !== 'warp');
      if (!pc.length) continue;
      for (const o of others) {
        if (used.has(o.id)) continue;
        const os = this.shipsOf(o).filter(s => s.state === 'space' && s.warp?.phase !== 'warp');
        let hit: V | null = null;
        for (const a of pc) { for (const b of os) if (dist(a.pos, b.pos) < ENGAGE_R) { hit = vlerp(a.pos, b.pos, 0.5); break; } if (hit) break; }
        if (hit) { tryEngage(hit); break; }
      }
    }
    // lairs defend themselves
    for (const l of Object.values(st.lairs)) {
      if (!l.alive) continue;
      for (const o of others) {
        if (used.has(o.id)) continue;
        const os = this.shipsOf(o).filter(s => s.state === 'space' && s.warp?.phase !== 'warp');
        if (os.some(s => dist(s.pos, l.pos) < 800)) { tryEngage(l.pos, l.id); break; }
      }
    }
  }

  private toGroupSpec(g: WGroup, ships: WShip[], included: Set<string>, team: 0 | 1): GroupSpec[] {
    const c = this.cmdr(g);
    const cmd: CommanderDef = { ...c, team };
    const mil = ships.filter(s => s.groupId === g.id && econOf(s).military);
    const civ = ships.filter(s => s.groupId === g.id && !econOf(s).military);
    const spec = (s: WShip): ShipSpec => { const fit = this.fittingSpec(s); return { classId: s.classId, loadoutId: s.loadoutId, name: s.name, ref: s.id, hp: s.hp, ...(this.st.companies[s.owner]?.kind === 'player' ? { fx: this.shipFxOf(s) } : {}), ...(fit ? { fit } : {}) }; };
    const kids: GroupSpec[] = [];
    for (const cid of g.childIds) if (included.has(cid)) kids.push(...this.toGroupSpec(this.st.groups[cid], ships, included, team));
    const out: GroupSpec[] = [];
    if (mil.length || kids.length) out.push({ name: g.name, commander: cmd, ref: g.id, order: 'auto', retreatAt: 0, ships: mil.map(spec), children: kids });
    if (civ.length) out.push({ name: `${g.name} (비전투)`, commander: cmd, ref: g.id + '#civ', order: 'retreat', retreatAt: 0, ships: civ.map(spec), children: [] });
    return out;
  }

  private sideFleet(groups: WGroup[], ships: WShip[], team: 0 | 1, extra: GroupSpec[], title: string): FleetSpec {
    const ids = new Set(groups.map(g => g.id));
    const tops = groups.filter(g => !g.parentId || !ids.has(g.parentId));
    const children: GroupSpec[] = [...extra];
    for (const t of tops) children.push(...this.toGroupSpec(t, ships, ids, team));
    // the most capable commander present takes overall command
    const best = groups.map(g => this.cmdr(g)).sort((a, b) => b.skill - a.skill)[0] ?? { ...ACTING_CAPTAIN };
    return { name: title, root: { name: title, commander: { ...best, team }, ref: 'root', order: 'engage', retreatAt: 0, ships: [], children } };
  }

  createEngagement(pos: V, pirates: WGroup[], others: WGroup[], lair?: { id: string; name: string; hp: number; pos: V }) {
    const st = this.st;
    const all = [...pirates, ...others];
    const ships: WShip[] = [];
    for (const g of all) for (const s of this.shipsOf(g)) if (s.state === 'space' && s.warp?.phase !== 'warp') ships.push(s);
    const extraA: GroupSpec[] = [];
    if (lair) {
      extraA.push({ name: lair.name, commander: { ...ACTING_CAPTAIN, name: '은신처 수비대장', team: 1, aggression: 0.8 }, ref: 'lair:' + lair.id, order: 'hold', retreatAt: 0, ships: [{ classId: 'platform', loadoutId: 'std', name: lair.name, ref: 'lair:' + lair.id, hp: lair.hp }], children: [] });
    }
    // own stations with defense batteries join nearby fights
    const extraB: GroupSpec[] = [];
    let stationId: string | undefined;
    for (const s of Object.values(st.stations)) {
      if (s.public || dist(s.pos, pos) > JOIN_R) continue;
      const n = stationSupportOnline(s) ? s.modules.filter(m => m.kind === 'defense' && m.built).length : 0;
      if (!n) continue;
      stationId = s.id;
      extraB.push({ name: `${s.name} 방어 포대`, commander: { ...ACTING_CAPTAIN, name: '포대장', team: 0 }, ref: 'station:' + s.id, order: 'hold', retreatAt: 0,
        ships: Array.from({ length: n }, (_, i) => ({ classId: 'platform', loadoutId: 'std', name: `${s.name} 포대 ${i + 1}`, ref: `station:${s.id}`, hp: s.defenseHp })), children: [] });
    }
    const sideB = [...new Set(others.map(g => g.owner))];
    const sideA = [...new Set(pirates.map(g => g.owner))];
    if (lair && !sideA.includes('pirates')) sideA.push('pirates');
    const live = sideB.some(c => st.companies[c]?.kind === 'player');
    const titleB = sideB.filter(c => st.companies[c]?.kind === 'player').map(c => st.companies[c].name).join(' · ') || sideB.map(c => st.companies[c]?.name ?? c).join(' · ') || '연합 경비대';
    const sys = this.sysOf(pos);
    const setup = {
      seed: this.rng.int(2 ** 31), scenarioId: lair ? 'bastion' : (sys?.security ?? 50) < 40 ? 'wolfpack' : 'kestrel', spawnZ: 720,
      fleets: [this.sideFleet(others, ships, 0, extraB, titleB), this.sideFleet(pirates, ships, 1, extraA, '해적')] as [FleetSpec, FleetSpec],
    };
    const e: Engagement = {
      id: this.id('e'), pos: { ...pos }, start: st.time, setup, orders: [], tick: 0, sides: [sideB, sideA], groupRefs: all.map(g => g.id),
      live, done: false, lairId: lair?.id, stationId, n: ships.length + (lair ? 1 : 0), sys: sys?.id,
      names: [titleB, lair ? `해적 · ${lair.name}` : '해적'],
    };
    st.engagements[e.id] = e;
    for (const s of ships) { s.state = 'battle'; s.engagement = e.id; s.vel = { x: 0, y: 0, z: 0 }; s.warp = undefined; }
    const desc = `${pirates.length ? pirates.map(g => g.name).join(', ') : ''}${lair ? (pirates.length ? ' + ' : '') + lair.name : ''}`;
    for (const c of sideB) if (st.companies[c]?.kind === 'player') this.ev('battle', `교전 발생! ${desc}와(과) 전투 중`, { company: c, pos, ref: e.id });
    // every battle runs the real tactical engine in real time (≈3 ms of CPU per battle-second);
    // only if an absurd number of NPC ships are fighting at once does the strength model take over
    const npcShips = [...this.battles.keys()].map(id => st.engagements[id]).filter(x => x && !x.live).reduce((a, x) => a + (x.n ?? 0), 0);
    if (live || npcShips + (e.n ?? 0) <= NPC_BATTLE_CAP) { const w = new World(setup); this.battles.set(e.id, w); this.battleAcc.set(e.id, 0); this.mirrorBattle(e, w); }
    else e.autoEnd = st.time + Math.min(90, 20 + ships.length * 2.5);
    if (!live && (e.n ?? 0) >= 4 && sys) this.ev('world', `${sys.name}: ${e.names![0]} ↔ ${e.names![1]} 교전 발생 (${e.n}척)${e.autoEnd === undefined ? ' — 클릭하여 관전' : ''}`, { pos, ref: e.id });
    return e;
  }

  /** a player's order inside a live battle: validated and stamped a few ticks ahead */
  battleOrder(company: string, engId: string, groupId: number, order: Order | null, opts: { retreatAt?: number; release?: boolean }): string | null {
    const e = this.st.engagements[engId]; const w = this.battles.get(engId);
    if (!e || !w || e.done) return '전투 없음';
    const tg = w.groupById.get(groupId); if (!tg) return '부대 없음';
    if (!this.tacticalOwner(tg.ref).includes(company)) return '지휘 권한 없음';
    const rec: OrderRecord = { tick: w.tick + 4, groupId, order, retreatAt: opts.retreatAt, release: opts.release };
    w.scheduleOrder(rec);
    e.orders.push(rec);
    this.onBattleOrder?.(engId, rec);
    return null;
  }

  /** companies allowed to command a tactical group */
  tacticalOwner(ref: string | undefined): string[] {
    if (!ref) return [];
    if (ref === 'root') return [];
    if (ref.startsWith('station:')) { const s = this.st.stations[ref.slice(8)]; return s ? [s.owner] : []; }
    if (ref.startsWith('lair:')) return [];
    const g = this.st.groups[ref.replace('#civ', '')];
    return g ? [g.owner] : [];
  }

  private resultFromWorld(w: World): BattleResult {
    const groupKills = new Map<string, number>();
    for (const tg of w.groups) if (tg.ref) groupKills.set(tg.ref.replace('#civ', ''), (groupKills.get(tg.ref.replace('#civ', '')) ?? 0) + tg.stats.killValue);
    const ships: BattleResult['ships'] = [];
    for (const ts of w.ships) if (ts.ref) ships.push({ ref: ts.ref, dead: ts.state === 'dead' || ts.state === 'dying', hp: ts.hp / ts.maxHp, escaped: ts.state === 'escaped', dmg: ts.stats.dmgDealt });
    return { winner: w.outcome?.winner ?? -1, ships, groupKills };
  }

  private resolveAuto() {
    for (const e of Object.values(this.st.engagements)) if (!e.done && e.autoEnd !== undefined && this.time >= e.autoEnd) this.finishEngagement(e, this.quickResolve(e), false);
  }

  /** strength-model resolution for NPC-only fights (Lanchester square law with noise) */
  private quickResolve(e: Engagement): BattleResult {
    const st = this.st, r = this.rng;
    type U = { ref: string; side: number; val: number; hp: number; group?: string };
    const units: U[] = [];
    for (const s of Object.values(st.ships)) {
      if (s.engagement !== e.id) continue;
      const g = st.groups[s.groupId];
      const skill = g ? this.cmdr(g).skill : 0.3;
      const mil = econOf(s).military;
      units.push({ ref: s.id, side: e.sides[0].includes(s.owner) ? 0 : 1, val: shipValue(s.classId) * (mil ? 1 : 0.12) * (0.35 + 0.65 * s.hp) * (0.85 + skill * 0.3), hp: s.hp, group: s.groupId });
    }
    if (e.lairId) { const l = st.lairs[e.lairId]; if (l) units.push({ ref: 'lair:' + l.id, side: 1, val: 300 * (0.4 + 0.6 * l.hp), hp: l.hp }); }
    if (e.stationId) { const x = st.stations[e.stationId]; const n = x && stationSupportOnline(x) ? x.modules.filter(m => m.kind === 'defense' && m.built).length : 0; for (let i = 0; i < n; i++) units.push({ ref: 'station:' + x!.id, side: 0, val: 300 * x!.defenseHp, hp: x!.defenseHp }); }
    const S = [0, 1].map(k => units.filter(u => u.side === k).reduce((a, u) => a + u.val, 0) * r.range(0.82, 1.18));
    const winner = S[0] === 0 && S[1] === 0 ? -1 : S[0] >= S[1] ? 0 : 1;
    const W = Math.max(S[0], S[1]), L = Math.min(S[0], S[1]);
    const rem = Math.sqrt(Math.max(0, 1 - (L / Math.max(1, W)) ** 2));
    const dmgW = Math.max(0.04, Math.min(0.85, 1 - rem));
    const out: BattleResult = { winner, ships: [], groupKills: new Map() };
    for (const u of units) {
      if (u.side === winner) {
        const hp = u.hp - dmgW * r.range(0.4, 1.6);
        out.ships.push({ ref: u.ref, dead: hp < 0.08 && !u.ref.startsWith('station:'), hp: Math.max(0.08, hp), escaped: false, dmg: u.val });
        if (u.group) out.groupKills.set(u.group, (out.groupKills.get(u.group) ?? 0) + L / Math.max(1, units.filter(x => x.side === winner).length));
      } else {
        const crushing = 1 - L / Math.max(1, W);
        const dead = u.ref.startsWith('lair:') ? W > L * 1.6 : u.ref.startsWith('station:') ? false : r.chance(0.5 + 0.45 * crushing);
        out.ships.push({ ref: u.ref, dead, hp: u.ref.startsWith('lair:') ? Math.max(0.05, u.hp - 0.4) : Math.max(0.08, u.hp * r.range(0.2, 0.6)), escaped: !dead, dmg: 0 });
      }
    }
    return out;
  }

  private finishEngagement(e: Engagement, res: BattleResult, tactical = false) { return watchMoney(this.st, 'battle_reward', { system: e.sys, ref: e.id }, () => this.finishEngagementObserved(e, res, tactical)); }

  private finishEngagementObserved(e: Engagement, res: BattleResult, tactical: boolean) {
    const st = this.st;
    if (e.done) return;
    e.done = true; e.winner = res.winner;
    emit(st, { kind: 'combat.engagement', amount: 1, system: e.sys, reason: tactical ? 'tactical' : 'strength_model' });
    for (const r of res.ships) {
      const ship = st.ships[r.ref]; if (!ship) continue;
      const meta = { company: ship.owner, group: ship.groupId, ship: ship.id, item: ship.classId, system: e.sys, reason: tactical ? 'tactical' : 'strength_model' };
      emit(st, { ...meta, kind: 'combat.participation', amount: 1 });
      if (r.dead) { emit(st, { ...meta, kind: 'combat.loss', amount: 1 }); for (const [item, amount] of Object.entries(ship.cargo)) if (amount > 0) emit(st, { ...meta, kind: 'consume', reason: 'combat_cargo_loss', item, amount }); }
      if (e.sides[res.winner]?.includes(ship.owner)) emit(st, { ...meta, kind: 'combat.win', amount: 1 });
      emit(st, { ...meta, kind: 'combat.damage', amount: r.dmg });
    }
    const sideOf = (ref: string) => ref.startsWith('lair:') ? 1 : ref.startsWith('station:') ? 0 : (st.ships[ref] && e.sides[0].includes(st.ships[ref].owner) ? 0 : 1);
    const losses: [number, number] = [0, 0];
    for (const ts of res.ships) if (ts.dead && !ts.ref.startsWith('station:')) losses[sideOf(ts.ref)]++;
    const sys = this.sysOf(e.pos);
    const destroyedPirateValue = new Map<string, number>();
    const wrecks: Record<string, number>[] = [];
    const wreckCls: string[] = [];
    const dmgBy = new Map<string, number>();
    const lostBy = new Map<string, number>();
    let salvage = 0;
    const killsByGroup = res.groupKills;
    for (const ts of res.ships) {
      const owner = ts.ref.startsWith('lair:') ? 'pirates' : ts.ref.startsWith('station:') ? st.stations[ts.ref.slice(8)]?.owner : st.ships[ts.ref]?.owner;
      if (owner) dmgBy.set(owner, (dmgBy.get(owner) ?? 0) + ts.dmg);
      const dead = ts.dead;
      if (ts.ref.startsWith('lair:')) {
        const l = st.lairs[ts.ref.slice(5)];
        if (l) { l.hp = dead ? 0 : Math.max(0.05, ts.hp); if (dead) this.destroyLair(l, e); }
        continue;
      }
      if (ts.ref.startsWith('station:')) {
        const s = st.stations[ts.ref.slice(8)];
        if (s) s.defenseHp = dead ? 0.15 : Math.max(0.1, ts.hp);
        continue;
      }
      const s = st.ships[ts.ref];
      if (!s) continue;
      if (dead && isExclusiveShip(s)) {
        // BB-EX is never deleted and leaves no wreck, salvage or blueprint: the same hull recovers
        lostBy.set(s.owner, (lostBy.get(s.owner) ?? 0) + 1);
        const co = st.companies[s.owner]; if (co) co.stats.lost++;
        exclusiveLost(this, s);
        continue;
      }
      if (dead) {
        salvage += shipValue(s.classId) * 2.2;
        if (sys) {
          if (s.owner === 'pirates') { sys.stats.pirateKills++; sys.heat = Math.max(0, sys.heat - 3); bump(sys, { pirates: -0.6, union: 0.2 }); }
          else if (s.owner === 'union') { sys.stats.unionLosses++; sys.heat = Math.min(100, sys.heat + 3); }
          else { sys.stats.civLosses++; sys.heat = Math.min(100, sys.heat + 4); }
        }
        if (s.owner === 'pirates') { destroyedPirateValue.set(ts.ref, shipValue(s.classId)); wrecks.push(loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts)); wreckCls.push(s.classId); }
        lostBy.set(s.owner, (lostBy.get(s.owner) ?? 0) + 1);
        const co = st.companies[s.owner]; if (co) co.stats.lost++;
        const g = st.groups[s.groupId];
        if (g) g.shipIds = g.shipIds.filter(x => x !== s.id);
        delete st.ships[s.id];
      } else {
        s.hp = Math.max(0.05, ts.hp);
        s.state = 'space'; s.engagement = undefined; s.task = { k: 'none' };
        if (tactical) {
          // they are already where the tactical battle left them (mirrored live); keep escapees nearby
          const dx = s.pos.x - e.pos.x, dz = s.pos.z - e.pos.z, d = Math.hypot(dx, dz);
          if (d > 2500) { s.pos = { x: e.pos.x + dx / d * 2500, y: e.pos.y, z: e.pos.z + dz / d * 2500 }; }
          s.vel = { x: 0, y: 0, z: 0 };
        } else {
          // strength-model fights: survivors drift out of the battle zone; escapees end up further away
          const off = ts.escaped ? 520 : 140;
          const ang = this.rng.range(0, Math.PI * 2);
          s.pos = { x: e.pos.x + Math.cos(ang) * off * this.rng.range(0.4, 1), y: e.pos.y + this.rng.range(-30, 30), z: e.pos.z + Math.sin(ang) * off * this.rng.range(0.4, 1) };
        }
      }
    }
    // groups: cooldown, commander experience & injuries
    for (const gid of e.groupRefs) {
      const g = st.groups[gid]; if (!g) continue;
      g.cooldown = 25; g.fleeing = false;
      if (g.owner === 'pirates' && g.op.k === 'raid') { g.op.target = undefined; (g as any)._nextPick = this.time + 40; }
      const cm = g.commanderId ? st.commanders[g.commanderId] : null;
      if (cm && cm.injuredUntil <= this.time) {
        cm.battles++;
        const gain = (12 + (killsByGroup.get(gid) ?? 0) / 12) * (cm.owner ? techFx(st.companies[cm.owner]?.tech).skillGain : 1);
        cm.xp += gain;
        if (cm.xp >= cm.level * 100) {
          cm.xp -= cm.level * 100; cm.level++;
          cm.skill = Math.min(0.95, cm.skill + 0.03);
          if (cm.owner && st.companies[cm.owner]?.kind === 'player') this.ev('milestone', `${cm.rank} ${cm.name} 숙련도 상승 → Lv.${cm.level} (판단력 ${Math.round(cm.skill * 100)})`, { company: cm.owner, who: cm.name, color: cm.color });
        }
        if (!g.shipIds.length) { cm.injuredUntil = this.time + 240; if (cm.owner) this.ev('warn', `${cm.name}의 함대가 전멸했다. 탈출 포드로 귀환, 4분간 부상.`, { company: cm.owner }); }
      }
      if (g.owner === 'union' && g.npc) {
        // lost hulls are replaced from the home yard; a wiped-out force is rebuilt after a delay
        const sysG = st.systems[g.npc.sys];
        if (sysG) g.npc.nextRefit = Math.max(g.npc.nextRefit, this.time + (g.shipIds.length ? this.refitTime(sysG) : this.respawnTime(sysG)));
        continue;
      }
      if (!g.shipIds.length && st.companies[g.owner]?.kind !== 'player') {
        if (g.commanderId) delete st.commanders[g.commanderId];
        delete st.groups[g.id];
      }
    }
    // bounties & reputation by damage share
    const players = e.sides[0].filter(c => st.companies[c]?.kind === 'player');
    const totalDmg = players.reduce((a, c) => a + (dmgBy.get(c) ?? 0), 0);
    let bounty = 0;
    for (const v of destroyedPirateValue.values()) bounty += v * 22;
    if (e.lairId && !st.lairs[e.lairId]?.alive) bounty += 6000;
    const won = e.winner === 0;
    for (const c of players) {
      const co = st.companies[c];
      const share = totalDmg > 0 ? (dmgBy.get(c) ?? 0) / totalDmg : 1 / players.length;
      const pay = Math.round(bounty * share);
      if (pay > 0) { co.credits += pay; co.stats.earned += pay; }
      const standing = Math.round(destroyedPirateValue.size * share); co.rep += standing;
      if (standing) emit(st, { kind: 'reputation', reason: 'pirate_bounty', amount: standing, company: co.id, system: e.sys });
      // P10: the faction holding the system values pirate hunting; the pirates remember it
      if (standing && st.factions) { const fsys = st.systems[e.sys ?? '']?.faction; if (fsys && fsys !== 'pirates') bumpStanding(st, co.id, fsys, standing * .5); bumpStanding(st, co.id, 'pirates', -standing); }
      co.stats.kills += Math.round(destroyedPirateValue.size * share);
      if (won) { co.stats.battlesWon++; if (!co.milestones.includes('first_victory')) this.milestone(co, 'first_victory'); }
      const lost = lostBy.get(c) ?? 0;
      e.summary = `${won ? '승리' : e.winner === 1 ? '패배' : '교착'} — 해적 ${destroyedPirateValue.size}척 격침, 아군 손실 ${lost}척${pay ? `, 현상금 +${pay.toLocaleString()} cr` : ''}`;
      this.ev('battle', `전투 종료: ${e.summary}`, { company: c, pos: e.pos, ref: e.id });
      if (co.tech?.includes('salvage_ops') && wrecks.length) this.salvageWrecks(co, wrecks, share, e.pos, wreckCls);
    }
    // contracts: bounties on bands wiped out
    for (const k of Object.values(st.contracts)) {
      if (k.done || k.kind !== 'bounty' || !k.target) continue;
      const g = st.groups[k.target];
      if (g && g.shipIds.length) continue;
      if (k.takenBy && players.includes(k.takenBy) && (dmgBy.get(k.takenBy) ?? 0) > 0) this.completeContract(k);
      else { k.done = true; if (k.takenBy) this.ev('info', `계약 "${k.title}" 대상이 다른 세력에 의해 소멸했다.`, { company: k.takenBy }); }
    }
    // wreckage becomes a salvage field (alloy)
    if (salvage > 300) {
      const f: Field = { id: this.id('wreck'), name: '전투 잔해', pos: { ...e.pos }, radius: 220, res: 'alloy', mix: { ...SALVAGE_MIX }, amount: Math.round(salvage), max: Math.round(salvage), regen: 0, rocks: Math.min(40, 8 + Math.round(salvage / 150)), salvage: true, expires: this.time + 1500, danger: 1 };
      st.fields[f.id] = f;
    }
    if (!players.length && sys) {
      const nPir = res.ships.filter(x => st.ships[x.ref]?.owner === 'pirates' || destroyedPirateValue.has(x.ref)).length;
      if (e.sides[0].includes('union')) {
        if (!won) this.ev('world', `${sys.name}: 연합군이 해적에게 밀려났다! 주변 항로가 위험해진다.`, { pos: e.pos });
        else if (destroyedPirateValue.size >= 3 || e.lairId) this.ev('world', `${sys.name}: 연합군이 해적 ${destroyedPirateValue.size}척을 격침했다.`, { pos: e.pos });
      } else if (!won) { sys.stats.raids++; bump(sys, { pirates: 3, guild: -3 }); this.ev('world', `${sys.name}: 길드 상선이 해적에게 약탈당했다.`, { pos: e.pos }); }
      void nPir;
    }
    // a record anyone can replay: the setup (with its seed) and the orders reproduce it exactly
    const names = e.names ?? ['아군', '해적'];
    if (!e.summary) e.summary = `${e.winner === 0 ? names[0] + ' 승리' : e.winner === 1 ? names[1] + ' 승리' : '교착'} — 손실 ${names[0]} ${losses[0]}척 · ${names[1]} ${losses[1]}척`;
    if (tactical) {
      const log = (st.battleLog ??= []);
      log.push({ id: e.id, sys: e.sys, pos: { ...e.pos }, start: e.start, end: this.time, names, winner: e.winner ?? -1, summary: e.summary, n: e.n ?? 0, losses, setup: e.setup, orders: e.orders });
      if (log.length > 30) log.splice(0, log.length - 30);
    }
    this.onBattleEnd?.(e);
  }

  private destroyLair(l: import('./types').Lair, e: Engagement) {
    l.alive = false; l.respawnAt = this.time + ((l.tier ?? 2) >= 4 ? 3000 : 2000);
    const lsys = this.sysOf(l.pos); if (lsys) lsys.heat = Math.max(0, lsys.heat - 40);
    // the region changes hands: pirates lose their foothold, the Union and the merchants move in
    if (lsys) {
      ensureInfluence(this.st, lsys, this.time);
      bump(lsys, { pirates: -25 - (l.tier ?? 2) * 3, union: 8, guild: 8 });
      lsys.recoverUntil = this.time + RECOVERY_TIME;
      l.respawnAt = this.time + ((l.tier ?? 2) >= 4 ? 3000 : 2000) * (1 + (lsys.inf?.union ?? 50) / 100);
      this.reconstructionContracts(lsys);
    }
    const who = e.sides[0].filter(c => this.st.companies[c]?.kind === 'player').map(c => this.st.companies[c].name).join(', ') || '연합군';
    this.ev('world', `${l.name}이(가) ${who}에 의해 파괴되었다! 주변 항로의 해적 위협이 사라진다.`, { pos: l.pos, ref: l.id });
    for (const f of Object.values(this.st.fields)) if (dist(f.pos, l.pos) < 9000) f.danger = Math.max(1, f.danger - 1);
    for (const c of e.sides[0]) {
      const co = this.st.companies[c];
      if (co?.kind === 'player') { co.rep += 15; emit(this.st, { kind: 'reputation', reason: 'lair_destroyed', amount: 15, company: co.id, system: e.sys }); if (!co.milestones.includes('lair')) this.milestone(co, 'lair'); }
    }
    for (const k of Object.values(this.st.contracts)) if (!k.done && k.kind === 'lair' && k.target === l.id) {
      if (k.takenBy && e.sides[0].includes(k.takenBy)) this.completeContract(k); else k.done = true;
    }
  }

  // ===================================================================== contracts & progression

  private offerContract(k: Omit<Contract, 'id' | 'progress' | 'expires' | 'takenBy' | 'done'>, life = 900) {
    const id = this.id('k');
    this.st.contracts[id] = { ...k, id, progress: 0, expires: this.time + life, takenBy: null, done: false };
    return id;
  }

  /** a liberated system needs building materials: its stations post well-paid, long-lived delivery contracts */
  private reconstructionContracts(sys: StarSystem) {
    const hosts = Object.values(this.st.stations).filter(s => s.public && s.market && this.sysOf(s.pos) === sys).slice(0, 2);
    const goods = ['structure', 'machinery', 'electronics', 'armor_plate', 'alloy', 'composite'];
    for (const h of hosts) for (let i = 0; i < 2; i++) {
      const res = this.rng.pick(goods);
      const amount = Math.max(5, Math.round(targetFor(res) * this.rng.range(0.08, 0.16) / 5) * 5);
      const base = h.market?.[res]?.base ?? itemPriceOf(res);
      this.offerContract({ stationId: h.id, kind: 'delivery', title: `재건 물자: ${RES_NAME[res]} ${amount}`, desc: `해적 거점이 무너진 ${sys.name}의 재건에 ${RES_NAME[res]} ${amount}단위가 필요하다. 시장가의 2.2배를 지급한다.`, reward: Math.round(amount * base * 2.2 / 50) * 50, rep: 4, res, amount }, RECOVERY_TIME);
    }
    if (hosts.length) this.ev('world', `${sys.name}: 해방 후 재건이 시작되었다 — 상인 길드가 진출하고 재건 물자 납품 계약이 게시되었다.`, { pos: hosts[0].pos });
  }

  private contracts() {
    const st = this.st;
    for (const k of Object.values(st.contracts)) {
      if (k.done) continue;
      if (this.time > k.expires) {
        k.done = true;
        if (k.takenBy) { const co = st.companies[k.takenBy]; const prev = co.rep; co.rep = Math.max(0, co.rep - 2); emit(st, { kind: 'reputation', amount: co.rep - prev, reason: 'contract_expired', company: co.id }); emit(st, { kind: 'contract', amount: 1, reason: 'fail', company: co.id, item: k.kind, station: k.stationId }); this.ev('warn', `계약 기한 만료: ${k.title} (평판 -2)`, { company: k.takenBy }); }
      }
    }
    // stations keep a few delivery jobs posted
    for (const s of Object.values(st.stations)) {
      if (!s.public || !s.services.contracts) continue;
      const open = Object.values(st.contracts).filter(k => !k.done && k.stationId === s.id && k.kind === 'delivery');
      if (open.length < 2 && this.rng.chance(0.08)) {
        // half the time: one of the goods this station's region consumes (refined goods, parts, equipment)
        const local = Object.keys(PROFILES[s.id]?.use ?? {}).filter(k => s.market?.[k] && !['ore', 'alloy', 'crystal'].includes(k));
        const res: Res = local.length && this.rng.chance(0.5) ? this.rng.pick(local) : this.rng.chance(0.7) ? 'ore' : this.rng.chance(0.6) ? 'alloy' : 'crystal';
        const amount = res === 'crystal' ? 40 + this.rng.int(5) * 20 : res === 'alloy' ? 100 + this.rng.int(4) * 50 : res === 'ore' ? 200 + this.rng.int(5) * 100 : Math.max(4, Math.round(targetFor(res) * this.rng.range(0.06, 0.14) / 2) * 2);
        const base = s.market?.[res]?.base ?? 20;
        // remote, dangerous stations pay far more for the same cargo
        const mult = 1.6 + (100 - this.secAt(s.pos)) / 70;
        this.offerContract({ stationId: s.id, kind: 'delivery', title: `${RES_NAME[res]} ${amount} 납품`, desc: `${s.name}에 ${RES_NAME[res]} ${amount}단위를 납품하라. 시장가의 약 ${mult.toFixed(1)}배를 지급한다.`, reward: Math.round(amount * base * mult / 50) * 50, rep: 2, res, amount });
      }
    }
    // lair assaults posted by the Union
    for (const l of Object.values(st.lairs)) {
      if (!l.alive) continue;
      if (Object.values(st.contracts).some(k => !k.done && k.kind === 'lair' && k.target === l.id)) continue;
      const lsys = this.sysOf(l.pos);
      const host = Object.values(st.stations).filter(x => x.public && x.services.contracts).sort((a, b) => this.routeDistance(a.pos, l.pos) - this.routeDistance(b.pos, l.pos))[0];
      const tier = l.tier ?? 2;
      this.offerContract({ stationId: host?.id ?? 'astra', kind: 'lair', title: `토벌: ${l.name}`, desc: `${lsys?.name ?? ''} — ${l.name}을(를) 파괴하라. 요새 포대와 수비대가 있다 — ${tier >= 4 ? '전함을 포함한 대함대' : tier >= 3 ? '순양함 여러 척' : '순양함급 이상'}의 전력을 권장.`, reward: tier * 14000 + 4000, rep: 8 + tier * 4, target: l.id });
    }
    // recruitment pools
    for (const s of Object.values(st.stations)) {
      if (!s.services.recruit) continue;
      const pool = Object.values(st.commanders).filter(c => !c.owner && c.stationId === s.id);
      // veterans gather where the fighting is (and where the money is)
      const sec = this.secAt(s.pos);
      if (pool.length < 3 && this.rng.chance(0.05)) this.newCommander(null, s.id === 'helios' ? 2 : sec < 40 ? 1.8 : 1, s.id);
    }
  }

  private completeContract(k: Contract) { return watchMoney(this.st, `contract_${k.kind}`, { company: k.takenBy ?? undefined, station: k.stationId }, () => this.completeContractObserved(k)); }

  private completeContractObserved(k: Contract) {
    if (k.done) return;
    k.done = true;
    const co = k.takenBy ? this.st.companies[k.takenBy] : null;
    if (!co) return;
    co.credits += k.reward; co.stats.earned += k.reward; co.rep += k.rep; emit(this.st, { kind: 'reputation', reason: `contract_${k.kind}`, amount: k.rep, company: co.id, station: k.stationId }); co.stats.contracts++;
    emit(this.st, { kind: 'contract', reason: 'complete', amount: 1, value: k.reward, company: co.id, station: k.stationId, item: k.kind });
    this.ev('money', `계약 완수: ${k.title} — 보수 +${k.reward.toLocaleString()} cr, 평판 +${k.rep}`, { company: co.id, pos: this.st.stations[k.stationId]?.pos });
    // growth P6: lair assaults can award blueprints (contract / unique sources)
    if (growthOn(this.st) && k.kind === 'lair') {
      const tier = (k.target && this.st.lairs[k.target]?.tier) || 2;
      for (const bp of contractAwards(this.st, co, tier, () => this.rng.next())) this.ev('milestone', `계약 보상 설계도: ${bpName(bp)}`, { company: co.id, tag: 'blueprint' });
    }
    if (!co.milestones.includes('first_contract')) this.milestone(co, 'first_contract');
  }

  private milestone(co: Company, id: string) {
    if (co.milestones.includes(id)) return;
    co.milestones.push(id);
    const m = MILESTONES.find(x => x.id === id);
    if (m) this.ev('milestone', `목표 달성: ${m.title}`, { company: co.id });
  }

  private milestones() {
    for (const co of Object.values(this.st.companies)) {
      if (co.kind !== 'player') continue;
      const ships = Object.values(this.st.ships).filter(s => s.owner === co.id);
      if (ships.length >= 8) this.milestone(co, 'fleet_8');
      if (Object.values(this.st.commanders).filter(c => c.owner === co.id).length >= 3) this.milestone(co, 'commanders_3');
      if (ships.some(s => s.classId === 'cruiser')) this.milestone(co, 'cruiser');
      if (ships.some(s => s.classId === 'battleship')) this.milestone(co, 'battleship');
      const own = Object.values(this.st.stations).filter(s => s.owner === co.id);
      if (own.some(s => this.hasModule(s, 'core'))) this.milestone(co, 'station');
      if (own.reduce((a, s) => a + s.modules.filter(m => m.built).length, 0) >= 3) this.milestone(co, 'station_3');
      if (this.netWorth(co.id) >= 300000) this.milestone(co, 'rich');
    }
  }

  netWorth(company: string): number {
    const co = this.st.companies[company];
    let v = co.credits;
    for (const j of Object.values(this.st.logisticsJobs ?? {})) if (j.owner === company) v += j.reserved * assetReferenceValue(this.st, j.item);
    for (const cargo of Object.values(co.pendingLoot ?? {})) for (const k of cargoKeys(cargo)) v += cargo[k] * assetReferenceValue(this.st, k);
    for (const s of Object.values(this.st.ships)) if (s.owner === company) v += (shipWorth(this.st, s) + regionalShipValueAdjustment(this.st, s)) * (0.5 + 0.5 * s.hp);
    for (const s of Object.values(this.st.stations)) {
      const store = s.storage[company]; if (store) for (const k of cargoKeys(store)) v += store[k] * assetReferenceValue(this.st, k);
      if (s.owner === company) for (const m of s.modules) if (m.built) {
        const md = MODULES[m.kind], cost = m.economy === 'p963' ? { credits: m.paid ?? md.credits, mats: moduleMaterials(m) } : facilityBuild(md, false);
        v += cost.credits + Object.entries(cost.mats).reduce((a, [k, n]) => a + n * itemPriceOf(k), 0);
      }
    }
    return Math.round(v);
  }

  private cleanup() {
    const st = this.st;
    for (const f of Object.values(st.fields)) if (f.salvage && (f.expires < this.time || f.amount < 1)) delete st.fields[f.id];
    for (const [id, e] of Object.entries(st.engagements)) if (e.done && this.time - e.start > 600) delete st.engagements[id];
    for (const [id, k] of Object.entries(st.contracts)) if (k.done && this.time - k.expires > 300) delete st.contracts[id];
    if (st.exclusive) { stepExclusive(this); enforceExclusive(st); }
    // NPC groups that lost all ships
    for (const g of Object.values(st.groups)) if (!g.shipIds.length && st.companies[g.owner]?.kind !== 'player' && !(g.owner === 'union' && g.npc)) { if (g.commanderId) delete st.commanders[g.commanderId]; delete st.groups[g.id]; }
  }
}

const BERTH_MAX = 28;
