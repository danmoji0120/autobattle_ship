// P17.3 fleet expansion: every new hull has its own silhouette, its turrets sit on the hull (no floating,
// no burying), engine plumes leave the stern unobstructed, and the content is complete. docs/P17_3_ARSENAL.md
import { describe, expect, it } from 'vitest';
import { CONTENT } from '../src/content/registry';
import { SHIP_CLASSES } from '../src/sim/data/ships';
import { P17_MESH_BASES } from '../src/content/meshBases';
import { hullParts, buildShip } from '../src/render/shipMesh';
import { probeHull } from './helpers/hullProbe';
import { fittingMounts } from '../src/world/fitting';

// minimal canvas so the mesh builder's procedural textures run in node (as tests/fitting.test.ts)
const ctx = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
(globalThis as any).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };

const P17 = Object.values(CONTENT.hulls).filter(h => h.id.startsWith('p17_'));

describe('P17.3 hulls', () => {
  it('36 new base hulls across every combat class, each on its own silhouette', () => {
    expect(P17.length).toBe(36);
    const by: Record<string, number> = {};
    for (const h of P17) by[h.classId] = (by[h.classId] ?? 0) + 1;
    for (const c of ['corvette', 'frigate', 'destroyer', 'light_cruiser', 'cruiser', 'battlecruiser', 'battleship', 'dreadnought', 'carrier']) expect(by[c] ?? 0, c).toBeGreaterThanOrEqual(2);
    expect(new Set(P17.map(h => h.mesh.base)).size).toBe(36);
    expect([...P17_MESH_BASES].sort()).toEqual(P17.map(h => h.mesh.base).sort());
    // geometry really differs: vertex count + bounding box signature unique per base
    const sig = new Set<string>();
    for (const h of P17) {
      const pr = probeHull(h.mesh.base, SHIP_CLASSES[h.classId].length)!;
      expect(pr, h.id).toBeTruthy();
      const s = pr.box.getSize(new (pr.box.min.constructor as any)());
      sig.add(`${pr.verts}:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${s.z.toFixed(1)}`);
      expect(h.mesh.scale).toBe(1);
    }
    expect(sig.size).toBe(36);
  });

  it('every hardpoint sits on the hull: the pedestal reaches the surface and nothing covers the turret', () => {
    const bad: string[] = [];
    for (const h of P17) {
      const pr = probeHull(h.mesh.base, SHIP_CLASSES[h.classId].length)!;
      for (const p of h.hardpoints) {
        const [x, y, z] = p.pos;
        const s = pr.surfaceBelow(x, y, z);
        if (s === null) { bad.push(`${h.id}/${p.id}: 아래에 선체 없음(부유)`); continue; }
        const gap = y - s;
        // pedestal spans y-3.5 .. y-0.5 (render/shipMesh.ts): it must touch the hull and not be sunk into it
        if (gap < 0.6 || gap > 3.3) bad.push(`${h.id}/${p.id}: 표면 간격 ${gap.toFixed(2)}`);
        if (!pr.clearAbove(x, y, z, 1.4)) bad.push(`${h.id}/${p.id}: 선체에 파묻힘`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('engine nozzles are at the stern with a clear path for the plume', () => {
    const bad: string[] = [];
    for (const h of P17) {
      const parts = hullParts(h.mesh.base, SHIP_CLASSES[h.classId].length)!;
      const pr = probeHull(h.mesh.base, SHIP_CLASSES[h.classId].length)!;
      expect(parts.engines.length, h.id).toBeGreaterThan(0);
      for (const e of parts.engines) if (!pr.clearBehind(e.x, e.y, e.z - e.r * 0.2, 40)) bad.push(`${h.id}: 엔진 (${e.x},${e.y},${e.z}) 뒤가 막힘`);
    }
    expect(bad).toEqual([]);
  });

  it('builds with friendly and hostile materials; each hull carries economy, blueprint and a recommended computer', () => {
    for (const h of P17) {
      const p = Object.values(CONTENT.presets).find(x => x.variant === `${h.id}_std`)!;
      const mounts = fittingMounts(`${h.id}_std`, { hp: p.weapons, bay: {} });
      expect(mounts.length, h.id).toBe(Object.keys(p.weapons).length);
      for (const team of [0, 1] as const) {
        const sm = buildShip(SHIP_CLASSES[h.classId], { id: 'x', name: 'x', desc: '', mounts, mesh: h.mesh }, team);
        expect(sm.turrets.length).toBe(mounts.length);
        expect(sm.engines.length).toBeGreaterThan(0);
      }
      expect(h.build && h.upkeep && h.ops?.cruise).toBeTruthy();
      expect(Object.values(CONTENT.blueprints).some(b => b.target.kind === 'hull' && b.target.id === h.id), h.id).toBe(true);
      expect(h.cpu && CONTENT.modules[h.cpu]?.cpu, h.id).toBeTruthy();
    }
    // carriers keep the existing preview flag; preview hulls are never stocked
    for (const h of P17.filter(x => x.classId === 'carrier')) { expect(h.preview).toBe(true); expect(h.sale).toBeUndefined(); }
    // not everything is on sale, and not nothing either
    const onSale = P17.filter(h => h.sale).length;
    expect(onSale).toBeGreaterThan(15);
    expect(onSale).toBeLessThan(P17.length);
  });
});
