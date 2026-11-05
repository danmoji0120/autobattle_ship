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
  const a = (slot - 1) / 6 * Math.PI * 2;
  return { x: s.pos.x + Math.cos(a) * 150, y: s.pos.y + (slot % 2 ? 20 : -20), z: s.pos.z + Math.sin(a) * 150 };
}
