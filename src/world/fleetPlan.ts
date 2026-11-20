// P17.4d (AUD-12 / AUD-13): fleet goal lines, mixed-fleet templates and yard-aware parallel builds.
//
// AUD-12: the fleet goal could only name a hull and a count. The engine accepted a variant / preset but never checked
// them, the UI never sent them, and a company fitting preset (the screen's "save draft") could not be used. A goal now
// holds one or more lines — hull, structural variant, weapon preset or saved company fitting, count — validated here
// with the same rules the build command applies, so a goal never queues a design the yard would refuse.
//
// D2: a fleet template is a named list of lines kept by the company. Saving one costs nothing and needs no ship or
// yard (it is a design, not an order); a fleet goal can be created from it.
//
// AUD-13: a goal kept at most two hulls in flight whatever the station had. `yardCapacity` counts the yard slots that
// can take the line's hull, and the goal keeps one hull queued beyond them (so its parts are procured while the slots
// are busy). It stops adding while a queued hull of the goal is blocked by something more hulls cannot fix (parts,
// research, facilities, power); credits and spending limits are checked per hull by the existing authorisation.
import type { Company, Station, WorldState } from './types';
import { CONTENT, contentAvail, hullReleased } from '../content/registry';
import { yardSlots, buildNeeds } from './production';
import { yardHulls, yardShipPrice, hullSale } from './hullops';
import { yardFee } from './valuation';
import { qty } from './types';
import { hullBuild } from './hullops';
import { checkFitting } from './fitting';

export interface FleetLine { hull: string; variant?: string; preset?: string; /** a saved company fitting (Company.fitPresets id) */ fitPreset?: string; count: number }
export interface FleetTemplate { id: string; name: string; lines: FleetLine[] }

export const MAX_LINES = 8;
export const MAX_TEMPLATES = 20;
/** extra hulls a goal keeps queued beyond the yard slots that can build them */
export const QUEUE_AHEAD = 1;

const hasOwn = (o: object, k: unknown) => typeof k === 'string' && Object.hasOwn(o, k);

/** one line, normalised (variant resolved), or the reason it cannot be built */
export function normLine(w: Pick<WorldState, 'contentV'>, co: Company | undefined, x: unknown): FleetLine | string {
  const l = x as Partial<FleetLine> | null;
  if (!l || typeof l !== 'object') return '함대 구성 항목을 확인하세요';
  if (!hasOwn(CONTENT.hulls, l.hull)) return '선체를 확인하세요';
  const hull = CONTENT.hulls[l.hull!];
  if (hull.dev || hull.exclusive || hull.classId === 'platform' || (hull.preview && !hullReleased(hull.id))) return `${hull.name}: 건조할 수 없는 선체`;
  if (!Number.isSafeInteger(l.count) || l.count! < 1 || l.count! > 50) return '척수는 1–50';
  if (l.fitPreset !== undefined) {
    const fp = co?.fitPresets?.find(p => p.id === l.fitPreset);
    if (!fp) return '저장된 회사 피팅을 찾을 수 없습니다';
    if (fp.hull !== hull.id) return `회사 피팅 "${fp.name}"은(는) ${hull.name}용이 아님`;
    if (checkFitting(fp.variant, fp).errors.length) return `회사 피팅 "${fp.name}"을(를) 이 구조에 장착할 수 없음`;
    return { hull: hull.id, variant: fp.variant, fitPreset: fp.id, count: l.count! };
  }
  if (l.preset !== undefined && !hasOwn(CONTENT.presets, l.preset)) return '알 수 없는 무장 프리셋';
  const p = l.preset ? CONTENT.presets[l.preset] : undefined;
  const variant = l.variant ?? p?.variant ?? `${hull.id}_std`;
  if (!hasOwn(CONTENT.variants, variant) || CONTENT.variants[variant].hull !== hull.id) return '이 선체의 변형이 아님';
  if (!contentAvail(variant, w.contentV)) return '이 월드에서는 아직 사용할 수 없는 구조';
  if (p && (p.hull !== hull.id || p.variant !== variant)) return '이 선체 변형의 프리셋이 아님';
  return { hull: hull.id, variant, ...(p ? { preset: p.id } : {}), count: l.count! };
}

export function normLines(w: Pick<WorldState, 'contentV'>, co: Company | undefined, lines: unknown): FleetLine[] | string {
  if (!Array.isArray(lines) || !lines.length) return '함대 구성을 한 줄 이상 넣으세요';
  if (lines.length > MAX_LINES) return `함대 구성은 ${MAX_LINES}줄까지`;
  const out: FleetLine[] = [];
  for (const x of lines) { const l = normLine(w, co, x); if (typeof l === 'string') return l; out.push(l); }
  if (out.reduce((a, l) => a + l.count, 0) > 50) return '한 목표의 총 척수는 50척까지';
  return out;
}

export const lineName = (co: Company | undefined, l: FleetLine) => {
  const h = CONTENT.hulls[l.hull]?.name ?? l.hull;
  const fit = l.fitPreset ? co?.fitPresets?.find(p => p.id === l.fitPreset)?.name : l.preset ? CONTENT.presets[l.preset]?.name : undefined;
  const v = l.variant && l.variant !== `${l.hull}_std` ? CONTENT.variants[l.variant]?.name : undefined;
  return [h, v, fit].filter(Boolean).join(' · ');
};

/** yard slots at `st` big enough for the line's hull (0 = this station cannot build it) */
export function yardCapacity(st: Station, l: FleetLine): number {
  let need = 0; try { need = hullBuild(l.hull, l.variant).yard; } catch { return 0; }
  return yardSlots(st).filter(y => y.size >= need).length;
}

/** a queued (not started) build waits on something neither more hulls nor procurement can fix */
export const blockedQueue = (why: string | undefined) => !!why && /연구 필요|시설 없음|필요 시설|전력 부족|정박 규격|조선소 필요/.test(why);
/** a queued build waits on parts: procurement brings them, so a little queue ahead is useful (parts are planned for
 *  queued hulls), but no more than PARTS_AHEAD hulls wait on parts at once */
export const partsWait = (why: string | undefined) => !!why && /부품 부족/.test(why);
export const PARTS_AHEAD = 2;

// ── templates (free designs: no ship, no yard, no credits)
export function saveTemplate(w: Pick<WorldState, 'contentV'>, co: Company, name: unknown, lines: unknown, id: () => string): string | null {
  const ls = normLines(w, co, lines); if (typeof ls === 'string') return ls;
  const nm = String(name ?? '').trim().slice(0, 24) || '함대 구성';
  const list = (co.fleetTemplates ??= []);
  const same = list.find(t => t.name === nm);
  if (!same && list.length >= MAX_TEMPLATES) return `함대 구성 템플릿은 ${MAX_TEMPLATES}개까지`;
  if (same) same.lines = ls; else list.push({ id: id(), name: nm, lines: ls });
  return null;
}
export function deleteTemplate(co: Company, id: unknown): string | null {
  const list = co.fleetTemplates ?? []; const i = list.findIndex(t => t.id === id);
  if (i < 0) return '템플릿 없음';
  list.splice(i, 1); return null;
}

// ── D4: what a fleet costs before it is ordered, and what can be bought instead of built
type Host = { st: WorldState; canDock(st: Station, co: string): boolean };

/** public yards that sell this line ready-made (standard structure and weapons only: a company fitting is built) */
export function publicOffers(h: Host, owner: string, l: FleetLine): { station: string; name: string; price: number; stock: number }[] {
  if (l.fitPreset || CONTENT.variants[l.variant ?? '']?.blueprint !== 'common' || !hullSale(l.hull)) return [];
  if (l.preset && CONTENT.presets[l.preset]?.variant !== l.variant) return [];
  return Object.values(h.st.stations).filter(st => st.public && yardHulls(st).includes(l.hull) && h.canDock(st, owner))
    .map(st => ({ station: st.id, name: st.name, price: yardShipPrice(st, l.hull), stock: Math.floor(st.shipStock?.[l.hull]?.n ?? hullSale(l.hull)!.stock) }))
    .filter(o => o.price > 0 && o.stock > 0).sort((a, b) => a.price - b.price);
}

export interface FleetEstimate {
  lines: { name: string; count: number; perHull: number; build: number; buyable: number; buyPrice: number; yard: number }[];
  /** credits to lay every keel (labour + yard fee), and the cheapest purchase of what public yards stock now */
  buildCredits: number; buyCredits: number;
  /** parts and equipment the yard station needs for every hull, what its store holds, and the shortfall */
  needs: { item: string; need: number; have: number; short: number }[];
}
export function fleetEstimate(h: Host, owner: string, station: Station, lines: FleetLine[], buy = false): FleetEstimate {
  const co = h.st.companies[owner], need: Record<string, number> = {};
  const out: FleetEstimate = { lines: [], buildCredits: 0, buyCredits: 0, needs: [] };
  for (const l of lines) {
    const fp = l.fitPreset ? co?.fitPresets?.find(p => p.id === l.fitPreset) : undefined;
    let perHull = 0; try { const b = hullBuild(l.hull, l.variant); perHull = b.credits + yardFee(b); } catch { perHull = 0; }
    // buying first (the goal's "buy" option): the cheapest stocked yards, in price order
    let buyable = 0, buyPrice = 0;
    if (buy) for (const o of publicOffers(h, owner, l)) { const n = Math.min(o.stock, l.count - buyable); buyable += n; buyPrice += n * o.price; if (buyable >= l.count) break; }
    const build = l.count - buyable;
    const n1 = buildNeeds(CONTENT.hulls[l.hull].classId, '', [], { hull: l.hull, variant: l.variant, preset: fp ? undefined : l.preset, ...(fp ? { hp: fp.hp, bay: fp.bay } : {}) });
    for (const [k, n] of Object.entries(n1)) need[k] = (need[k] ?? 0) + n * build;
    out.lines.push({ name: lineName(co, l), count: l.count, perHull, build, buyable, buyPrice, yard: yardCapacity(station, l) });
    out.buildCredits += perHull * build; out.buyCredits += buyPrice;
  }
  const store = station.storage[owner];
  out.needs = Object.entries(need).map(([item, n]) => ({ item, need: n, have: qty(store, item), short: Math.max(0, n - qty(store, item)) })).sort((a, b) => b.short - a.short || a.item.localeCompare(b.item));
  return out;
}
