// Station industry engine: power, storage capacity, production orders and jobs.
//
// Rules (server-authoritative; the client uses the same read-only helpers to display them):
//  - Production happens only at a company's own station, from that company's storage there.
//  - An order says what to make and how much: `count` (make n batches, then finish) or `stock`
//    (keep at least n of the output in storage). Orders are served in queue order.
//  - A facility kind has (built instances × lines) parallel lines. A free line takes the first order
//    for its kind whose recipe is researched, whose target isn't met, whose inputs are ALL in storage
//    and whose output still fits in the warehouse. The inputs are taken out of storage at that moment
//    (so nothing can spend them twice) and the output appears when the job finishes.
//  - Speed = power factor × research × support facilities. Sized stations can also stop at zero power;
//    legacy stations retain their original 25% floor.
//  - Every order carries `why`: the exact reason it is not producing right now.

import { emit } from './observe';
import { stationFx } from './officers';
import type { Station, Cargo, Company, WorldState } from './types';
import { qty, addc, cargoSum, hasAll } from './types';
import { FACILITIES, RECIPES, ITEMS, itemName, recipeFor, techFx, type RecipeDef } from './industry';
import { stationSize, stationBerths, occupiedBerths } from './stations';
import { storeUsed, takesSpace, logisticsReservedSpace } from './storage';

export interface ProdOrder { id: string; recipe: string; mode: 'count' | 'stock'; n: number; done: number; paused?: boolean; why?: string; /** Obsolete P9.7 development-save field; never changes a new batch's inputs. */ legacyRecipe?: true }
export interface ProdJob { id: string; order: string; recipe: string; fac: string; left: number; total: number;
  /** output fixed when the batch started (only stored when it differs from the static recipe) */
  out?: Record<string, number> }

export const builtCount = (st: Station, kind: string) => st.modules.filter(m => m.kind === kind && m.built).length;
export const facLines = (st: Station, kind: string) => builtCount(st, kind) * (FACILITIES[kind]?.lines ?? 1);

export function stationPower(st: Station) {
  let supply = 0, demand = 0;
  for (const m of st.modules) {
    if (!m.built) continue;
    const p = m.kind === 'core' && stationSize(st) ? stationSize(st)!.power : FACILITIES[m.kind]?.power ?? 0;
    if (p >= 0) supply += p; else demand -= p;
  }
  const factor = demand <= 0 ? 1 : Math.max(stationSize(st) ? 0 : 0.25, Math.min(1, supply / demand));
  return { supply, demand, factor };
}

/** Instantaneous support services cannot run fractionally; old stations keep their prior rules. */
export const stationSupportOnline = (st: Station) => !stationSize(st) || stationPower(st).factor >= 1;

export function storageCap(st: Station): number {
  let cap = 0;
  for (const m of st.modules) if (m.built) cap += m.kind === 'core' && stationSize(st) ? stationSize(st)!.storage : FACILITIES[m.kind]?.storage ?? 0;
  return cap;
}

/** company-wide production speed at this station */
export function prodSpeed(st: Station, co: Company | undefined): number {
  const fx = techFx(co?.tech);
  return stationPower(st).factor * fx.prodMul * (builtCount(st, 'habitat') ? 1.1 : 1);
}

export function recipeOk(r: RecipeDef, co: Company | undefined) { return !r.tech || !!co?.tech?.includes(r.tech); }

const fmt = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();
/** first missing input of a recipe, as text */
export function shortText(store: Cargo, need: Record<string, number>, mul = 1): string | null {
  const miss = Object.entries(need).filter(([k, n]) => qty(store, k) < n * mul - 1e-9).map(([k, n]) => `${itemName(k)} ${fmt(n * mul - qty(store, k))}`);
  return miss.length ? miss.join(', ') : null;
}

/** units of recipe output already queued in running jobs for this order */
const inflight = (jobs: ProdJob[], o: ProdOrder) => jobs.filter(j => j.order === o.id).length;
const mainOut = (r: RecipeDef) => Object.keys(r.out)[0];

/** does the order still want another batch? (and why not) */
export function orderWants(o: ProdOrder, store: Cargo, jobs: ProdJob[], world?: { regionalV?: number }): string | null {
  const r = recipeFor(world, o.recipe) ?? RECIPES[o.recipe];
  if (o.mode === 'count') return o.done + inflight(jobs, o) >= o.n ? '완료' : null;
  const have = qty(store, mainOut(r)) + inflight(jobs, o) * r.out[mainOut(r)];
  return have >= o.n ? `목표 재고 도달 (${fmt(qty(store, mainOut(r)))}/${o.n})` : null;
}

export interface ProdEvent { kind: 'done' | 'finished'; recipe: string; order: string }

/**
 * Advance one station's production by dt seconds. Mutates storage, orders and jobs.
 * Returns what finished (for notifications).
 */
export function stepProduction(st: Station, co: Company | undefined, dt: number, world?: WorldState): ProdEvent[] {
  const out: ProdEvent[] = [];
  const orders = (st.orders ??= []);
  const jobs = (st.jobs ??= []);
  if (!orders.length && !jobs.length) return out;
  const store = (st.storage[st.owner] ??= { ore: 0, alloy: 0, crystal: 0 });
  // B-1: the station director's production and material-saving skills (only at the station they direct)
  const ofx = world?.officerV ? stationFx(world, st.id) : undefined;
  const speed = prodSpeed(st, co) * (ofx?.prod ? 1 + ofx.prod : 1);
  const sized = !!stationSize(st);
  const logisticsHeld = logisticsReservedSpace(world, st.id, st.owner);
  const capacity = sized ? storageCap(st) : 0;
  const space = (cargo: Record<string, number>) => Object.entries(cargo).reduce((n, [item, amount]) => n + (takesSpace(item) ? amount : 0), 0);
  // 1) running jobs
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    j.left -= dt * speed;
    if (j.left > 0) continue;
    const r = RECIPES[j.recipe], made = j.out ?? r.out;
    if (sized && (speed <= 0 || storeUsed(store) + logisticsHeld + space(made) > capacity + 1e-9)) {
      j.left = 0;
      continue; // The completed batch remains in its job until power and output space return.
    }
    for (const [k, n] of Object.entries(made)) { addc(store, k, n); if (world) emit(world, { kind: 'produce', reason: 'industry', amount: n, company: co?.id, station: st.id, item: k }); }
    jobs.splice(i, 1);
    const o = orders.find(x => x.id === j.order);
    if (o) {
      o.done++;
      if (o.mode === 'count' && o.done >= o.n) { orders.splice(orders.indexOf(o), 1); out.push({ kind: 'finished', recipe: r.id, order: o.id }); }
    }
    out.push({ kind: 'done', recipe: r.id, order: j.order });
  }
  // 2) free lines take the first order they can serve
  const cap = storageCap(st);
  const used = cargoSum(store) + logisticsHeld;
  let projected = sized ? storeUsed(store) + logisticsHeld + jobs.reduce((n, j) => n + space(j.out ?? RECIPES[j.recipe]?.out ?? {}), 0) : 0;
  const busy: Record<string, number> = {};
  for (const j of jobs) busy[j.fac] = (busy[j.fac] ?? 0) + 1;
  for (const o of orders) {
    const r = recipeFor(world, o.recipe);
    if (!r) { o.why = '알 수 없는 레시피'; continue; }
    if (o.paused) { o.why = '일시 정지'; continue; }
    if (!recipeOk(r, co)) { o.why = `연구 필요`; continue; }
    if (sized && speed <= 0) { o.why = '전력 부족 — 자재와 작업 보존'; continue; }
    if (sized && jobs.some(j => j.order === o.id && j.left <= 0)) { o.why = '창고 가득 — 완성품 보관 공간 대기'; continue; }
    const lines = facLines(st, r.fac);
    if (!lines) { o.why = `${FACILITIES[r.fac]?.name ?? r.fac} 없음`; continue; }
    let started = 0;
    for (;;) {
      const want = orderWants(o, store, jobs, world);
      if (want) { o.why = inflight(jobs, o) ? '가동 중' : want; break; }
      if ((busy[r.fac] ?? 0) >= lines) { o.why = inflight(jobs, o) ? '가동 중' : `${FACILITIES[r.fac].name} 라인 사용 중 — 대기`; break; }
      const sh = shortText(store, r.in);
      if (sh) { o.why = inflight(jobs, o) ? `가동 중 · 다음 배치 원료 부족: ${sh}` : `원료 부족: ${sh}`; break; }
      const outN = Object.values(r.out).reduce((a, b) => a + b, 0) - Object.values(r.in).reduce((a, b) => a + b, 0);
      // During preserved overflow, consuming a net-reducing batch is safe even if that batch
      // alone cannot clear the entire overflow. Completed output still waits for actual space.
      if (sized ? projected - space(r.in) + space(r.out) > Math.max(cap, projected) + 1e-9 : cap > 0 && used + outN > cap) { o.why = `창고 가득 (${fmt(sized ? storeUsed(store) : used)}/${fmt(cap)})`; break; }
      for (const [k, n] of Object.entries(r.in)) {
        // material saving: a share of each input comes back, in whole units, accumulated per station (never more than was used)
        let back = 0;
        if (ofx?.saveIn) { const acc = (st.ofSave ??= {}); acc[k] = (acc[k] ?? 0) + n * ofx.saveIn; back = Math.min(n, Math.floor(acc[k] + 1e-9)); acc[k] -= back; }
        addc(store, k, -(n - back)); if (world) emit(world, { kind: 'consume', reason: 'industry', amount: n - back, company: co?.id, station: st.id, item: k });
      }
      if (sized) projected += space(r.out) - space(r.in);
      jobs.push({ id: `j${(st.seq = (st.seq ?? 0) + 1)}`, order: o.id, recipe: r.id, fac: r.fac, left: r.time, total: r.time, ...(r.out !== RECIPES[r.id]?.out ? { out: { ...r.out } } : {}) });
      busy[r.fac] = (busy[r.fac] ?? 0) + 1;
      o.why = '가동 중';
      if (++started > 50) break;
    }
  }
  return out;
}

/** per-facility load for the UI: lines, busy, waiting orders */
export function facilityLoad(st: Station) {
  const out: Record<string, { lines: number; busy: number; waiting: number }> = {};
  for (const m of st.modules) if (m.built && FACILITIES[m.kind]?.lines) out[m.kind] ??= { lines: facLines(st, m.kind), busy: 0, waiting: 0 };
  for (const j of st.jobs ?? []) (out[j.fac] ??= { lines: facLines(st, j.fac), busy: 0, waiting: 0 }).busy++;
  for (const o of st.orders ?? []) { const r = RECIPES[o.recipe]; if (r && o.why && o.why !== '가동 중' && !o.paused) (out[r.fac] ??= { lines: facLines(st, r.fac), busy: 0, waiting: 0 }).waiting++; }
  return out;
}

/** items the station's waiting orders lack right now (for auto supply hauling) */
export function stationNeeds(st: Station, world?: { regionalV?: number }): Record<string, number> {
  const store = st.storage[st.owner] ?? {};
  const need: Record<string, number> = {};
  for (const o of st.orders ?? []) {
    if (o.paused) continue;
    const r = recipeFor(world, o.recipe); if (!r) continue;
    if (orderWants(o, store, st.jobs ?? [], world)) continue;
    // aim for two batches of each input
    for (const [k, n] of Object.entries(r.in)) { const lack = n * 2 - qty(store, k); if (lack > 0) need[k] = Math.max(need[k] ?? 0, lack); }
  }
  return need;
}

export { hasAll, ITEMS };

// ───────────────────────────────────────────────────────── shipyards

import type { ShipBuild } from './types';
import { HULLS, loadoutEquipment, EQUIPMENT, TECHS } from './industry';
import { SHIP_CLASSES, getLoadout } from '../sim/data/ships';
import { hullBuild, hullEcon, berthFits, PRE_P9631_YARD } from './hullops';
import { CONTENT } from '../content/registry';

export const YARD_NAME = ['', '소형', '중형', '대형', '초대형'];
/** build slots at a station: one per built yard, with its size class */
export function yardSlots(st: Station): { kind: string; size: number }[] {
  return st.modules.filter(m => m.built && FACILITIES[m.kind]?.yard).map(m => ({ kind: m.kind, size: FACILITIES[m.kind].yard! })).sort((a, b) => a.size - b.size);
}
/** everything a hull build consumes when it starts: hull parts (+ variant parts) + the preset's or
 *  loadout's weapons + fitted modules */
export function buildNeeds(classId: string, loadoutId: string, fit: string[], b?: { hull?: string; variant?: string; preset?: string; regionalMaterials?: Cargo; hp?: Record<string, string>; bay?: Record<string, string> }): Record<string, number> {
  const need: Record<string, number> = { ...(b?.hull ? hullBuild(b.hull, b.variant).parts : HULLS[classId]?.parts ?? {}) };
  for (const [k, n] of Object.entries(b?.regionalMaterials ?? {})) need[k] = (need[k] ?? 0) + n;
  // an explicit launch fitting: exactly its weapons and bay items (real items from storage, never free)
  if (b?.hp) { for (const k of [...Object.values(b.hp), ...Object.values(b.bay ?? {})]) need[k] = (need[k] ?? 0) + 1; }
  else for (const [k, n] of Object.entries(buildWeapons(classId, loadoutId, b?.preset))) need[k] = (need[k] ?? 0) + n;
  for (const k of fit) need[k] = (need[k] ?? 0) + 1;
  return need;
}
/** weapon items a build mounts: its hull preset (growth builds) or its legacy loadout */
export function buildWeapons(classId: string, loadoutId: string, preset?: string): Record<string, number> {
  const p = preset ? CONTENT.presets[preset] : undefined;
  if (!p) return loadoutEquipment(getLoadout(classId, loadoutId).mounts);
  const out: Record<string, number> = {};
  for (const k of Object.values(p.weapons)) out[k] = (out[k] ?? 0) + 1;
  return out;
}
/** yard size / research / facilities of a queued build */
export const buildSpec = (b: ShipBuild) => {
  const id = b.hull ?? `${b.classId}_mk1`;
  return hullBuild(id, b.variant, !!b.hull, b.requiredYard ?? PRE_P9631_YARD[id]);
};
export const fitUnits = (fit: string[]) => fit.reduce((a, k) => a + (EQUIPMENT[k]?.size ?? 1), 0);
export const hullName = (classId: string) => { const c = SHIP_CLASSES[classId]; return c ? `${c.name} ${c.type}` : classId; };

/** which slot each started build occupies (smallest that fits, queue order) */
function assignSlots(st: Station): Map<string, number> {
  const slots = yardSlots(st);
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const b of st.builds ?? []) {
    if (!b.started) continue;
    const need = buildSpec(b).yard;
    const i = slots.findIndex((s, j) => !used.has(j) && s.size >= need);
    if (i >= 0) { used.add(i); out.set(b.id, i); }
  }
  return out;
}

export function buildSpeed(st: Station, co: Company | undefined) { return stationPower(st).factor * techFx(co?.tech).buildMul; }

/** advance a station's ship construction; returns builds that just completed (removed from the queue) */
export function stepBuilds(st: Station, co: Company | undefined, dt: number, world?: WorldState): ShipBuild[] {
  const q = st.builds;
  if (!q?.length) return [];
  const store = (st.storage[st.owner] ??= { ore: 0, alloy: 0, crystal: 0 });
  const slots = yardSlots(st);
  const taken = assignSlots(st);
  const used = new Set(taken.values());
  const speed = buildSpeed(st, co) * (world?.officerV ? 1 + (stationFx(world, st.id).build ?? 0) : 1);
  const done: ShipBuild[] = [];
  for (const b of [...q]) {
    const h = buildSpec(b);
    if (b.started) {
      if (b.paused) { b.why = '일시 정지 (슬롯 유지)'; continue; }
      if (!taken.has(b.id)) { b.why = '조선소 슬롯 없음'; continue; }
      if (stationSize(st) && speed <= 0) { b.why = '전력 부족 — 건조 중단'; continue; }
      b.left -= dt * speed;
      b.why = `건조 중 — ${FACILITIES[slots[taken.get(b.id)!].kind].name}`;
      if (b.left <= 0) {
        const limit = stationBerths(st);
        if (limit !== undefined && world && occupiedBerths(world, st.id) + done.length >= limit) { b.left = 0; b.why = '정박 공간 대기 — 완성된 선체 보존'; continue; }
        q.splice(q.indexOf(b), 1); done.push(b);
      }
      continue;
    }
    if (b.paused) { b.why = '일시 정지'; continue; }
    if (stationSize(st) && speed <= 0) { b.why = '전력 부족 — 부품 보존'; continue; }
    if (stationSize(st) && !berthFits(st, hullEcon(b.hull ?? `${b.classId}_mk1`, b.variant).berth)) { b.why = '이 정거장의 정박 규격으로 수용할 수 없는 선체'; continue; }
    const noTech = (h.tech ?? []).filter(t => !co?.tech?.includes(t));
    if (noTech.length) { b.why = `설계 연구 필요: ${noTech.map(t => TECHS[t]?.name ?? t).join(', ')}`; continue; }
    const noFac = (h.facilities ?? []).filter(f => !st.modules.some(m => m.built && m.kind === f));
    if (noFac.length) { b.why = `필요 시설 없음: ${noFac.map(f => FACILITIES[f]?.name ?? f).join(', ')}`; continue; }
    if (!slots.some(s => s.size >= h.yard)) { b.why = `${YARD_NAME[h.yard]} 이상 조선소 필요`; continue; }
    const i = slots.findIndex((s, j) => !used.has(j) && s.size >= h.yard);
    if (i < 0) { b.why = '조선소 슬롯 사용 중 — 순서 대기'; continue; }
    const need = buildNeeds(b.classId, b.loadoutId, b.fit, b);
    const sh = shortText(store, need);
    if (sh) {
      // say so when construction plans are taking the same goods first (they reserve as materials arrive)
      const rivals = Object.keys(need).filter(k => qty(store, k) < need[k] && st.modules.some(m => !m.built && (m.reserved?.[k] ?? 0) > 0));
      b.why = `부품 부족: ${sh}${rivals.length ? ` — ${rivals.map(itemName).join(', ')}을(를) 건설 계획이 먼저 확보 중` : ''}`;
      continue;
    }
    for (const [k, n] of Object.entries(need)) { addc(store, k, -n); if (world) emit(world, { kind: 'consume', reason: 'ship_construction', amount: n, company: co?.id, station: st.id, item: k }); }
    b.started = true; used.add(i); taken.set(b.id, i);
    b.why = `건조 시작 — ${FACILITIES[slots[i].kind].name}`;
  }
  return done;
}
