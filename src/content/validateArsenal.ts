// P5/P7 validator rules for weapons, modules, goods, research, facilities and recipes (content packs).
// Called by validateContent. Checks references (against the built-in tables and every pack), value
// ranges, the design rules (a higher tier must not beat a lower one on every axis; each research area
// owns its own kinds of effect) and the numeric budget against the existing weapons of the same size.
import { EQUIPMENT, ITEMS, FACILITIES, TECHS, RECIPES } from '../world/industry';
import { WEAPONS, type WeaponDef } from '../sim/data/weapons';
import { INTERNAL_KINDS, MOUNT_STYLES, RESEARCH_AREAS, SIZES, WEAPON_FAMILIES, sizeRank, type ArmContent, type CombatFx, type ResearchArea, type Size, type WeaponStats } from './schema';
import { armWeaponId, type Registry } from './registry';
import type { Issue } from './validate';

const ID = /^[a-z][a-z0-9_]{1,47}$/;
const ROLES = ['anti-small', 'general', 'anti-capital', 'pd'];
const FAC_CATS = ['기반', '정제', '부품', '조선', '군사', '연구', '물류'];

/** which effects each research area may use (no two areas repeat the same effect) */
export const AREA_EFFECTS: Record<ResearchArea, { fx?: string[]; cfx?: string[]; families?: string[] }> = {
  hull: { fx: ['buildMul'], cfx: ['hpMul'] },
  propulsion: { fx: ['cruiseMul'], cfx: ['speedMul'] },
  power: { cfx: ['shieldRegenMul'] },
  kinetic: { cfx: ['dmgMul', 'reloadMul', 'rangeMul'], families: ['coil', 'cannon'] },
  energy: { cfx: ['dmgMul', 'reloadMul', 'rangeMul'], families: ['laser', 'plasma', 'particle'] },
  missile: { cfx: ['dmgMul', 'reloadMul', 'rangeMul'], families: ['missile', 'torpedo'] },
  defense: { fx: ['repairMul'], cfx: ['armorMul', 'shieldMul'] },
  electronics: { cfx: ['accMul', 'pdMul'] },
  industry: { fx: ['prodMul', 'refineMul'] },
  resource: { fx: ['mineMul'] },
  logistics: { fx: ['cargoMul', 'supplyMul', 'upkeepMul'] },
  station: { fx: ['researchMul', 'constructMul'] },
  tactics: { fx: ['skillGain'], cfx: ['evasion'] },
};
const FAMILY_KIND: Record<string, WeaponStats['kind']> = { missile: 'missile', torpedo: 'torpedo', pd: 'pd' };

/** comparable strength of a weapon: sustained damage × armour reach × range reach. Used to compare a
 *  new weapon with the existing ones of its size (docs/CODEX_CONTENT_GUIDE.md §7). */
export function armScore(w: Pick<WeaponStats, 'damage' | 'salvo' | 'reload' | 'pen' | 'range' | 'kind'>): number {
  const dps = w.damage * w.salvo / Math.max(0.05, w.reload);
  return Math.round(dps * Math.sqrt(Math.max(1, w.pen) / 40) * Math.sqrt(w.range / 1000));
}
const sizeOfEquip = (id: string): Size | undefined => ({ 1: 'S', 2: 'M', 3: 'L' } as const)[EQUIPMENT[id]?.size as 1 | 2 | 3];
/** best score among the built-in weapons of each size (the budget a new weapon is measured against) */
export function referenceScores(): Record<Size, number> {
  const best: Record<string, number> = { S: 0, M: 0, L: 0, XL: 0 };
  for (const e of Object.values(EQUIPMENT)) {
    if (e.kind !== 'weapon' || e.growth || !e.weapon) continue;
    const w = WEAPONS[e.weapon]; const sz = sizeOfEquip(e.id); if (!w || !sz || w.kind === 'pd') continue;
    best[sz] = Math.max(best[sz], armScore(w));
  }
  return best as Record<Size, number>;
}

export function validateArsenal(reg: Registry, err: (w: string, m: string) => void, warn: (w: string, m: string) => void) {
  const tech = (id: string) => !!TECHS[id] || !!reg.techs[id];
  const fac = (id: string) => !!FACILITIES[id] || !!reg.facilities[id];
  const item = (id: string) => !!ITEMS[id] || !!reg.items[id] || !!EQUIPMENT[id] || !!reg.arms[id] || !!reg.modules[id];
  const labFields = new Set<string>([...Object.values(FACILITIES), ...Object.values(reg.facilities)].flatMap(f => f.lab ?? []));
  const isGrowth = (id: string) => reg.growthOnly.has(id) || !!TECHS[id]?.growth || !!FACILITIES[id]?.growth || !!ITEMS[id]?.growth || !!EQUIPMENT[id]?.growth;
  const goods = (where: string, m: Record<string, number> | undefined, what: string, growthPack: boolean) => {
    for (const [k, n] of Object.entries(m ?? {})) {
      if (!item(k)) err(where, `${what}: 알 수 없는 품목 "${k}"`);
      else if (!growthPack && isGrowth(k)) err(where, `${what}: 성장 전용 품목 "${k}" 를 c0 콘텐츠가 참조`);
      if (!(n > 0)) err(where, `${what}: ${k} 수량 ${n}`);
    }
  };
  const packGrowth = (kind: string, id: string) => { const p = reg.packs.find(x => x.id === reg.origin[`${kind}:${id}`]); return (p?.minContentV ?? 0) >= 3; };

  // ── goods
  for (const x of Object.values(reg.items)) {
    const at = `item ${x.id}`;
    if (!ID.test(x.id)) err(at, 'id 형식 (소문자·숫자·_)');
    if (ITEMS[x.id] && ITEMS[x.id] !== (x as unknown) && !ITEMS[x.id].growth && !reg.growthOnly.has(x.id)) err(at, '내장 품목과 id 충돌');
    if (!['refined', 'part', 'shippart'].includes(x.cat)) err(at, `cat "${x.cat}" (refined/part/shippart)`);
    if (!(x.price > 0 && x.price < 100000)) err(at, `price ${x.price}`);
    if (!/^#[0-9a-f]{6}$/i.test(x.color)) err(at, `color "${x.color}" (#rrggbb)`);
    const made = [...Object.values(RECIPES), ...Object.values(reg.recipes)].some(r => r.out[x.id]);
    if (!made) err(at, '이 품목을 만드는 레시피가 없음 (중간재는 생산 경로가 있어야 함)');
    const used = [...Object.values(RECIPES), ...Object.values(reg.recipes)].some(r => r.in[x.id]) || Object.values(reg.arms).some(a => a.recipe.in[x.id]) || Object.values(reg.modules).some(m => m.recipe.in[x.id]);
    if (!used) warn(at, '어떤 레시피에도 쓰이지 않음 — 게임플레이 역할이 없는 중간재는 추가하지 않는다');
  }

  // ── weapons
  const ref = referenceScores();
  const byFamily = new Map<string, ArmContent[]>();
  for (const a of Object.values(reg.arms)) {
    const at = `arm ${a.id}`, c = a.combat, g = packGrowth('arm', a.id);
    if (!/^eq_[a-z0-9_]{2,40}$/.test(a.id)) err(at, 'id 는 `eq_` 로 시작 (소문자·숫자·_)');
    if (WEAPONS[armWeaponId(a.id)] && WEAPONS[armWeaponId(a.id)].name !== a.name) err(at, `전투 무장 id "${armWeaponId(a.id)}" 가 기존 무장과 충돌`);
    if (!WEAPON_FAMILIES.includes(a.family)) err(at, `family "${a.family}" (${WEAPON_FAMILIES.join('/')})`);
    if (!(Number.isInteger(a.tier) && a.tier >= 1 && a.tier <= 5)) err(at, `tier ${a.tier} (1–5)`);
    if (!ROLES.includes(a.role)) err(at, `role "${a.role}"`);
    if ((a.family === 'pd') !== (a.role === 'pd')) err(at, '방공(pd) 계열과 role "pd" 는 함께 써야 함');
    if (!SIZES.includes(a.size) || a.size === 'XL') err(at, `size "${a.size}" (S/M/L)`);
    for (const m of a.mounts ?? []) if (!MOUNT_STYLES.includes(m)) err(at, `mount "${m}"`);
    if (!(a.mass > 0 && a.mass <= 60)) err(at, `mass ${a.mass} (0–60)`);
    if (!(a.power >= 0 && a.power <= 80)) err(at, `power ${a.power} (0–80)`);
    if (a.tech && !tech(a.tech)) err(at, `tech "${a.tech}" 없음`);
    if (!a.tech && a.tier >= 2) warn(at, '2티어 이상 무장에 해금 연구(tech)가 없음');
    const want = FAMILY_KIND[a.family] ?? 'shell';
    if (c.kind !== want) err(at, `${a.family} 계열의 combat.kind 는 "${want}"`);
    const rng = (k: keyof WeaponStats, lo: number, hi: number) => { const v = c[k] as number | undefined; if (v === undefined || !(v >= lo && v <= hi)) err(at, `combat.${String(k)} ${v} (${lo}–${hi})`); };
    rng('damage', 1, 3000); rng('pen', 1, 200); rng('range', 150, 3000); rng('reload', 0.05, 60); rng('salvo', 1, 12); rng('salvoGap', 0, 2);
    rng('spread', 0, 0.3); rng('turnSpeed', 1, 600); rng('caliber', 0.2, 4);
    if (c.kind === 'shell' || c.kind === 'missile' || c.kind === 'torpedo') rng('speed', 50, 8000);
    if (c.kind === 'missile' || c.kind === 'torpedo') { rng('guidedTurn', 0.1, 5); rng('munitionHp', 1, 8); }
    if (c.kind === 'pd') rng('pdChance', 0.01, 0.3);
    // P15: a guided torpedo carries a limited load; an unguided one may be unlimited
    if (c.p15?.magazine !== undefined && !(c.p15.magazine >= 1 && c.p15.magazine <= 20)) err(at, `combat.p15.magazine ${c.p15.magazine} (1–20)`);
    if (c.kind === 'torpedo' && !c.p15?.unguided && c.magazine === undefined && c.p15?.magazine === undefined) warn(at, '유도 어뢰에 탄약 제한(p15.magazine)이 없음 — 유도 어뢰는 탄약 제한, 무제한 어뢰는 비유도(p15.unguided)');
    if (c.vsShield !== undefined && !(c.vsShield >= 0.3 && c.vsShield <= 2)) err(at, `combat.vsShield ${c.vsShield} (0.3–2)`);
    if (a.vis && (!/^#[0-9a-f]{6}$/i.test(a.vis.color) || !(a.vis.len >= 0 && a.vis.len <= 200) || !(a.vis.wid > 0 && a.vis.wid <= 4))) err(at, 'vis: color #rrggbb, len 0–200, wid 0–4');
    if (!fac(a.recipe.fac)) err(at, `recipe.fac "${a.recipe.fac}" 시설 없음`);
    if (!(a.recipe.time >= 30 && a.recipe.time <= 86400)) err(at, `recipe.time ${a.recipe.time} (30–86400 s)`);
    goods(at, a.recipe.in, 'recipe.in', g);
    goods(at, a.supply, 'supply', g);
    if (a.supply && Object.values(a.supply).some(n => n > 5)) warn(at, '시간당 보급 소모가 큼 (> 5)');
    if (a.family !== 'pd') {
      const s = armScore(c), cap = ref[a.size] || 1;
      if (s > cap * 1.6) err(at, `전투 지수 ${s} 가 기존 ${a.size} 무장 최고치 ${cap} 의 1.6배 초과 — 수치 과다`);
      else if (s > cap * 1.25) warn(at, `전투 지수 ${s} > 기존 ${a.size} 최고 ${cap} ×1.25 — 비용·전력·티어로 정당화되는지 검토`);
    }
    (byFamily.get(a.family) ?? byFamily.set(a.family, []).get(a.family)!).push(a);
  }
  // a higher tier must not beat a lower tier of the same family on every axis
  for (const [fam, list] of byFamily) {
    for (const hi of list) for (const lo of list) {
      if (hi.tier <= lo.tier) continue;
      const better = armScore(hi.combat) >= armScore(lo.combat) && hi.combat.pen >= lo.combat.pen && hi.combat.range >= lo.combat.range && hi.combat.turnSpeed >= lo.combat.turnSpeed;
      const cheaper = hi.power <= lo.power && hi.mass <= lo.mass && sizeRank(hi.size) <= sizeRank(lo.size);
      if (better && cheaper) err(`arm ${hi.id}`, `${fam} ${hi.tier}티어가 ${lo.id}(${lo.tier}티어)를 모든 면에서 압도 — 전력·크기·선회·연사 중 하나는 불리해야 함`);
    }
  }

  // ── modules
  const CFX = ['family', 'dmgMul', 'reloadMul', 'rangeMul', 'hpMul', 'armorMul', 'speedMul', 'accMul', 'pdMul', 'evasion', 'shield', 'shieldMul', 'shieldRegen', 'shieldRegenMul'];
  const cfxCheck = (at: string, c: CombatFx | undefined) => {
    for (const [k, v] of Object.entries(c ?? {})) {
      if (!CFX.includes(k)) { err(at, `알 수 없는 전투 효과 "${k}"`); continue; }
      if (k === 'family') { for (const f of Array.isArray(v) ? v : [v]) if (!WEAPON_FAMILIES.includes(f)) err(at, `family "${f}"`); continue; }
      const n = v as number;
      if (k === 'evasion' ? !(n > 0 && n <= 0.2) : k === 'shield' ? !(n > 0 && n <= 0.5) : k === 'shieldRegen' ? !(n > 0 && n <= 0.1) : !(n >= 0.5 && n <= 1.5)) err(at, `${k} ${n} 범위 밖`);
    }
  };
  for (const m of Object.values(reg.modules)) {
    const at = `module ${m.id}`, g = packGrowth('module', m.id);
    // industrial hardpoint gear (slot industrial) is named ind_<work>_<size>; every other module mod_
    const pre = m.slot === 'industrial' ? 'ind_' : m.slot === 'computer' ? 'cpu_' : 'mod_';
    if (!new RegExp(`^${pre}[a-z0-9_]{2,40}$`).test(m.id)) err(at, `id 는 \`${pre}\` 로 시작`);
    if (!INTERNAL_KINDS.includes(m.slot)) err(at, `slot "${m.slot}"`);
    if (!SIZES.includes(m.size)) err(at, `size "${m.size}"`);
    if (!(m.mass > 0 && m.mass <= 60)) err(at, `mass ${m.mass}`);
    if (!(m.power >= -80 && m.power <= 60)) err(at, `power ${m.power}`);
    if (m.tech && !tech(m.tech)) err(at, `tech "${m.tech}" 없음`);
    if (m.fx.family) err(at, '모듈은 계열 한정 효과(family)를 쓰지 않는다 (연구로)');
    if (m.fx.shield && m.power <= 0) err(at, '실드 발생기는 전력을 소모해야 함');
    cfxCheck(at, m.fx);
    if (!Object.keys(m.fx).length && m.power >= 0 && !m.ind && !m.cpu) err(at, '효과도 전력 공급도 없는 모듈');
    if (!fac(m.recipe.fac)) err(at, `recipe.fac "${m.recipe.fac}" 시설 없음`);
    goods(at, m.recipe.in, 'recipe.in', g);
  }

  // ── research
  const allTech = { ...TECHS, ...Object.fromEntries(Object.values(reg.techs).map(t => [t.id, t])) } as Record<string, { pre?: string[] }>;
  const unlockedBy = new Set<string>([
    ...Object.values(reg.arms).map(a => a.tech), ...Object.values(reg.modules).map(m => m.tech), ...Object.values(reg.recipes).map(r => r.tech),
    ...Object.values(reg.facilities).map(f => f.tech), ...Object.values(EQUIPMENT).map(e => e.tech), ...Object.values(RECIPES).map(r => r.tech), ...Object.values(FACILITIES).map(f => f.tech),
  ].filter(Boolean) as string[]);
  for (const t of Object.values(reg.techs)) {
    const at = `tech ${t.id}`, g = packGrowth('tech', t.id);
    if (!ID.test(t.id)) err(at, 'id 형식');
    if (!RESEARCH_AREAS.includes(t.area)) err(at, `area "${t.area}" (${RESEARCH_AREAS.join('/')})`);
    if (!labFields.has(t.field)) err(at, `field "${t.field}" 를 연구할 수 있는 연구소가 없음`);
    for (const p of t.pre ?? []) if (!tech(p)) err(at, `선행 연구 "${p}" 없음`);
    if (t.needLab && !(FACILITIES[t.needLab]?.lab || reg.facilities[t.needLab]?.lab)) err(at, `needLab "${t.needLab}" 은 연구소 시설이어야 함`);
    if (t.needLab) { const lf = FACILITIES[t.needLab]?.lab ?? reg.facilities[t.needLab]?.lab ?? []; if (!lf.includes(t.field)) err(at, `needLab ${t.needLab} 이 field "${t.field}" 를 연구하지 않음`); }
    if (!(t.time >= 600 && t.time <= 7 * 86400)) err(at, `time ${t.time}`);
    if (!(t.credits >= 0)) err(at, `credits ${t.credits}`);
    goods(at, t.cost, 'cost', g);
    const rule = AREA_EFFECTS[t.area];
    for (const k of Object.keys(t.fx ?? {})) if (!rule?.fx?.includes(k)) err(at, `${t.area} 분야는 ${k} 효과를 쓰지 않음 (다른 분야의 효과) — 허용: ${rule?.fx?.join(', ') || '없음'}`);
    for (const k of Object.keys(t.cfx ?? {})) if (k !== 'family' && !rule?.cfx?.includes(k)) err(at, `${t.area} 분야는 전투 효과 ${k} 를 쓰지 않음 — 허용: ${rule?.cfx?.join(', ') || '없음'}`);
    if (rule?.families) {
      const fs = t.cfx?.family === undefined ? [] : Array.isArray(t.cfx.family) ? t.cfx.family : [t.cfx.family];
      if (t.cfx && !fs.length) err(at, `${t.area} 분야의 전투 효과는 무장 계열(family)을 지정해야 함`);
      for (const f of fs) if (!rule.families.includes(f)) err(at, `${t.area} 분야는 ${f} 계열을 다루지 않음`);
    } else if (t.cfx?.family) err(at, '무장 계열 효과는 실탄·에너지·유도 무장 분야만');
    cfxCheck(at, t.cfx);
    for (const [k, v] of Object.entries(t.fx ?? {})) if (!((v as number) >= 0.5 && (v as number) <= 2)) err(at, `fx.${k} ${v}`);
    // every research must do something: unlock content, change numbers, or lead to research that does
    const leads = Object.values(allTech).some(x => x.pre?.includes(t.id));
    if (!unlockedBy.has(t.id) && !t.fx && !t.cfx && !leads) err(at, '아무것도 해금하거나 바꾸지 않는 연구');
    if (!t.unlocks.trim()) err(at, 'unlocks(플레이어 표시 요약) 비어 있음');
  }
  // prerequisite cycles
  const seen = new Map<string, number>();
  const dfs = (id: string, path: string[]): void => {
    if (seen.get(id) === 2) return;
    if (seen.get(id) === 1) { err(`tech ${id}`, `선행 연구 순환: ${[...path, id].join(' → ')}`); return; }
    seen.set(id, 1); for (const p of allTech[id]?.pre ?? []) dfs(p, [...path, id]); seen.set(id, 2);
  };
  for (const id of Object.keys(reg.techs)) dfs(id, []);

  // ── facilities
  for (const f of Object.values(reg.facilities)) {
    const at = `facility ${f.kind}`, g = packGrowth('facility', f.kind);
    if (!ID.test(f.kind)) err(at, 'kind 형식');
    if (!FAC_CATS.includes(f.cat)) err(at, `cat "${f.cat}"`);
    if (f.requires && !fac(f.requires)) err(at, `requires "${f.requires}" 없음`);
    if (f.tech && !tech(f.tech)) err(at, `tech "${f.tech}" 없음`);
    if (f.minStation !== undefined && !['S', 'M', 'L', 'XL'].includes(f.minStation)) err(at, `minStation "${f.minStation}" 은 S/M/L/XL이어야 함`);
    if (!(f.credits >= 0 && f.work > 0)) err(at, 'credits ≥ 0, work > 0');
    goods(at, f.mats, 'mats', g);
    if (f.legacyBuild) {
      if (!(f.legacyBuild.credits >= 0)) err(at, 'legacyBuild.credits ≥ 0');
      goods(at, f.legacyBuild.mats, 'legacyBuild.mats', g);
    }
    if (!Object.keys(f.mats).length) err(at, '건설 자재가 없음 (생산시설은 실제 자재가 필요)');
    const makes = [...Object.values(RECIPES), ...Object.values(reg.recipes)].some(r => r.fac === f.kind) || Object.values(reg.arms).some(a => a.recipe.fac === f.kind) || Object.values(reg.modules).some(m => m.recipe.fac === f.kind);
    if (!makes && !f.lab && !f.yard && !f.storage) warn(at, '생산·연구·조선·저장 어느 역할도 없는 시설');
  }
  // ── recipes
  for (const r of Object.values(reg.recipes)) {
    const at = `recipe ${r.id}`, g = packGrowth('recipe', r.id);
    if (!ID.test(r.id)) err(at, 'id 형식');
    if (!fac(r.fac)) err(at, `fac "${r.fac}" 없음`);
    if (r.tech && !tech(r.tech)) err(at, `tech "${r.tech}" 없음`);
    if (!(r.time >= 10)) err(at, `time ${r.time}`);
    goods(at, r.in, 'in', g); goods(at, r.out, 'out', g);
    if (!Object.keys(r.in).length) err(at, '재료 없는 레시피 (무에서 생산 불가)');
    for (const o of Object.keys(r.out)) if (r.in[o]) err(at, `${o} 를 넣어 ${o} 를 만드는 레시피`);
  }
}

/** is a weapon id one of the arsenal's (for the UI) */
export const isArsenalWeapon = (w: WeaponDef | undefined) => !!w?.tier;
