// Account-exclusive content: the commander BB and the ship BB-EX.
//
// They are not part of the game economy. There is no blueprint, recipe, sale, recruit pool or drop
// for them; the only way they come into a world is the grant below, made by the SERVER to the PMC of
// one verified account (the account's immutable UUID, set by the operator — never a display name,
// e-mail or company name, never anything a client sends).
//
// The world keeps a ledger (`WorldState.exclusive`) that binds both to that account. Everything here
// is idempotent and self-repairing: granting twice, restarting, restoring a save or replaying a
// request can never produce a second copy, and anything that contradicts the ledger (a second hull,
// a foreign owner, loose exclusive equipment) is removed by `enforceExclusive`.
import { CONTENT, isExclusive } from '../content/registry';
import { BBEX_HULL, BBEX_VARIANT, BBEX_PRESET, BBEX_BAYS } from '../content/packs/bbex';
import { BBEX_CLASS, BBEX_LOADOUT, BB_COMMANDER } from '../sim/bbex/data';
import { EQUIPMENT } from './industry';
import type { Station, V, WCommander, WGroup, WShip, WorldState } from './types';

export const BBEX_SHIP_ID = 'x_bbex';
export const BB_COMMANDER_ID = 'x_bb';
/** a destroyed BB-EX is not gone: it reconstitutes at the owner's home port after this long */
export const EXCLUSIVE_RECOVER_S = 1800;
/** BB is out of action this long after BB-EX is lost */
export const BB_INJURED_S = 600;

export interface ExclusiveLedger {
  /** verified account UUID the content is bound to (never changes once written) */
  account: string;
  /** that account's PMC */
  company: string;
  ship: string;
  commander: string;
  grantedAt: number;
  /** 'recovering' = BB-EX was destroyed and is reconstituting (still the same, single hull) */
  state: 'active' | 'recovering';
  recoverUntil?: number;
  /** times it was lost and recovered (never a new hull) */
  losses: number;
}

/** what the grant needs from the world simulation */
export interface ExclusiveHost {
  st: WorldState;
  time: number;
  newGroup(owner: string, name: string, parentId?: string | null): WGroup;
  spawnHull(owner: string, hullId: string, variantId: string, presetId: string | undefined, groupId: string, pos: V, name?: string): WShip;
  dockShip(s: WShip, st: Station): boolean;
  ev(kind: 'info' | 'warn' | 'milestone' | 'world', text: string, o?: { company?: string; pos?: V; tag?: string }): void;
  /** set while the grant itself spawns the hull (every other spawn of an exclusive hull throws) */
  exclusiveSpawn: boolean;
}

export const isExclusiveShip = (s: { classId: string; hull?: string } | undefined) => !!s && (s.classId === BBEX_CLASS || isExclusive(s.hull));
export const isExclusiveEquip = (id: unknown): boolean => typeof id === 'string' && !!EQUIPMENT[id]?.exclusive;
export const isExclusiveCommander = (c: { id: string; causal?: boolean } | undefined) => !!c && (c.id === BB_COMMANDER_ID || !!c.causal);
const ledgerOf = (st: WorldState) => st.exclusive?.bbex;

function homeStation(st: WorldState, company: string): Station | undefined {
  const co = st.companies[company];
  return st.stations[co?.homeStation ?? ''] ?? Object.values(st.stations).find(x => x.public);
}

function fitExclusive(s: WShip) {
  s.classId = BBEX_CLASS; s.loadoutId = BBEX_LOADOUT; s.hull = BBEX_HULL; s.variant = BBEX_VARIANT;
  s.fitting = { hp: { ...CONTENT.presets[BBEX_PRESET].weapons }, bay: { ...BBEX_BAYS }, preset: BBEX_PRESET };
  s.fit = Object.values(BBEX_BAYS);
  s.fitting.sig = `${s.loadoutId}|${s.fit.join(',')}`;
  delete s.listed; delete s.logisticsPool; delete s.logisticsJob;
}

function makeCommander(company: string): WCommander {
  const { team: _team, ...def } = BB_COMMANDER;
  return { ...def, id: BB_COMMANDER_ID, owner: company, stationId: null, hireCost: 0, xp: 0, level: 9, injuredUntil: 0, battles: 0 };
}

/**
 * Give BB and BB-EX to `company`, the PMC of the verified account `account`. Safe to call on every
 * start, every login and any number of times in a row:
 *  - nothing granted yet → one commander and one ship are created and the ledger is written;
 *  - already granted to this account → missing pieces are repaired, nothing is duplicated;
 *  - already granted to ANOTHER account → nothing happens (ownership never moves); the caller is told.
 */
export function grantExclusive(h: ExclusiveHost, account: string, company: string): 'granted' | 'present' | 'repaired' | 'bound-elsewhere' | 'no-company' {
  const st = h.st;
  const co = st.companies[company];
  if (!account || !co || co.kind !== 'player') return 'no-company';
  let led = ledgerOf(st);
  if (led && led.account !== account) return 'bound-elsewhere';
  let result: 'granted' | 'present' | 'repaired' = led ? 'present' : 'granted';
  if (!led) {
    led = { account, company, ship: BBEX_SHIP_ID, commander: BB_COMMANDER_ID, grantedAt: h.time, state: 'active', losses: 0 };
    (st.exclusive ??= {}).bbex = led;
  }
  // the account's PMC changed (its old PMC is gone): the same commander and hull follow the account
  if (led.company !== company) { led.company = company; result = 'repaired'; }
  // ── commander
  let cm = st.commanders[led.commander];
  if (!cm) { cm = makeCommander(company); st.commanders[cm.id] = cm; if (result === 'present') result = 'repaired'; }
  if (cm.owner !== company) { for (const g of Object.values(st.groups)) if (g.commanderId === cm.id && g.owner !== company) g.commanderId = null; cm.owner = company; cm.stationId = null; if (result === 'present') result = 'repaired'; }
  cm.causal = true;
  // ── ship
  let s = st.ships[led.ship];
  if (s && s.owner !== company) {
    // put it back where it belongs, out of whatever group held it
    const old = st.groups[s.groupId]; if (old) old.shipIds = old.shipIds.filter(x => x !== s!.id);
    delete st.ships[s.id]; s = undefined as unknown as WShip;
  }
  if (!s) {
    const home = homeStation(st, company);
    let g = Object.values(st.groups).find(x => x.owner === company && x.commanderId === cm!.id && !x.npc);
    if (!g) { g = h.newGroup(company, 'BB-EX'); g.commanderId = cm.id; }
    for (const o of Object.values(st.groups)) if (o.commanderId === cm.id && o.id !== g.id) o.commanderId = null;
    h.exclusiveSpawn = true;
    try { s = h.spawnHull(company, BBEX_HULL, BBEX_VARIANT, BBEX_PRESET, g.id, home?.pos ?? { x: 0, y: 0, z: 0 }, 'BB-EX'); } finally { h.exclusiveSpawn = false; }
    // a fixed id: a second copy cannot even be addressed
    const tmp = s.id;
    delete st.ships[tmp]; s.id = led.ship; st.ships[s.id] = s;
    g.shipIds = g.shipIds.map(x => x === tmp ? s!.id : x);
    fitExclusive(s);
    if (home) h.dockShip(s, home);
    if (led.state === 'recovering') { s.hp = 0.05; s.recover = { until: led.recoverUntil ?? h.time + EXCLUSIVE_RECOVER_S }; }
    if (result === 'present') result = 'repaired';
  } else fitExclusive(s);
  if (result === 'granted') {
    h.ev('milestone', '세계 유일의 지휘관 BB와 실험함 BB-EX가 이 계정에 귀속되었습니다. 양도·판매·복제할 수 없습니다.', { company, tag: 'exclusive' });
  }
  enforceExclusive(st);
  return result;
}

/** Remove everything that contradicts the ledger. Runs on load, after a grant and once a second. */
export function enforceExclusive(st: WorldState): number {
  const led = ledgerOf(st);
  let fixed = 0;
  for (const s of Object.values(st.ships)) {
    if (!isExclusiveShip(s)) continue;
    if (led && s.id === led.ship && s.owner === led.company) continue;
    // a copy, or the hull in the wrong hands: it does not exist
    const g = st.groups[s.groupId]; if (g) g.shipIds = g.shipIds.filter(x => x !== s.id);
    delete st.ships[s.id]; fixed++;
  }
  for (const c of Object.values(st.commanders)) {
    if (!isExclusiveCommander(c)) continue;
    if (led && c.id === led.commander) { if (c.owner !== led.company) { c.owner = led.company; c.stationId = null; fixed++; } continue; }
    for (const g of Object.values(st.groups)) if (g.commanderId === c.id) g.commanderId = null;
    delete st.commanders[c.id]; fixed++;
  }
  // BB commands only its owner's groups
  if (led) for (const g of Object.values(st.groups)) if (g.commanderId === led.commander && g.owner !== led.company) { g.commanderId = null; fixed++; }
  // exclusive equipment exists only fitted on the exclusive hull
  const scrub = (c: Record<string, number> | undefined) => { if (c) for (const k of Object.keys(c)) if (isExclusiveEquip(k)) { delete c[k]; fixed++; } };
  for (const x of Object.values(st.stations)) {
    for (const c of Object.values(x.storage)) scrub(c);
    if (x.market) for (const k of Object.keys(x.market)) if (isExclusiveEquip(k)) { delete x.market[k]; fixed++; }
    if (x.listings) { const n = x.listings.length; x.listings = x.listings.filter(l => !isExclusiveEquip(l.item)); fixed += n - x.listings.length; }
    if (x.shipListings) { const n = x.shipListings.length; x.shipListings = x.shipListings.filter(l => !isExclusiveShip(st.ships[l.ship])); fixed += n - x.shipListings.length; }
    if (x.builds) { const n = x.builds.length; x.builds = x.builds.filter(b => b.classId !== BBEX_CLASS && !isExclusive(b.hull)); fixed += n - x.builds.length; }
    if (x.shipStock) for (const k of Object.keys(x.shipStock)) if (isExclusive(k)) { delete x.shipStock[k]; fixed++; }
  }
  for (const s of Object.values(st.ships)) {
    scrub(s.cargo);
    if (isExclusiveShip(s)) continue;
    if (s.fitting) for (const part of [s.fitting.hp, s.fitting.bay]) for (const k of Object.keys(part)) if (isExclusiveEquip(part[k])) { delete part[k]; fixed++; }
    if (s.fit?.some(isExclusiveEquip)) { s.fit = s.fit.filter(k => !isExclusiveEquip(k)); fixed++; }
  }
  for (const co of Object.values(st.companies)) {
    for (const c of Object.values(co.pendingLoot ?? {})) scrub(c);
    if (co.fitPresets?.some(p => isExclusive(p.hull))) { co.fitPresets = co.fitPresets.filter(p => !isExclusive(p.hull)); fixed++; }
  }
  return fixed;
}

/** BB-EX was destroyed in battle: it is not deleted and nothing drops. The same hull reconstitutes at
 *  the owner's home port; until then it cannot leave, and BB is out of action. */
export function exclusiveLost(h: ExclusiveHost, s: WShip): void {
  const st = h.st, led = ledgerOf(st);
  const home = homeStation(st, s.owner);
  s.hp = 0.05; s.engagement = undefined; s.vel = { x: 0, y: 0, z: 0 }; s.warp = undefined; s.cargo = { ore: 0, alloy: 0, crystal: 0 }; delete s.cargoOrigins;
  s.state = 'space'; s.task = { k: 'none' };
  if (home) { s.pos = { ...home.pos }; h.dockShip(s, home); }
  const until = h.time + EXCLUSIVE_RECOVER_S;
  s.recover = { until };
  if (led && led.ship === s.id) { led.state = 'recovering'; led.recoverUntil = until; led.losses++; }
  const cm = led ? st.commanders[led.commander] : undefined;
  if (cm) cm.injuredUntil = Math.max(cm.injuredUntil, h.time + BB_INJURED_S);
  h.ev('warn', `BB-EX 격침. 함체는 소실되지 않았다 — ${home?.name ?? '모항'}에서 자율 재구성 중 (${Math.round(EXCLUSIVE_RECOVER_S / 60)}분). BB는 ${Math.round(BB_INJURED_S / 60)}분간 전투 불능.`, { company: s.owner, pos: home?.pos, tag: 'exclusive' });
}

/** recovery finishes on its own (called once a second) */
export function stepExclusive(h: ExclusiveHost): void {
  const st = h.st, led = ledgerOf(st);
  if (!led || led.state !== 'recovering') return;
  const s = st.ships[led.ship];
  if (!s) return;
  if (h.time < (led.recoverUntil ?? 0)) return;
  led.state = 'active'; delete led.recoverUntil;
  delete s.recover; s.hp = Math.max(s.hp, 1);
  h.ev('milestone', 'BB-EX 재구성 완료. 출항 가능.', { company: s.owner, tag: 'exclusive' });
}

/** why a command is refused because it would touch exclusive content (null = not our business) */
export function exclusiveGuard(st: WorldState, company: string, cmd: Record<string, unknown> & { c: string }): string | null {
  const ship = typeof cmd.ship === 'string' ? st.ships[cmd.ship] : undefined;
  const NO = '세계 유일 계정 전용 콘텐츠 — 이 작업은 할 수 없습니다';
  // nobody builds, buys or queues the hull
  if (cmd.classId === BBEX_CLASS || isExclusive(cmd.hull as string) || isExclusive(cmd.variant as string) || isExclusive(cmd.preset as string)) {
    if (cmd.c === 'buyShip' || cmd.c === 'buildShip') return 'BB-EX는 건조하거나 구매할 수 없습니다 (세계 유일 · 설계도 없음)';
    if (!ship || !isExclusiveShip(ship)) return NO;
  }
  // exclusive equipment never moves as an item
  for (const k of ['res', 'item', 'recipe', 'bp', 'blueprint']) if (isExclusiveEquip(cmd[k])) return 'BB-EX 전용 장비는 생산·거래·운송할 수 없습니다';
  for (const part of [cmd.hp, cmd.bay] as (Record<string, unknown> | undefined)[]) if (part && typeof part === 'object' && Object.values(part).some(isExclusiveEquip) && !(ship && isExclusiveShip(ship))) return 'BB-EX 전용 장비는 다른 함선에 장착할 수 없습니다';
  if (Array.isArray(cmd.fit) && cmd.fit.some(isExclusiveEquip) && !(ship && isExclusiveShip(ship))) return 'BB-EX 전용 장비는 다른 함선에 장착할 수 없습니다';
  if (ship && isExclusiveShip(ship)) {
    if (ship.owner !== company) return NO;
    // its structure and equipment are fixed; it is never offered for sale
    if (['listShip', 'refit', 'fit', 'fitShip', 'savePreset'].includes(cmd.c)) return cmd.c === 'listShip' ? 'BB-EX는 판매·양도할 수 없습니다' : 'BB-EX의 전용 장비는 분리하거나 교체할 수 없습니다';
  }
  if (cmd.c === 'buyShipListing') {
    const l = (st.stations[cmd.station as string]?.shipListings ?? []).find(x => x.id === cmd.listing);
    if (l && isExclusiveShip(st.ships[l.ship])) return NO;
  }
  const cm = typeof cmd.commander === 'string' ? st.commanders[cmd.commander] : undefined;
  if (cm && isExclusiveCommander(cm)) {
    if (cm.owner !== company) return NO;
    if (cmd.c === 'dismiss' || cmd.c === 'hire') return 'BB는 해임하거나 이적시킬 수 없습니다';
  }
  return null;
}

/** public summary for clients (who holds the unique ship — everyone may know; the account id is not sent) */
export const exclusiveStatus = (st: WorldState) => { const l = ledgerOf(st); return l ? { company: l.company, state: l.state, recoverUntil: l.recoverUntil, losses: l.losses } : null; };
