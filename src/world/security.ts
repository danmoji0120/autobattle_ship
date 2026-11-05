// Security model shared by the simulation (pirate/Union decisions) and the client (map overlay),
// so what players see on the security map is exactly what the AI acts on.
import type { StarSystem, Station, Lair, V } from './types';
import { sysAt } from './geom';

interface SecWorld { systems: Record<string, StarSystem>; stations: Record<string, Station>; lairs: Record<string, Lair> }

/** effective system security: base minus recent pirate activity, bounded so a capital never collapses */
export const effSec = (sys: StarSystem) => sys.security - Math.min(sys.heat * 0.3, 4 + (100 - sys.security) * 0.35);

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
