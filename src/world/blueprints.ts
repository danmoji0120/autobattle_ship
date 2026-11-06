// Blueprints (growth P6): production rights, held per company, independent of research and of ship
// ownership. Owning a ship never needs a blueprint; *building* one needs the hull's blueprint (and a
// non-common variant's), the research it requires, a yard, the facilities, parts and yard time.
// Acquisition sources are data (content BlueprintDef.sources): shop / commercial / faction /
// contract / salvage fragments / unique. Pure helpers + the few state changes they imply.
import { CONTENT, blueprintsFor } from '../content/registry';
import type { BlueprintDef, BlueprintSource } from '../content/schema';
import { STARTER_BLUEPRINTS } from '../content/packs/growth/blueprints';
import type { Company, Station, WorldState } from './types';
import { qty, addc } from './types';
import { TECHS, ITEM_NAME_HOOKS } from './industry';
import { sysAt } from './geom';
import { hullBuild } from './hullops';
import { ensureInfluence } from './factions';

export { STARTER_BLUEPRINTS };
export const FRAG_PREFIX = 'bpf:';
export const fragId = (bp: string) => `${FRAG_PREFIX}${bp}`;
export const isFrag = (id: string) => id.startsWith(FRAG_PREFIX);
export const bpName = (id: string) => CONTENT.blueprints[id]?.name ?? id;
ITEM_NAME_HOOKS.push(id => id.startsWith(FRAG_PREFIX) ? `설계 조각: ${bpName(id.slice(FRAG_PREFIX.length))}` : undefined);
export const SRC_NAME: Record<BlueprintSource['kind'], string> = { shop: '일반 판매', commercial: '고가 상업 라이선스', faction: '세력 전용', contract: '계약 보상', salvage: '잔해 조각 복원', unique: '유일 설계' };

export const holds = (co: Company | undefined, bp: string) => !!co?.blueprints?.[bp];
/** the blueprint that lets a company build this hull (its own row, if any) */
export const hullBlueprint = (hullId: string) => blueprintsFor('hull', hullId)[0]?.id;
/** a variant needs its own blueprint unless it is common (then the hull's covers it) */
export function variantBlueprint(variantId: string): string | undefined {
  const v = CONTENT.variants[variantId];
  if (!v || v.blueprint === 'common') return undefined;
  return blueprintsFor('variant', variantId)[0]?.id ?? `bp_${variantId}`;
}

/** research a hull + variant build needs (hull build tech ∪ blueprint requirements) */
export function buildTech(hullId: string, variantId?: string): string[] {
  const t = new Set(hullBuild(hullId, variantId).tech ?? []);
  for (const id of [hullBlueprint(hullId), variantId && variantBlueprint(variantId)]) for (const r of (id && CONTENT.blueprints[id]?.requires) || []) t.add(r);
  return [...t].filter(x => TECHS[x]);
}

/** production rights only (blueprints + research); yard, facilities and parts are checked by the yard */
export function rightsProblem(co: Company, hullId: string, variantId: string): string | null {
  const hb = hullBlueprint(hullId);
  if (!hb) return '이 선체는 설계도가 공개되지 않아 건조할 수 없습니다';
  if (!holds(co, hb)) return `설계도 필요: ${bpName(hb)}`;
  const vb = variantBlueprint(variantId);
  if (vb && !holds(co, vb)) return `변형 설계도 필요: ${bpName(vb)}`;
  const miss = buildTech(hullId, variantId).filter(t => !co.tech?.includes(t));
  if (miss.length) return `연구 필요: ${miss.map(t => TECHS[t]?.name ?? t).join(', ')}`;
  return null;
}

/** add a holding; respects unique limits. Returns false if it could not be granted. */
export function grantBlueprint(w: WorldState, co: Company, bp: string, src: string, t: number): boolean {
  const def = CONTENT.blueprints[bp]; if (!def) return false;
  if (holds(co, bp)) {
    // a limited-run licence bought again tops up its runs
    if (def.runs && co.blueprints![bp].runs !== undefined) co.blueprints![bp].runs! += def.runs;
    return true;
  }
  const uq = def.sources.find(s => s.kind === 'unique') as Extract<BlueprintSource, { kind: 'unique' }> | undefined;
  if (uq && src === 'unique') {
    const holders = ((w.uniques ??= {})[bp] ??= []);
    if (holders.length >= uq.limit) return false;
    holders.push(co.id);
  }
  (co.blueprints ??= {})[bp] = { src, t, ...(def.runs ? { runs: def.runs } : {}) };
  return true;
}

/** a build used one run of a limited licence (perpetual blueprints are not consumed) */
export function useRun(co: Company, bp: string | undefined) {
  const h = bp ? co.blueprints?.[bp] : undefined;
  if (h?.runs !== undefined) { h.runs--; if (h.runs <= 0) delete co.blueprints![bp!]; }
}

export interface Offer { bp: BlueprintDef; src: BlueprintSource; price: number; why: string | null }
/** blueprints a station sells to this company (with the reason it cannot buy, if any) */
export function offersAt(w: WorldState, st: Station, co: Company): Offer[] {
  if (!st.public) return [];
  const sys = sysAt(w.systems, st.pos);
  if (sys) ensureInfluence(w, sys, w.time);
  const out: Offer[] = [];
  for (const bp of Object.values(CONTENT.blueprints)) {
    for (const src of bp.sources) {
      if (!('stations' in src) || !src.stations.includes(st.id)) continue;
      let why: string | null = null;
      if (holds(co, bp.id) && !bp.runs) why = '보유 중';
      else if (src.kind === 'commercial' && co.rep < src.rep) why = `연합 평판 ${src.rep} 필요 (현재 ${Math.floor(co.rep)})`;
      else if (src.kind === 'faction') {
        const inf = sys?.inf?.[src.faction] ?? 0;
        if (inf < src.influence) why = `${FACTION_NAME[src.faction]} 영향력 ${src.influence} 이상인 성계에서만 판매 (현재 ${Math.round(inf)})`;
        else if (src.rep !== undefined && co.rep < src.rep) why = `평판 ${src.rep} 필요 (현재 ${Math.floor(co.rep)})`;
      }
      if (!why && co.credits < src.price) why = `자금 부족 — ${Math.ceil(src.price - co.credits).toLocaleString()} cr 더 필요`;
      out.push({ bp, src, price: src.price, why });
      break;
    }
  }
  return out;
}
const FACTION_NAME = { union: '연합', guild: '상인 길드', pirates: '해적' } as const;

/** buy a blueprint at a public station. Credits go into the station's NPC budget (P4). */
export function buyBlueprint(w: WorldState, co: Company, st: Station, bp: string): string | null {
  const o = offersAt(w, st, co).find(x => x.bp.id === bp);
  if (!o) return '이 정거장에서 판매하지 않는 설계도';
  if (o.why) return o.why;
  co.credits -= o.price;
  st.funds = Math.min((st.fundsMax ?? 0) * 1.5, (st.funds ?? 0) + o.price * 0.5);
  grantBlueprint(w, co, bp, o.src.kind, w.time);
  return null;
}

/** salvage fragments needed to restore a blueprint (if it has a salvage source) */
export const fragmentsNeeded = (bp: string) => (CONTENT.blueprints[bp]?.sources.find(s => s.kind === 'salvage') as Extract<BlueprintSource, { kind: 'salvage' }> | undefined)?.fragments;

/** assemble salvaged fragments stored at a station into the blueprint */
export function assembleBlueprint(w: WorldState, co: Company, st: Station, bp: string): string | null {
  const need = fragmentsNeeded(bp);
  if (!need) return '조각으로 복원할 수 없는 설계도';
  if (holds(co, bp)) return '이미 보유한 설계도';
  const S = st.storage[co.id];
  const have = Math.floor(qty(S, fragId(bp)) + 1e-9);
  if (have < need) return `설계 조각 부족 (${have}/${need})`;
  addc(S, fragId(bp), -need);
  grantBlueprint(w, co, bp, 'salvage', w.time);
  return null;
}

/** fragments a wreck can yield (pirate wrecks of a class can carry its blueprints' fragments) */
export function wreckFragments(rng: () => number, classIds: string[]): string[] {
  const out: string[] = [];
  for (const bp of Object.values(CONTENT.blueprints)) {
    const s = bp.sources.find(x => x.kind === 'salvage') as Extract<BlueprintSource, { kind: 'salvage' }> | undefined;
    if (!s) continue;
    const cls = bp.target.kind === 'hull' ? CONTENT.hulls[bp.target.id]?.classId : bp.target.kind === 'variant' ? CONTENT.hulls[CONTENT.variants[bp.target.id]?.hull]?.classId : undefined;
    // fragments come from wrecks of the same class or bigger fights (any class for variants/equipment)
    const n = cls ? classIds.filter(c => c === cls).length : classIds.length > 3 ? 1 : 0;
    for (let i = 0; i < n; i++) if (rng() < s.chance) out.push(fragId(bp.id));
  }
  return out;
}

/** blueprints awarded for a lair contract of this tier (contract + unique sources) */
export function contractAwards(w: WorldState, co: Company, tier: number, rng: () => number): string[] {
  const got: string[] = [];
  for (const bp of Object.values(CONTENT.blueprints)) {
    if (holds(co, bp.id)) continue;
    for (const s of bp.sources) {
      if (s.kind === 'contract' && tier >= s.minTier && rng() < s.chance && grantBlueprint(w, co, bp.id, 'contract', w.time)) { got.push(bp.id); break; }
      if (s.kind === 'unique' && tier >= s.minTier && grantBlueprint(w, co, bp.id, 'unique', w.time)) { got.push(bp.id); break; }
    }
  }
  return got;
}

/** blueprints a company may build from (owned, usable now or after research) — for UI lists */
export function ownedBlueprints(co: Company): { bp: BlueprintDef; runs?: number; src: string }[] {
  return Object.entries(co.blueprints ?? {}).map(([id, h]) => ({ bp: CONTENT.blueprints[id], runs: h.runs, src: h.src })).filter(x => !!x.bp);
}
