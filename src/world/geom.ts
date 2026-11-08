// Deterministic world-space layout helpers shared by the simulation and the renderer,
// so a miner parks exactly at the rock the client draws and ships dock at visible berths.
import type { Field, Station, V } from './types';

export const dist = (a: V, b: V) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2 = (a: V, b: V) => Math.hypot(a.x - b.x, a.z - b.z);

function h(n: number, salt: number) { const x = Math.sin(n * 127.1 + salt * 311.7) * 43758.5453; return x - Math.floor(x); }
export function hashId(id: string): number { let s = 0; for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0; return s; }

export function rockPos(f: Field, i: number): V & { size: number } {
  const seed = hashId(f.id);
  const a = h(i, seed) * Math.PI * 2;
  const r = Math.sqrt(h(i, seed + 1)) * f.radius;
  const size = (f.salvage ? 4 : 10) + Math.pow(h(i, seed + 3), 3) * (f.salvage ? 14 : (f.res === 'crystal' ? 30 : 46));
  return { x: f.pos.x + Math.cos(a) * r, y: f.pos.y + (h(i, seed + 2) - 0.5) * f.radius * 0.25, z: f.pos.z + Math.sin(a) * r, size };
}

/** where a mining ship hovers next to its rock */
export function miningSpot(f: Field, i: number): V {
  const r = rockPos(f, i);
  const dx = f.pos.x - r.x, dz = f.pos.z - r.z;
  const l = Math.hypot(dx, dz) || 1;
  const off = r.size + 28;
  return { x: r.x + dx / l * off, y: r.y + 12, z: r.z + dz / l * off };
}

export const BERTHS = 14;
export function berthPos(s: Station, i: number): V {
  const a = (i % BERTHS) / BERTHS * Math.PI * 2 + (s.style * 0.3);
  const r = s.radius + 70 + (i >= BERTHS ? 90 : 0);
  return { x: s.pos.x + Math.cos(a) * r, y: s.pos.y + (i % 2 ? 22 : -22), z: s.pos.z + Math.sin(a) * r };
}

export function modulePos(s: Station, slot: number): V {
  if (slot === 0) return { ...s.pos };
  // rings around the hub: 6, then 10, then 14 per ring
  let i = slot - 1, ring = 0, n = 6;
  while (i >= n) { i -= n; ring++; n += 4; }
  const a = i / n * Math.PI * 2 + ring * 0.37;
  const r = 150 + ring * 115;
  return { x: s.pos.x + Math.cos(a) * r, y: s.pos.y + (slot % 2 ? 20 : -20) + (ring % 2 ? 30 : 0), z: s.pos.z + Math.sin(a) * r };
}

// ---------------------------------------------------------------- star systems
// Every system lives in one global coordinate space, each around its own origin far from the
// others, so proximity logic never crosses systems and positions stay plain vectors.
export const SYS_SPACING = 250000;
export const sysIndexAt = (p: V) => Math.round(p.x / SYS_SPACING) + 2;
export const sysOriginX = (idx: number) => (idx - 2) * SYS_SPACING;

import type { StarSystem } from './types';
// Worlds own their system records. The cache is weak and validates entries so edits, removals and
// reloads remain visible; it avoids scanning all systems for every ship on every tick.
const systemIndex = new WeakMap<Record<string, StarSystem>, Map<number, StarSystem>>();
export function sysAt(systems: Record<string, StarSystem>, p: V): StarSystem | undefined {
  const i = sysIndexAt(p);
  let index = systemIndex.get(systems);
  if (!index) { index = new Map(); systemIndex.set(systems, index); }
  const cached = index.get(i);
  if (cached && cached.idx === i && systems[cached.id] === cached) return cached;
  for (const s of Object.values(systems)) if (s.idx === i) { index.set(i, s); return s; }
  index.delete(i);
  return undefined;
}
export const local = (s: StarSystem, p: V): V => ({ x: p.x - s.origin.x, y: p.y - s.origin.y, z: p.z - s.origin.z });

/** gate-graph route: the next gate to take from system a toward b (BFS over links) */
export function nextGate(systems: Record<string, StarSystem>, from: string, to: string, usable?: (gate: import('./types').Gate) => boolean): import('./types').Gate | null {
  if (from === to) return null;
  const prev = new Map<string, { sys: string; gate: import('./types').Gate }>();
  const q = [from]; const seen = new Set([from]);
  while (q.length) {
    const cur = q.shift()!;
    if (cur === to) break;
    for (const g of systems[cur]?.gates ?? []) if ((!usable || usable(g)) && !seen.has(g.to)) { seen.add(g.to); prev.set(g.to, { sys: cur, gate: g }); q.push(g.to); }
  }
  if (!prev.has(to)) return null;
  let node = to; let step = prev.get(node)!;
  while (step.sys !== from) { node = step.sys; step = prev.get(node)!; }
  return step.gate;
}

/** number of gate jumps between two systems */
export function jumps(systems: Record<string, StarSystem>, from: string, to: string): number {
  if (from === to) return 0;
  const d = new Map([[from, 0]]); const q = [from];
  while (q.length) { const c = q.shift()!; for (const g of systems[c]?.gates ?? []) if (!d.has(g.to)) { d.set(g.to, d.get(c)! + 1); q.push(g.to); } }
  return d.get(to) ?? 99;
}
