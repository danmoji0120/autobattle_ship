// P16.1 performance harness (docs/P16_0_FIGHTERS_CARRIERS.md §11): ms per 30 Hz step of one battle under rules 3
// with the light-craft pool. Carriers come from the prototype fixtures (tests/helpers/p16Craft.ts).
//   npx vite-node scripts/p16/craft-perf.ts [ticks]   (results: docs/p16/craft-perf.txt)
import { World } from '../../src/sim/world';
import { lineFleet } from '../../src/sim/bbex/trials';
import { carrierSpec } from '../../tests/helpers/p16Craft';
import type { FleetSpec } from '../../src/sim/fleet';
import '../../src/content/registry';

const TICKS = Number(process.argv[2] ?? 2400);
const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
/** per side: `carriers` carriers of `per` craft each next to battleships and AA destroyers */
function side(name: string, team: 0 | 1, carriers: number, per: number, bb: number, dd: number): FleetSpec {
  const f = lineFleet(name, [['battleship', 'std', bb], ['destroyer', 'aa', dd]], 10, team);
  if (carriers) f.root.children.unshift({ name: '항모 전대', commanderId: f.root.children[0].commanderId, order: 'auto', retreatAt: 0, ships: Array.from({ length: carriers }, () => carrierSpec(per)), children: [] });
  return f;
}
const CASES = [
  { label: '함선 24 + 비행체 0 (규칙 3, 함재기 없음)', c: 0, per: 0, bb: 4, dd: 8 },
  { label: '함선 24 + 비행체 200', c: 2, per: 50, bb: 4, dd: 6 },
  { label: '함선 24 + 비행체 400', c: 2, per: 100, bb: 4, dd: 6 },
  { label: '함선 60 + 비행체 800', c: 4, per: 100, bb: 8, dd: 18 },
  // stress: no ship point defence at all, so nearly every craft stays airborne in a long dogfight
  { label: '함선 60 + 비행체 800 (스트레스: 함선 PD 없음)', c: 4, per: 100, bb: 8, dd: 18, noPd: true },
];
const mk = (k: (typeof CASES)[number]) => {
  const w = new World({ seed: 5, scenarioId: 'kestrel', fleets: [side('A', 0, k.c, k.per, k.bb, k.dd), side('B', 1, k.c, k.per, k.bb, k.dd)], rules: 3 });
  if ('noPd' in k && k.noPd) for (const s of w.ships) for (const m of s.mounts) if (m.weapon.kind === 'pd') m.disabled = 1e9;
  return w;
};
const only = process.argv[3];
for (const k of CASES) {
  if (only && !k.label.includes(only)) continue;
  const w = mk(k);
  const dts: number[] = [], busy: number[] = [];
  let mun = 0, fly = 0, craftMs = 0, downs = 0, craftHits = 0, ord = 0, launches = 0, sunk = 0;
  const cap = w.craft ? w.craft.n : 0;
  for (let i = 0; i < TICKS && !w.outcome; i++) {
    const t0 = performance.now(); w.step(); const dt = performance.now() - t0;
    dts.push(dt);
    for (const e of w.events) {
      if (e.t === 'craftDown') downs++; else if (e.t === 'craftLaunch') launches++; else if (e.t === 'dying') sunk++;
      else if (e.t === 'hit' && e.weapon.startsWith('p16t_')) craftHits++;
      else if (e.t === 'fire' && e.weapon === 'p16t_air_torp') ord++;
    }
    mun = Math.max(mun, w.munitions.length);
    const f = w.craft ? w.craft.flying() : 0; fly = Math.max(fly, f);
    if (cap && f >= cap * 0.5) busy.push(dt);
  }
  // the craft update alone (a second identical run, timing only CraftPool.update)
  if (w.craft) {
    const w2 = mk(k);
    const pool = w2.craft!; const orig = pool.update.bind(pool);
    pool.update = () => { const t0 = performance.now(); orig(); craftMs += performance.now() - t0; };
    for (let i = 0; i < dts.length; i++) w2.step();
    if (w2.digest() !== w.digest()) console.log('!! digest mismatch between identical runs');
  }
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  const bm = busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : 0;
  console.log(JSON.stringify({
    case: k.label, ships: w.ships.length, craftSlots: cap, peakFlying: fly, steps: dts.length, simTime: +w.time.toFixed(0), outcome: w.outcome?.reason ?? null,
    meanMs: +mean.toFixed(2), p95Ms: +q(dts, 0.95).toFixed(2), maxMs: +Math.max(...dts).toFixed(1),
    busySteps: busy.length, busyMeanMs: +bm.toFixed(2), busyP95Ms: busy.length ? +q(busy, 0.95).toFixed(2) : 0,
    craftUpdateMeanMs: +(craftMs / dts.length).toFixed(3), peakMunitions: mun, launches, craftDowns: downs, craftGunHits: craftHits, airTorps: ord, shipsSunk: sunk,
  }));
}
