// A chart projection, not simulation coordinates. P9 saves retain their original map and gate
// positions; this presentation also applies to already-created P9 worlds without migrating them.
import type { StarSystem } from '../../world/types';
import { nextGate } from '../../world/geom';

export const CHART_WIDTH = 1600;
export const CHART_HEIGHT = 1000;
type ChartPoint = { x: number; y: number; label: 'left' | 'right' };

// The settled loop is compact. Two longer arms leave open space around the northern bottleneck
// and the southern route to Fang; the three vacant dead ends sit beyond their parent systems.
export const P9_CHART: Readonly<Record<string, ChartPoint>> = {
  helios: { x: 410, y: 395, label: 'left' }, astra: { x: 605, y: 420, label: 'right' },
  lyra: { x: 340, y: 250, label: 'left' }, ceres: { x: 525, y: 240, label: 'left' },
  anvil: { x: 765, y: 175, label: 'right' }, rime: { x: 990, y: 90, label: 'right' },
  drake: { x: 820, y: 350, label: 'right' }, junction: { x: 1025, y: 275, label: 'right' },
  shard: { x: 1195, y: 185, label: 'left' }, watch: { x: 1375, y: 110, label: 'left' },
  blackgate: { x: 1510, y: 250, label: 'left' }, harbor: { x: 315, y: 565, label: 'left' },
  forge: { x: 530, y: 615, label: 'right' }, sunder: { x: 745, y: 660, label: 'right' },
  ember: { x: 935, y: 570, label: 'right' }, fang: { x: 1180, y: 645, label: 'right' },
  frontier: { x: 1460, y: 775, label: 'left' }, quiet: { x: 140, y: 720, label: 'right' },
  salvage: { x: 405, y: 830, label: 'right' }, rift: { x: 655, y: 875, label: 'left' },
  relic: { x: 910, y: 880, label: 'right' }, dusk: { x: 1155, y: 845, label: 'right' },
};

export function chartPoint(s: StarSystem, layout?: string): ChartPoint {
  return layout === 'p9' && P9_CHART[s.id] ? P9_CHART[s.id] : { x: 110 + s.map.x * 1380, y: 95 + s.map.y * 810, label: s.map.x > .72 ? 'left' : 'right' };
}
export const edgeKey = (a: string, b: string) => [a, b].sort().join('\u0000');

/** Highlight only an actual BFS route. An unavailable destination never paints a partial route. */
export function chartRoute(systems: Record<string, StarSystem>, from?: string, to?: string): Set<string> {
  const result = new Set<string>();
  if (!from || !to || !systems[from] || !systems[to] || from === to) return result;
  let current = from;
  const visited = new Set<string>();
  while (current !== to && !visited.has(current)) {
    visited.add(current);
    const gate = nextGate(systems, current, to);
    if (!gate || !systems[gate.to]) return new Set();
    result.add(edgeKey(current, gate.to));
    current = gate.to;
  }
  return current === to ? result : new Set();
}

// Small, deterministic, non-interactive background stars. Three paths keep the decorative
// background cheap to morph when live map data changes.
let seed = 27391;
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const stars = ['', '', ''];
for (let i = 0; i < 340; i++) {
  const x = Math.round(18 + next() * 1564), y = Math.round(18 + next() * 964);
  const group = Math.floor(next() * stars.length);
  stars[group] += `M${x} ${y}h.01`;
}
export const CHART_STARS = stars.map((d, i) => `<path d="${d}" stroke-width="${[1, 1.7, 2.4][i]}" opacity="${[.22, .32, .42][i]}"/>`).join('');
