// HISTORICAL — do not re-run (it would overwrite hand edits). One-off generator (P1): turns the legacy ship tables (SHIP_CLASSES loadouts + HULLS) into the
// explicit core content pack src/content/packs/core/hulls.ts. After P1 that file is the source of
// truth and is edited by hand; this script stays only to document how it was derived.
//   npx vite-node scripts/content-freeze-core.ts
import fs from 'node:fs';
import { SHIP_CLASSES } from '../src/sim/data/ships';
import { HULLS, EQUIPMENT } from '../src/world/industry';
import type { HardpointDef, HardpointType, HullDef, LegacyLoadoutMap, MountStyle, PresetDef, Size, VariantDef } from '../src/content/schema';

const SIZE: Size[] = ['S', 'M', 'L', 'XL'];
const wSize = (w: string): number => Object.values(EQUIPMENT).find(e => e.weapon === w)?.size ?? 1;
const wCat = (w: string): HardpointType => w === 'pd_gun' ? 'pd' : w === 'pulse_laser' || w === 'particle_lance' ? 'energy' : w === 'missile_rack' || w === 'torpedo' ? 'missile' : 'ballistic';
const key = (p: number[], f: number) => `${p.join(',')}@${f}`;

const hulls: HullDef[] = [], variants: VariantDef[] = [], presets: PresetDef[] = [], legacy: LegacyLoadoutMap[] = [];
for (const c of Object.values(SHIP_CLASSES)) {
  const h = HULLS[c.id];
  const hullId = `${c.id}_mk1`;
  const slots = new Map<string, { pos: [number, number, number]; facing: number; arc: number; weapons: Set<string> }>();
  for (const l of c.loadouts) for (const m of l.mounts) {
    const k = key(m.pos, m.facing);
    const s = slots.get(k) ?? { pos: m.pos, facing: m.facing, arc: 0, weapons: new Set() };
    s.arc = Math.max(s.arc, m.arc); s.weapons.add(m.weapon); slots.set(k, s);
  }
  const ids = new Map<string, string>();
  const hps: HardpointDef[] = [...slots.entries()].map(([k, s], i) => {
    const id = `hp${String(i + 1).padStart(2, '0')}`; ids.set(k, id);
    const ws = [...s.weapons];
    const cats = new Set(ws.map(wCat)); const nonPd = [...cats].filter(x => x !== 'pd');
    const type: HardpointType = nonPd.length === 0 ? 'pd' : nonPd.length === 1 ? nonPd[0] : 'universal';
    const mount: MountStyle = ws.every(w => w === 'missile_rack') ? 'vls' : s.arc <= 30 ? 'fixed' : 'turret';
    return { id, pos: s.pos, facing: s.facing, arc: s.arc, size: SIZE[Math.max(...ws.map(wSize)) - 1], type, mount };
  });
  const yard = h?.yard ?? 3;
  hulls.push({
    id: hullId, classId: c.id, name: c.name, tier: Math.min(4, yard) as 1 | 2 | 3 | 4, size: SIZE[yard - 1],
    hardpoints: hps, internals: [], moduleSlots: h?.slots ?? 0, power: 0, mass: 0, // power/mass/bays were set by hand in P2
    mesh: { base: c.id, scale: 1 }, blueprint: h?.tech ? 'advanced' : 'common', desc: c.desc,
  });
  const baseVar = `${hullId}_std`;
  variants.push({ id: baseVar, hull: hullId, name: '표준형', desc: `${c.name} 기본 구조.`, blueprint: 'common' });
  for (const l of c.loadouts) {
    let v = baseVar;
    if (l.hpMul || l.armorMul || l.speedMul) {
      v = `${hullId}_${l.id}`;
      variants.push({ id: v, hull: hullId, name: `${l.name}`, desc: `구조 보강형 (${l.desc})`, blueprint: 'common', mods: { ...(l.hpMul ? { hpMul: l.hpMul } : {}), ...(l.armorMul ? { armorMul: l.armorMul } : {}), ...(l.speedMul ? { speedMul: l.speedMul } : {}) } });
    }
    const weapons: Record<string, string | { weapon: string; arc: number }> = {};
    for (const m of l.mounts) {
      const id = ids.get(key(m.pos, m.facing))!;
      const hp = hps.find(x => x.id === id)!;
      weapons[id] = m.arc < hp.arc ? { weapon: m.weapon, arc: m.arc } : m.weapon;
    }
    const pid = `${c.id}_${l.id}`;
    presets.push({ id: pid, hull: hullId, variant: v, name: l.name, desc: l.desc, weapons: weapons as any, ...(l.costDelta ? { costDelta: l.costDelta } : {}) });
    legacy.push({ classId: c.id, loadoutId: l.id, hull: hullId, variant: v, preset: pid });
  }
}

const j = (x: unknown) => JSON.stringify(x);
const out = `// Core content pack: the original 12 ship classes as hulls, variants and fitting presets.
// Derived once from the legacy tables by scripts/content-freeze-core.ts (P1); edit by hand from now on.
// Hardpoint ids are saved on ships from P2 on: never renumber or reuse them. See docs/CONTENT_SCHEMA.md.
import type { HullDef, VariantDef, PresetDef, LegacyLoadoutMap } from '../../schema';

export const CORE_HULLS: HullDef[] = [
${hulls.map(h => `  {
    id: ${j(h.id)}, classId: ${j(h.classId)}, name: ${j(h.name)}, tier: ${h.tier}, size: ${j(h.size)}, moduleSlots: ${h.moduleSlots}, blueprint: ${j(h.blueprint)},
    mesh: ${j(h.mesh)}, internals: [],
    desc: ${j(h.desc)},
    hardpoints: [
${h.hardpoints.map(p => `      ${j(p)},`).join('\n')}
    ],
  },`).join('\n')}
];

export const CORE_VARIANTS: VariantDef[] = [
${variants.map(v => `  ${j(v)},`).join('\n')}
];

export const CORE_PRESETS: PresetDef[] = [
${presets.map(p => `  ${j(p)},`).join('\n')}
];

export const CORE_LEGACY: LegacyLoadoutMap[] = [
${legacy.map(l => `  ${j(l)},`).join('\n')}
];
`;
fs.mkdirSync('src/content/packs/core', { recursive: true });
fs.writeFileSync('src/content/packs/core/hulls.ts', out);
console.log(`hulls ${hulls.length} · variants ${variants.length} · presets ${presets.length} · hardpoints ${hulls.reduce((a, h) => a + h.hardpoints.length, 0)}`);
