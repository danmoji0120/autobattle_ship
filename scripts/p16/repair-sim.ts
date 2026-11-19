// P16.7 short combat repair simulation (not a balance study): same fleets with one combat repair ship (구호급,
// support computer) vs one ordinary destroyer in its place. Reports repair work, the repair ship's position
// relative to its line and enemy fire on it. Usage: npx vite-node scripts/p16/repair-sim.ts
import { World, type BattleSetup } from '../../src/sim/world';
import { shipLoadout } from '../../src/world/fitting';
import { MENDER_STD_WEAPONS, REPAIR_HULL } from '../../src/content/packs/growth/support';
import type { GroupSpec, ShipSpec } from '../../src/sim/fleet';

const lo = shipLoadout({ classId: 'destroyer', loadoutId: 'aa', variant: `${REPAIR_HULL}_std`, fitting: { hp: { ...MENDER_STD_WEAPONS }, bay: {} } });
const S = (c: string, l: string, n: number, x: Partial<ShipSpec> = {}): ShipSpec[] => Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...x }));
const G = (ships: ShipSpec[]): GroupSpec => ({ name: 'g', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] });
const mender: ShipSpec = { classId: 'destroyer', loadoutId: 'aa', fit: { name: lo.name, mounts: lo.mounts }, cpu: { id: 'cpu_support', arch: 'support' } };
const rows: string[] = [];
for (const seed of [1, 2, 3]) for (const withRep of [false, true]) {
  const a = [...S('cruiser', 'multi', 3), ...S('destroyer', 'aa', 1), ...(withRep ? [mender] : S('destroyer', 'aa', 1))];
  const setup: BattleSetup = { seed, scenarioId: 'p167sim', rules: 3, fleets: [{ name: 'A', root: G(a) }, { name: 'B', root: G(S('cruiser', 'multi', 4)) }] };
  const w = new World(setup);
  let ev = 0, hull = 0, cut = 0, hitsOnRep = 0, behind = 0, samples = 0;
  const rep = () => w.ships.find(s => s.rep);
  while (!w.outcome && w.time < 240) {
    w.step();
    for (const e of w.events) {
      if (e.t === 'repair') { ev++; hull += e.hull; cut += e.cut; }
      if (e.t === 'hit' && e.target === rep()?.id) hitsOnRep++;
    }
    const r = rep();
    if (r && r.state === 'alive' && w.tick % 30 === 0) {
      const mine = w.ships.filter(s => s.team === 0 && s.state === 'alive' && s !== r), foe = w.ships.filter(s => s.team === 1 && s.state === 'alive');
      if (mine.length && foe.length) {
        const c = (l: typeof mine) => ({ x: l.reduce((n, s) => n + s.pos.x, 0) / l.length, z: l.reduce((n, s) => n + s.pos.z, 0) / l.length });
        const m = c(mine), f = c(foe), d = (p: { x: number; z: number }) => Math.hypot(p.x - f.x, p.z - f.z);
        samples++; if (d(r.pos) > d(m)) behind++;
      }
    }
  }
  const A = w.ships.filter(s => s.team === 0), B = w.ships.filter(s => s.team === 1);
  const alive = (l: typeof A) => l.filter(s => s.state === 'alive').length;
  const hp = (l: typeof A) => Math.round(l.reduce((n, s) => n + (s.state === 'alive' ? s.hp : 0), 0));
  rows.push(`seed ${seed} ${withRep ? '수리함' : '구축함'} | t=${Math.round(w.time)} 결과=${w.outcome?.winner ?? '-'} | A 생존 ${alive(A)}/${A.length} 잔여HP ${hp(A)} | B 생존 ${alive(B)}/${B.length} 잔여HP ${hp(B)}` +
    (withRep ? ` | 수리 ${ev}회 선체 ${Math.round(hull)} 손상시간 단축 ${Math.round(cut)}s | 수리함 피격 ${hitsOnRep} | 전열 뒤 ${samples ? Math.round(behind / samples * 100) : '-'}%` : ''));
}
console.log(rows.join('\n'));
