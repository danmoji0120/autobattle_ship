// P13.1 battlefield wrecks (salvageV worlds). A wreck is a persistent world object made from ships that
// were actually destroyed: the surviving part of their real cargo, the equipment that was really fitted on
// them, and the scrap of their hulls. Nothing is invented and nothing is copied per company: every company
// that reaches a wreck works the same lots, and whatever is taken leaves the wreck at that moment.
// Large battles are merged into a few wreck fields (clustered by where the ships died) so 200 losses do
// not become 200 objects. Wrecks decay after a while; what is left then is gone for good.
// See docs/P13_1_SALVAGE.md.
import type { Cargo, V, WShip, WorldState } from './types';
import { cargoKeys, qty } from './types';
import { emit } from './observe';
import { shipValue } from './data';
import { SALVAGE_MIX } from './economy';
import { fittingItems } from './fitting';
import { EQUIPMENT, ITEMS, loadoutEquipment } from './industry';
import { getLoadout } from '../sim/data/ships';
import { isExclusiveEquip, isExclusiveShip } from './exclusive';
import { wreckFragments } from './blueprints';
import { assetReferenceValue } from './valuation';
import { econOf } from './hullops';
import { sysAt } from './geom';

/** tunables (tested values; see docs §3) */
export const WRECK_CFG = {
  /** share of a destroyed ship's cargo that survives in the wreck (civilian / military hull) */
  cargoSurvive: { civil: 0.5, military: 0.35 },
  /** ± spread of that share per ship (deterministic from the world RNG) */
  cargoSpread: 0.15,
  /** chance that one fitted equipment unit survives intact */
  equipSurvive: 0.3,
  /** hull scrap per ship = shipValue × this (the legacy battle-debris field used the same 2.2) */
  hullScrap: 2.2,
  /** ships destroyed within this distance of a wreck field's centre join it */
  clusterR: 1500,
  /** at most this many wreck fields per engagement (more are merged into the nearest) */
  maxFields: 6,
  /** lifetime: base + per ship, capped */
  lifeBase: 7200, lifePerShip: 600, lifeMax: 4 * 3600,
} as const;

export type LotKind = 'cargo' | 'equip' | 'hull' | 'frag';
/** one recoverable quantity: a kind of goods of one original owner */
export interface WreckLot { id: string; k: LotKind; item: string; n: number; owner: string }
export interface WreckSource { ship: string; owner: string; classId: string; hull?: string; variant?: string; at: number }
export interface WreckSite {
  id: string;
  name: string;
  /** engagement that produced it */
  eng: string;
  system: string;
  pos: V;
  created: number;
  expires: number;
  sources: WreckSource[];
  lots: WreckLot[];
  /** total units at creation (for progress) */
  initial: number;
  /** what each company recovered (units by item) — server-side bookkeeping, not replicated to others */
  taken: Record<string, Record<string, number>>;
  /** companies that know what is in it (engagement sides, ships that came close) */
  seen: string[];
  /** unauthorised recovery of cargo, by company: value taken (crime bookkeeping) */
  crime?: Record<string, number>;
}

/** what the salvage engine needs of anything it recovers from: a battlefield wreck or (P13.2) jettisoned cargo */
export type SalvSite = Pick<WreckSite, 'id' | 'name' | 'system' | 'pos' | 'created' | 'expires' | 'lots' | 'initial' | 'taken' | 'seen' | 'crime'>;
/** a recoverable site by id: wrecks first, then jettisoned cargo (P13.2) */
export const siteOf = (st: WorldState, id: string | undefined): SalvSite | undefined => id === undefined ? undefined : st.wrecks?.[id] ?? (st.drops?.[id] as SalvSite | undefined);
export const allSites = (st: WorldState): SalvSite[] => st.drops ? [...Object.values(st.wrecks ?? {}), ...Object.values(st.drops) as SalvSite[]] : Object.values(st.wrecks ?? {});

export const wreckUnits = (w: Pick<WreckSite, 'lots'>) => w.lots.reduce((n, l) => n + l.n, 0);
export const lotValue = (st: WorldState, l: Pick<WreckLot, 'item'>) => l.item.startsWith('bpf:') ? 500 : assetReferenceValue(st, l.item);

/** what a destroyed ship physically carried / had fitted (exclusive content never) */
function equipmentOf(s: WShip): Record<string, number> {
  const raw = s.fitting ? fittingItems(s.fitting) : loadoutEquipment(getLoadout(s.classId, s.loadoutId).mounts);
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(raw)) if (EQUIPMENT[k] && !isExclusiveEquip(k) && n > 0) out[k] = n;
  return out;
}

export interface DeadShip { ship: WShip; pos: V }
interface Draft { pos: V; ships: DeadShip[] }

/** group dead ships into at most `maxFields` wreck fields by where they died */
function cluster(dead: DeadShip[]): Draft[] {
  const out: Draft[] = [];
  for (const d of dead) {
    let best: Draft | null = null, bd = Infinity;
    for (const c of out) { const dd = Math.hypot(c.pos.x - d.pos.x, c.pos.z - d.pos.z); if (dd < bd) { bd = dd; best = c; } }
    if (best && (bd <= WRECK_CFG.clusterR || out.length >= WRECK_CFG.maxFields)) {
      const n = best.ships.length;
      best.pos = { x: (best.pos.x * n + d.pos.x) / (n + 1), y: (best.pos.y * n + d.pos.y) / (n + 1), z: (best.pos.z * n + d.pos.z) / (n + 1) };
      best.ships.push(d);
    } else out.push({ pos: { ...d.pos }, ships: [d] });
  }
  return out;
}

/**
 * Build the wreck fields of one finished engagement. Idempotent per engagement (ids derive from it).
 * Must be called before the dead ships are deleted. Emits: lost cargo as consume/combat_cargo_loss,
 * surviving cargo as salvage/to_wreck (it changes hands from the ship to the wreck, nothing is created).
 */
export function makeWrecks(st: WorldState, engId: string, dead: DeadShip[], time: number, rng: () => number, sides: string[]): WreckSite[] {
  const wrecks = (st.wrecks ??= {});
  if (Object.values(wrecks).some(w => w.eng === engId)) return [];
  const usable = dead.filter(d => !isExclusiveShip(d.ship));
  if (!usable.length) return [];
  const made: WreckSite[] = [];
  cluster(usable).forEach((c, k) => {
    const sys = sysAt(st.systems, c.pos);
    const lots = new Map<string, WreckLot>();
    const add = (kind: LotKind, item: string, n: number, owner: string) => {
      n = Math.floor(n + 1e-9); if (n <= 0) return;
      const key = `${kind}|${item}|${owner}`;
      const l = lots.get(key); if (l) l.n += n; else lots.set(key, { id: `l${lots.size}`, k: kind, item, n, owner });
    };
    const sources: WreckSource[] = [];
    for (const { ship: s } of c.ships) {
      sources.push({ ship: s.id, owner: s.owner, classId: s.classId, ...(s.hull ? { hull: s.hull } : {}), ...(s.variant ? { variant: s.variant } : {}), at: time });
      const meta = { company: s.owner, group: s.groupId, ship: s.id, system: sys?.id, ref: engId };
      // cargo: a share survives, the rest is destroyed with the ship
      const base = econOf(s).military ? WRECK_CFG.cargoSurvive.military : WRECK_CFG.cargoSurvive.civil;
      const share = Math.max(0, Math.min(0.85, base + (rng() * 2 - 1) * WRECK_CFG.cargoSpread));
      for (const item of cargoKeys(s.cargo)) {
        const have = qty(s.cargo, item); if (have <= 0) continue;
        const keep = Math.floor(have * share + 1e-9);
        if (keep > 0) { add('cargo', item, keep, s.owner); emit(st, { ...meta, kind: 'salvage', reason: 'to_wreck', item, amount: keep }); }
        if (have - keep > 0) emit(st, { ...meta, kind: 'consume', reason: 'combat_cargo_loss', item, amount: have - keep });
      }
      // fitted equipment: each unit survives intact or is wrecked
      for (const [item, n] of Object.entries(equipmentOf(s))) { let keep = 0; for (let i = 0; i < n; i++) if (rng() < WRECK_CFG.equipSurvive) keep++; add('equip', item, keep, s.owner); }
      // hull scrap: bounded by the ship's own value (same total as the legacy debris field)
      const scrap = shipValue(s.classId) * WRECK_CFG.hullScrap;
      for (const [item, w] of Object.entries(SALVAGE_MIX)) add('hull', item, scrap * w, s.owner);
      // blueprint fragments: pirate hulls only, as the legacy battle recovery did
      if (s.owner === 'pirates') for (const f of wreckFragments(rng, [s.classId])) add('frag', f, 1, s.owner);
    }
    const all = [...lots.values()];
    if (!all.length) return;
    const n = c.ships.length;
    const life = Math.min(WRECK_CFG.lifeMax, WRECK_CFG.lifeBase + WRECK_CFG.lifePerShip * n);
    const w: WreckSite = {
      id: `wk_${engId}_${k}`, name: `${sys?.name ?? '심우주'} 전장 잔해 ${String.fromCharCode(65 + k)}`, eng: engId, system: sys?.id ?? '',
      pos: { x: c.pos.x, y: c.pos.y, z: c.pos.z }, created: time, expires: time + life, sources, lots: all,
      initial: all.reduce((a, l) => a + l.n, 0), taken: {}, seen: [...new Set(sides.filter(x => st.companies[x]?.kind === 'player'))],
    };
    wrecks[w.id] = w; made.push(w);
    for (const l of all) if (l.k !== 'cargo') emit(st, { kind: 'salvage', reason: `wreck_${l.k}`, item: l.item, amount: l.n, company: l.owner, system: w.system, ref: w.id });
  });
  return made;
}

/** remove exhausted / expired wrecks; what is left in an expired wreck is gone (consume/wreck_decay) */
export function expireWrecks(st: WorldState, time: number): WreckSite[] {
  const gone: WreckSite[] = [];
  for (const w of Object.values(st.wrecks ?? {})) {
    w.lots = w.lots.filter(l => l.n > 0);
    if (w.lots.length && w.expires > time) continue;
    for (const l of w.lots) emit(st, { kind: 'consume', reason: 'wreck_decay', item: l.item, amount: l.n, company: l.owner, system: w.system, ref: w.id });
    delete st.wrecks![w.id]; gone.push(w);
  }
  return gone;
}

/** who may see the lots: sides of the battle and companies whose ships came within sensor range */
export const WRECK_SEEN_R = 8000;
export function markSeen(st: WorldState) {
  const ws = allSites(st); if (!ws.length) return;
  for (const s of Object.values(st.ships)) {
    if (st.companies[s.owner]?.kind !== 'player' || s.state === 'docked') continue;
    for (const w of ws) if (!w.seen.includes(s.owner) && Math.abs(w.pos.x - s.pos.x) < WRECK_SEEN_R && Math.hypot(w.pos.x - s.pos.x, w.pos.z - s.pos.z) < WRECK_SEEN_R) w.seen.push(s.owner);
  }
}

/** what a viewer gets: position, size and age for anyone (a battle is public news); contents only when seen */
export function wreckFor(w: WreckSite, company: string | undefined) {
  const known = !!company && w.seen.includes(company);
  const units = wreckUnits(w);
  const base = { id: w.id, name: w.name, eng: w.eng, system: w.system, pos: w.pos, created: w.created, expires: w.expires, initial: w.initial, ships: w.sources.length, size: units > 2000 ? 3 : units > 400 ? 2 : 1, left: known ? units : undefined };
  if (!known) return base;
  return { ...base, known: true, sources: w.sources, lots: w.lots, taken: company && w.taken[company] ? { [company]: w.taken[company] } : {} };
}
export type WreckView = ReturnType<typeof wreckFor> & { known?: true; sources?: WreckSource[]; lots?: WreckLot[]; taken?: Record<string, Cargo> };

export const itemLabel = (item: string) => item.startsWith('bpf:') ? '설계도 조각' : (ITEMS[item]?.name ?? EQUIPMENT[item]?.name ?? item);
