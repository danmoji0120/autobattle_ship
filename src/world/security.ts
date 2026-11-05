// Security model shared by the simulation (pirate/Union decisions) and the client (map overlay),
// so what players see on the security map is exactly what the AI acts on.
import type { StarSystem, Station, Lair, V } from './types';
import { sysAt } from './geom';
import { influenceSec } from './factions';

interface SecWorld { systems: Record<string, StarSystem>; stations: Record<string, Station>; lairs: Record<string, Lair> }

/** effective system security: base minus recent pirate activity, bounded so a capital never collapses */
export const effSec = (sys: StarSystem) => Math.max(0, Math.min(100, sys.security - Math.min(sys.heat * 0.3, 4 + (100 - sys.security) * 0.35) + influenceSec(sys)));

const hasDefense = (s: Station) => s.modules.some(m => m.kind === 'defense' && m.built);

/** local security at a point: government reach, station defences, pirate lairs and remoteness */
export function secAt(w: SecWorld, p: V, sys = sysAt(w.systems, p)): number {
  if (!sys) return 0;
  let v = effSec(sys);
  const r = Math.hypot(p.x - sys.origin.x, p.z - sys.origin.z) / sys.radius;
  v -= Math.max(0, Math.min(1, (r - 0.5) / 0.5)) * (sys.security >= 70 ? 20 : 12);
  for (const st of Object.values(w.stations)) {
    if (Math.abs(st.pos.x - p.x) > 12000) continue;
    const d = Math.hypot(st.pos.x - p.x, st.pos.z - p.z);
    if (st.public && st.garrison) v += st.garrison * 5 * Math.max(0, 1 - d / 9000);
    else if (!st.public && hasDefense(st)) v += 10 * Math.max(0, 1 - d / 5000);
  }
  for (const l of Object.values(w.lairs)) if (l.alive && Math.abs(l.pos.x - p.x) < 20000) v -= 35 * Math.max(0, 1 - Math.hypot(l.pos.x - p.x, l.pos.z - p.z) / 14000);
  return Math.max(0, Math.min(100, v));
}

/** The same field as secAt, flattened into point sources relative to the system origin. The
 *  client's security-map shader evaluates exactly this per pixel (see SystemScene), so the map, the
 *  cursor readout and the server AI all agree. */
export interface SecField { eff: number; rim: number; radius: number; src: [number, number, number, number][] }
export function secField(w: SecWorld, sys: StarSystem): SecField {
  const src: SecField['src'] = [];
  const near = (p: V) => Math.abs(p.x - sys.origin.x) < sys.radius + 20000;
  for (const st of Object.values(w.stations)) {
    if (!near(st.pos)) continue;
    if (st.public && st.garrison) src.push([st.pos.x - sys.origin.x, st.pos.z - sys.origin.z, st.garrison * 5, 9000]);
    else if (!st.public && hasDefense(st)) src.push([st.pos.x - sys.origin.x, st.pos.z - sys.origin.z, 10, 5000]);
  }
  for (const l of Object.values(w.lairs)) if (l.alive && near(l.pos)) src.push([l.pos.x - sys.origin.x, l.pos.z - sys.origin.z, -35, 14000]);
  return { eff: effSec(sys), rim: sys.security >= 70 ? 20 : 12, radius: sys.radius, src };
}
/** evaluate a SecField at (dx, dz) from the system origin — the shader's formula, in JS */
export function secFieldAt(f: SecField, dx: number, dz: number): number {
  const r = Math.hypot(dx, dz) / f.radius;
  let v = f.eff - Math.max(0, Math.min(1, (r - 0.5) / 0.5)) * f.rim;
  for (const [x, z, a, R] of f.src) v += a * Math.max(0, 1 - Math.hypot(x - dx, z - dz) / R);
  return Math.max(0, Math.min(100, v));
}
