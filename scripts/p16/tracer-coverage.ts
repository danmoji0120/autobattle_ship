// P16.4.1: how many real craft gun shots the cooldown-based tracer (render/craftView.ts) sees when the renderer
// samples every k sim ticks (k=2 ≈ 60 fps at 1×, k=8 ≈ 4× time scale), compared with the parallel branch's
// `craftShot` sim event (backup/p164-parallel-2ff8916: emitted on HITS only, 1 in 6 by tick parity).
//   npx vite-node scripts/p16/tracer-coverage.ts
import '../../src/content/registry';             // registers the content packs (carrier, wing weapons)
import { World } from '../../src/sim/world';
import type { FleetSpec, GroupSpec } from '../../src/sim/fleet';
import { CRAFT_ST } from '../../src/sim/craft';
import { WEAPONS } from '../../src/sim/data/weapons';

const g = (ships: GroupSpec['ships']): GroupSpec => ({ name: 't', commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] });
const f = (ships: GroupSpec['ships']): FleetSpec => ({ name: 't', root: g(ships) });
const mk = () => new World({ seed: 21, scenarioId: 'kestrel', rules: 3, spawnZ: 900, fleets: [
  f([{ classId: 'carrier', loadoutId: 'air_group' }, { classId: 'carrier', loadoutId: 'air_group' }, { classId: 'cruiser', loadoutId: 'multi' }]),
  f([{ classId: 'carrier', loadoutId: 'air_group' }, { classId: 'battleship', loadoutId: 'std' }, { classId: 'destroyer', loadoutId: 'std' }])] });

for (const k of [1, 2, 4, 8]) {
  const w = mk();
  const tc = new Float64Array(8192), ts = new Uint8Array(8192);       // every-tick truth
  const vc = new Float64Array(8192), vs = new Uint8Array(8192);       // renderer's sampled memory
  let real = 0, seen = 0, shipHits = 0, tick = 0;
  while (!w.outcome && w.time < 180) {
    w.step(); tick++;
    for (const e of w.events) if (e.t === 'hit' && WEAPONS[(e as any).weapon]?.kind === 'craft') shipHits++;
    const c = w.craft; if (!c) continue;
    for (let i = 0; i < c.st.length; i++) { if (ts[i] === CRAFT_ST.OUT && c.st[i] === CRAFT_ST.OUT && c.cool[i] > tc[i] + 1e-9) real++; tc[i] = c.cool[i]; ts[i] = c.st[i]; }
    if (tick % k) continue;
    for (let i = 0; i < c.st.length; i++) { if (vs[i] === CRAFT_ST.OUT && c.st[i] === CRAFT_ST.OUT && c.cool[i] > vc[i] + 1e-9) seen++; vc[i] = c.cool[i]; vs[i] = c.st[i]; }
  }
  console.log(JSON.stringify({ ticksPerFrame: k, simTime: +w.time.toFixed(1), realShots: real, cooldownTracers: seen, coverage: +(seen / Math.max(1, real)).toFixed(3), craftHitsOnShips: shipHits }));
}
