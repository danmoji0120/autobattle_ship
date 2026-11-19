// Content validator: referential integrity, fitting compatibility, value ranges, legacy fidelity and
// asset registration. Pure — file access is injected so it runs in tests and in the CLI
// (scripts/content-check.ts, `npm run content:check`). Errors block a merge; warnings are review notes.
import { isExtraMeshBase } from './meshBases';
import { PUBLIC_BERTH, P10_PUBLIC_STATIONS } from '../world/hullops';
import { SHIP_CLASSES, getLoadout } from '../sim/data/ships';
import { COMMANDERS } from '../sim/data/commanders';
import { EQUIPMENT, ITEMS, FACILITIES, HULLS, TECHS, RECIPES } from '../world/industry';
import { placeModules } from '../world/fitting';
import { FACTION_IDS, ASSET_KINDS, BLUEPRINT_GRADES, HARDPOINT_TYPES, INTERNAL_KINDS, MOUNT_STYLES, SIZES, type AssetKind, type HardpointDef } from './schema';
import { presetMounts, variantLayout, INSTALLED_EQUIPMENT, type Registry } from './registry';
import { hpAccepts, fitTotals } from './rules';
import { validateArsenal } from './validateArsenal';
import { CPU_ARCHS } from '../sim/ai/computer';
import { validateModels } from './validateModels';

export interface Issue { level: 'error' | 'warn'; where: string; msg: string }

export interface AssetFs {
  /** byte size of public/assets/content/<file>, or null if missing */
  size(file: string): number | null;
  /** every file under public/assets/content/ (relative, forward slashes) */
  list(): string[];
  /** file bytes (models are inspected), or null if missing */
  read?(file: string): Uint8Array | null;
  /** SHA-256 hex of the file, or null if missing */
  sha256?(file: string): string | null;
}

const ID = /^[a-z][a-z0-9_]{1,47}$/;
const HP_ID = /^[a-z][a-z0-9_]{1,23}$/;

export { weaponType } from './rules';

/** every multiset of legacy modules with Σ size ≤ slots (what fitShip allowed before P2) */
const setCache = new Map<number, string[][]>();
export function legacyModuleSets(slots: number): string[][] {
  const hit = setCache.get(slots); if (hit) return hit;
  const mods = Object.values(EQUIPMENT).filter(e => e.kind === 'module' && !e.growth);   // the pre-P2 module set
  const go = (n: number, from: number): string[][] => {
    const out: string[][] = [[]];
    for (let i = from; i < mods.length; i++) if (mods[i].size <= n) for (const r of go(n - mods[i].size, i)) out.push([mods[i].id, ...r]);
    return out;
  };
  const r = go(slots, 0); setCache.set(slots, r); return r;
}
/** legacy helper kept for tests: can this combat weapon go on this hardpoint? */
export function weaponFits(weapon: string, hp: HardpointDef): string | null {
  const eq = Object.values(EQUIPMENT).find(e => e.weapon === weapon);
  if (!eq) return `알 수 없는 무기 "${weapon}"`;
  return hpAccepts({ ...hp, arcBy: undefined }, eq.id);
}

export const ASSET_RULES: Record<AssetKind, { dir: string; ext: string[]; maxBytes: number; target: string }> = {
  'ship-model': { dir: 'models/', ext: ['.glb'], maxBytes: 2 * 1024 * 1024, target: 'hull' },
  'variant-model': { dir: 'models/', ext: ['.glb'], maxBytes: 2 * 1024 * 1024, target: 'variant' },
  'model-lod': { dir: 'models/', ext: ['.glb'], maxBytes: 768 * 1024, target: 'asset' },
  portrait: { dir: 'portraits/', ext: ['.webp', '.png'], maxBytes: 300 * 1024, target: 'commander' },
  'equipment-icon': { dir: 'icons/', ext: ['.svg', '.webp', '.png'], maxBytes: 64 * 1024, target: 'equipment' },
  'item-icon': { dir: 'icons/', ext: ['.svg', '.webp', '.png'], maxBytes: 64 * 1024, target: 'item' },
  'facility-icon': { dir: 'icons/', ext: ['.svg', '.webp', '.png'], maxBytes: 64 * 1024, target: 'facility' },
};

const sameMounts = (a: { weapon: string; pos: number[]; facing: number; arc: number }[], b: typeof a) => {
  const k = (m: (typeof a)[number]) => `${m.weapon}|${m.pos.join(',')}|${m.facing}|${m.arc}`;
  return JSON.stringify(a.map(k).sort()) === JSON.stringify(b.map(k).sort());
};

export function validateContent(reg: Registry, fs?: AssetFs): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, msg: string) => out.push({ level: 'error', where, msg });
  const warn = (where: string, msg: string) => out.push({ level: 'warn', where, msg });
  for (const d of reg.dupes) err('registry', `중복 id: ${d}`);
  validateArsenal(reg, err, warn);
  const packOf = (kind: string, id: string) => reg.origin[`${kind}:${id}`];

  // ── hulls
  for (const h of Object.values(reg.hulls)) {
    const at = `hull ${h.id}`;
    if (!ID.test(h.id)) err(at, 'id 형식: 소문자·숫자·_ 2~48자, 영문자로 시작');
    const cls = SHIP_CLASSES[h.classId];
    if (!cls) err(at, `classId "${h.classId}" 가 SHIP_CLASSES에 없음`);
    if (![1, 2, 3, 4].includes(h.tier)) err(at, `tier ${h.tier} (1~4)`);
    if (!SIZES.includes(h.size)) err(at, `size "${h.size}"`);
    if (!BLUEPRINT_GRADES.includes(h.blueprint)) err(at, `blueprint "${h.blueprint}"`);
    if (!Number.isInteger(h.moduleSlots) || h.moduleSlots < 0 || h.moduleSlots > 12) err(at, `moduleSlots ${h.moduleSlots} (0~12 정수)`);
    if (!SHIP_CLASSES[h.mesh?.base] && !isExtraMeshBase(h.mesh?.base)) err(at, `mesh.base "${h.mesh?.base}" 는 렌더러 실루엣(함급 id 또는 EXTRA_MESH_BASES)이어야 함`);
    if (!(h.mesh?.scale > 0.2 && h.mesh.scale < 5)) err(at, `mesh.scale ${h.mesh?.scale} (0.2~5)`);
    if (h.mesh?.model) { const a = reg.assets[h.mesh.model]; if (!a) err(at, `mesh.model 에셋 "${h.mesh.model}" 미등록`); else if (a.kind !== 'ship-model' || a.for !== h.id) err(at, `mesh.model "${a.id}" 는 이 선체용 ship-model 이어야 함`); }
    if (!h.name?.trim() || !h.desc?.trim()) err(at, '이름·설명 필수');
    const reach = cls ? (cls.length / 2) * (h.mesh?.scale ?? 1) * 1.25 + 4 : 999;
    const seen = new Set<string>();
    for (const p of h.hardpoints) checkHardpoint(`${at}/${p.id}`, p, seen, reach);
    const seenI = new Set<string>();
    for (const s of h.internals) {
      if (!HP_ID.test(s.id) || seenI.has(s.id) || seen.has(s.id)) err(`${at}/${s.id}`, '내부 슬롯 id 형식 오류 또는 중복');
      seenI.add(s.id);
      if (!INTERNAL_KINDS.includes(s.kind)) err(`${at}/${s.id}`, `kind "${s.kind}"`);
      if (!SIZES.includes(s.size)) err(`${at}/${s.id}`, `size "${s.size}"`);
    }
    if (cls && cls.role !== 'civilian' && h.classId !== 'platform' && !h.hardpoints.some(p => p.type !== 'pd')) warn(at, '전투함인데 주무장 하드포인트가 없음');
  }
  function checkHardpoint(at: string, p: HardpointDef, seen: Set<string>, reach: number) {
    if (!HP_ID.test(p.id)) err(at, '하드포인트 id 형식 (소문자·숫자·_, 2~24자)');
    if (seen.has(p.id)) err(at, '하드포인트 id 중복'); seen.add(p.id);
    if (!Array.isArray(p.pos) || p.pos.length !== 3 || !p.pos.every(Number.isFinite)) err(at, 'pos 는 [x,y,z] 숫자');
    else if (Math.hypot(...p.pos) > reach) err(at, `pos ${JSON.stringify(p.pos)} 가 선체 범위(${reach.toFixed(0)}) 밖`);
    if (!(p.facing >= -180 && p.facing <= 180)) err(at, `facing ${p.facing} (-180~180)`);
    if (!(p.arc > 0 && p.arc <= 180)) err(at, `arc ${p.arc} (0 초과 180 이하)`);
    if (!SIZES.includes(p.size)) err(at, `size "${p.size}"`);
    if (!HARDPOINT_TYPES.includes(p.type)) err(at, `type "${p.type}"`);
    if (!MOUNT_STYLES.includes(p.mount)) err(at, `mount "${p.mount}"`);
    for (const [eq, a] of Object.entries(p.arcBy ?? {})) {
      if (!EQUIPMENT[eq]?.weapon) err(at, `arcBy 의 "${eq}" 는 무장 장비가 아님`);
      if (!(a > 0 && a <= p.arc)) err(at, `arcBy.${eq} = ${a} (0 초과, arc ${p.arc} 이하)`);
    }
    // P16: an H (hangar) hardpoint is a flight-deck launch point, and only an H hardpoint is
    if ((p.type === 'hangar') !== (p.mount === 'deck')) err(at, '격납(H) 하드포인트는 mount "deck", deck 마운트는 격납(H) 하드포인트만');
    if (p.mount === 'spinal' && p.arc > 15) warn(at, `spinal 마운트의 arc ${p.arc}° 는 넓음 (≤15 권장)`);
    if (p.mount === 'fixed' && p.arc > 45) warn(at, `fixed 마운트의 arc ${p.arc}° 는 넓음 (≤45 권장)`);
  }

  // ── equipment fitting rules: every equipment item needs exactly one spec
  // built-in equipment needs a spec in this registry; pack equipment is checked with its own pack
  for (const e of Object.values(EQUIPMENT)) if (!reg.equipment[e.id] && !(INSTALLED_EQUIPMENT.has(e.id) && !reg.arms[e.id] && !reg.modules[e.id] && !reg.exArms[e.id] && !reg.exModules[e.id])) err(`equipment ${e.id}`, '피팅 규격(EquipSpec) 없음');
  for (const id of reg.exclusive) if ((reg.exArms[id] || reg.exModules[id]) && (reg.packs.find(p => p.id === packOf(reg.exArms[id] ? 'arm' : 'module', id))?.minContentV ?? 0) < 3) err(`equipment ${id}`, '계정 전용 장비는 minContentV 3 팩에만');
  for (const e of Object.values(reg.equipment)) {
    const at = `equipment ${e.id}`, item = EQUIPMENT[e.id];
    if (!item) { err(at, 'EQUIPMENT 에 없는 장비'); continue; }
    if (!SIZES.includes(e.size)) err(at, `size "${e.size}"`);
    if (item.kind === 'weapon' && e.slot !== 'hardpoint') err(at, '무장은 slot: hardpoint');
    if (item.kind === 'module' && !INTERNAL_KINDS.includes(e.slot as any)) err(at, `모듈의 slot "${e.slot}" 은 내부 베이 종류여야 함`);
    // industrial hardpoint gear: an industrial module does exactly one kind of work, nothing else does any
    const mc = reg.modules[e.id];
    if (mc && (mc.slot === 'industrial') !== !!mc.ind) err(at, '산업 장비(slot industrial)는 ind(작업 종류·효율)가 반드시 있어야 하고, 다른 모듈에는 없어야 함');
    if (mc?.ind && (!['mine', 'build', 'salvage', 'repair'].includes(mc.ind.work) || !(mc.ind.rate > 0 && mc.ind.rate <= 100))) err(at, `ind ${JSON.stringify(mc.ind)}`);
    // P15.1 combat computers: a computer module runs exactly one behaviour, nothing else has one
    if (mc && (mc.slot === 'computer') !== !!mc.cpu) err(at, '전투 컴퓨터(slot computer)는 cpu(행동 원형)가 반드시 있어야 하고, 다른 모듈에는 없어야 함');
    if (mc?.cpu && (!CPU_ARCHS.includes(mc.cpu.arch) || mc.cpu.arch === 'basic' || (mc.cpu.react !== undefined && !(mc.cpu.react >= 0.3 && mc.cpu.react <= 4)))) err(at, `cpu ${JSON.stringify(mc.cpu)} (행동 원형 swarm/picket/line/artillery/siege/carrier, react 0.3~4초)`);
    if (mc?.cpu && Object.keys(mc.fx).length) err(at, '전투 컴퓨터는 수치 효과(fx)를 갖지 않는다 — 행동만 바꾼다');
    // P16 aviation modules: a flight-bay module carries exactly an air spec, nothing else has one
    if (mc && (mc.slot === 'flight') !== !!mc.air) err(at, '항공 장비(slot flight)는 air(항공 효과)가 반드시 있어야 하고, 다른 모듈에는 없어야 함');
    if (mc?.air) {
      const a = mc.air, keys = Object.keys(a);
      if (!keys.length) err(at, 'air 효과가 비어 있음');
      for (const k of keys) if (!['complement', 'spares', 'control', 'turnaround'].includes(k)) err(at, `알 수 없는 항공 효과 "${k}"`);
      if (a.complement !== undefined && !(Number.isInteger(a.complement) && a.complement >= 1 && a.complement <= 6)) err(at, `air.complement ${a.complement} (정수 1~6)`);
      if (a.control !== undefined && !(Number.isInteger(a.control) && a.control >= 1 && a.control <= 4)) err(at, `air.control ${a.control} (정수 1~4)`);
      if (a.spares !== undefined && !(a.spares >= 1 && a.spares <= 2)) err(at, `air.spares ${a.spares} (배율 1~2)`);
      if (a.turnaround !== undefined && !(a.turnaround >= 0.5 && a.turnaround < 1)) err(at, `air.turnaround ${a.turnaround} (배율 0.5 이상 1 미만)`);
      if (Object.keys(mc.fx).length) err(at, '항공 장비는 함선 수치 효과(fx)를 갖지 않는다 — 함재기 운용만 바꾼다');
    }
    if (reg.exclusive.has(e.id)) {
      // nothing may produce, unlock or consume exclusive equipment
      if (RECIPES[e.id] || Object.values(RECIPES).some(r => r.out[e.id] || r.in[e.id]) || Object.values(reg.recipes).some(r => r.out[e.id] || r.in[e.id])) err(at, '계정 전용 장비에는 생산·소모 레시피가 없어야 함');
      if (item.tech) err(at, '계정 전용 장비에는 해금 연구가 없어야 함');
      if (Object.values(reg.hulls).some(h => h.build?.parts[e.id]) || Object.values(reg.variants).some(v => v.parts?.[e.id])) err(at, '계정 전용 장비를 건조 부품으로 쓸 수 없음');
      if (Object.values(reg.blueprints).some(b => b.target.id === e.id)) err(at, '계정 전용 장비에는 설계도를 두지 않음');
    }
    if (!(e.mass >= 0 && e.mass <= 200)) err(at, `mass ${e.mass} (0~200)`);
    if (!(e.power >= -200 && e.power <= 200)) err(at, `power ${e.power} (-200~200)`);
    if (e.power < 0 && e.slot !== 'reactor') warn(at, '전력 공급(음수 power)은 보통 reactor 장비');
    for (const m of e.mounts ?? []) if (!MOUNT_STYLES.includes(m)) err(at, `mounts "${m}"`);
  }
  for (const h of Object.values(reg.hulls)) {
    if (!(h.power >= 0 && h.power <= 1000)) err(`hull ${h.id}`, `power ${h.power} (0~1000)`);
    if (!(h.mass > 0 && h.mass <= 3000)) err(`hull ${h.id}`, `mass ${h.mass} (0 초과 3000 이하)`);
  }

  // ── growth data (P3/P4/P6): build, upkeep, sale, ops, stats
  const STATIONS = [...Object.keys(PUBLIC_BERTH), ...P10_PUBLIC_STATIONS];
  const known = (k: string) => !!(ITEMS[k] || EQUIPMENT[k]);
  for (const h of Object.values(reg.hulls)) {
    const at = `hull ${h.id}`;
    for (const [k, v] of Object.entries(h.stats ?? {})) if (!(v! >= 0.5 && v! <= 1.6)) err(at, `stats.${k} ${v} (0.5~1.6)`);
    if (h.ops) {
      const o = h.ops;
      if (o.berth && !SIZES.includes(o.berth)) err(at, `ops.berth "${o.berth}"`);
      for (const k of ['cruise', 'cargo', 'mine', 'build', 'minField'] as const) if (o[k] !== undefined && !(o[k]! >= 0)) err(at, `ops.${k} ${o[k]}`);
      for (const [k, v] of Object.entries(o.bonus ?? {})) if (!['mine', 'build', 'salvage'].includes(k) || !(v! >= 0.5 && v! <= 2)) err(at, `ops.bonus.${k} ${v} (mine/build/salvage, 0.5~2)`);
      // the standard industrial fit must fit the hull's industrial hardpoints and its power / mass
      if (o.gear?.length) {
        const bays = h.internals.filter(b => b.kind === 'industrial'), used = new Set<string>();
        for (const g of o.gear) {
          const m = reg.modules[g];
          // the gear may live in a pack not loaded here (core hulls name growth-pack gear): only a wrong module is an error
          if (!m) { warn(at, `ops.gear "${g}" 모듈이 로드된 팩에 없음`); continue; }
          if (!m.ind) { err(at, `ops.gear "${g}" 는 산업 장비가 아님`); continue; }
          const b = bays.find(x => !used.has(x.id) && SIZES.indexOf(x.size) >= SIZES.indexOf(m.size));
          if (b) used.add(b.id); else err(at, `ops.gear "${g}" 를 넣을 산업 하드포인트 없음`);
        }
      }
    }
    if (h.build) {
      const b = h.build;
      if (![1, 2, 3, 4].includes(b.yard)) err(at, `build.yard ${b.yard} (1~4)`);
      if (!(b.time > 0 && b.credits >= 0)) err(at, 'build.time > 0, build.credits ≥ 0');
      for (const k of Object.keys(b.parts)) if (!known(k)) err(at, `build.parts "${k}" 는 ITEMS/EQUIPMENT 에 없음`);
      for (const t of b.tech ?? []) if (!TECHS[t]) err(at, `build.tech "${t}" 없음`);
      for (const f of b.facilities ?? []) if (!FACILITIES[f]) err(at, `build.facilities "${f}" 없음`);
    } else if (!h.id.endsWith('_mk1') && !h.exclusive) err(at, 'mk1 이 아닌 선체는 build 필수');
    if (h.upkeep) for (const k of Object.keys(h.upkeep.supplies ?? {})) if (!known(k)) err(at, `upkeep.supplies "${k}" 없음`);
    if (h.sale) {
      for (const sid of h.sale.stations) if (!STATIONS.includes(sid)) err(at, `sale.stations "${sid}" 는 공영 정거장 id 가 아님`);
      if (!((h.sale.price === undefined || h.sale.price > 0) && h.sale.stock >= 1 && h.sale.restock > 0)) err(at, 'sale.price(선택) > 0, stock ≥ 1, restock > 0');
      const berth = h.ops?.berth;
      if (berth) for (const sid of h.sale.stations) if (PUBLIC_BERTH[sid] && SIZES.indexOf(PUBLIC_BERTH[sid]) < SIZES.indexOf(berth)) err(at, `sale.stations "${sid}" 의 정박 등급(${PUBLIC_BERTH[sid]})이 선체(${berth})보다 작음`);
    }
    if (h.exclusive) {
      // account-exclusive: no way into the economy may exist, not even an unobtainable placeholder
      if (h.sale) err(at, '계정 전용 선체는 판매(sale)할 수 없음');
      if (h.build) err(at, '계정 전용 선체에는 건조 조건(build)을 두지 않음');
      if (h.dev) err(at, '계정 전용 선체는 dev 선체가 아님');
      if (Object.values(reg.blueprints).some(b => b.target.id === h.id || reg.variants[b.target.id]?.hull === h.id)) err(at, '계정 전용 선체·변형에는 설계도를 두지 않음');
      if (Object.values(reg.legacy).some(l => l.hull === h.id)) err(at, '계정 전용 선체는 legacy 매핑에 넣지 않음');
      for (const v of Object.values(reg.variants)) if (v.hull === h.id && (v.parts || v.needs)) err(`variant ${v.id}`, '계정 전용 선체의 변형에는 건조 부품·조건을 두지 않음');
    } else if (h.preview) {
      // P16 preview hull: complete content the world does not release yet (HullDef.preview)
      if (h.sale) err(at, '미공개(preview) 선체는 판매(sale)할 수 없음');
      if (h.dev) err(at, '미공개(preview) 선체는 dev 선체가 아님');
      if ((reg.packs.find(p => p.id === packOf('hull', h.id))?.minContentV ?? 0) < 3) err(at, '미공개(preview) 선체는 minContentV 3 팩에만');
      const bps = Object.values(reg.blueprints).filter(b => b.target.id === h.id || reg.variants[b.target.id]?.hull === h.id);
      if (!bps.some(b => b.target.kind === 'hull')) err(at, '이 선체의 설계도(BlueprintDef target hull)가 없음 — 공개 후 건조 불가');
      // a random award (contract / salvage / exploration / unique) would draw from the world RNG for a hull nobody
      // may hold yet: station sources only, so the world's random sequence is the same with or without it
      for (const b of bps) for (const src of b.sources) if (!('stations' in src)) err(`blueprint ${b.id}`, `미공개(preview) 선체의 설계도는 정거장 판매 출처만 (${src.kind} 불가)`);
    } else if (h.dev) {
      if (h.sale) err(at, 'dev 선체는 판매(sale)할 수 없음');
      if (Object.values(reg.blueprints).some(b => b.target.kind === 'hull' && b.target.id === h.id)) err(at, 'dev 선체에는 설계도를 두지 않음 (획득 불가여야 함)');
      if ((reg.packs.find(p => p.id === packOf('hull', h.id))?.minContentV ?? 0) < 3) err(at, 'dev 선체는 minContentV 3 팩에만');
    } else if (h.classId !== 'platform' && !Object.values(reg.blueprints).some(b => b.target.kind === 'hull' && b.target.id === h.id)) (h.id.endsWith('_mk1') ? warn : err)(at, '이 선체의 설계도(BlueprintDef target hull)가 없음 — 건조 불가');
  }
  // ── blueprints
  for (const b of Object.values(reg.blueprints)) {
    const at = `blueprint ${b.id}`;
    if (!ID.test(b.id)) err(at, 'id 형식');
    if (!b.name?.trim() || !b.desc?.trim()) err(at, '이름·설명 필수');
    if (!BLUEPRINT_GRADES.includes(b.grade)) err(at, `grade "${b.grade}"`);
    const t = b.target;
    if (t.kind === 'hull' ? !reg.hulls[t.id] : t.kind === 'variant' ? !reg.variants[t.id] : !known(t.id)) err(at, `target ${t.kind} "${t.id}" 없음`);
    for (const r of b.requires ?? []) if (!TECHS[r]) err(at, `requires "${r}" 없음`);
    if (b.runs !== undefined && !(Number.isInteger(b.runs) && b.runs > 0)) err(at, `runs ${b.runs}`);
    if (!b.sources.length) warn(at, '획득 경로(sources) 없음');
    for (const s of b.sources) {
      if ('stations' in s) for (const sid of s.stations) if (!STATIONS.includes(sid)) err(at, `sources.${s.kind}.stations "${sid}" 없음`);
      if ('price' in s && !(s.price > 0)) err(at, `sources.${s.kind}.price ${s.price}`);
      if ('chance' in s && !(s.chance > 0 && s.chance <= 1)) err(at, `sources.${s.kind}.chance ${s.chance} (0~1)`);
      if (s.kind === 'salvage' && !(Number.isInteger(s.fragments) && s.fragments >= 2)) err(at, `salvage.fragments ${s.fragments} (정수 ≥ 2)`);
      if (s.kind === 'unique' && !(Number.isInteger(s.limit) && s.limit >= 1)) err(at, `unique.limit ${s.limit}`);
      if (s.kind === 'explore' && !(Number.isInteger(s.tier) && s.tier >= 1 && s.tier <= 3)) err(at, `explore.tier ${s.tier} (1~3)`);
      if (s.kind === 'faction') {
        if (!FACTION_IDS.includes(s.faction)) err(at, `faction.faction "${s.faction}" (${FACTION_IDS.join('/')})`);
        if (s.trust !== undefined && !(s.trust >= -100 && s.trust <= 100)) err(at, `faction.trust ${s.trust} (−100~100)`);
        if (s.contracts !== undefined && !(Number.isInteger(s.contracts) && s.contracts >= 1)) err(at, `faction.contracts ${s.contracts}`);
        if (s.repOnly && s.trust === undefined) err(at, 'faction.repOnly 판매처는 trust 필요');
      }
      if (s.kind === 'commercial' && s.credit !== undefined && !(s.credit >= 0 && s.credit <= 100)) err(at, `commercial.credit ${s.credit} (0~100)`);
      if (s.kind === 'commercial' && s.contracts !== undefined && !(Number.isInteger(s.contracts) && s.contracts >= 1)) err(at, `commercial.contracts ${s.contracts}`);
    }
  }
  for (const v of Object.values(reg.variants)) {
    for (const f of v.needs?.facilities ?? []) if (!FACILITIES[f]) err(`variant ${v.id}`, `needs.facilities "${f}" 없음`);
    for (const t of v.needs?.tech ?? []) if (!TECHS[t]) err(`variant ${v.id}`, `needs.tech "${t}" 없음`);
  }
  for (const v of Object.values(reg.variants)) if (v.blueprint !== 'common' && !Object.values(reg.blueprints).some(b => b.target.kind === 'variant' && b.target.id === v.id)) warn(`variant ${v.id}`, `${v.blueprint} 변형인데 변형 설계도가 없음 — 아직 얻을 수 없음`);

  // ── variants
  for (const v of Object.values(reg.variants)) {
    const at = `variant ${v.id}`;
    if (!ID.test(v.id)) err(at, 'id 형식');
    const h = reg.hulls[v.hull];
    if (!h) { err(at, `hull "${v.hull}" 없음`); continue; }
    if (!BLUEPRINT_GRADES.includes(v.blueprint)) err(at, `blueprint "${v.blueprint}"`);
    for (const id of v.hardpoints?.remove ?? []) if (!h.hardpoints.some(p => p.id === id)) err(at, `제거할 하드포인트 "${id}" 가 선체에 없음`);
    for (const id of v.internals?.remove ?? []) if (!h.internals.some(p => p.id === id)) err(at, `제거할 내부 슬롯 "${id}" 가 선체에 없음`);
    const lay = variantLayout(v.id, reg)!;
    const ids = new Set<string>();
    for (const p of v.hardpoints?.add ?? []) { if (h.hardpoints.some(x => x.id === p.id)) err(`${at}/${p.id}`, '추가 하드포인트 id 가 선체의 기존 id 와 겹침 (새 id 사용)'); }
    const cls = SHIP_CLASSES[h.classId];
    const reach = cls ? (cls.length / 2) * h.mesh.scale * 1.25 + 4 : 999;
    for (const p of v.hardpoints?.add ?? []) checkHardpoint(`${at}/${p.id}`, p, ids, reach);
    for (const [k, x] of Object.entries(v.mods ?? {})) if (!(typeof x === 'number' && x >= 0.5 && x <= 1.5)) err(at, `mods.${k} = ${x} (0.5~1.5)`);
    if (v.model) { const a = reg.assets[v.model]; if (!a) err(at, `model 에셋 "${v.model}" 미등록`); else if (a.kind !== 'variant-model' || a.for !== v.id) err(at, `model "${a.id}" 는 이 변형용 variant-model 이어야 함`); }
    if (!lay.hardpoints.length && cls?.role !== 'civilian') warn(at, '하드포인트가 하나도 없음');
    if (!v.name?.trim()) err(at, '이름 필수');
  }
  for (const h of Object.values(reg.hulls)) if (!Object.values(reg.variants).some(v => v.hull === h.id)) err(`hull ${h.id}`, '변형이 하나도 없음 (기본 변형 필요)');

  // ── presets
  for (const p of Object.values(reg.presets)) {
    const at = `preset ${p.id}`;
    if (!ID.test(p.id)) err(at, 'id 형식');
    const v = reg.variants[p.variant];
    if (!reg.hulls[p.hull]) { err(at, `hull "${p.hull}" 없음`); continue; }
    if (!v) { err(at, `variant "${p.variant}" 없음`); continue; }
    if (v.hull !== p.hull) err(at, `variant "${p.variant}" 는 hull "${v.hull}" 의 변형`);
    const lay = variantLayout(p.variant, reg);
    if (!lay) { err(at, `variant "${p.variant}" 의 선체를 찾을 수 없음`); continue; }
    for (const [hpId, eq] of Object.entries(p.weapons)) {
      const hp = lay.hardpoints.find(x => x.id === hpId);
      if (!hp) { err(`${at}/${hpId}`, '변형에 없는 하드포인트'); continue; }
      if (reg.exclusive.has(eq) && !reg.exclusive.has(p.hull)) err(`${at}/${hpId}`, `계정 전용 장비 "${eq}" 는 전용 선체에만 장착`);
      const why = hpAccepts(hp, eq, reg); if (why) err(`${at}/${hpId}`, why);
    }
    const st = fitTotals(reg, p.hull, p.weapons, {});
    if (st && st.power > st.supply) err(at, `전력 초과 ${st.power}/${st.supply}`);
    if (st && st.mass > st.cap) err(at, `적재 초과 ${st.mass}/${st.cap}`);
    if (!Object.keys(p.weapons).length && SHIP_CLASSES[reg.hulls[p.hull].classId]?.role !== 'civilian') warn(at, '무장이 없는 프리셋');
  }

  // ── legacy mapping: every old (class, loadout) must resolve, and resolve to exactly the same ship
  for (const c of Object.values(SHIP_CLASSES)) for (const l of c.loadouts) {
    const at = `legacy ${c.id}/${l.id}`;
    const m = reg.legacy[`${c.id}/${l.id}`];
    if (!m) { err(at, '기존 로드아웃이 새 콘텐츠로 매핑되지 않음'); continue; }
    const h = reg.hulls[m.hull], v = reg.variants[m.variant], p = reg.presets[m.preset];
    if (!h || !v || !p) { err(at, `매핑 대상 없음 (${m.hull}/${m.variant}/${m.preset})`); continue; }
    if (h.classId !== c.id || v.hull !== h.id || p.variant !== v.id) err(at, '매핑의 선체·변형·프리셋이 서로 맞지 않음');
    if (!sameMounts(presetMounts(p.id, reg), getLoadout(c.id, l.id).mounts)) err(at, '프리셋 무장이 기존 로드아웃과 다름 (전투 결과가 바뀜)');
    const mods = v.mods ?? {};
    if ((mods.hpMul ?? 1) !== (l.hpMul ?? 1) || (mods.armorMul ?? 1) !== (l.armorMul ?? 1) || (mods.speedMul ?? 1) !== (l.speedMul ?? 1)) err(at, '변형 구조 보정이 기존 로드아웃과 다름');
    if ((p.costDelta ?? 0) !== (l.costDelta ?? 0)) err(at, `costDelta ${p.costDelta ?? 0} ≠ 기존 ${l.costDelta ?? 0}`);
    // every module set an old ship of this class could carry (Σ size ≤ slots) must still fit with
    // this preset — bays, power and mass — or migrating that ship would strip modules
    const bad = legacyModuleSets(HULLS[c.id]?.slots ?? 0).find(set => {
      const pl = placeModules(v.id, set, reg); if (pl.unplaced.length) return true;
      const t = fitTotals(reg, h.id, p.weapons, pl.bay)!; return t.power > t.supply || t.mass > t.cap;
    });
    if (bad) err(at, `기존 모듈 조합 [${bad.join(', ')}] 이 이 선체에 들어가지 않음 (베이·전력·질량)`);
  }

  // ── assets
  const targets: Record<string, (id: string) => boolean> = {
    hull: id => !!reg.hulls[id], variant: id => !!reg.variants[id],
    commander: id => COMMANDERS.some(c => c.id === id) || /^pool:[a-z0-9_]+$/.test(id),
    equipment: id => !!EQUIPMENT[id], item: id => !!ITEMS[id], facility: id => !!FACILITIES[id],
    asset: id => !!reg.assets[id],
  };
  const files = new Set<string>();
  for (const a of Object.values(reg.assets)) {
    const at = `asset ${a.id}`;
    const rule = ASSET_RULES[a.kind];
    if (!ASSET_KINDS.includes(a.kind) || !rule) { err(at, `kind "${a.kind}"`); continue; }
    if (!/^[a-z]+\.[a-z0-9_]+$/.test(a.id)) err(at, 'id 형식 `<접두사>.<이름>` (예: model.destroyer_mk2)');
    if (!/^[a-z0-9_\-/]+\.[a-z0-9]+$/.test(a.file) || a.file.includes('..') || a.file.startsWith('/')) err(at, `file "${a.file}" 형식 (소문자 상대경로)`);
    if (!a.file.startsWith(rule.dir)) err(at, `${a.kind} 는 ${rule.dir} 아래에 있어야 함`);
    if (!rule.ext.some(e => a.file.endsWith(e))) err(at, `${a.kind} 확장자는 ${rule.ext.join('/')}`);
    if (!targets[rule.target](a.for)) err(at, `for "${a.for}" 가 존재하는 ${rule.target} 가 아님`);
    if (files.has(a.file)) err(at, `파일 "${a.file}" 이 두 번 등록됨`); files.add(a.file);
    if (!a.license) warn(at, 'license 미기재');
    if (fs) {
      const n = fs.size(a.file);
      if (n === null) err(at, `파일 없음: public/assets/content/${a.file}`);
      else if (n > rule.maxBytes) err(at, `파일 크기 ${(n / 1024).toFixed(0)} KB > 한도 ${(rule.maxBytes / 1024).toFixed(0)} KB`);
    }
  }
  validateModels(reg, fs, err, warn);
  if (fs) for (const f of fs.list()) if (!files.has(f) && !/(^|\/)(\.gitkeep|README\.md)$/.test(f)) err(`asset-file ${f}`, '등록되지 않은 파일 (packs/*/assets.ts 에 등록하거나 삭제)');
  return out;
}
