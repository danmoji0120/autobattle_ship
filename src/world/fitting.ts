// Fitting V2 (growth P2): real equipment items on hardpoints and internal bays, checked against the
// hull's size/type/mount rules, power supply and mass capacity. Pure functions — the server (sim.ts)
// applies them with inventory moves, the client uses them to preview and explain.
//
// A player ship on contentV ≥ 2 carries `fitting`; it is the source of truth for its weapons and
// modules. `loadoutId` stays as a label (closest legacy preset) and `fit` mirrors the bay modules so
// older code paths (cruise speed, combat fx, census) keep working unchanged.
import { CONTENT, legacyOf, layoutMounts, variantLayout, type Registry } from '../content/registry';
import { arcOf, bayAccepts, fitTotals, hpAccepts } from '../content/rules';
import type { HardpointDef } from '../content/schema';
import { EQUIPMENT } from './industry';
import { getLoadout, type LoadoutDef, type MountDef } from '../sim/data/ships';

export interface ShipFitting {
  /** hardpoint id → EQUIPMENT id (weapons) */
  hp: Record<string, string>;
  /** internal bay id → EQUIPMENT id (modules) */
  bay: Record<string, string>;
  /** hull preset (or company preset) it was last set from, if unchanged since */
  preset?: string;
  /** (loadoutId|fit) this fitting was written with — lets newer code notice edits made by older code */
  sig?: string;
}

export interface FitReport {
  errors: string[];
  /** per hardpoint/bay id: why the item there is not allowed */
  bad: Record<string, string>;
  power: number; supply: number; mass: number; cap: number;
}

export const legacySig = (loadoutId: string, fit: string[] | undefined) => `${loadoutId}|${(fit ?? []).join(',')}`;

/** every rule a fitting must satisfy on this variant */
export function checkFitting(variantId: string, f: ShipFitting, reg: Registry = CONTENT): FitReport {
  const lay = variantLayout(variantId, reg);
  const rep: FitReport = { errors: [], bad: {}, power: 0, supply: 0, mass: 0, cap: 0 };
  if (!lay) { rep.errors.push(`알 수 없는 선체 변형 "${variantId}"`); return rep; }
  for (const [id, eq] of Object.entries(f.hp)) {
    const hp = lay.hardpoints.find(x => x.id === id);
    const why = !hp ? '이 선체에 없는 하드포인트' : !Object.hasOwn(EQUIPMENT, eq) ? `알 수 없는 장비 "${eq}"` : hpAccepts(hp, eq, reg);
    if (why) { rep.bad[id] = why; rep.errors.push(`${id}: ${why}`); }
  }
  for (const [id, eq] of Object.entries(f.bay)) {
    const bay = lay.internals.find(x => x.id === id);
    const why = !bay ? '이 선체에 없는 내부 베이' : !Object.hasOwn(EQUIPMENT, eq) ? `알 수 없는 장비 "${eq}"` : bayAccepts(bay, eq, reg);
    if (why) { rep.bad[id] = why; rep.errors.push(`${id}: ${why}`); }
  }
  const t = fitTotals(reg, lay.hull.id, f.hp, f.bay)!;
  Object.assign(rep, t);
  if (t.power > t.supply) rep.errors.push(`전력 초과 — 필요 ${t.power} / 공급 ${t.supply}`);
  if (t.mass > t.cap) rep.errors.push(`적재 초과 — 질량 ${t.mass} / 한도 ${t.cap}`);
  return rep;
}

/** item counts of a fitting (what is physically on the ship) */
export function fittingItems(f: ShipFitting | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of [...Object.values(f?.hp ?? {}), ...Object.values(f?.bay ?? {})]) out[id] = (out[id] ?? 0) + 1;
  return out;
}

/** modules in bay order (mirrored into WShip.fit) */
export function bayModules(variantId: string, f: ShipFitting, reg: Registry = CONTENT): string[] {
  const lay = variantLayout(variantId, reg);
  return (lay?.internals ?? []).map(b => f.bay[b.id]).filter((x): x is string => !!x);
}

/** put modules into the first free bay that accepts each (in the given order) */
export function placeModules(variantId: string, mods: string[], reg: Registry = CONTENT): { bay: Record<string, string>; unplaced: string[] } {
  const lay = variantLayout(variantId, reg);
  const bay: Record<string, string> = {}; const unplaced: string[] = [];
  // typed bays first so universal bays stay free for what only fits there
  const bays = [...(lay?.internals ?? [])].sort((a, b) => (a.kind === 'special' ? 1 : 0) - (b.kind === 'special' ? 1 : 0));
  for (const m of mods) {
    const b = bays.find(x => !bay[x.id] && !bayAccepts(x, m, reg));
    if (b) bay[b.id] = m; else unplaced.push(m);
  }
  return { bay, unplaced };
}

/** the fitting an old (classId, loadoutId, fit) ship physically has */
export function fittingFromLegacy(classId: string, loadoutId: string, fit: string[] | undefined, reg: Registry = CONTENT): { variant: string; hull: string; fitting: ShipFitting; unplaced: string[] } | null {
  const m = legacyOf(classId, loadoutId, reg); if (!m) return null;
  const p = reg.presets[m.preset];
  const { bay, unplaced } = placeModules(m.variant, fit ?? [], reg);
  return { hull: m.hull, variant: m.variant, fitting: { hp: { ...p.weapons }, bay, preset: m.preset, sig: legacySig(getLoadout(classId, loadoutId).id, fit) }, unplaced };
}

/** P15.1: the combat computer fitted in a ship's bays, as the battle needs it (ShipSpec.cpu). The
 *  hull has one computer bay; should a variant ever carry more, the first bay in id order counts. */
export function cpuOfFitting(f: ShipFitting | undefined): import('../sim/ai/computer').CpuSpec | undefined {
  if (!f) return undefined;
  for (const id of Object.keys(f.bay).sort()) {
    const c = EQUIPMENT[f.bay[id]]?.cpu;
    if (c) return { id: f.bay[id], arch: c.arch, ...(c.react !== undefined ? { react: c.react } : {}) };
  }
  return undefined;
}

/** combat mounts of a fitting (same shape as LoadoutDef.mounts) */
export const fittingMounts = (variantId: string, f: ShipFitting, reg: Registry = CONTENT): MountDef[] => layoutMounts(variantId, f.hp, reg);

/** the hull preset whose weapons match this fitting exactly (for labels and the legacy loadoutId) */
export function matchingPreset(variantId: string, f: ShipFitting, reg: Registry = CONTENT): string | undefined {
  const k = (o: Record<string, string>) => JSON.stringify(Object.entries(o).sort());
  return Object.values(reg.presets).find(p => p.variant === variantId && k(p.weapons) === k(f.hp))?.id;
}

/** legacy loadout id that best describes a fitting (exact preset if any, else the variant's base) */
export function loadoutLabel(classId: string, variantId: string, f: ShipFitting, reg: Registry = CONTENT): string {
  const pid = matchingPreset(variantId, f, reg);
  const m = Object.values(reg.legacy).find(l => l.preset === pid) ?? Object.values(reg.legacy).find(l => l.classId === classId && l.variant === variantId);
  return m?.loadoutId ?? getLoadout(classId, '').id;
}

/** difference between two item sets: what must come from storage (+) and what goes back (−) */
export function itemDelta(cur: Record<string, number>, nxt: Record<string, number>): Record<string, number> {
  const d: Record<string, number> = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(nxt)])) { const n = (nxt[k] ?? 0) - (cur[k] ?? 0); if (n) d[k] = n; }
  return d;
}

/** a clean copy: only string values, no empty slots */
export function normFitting(f: { hp?: Record<string, unknown>; bay?: Record<string, unknown> } | undefined): ShipFitting {
  const clean = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.length > 0 && k.length <= 24)) as Record<string, string>;
  return { hp: clean(f?.hp), bay: clean(f?.bay) };
}

/** what a ship looks like / fights with: its fitting's mounts if it has one, else its legacy loadout */
export function shipLoadout(s: { classId: string; loadoutId: string; variant?: string; fitting?: ShipFitting }, reg: Registry = CONTENT): LoadoutDef {
  const base = getLoadout(s.classId, s.loadoutId);
  if (!s.fitting || !s.variant) return base;
  const v = reg.variants[s.variant];
  // an unchanged legacy preset keeps the legacy mount order (mount order feeds targeting and the
  // battle RNG, so this keeps old ships' battles bit-identical); custom fittings use hardpoint order
  const pid = matchingPreset(s.variant, s.fitting, reg);
  const leg = pid && Object.values(reg.legacy).find(l => l.preset === pid && l.classId === s.classId);
  const mounts = leg ? getLoadout(s.classId, leg.loadoutId).mounts : fittingMounts(s.variant, s.fitting, reg);
  const h = v ? reg.hulls[v.hull] : undefined;
  // hull stats × variant mods; mk1 hulls have no stats, so their values stay exactly the variant's
  const mul = (a?: number, b?: number) => a == null ? b : b == null ? a : a * b;
  // render-only: silhouette override and the external model (variant model, else the hull's); combat
  // never reads it. mk1 hulls of legacy worlds have neither, so their loadouts stay exactly as before.
  const model = (v?.model ?? h?.mesh.model) || undefined;
  const mesh = h && (h.mesh.base !== s.classId || model) ? { base: h.mesh.base, scale: h.mesh.scale, ...(model ? { model } : {}) } : undefined;
  return { id: base.id, name: v?.name ?? base.name, desc: '', mounts, hpMul: mul(h?.stats?.hpMul, v?.mods?.hpMul), armorMul: mul(h?.stats?.armorMul, v?.mods?.armorMul), speedMul: mul(h?.stats?.speedMul, v?.mods?.speedMul), costDelta: base.costDelta, ...(mesh ? { mesh } : {}) };
}
/** cache key for a ship's model (changes when its weapons move) */
export const shipLoadoutKey = (s: { classId: string; loadoutId: string; variant?: string; fitting?: ShipFitting }) =>
  s.fitting ? `${s.classId}:${s.variant}:${Object.entries(s.fitting.hp).sort().map(e => e.join('=')).join(',')}` : `${s.classId}:${s.loadoutId}`;

/** the weapons a (draft) fitting carries, as the combat-computer band calculation reads them (UI summary) */
export function cpuMountsOf(lay: { hardpoints: HardpointDef[] }, hp: Record<string, string | undefined>): { weapon: string; facing: number; arc: number }[] {
  return lay.hardpoints.flatMap(h => { const eq = hp[h.id], w = eq ? EQUIPMENT[eq]?.weapon : undefined; return w ? [{ weapon: w, facing: h.facing, arc: arcOf(h, eq!) }] : []; });
}
