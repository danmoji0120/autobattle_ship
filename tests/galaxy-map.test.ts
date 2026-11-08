import { describe, expect, it } from 'vitest';
import { CHART_HEIGHT, CHART_WIDTH, P9_CHART, chartPoint, chartRoute, edgeKey } from '../src/client/strategic/galaxyMap';
import { jumps } from '../src/world/geom';
import { WorldSim } from '../src/world/sim';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('galaxy chart projection', () => {
  it('gives each P9 system a stable distinct point without changing saved maps or gates', () => {
    const sim = WorldSim.create(731), world = sim.st, before = JSON.stringify(world.systems);
    const systems = Object.values(world.systems);
    expect(Object.keys(P9_CHART)).toHaveLength(22);
    expect(new Set(systems.map(s => { const p = chartPoint(s, world.worldLayout); return `${p.x},${p.y}`; })).size).toBe(22);
    for (const s of systems) {
      const p = chartPoint(s, world.worldLayout);
      expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(CHART_WIDTH);
      expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(CHART_HEIGHT);
    }
    expect(JSON.stringify(world.systems)).toBe(before);
    // A compact inhabited core and a more isolated frontier should read differently on the map.
    expect(distance(chartPoint(world.systems.helios, 'p9'), chartPoint(world.systems.astra, 'p9')))
      .toBeLessThan(distance(chartPoint(world.systems.harbor, 'p9'), chartPoint(world.systems.quiet, 'p9')));
    expect(distance(chartPoint(world.systems.fang, 'p9'), chartPoint(world.systems.frontier, 'p9')))
      .toBeGreaterThan(distance(chartPoint(world.systems.lyra, 'p9'), chartPoint(world.systems.ceres, 'p9')));
  });

  it('uses saved coordinates for legacy and unknown systems rather than forcing the P9 projection', () => {
    const s = structuredClone(WorldSim.create(732).st.systems.astra);
    const legacy = chartPoint(s); s.map = { x: .13, y: .87 };
    expect(chartPoint(s)).not.toEqual(legacy);
    const p9 = chartPoint(s, 'p9'); s.map = { x: .91, y: .03 };
    expect(chartPoint(s, 'p9')).toEqual(p9);
    s.id = 'future_system'; expect(chartPoint(s, 'p9')).toEqual(chartPoint(s));
  });

  it('highlights only a real shortest gate path and clears it when a choke is disconnected', () => {
    const systems = WorldSim.create(733).st.systems;
    const route = chartRoute(systems, 'astra', 'blackgate');
    expect(route.size).toBe(jumps(systems, 'astra', 'blackgate'));
    expect(route.has(edgeKey('junction', 'shard'))).toBe(true);
    const real = new Set(Object.values(systems).flatMap(s => s.gates.map(g => edgeKey(s.id, g.to))));
    expect([...route].every(k => real.has(k))).toBe(true);
    systems.junction.gates = systems.junction.gates.filter(g => g.to !== 'shard');
    systems.shard.gates = systems.shard.gates.filter(g => g.to !== 'junction');
    expect(chartRoute(systems, 'astra', 'blackgate').size).toBe(0);
    expect(chartRoute(systems, 'missing', 'blackgate').size).toBe(0);
  });

  it('keeps unrelated gate lines from crossing like an unmarked interchange', () => {
    const systems = WorldSim.create(734).st.systems, seen = new Set<string>(), edges: [string, string][] = [];
    for (const s of Object.values(systems)) for (const gate of s.gates) {
      const key = edgeKey(s.id, gate.to); if (!seen.has(key)) { seen.add(key); edges.push([s.id, gate.to]); }
    }
    const orient = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const crossings: string[] = [];
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i], [c, d] = edges[j]; if (new Set([a, b, c, d]).size < 4) continue;
      const p = chartPoint(systems[a], 'p9'), q = chartPoint(systems[b], 'p9'), r = chartPoint(systems[c], 'p9'), s = chartPoint(systems[d], 'p9');
      if (orient(p, q, r) * orient(p, q, s) < 0 && orient(r, s, p) * orient(r, s, q) < 0) crossings.push(`${a}-${b} / ${c}-${d}`);
    }
    expect(crossings).toEqual([]);
  });
});
