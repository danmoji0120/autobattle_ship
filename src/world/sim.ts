// Authoritative persistent-world simulation. Runs identically on the Node server (multiplayer)
// and inside the browser (single player). All state lives in `st` (plain JSON).

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
import { normPlan, allocate, advance, activePlan, cancelRefund, plans, missing, isSecured, prereqBuilt, matsOf } from './construction';
import { stepProduction, storageCap, stationNeeds, stepBuilds, buildNeeds, fitUnits, yardSlots, hullName, YARD_NAME, type ProdOrder } from './production';
import { RECIPES, ITEMS, TECHS, EQUIPMENT, HULLS, techFx, fitFx, loadoutEquipment, itemPrice as itemPriceOf } from './industry';
import { upgradeIndustry, npcMarketStep, SALVAGE_MIX, PROFILES, targetFor } from './economy';
import { factionStep, bump, supplyMul, LAIR_FOOTHOLD, RECOVERY_TIME, ensureInfluence } from './factions';
import { canQueue, stepResearch, learnBlueprint, projectCredits, projectTime, wreckLoot } from './research';
const techName = (id: string) => TECHS[id]?.name ?? id;
import { STATION_CREW_RATE } from './data';
import { effSec, secAt } from './security';
import { dist, dist2, rockPos, miningSpot, berthPos, hashId, sysAt, nextGate, jumps } from './geom';

export const STRAT_DT = 0.25;
/** NPC-only battles share this much wall time per update (ms); beyond it they just run a bit slower */
const NPC_BATTLE_BUDGET_MS = 8;
/** safety valve: ships in concurrent NPC battles above this fall back to the strength model */
const NPC_BATTLE_CAP = 160;
const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
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
  | { c: 'buyShip'; station: string; classId: string; loadoutId: string; group?: string }
  | { c: 'sell'; station: string; res: Res; amount: number }
  | { c: 'buy'; station: string; res: Res; amount: number }
  | { c: 'repair'; ship: string }
  | { c: 'refit'; ship: string; loadoutId: string }
  | { c: 'hire'; commander: string }
  | { c: 'dismiss'; commander: string }
  | { c: 'accept'; contract: string }
  | { c: 'queueModule'; station: string; kind: string }
  | { c: 'planOp'; station: string; plan: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'prodOrder'; station: string; recipe: string; mode: 'count' | 'stock'; n: number }
  | { c: 'prodOp'; station: string; order: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' | 'set'; n?: number }
  | { c: 'list'; station: string; item: string; qty: number; price: number }
  | { c: 'delist'; station: string; listing: string }
  | { c: 'buyListing'; station: string; listing: string; qty: number }
  | { c: 'buildShip'; station: string; classId: string; loadoutId: string; fit?: string[]; group?: string }
  | { c: 'buildOp'; station: string; build: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'fitShip'; ship: string; fit: string[] }
  | { c: 'research'; station: string; tech: string; source?: 'lab' | 'salvage' | 'copy' }
  | { c: 'researchOp'; project: string; op: 'pause' | 'resume' | 'cancel' | 'up' | 'down' | 'top' }
  | { c: 'learnBlueprint'; station: string; tech: string }
  | { c: 'renameCompany'; name: string };

const PLAYER_COLORS = ['#5fd4ff', '#7dffb0', '#ffb35f', '#d79fff'];

const vadd = (a: V, b: V, k = 1): V => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const vlerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export class WorldSim {
  st: WorldState;
  rng: Rng;
  /** live tactical battles (transient; rebuilt from setup+orders on load) */
  battles = new Map<string, World>();
  private battleAcc = new Map<string, number>();
  private npcRot = 0;
  /** wall time spent stepping NPC battles (diagnostics) */
  npcBattleMs = 0;
  private acc = 0;
  private slow = 0;
  /** hooks for the server */
  onBattleOrder?: (eng: string, rec: OrderRecord) => void;
  onBattleEnd?: (eng: Engagement) => void;

  constructor(st: WorldState) {
    if ((st.version ?? 0) < WORLD_VERSION) st = migrateWorld(st);
    this.st = st;
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
  }

  static create(seed = 1): WorldSim { return new WorldSim(newWorld(seed)); }

  serialize(): string { this.st.rng = this.rng.state(); return JSON.stringify(this.st); }

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
    return this.shipsOf(g).filter(s => s.state !== 'battle' && (military === undefined || ECON[s.classId].military === military)).reduce((a, s) => a + shipValue(s.classId) * (0.4 + 0.6 * s.hp), 0);
  }
  storage(st: Station, company: string): Cargo { return st.storage[company] ??= emptyCargo(); }
  hasModule(st: Station, kind: string) { return st.modules.some(m => m.kind === kind && m.built); }
  /** why a station can't take this mining delivery (null = fine) */
  deliverProblem(st: Station | undefined, company: string, sell: boolean): string | null {
    if (!st) return '하역 정거장이 사라짐';
    if (!this.canDock(st, company)) return st.owner === company ? '정거장 핵심 모듈 미완성' : '하역 권한 없음';
    if (sell && !st.market) return '시장이 없는 정거장 (자동 판매 불가 — 창고 보관을 선택하세요)';
    return null;
  }

  /** best station to unload a field's ore: same system first, own stations preferred for storage */
  autoDeliver(company: string, fieldId: string, sell: boolean): string | null {
    const f = this.st.fields[fieldId]; if (!f) return null;
    const fs = sysAt(this.st.systems, f.pos)?.id;
    let best: string | null = null, bd = Infinity;
    for (const st of Object.values(this.st.stations)) {
      if (this.deliverProblem(st, company, sell)) continue;
      const ss = sysAt(this.st.systems, st.pos)?.id;
      const j = fs && ss ? jumps(this.st.systems, fs, ss) : 0;
      const d = (Math.hypot(st.pos.x - f.pos.x, st.pos.z - f.pos.z) + j * 200000) * (!sell && st.owner === company ? 0.6 : 1);
      if (d < bd) { bd = d; best = st.id; }
    }
    return best;
  }

  /** strategic cruise speed: hull, fitted drives, propulsion research */
  cruiseOf(s: WShip): number {
    const co = this.st.companies[s.owner];
    if (!co || co.kind !== 'player') return ECON[s.classId].cruise;
    return ECON[s.classId].cruise * techFx(co.tech).cruiseMul * (s.fit?.length ? fitFx(s.fit, undefined).speedMul : 1);
  }
  /** combat effects of a ship's fitting + its company's research and armouries */
  shipFxOf(s: WShip) {
    const co = this.st.companies[s.owner];
    const armory = Object.values(this.st.stations).some(x => x.owner === s.owner && this.hasModule(x, 'armory'));
    return fitFx(s.fit, co?.tech, armory);
  }

  /** free warehouse space for a company at a station (public stations: unlimited) */
  room(st: Station, company: string): number {
    if (st.owner !== company) return Infinity;
    const cap = storageCap(st);
    return cap > 0 ? Math.max(0, cap - cargoSum(this.storage(st, company))) : Infinity;
  }
  overCap(st: Station, company: string, add: number) { return this.room(st, company) < add; }
  /** public markets and own stations with a trade hub host a player exchange */
  hasExchange(st: Station) { return (st.public && !!st.market) || this.hasModule(st, 'trade_hub'); }

  /** what a hauler loads at `a` for this haul order, in priority order */
  private haulPick(op: Extract<Op, { k: 'haul' }>, a: Station, b: Station, store: Cargo): [string, number][] {
    if (op.res === '*all') return cargoKeys(store).map(k => [k, store[k]] as [string, number]);
    if (op.res === '*auto') {
      // what the destination's production orders and construction plans are short of
      const need = stationNeeds(b);
      for (const m of plans(b)) if (!m.paused) for (const r of matsOf(m.kind)) { const x = missing(m, r) - qty(this.storage(b, b.owner), r); if (x > 0) need[r] = Math.max(need[r] ?? 0, x); }
      return Object.entries(need).filter(([k]) => qty(store, k) >= 1).sort((x, y) => y[1] * (ITEMS[y[0]]?.price ?? 50) - x[1] * (ITEMS[x[0]]?.price ?? 50));
    }
    return [[op.res, qty(store, op.res)]];
  }

  private npcMarket(s: Station, m: import('./types').Market, dt: number) {
    const sys = this.sysOf(s.pos);
    npcMarketStep(s, m, dt, sys?.heat ?? 0, supplyMul(sys, this.time));
  }

  canDock(st: Station, company: string) { return st.public || (st.owner === company && this.hasModule(st, 'core')); }

  price(st: Station, res: Res, side: 'sell' | 'buy'): number {
    const m = st.market?.[res];
    if (!m) return 0;
    const ratio = m.stock / m.target;
    const p = m.base * Math.max(0.45, Math.min(1.7, 1.45 - 0.55 * ratio));
    return side === 'sell' ? Math.round(p * 10) / 10 : Math.round(p * 1.18 * 10) / 10;
  }

  // ===================================================================== creation

  spawnShip(owner: string, classId: string, loadoutId: string, groupId: string, pos: V, name?: string): WShip {
    const id = this.id('s');
    const names = SHIP_NAMES[owner === 'pirates' ? 1 : 0];
    const civ: Record<string, string> = { miner: '곡괭이', hauler: '짐꾼', constructor: '석공' };
    const nm = name ?? (civ[classId] ? `${civ[classId]} ${this.st.nextId % 100}호` : `${this.rng.pick(names)}${this.rng.chance(0.4) ? ' ' + ['II', 'III', 'IV', 'V'][this.rng.int(4)] : ''}`);
    const s: WShip = { id, owner, classId, loadoutId, name: nm, hp: 1, pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, heading: this.rng.range(0, 6.28), groupId, state: 'space', task: { k: 'none' }, cargo: emptyCargo(), kills: 0 };
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

  addPlayer(name: string): string {
    const n = Object.values(this.st.companies).filter(c => c.kind === 'player').length;
    const id = this.id('p');
    this.st.companies[id] = {
      id, name: name.slice(0, 20) || `PMC-${id}`, kind: 'player', color: PLAYER_COLORS[n % PLAYER_COLORS.length], credits: 7000, rep: 0,
      createdAt: this.time, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [], homeStation: 'astra', tech: [], research: [],
    };
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
    const co = this.st.companies[company];
    if (!co || co.kind !== 'player') return '알 수 없는 회사';
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
        if (cmd.op.k === 'mine' && cmd.op.auto) cmd.op = { ...cmd.op, deliver: this.autoDeliver(company, cmd.op.field, cmd.op.sell) ?? '' };
        const err = this.validateOp(company, g, cmd.op);
        if (err) return err;
        if (cmd.op.k === 'found') {
          const e2 = this.prepareFound(company, g);
          if (e2) return e2;
        }
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
        const st = S(cmd.station); if (!st?.market?.[cmd.res]) return '거래 불가';
        const store = this.storage(st, company);
        const amt = Math.floor(Math.max(0, cmd.amount));
        if (cmd.c === 'sell') {
          const a = Math.min(amt, Math.floor(qty(store, cmd.res))); if (a <= 0) return '창고에 자원 없음';
          const v = this.sellAt(st, company, cmd.res, a); addc(store, cmd.res, -a);
          this.ev('money', `${RES_NAME[cmd.res]} ${a} 판매 +${Math.round(v).toLocaleString()} cr`, { company, pos: st.pos });
        } else {
          const m = st.market[cmd.res]; const a = Math.min(amt, Math.floor(m.stock)); const cost = a * this.price(st, cmd.res, 'buy');
          if (a <= 0) return '재고 없음'; if (co.credits < cost) return '자금 부족';
          if (st.owner !== company && this.overCap(st, company, a)) return '창고 용량 부족';
          co.credits -= cost; m.stock -= a; addc(store, cmd.res, a);
          this.ev('money', `${RES_NAME[cmd.res]} ${a} 구매 -${Math.round(cost).toLocaleString()} cr`, { company, pos: st.pos });
        }
        return null;
      }
      case 'repair': {
        const s = this.st.ships[cmd.ship]; if (!s || s.owner !== company || s.state !== 'docked' || s.task.k !== 'docked') return '정박 중인 함선만 수리 가능';
        const st = S(s.task.station); if (!st.services.repair && !(st.owner === company && this.hasModule(st, 'repair'))) return '수리 시설 없음';
        const cost = Math.round((1 - s.hp) * ECON[s.classId].price * 0.3 / techFx(co.tech).repairMul);
        if (co.credits < cost) return '자금 부족';
        co.credits -= cost; s.hp = 1;
        this.ev('money', `${s.name} 수리 완료 -${cost.toLocaleString()} cr`, { company });
        return null;
      }
      case 'refit': {
        const s = this.st.ships[cmd.ship]; if (!s || s.owner !== company || s.task.k !== 'docked') return '정박 중이어야 함';
        const st = S(s.task.station);
        const ownFit = st.owner === company && (this.hasModule(st, 'fitting') || yardSlots(st).length > 0);
        if (!st.services.refit && !ownFit) return '개조 시설 없음';
        if (ownFit) {
          // own facility: the new weapons come from storage, the old ones go back into it
          const cur = loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts), nxt = loadoutEquipment(getLoadout(s.classId, cmd.loadoutId).mounts);
          const store = this.storage(st, company);
          for (const [k, n] of Object.entries(nxt)) if (n > (cur[k] ?? 0) && qty(store, k) < n - (cur[k] ?? 0)) return `${RES_NAME[k]} ${n - (cur[k] ?? 0)} 필요 (보관함에 ${Math.floor(qty(store, k))})`;
          for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt)])) addc(store, k, (cur[k] ?? 0) - (nxt[k] ?? 0));
          s.loadoutId = getLoadout(s.classId, cmd.loadoutId).id;
          this.ev('money', `${s.name} 무장 교체: ${getLoadout(s.classId, s.loadoutId).name} (기존 무장은 창고로)`, { company });
          return null;
        }
        const cost = Math.round(ECON[s.classId].price * 0.15);
        if (co.credits < cost) return '자금 부족';
        co.credits -= cost; s.loadoutId = getLoadout(s.classId, cmd.loadoutId).id;
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
        k.takenBy = company; k.expires = this.time + (k.kind === 'lair' ? 1800 : 1200);
        this.ev('info', `계약 수주: ${k.title}`, { company, pos: S(k.stationId).pos });
        return null;
      }
      case 'queueModule': {
        const st = S(cmd.station); const md = MODULES[cmd.kind];
        if (!st || st.owner !== company || !md) return '건설 불가';
        if (md.kind === 'core') return '도킹 허브는 정거장 설립 시 함께 건설됨';
        if (st.modules.length >= MAX_MODULES) return `시설 슬롯 부족 (${st.modules.length}/${MAX_MODULES})`;
        if (md.requires && !st.modules.some(m => m.kind === md.requires)) return `${MODULES[md.requires].name} 필요`;
        if (md.tech && !co.tech?.includes(md.tech)) return `연구 필요: ${techName(md.tech)}`;
        if (md.max !== undefined && st.modules.filter(m => m.kind === md.kind).length >= md.max) return md.max === 1 ? '이미 보유하거나 계획된 시설 (정거장당 1개)' : `정거장당 최대 ${md.max}개`;
        // credits are paid now; materials may arrive later — the plan waits for them
        if (co.credits < md.credits) return `자금 부족 — ${Math.ceil(md.credits - co.credits).toLocaleString()} cr 더 필요`;
        co.credits -= md.credits;
        const m = normPlan({ kind: md.kind, progress: 0, built: false, slot: this.freeSlot(st), paid: md.credits }, () => this.id('pl'));
        st.modules.push(m);
        // take what is already in storage right away so the panel shows it immediately
        allocate(st, this.storage(st, company));
        const short = matsOf(m.kind).filter(r => missing(m, r) > 1e-6).map(r => `${RES_NAME[r]} ${Math.ceil(missing(m, r))}`);
        this.ev('info', `${st.name}: ${md.name} 건설 계획 등록 — ${short.length ? `자재 대기 (${short.join(', ')} 부족)` : '자재 확보 완료'}`, { company, pos: st.pos, tag: 'build_plan' });
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
            this.ev('info', `${st.name}: ${md.name} 계획 취소 — 환불 ${back.credits.toLocaleString()} cr, 예약 자재 반환 (${Object.entries(back.mats).map(([k, n]) => `${RES_NAME[k]} ${Math.round(n)}`).join(', ') || '없음'})${m.progress > 0 ? ` · 투입된 자재는 회수 불가` : ''}`, { company, pos: st.pos });
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
        const st = S(cmd.station); const r = RECIPES[cmd.recipe];
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        if (!r) return '알 수 없는 레시피';
        if (r.tech && !co.tech?.includes(r.tech)) return `연구 필요: ${techName(r.tech)}`;
        if (!st.modules.some(m => m.kind === r.fac)) return `${MODULES[r.fac].name}이(가) 없습니다 — 먼저 건설하세요`;
        const n = Math.floor(cmd.n);
        if (!(n >= 1 && n <= 1e6)) return '수량 오류';
        if ((st.orders ?? []).length >= 40) return '생산 주문은 정거장당 40개까지';
        st.seq = (st.seq ?? 0) + 1;
        (st.orders ??= []).push({ id: `o${st.seq}`, recipe: r.id, mode: cmd.mode === 'stock' ? 'stock' : 'count', n, done: 0 });
        stepProduction(st, co, 0);
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
        stepProduction(st, co, 0);
        return null;
      }
      // ── player market: goods are held in escrow at the station until sold or withdrawn ──
      case 'list': {
        const st = S(cmd.station); if (!st) return '정거장 없음';
        if (!this.hasExchange(st)) return '이 정거장에는 거래소가 없습니다';
        const n = Math.floor(cmd.qty), price = Math.round(cmd.price * 10) / 10;
        if (!(n >= 1) || !(price > 0 && price < 1e8)) return '수량·가격 오류';
        const store = this.storage(st, company);
        if (qty(store, cmd.item) < n) return '보관함에 수량 부족';
        if ((st.listings ?? []).filter(l => l.seller === company).length >= 20) return '정거장당 매물은 20개까지';
        addc(store, cmd.item, -n);
        st.seq = (st.seq ?? 0) + 1;
        (st.listings ??= []).push({ id: `l${st.seq}`, seller: company, item: cmd.item, qty: n, price, t: this.time });
        this.ev('world', `${co.name}이(가) ${st.name} 거래소에 ${RES_NAME[cmd.item]} ${n}을(를) 개당 ${price.toLocaleString()} cr에 내놓았다.`, { pos: st.pos, ref: st.id });
        return null;
      }
      case 'delist': {
        const st = S(cmd.station); const l = st?.listings?.find(x => x.id === cmd.listing);
        if (!st || !l || l.seller !== company) return '매물 없음';
        addc(this.storage(st, company), l.item, l.qty);
        st.listings!.splice(st.listings!.indexOf(l), 1);
        return null;
      }
      case 'buyListing': {
        const st = S(cmd.station); const l = st?.listings?.find(x => x.id === cmd.listing);
        if (!st || !l) return '매물이 이미 팔렸거나 내려갔습니다';
        if (l.seller === company) return '자기 매물';
        const n = Math.min(Math.floor(cmd.qty), l.qty);
        if (!(n >= 1)) return '수량 오류';
        const cost = n * l.price;
        if (co.credits < cost) return `자금 부족 — ${Math.ceil(cost - co.credits).toLocaleString()} cr 더 필요`;
        if (this.overCap(st, company, n)) return '창고 용량 부족';
        const seller = this.st.companies[l.seller];
        co.credits -= cost;
        const net = cost * (1 - (st.tax ?? 0.02));
        if (seller) { seller.credits += net; seller.stats.earned += net; }
        addc(this.storage(st, company), l.item, n);
        l.qty -= n;
        if (l.qty <= 0) st.listings!.splice(st.listings!.indexOf(l), 1);
        this.ev('money', `${st.name} 거래소: ${RES_NAME[l.item]} ${n} 구매 -${Math.round(cost).toLocaleString()} cr`, { company, pos: st.pos });
        if (seller) this.ev('money', `${st.name} 거래소: ${co.name}이(가) ${RES_NAME[l.item]} ${n} 구매 +${Math.round(net).toLocaleString()} cr`, { company: l.seller, pos: st.pos });
        return null;
      }
      case 'buildShip': {
        const st = S(cmd.station); const h = HULLS[cmd.classId]; const cls = SHIP_CLASSES[cmd.classId];
        if (!st || st.owner !== company) return '자사 정거장이 아님';
        if (!h || !cls) return '건조할 수 없는 함급';
        if (h.tech && !co.tech?.includes(h.tech)) return `설계 연구 필요: ${techName(h.tech)}`;
        if (!yardSlots(st).some(y => y.size >= h.yard)) return `${YARD_NAME[h.yard]} 이상 조선소가 필요합니다`;
        const lo = getLoadout(cmd.classId, cmd.loadoutId);
        const fit = (cmd.fit ?? []).filter(k => EQUIPMENT[k]?.kind === 'module');
        if (fitUnits(fit) > h.slots) return `피팅 슬롯 초과 (${fitUnits(fit)}/${h.slots})`;
        if ((st.builds ?? []).length >= 20) return '건조 대기열은 20척까지';
        if (co.credits < h.credits) return `자금 부족 — ${Math.ceil(h.credits - co.credits).toLocaleString()} cr 더 필요`;
        const g = cmd.group ? G(cmd.group) : null;
        co.credits -= h.credits;
        st.seq = (st.seq ?? 0) + 1;
        (st.builds ??= []).push({ id: `b${st.seq}`, classId: cmd.classId, loadoutId: lo.id, fit, group: g?.id, left: h.time, total: h.time, started: false, paid: h.credits });
        stepBuilds(st, co, 0);
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
        stepBuilds(st, co, 0);
        return null;
      }
      case 'research': {
        const st = S(cmd.station);
        if (!st) return '정거장 없음';
        const src = cmd.source ?? 'lab';
        const err = canQueue(co, st, cmd.tech, src);
        if (err) return err;
        if ((co.research ?? []).length >= 30) return '연구 대기열은 30개까지';
        const cr = projectCredits(cmd.tech, src), time = projectTime(cmd.tech, src);
        co.credits -= cr;
        co.rseq = (co.rseq ?? 0) + 1;
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
        this.ev('milestone', `설계도 습득: ${techName(cmd.tech)} — ${TECHS[cmd.tech].unlocks}`, { company, pos: st.pos });
        return null;
      }
      case 'fitShip': {
        const s = this.st.ships[cmd.ship];
        if (!s || s.owner !== company || s.task.k !== 'docked') return '정박 중인 자사 함선만 장비를 바꿀 수 있습니다';
        const st = S(s.task.station);
        const ownFit = st.owner === company && (this.hasModule(st, 'fitting') || yardSlots(st).length > 0);
        if (!ownFit && !(st.public && st.services.refit)) return '피팅 시설이 없는 정거장';
        const fit = cmd.fit.filter(k => EQUIPMENT[k]?.kind === 'module');
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
        co.credits -= fee;
        for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt)])) addc(store, k, (cur[k] ?? 0) - (nxt[k] ?? 0));
        s.fit = fit;
        this.ev('money', `${s.name} 장비 변경: ${fit.map(k => EQUIPMENT[k].name).join(', ') || '없음'}${fee ? ` -${fee.toLocaleString()} cr` : ''}`, { company, pos: st.pos });
        return null;
      }
      case 'renameCompany': co.name = cmd.name.slice(0, 20) || co.name; return null;
    }
    return '알 수 없는 명령';
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
    if (advance(m, rate)) {
      // rounding crumbs go back; completed modules carry no plan bookkeeping
      const store = this.storage(st, st.owner);
      for (const [r, n] of Object.entries(m.reserved ?? {})) if (n > 0) addc(store, r, n);
      delete m.reserved; delete m.used; delete m.paused; delete m.secured;
      this.ev('world', `${this.st.companies[st.owner]?.name ?? ''}: ${st.name}에 ${md.name} 완공!`, { pos: st.pos, ref: st.id });
      this.ev('info', `${st.name}: ${md.name} 완공 — ${md.unlocks}`, { company: st.owner, pos: st.pos, tag: 'build_done' });
      if (g) this.say(g, `${md.name} 완공했습니다.`, 'radio', 0);
    }
  }

  /** a finished hull leaves the yard: docked at the station, in its assigned group */
  private launchBuild(st: Station, b: import('./types').ShipBuild) {
    const company = st.owner;
    const cls = SHIP_CLASSES[b.classId];
    let g = b.group ? this.st.groups[b.group] : undefined;
    if (!g || g.owner !== company) g = this.newGroup(company, ECON[b.classId]?.military ? '신조함 편대' : `${cls.type}반`);
    const s = this.spawnShip(company, b.classId, b.loadoutId, g.id, st.pos);
    s.fit = [...b.fit];
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
        if (!f) return '소행성 지대 없음';
        if (!st) return op.auto ? '하역 가능한 정거장이 없음' : '하역 정거장 없음';
        if (!sub.some(s => ECON[s.classId].mine > 0)) return '채굴선이 없음';
        return this.deliverProblem(st, company, op.sell);
      }
      case 'haul': {
        const a = this.st.stations[op.from], b = this.st.stations[op.to];
        if (!a || !b || a === b || !this.canDock(a, company) || !this.canDock(b, company)) return '운송 경로 오류';
        if (!sub.some(s => ECON[s.classId].cargo > 0)) return '화물 적재 함선이 없음';
        if (op.res === '*auto' && ![a, b].some(x => x.owner === company && x.modules.some(m => m.kind === 'logistics' && m.built))) return '자동 보급에는 물류센터가 필요 (출발지나 목적지)';
        if (op.res !== '*auto' && op.res !== '*all' && !ITEMS[op.res] && !EQUIPMENT[op.res] && !op.res.startsWith('bp:')) return '알 수 없는 품목';
        return null;
      }
      case 'dock': { const st = this.st.stations[op.station]; return st && this.canDock(st, company) ? null : '정박 불가'; }
      case 'escort': { const t = this.st.groups[op.group]; return t && t.owner === company && t.id !== g.id ? null : '호위 대상 오류'; }
      case 'attack': {
        if (op.lair) return this.st.lairs[op.lair]?.alive ? null : '대상 없음';
        const t = op.group ? this.st.groups[op.group] : null;
        if (!t || this.st.companies[t.owner]?.kind !== 'pirate') return '공격할 수 없는 대상 (현재는 해적만 공격 가능)';
        return null;
      }
      case 'build': { const st = this.st.stations[op.station]; if (!st || st.owner !== company) return '자사 정거장이 아님'; return sub.some(s => s.classId === 'constructor') ? null : '공작선이 필요'; }
      case 'found': {
        if (!ships.some(s => s.classId === 'constructor')) return '공작선이 이 부대에 직접 있어야 함';
        for (const s of Object.values(this.st.stations)) if (dist2(s.pos, op.at) < 2600) return '다른 정거장과 너무 가깝다 (2,600 이상)';
        for (const l of Object.values(this.st.lairs)) if (dist2(l.pos, op.at) < 3000) return '해적 은신처와 너무 가깝다';
        const sys = this.sysOf(op.at);
        if (!sys || Math.hypot(op.at.x - sys.origin.x, op.at.z - sys.origin.z) > sys.radius * 0.95) return '성계 관제 범위를 벗어남';
        if (sys.security >= 90) return `${sys.name}은(는) 연합 핵심 성계 — 민간 정거장 건설 허가가 나지 않는다`;
        if (Math.hypot(op.at.x - sys.origin.x, op.at.z - sys.origin.z) < sys.star.size * 2.5) return '항성에 너무 가깝다';
        for (const pl of sys.planets) if (dist2(pl.pos, op.at) < pl.size * 1.8) return `${pl.name}에 너무 가깝다`;
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
    const market = Object.values(this.st.stations).filter(s => s.market?.alloy).sort((a, b) => dist(a.pos, con.pos) - dist(b.pos, con.pos))[0];
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
    const t0 = clockMs();
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
        if (npc && clockMs() - t0 > NPC_BATTLE_BUDGET_MS) break;
        w.step(); acc -= w.dt;
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
    for (const g of Object.values(st.groups)) {
      if (g.cooldown > 0) g.cooldown -= dt;
      this.runGroup(g, dt);
    }
    if (this.slow >= 1) {
      this.slow = 0;
      this.npcSlow();
      this.detectEngagements();
      this.resolveAuto();
      this.contracts();
      this.milestones();
      this.cleanup();
    }
  }

  /** salvage_ops: recovered parts and captured equipment go to the nearest station the company can store at */
  private salvageWrecks(co: Company, wrecks: Record<string, number>[], share: number, pos: V) {
    const loot: Record<string, number> = {};
    const rng = () => this.rng.next();
    for (const w of wrecks) { if (rng() > share) continue; for (const [k, n] of Object.entries(wreckLoot(rng, w))) loot[k] = (loot[k] ?? 0) + n; }
    if (!Object.keys(loot).length) return;
    const sys = sysAt(this.st.systems, pos);
    let best: Station | null = null, bd = Infinity;
    for (const x of Object.values(this.st.stations)) {
      if (!(x.public || x.owner === co.id)) continue;
      const d = dist(x.pos, pos) + (sysAt(this.st.systems, x.pos) === sys ? 0 : 1e7) - (x.owner === co.id ? 5000 : 0);
      if (d < bd) { bd = d; best = x; }
    }
    if (!best) return;
    const S = best.storage[co.id] ??= emptyCargo();
    for (const [k, n] of Object.entries(loot)) addc(S, k, n);
    this.ev('money', `전장 회수: ${Object.entries(loot).map(([k, n]) => `${RES_NAME[k]} ${n}`).join(', ')} → ${best.name} 창고`, { company: co.id, pos: best.pos, tag: 'salvage' });
  }

  // ===================================================================== economy

  private economy(dt: number) {
    const st = this.st;
    for (const s of Object.values(st.stations)) {
      if (s.market) {
        // stations consume/produce so prices recover over time
        const m = s.market;
        this.npcMarket(s, m, dt);
      }
      if (!s.public) {
        if (this.hasModule(s, 'defense') && s.defenseHp < 1) s.defenseHp = Math.min(1, s.defenseHp + dt * 0.004);
        this.stationWorks(s, dt);
        for (const b of stepBuilds(s, st.companies[s.owner], dt)) this.launchBuild(s, b);
        for (const e of stepProduction(s, st.companies[s.owner], dt)) {
          if (e.kind === 'finished') this.ev('info', `${s.name}: 생산 주문 완료 — ${RECIPES[e.recipe].name}`, { company: s.owner, pos: s.pos, tag: 'prod_done' });
        }
      }
    }
    for (const co of Object.values(st.companies)) {
      if (co.kind !== 'player' || !co.research?.length) continue;
      for (const p of stepResearch(st, co, dt)) {
        const t = TECHS[p.tech];
        if (p.source === 'copy') this.ev('info', `설계도 복제 완료: ${t.name} — ${st.stations[p.station]?.name ?? ''} 창고`, { company: co.id, tag: 'research_done' });
        else this.ev('milestone', `연구 완료: ${t.name} — ${t.unlocks}`, { company: co.id, tag: 'research_done' });
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
    const ids = ['astra', 'nova', 'barcaco', 'exchange', 'helios', 'drakeout', 'cinderco'].filter(x => this.st.stations[x]);
    const start = this.rng.pick(ids);
    const route = [start];
    while (route.length < 4) { const n = this.rng.pick(ids); if (n !== route[route.length - 1]) route.push(n); }
    const g = this.newGroup('guild', `길드 상선단`, null, { k: 'trade', route, leg: 1 });
    g.npc = { role: 'trader', sys: this.sysOf(this.st.stations[start].pos)?.id ?? 'astra', home: start, template: [], nextRefit: 0, born: this.time };
    this.spawnShip('guild', 'hauler', 'std', g.id, vadd(this.st.stations[start].pos, { x: this.rng.range(-300, 300), y: 0, z: this.rng.range(-300, 300) }), `${this.rng.pick(['황금', '은빛', '푸른', '느린'])} ${this.rng.pick(['거북', '낙타', '고래', '돛'])}호`);
  }

  // ===================================================================== group behaviour

  private runGroup(g: WGroup, dt: number) {
    const ships = this.shipsOf(g).filter(s => s.state !== 'battle');
    if (!ships.length) return;
    const op = this.opOf(g);
    const c = this.cmdr(g);
    // ---- commander threat assessment for civilian work
    if (this.st.companies[g.owner]?.kind === 'player' || g.owner === 'guild') this.threatCheck(g, ships, op, c);
    for (const s of ships) { s.fx = undefined; }
    if (g.fleeing) {
      for (const s of ships) {
        if (ECON[s.classId].military && op.k !== 'mine' && op.k !== 'haul') { this.behave(s, g, op, dt, c); continue; }
        const st = this.nearestDock(s.pos, g.owner);
        if (st) this.goDock(s, st, dt, ECON[s.classId].cruise * 1.1);
      }
      g.status = '해적 회피 — 대피 중';
      return;
    }
    if ((op.k === 'move' || op.k === 'attack') && this.st.companies[g.owner]?.kind === 'player') {
      const m = this.fleetMarch(g, op, dt);
      if (m) { for (const s of ships) this.marchShip(s, g, op, m, dt, c); return; }
    }
    for (const s of ships) this.behave(s, g, op, dt, c);
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
      for (const id of x.shipIds) { const s = this.st.ships[id]; if (s && s.state !== 'battle' && ECON[s.classId].cruise > 0) ships.push(s); }
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
      const gate = nextGate(this.st.systems, here.id, there.id); if (!gate) break;
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
    const civ = ships.filter(s => !ECON[s.classId].military && s.state === 'space');
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
    for (const s of Object.values(this.st.stations)) { if (!this.canDock(s, company)) continue; const d = dist(s.pos, p); if (d < bd) { bd = d; best = s; } }
    return best;
  }

  // -------------------------------------------------- motion primitives

  sysOf(p: V): StarSystem | undefined { return sysAt(this.st.systems, p); }

  effSec(sys: StarSystem): number { return effSec(sys); }
  secAt(p: V): number { return secAt(this.st, p); }

  /** move toward `to`, routing through jump gates when it lies in another system */
  private moveTo(s: WShip, to: V, speed: number, dt: number, arrive = 40): boolean {
    if (s.state === 'docked') this.undock(s);
    const here = this.sysOf(s.pos), there = this.sysOf(to);
    if (here && there && here.id !== there.id) {
      const gate = nextGate(this.st.systems, here.id, there.id);
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
        if (!o || o.state !== 'space' || !ECON[o.classId].military || o.warp?.phase === 'warp') continue;
        if (Math.abs(o.pos.x - s.pos.x) < SCRAMBLE_R && dist(o.pos, s.pos) < SCRAMBLE_R) return true;
      }
    }
    return false;
  }

  /** in-system flight: warp for long legs (align → warp → drop out), sublight otherwise */
  private fly(s: WShip, to: V, speed: number, dt: number, arrive: number): boolean {
    let d = dist(s.pos, to);
    if (!s.warp && d > WARP_MIN && ECON[s.classId].cruise > 0 && !this.scrambled(s)) s.warp = { to: { ...to }, phase: 'align', t: 0 };
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

  private undock(s: WShip) { s.state = 'space'; if (s.task.k === 'docked') s.task = { k: 'none' }; }

  private dockShip(s: WShip, st: Station) {
    const used = new Set(Object.values(this.st.ships).filter(o => o.task.k === 'docked' && o.task.station === st.id).map(o => (o.task as any).berth));
    let b = hashId(s.id) % (BERTH_MAX); let n = 0; while (used.has(b) && n++ < BERTH_MAX) b = (b + 1) % BERTH_MAX;
    s.state = 'docked'; s.task = { k: 'docked', station: st.id, berth: b }; s.pos = berthPos(st, b); s.vel = { x: 0, y: 0, z: 0 };
    s.heading = Math.atan2(st.pos.x - s.pos.x, st.pos.z - s.pos.z) + Math.PI / 2;
  }

  /** returns true once docked */
  private goDock(s: WShip, st: Station, dt: number, speed: number): boolean {
    if (s.state === 'docked' && s.task.k === 'docked' && s.task.station === st.id) return true;
    const approach = berthPos(st, hashId(s.id) % BERTH_MAX);
    if (this.moveTo(s, approach, speed, dt, 45)) { this.dockShip(s, st); return true; }
    return false;
  }

  private formationSlot(s: WShip, g: WGroup, center: V, spread = 70): V {
    const idx = g.shipIds.indexOf(s.id);
    const a = idx * 2.4;
    const r = idx === 0 ? 0 : spread * (0.6 + Math.floor(idx / 6) * 0.6);
    return { x: center.x + Math.cos(a) * r, y: center.y + ((idx % 3) - 1) * 18, z: center.z + Math.sin(a) * r };
  }

  private groupSpeed(g: WGroup, military: boolean): number {
    const s = this.shipsOf(g).filter(x => x.state !== 'battle' && ECON[x.classId].military === military);
    return s.length ? Math.min(...s.map(x => this.cruiseOf(x) * (0.6 + 0.4 * x.hp))) : 100;
  }

  // -------------------------------------------------- per-ship behaviour

  private behave(s: WShip, g: WGroup, op: Op, dt: number, c: CommanderDef) {
    const ec = ECON[s.classId];
    if (ec.cruise <= 0) return;
    const speed = this.cruiseOf(s) * (0.6 + 0.4 * s.hp) * (c.specialty === 'maneuver' ? 1.08 : 1);
    const st = this.st;
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
      case 'escort': {
        const t = st.groups[op.group];
        const tc = t ? this.groupCenter(t) : null;
        if (!tc) { g.status = '호위 대상 소실'; break; }
        if (ec.military) {
          const hostile = this.nearestHostile(tc, g.owner, 1600, tc, 1800);
          if (hostile) { this.moveTo(s, this.formationSlot(s, g, hostile, 50), speed, dt, 10); g.status = `${t.name} 호위 — 위협 요격`; break; }
        }
        this.moveTo(s, this.formationSlot(s, g, vadd(tc, { x: 0, y: 40, z: 0 }), 120), speed, dt, 30);
        g.status = `${t.name} 호위 중`;
        break;
      }
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
        if (this.moveTo(s, op.at, speed, dt, 60)) this.foundStation(g, s, op);
        else g.status = `정거장 부지로 이동 (${Math.round(dist(s.pos, op.at))}m)`;
        break;
      }
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
    const ec = ECON[s.classId];
    const groupShips = this.subtreeShipsInOp(g);
    const haulers = groupShips.filter(x => x.classId === 'hauler' && x.state !== 'battle');
    if (ec.mine > 0) {
      const cap = ec.cargo;
      if (s.state === 'docked') {
        if (cargoSum(s.cargo) > 0 && dock) this.unload(s, dock, op.sell);
        this.undock(s);
      }
      const full = cargoSum(s.cargo) >= cap * 0.98;
      if (!dock && (full || (s.task as any).why === 'deliver')) {
        // nowhere valid to unload: hold the ore (never sell it somewhere the player didn't choose)
        s.task = { k: 'none' }; s.vel.x *= 0.8; s.vel.z *= 0.8;
        g.status = '하역지 사용 불가 — 화물 보관 중, 목적지 재지정 필요'; return;
      }
      if (full && dock && (!haulers.length || (s.task as any).why === 'deliver')) {
        s.task = { k: 'goto', to: dock.pos, why: 'deliver' };
        if (this.goDock(s, dock, dt, speed)) { this.unload(s, dock, op.sell); this.undock(s); s.task = { k: 'none' }; }
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
        if (cargoSum(s.cargo) > 0 && dock) { s.task = { k: 'goto', to: dock.pos, why: 'deliver' }; if (this.goDock(s, dock, dt, speed)) { this.unload(s, dock, op.sell); this.undock(s); s.task = { k: 'none' }; } }
        return;
      }
      const rock = hashId(s.id) % f.rocks;
      const spot = miningSpot(f, rock);
      if (this.moveTo(s, spot, speed, dt, 18)) {
        const rate = ec.mine * (0.8 + c.skill * 0.4) * (0.5 + 0.5 * s.hp) * (f.rich ?? 1);
        const a = Math.min(rate * dt * techFx(this.st.companies[g.owner]?.tech).mineMul, f.amount, cap - cargoSum(s.cargo));
        f.amount -= a;
        for (const [k, w] of Object.entries(f.mix ?? { [f.res]: 1 })) addc(s.cargo, k, a * w);
        s.task = { k: 'mine', field: f.id, rock };
        s.fx = { mining: f.id, rock };
        const r = rockPos(f, rock); s.heading = Math.atan2(r.x - s.pos.x, r.z - s.pos.z);
        this.st.companies[g.owner] && (this.st.companies[g.owner].stats.mined += a);
        g.status = `${f.name} 채굴 중`;
      } else { s.task = { k: 'goto', to: spot, why: 'field' }; g.status = `${f.name}로 이동`; }
      return;
    }
    if (ec.cargo > 0 && s.classId === 'hauler') {
      const cap = ec.cargo;
      if (s.state === 'docked') { if (cargoSum(s.cargo) > 0 && dock) this.unload(s, dock, op.sell); this.undock(s); }
      const miners = groupShips.filter(x => ECON[x.classId].mine > 0 && x.state === 'space');
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
          for (const r of cargoKeys(donor.cargo)) { const t = takec(donor.cargo, r, left); addc(s.cargo, r, t); left -= t; if (left <= 1e-9) break; }
          s.fx = { transfer: donor.id };
          if ((donor.task as any).why === 'deliver') donor.task = { k: 'none' };
        }
        return;
      }
      if (!dock && (load > cap * 0.5 || delivering)) { s.task = { k: 'none' }; this.moveTo(s, this.formationSlot(s, g, vadd(f.pos, { x: 0, y: 60, z: 0 }), 120), speed, dt); return; }
      if (dock && (load > cap * 0.5 || (load > 0 && !donor) || delivering)) {
        s.task = { k: 'goto', to: dock.pos, why: 'deliver' };
        if (this.goDock(s, dock, dt, speed)) { this.unload(s, dock, op.sell); this.undock(s); s.task = { k: 'none' }; }
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
    let why = this.deliverProblem(st, g.owner, op.sell);
    if (why && op.auto) {
      const alt = this.autoDeliver(g.owner, op.field, op.sell);
      if (alt) { op.deliver = alt; st = this.st.stations[alt]; why = null; this.say(g, `자동 하역지 변경: ${st.name}.`, 'radio', 0.3); }
    }
    const warned = (g as any)._dockWarn as string | undefined;
    if (!why) { if (warned) delete (g as any)._dockWarn; return st!; }
    if (warned !== op.deliver + why) {
      (g as any)._dockWarn = op.deliver + why;
      const co = this.st.companies[g.owner];
      if (co?.kind === 'player') this.ev('warn', `${g.name}: ${st ? `하역지 ${st.name} 사용 불가 — ${why}` : '하역 정거장이 사라졌습니다'}. 화물은 판매하지 않고 보관 중입니다. 하역 목적지를 다시 지정하세요.`, { company: g.owner, who: g.name, pos: st?.pos });
    }
    return null;
  }

  /** ships that share this group's effective op: the group plus delegated children */
  private subtreeShipsInOp(g: WGroup): WShip[] {
    let root = g;
    while (root.parentId && !root.override) root = this.st.groups[root.parentId];
    const out: WShip[] = [];
    const walk = (x: WGroup) => { out.push(...this.shipsOf(x)); for (const c of x.childIds) { const cg = this.st.groups[c]; if (cg && !cg.override) walk(cg); } };
    walk(root);
    return out;
  }

  private behaveHaul(s: WShip, g: WGroup, op: Extract<Op, { k: 'haul' }>, dt: number, speed: number) {
    const a = this.st.stations[op.from], b = this.st.stations[op.to];
    const ec = ECON[s.classId];
    if (!a || !b) return;
    if (ec.cargo <= 0) {
      // warships escort the cargo ships of the operation
      const carriers = this.subtreeShipsInOp(g).filter(x => ECON[x.classId].cargo > 0 && x.state === 'space');
      if (carriers.length) {
        const c = carriers[0].pos;
        const hostile = this.nearestHostile(c, g.owner, 1500, c, 1700);
        this.moveTo(s, this.formationSlot(s, g, hostile ?? c, 90), speed, dt, 20);
      } else this.goDock(s, a, dt, speed);
      return;
    }
    const label = op.res === '*auto' ? '자동 보급' : op.res === '*all' ? '전 품목' : RES_NAME[op.res];
    if (cargoSum(s.cargo) > 0.5) {
      g.status = `${b.name}로 ${label} 운송`;
      if (this.goDock(s, b, dt, speed)) {
        this.unload(s, b, false);
        if (cargoSum(s.cargo) > 0.5) g.status = `${b.name} 창고 가득 — 하역 대기`; else this.undock(s);
      }
      return;
    }
    if (this.goDock(s, a, dt, speed)) {
      const store = this.storage(a, s.owner);
      const cap = ec.cargo * techFx(this.st.companies[s.owner]?.tech).cargoMul;
      const pick = this.haulPick(op, a, b, store);
      let room = cap;
      for (const [k, want] of pick) { const t = takec(store, k, Math.min(room, Math.floor(want))); addc(s.cargo, k, t); room -= t; if (room < 1) break; }
      if (cap - room > 0) { g.status = `${a.name}에서 적재 완료 (${Math.round(cap - room)})`; this.undock(s); }
      else g.status = op.res === '*auto' ? `${b.name}에 부족한 원료가 ${a.name} 창고에 없음 — 대기` : `${a.name} 창고에 ${label} 없음 — 대기`;
    } else g.status = `${a.name}로 적재하러 이동`;
  }

  private behaveBuild(s: WShip, g: WGroup, stationId: string, dt: number, speed: number, c: CommanderDef) {
    const st = this.st.stations[stationId];
    if (!st) return;
    if (s.classId !== 'constructor') { if (this.canDock(st, s.owner)) this.goDock(s, st, dt, speed); else this.moveTo(s, this.formationSlot(s, g, st.pos, 250), speed, dt); return; }
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
    let unloaded = false;
    for (const r of cargoKeys(s.cargo)) { addc(store, r, takec(s.cargo, r, s.cargo[r])); unloaded = true; }
    if (unloaded) this.stationWorks(st, 0);
    if (active) {
      const md = MODULES[active.kind];
      this.workOn(st, active, dt / md.work * (0.8 + c.skill * 0.5) * techFx(this.st.companies[s.owner]?.tech).constructMul, g);
      s.fx = { welding: `${st.id}:${active.slot}` };
      g.status = active.built ? `${md.name} 완공` : `${md.name} 건설 ${Math.round(active.progress * 100)}%`;
      return;
    }
    // nothing buildable: say exactly what is missing (alloy and crystal reported separately)
    const first = waiting.find(m => !m.paused && prereqBuilt(st, m)) ?? waiting[0];
    const md = MODULES[first.kind];
    if (first.paused) { g.status = `${md.name} — 일시 정지됨`; return; }
    if (!isSecured(first)) {
      const short = matsOf(first.kind).filter(r => missing(first, r) > 1e-6).map(r => `${RES_NAME[r]} ${Math.ceil(missing(first, r))} 부족`);
      g.status = `${md.name} — 자재 대기 (${short.join(', ')})`;
      this.say(g, `${md.name} 자재 대기 중: ${short.join(', ')}. ${st.name} 창고로 운송하거나 하역해 주십시오.`, 'warn', 90);
    } else g.status = `${md.name} — 선행 시설 대기`;
  }

  private foundStation(g: WGroup, s: WShip, op: Extract<Op, { k: 'found' }>) {
    const co = this.st.companies[g.owner];
    const id = this.id('st');
    const station: Station = {
      id, name: op.name.slice(0, 18) || `${co.name} 기지`, owner: g.owner, public: false, style: 3, pos: { ...op.at, y: 0 }, radius: 180,
      market: null, services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false },
      storage: {}, modules: [normPlan({ kind: 'core', progress: 0, built: false, slot: 0, paid: 0 }, () => this.id('pl'))], defenseHp: 1, founded: this.time,
      desc: `${co.name}의 자체 정거장.`,
    };
    for (const cid of Object.keys(this.st.companies)) station.storage[cid] = emptyCargo();
    this.st.stations[id] = station;
    const store = station.storage[g.owner];
    for (const r of cargoKeys(s.cargo)) addc(store, r, takec(s.cargo, r, s.cargo[r]));
    g.op = { k: 'build', station: id }; g.override = true;
    this.ev('world', `${co.name}이(가) 새 정거장 "${station.name}" 건설에 착수했다.`, { pos: station.pos, ref: id });
    this.say(g, '부지 도착. 골조 조립을 시작합니다.', 'radio', 0);
  }

  // -------------------------------------------------- unloading / trade

  private unload(s: WShip, st: Station, sell: boolean) {
    const co = this.st.companies[s.owner];
    if (!co) return;
    let msg = '';
    // an own station only takes what fits in its warehouse; the rest stays aboard
    let room = st.owner === s.owner ? this.room(st, s.owner) : Infinity;
    let held = 0;
    for (const r of cargoKeys(s.cargo)) {
      let amt = qty(s.cargo, r);
      if (amt <= 0.01) continue;
      const toStore = !(sell && st.market?.[r]) && co.kind === 'player';
      if (toStore && amt > room) { held += amt - Math.max(0, room); amt = Math.max(0, room); }
      takec(s.cargo, r, amt);
      if (toStore) room -= amt;
      if (amt <= 0.01) continue;
      // contracts first
      for (const k of Object.values(this.st.contracts)) {
        if (k.done || k.takenBy !== s.owner || k.kind !== 'delivery' || k.stationId !== st.id || k.res !== r) continue;
        const use = Math.min(amt, (k.amount ?? 0) - k.progress);
        k.progress += use; amt -= use;
        if (k.progress >= (k.amount ?? 0) - 0.01) this.completeContract(k);
      }
      if (amt <= 0.01) continue;
      if (co.kind !== 'player') { if (st.market?.[r]) st.market[r].stock += amt; continue; }
      if (sell && st.market?.[r]) { const v = this.sellAt(st, s.owner, r, amt); msg += `${RES_NAME[r]} ${Math.round(amt)} → +${Math.round(v).toLocaleString()} cr `; }
      else { addc(this.storage(st, s.owner), r, amt); msg += `${RES_NAME[r]} ${Math.round(amt)} 입고 `; }
    }
    if (held > 0.5 && co.kind === 'player') this.ev('warn', `${st.name} 창고 가득 — ${s.name}이(가) 화물 ${Math.round(held)}을(를) 하역하지 못함. 창고를 증설하거나 재고를 옮기세요.`, { company: s.owner, pos: st.pos, tag: 'storage_full' });
    if (msg && co.kind === 'player') {
      const g = this.st.groups[s.groupId];
      this.ev('money', `${s.name} @ ${st.name}: ${msg.trim()}`, { company: s.owner, pos: st.pos, who: g?.name, color: co.color });
    }
  }

  sellAt(st: Station, company: string, r: Res, amt: number): number {
    // sell in chunks so large dumps walk the price down
    let total = 0, left = amt;
    const m = st.market![r];
    while (left > 0.01) { const chunk = Math.min(left, 50); total += chunk * this.price(st, r, 'sell'); m.stock += chunk; left -= chunk; }
    total *= 1 - (st.tax ?? 0);
    const co = this.st.companies[company];
    co.credits += total; co.stats.earned += total;
    if (!co.milestones.includes('first_sale')) this.milestone(co, 'first_sale');
    return total;
  }

  private behaveTrade(s: WShip, g: WGroup, op: Extract<Op, { k: 'trade' }>, dt: number, speed: number) {
    const target = this.st.stations[op.route[op.leg % op.route.length]];
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
    const mil = ships.filter(s => s.groupId === g.id && ECON[s.classId].military);
    const civ = ships.filter(s => s.groupId === g.id && !ECON[s.classId].military);
    const spec = (s: WShip): ShipSpec => ({ classId: s.classId, loadoutId: s.loadoutId, name: s.name, ref: s.id, hp: s.hp, ...(this.st.companies[s.owner]?.kind === 'player' ? { fx: this.shipFxOf(s) } : {}) });
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
      const n = s.modules.filter(m => m.kind === 'defense' && m.built).length;
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
      const mil = ECON[s.classId].military;
      units.push({ ref: s.id, side: e.sides[0].includes(s.owner) ? 0 : 1, val: shipValue(s.classId) * (mil ? 1 : 0.12) * (0.35 + 0.65 * s.hp) * (0.85 + skill * 0.3), hp: s.hp, group: s.groupId });
    }
    if (e.lairId) { const l = st.lairs[e.lairId]; if (l) units.push({ ref: 'lair:' + l.id, side: 1, val: 300 * (0.4 + 0.6 * l.hp), hp: l.hp }); }
    if (e.stationId) { const x = st.stations[e.stationId]; const n = x?.modules.filter(m => m.kind === 'defense' && m.built).length ?? 0; for (let i = 0; i < n; i++) units.push({ ref: 'station:' + x!.id, side: 0, val: 300 * x!.defenseHp, hp: x!.defenseHp }); }
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

  private finishEngagement(e: Engagement, res: BattleResult, tactical = false) {
    const st = this.st;
    e.done = true; e.winner = res.winner;
    const sideOf = (ref: string) => ref.startsWith('lair:') ? 1 : ref.startsWith('station:') ? 0 : (st.ships[ref] && e.sides[0].includes(st.ships[ref].owner) ? 0 : 1);
    const losses: [number, number] = [0, 0];
    for (const ts of res.ships) if (ts.dead && !ts.ref.startsWith('station:')) losses[sideOf(ts.ref)]++;
    const sys = this.sysOf(e.pos);
    const destroyedPirateValue = new Map<string, number>();
    const wrecks: Record<string, number>[] = [];
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
      if (dead) {
        salvage += shipValue(s.classId) * 2.2;
        if (sys) {
          if (s.owner === 'pirates') { sys.stats.pirateKills++; sys.heat = Math.max(0, sys.heat - 3); bump(sys, { pirates: -0.6, union: 0.2 }); }
          else if (s.owner === 'union') { sys.stats.unionLosses++; sys.heat = Math.min(100, sys.heat + 3); }
          else { sys.stats.civLosses++; sys.heat = Math.min(100, sys.heat + 4); }
        }
        if (s.owner === 'pirates') { destroyedPirateValue.set(ts.ref, shipValue(s.classId)); wrecks.push(loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts)); }
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
      co.rep += Math.round(destroyedPirateValue.size * share);
      co.stats.kills += Math.round(destroyedPirateValue.size * share);
      if (won) { co.stats.battlesWon++; if (!co.milestones.includes('first_victory')) this.milestone(co, 'first_victory'); }
      const lost = lostBy.get(c) ?? 0;
      e.summary = `${won ? '승리' : e.winner === 1 ? '패배' : '교착'} — 해적 ${destroyedPirateValue.size}척 격침, 아군 손실 ${lost}척${pay ? `, 현상금 +${pay.toLocaleString()} cr` : ''}`;
      this.ev('battle', `전투 종료: ${e.summary}`, { company: c, pos: e.pos, ref: e.id });
      if (co.tech?.includes('salvage_ops') && wrecks.length) this.salvageWrecks(co, wrecks, share, e.pos);
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
      if (co?.kind === 'player') { co.rep += 15; if (!co.milestones.includes('lair')) this.milestone(co, 'lair'); }
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
        if (k.takenBy) { const co = st.companies[k.takenBy]; co.rep = Math.max(0, co.rep - 2); this.ev('warn', `계약 기한 만료: ${k.title} (평판 -2)`, { company: k.takenBy }); }
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
      const host = Object.values(st.stations).filter(x => x.public && x.services.contracts).sort((a, b) => dist(a.pos, l.pos) - dist(b.pos, l.pos))[0];
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

  private completeContract(k: Contract) {
    if (k.done) return;
    k.done = true;
    const co = k.takenBy ? this.st.companies[k.takenBy] : null;
    if (!co) return;
    co.credits += k.reward; co.stats.earned += k.reward; co.rep += k.rep; co.stats.contracts++;
    this.ev('money', `계약 완수: ${k.title} — 보수 +${k.reward.toLocaleString()} cr, 평판 +${k.rep}`, { company: co.id, pos: this.st.stations[k.stationId]?.pos });
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
    for (const s of Object.values(this.st.ships)) if (s.owner === company) v += ECON[s.classId].price * (0.5 + 0.5 * s.hp);
    for (const s of Object.values(this.st.stations)) {
      const store = s.storage[company]; if (store) for (const k of cargoKeys(store)) v += store[k] * itemPriceOf(k);
      if (s.owner === company) for (const m of s.modules) if (m.built) v += MODULES[m.kind].credits + Object.entries(MODULES[m.kind].mats).reduce((a, [k, n]) => a + n * itemPriceOf(k), 0);
    }
    return Math.round(v);
  }

  private cleanup() {
    const st = this.st;
    for (const f of Object.values(st.fields)) if (f.salvage && (f.expires < this.time || f.amount < 1)) delete st.fields[f.id];
    for (const [id, e] of Object.entries(st.engagements)) if (e.done && this.time - e.start > 600) delete st.engagements[id];
    for (const [id, k] of Object.entries(st.contracts)) if (k.done && this.time - k.expires > 300) delete st.contracts[id];
    // NPC groups that lost all ships
    for (const g of Object.values(st.groups)) if (!g.shipIds.length && st.companies[g.owner]?.kind !== 'player' && !(g.owner === 'union' && g.npc)) { if (g.commanderId) delete st.commanders[g.commanderId]; delete st.groups[g.id]; }
  }
}

const BERTH_MAX = 28;
