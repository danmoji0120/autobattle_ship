// P17.3 fleet expansion: 36 new base hulls across every combat class, grouped into maker product lines.
// Each hull has its own silhouette (render/hulls17.ts, mesh.scale 1 so the hardpoint coordinates below are
// the model's own) and its own structure — hardpoints, bays, power, mass, combat structure, economy.
// Performance and price are deliberately uneven: masterpieces, expensive elites, cheap mass production,
// obsolete designs and failed experiments sit side by side. No new materials: only existing goods.
// docs/P17_3_ARSENAL.md
//
// Acquisition is split on purpose (owning ≠ having the blueprint ≠ being able to build it):
//  - `sale`: which public yards stock built ships (cheap lines widely, elites at few stations, some never);
//  - blueprints: shop / commercial / faction / contract / salvage / explore sources (explore = P19 hook);
//  - `build.tech` + `build.facilities`: the research and plant a builder needs on top of the blueprint.
// Carriers stay PREVIEW hulls (HullDef.preview, the existing carrier release flag is not lifted).
import type { BlueprintDef, BlueprintSource, HardpointDef, HullDef, InternalSlotDef, PresetDef, Size, VariantDef } from '../../schema';

type HT = HardpointDef['type'];
type MS = HardpointDef['mount'];
const hp = (id: string, pos: [number, number, number], facing: number, arc: number, size: Size, type: HT, mount: MS = 'turret'): HardpointDef => ({ id, pos, facing, arc, size, type, mount });
/** "fcsS sensorS reactorM" → internal bays (ids kind+index) */
function bays(spec: string): InternalSlotDef[] {
  const n: Record<string, number> = {};
  const ID: Record<string, string> = { engine: 'eng', reactor: 'rx', sensor: 'sen', fcs: 'fcs', ew: 'ew', armor: 'arm', special: 'bay', flight: 'fl', computer: 'cpu' };
  return spec.split(/\s+/).filter(Boolean).map(t => {
    const kind = t.slice(0, -1) as InternalSlotDef['kind'], size = t.slice(-1) as Size;
    n[kind] = (n[kind] ?? 0) + 1;
    return { id: `${ID[kind] ?? kind}${n[kind]}`, kind, size };
  });
}

// class baselines (world/industry.ts HULLS): parts, yard, build seconds, class research
const BASE: Record<string, { parts: Record<string, number>; yard: number; time: number; tech: string[]; berth: Size }> = {
  corvette: { parts: { structure: 16, armor_plate: 6, engine: 1, reactor: 1, sensor: 1, electronics: 4 }, yard: 1, time: 1500, tech: [], berth: 'S' },
  frigate: { parts: { structure: 26, armor_plate: 12, engine: 2, reactor: 1, sensor: 1, electronics: 6 }, yard: 1, time: 2400, tech: ['frigate_design'], berth: 'S' },
  destroyer: { parts: { structure: 46, armor_plate: 22, engine: 2, reactor: 2, sensor: 2, electronics: 10 }, yard: 2, time: 5400, tech: [], berth: 'M' },
  light_cruiser: { parts: { structure: 80, armor_plate: 40, engine: 4, reactor: 3, sensor: 3, electronics: 16 }, yard: 2, time: 10800, tech: ['light_cruiser_design'], berth: 'M' },
  cruiser: { parts: { structure: 130, armor_plate: 70, engine: 6, reactor: 4, sensor: 4, electronics: 22, composite: 20 }, yard: 3, time: 18000, tech: ['capital_hulls'], berth: 'L' },
  battlecruiser: { parts: { structure: 220, armor_plate: 110, engine: 10, reactor: 6, sensor: 5, electronics: 32, composite: 40 }, yard: 3, time: 32400, tech: ['battlecruiser_design'], berth: 'L' },
  battleship: { parts: { structure: 340, armor_plate: 200, engine: 12, reactor: 8, sensor: 6, electronics: 40, composite: 80 }, yard: 3, time: 57600, tech: ['battleship_design'], berth: 'XL' },
  dreadnought: { parts: { structure: 900, armor_plate: 520, engine: 30, reactor: 20, sensor: 12, electronics: 100, composite: 240 }, yard: 4, time: 144000, tech: ['dreadnought_program'], berth: 'XL' },
  carrier: { parts: { structure: 160, armor_plate: 40, engine: 4, reactor: 3, sensor: 4, electronics: 30, machinery: 20 }, yard: 3, time: 16000, tech: ['capital_hulls', 'combined_arms'], berth: 'L' },
};

interface Row {
  id: string; cls: string; name: string; maker: string; line: string; tier: 1 | 2 | 3 | 4; size: Size; base: string;
  power: number; mass: number; grade: HullDef['blueprint']; desc: string;
  stats?: HullDef['stats']; cruise: number;
  /** build cost multiplier on the class baseline (parts and time), credits, extra parts / research / plant */
  k: number; credits: number; extra?: Record<string, number>; tech?: string[]; fac?: string[];
  upkeep: number; supplies?: Record<string, number>; wear?: number;
  sale?: HullDef['sale']; int: string; hps: HardpointDef[]; cpu?: string;
  fit: Record<string, string>; pname: string; pdesc: string;
  bp: BlueprintSource[]; preview?: true;
}

function hull(r: Row): HullDef {
  const b = BASE[r.cls];
  const parts: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.parts)) parts[k] = Math.max(1, Math.round(v * r.k));
  for (const [k, v] of Object.entries(r.extra ?? {})) parts[k] = (parts[k] ?? 0) + v;
  const tech = [...new Set([...b.tech, ...(r.tech ?? [])])];
  return {
    id: r.id, classId: r.cls, name: r.name, maker: r.maker, line: r.line, tier: r.tier, size: r.size,
    moduleSlots: Math.max(1, Math.min(8, r.int.split(/\s+/).length)), power: r.power, mass: r.mass, blueprint: r.grade,
    mesh: { base: r.base, scale: 1 }, desc: r.desc,
    ...(r.stats ? { stats: r.stats } : {}),
    ...(r.preview ? { preview: true } : {}),
    ops: { cruise: r.cruise, berth: b.berth },
    build: { yard: b.yard, time: Math.round(b.time * r.k), credits: r.credits, ...(tech.length ? { tech } : {}), ...(r.fac?.length ? { facilities: r.fac } : {}), parts },
    upkeep: { credits: r.upkeep, ...(r.supplies ? { supplies: r.supplies } : {}), wear: r.wear ?? 0.05 },
    ...(r.sale && !r.preview ? { sale: r.sale } : {}),
    internals: bays(r.int), hardpoints: r.hps,
    ...(r.cpu ? { cpu: r.cpu } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════ hardpoints
// (x port+, y up, z bow+). tests/p17-hulls.test.ts raycasts each one onto its hull: the pedestal must
// reach the surface below (no floating) and nothing of the hull may sit on top of it (no burying).
const HP: Record<string, HardpointDef[]> = {
  p17_cv_militia: [
    hp('main1', [0, 1.8, 3.0], 0, 140, 'S', 'ballistic'),
    hp('gun1', [0, 2.6, -1.2], 0, 160, 'S', 'ballistic'),
    hp('pd1', [-1.0, 1.8, -4.8], 180, 150, 'S', 'pd'),
  ],
  p17_cv_blackwing: [
    hp('torp1', [1.45, 1.7, 4.6], 0, 15, 'M', 'missile', 'fixed'),
    hp('torp2', [-1.45, 1.7, 4.6], 0, 15, 'M', 'missile', 'fixed'),
    hp('pd1', [0, 2.0, -4.0], 180, 150, 'S', 'pd'),
  ],
  p17_cv_spark: [
    hp('las1', [0, 1.8, 3.6], 0, 140, 'S', 'energy'),
    hp('las2', [0, 2.4, 0.6], 0, 170, 'S', 'energy'),
    hp('pd1', [0, 1.8, -2.0], 180, 160, 'S', 'pd'),
  ],
  p17_cv_hornet: [
    hp('vls1', [2.9, 1.9, -2.6], 0, 180, 'M', 'missile', 'vls'),
    hp('vls2', [-2.9, 1.9, -2.6], 0, 180, 'M', 'missile', 'vls'),
    hp('gun1', [0, 1.9, 4.0], 0, 140, 'S', 'ballistic'),
    hp('pd1', [0, 1.9, -4.2], 180, 150, 'S', 'pd'),
  ],
  p17_cv_relic: [
    hp('gun1', [0, 2.4, 2.2], 0, 140, 'S', 'ballistic'),
    hp('gun2', [0, 2.4, -3.0], 180, 140, 'S', 'ballistic'),
    hp('gun3', [0, 3.6, -1.3], 0, 170, 'S', 'ballistic'),
    hp('pd1', [0, 2.4, -5.6], 180, 140, 'S', 'pd'),
  ],
  p17_ff_mirage: [
    hp('gun1', [0, 2.2, 8.0], 0, 150, 'S', 'universal'),
    hp('pd1', [3.3, 2.2, 4.5], 90, 160, 'S', 'pd'),
    hp('pd2', [-3.3, 2.2, 4.5], -90, 160, 'S', 'pd'),
    hp('pd3', [0, 1.9, -6.0], 180, 150, 'S', 'pd'),
  ],
  p17_ff_shieldwall: [
    hp('main1', [0, 2.4, 4.4], 0, 140, 'M', 'ballistic'),
    hp('gun1', [2.0, 2.3, -1.0], 90, 140, 'S', 'ballistic'),
    hp('gun2', [-2.0, 2.3, -1.0], -90, 140, 'S', 'ballistic'),
    hp('pd1', [1.6, 2.3, -7.2], 180, 150, 'S', 'pd'),
  ],
  p17_ff_lantern: [
    hp('gun1', [0, 3.0, 3.6], 0, 150, 'S', 'ballistic'),
    hp('vls1', [0, 3.0, 0.9], 0, 180, 'M', 'missile', 'vls'),
    hp('gun2', [0, 3.0, -5.0], 180, 150, 'S', 'ballistic'),
    hp('pd1', [3.6, 2.0, -6.6], 90, 160, 'S', 'pd'),
    hp('pd2', [-3.6, 2.0, -6.6], -90, 160, 'S', 'pd'),
  ],
  p17_ff_scrap: [
    hp('gun1', [0, 2.1, 5.0], 0, 140, 'S', 'ballistic'),
    hp('vls1', [3.3, 2.2, -1.0], 0, 180, 'M', 'missile', 'vls'),
    hp('gun2', [-1.6, 2.1, 1.0], -90, 140, 'S', 'ballistic'),
    hp('pd1', [-0.8, 2.1, -7.0], 180, 150, 'S', 'pd'),
  ],
  p17_dd_hedgehog: [
    hp('main1', [0, 2.2, 7.6], 0, 150, 'M', 'ballistic'),
    hp('main2', [0, 2.2, -7.6], 180, 150, 'M', 'ballistic'),
    hp('pd1', [3.1, 2.0, 7.0], 60, 170, 'S', 'pd'), hp('pd2', [-3.1, 2.0, 7.0], -60, 170, 'S', 'pd'),
    hp('pd3', [3.1, 2.0, 3.5], 90, 170, 'S', 'pd'), hp('pd4', [-3.1, 2.0, 3.5], -90, 170, 'S', 'pd'),
    hp('pd5', [3.1, 2.0, -3.5], 90, 170, 'S', 'pd'), hp('pd6', [-3.1, 2.0, -3.5], -90, 170, 'S', 'pd'),
    hp('pd7', [3.1, 2.0, -7.0], 120, 170, 'S', 'pd'), hp('pd8', [-3.1, 2.0, -7.0], -120, 170, 'S', 'pd'),
  ],
  p17_dd_hammerhead: [
    hp('ham1', [3.2, 3.1, 10.2], 30, 130, 'M', 'ballistic'),
    hp('ham2', [-3.2, 3.1, 10.2], -30, 130, 'M', 'ballistic'),
    hp('main1', [0, 2.5, 4.0], 0, 140, 'L', 'ballistic'),
    hp('pd1', [2.2, 2.5, -9.0], 120, 160, 'S', 'pd'),
    hp('pd2', [-2.2, 2.5, -9.0], -120, 160, 'S', 'pd'),
  ],
  p17_dd_scavenger: [
    hp('gun1', [2.6, 2.2, 6.5], 0, 140, 'M', 'ballistic'),
    hp('gun2', [-2.6, 2.2, 6.5], 0, 140, 'M', 'ballistic'),
    hp('pd1', [-2.6, 2.2, -2.0], -90, 160, 'S', 'pd'),
    hp('pd2', [2.6, 2.2, -9.6], 180, 160, 'S', 'pd'),
  ],
  p17_dd_spindle: [
    hp('spin1', [0, 2.2, 8.0], 0, 6, 'L', 'ballistic', 'spinal'),
    hp('gun1', [0, 2.2, -6.6], 180, 150, 'M', 'ballistic'),
    hp('pd1', [1.2, 2.2, 1.0], 90, 160, 'S', 'pd'),
    hp('pd2', [-1.2, 2.2, 1.0], -90, 160, 'S', 'pd'),
  ],
  p17_dd_tempest: [
    hp('gun1', [0, 2.4, 8.0], 0, 150, 'M', 'ballistic'),
    hp('vls1', [1.5, 2.5, 0.2], 0, 180, 'M', 'missile', 'vls'),
    hp('vls2', [-1.5, 2.5, 0.2], 0, 180, 'M', 'missile', 'vls'),
    hp('gun2', [0, 2.4, -10.0], 180, 140, 'S', 'ballistic'),
    hp('pd1', [1.6, 2.4, -5.0], 90, 160, 'S', 'pd'),
    hp('pd2', [-1.6, 2.4, -5.0], -90, 160, 'S', 'pd'),
  ],
  p17_dd_forge: [
    hp('gun1', [0, 2.1, 7.0], 0, 150, 'M', 'ballistic'),
    hp('gun2', [0, 3.3, -9.0], 180, 150, 'M', 'ballistic'),
    hp('pd1', [2.0, 2.1, 4.6], 90, 160, 'S', 'pd'),
    hp('pd2', [-2.0, 2.1, 4.6], -90, 160, 'S', 'pd'),
    hp('rep1', [0, 2.1, -6.6], 180, 170, 'S', 'support'),
  ],
  p17_cl_longbow: [
    hp('spin1', [0, 2.3, 12.0], 0, 5, 'L', 'ballistic', 'spinal'),
    hp('gun1', [0, 2.3, 3.6], 0, 150, 'M', 'universal'),
    hp('gun2', [0, 2.3, -14.6], 180, 150, 'M', 'universal'),
    hp('pd1', [1.6, 2.3, -3.0], 90, 160, 'S', 'pd'),
    hp('pd2', [-1.6, 2.3, -3.0], -90, 160, 'S', 'pd'),
  ],
  p17_cl_siren: [
    hp('gun1', [3.4, 2.3, 4.0], 0, 150, 'M', 'universal'),
    hp('gun2', [-3.4, 2.3, 4.0], 0, 150, 'M', 'universal'),
    hp('gun3', [0, 2.3, -11.0], 180, 150, 'M', 'ballistic'),
    hp('pd1', [3.4, 2.3, -6.0], 90, 160, 'S', 'pd'),
    hp('pd2', [-3.4, 2.3, -6.0], -90, 160, 'S', 'pd'),
  ],
  p17_cl_warden: [
    hp('main1', [0, 2.5, 13.0], 0, 150, 'M', 'universal'),
    hp('main2', [0, 3.5, 8.0], 0, 150, 'M', 'universal'),
    hp('main3', [0, 3.5, -8.0], 180, 150, 'M', 'universal'),
    hp('vls1', [1.0, 3.5, -5.6], 0, 180, 'M', 'missile', 'vls'),
    hp('vls2', [-1.0, 3.5, -5.6], 0, 180, 'M', 'missile', 'vls'),
    hp('pd1', [3.0, 2.5, 4.0], 90, 160, 'S', 'pd'), hp('pd2', [-3.0, 2.5, 4.0], -90, 160, 'S', 'pd'),
    hp('pd3', [2.9, 2.5, -12.0], 120, 160, 'S', 'pd'), hp('pd4', [-2.9, 2.5, -12.0], -120, 160, 'S', 'pd'),
  ],
  p17_cl_ironside: [
    hp('main1', [0, 2.3, 11.0], 0, 140, 'L', 'ballistic'),
    hp('cas1', [3.0, 2.3, 5.0], 90, 70, 'M', 'ballistic'), hp('cas2', [-3.0, 2.3, 5.0], -90, 70, 'M', 'ballistic'),
    hp('cas3', [3.0, 2.3, -5.0], 90, 70, 'M', 'ballistic'), hp('cas4', [-3.0, 2.3, -5.0], -90, 70, 'M', 'ballistic'),
    hp('pd1', [0, 2.3, -11.0], 180, 150, 'S', 'pd'),
  ],
  p17_ca_nova: [
    hp('las1', [0, 3.9, 10.0], 0, 150, 'M', 'energy'),
    hp('las2', [0, 3.9, 4.0], 0, 150, 'M', 'energy'),
    hp('las3', [0, 3.9, -14.0], 180, 150, 'M', 'energy'),
    hp('las4', [3.4, 2.7, 6.0], 90, 140, 'S', 'energy'), hp('las5', [-3.4, 2.7, 6.0], -90, 140, 'S', 'energy'),
    hp('pd1', [3.6, 2.7, -10.0], 90, 160, 'S', 'pd'), hp('pd2', [-3.6, 2.7, -10.0], -90, 160, 'S', 'pd'),
  ],
  p17_ca_swarm: [
    hp('vls1', [3.1, 3.2, 11], 0, 180, 'M', 'missile', 'vls'), hp('vls2', [-3.1, 3.2, 11], 0, 180, 'M', 'missile', 'vls'),
    hp('vls3', [3.1, 3.2, 4], 0, 180, 'M', 'missile', 'vls'), hp('vls4', [-3.1, 3.2, 4], 0, 180, 'M', 'missile', 'vls'),
    hp('vls5', [3.1, 3.2, -3], 0, 180, 'M', 'missile', 'vls'), hp('vls6', [-3.1, 3.2, -3], 0, 180, 'M', 'missile', 'vls'),
    hp('vls7', [3.1, 3.2, -10], 0, 180, 'M', 'missile', 'vls'), hp('vls8', [-3.1, 3.2, -10], 0, 180, 'M', 'missile', 'vls'),
    hp('gun1', [0, 2.4, 14.6], 0, 140, 'M', 'ballistic'),
    hp('pd1', [0, 2.4, 0.5], 0, 175, 'S', 'pd'),
    hp('pd2', [0, 2.4, -7.0], 180, 175, 'S', 'pd'),
  ],
  p17_ca_aegis: [
    hp('gun1', [0, 2.5, 14.0], 0, 150, 'M', 'ballistic'),
    hp('vls1', [1.4, 2.6, 9.0], 0, 180, 'M', 'missile', 'vls'), hp('vls2', [-1.4, 2.6, 9.0], 0, 180, 'M', 'missile', 'vls'),
    hp('vls3', [1.4, 2.6, -10.5], 0, 180, 'M', 'missile', 'vls'), hp('vls4', [-1.4, 2.6, -10.5], 0, 180, 'M', 'missile', 'vls'),
    hp('pd1', [2.9, 2.5, 4.6], 60, 170, 'S', 'pd'), hp('pd2', [-2.9, 2.5, 4.6], -60, 170, 'S', 'pd'),
    hp('pd3', [2.9, 2.5, -7.6], 120, 170, 'S', 'pd'), hp('pd4', [-2.9, 2.5, -7.6], -120, 170, 'S', 'pd'),
    hp('pd5', [0, 2.5, -15.0], 180, 170, 'S', 'pd'),
  ],
  p17_ca_hydra: [
    hp('main1', [0, 3.8, 12.0], 0, 150, 'M', 'energy'),
    hp('main2', [0, 3.8, -12.0], 180, 150, 'M', 'energy'),
    hp('side1', [4.2, 1.0, 6.0], 30, 150, 'M', 'energy'), hp('side2', [-4.2, 1.0, 6.0], -30, 150, 'M', 'energy'),
    hp('pd1', [4.2, 1.0, -10.0], 90, 160, 'S', 'pd'), hp('pd2', [-4.2, 1.0, -10.0], -90, 160, 'S', 'pd'),
  ],
  p17_bc_breaker: [
    hp('main1', [0, 5.3, 16.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [0, 5.3, 7.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [0, 5.3, -17.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [4.6, 2.9, 0.0], 90, 140, 'M', 'ballistic'), hp('sec2', [-4.6, 2.9, 0.0], -90, 140, 'M', 'ballistic'),
    hp('pd1', [4.8, 2.9, 12.0], 60, 165, 'S', 'pd'), hp('pd2', [-4.8, 2.9, 12.0], -60, 165, 'S', 'pd'),
    hp('pd3', [4.8, 2.9, -12.0], 120, 165, 'S', 'pd'), hp('pd4', [-4.8, 2.9, -12.0], -120, 165, 'S', 'pd'),
  ],
  p17_bc_falchion: [
    hp('main1', [0, 3.7, 6.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [0, 2.5, 16.0], 0, 140, 'M', 'ballistic'),
    hp('pod1', [8.4, 3.2, -10.0], 60, 150, 'M', 'ballistic'), hp('pod2', [-8.4, 3.2, -10.0], -60, 150, 'M', 'ballistic'),
    hp('pd1', [3.0, 2.5, -3.0], 90, 160, 'S', 'pd'), hp('pd2', [-3.0, 2.5, -3.0], -90, 160, 'S', 'pd'),
    hp('pd3', [0, 3.7, -18.0], 180, 160, 'S', 'pd'),
  ],
  p17_bc_corsair: [
    hp('main1', [0, 2.9, 14.0], 0, 140, 'L', 'ballistic'),
    hp('deck1', [-7.5, 2.6, 5.5], -60, 140, 'M', 'ballistic'),
    hp('deck2', [-7.5, 2.6, 0.5], -90, 140, 'M', 'ballistic'),
    hp('vls1', [-2.0, 2.9, -8.0], 0, 180, 'M', 'missile', 'vls'),
    hp('pd1', [2.4, 6.9, -10.6], 180, 170, 'S', 'pd'),
    hp('pd2', [3.0, 2.9, 6.0], 90, 160, 'S', 'pd'),
    hp('pd3', [-2.5, 2.9, 20.0], -60, 160, 'S', 'pd'),
  ],
  p17_bc_monitor: [
    hp('spin1', [0, 4.3, 8.0], 0, 4, 'L', 'ballistic', 'spinal'),
    hp('sec1', [4.5, 2.1, 16.0], 60, 140, 'M', 'ballistic'), hp('sec2', [-4.5, 2.1, 16.0], -60, 140, 'M', 'ballistic'),
    hp('sec3', [4.5, 2.1, -8.0], 120, 140, 'M', 'ballistic'), hp('sec4', [-4.5, 2.1, -8.0], -120, 140, 'M', 'ballistic'),
    hp('pd1', [3.0, 2.1, -22.0], 150, 160, 'S', 'pd'), hp('pd2', [-3.0, 2.1, -22.0], -150, 160, 'S', 'pd'),
  ],
  p17_bb_solaris: [
    hp('main1', [2.2, 5.1, 12.0], 0, 140, 'L', 'energy'), hp('main2', [-2.2, 5.1, 12.0], 0, 140, 'L', 'energy'),
    hp('main3', [2.2, 5.1, -24.0], 180, 140, 'L', 'energy'), hp('main4', [-2.2, 5.1, -24.0], 180, 140, 'L', 'energy'),
    hp('sec1', [5.2, 3.3, 4.0], 90, 140, 'M', 'energy'), hp('sec2', [-5.2, 3.3, 4.0], -90, 140, 'M', 'energy'),
    hp('pd1', [3.6, 3.3, 22.0], 60, 165, 'S', 'pd'), hp('pd2', [-3.6, 3.3, 22.0], -60, 165, 'S', 'pd'),
    hp('pd3', [5.2, 3.3, -12.0], 120, 165, 'S', 'pd'), hp('pd4', [-5.2, 3.3, -12.0], -120, 165, 'S', 'pd'),
  ],
  p17_bb_hulk: [
    hp('main1', [0, 3.2, 26.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [3.6, 5.1, 6.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [-3.0, 5.1, 18.0], 0, 140, 'L', 'ballistic'),
    hp('main4', [0, 3.2, -26.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [-5.0, 3.2, 0.0], -90, 140, 'M', 'ballistic'),
    hp('sec2', [3.2, 3.2, -20.0], 90, 140, 'M', 'ballistic'),
    hp('pd1', [-1.2, 8.9, -16.6], 180, 170, 'S', 'pd'),
    hp('pd2', [5.0, 3.2, 12.0], 90, 160, 'S', 'pd'),
    hp('pd3', [-5.0, 3.2, -14.0], -90, 160, 'S', 'pd'),
  ],
  p17_bb_bastion: [
    hp('main1', [0, 6.3, 24.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [0, 6.3, 15.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [0, 8.0, 8.0], 0, 140, 'L', 'ballistic'),
    hp('main4', [0, 8.0, -14.0], 180, 140, 'L', 'ballistic'),
    hp('main5', [0, 6.3, -22.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [4.8, 6.2, 2.0], 90, 140, 'M', 'ballistic'), hp('sec2', [-4.8, 6.2, 2.0], -90, 140, 'M', 'ballistic'),
    hp('sec3', [4.8, 6.2, -8.0], 90, 140, 'M', 'ballistic'), hp('sec4', [-4.8, 6.2, -8.0], -90, 140, 'M', 'ballistic'),
    hp('pd1', [6.6, 3.1, 20.0], 60, 165, 'S', 'pd'), hp('pd2', [-6.6, 3.1, 20.0], -60, 165, 'S', 'pd'),
    hp('pd3', [6.6, 3.1, -20.0], 120, 165, 'S', 'pd'), hp('pd4', [-6.6, 3.1, -20.0], -120, 165, 'S', 'pd'),
  ],
  p17_bb_vanguard: [
    hp('main1', [5.8, 3.1, 22.0], 0, 140, 'L', 'ballistic'), hp('main2', [-5.8, 3.1, 22.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [5.8, 3.1, -22.0], 180, 140, 'L', 'ballistic'), hp('main4', [-5.8, 3.1, -22.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [8.0, 3.1, 6.0], 90, 140, 'M', 'ballistic'), hp('sec2', [-8.0, 3.1, 6.0], -90, 140, 'M', 'ballistic'),
    hp('sec3', [8.0, 3.1, -10.0], 90, 140, 'M', 'ballistic'), hp('sec4', [-8.0, 3.1, -10.0], -90, 140, 'M', 'ballistic'),
    hp('vls1', [2.0, 3.1, 8.0], 0, 180, 'M', 'missile', 'vls'), hp('vls2', [-2.0, 3.1, 8.0], 0, 180, 'M', 'missile', 'vls'),
    hp('pd1', [2.0, 3.1, -13.0], 180, 170, 'S', 'pd'), hp('pd2', [-2.0, 3.1, -13.0], 180, 170, 'S', 'pd'),
  ],
  p17_dn_citadel: [
    hp('main1', [0, 7.1, 36.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [0, 7.1, 26.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [0, 9.1, 16.0], 0, 140, 'L', 'ballistic'),
    hp('main4', [0, 10.6, -22.0], 180, 140, 'L', 'ballistic'),
    hp('main5', [0, 9.1, -32.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [6.4, 7.3, 6.0], 90, 140, 'M', 'ballistic'), hp('sec2', [-6.4, 7.3, 6.0], -90, 140, 'M', 'ballistic'),
    hp('sec3', [6.4, 7.3, -12.0], 90, 140, 'M', 'ballistic'), hp('sec4', [-6.4, 7.3, -12.0], -90, 140, 'M', 'ballistic'),
    hp('vls1', [2.6, 8.9, 8.0], 0, 180, 'M', 'missile', 'vls'), hp('vls2', [-2.6, 8.9, 8.0], 0, 180, 'M', 'missile', 'vls'),
    hp('pd1', [9.6, 3.3, 30.0], 60, 165, 'S', 'pd'), hp('pd2', [-9.6, 3.3, 30.0], -60, 165, 'S', 'pd'),
    hp('pd3', [9.6, 3.3, 0.0], 90, 165, 'S', 'pd'), hp('pd4', [-9.6, 3.3, 0.0], -90, 165, 'S', 'pd'),
    hp('pd5', [9.6, 3.3, -30.0], 120, 165, 'S', 'pd'), hp('pd6', [-9.6, 3.3, -30.0], -120, 165, 'S', 'pd'),
  ],
  p17_dn_leviathan: [
    hp('spin1', [0, 3.7, 40.0], 0, 4, 'L', 'energy', 'spinal'),
    hp('main1', [0, 5.9, 18.0], 0, 140, 'L', 'energy'),
    hp('main2', [0, 5.9, 6.0], 0, 140, 'L', 'energy'),
    hp('main3', [0, 5.9, -24.0], 180, 140, 'L', 'energy'),
    hp('sec1', [5.0, 3.7, 10.0], 90, 140, 'M', 'energy'), hp('sec2', [-5.0, 3.7, 10.0], -90, 140, 'M', 'energy'),
    hp('sec3', [5.0, 3.7, -20.0], 90, 140, 'M', 'energy'), hp('sec4', [-5.0, 3.7, -20.0], -90, 140, 'M', 'energy'),
    hp('pd1', [3.8, 3.7, 26.0], 60, 165, 'S', 'pd'), hp('pd2', [-3.8, 3.7, 26.0], -60, 165, 'S', 'pd'),
    hp('pd3', [3.0, 5.9, -30.0], 180, 165, 'S', 'pd'), hp('pd4', [-3.0, 5.9, -30.0], 180, 165, 'S', 'pd'),
  ],
  p17_dn_sovereign: [
    hp('main1', [0, 10.6, 24.0], 0, 140, 'L', 'ballistic'),
    hp('main2', [0, 10.6, 14.0], 0, 140, 'L', 'ballistic'),
    hp('main3', [0, 10.6, 5.0], 0, 140, 'L', 'ballistic'),
    hp('main4', [0, 10.6, -17.0], 180, 140, 'L', 'ballistic'),
    hp('main5', [0, 10.6, -24.0], 180, 140, 'L', 'ballistic'),
    hp('main6', [0, 10.6, -31.0], 180, 140, 'L', 'ballistic'),
    hp('sec1', [5.5, 5.6, 16.0], 90, 130, 'M', 'ballistic'), hp('sec2', [-5.5, 5.6, 16.0], -90, 130, 'M', 'ballistic'),
    hp('sec3', [5.5, 5.6, -6.0], 90, 130, 'M', 'ballistic'), hp('sec4', [-5.5, 5.6, -6.0], -90, 130, 'M', 'ballistic'),
    hp('sec5', [5.5, 5.6, -26.0], 90, 130, 'M', 'ballistic'), hp('sec6', [-5.5, 5.6, -26.0], -90, 130, 'M', 'ballistic'),
    hp('pd1', [5.5, 5.6, 6.0], 90, 150, 'S', 'pd'), hp('pd2', [-5.5, 5.6, 6.0], -90, 150, 'S', 'pd'),
    hp('pd3', [5.5, 5.6, -16.0], 90, 150, 'S', 'pd'), hp('pd4', [-5.5, 5.6, -16.0], -90, 150, 'S', 'pd'),
  ],
  p17_cv_hive: [
    hp('h1', [5.2, 4.9, 18.0], 90, 180, 'L', 'hangar', 'deck'), hp('h2', [-5.2, 4.9, 18.0], -90, 180, 'L', 'hangar', 'deck'),
    hp('h3', [5.2, 4.9, -4.0], 90, 180, 'L', 'hangar', 'deck'), hp('h4', [-5.2, 4.9, -4.0], -90, 180, 'L', 'hangar', 'deck'),
    hp('sec1', [0, 3.0, 22.0], 0, 150, 'M', 'ballistic'),
    hp('pd1', [5.2, 4.9, 7.0], 90, 170, 'S', 'pd'), hp('pd2', [-5.2, 4.9, 7.0], -90, 170, 'S', 'pd'),
    hp('pd3', [5.2, 4.9, -15.0], 90, 170, 'S', 'pd'), hp('pd4', [-5.2, 4.9, -15.0], -90, 170, 'S', 'pd'),
    hp('pd5', [0, 3.0, -27.0], 180, 170, 'S', 'pd'),
  ],
  p17_cv_ark: [
    hp('h1', [3.0, 4.5, 10.0], 90, 180, 'L', 'hangar', 'deck'), hp('h2', [-3.0, 4.5, 10.0], -90, 180, 'L', 'hangar', 'deck'),
    hp('h3', [3.0, 4.5, -12.0], 90, 180, 'L', 'hangar', 'deck'), hp('h4', [-3.0, 4.5, -12.0], -90, 180, 'L', 'hangar', 'deck'),
    hp('h5', [-3.0, 4.5, 22.0], -90, 180, 'L', 'hangar', 'deck'),
    hp('sec1', [10.6, 8.9, -6.6], 60, 150, 'M', 'ballistic'), hp('sec2', [10.6, 8.9, -20.6], 120, 150, 'M', 'ballistic'),
    hp('pd1', [8.5, 4.5, 26.0], 60, 170, 'S', 'pd'), hp('pd2', [-8.5, 4.5, 26.0], -60, 170, 'S', 'pd'),
    hp('pd3', [-8.5, 4.5, -26.0], -120, 170, 'S', 'pd'), hp('pd4', [8.5, 4.5, -28.0], 120, 170, 'S', 'pd'),
  ],
};

// ═══════════════════════════════════════════════════════════════════════════ makers / product lines
const M = {
  union: '연합 방위조선', helios: '헬리오스 조병창', ceres: '세레스 공업', bastion: '바스티온 중공업',
  rust: '러스트포트 자유조선', pirate: '해적 개조업체', cobalt: '코발트 양산공창', old: '구 제국 군수창', guild: '상인 길드 조선', iron: '철갑 사령부 공창',
} as const;

const shop = (stations: string[], price: number): BlueprintSource => ({ kind: 'shop', stations, price });
const lic = (stations: string[], price: number, rep: number, contracts?: number): BlueprintSource => ({ kind: 'commercial', stations, price, rep, ...(contracts ? { contracts } : {}) });
const fac = (faction: Extract<BlueprintSource, { kind: 'faction' }>['faction'], stations: string[], price: number, trust: number, contracts?: number): BlueprintSource =>
  ({ kind: 'faction', faction, stations, price, influence: 0, trust, ...(contracts ? { contracts } : {}), repOnly: true });
const salv = (fragments: number, chance: number): BlueprintSource => ({ kind: 'salvage', fragments, chance });
/** P19 exploration hook: found in derelict archives (no exploration system is added here) */
const exp = (tier: number, chance: number): BlueprintSource => ({ kind: 'explore', tier, chance });
const contract = (minTier: number, chance: number): BlueprintSource => ({ kind: 'contract', minTier, chance });

const ROWS: Row[] = [
  // ─────────────────────────────────────────────────────────── corvettes
  { id: 'p17_cv_militia', cls: 'corvette', name: '민병급', maker: M.cobalt, line: '코발트 양산', tier: 1, size: 'S', base: 'p17_cv_militia', power: 16, mass: 26, grade: 'common',
    desc: '평판 화살촉 선체에 조종실 상자와 보조 연료통을 볼트로 붙인 염가 초계정. 민병대와 신생 회사가 가장 먼저 사는 배다. 장갑과 속도 모두 평범 이하지만 값과 유지비가 압도적으로 싸다.',
    stats: { hpMul: 0.86, armorMul: 0.82, speedMul: 0.97 }, cruise: 132, k: 0.75, credits: 950, upkeep: 220, supplies: { chemicals: 0.3 },
    sale: { stations: ['astra', 'nova', 'exchange', 'barcaco', 'rustport', 'cinderco'], stock: 5, restock: 1800 },
    int: 'specialM', hps: HP.p17_cv_militia, cpu: 'cpu_generic', fit: { main1: 'eq_autocannon_40', gun1: 'eq_autocannon_40', pd1: 'eq_pd_gun' }, pname: '민병 초계', pdesc: '양산 40mm 기관포 2, 방공포 1. 싸고 쉽게 잃는다.',
    bp: [shop(['astra', 'nova', 'exchange', 'barcaco'], 2600)] },
  { id: 'p17_cv_blackwing', cls: 'corvette', name: '흑익급', maker: M.rust, line: '러스트포트 습격선', tier: 1, size: 'S', base: 'p17_cv_blackwing', power: 14, mass: 36, grade: 'faction',
    desc: '갈라진 두 선수 안에 고정 어뢰관을 하나씩 넣은 해적 뇌격정. 측면 사격 능력이 거의 없어 함수를 표적에 맞춰야 쏠 수 있다. 엔진은 과할 만큼 크다.',
    stats: { hpMul: 0.82, armorMul: 0.78, speedMul: 1.12 }, cruise: 150, k: 0.85, credits: 1500, upkeep: 300, supplies: { chemicals: 0.6 },
    sale: { stations: ['rustport', 'drakeout'], stock: 3, restock: 2400 },
    int: 'engineS specialM', hps: HP.p17_cv_blackwing, cpu: 'cpu_siege', fit: { torp1: 'eq_torpedo', torp2: 'eq_torpedo', pd1: 'eq_pd_gun' }, pname: '쌍어뢰 습격', pdesc: '고정 어뢰관 2, 방공포 1. 대형함 측후방 돌입용.',
    bp: [fac('pirates', ['rustport'], 9000, 20), salv(3, 0.06)] },
  { id: 'p17_cv_spark', cls: 'corvette', name: '불티급', maker: M.ceres, line: '세레스 에너지', tier: 2, size: 'S', base: 'p17_cv_spark', power: 32, mass: 22, grade: 'advanced',
    desc: '바늘 같은 선체가 노출된 링 드라이브를 관통하는 고속 에너지 초계정. 반응로 여유가 커서 레이저 둘을 상시 가동한다. 선체가 가늘어 한 번 맞으면 쉽게 부서진다.',
    stats: { hpMul: 0.74, armorMul: 0.7, speedMul: 1.16 }, cruise: 162, k: 0.9, credits: 2600, extra: { crystal: 4, precision: 2 }, tech: ['optical_lasers'], fac: ['electronics_fab'], upkeep: 480, supplies: { electronics: 0.1 },
    sale: { stations: ['p9_ceres_works', 'helios'], rep: 10, stock: 2, restock: 3600 },
    int: 'reactorM sensorS', hps: HP.p17_cv_spark, cpu: 'cpu_swarm', fit: { las1: 'eq_arc_s', las2: 'eq_arc_s', pd1: 'eq_pd_gun' }, pname: '적색 레이저 강습', pdesc: '소형 아크 방출기 2, 방공포 1. 소형함 무리에 튄다.',
    bp: [lic(['p9_ceres_works', 'helios'], 26000, 12), exp(1, 0.05)] },
  { id: 'p17_cv_hornet', cls: 'corvette', name: '말벌급', maker: M.helios, line: '헬리오스 정밀', tier: 2, size: 'S', base: 'p17_cv_hornet', power: 20, mass: 40, grade: 'advanced',
    desc: '중앙 칼날 선체와 미사일 발사기를 얹은 두 외곽 선체를 지주로 이은 삼동선 초계함. 작은 선체에 VLS 두 기를 실어 초계함치고 화력이 높다. 지주가 약점이다.',
    stats: { hpMul: 0.9, armorMul: 0.86, speedMul: 1.02 }, cruise: 140, k: 1.1, credits: 2400, extra: { electronics: 2 }, tech: ['guided_missiles'], upkeep: 420, supplies: { chemicals: 1.2 },
    sale: { stations: ['helios'], rep: 8, stock: 2, restock: 3000 },
    int: 'fcsS specialM', hps: HP.p17_cv_hornet, cpu: 'cpu_artillery', fit: { vls1: 'eq_swarm_lite', vls2: 'eq_missile_rack', gun1: 'eq_autocannon', pd1: 'eq_pd_gun' }, pname: '미사일 초계', pdesc: '경량 확산 미사일 1, VLS 1, 기관포 1, 방공포 1.',
    bp: [lic(['helios'], 24000, 10), exp(1, 0.05)] },
  { id: 'p17_cv_relic', cls: 'corvette', name: '유물급', maker: M.old, line: '구 제국 잔존 설계', tier: 1, size: 'S', base: 'p17_cv_relic', power: 14, mass: 46, grade: 'common',
    desc: '늑골이 드러난 원통 선체와 높은 구식 사령탑을 가진 구 제국 초계함. 기관포 셋을 올린 튼튼한 배지만 느리고 연비가 나쁘다. 부품이 흔해 수리비가 싸다.',
    stats: { hpMul: 1.12, armorMul: 1.05, speedMul: 0.84 }, cruise: 118, k: 0.9, credits: 1200, upkeep: 330, supplies: { chemicals: 0.8 }, wear: 0.07,
    sale: { stations: ['drakeout', 'cinderco', 'barcaco'], stock: 2, restock: 4200 },
    int: 'armorM', hps: HP.p17_cv_relic, cpu: 'cpu_generic', fit: { gun1: 'eq_autocannon', gun2: 'eq_autocannon', gun3: 'eq_autocannon', pd1: 'eq_pd_gun' }, pname: '구식 포정', pdesc: '기관포 3, 방공포 1.',
    bp: [salv(2, 0.1), exp(1, 0.08)] },
  // ─────────────────────────────────────────────────────────── frigates
  { id: 'p17_ff_mirage', cls: 'frigate', name: '신기루급', maker: M.guild, line: '길드 호송', tier: 2, size: 'S', base: 'p17_ff_mirage', power: 30, mass: 26, grade: 'advanced',
    desc: '렌즈형 원반 선수에 안테나 관을 두른 길드 전자전 호위함. 전자전 베이 둘과 방공포 셋으로 호송대를 지키지만 대함 화력은 범용 포좌 하나뿐이다.',
    stats: { hpMul: 0.86, armorMul: 0.8, speedMul: 1.04 }, cruise: 150, k: 1.0, credits: 3600, extra: { electronics: 6, sensor: 1 }, tech: ['ecm'], fac: ['electronics_fab'], upkeep: 640, supplies: { electronics: 0.15 },
    sale: { stations: ['exchange', 'astra'], rep: 8, stock: 2, restock: 4200 },
    int: 'ewS ewS sensorS', hps: HP.p17_ff_mirage, cpu: 'cpu_picket', fit: { gun1: 'eq_autocannon', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun' }, pname: '호송 교란', pdesc: '기관포 1, 방공포 3. 전자전 장비 공간 2.',
    bp: [fac('guild', ['astra'], 28000, 20, 2), lic(['exchange'], 34000, 15)] },
  { id: 'p17_ff_shieldwall', cls: 'frigate', name: '방벽급', maker: M.bastion, line: '바스티온 중장갑', tier: 2, size: 'S', base: 'p17_ff_shieldwall', power: 22, mass: 58, grade: 'faction',
    desc: '선수에 이격 장갑 쟁기를 단 저상 포곽 호위함. 정면 장갑이 순양함급이라 돌격의 선두에 선다. 무겁고 느리며 측면 화력이 약하다.',
    stats: { hpMul: 1.12, armorMul: 1.35, speedMul: 0.86 }, cruise: 118, k: 1.15, credits: 3400, extra: { armor_plate: 8 }, tech: ['reactive_armor'], fac: ['armor_plant'], upkeep: 600, supplies: { alloy: 0.1 },
    sale: { stations: ['bastion'], rep: 12, stock: 2, restock: 4800 },
    int: 'armorM armorM', hps: HP.p17_ff_shieldwall, cpu: 'cpu_line', fit: { main1: 'eq_medium_gun', gun1: 'eq_autocannon', gun2: 'eq_autocannon', pd1: 'eq_pd_gun' }, pname: '장갑 선봉', pdesc: '부포 1, 기관포 2, 방공포 1.',
    bp: [fac('iron', ['p10_bulwark_yard'], 30000, 24), lic(['bastion'], 36000, 18)] },
  { id: 'p17_ff_lantern', cls: 'frigate', name: '등불급', maker: M.union, line: '연합 표준', tier: 1, size: 'S', base: 'p17_ff_lantern', power: 26, mass: 44, grade: 'common',
    desc: '캡슐형 선체에 쌍 엔진 나셀과 투명 함교를 단 연합 표준 호위함. 값싸고 고장이 없으며 포·미사일·방공을 고루 갖춘 걸작으로 꼽힌다.',
    stats: { hpMul: 1.0, armorMul: 1.0, speedMul: 1.02 }, cruise: 142, k: 0.95, credits: 2300, upkeep: 420, supplies: { chemicals: 0.6 },
    sale: { stations: ['helios', 'bastion', 'astra', 'nova'], stock: 3, restock: 3000 },
    int: 'specialM sensorS', hps: HP.p17_ff_lantern, cpu: 'cpu_line', fit: { gun1: 'eq_autocannon', vls1: 'eq_missile_2stage', gun2: 'eq_autocannon', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '표준 호위', pdesc: '기관포 2, 2단 돌입 미사일 1, 방공포 2.',
    bp: [shop(['helios', 'bastion', 'astra'], 7000)] },
  { id: 'p17_ff_scrap', cls: 'frigate', name: '고철급', maker: M.pirate, line: '해적 개조', tier: 1, size: 'S', base: 'p17_ff_scrap', power: 18, mass: 40, grade: 'faction',
    desc: '화물 컨테이너를 좌현에 용접해 미사일 발사기로 쓰는 비대칭 해적 호위함. 함교는 우현에 치우쳐 있다. 싸고 무장도 괜찮지만 정비 불량으로 마모가 빠르다.',
    stats: { hpMul: 0.92, armorMul: 0.86, speedMul: 0.98 }, cruise: 136, k: 0.8, credits: 1700, upkeep: 380, supplies: { chemicals: 0.8 }, wear: 0.08,
    sale: { stations: ['rustport', 'drakeout'], stock: 3, restock: 2700 },
    int: 'specialM', hps: HP.p17_ff_scrap, cpu: 'cpu_swarm', fit: { gun1: 'eq_autocannon', vls1: 'eq_swarm_box', gun2: 'eq_autocannon', pd1: 'eq_pd_gun' }, pname: '컨테이너 발사대', pdesc: '기관포 2, 군집 컨테이너 VLS 1, 방공포 1.',
    bp: [fac('pirates', ['rustport'], 11000, 15), salv(3, 0.08)] },
  // ─────────────────────────────────────────────────────────── destroyers
  { id: 'p17_dd_hedgehog', cls: 'destroyer', name: '고슴도치급', maker: M.union, line: '연합 표준', tier: 2, size: 'M', base: 'p17_dd_hedgehog', power: 44, mass: 54, grade: 'advanced',
    desc: '좁은 선체 양현에 방공 스폰슨 여덟 개를 가시처럼 늘어놓은 방공 구축함. 레이더 쌍 돛대가 미사일 포화를 먼 곳에서 잡아낸다. 대함 화력은 부포 둘뿐이다.',
    stats: { hpMul: 0.96, armorMul: 0.92, speedMul: 1.0 }, cruise: 112, k: 1.0, credits: 4600, extra: { sensor: 1 }, tech: ['pd_network'], upkeep: 880, supplies: { chemicals: 1.0 },
    sale: { stations: ['helios', 'bastion', 'astra'], rep: 8, stock: 2, restock: 5400 },
    int: 'fcsS sensorS specialM', hps: HP.p17_dd_hedgehog, cpu: 'cpu_picket', fit: { main1: 'eq_medium_gun', main2: 'eq_medium_gun', pd1: 'eq_flak_heavy', pd2: 'eq_flak_heavy', pd3: 'eq_flak_prox', pd4: 'eq_flak_prox', pd5: 'eq_pd_gun', pd6: 'eq_pd_gun', pd7: 'eq_pd_gun', pd8: 'eq_pd_gun' }, pname: '함대 방공', pdesc: '부포 2, 중(重) 탄막 포대 2, 근접 신관 탄막포 2, 방공포 4. 자탄 무리 차단용.',
    bp: [lic(['helios', 'bastion'], 52000, 15, 2), exp(2, 0.05)] },
  { id: 'p17_dd_hammerhead', cls: 'destroyer', name: '귀상어급', maker: M.bastion, line: '바스티온 중장갑', tier: 3, size: 'M', base: 'p17_dd_hammerhead', power: 40, mass: 120, grade: 'faction',
    desc: '망치처럼 넓은 장갑 선수 블록 양끝에 포탑을 단 근접 격투 구축함. 짧고 두꺼운 선체에 주포 하나를 실었다. 비싸고 느리지만 근거리에서는 순양함과도 맞선다.',
    stats: { hpMul: 1.2, armorMul: 1.3, speedMul: 0.86 }, cruise: 96, k: 1.3, credits: 8600, extra: { armor_plate: 14, composite: 6 }, tech: ['reactive_armor', 'heavy_ordnance'], fac: ['armor_plant'], upkeep: 1500, supplies: { alloy: 0.2, chemicals: 0.6 },
    sale: { stations: ['bastion'], rep: 25, stock: 1, restock: 9000 },
    int: 'armorM armorM reactorM', hps: HP.p17_dd_hammerhead, cpu: 'cpu_swarm', fit: { ham1: 'eq_medium_gun', ham2: 'eq_medium_gun', main1: 'eq_coil_l', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '근접 격투', pdesc: '대구경 코일포 1, 부포 2, 방공포 2.',
    bp: [fac('iron', ['p10_bulwark_yard'], 90000, 35, 4), contract(3, 0.12)] },
  { id: 'p17_dd_scavenger', cls: 'destroyer', name: '넝마주이급', maker: M.rust, line: '러스트포트 습격선', tier: 1, size: 'M', base: 'p17_dd_scavenger', power: 30, mass: 60, grade: 'faction',
    desc: '두 선체 사이에 열린 인양 요람을 두고 크레인을 얹은 쌍동 구축함. 원래 인양선이었으나 포를 달아 해적 순찰선이 되었다. 싸고 튼튼하지만 무장 배치가 어설프다.',
    stats: { hpMul: 1.05, armorMul: 0.88, speedMul: 0.92 }, cruise: 104, k: 0.85, credits: 3000, extra: { machinery: 8 }, upkeep: 620, supplies: { chemicals: 0.8 }, wear: 0.07,
    sale: { stations: ['rustport', 'drakeout'], stock: 2, restock: 4800 },
    int: 'specialM specialM', hps: HP.p17_dd_scavenger, cpu: 'cpu_generic', fit: { gun1: 'eq_medium_gun', gun2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '해적 순찰', pdesc: '부포 2, 방공포 2.',
    bp: [fac('pirates', ['rustport'], 26000, 20), salv(4, 0.06)] },
  { id: 'p17_dd_spindle', cls: 'destroyer', name: '물레가락급', maker: M.helios, line: '헬리오스 정밀', tier: 3, size: 'M', base: 'p17_dd_spindle', power: 52, mass: 70, grade: 'rare',
    desc: '선수 밖까지 뻗은 함축 코일 포신을 중심으로 만든 장거리 저격 구축함. 레일 캐논을 함축으로 고정해 사계가 매우 좁다. 선체를 표적에 맞추는 동안 취약하다.',
    stats: { hpMul: 0.88, armorMul: 0.86, speedMul: 1.06 }, cruise: 118, k: 1.25, credits: 9400, extra: { precision: 6, rare_metal: 4 }, tech: ['railguns'], fac: ['electronics_fab'], upkeep: 1350, supplies: { electronics: 0.2 },
    sale: { stations: ['helios'], rep: 30, stock: 1, restock: 9000 },
    int: 'fcsS reactorM sensorS', hps: HP.p17_dd_spindle, cpu: 'cpu_artillery', fit: { spin1: 'eq_rail_cannon', gun1: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '함축 저격', pdesc: '함축 레일 캐논 1, 부포 1, 방공포 2.',
    bp: [lic(['helios'], 120000, 35, 4), exp(3, 0.03)] },
  { id: 'p17_dd_tempest', cls: 'destroyer', name: '돌개바람급', maker: M.cobalt, line: '코발트 양산', tier: 1, size: 'M', base: 'p17_dd_tempest', power: 34, mass: 56, grade: 'common',
    desc: '상자 세 개를 이어 붙인 모듈식 양산 구축함. 셀 랙을 그대로 드러낸 갑판에 VLS 둘을 두었다. 성능은 무난하고 건조가 빠르며, 유지비가 표준 구축함보다 싸다.',
    stats: { hpMul: 0.94, armorMul: 0.9, speedMul: 0.98 }, cruise: 110, k: 0.8, credits: 3200, upkeep: 680, supplies: { chemicals: 1.2 },
    sale: { stations: ['astra', 'nova', 'exchange', 'barcaco'], stock: 3, restock: 4200 },
    int: 'specialM specialM', hps: HP.p17_dd_tempest, cpu: 'cpu_line', fit: { gun1: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_mine_layer', gun2: 'eq_autocannon', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '양산 다목적', pdesc: '부포 1, VLS 1, 근접 기뢰 투하기 1, 기관포 1, 방공포 2.',
    bp: [shop(['astra', 'nova', 'exchange'], 18000)] },
  { id: 'p17_dd_forge', cls: 'destroyer', name: '대장간급', maker: '바르카·연합 합작', line: '산업 군용 겸용', tier: 2, size: 'M', base: 'p17_dd_forge', power: 40, mass: 64, grade: 'advanced',
    desc: '노출된 갠트리와 가공 드럼을 실은 군·산 겸용 공작 구축함. 포 둘과 방공포를 갖추고, 후갑판에 지원(R) 포좌를 두어 전투 수리 장비를 달 수 있다. 무장은 평범하다.',
    stats: { hpMul: 1.02, armorMul: 0.9, speedMul: 0.92 }, cruise: 100, k: 1.05, credits: 5200, extra: { machinery: 14 }, tech: ['damage_control'], fac: ['machine_shop'], upkeep: 900, supplies: { machinery: 0.1 },
    sale: { stations: ['barcaco', 'astra'], rep: 10, stock: 1, restock: 6000 },
    int: 'specialM specialM sensorS', hps: HP.p17_dd_forge, cpu: 'cpu_line', fit: { gun1: 'eq_medium_gun', gun2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '무장 공작', pdesc: '부포 2, 방공포 2. 지원 포좌는 비워 둔다(전투 수리 장비 별도).',
    bp: [lic(['barcaco', 'astra'], 48000, 12, 2), exp(2, 0.04)] },
  // ─────────────────────────────────────────────────────────── light cruisers
  { id: 'p17_cl_longbow', cls: 'light_cruiser', name: '장궁급', maker: M.ceres, line: '세레스 에너지', tier: 3, size: 'M', base: 'p17_cl_longbow', power: 70, mass: 76, grade: 'rare',
    desc: '선수보다 길게 뻗은 함축 레일과 등 위의 축전기 열을 가진 긴 경순양함. 사거리는 함대 최고 수준이지만 선체가 가늘고, 근접전에서는 포탑 둘로 버텨야 한다.',
    stats: { hpMul: 0.9, armorMul: 0.88, speedMul: 1.02 }, cruise: 108, k: 1.2, credits: 14000, extra: { precision: 8, crystal: 6 }, tech: ['railguns', 'fusion_reactors'], fac: ['electronics_fab'], upkeep: 2100, supplies: { electronics: 0.25 },
    sale: { stations: ['p9_ceres_works'], rep: 35, stock: 1, restock: 14400 },
    int: 'fcsS reactorM sensorS specialM', hps: HP.p17_cl_longbow, cpu: 'cpu_artillery', fit: { spin1: 'eq_rail_cannon', gun1: 'eq_medium_gun', gun2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '장거리 저격', pdesc: '함축 레일 1, 부포 2, 방공포 2.',
    bp: [lic(['p9_ceres_works'], 160000, 40, 5), exp(3, 0.03), salv(6, 0.03)] },
  { id: 'p17_cl_siren', cls: 'light_cruiser', name: '세이렌급', maker: M.guild, line: '길드 호송', tier: 2, size: 'M', base: 'p17_cl_siren', power: 56, mass: 58, grade: 'advanced',
    desc: '앞뒤로 이어진 쌍 붐 사이에 교란 접시 배열을 매단 전자전 경순양함. 전자전·센서 베이가 많아 함대 지원에 뛰어나지만 쌍 붐 구조라 피격 면적이 넓다.',
    stats: { hpMul: 0.92, armorMul: 0.84, speedMul: 1.0 }, cruise: 112, k: 1.05, credits: 9800, extra: { electronics: 12, sensor: 2 }, tech: ['ecm', 'long_sensors'], fac: ['comms'], upkeep: 1600, supplies: { electronics: 0.3 },
    sale: { stations: ['exchange'], rep: 20, stock: 1, restock: 10800 },
    int: 'ewS ewS sensorS sensorS fcsS', hps: HP.p17_cl_siren, cpu: 'cpu_picket', fit: { gun1: 'eq_medium_gun', gun2: 'eq_medium_gun', gun3: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '전자전 지원', pdesc: '부포 3, 방공포 2. 전자전 베이 2, 센서 베이 2.',
    bp: [fac('guild', ['astra'], 85000, 30, 3), lic(['exchange'], 95000, 25, 3)] },
  { id: 'p17_cl_warden', cls: 'light_cruiser', name: '파수장급', maker: M.union, line: '연합 표준', tier: 2, size: 'M', base: 'p17_cl_warden', power: 60, mass: 70, grade: 'advanced',
    desc: '앞뒤로 높인 포갑판과 중앙 탑을 가진 고전적인 계단형 경순양함. 포 셋, VLS 둘, 방공포 넷으로 어떤 임무에도 무난하다. 특출난 점이 없는 대신 약점도 없다.',
    stats: { hpMul: 1.0, armorMul: 1.0, speedMul: 1.0 }, cruise: 104, k: 1.0, credits: 8200, upkeep: 1400, supplies: { chemicals: 1.6 },
    sale: { stations: ['helios', 'bastion', 'exchange'], rep: 18, stock: 1, restock: 9600 },
    int: 'fcsS sensorS specialM specialM', hps: HP.p17_cl_warden, cpu: 'cpu_line', fit: { main1: 'eq_medium_gun', main2: 'eq_medium_gun', main3: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '전열 표준', pdesc: '부포 3, VLS 2, 방공포 4.',
    bp: [lic(['helios', 'bastion'], 88000, 22, 3), fac('union', ['helios'], 82000, 28, 3), exp(2, 0.04)] },
  { id: 'p17_cl_ironside', cls: 'light_cruiser', name: '철현급', maker: M.old, line: '구 제국 잔존 설계', tier: 1, size: 'M', base: 'p17_cl_ironside', power: 38, mass: 110, grade: 'common',
    desc: '포문 달린 포곽과 높은 탑식 함교, 거대한 연돌을 가진 구 제국 경순양함. 중포 하나와 측면 포곽 넷으로 화력은 묵직하지만 느리고 사격 통제가 낡았다. 값싼 중고 전력.',
    stats: { hpMul: 1.14, armorMul: 1.08, speedMul: 0.8 }, cruise: 90, k: 0.95, credits: 5200, upkeep: 1200, supplies: { chemicals: 1.8 }, wear: 0.08,
    sale: { stations: ['barcaco', 'nova'], stock: 1, restock: 12000 },
    int: 'armorM specialM', hps: HP.p17_cl_ironside, cpu: 'cpu_generic', fit: { main1: 'eq_howitzer_l', cas1: 'eq_medium_gun', cas2: 'eq_medium_gun', cas3: 'eq_medium_gun', cas4: 'eq_medium_gun', pd1: 'eq_pd_gun' }, pname: '포곽 전열', pdesc: '장포신 곡사 주포 1, 포곽 부포 4, 방공포 1.',
    bp: [salv(4, 0.08), exp(2, 0.06), shop(['barcaco'], 30000)] },
  // ─────────────────────────────────────────────────────────── cruisers
  { id: 'p17_ca_nova', cls: 'cruiser', name: '신성급', maker: M.ceres, line: '세레스 에너지', tier: 3, size: 'L', base: 'p17_ca_nova', power: 110, mass: 92, grade: 'rare',
    desc: '선체 중앙을 빛나는 반응로 고리가 관통하는 에너지 순양함. 광학 포좌 다섯이 상시 가동하며 실탄 보급이 거의 필요 없다. 고리는 피격 시 큰 표적이 된다.',
    stats: { hpMul: 0.94, armorMul: 0.92, speedMul: 1.02 }, cruise: 100, k: 1.15, credits: 21000, extra: { crystal: 14, precision: 8 }, tech: ['blue_lasers', 'fusion_reactors'], fac: ['electronics_fab'], upkeep: 2900, supplies: { electronics: 0.4 },
    sale: { stations: ['p9_ceres_works'], rep: 40, stock: 1, restock: 18000 },
    int: 'reactorM reactorM fcsS sensorS', hps: HP.p17_ca_nova, cpu: 'cpu_line', fit: { las1: 'eq_laser_blue', las2: 'eq_laser_blue', las3: 'eq_laser_blue', las4: 'eq_beam_s', las5: 'eq_beam_s', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '광학 전열', pdesc: '청색 레이저 3, 소형 절단 빔 2, 방공포 2.',
    bp: [lic(['p9_ceres_works'], 210000, 45, 6), fac('ceres', ['p9_ceres_works'], 200000, 40, 5), exp(3, 0.02)] },
  { id: 'p17_ca_swarm', cls: 'cruiser', name: '벌떼급', maker: M.pirate, line: '해적 개조', tier: 2, size: 'L', base: 'p17_ca_swarm', power: 50, mass: 140, grade: 'faction',
    desc: '열린 골조 척추에 미사일 컨테이너 랙 여덟 개를 볼트로 단 해적 미사일 바지선. 일제사격은 무섭지만 장갑이 얇고 랙이 터지면 줄줄이 유폭한다.',
    stats: { hpMul: 0.86, armorMul: 0.74, speedMul: 0.94 }, cruise: 98, k: 0.85, credits: 9500, extra: { machinery: 10 }, tech: ['guided_missiles'], upkeep: 2000, supplies: { chemicals: 3.5 }, wear: 0.07,
    int: 'specialM specialM fcsS', hps: HP.p17_ca_swarm, cpu: 'cpu_artillery', fit: { vls1: 'eq_swarm_box', vls2: 'eq_swarm_box', vls3: 'eq_swarm_box', vls4: 'eq_swarm_box', vls5: 'eq_missile_tot', vls6: 'eq_missile_tot', vls7: 'eq_missile_decoy', vls8: 'eq_missile_decoy', gun1: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '미사일 바지선', pdesc: '군집 컨테이너 4, 동시 탄착 2, 기만 유도탄 2, 부포 1, 방공포 2.',
    bp: [fac('pirates', ['rustport'], 70000, 30, 3), salv(5, 0.05)] },
  { id: 'p17_ca_aegis', cls: 'cruiser', name: '아이기스-II급', maker: M.helios, line: '헬리오스 정밀', tier: 3, size: 'L', base: 'p17_ca_aegis', power: 70, mass: 104, grade: 'rare',
    desc: '네 면에 위상배열 판을 붙인 높은 다면체 상부구조의 방공 순양함. 방공포 다섯과 VLS 넷, 사격통제·센서 베이로 함대의 미사일 방패가 된다. 매우 비싸다.',
    stats: { hpMul: 0.98, armorMul: 0.96, speedMul: 0.98 }, cruise: 100, k: 1.25, credits: 24000, extra: { electronics: 16, sensor: 3, precision: 6 }, tech: ['pd_network', 'long_sensors'], fac: ['electronics_fab', 'comms'], upkeep: 3200, supplies: { chemicals: 2, electronics: 0.4 },
    sale: { stations: ['helios'], rep: 45, stock: 1, restock: 21600 },
    int: 'fcsS fcsS sensorS sensorS specialM', hps: HP.p17_ca_aegis, cpu: 'cpu_picket', fit: { gun1: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', vls3: 'eq_missile_rack', vls4: 'eq_missile_rack', pd1: 'eq_flak_prox', pd2: 'eq_flak_prox', pd3: 'eq_flak_prox', pd4: 'eq_pd_gun', pd5: 'eq_pd_gun' }, pname: '함대 방공', pdesc: '부포 1, VLS 4, 근접 신관 탄막포 3, 방공포 2.',
    bp: [lic(['helios'], 240000, 50, 6), contract(4, 0.08)] },
  { id: 'p17_ca_hydra', cls: 'cruiser', name: '히드라급', maker: M.ceres, line: '세레스 실험선', tier: 3, size: 'L', base: 'p17_ca_hydra', power: 96, mass: 84, grade: 'rare',
    desc: '세 개의 독립 선체를 골조로 묶고 각각에 추진기를 단 실험 순양함. 에너지 포좌 넷을 넓게 벌려 사계는 좋지만, 골조가 약하고 유지비가 지나치게 비싸 실패작으로 남았다.',
    stats: { hpMul: 0.82, armorMul: 0.8, speedMul: 1.0 }, cruise: 96, k: 1.3, credits: 26000, extra: { crystal: 12, precision: 10 }, tech: ['plasma_containment'], fac: ['electronics_fab'], upkeep: 3800, supplies: { electronics: 0.5, chemicals: 1.5 }, wear: 0.08,
    int: 'reactorM reactorM sensorS', hps: HP.p17_ca_hydra, cpu: 'cpu_line', fit: { main1: 'eq_plasma_burst', main2: 'eq_plasma_burst', side1: 'eq_arc_projector', side2: 'eq_arc_projector', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '삼동 실험', pdesc: '플라즈마 폭렬포 2, 연쇄 아크 투사기 2, 방공포 2.',
    bp: [exp(3, 0.04), salv(6, 0.04)] },
  // ─────────────────────────────────────────────────────────── battlecruisers
  { id: 'p17_bc_breaker', cls: 'battlecruiser', name: '파성급', maker: M.bastion, line: '바스티온 중장갑', tier: 3, size: 'L', base: 'p17_bc_breaker', power: 110, mass: 260, grade: 'faction',
    desc: '거대한 장갑 쐐기 선수와 세 개의 중포 바벳, 이격 장갑 띠를 가진 공성 순양전함. 요새와 전열함을 깨려고 만들었다. 정면은 단단하지만 측후방 방공이 부족하다.',
    stats: { hpMul: 1.12, armorMul: 1.26, speedMul: 0.88 }, cruise: 84, k: 1.15, credits: 29000, extra: { armor_plate: 30 }, tech: ['heavy_ordnance', 'reactive_armor'], fac: ['armor_plant'], upkeep: 4300, supplies: { alloy: 0.4, chemicals: 2 },
    sale: { stations: ['bastion'], rep: 55, stock: 1, restock: 32400 },
    int: 'armorM armorM reactorM specialM fcsS', hps: HP.p17_bc_breaker, cpu: 'cpu_line', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '공성 전열', pdesc: '주포 3, 부포 2, 방공포 4.',
    bp: [fac('iron', ['p10_bulwark_yard'], 260000, 40, 6), contract(4, 0.1)] },
  { id: 'p17_bc_falchion', cls: 'battlecruiser', name: '팔시온급', maker: M.helios, line: '헬리오스 정밀', tier: 3, size: 'L', base: 'p17_bc_falchion', power: 120, mass: 150, grade: 'rare',
    desc: '칼날 선체 양옆에 후퇴익 지주로 긴 엔진 포드를 매단 고속 순양전함. 포드 위에도 포좌가 있다. 순양함을 따라잡아 잡는 사냥꾼이지만 장갑은 순양함 수준이다.',
    stats: { hpMul: 0.92, armorMul: 0.86, speedMul: 1.18 }, cruise: 112, k: 1.2, credits: 34000, extra: { engine: 6, precision: 8 }, tech: ['railguns', 'vector_thrust'], fac: ['engine_plant'], upkeep: 4600, supplies: { chemicals: 2.5, electronics: 0.3 },
    sale: { stations: ['helios'], rep: 60, stock: 1, restock: 36000 },
    int: 'engineS engineS reactorM fcsS specialM', hps: HP.p17_bc_falchion, cpu: 'cpu_swarm', fit: { main1: 'eq_rail_cannon', main2: 'eq_medium_gun', pod1: 'eq_medium_gun', pod2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun' }, pname: '고속 추격', pdesc: '레일 캐논 1, 부포 3, 방공포 3.',
    bp: [lic(['helios'], 300000, 60, 8), exp(3, 0.015)] },
  { id: 'p17_bc_corsair', cls: 'battlecruiser', name: '사략선급', maker: M.rust, line: '러스트포트 습격선', tier: 2, size: 'L', base: 'p17_bc_corsair', power: 70, mass: 200, grade: 'faction',
    desc: '노획 선체에 판재 장갑을 고르지 않게 덧대고, 좌현에 외팔 포갑판을 매단 개조 순양전함. 함교는 우현으로 치우쳐 있다. 싸고 화력은 쓸 만하지만 균형이 나빠 선회가 둔하다.',
    stats: { hpMul: 1.0, armorMul: 0.9, speedMul: 0.92 }, cruise: 92, k: 0.85, credits: 16000, extra: { machinery: 12 }, upkeep: 3000, supplies: { chemicals: 2.4 }, wear: 0.08,
    int: 'specialM specialM armorM', hps: HP.p17_bc_corsair, cpu: 'cpu_swarm', fit: { main1: 'eq_heavy_cannon', deck1: 'eq_medium_gun', deck2: 'eq_medium_gun', vls1: 'eq_missile_ghost', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun' }, pname: '해적 기함', pdesc: '주포 1, 외팔 부포 2, 유령 군집 미사일 1, 방공포 3.',
    bp: [fac('pirates', ['rustport'], 140000, 40, 5), salv(6, 0.05)] },
  { id: 'p17_bc_monitor', cls: 'battlecruiser', name: '감시포함급', maker: M.bastion, line: '바스티온 중장갑', tier: 3, size: 'L', base: 'p17_bc_monitor', power: 96, mass: 220, grade: 'rare',
    desc: '거대한 함축 주포 하나를 감싸 지은 낮고 평평한 모니터함. 상부구조가 거의 없어 피격 면적이 작다. 함축포 일격은 전함급이지만 선체를 돌려야 쏠 수 있고 느리다.',
    stats: { hpMul: 1.04, armorMul: 1.2, speedMul: 0.8 }, cruise: 80, k: 1.1, credits: 31000, extra: { precision: 10, armor_plate: 20 }, tech: ['heavy_ordnance', 'railguns'], fac: ['armor_plant', 'weapons_factory'], upkeep: 4000, supplies: { alloy: 0.3, chemicals: 1.6 },
    sale: { stations: ['bastion'], rep: 60, stock: 1, restock: 36000 },
    int: 'armorM fcsS reactorM specialM', hps: HP.p17_bc_monitor, cpu: 'cpu_artillery', fit: { spin1: 'eq_rail_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', sec3: 'eq_medium_gun', sec4: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '함축 포격', pdesc: '함축 레일 1, 부포 4, 방공포 2.',
    bp: [lic(['bastion'], 280000, 60, 8), salv(8, 0.03)] },
  // ─────────────────────────────────────────────────────────── battleships
  { id: 'p17_bb_solaris', cls: 'battleship', name: '솔라리스급', maker: M.ceres, line: '세레스 에너지', tier: 4, size: 'L', base: 'p17_bb_solaris', power: 220, mass: 240, grade: 'rare',
    desc: '앞뒤로 늘어선 두 반응로 고리와 결정 척추를 가진 세레스 기함. 대형 광학 포좌 넷과 중형 둘을 동시에 가동할 전력을 낸다. 막대한 결정과 정밀 부품이 든다.',
    stats: { hpMul: 0.96, armorMul: 0.94, speedMul: 1.02 }, cruise: 86, k: 1.2, credits: 52000, extra: { crystal: 40, precision: 20 }, tech: ['xray_lasers', 'fusion_reactors'], fac: ['electronics_fab'], upkeep: 7400, supplies: { electronics: 0.8 },
    int: 'reactorM reactorM reactorM fcsS sensorS specialM', hps: HP.p17_bb_solaris, cpu: 'cpu_artillery', fit: { main1: 'eq_laser_xray', main2: 'eq_laser_xray', main3: 'eq_laser_xray', main4: 'eq_beam_l', sec1: 'eq_beam_cutter', sec2: 'eq_beam_cutter', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '광학 기함', pdesc: 'X선 레이저 3, 대형 지속 빔 1, 지속 절단 빔 2, 방공포 4.',
    bp: [fac('ceres', ['p9_ceres_works'], 520000, 60, 12), exp(3, 0.01)] },
  { id: 'p17_bb_hulk', cls: 'battleship', name: '폐선급', maker: M.pirate, line: '해적 개조', tier: 2, size: 'L', base: 'p17_bb_hulk', power: 96, mass: 300, grade: 'faction',
    desc: '비계와 쌓인 컨테이너, 서로 맞지 않는 포갑판으로 기운 해적 전함. 버려진 선체를 주워 고쳤다. 전함치고 싸고 주포가 넷이나 되지만, 장갑에 구멍이 많고 쉽게 고장 난다.',
    stats: { hpMul: 0.92, armorMul: 0.8, speedMul: 0.86 }, cruise: 74, k: 0.8, credits: 19000, extra: { machinery: 20 }, upkeep: 5200, supplies: { chemicals: 3.5, alloy: 0.3 }, wear: 0.1,
    int: 'specialM specialM specialM armorM', hps: HP.p17_bb_hulk, cpu: 'cpu_generic', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', main4: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun' }, pname: '누더기 전열', pdesc: '주포 4, 부포 2, 방공포 3.',
    bp: [fac('pirates', ['rustport'], 200000, 55, 8), salv(8, 0.04)] },
  { id: 'p17_bb_bastion', cls: 'battleship', name: '성채급', maker: M.bastion, line: '바스티온 중장갑', tier: 4, size: 'L', base: 'p17_bb_bastion', power: 150, mass: 380, grade: 'faction',
    desc: '세 단의 장갑 계단, 다섯 개의 주포 바벳, 장갑 성채를 가진 지구라트형 전함. 정면·측면 모두 두껍고 주포가 다섯이다. 매우 무겁고 비싸며 건조에 오래 걸린다.',
    stats: { hpMul: 1.14, armorMul: 1.24, speedMul: 0.84 }, cruise: 72, k: 1.25, credits: 46000, extra: { armor_plate: 60, composite: 20 }, tech: ['heavy_ordnance', 'reactive_armor'], fac: ['armor_plant'], upkeep: 7000, supplies: { alloy: 0.6, chemicals: 3 },
    sale: { stations: ['bastion'], rep: 90, stock: 1, restock: 64800 },
    int: 'armorM armorM armorM reactorM fcsS specialM', hps: HP.p17_bb_bastion, cpu: 'cpu_line', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', main4: 'eq_heavy_cannon', main5: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', sec3: 'eq_medium_gun', sec4: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '성채 전열', pdesc: '주포 5, 부포 4, 방공포 4.',
    bp: [fac('iron', ['p10_bulwark_yard'], 460000, 55, 12), contract(5, 0.05)] },
  { id: 'p17_bb_vanguard', cls: 'battleship', name: '선봉급', maker: M.union, line: '연합 표준', tier: 3, size: 'L', base: 'p17_bb_vanguard', power: 130, mass: 280, grade: 'faction',
    desc: '두 장갑 선체를 함교 갑판과 열린 용골 트러스로 이은 분리 선체 전함. 한쪽 선체가 부서져도 싸울 수 있게 만들었다. 주포 넷, 부포 넷, VLS 둘로 균형 잡힌 연합 주력함.',
    stats: { hpMul: 1.06, armorMul: 1.02, speedMul: 0.96 }, cruise: 82, k: 1.1, credits: 36000, extra: { structure: 40 }, tech: ['heavy_ordnance', 'guided_missiles'], upkeep: 6000, supplies: { chemicals: 3.2 },
    sale: { stations: ['helios', 'bastion'], rep: 70, stock: 1, restock: 57600 },
    int: 'reactorM fcsS sensorS specialM specialM specialM', hps: HP.p17_bb_vanguard, cpu: 'cpu_line', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', main4: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', sec3: 'eq_medium_gun', sec4: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun' }, pname: '연합 주력', pdesc: '주포 4, 부포 4, VLS 2, 방공포 2.',
    bp: [fac('union', ['helios', 'bastion'], 400000, 45, 10), salv(8, 0.03)] },
  // ─────────────────────────────────────────────────────────── dreadnoughts
  { id: 'p17_dn_citadel', cls: 'dreadnought', name: '아성급', maker: M.iron, line: '철갑 사령부', tier: 4, size: 'XL', base: 'p17_dn_citadel', power: 230, mass: 640, grade: 'unique',
    desc: '네 단의 계단 장갑과 아홉 개의 바벳, 성채 함교를 가진 움직이는 요새. 철갑 사령부가 직접 건조하며 외부에 거의 팔지 않는다. 느리고 유지비가 막대하다.',
    stats: { hpMul: 1.1, armorMul: 1.2, speedMul: 0.86 }, cruise: 60, k: 1.05, credits: 110000, extra: { armor_plate: 80 }, tech: ['heavy_ordnance', 'reactive_armor'], fac: ['armor_plant'], upkeep: 15000, supplies: { alloy: 1.2, chemicals: 6 },
    int: 'armorM armorM armorM reactorM reactorM fcsS sensorS specialM', hps: HP.p17_dn_citadel, cpu: 'cpu_line', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', main4: 'eq_heavy_cannon', main5: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', sec3: 'eq_medium_gun', sec4: 'eq_medium_gun', vls1: 'eq_missile_rack', vls2: 'eq_missile_rack', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun', pd5: 'eq_pd_gun', pd6: 'eq_pd_gun' }, pname: '요새 전열', pdesc: '주포 5, 부포 4, VLS 2, 방공포 6.',
    bp: [{ kind: 'unique', limit: 2, minTier: 5 }, fac('iron', ['p10_bulwark_yard'], 1600000, 85, 30)] },
  { id: 'p17_dn_leviathan', cls: 'dreadnought', name: '레비아탄-II급', maker: M.helios, line: '헬리오스 정밀', tier: 4, size: 'XL', base: 'p17_dn_leviathan', power: 320, mass: 420, grade: 'unique',
    desc: '함축 입자 창을 감싼 긴 칼날 선체에 단일 추진 고리와 후퇴 핀을 단 헬리오스 초대형함. 입자 창과 대형 광학 포좌의 사거리로 적을 접근 전에 녹인다. 근접 방어가 얇다.',
    stats: { hpMul: 0.94, armorMul: 0.94, speedMul: 1.06 }, cruise: 70, k: 1.15, credits: 140000, extra: { crystal: 60, precision: 40, rare_metal: 20 }, tech: ['particle_lance', 'xray_lasers'], fac: ['electronics_fab'], upkeep: 17000, supplies: { electronics: 1.6 },
    int: 'reactorM reactorM reactorM reactorM fcsS fcsS sensorS specialM', hps: HP.p17_dn_leviathan, cpu: 'cpu_artillery', fit: { spin1: 'eq_charge_lance', main1: 'eq_laser_xray', main2: 'eq_laser_xray', main3: 'eq_laser_xray', sec1: 'eq_laser_blue', sec2: 'eq_laser_blue', sec3: 'eq_laser_blue', sec4: 'eq_laser_blue', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '창 기함', pdesc: '함축 축전 랜스 1, X선 레이저 3, 청색 레이저 4, 방공포 4.',
    bp: [{ kind: 'unique', limit: 2, minTier: 5 }, exp(3, 0.006)] },
  { id: 'p17_dn_sovereign', cls: 'dreadnought', name: '군주급', maker: M.old, line: '구 제국 잔존 설계', tier: 3, size: 'XL', base: 'p17_dn_sovereign', power: 170, mass: 700, grade: 'rare',
    desc: '늑골 두른 긴 원통 선체에 열린 포실 여섯과 높은 탑식 돛대를 세운 구 제국 초대형함. 주포 여섯, 부포 여섯으로 숫자는 압도적이지만 사격 통제가 낡고 매우 느리다. 잔해에서 설계도를 찾는 경우가 많다.',
    stats: { hpMul: 1.06, armorMul: 0.96, speedMul: 0.72 }, cruise: 52, k: 0.9, credits: 70000, upkeep: 13000, supplies: { chemicals: 7, alloy: 0.8 }, wear: 0.09,
    int: 'armorM armorM specialM specialM reactorM', hps: HP.p17_dn_sovereign, cpu: 'cpu_generic', fit: { main1: 'eq_heavy_cannon', main2: 'eq_heavy_cannon', main3: 'eq_heavy_cannon', main4: 'eq_heavy_cannon', main5: 'eq_heavy_cannon', main6: 'eq_heavy_cannon', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', sec3: 'eq_medium_gun', sec4: 'eq_medium_gun', sec5: 'eq_medium_gun', sec6: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '구식 대전열', pdesc: '주포 6, 부포 6, 방공포 4.',
    bp: [salv(10, 0.03), exp(3, 0.02)] },
  // ─────────────────────────────────────────────────────────── carriers (PREVIEW: the carrier release flag stays as it is)
  { id: 'p17_cv_hive', cls: 'carrier', name: '벌집급', maker: M.guild, line: '길드 호송', tier: 3, size: 'L', base: 'p17_cv_hive', power: 48, mass: 150, grade: 'rare', preview: true,
    desc: '중앙 척추 둘레에 벌집형 격납 블록을 붙인 경항모. 비행 갑판 없이 블록마다 발진구가 열려 있다. 격납(H) 넷, 방공포 다섯. 장갑이 얇다.',
    stats: { hpMul: 0.9, armorMul: 0.84, speedMul: 1.0 }, cruise: 92, k: 0.95, credits: 13000, upkeep: 2400, supplies: { chemicals: 1.8, electronics: 0.3 },
    int: 'flightM flightM sensorS specialM', hps: HP.p17_cv_hive, cpu: 'cpu_carrier', fit: { h1: 'eq_wing_fighter', h2: 'eq_wing_fighter', h3: 'eq_wing_interceptor', h4: 'eq_wing_torpedo', sec1: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun', pd5: 'eq_pd_gun' }, pname: '호송 항공단', pdesc: '전투기 2, 요격기 1, 뇌격기 1, 부포 1, 방공포 5.',
    bp: [lic(['exchange'], 160000, 40, 5)] },
  { id: 'p17_cv_ark', cls: 'carrier', name: '방주급', maker: M.union, line: '연합 표준', tier: 4, size: 'L', base: 'p17_cv_ark', power: 64, mass: 210, grade: 'rare', preview: true,
    desc: '깊은 격납 선체 위에 경사 비행 갑판을 깔고 쌍 함교를 세운 연합 정규 항모. 격납(H) 다섯, 항공 베이 넷. 크고 비싸며 호위 없이는 취약하다.',
    stats: { hpMul: 1.04, armorMul: 0.96, speedMul: 0.94 }, cruise: 84, k: 1.25, credits: 22000, extra: { machinery: 10 }, upkeep: 3600, supplies: { chemicals: 2.5, electronics: 0.4 },
    int: 'flightM flightM flightM flightM sensorS fcsS', hps: HP.p17_cv_ark, cpu: 'cpu_carrier', fit: { h1: 'eq_wing_fighter', h2: 'eq_wing_fighter', h3: 'eq_wing_torpedo', h4: 'eq_wing_torpedo', h5: 'eq_wing_interceptor', sec1: 'eq_medium_gun', sec2: 'eq_medium_gun', pd1: 'eq_pd_gun', pd2: 'eq_pd_gun', pd3: 'eq_pd_gun', pd4: 'eq_pd_gun' }, pname: '정규 항공단', pdesc: '전투기 2, 뇌격기 2, 요격기 1, 부포 2, 방공포 4.',
    bp: [lic(['helios'], 240000, 60, 8)] },
];

export const P17_HULLS: HullDef[] = ROWS.map(hull);
export const P17_VARIANTS: VariantDef[] = ROWS.map(r => ({ id: `${r.id}_std`, hull: r.id, name: '표준형', desc: `${r.name} 기본 구조.`, blueprint: 'common' }));
export const P17_PRESETS: PresetDef[] = ROWS.map(r => ({ id: `${r.id}_p`, hull: r.id, variant: `${r.id}_std`, name: r.pname, desc: r.pdesc, weapons: r.fit }));
const CLS_NAME: Record<string, string> = { corvette: '초계함', frigate: '호위함', destroyer: '구축함', light_cruiser: '경순양함', cruiser: '순양함', battlecruiser: '순양전함', battleship: '전함', dreadnought: '초대형 전함', carrier: '항모' };
export const P17_BLUEPRINTS: BlueprintDef[] = ROWS.map(r => {
  const h = P17_HULLS.find(x => x.id === r.id)!;
  // a preview hull's blueprint may only be sold at stations (no RNG draws) — the validator keeps it so
  const sources = r.preview ? r.bp.filter(s => 'stations' in s) : r.bp;
  return { id: `bp_${r.id}`, name: `${r.name} ${CLS_NAME[r.cls]} 설계도`, desc: `${r.name} 선체(${r.maker})를 자체 조선소에서 건조할 권리. 연구·시설 조건은 별도.`, grade: r.grade, target: { kind: 'hull', id: r.id }, sources, ...(h.build?.tech?.length ? { requires: h.build.tech } : {}) };
});
