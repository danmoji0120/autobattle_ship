// P15.1.1: line vs picket vs basic — objective formation and gunnery measures. Same hulls, weapons, commander
// and seeds; only our computer changes. Sampled once per second from 20 s while 2+ of our ships are alive.
//   depth     spread (std, m) of our ships along the axis to the enemy centroid — 0 = one rank abreast
//   gapCV     irregularity of the lateral spacing (std/mean of neighbour gaps along the line)
//   masked    share of our ships whose line of fire to their target passes a friendly hull
//   coh       mean distance of our ships to their own centroid
//   range     mean distance to the ship's own target
//   bear      share of usable attack mounts whose arc covers the bearing to the ship's target
//   idle      share of usable attack mounts loaded but not firing (lower = more of the battery in use)
//   lag       mean distance between the slowest ship and the group centroid's line (stragglers)
//   npx vite-node scripts/p15/line.ts [seeds=4] [filter]
import { World, BATTLE_RULES } from '../../src/sim/world';
import { worldDirToLocal, angleBetween, Vec3 } from '../../src/sim/math';
import type { FleetSpec, ShipSpec, GroupSpec } from '../../src/sim/fleet';
import type { CpuArch } from '../../src/sim/ai/computer';
import type { Ship } from '../../src/sim/types';
import '../../src/content/registry';

const SEEDS = Number(process.argv[2] ?? 4), FILTER = process.argv[3] ?? '', T = 150;
const S = (c: string, l: string, n: number, cpu?: CpuArch): ShipSpec[] =>
  Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...(cpu && cpu !== 'basic' ? { cpu: { id: `cpu_${cpu}`, arch: cpu } } : {}) }));
const G = (ships: ShipSpec[], cmd: string): GroupSpec => ({ name: 'g', commanderId: cmd, order: 'engage', retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec): FleetSpec => ({ name: 'x', root: g });
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const std = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const f2 = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '-';
const r0 = (n: number) => Number.isFinite(n) ? String(Math.round(n)) : '-';

function segDist(p: Vec3, a: Vec3, b: Vec3) {
  const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / l2));
  return Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z);
}

function run(mine: ShipSpec[], theirs: ShipSpec[], seed: number) {
  const w = new World({ seed, scenarioId: 'p1511l', fleets: [F(G(mine, 'wolf')), F(G(theirs, 'vorn'))], rules: BATTLE_RULES });
  const m: Record<string, number[]> = {};
  const push = (k: string, v: number) => { if (Number.isFinite(v)) (m[k] ??= []).push(v); };
  const tmp = new Vec3(), loc = new Vec3();
  while (!w.outcome && w.time < T) {
    w.step();
    if (w.tick % 30 !== 0 || w.time < 20) continue;
    const us = w.ships.filter(s => s.team === 0 && s.state === 'alive'), them = w.ships.filter(s => s.team === 1 && s.state === 'alive');
    if (us.length < 2 || !them.length) continue;
    const C = w.centroid(us, new Vec3()), E = w.centroid(them, new Vec3());
    const ax = new Vec3(C.x - E.x, 0, C.z - E.z); if (ax.lengthSq() < 1) continue; ax.normalize();
    const rt = new Vec3(ax.z, 0, -ax.x);
    push('depth', std(us.map(s => (s.pos.x - C.x) * ax.x + (s.pos.z - C.z) * ax.z)));
    const lat = us.map(s => (s.pos.x - C.x) * rt.x + (s.pos.z - C.z) * rt.z).sort((a, b) => a - b);
    const gaps = lat.slice(1).map((x, i) => x - lat[i]);
    if (gaps.length > 1) push('gapCV', std(gaps) / Math.max(1, mean(gaps)));
    push('coh', mean(us.map(s => Math.hypot(s.pos.x - C.x, s.pos.z - C.z))));
    let masked = 0, n = 0, bear = 0, mounts = 0, idle = 0;
    const rng: number[] = [];
    for (const s of us) {
      const t = w.shipById.get(s.ai.targetId); if (!t || t.state !== 'alive') continue;
      n++; rng.push(t.pos.distTo(s.pos));
      if (us.some(o => o !== s && segDist(o.pos, s.pos, t.pos) < o.radius + 15 && o.pos.distTo(s.pos) < t.pos.distTo(s.pos))) masked++;
      for (const mt of s.mounts) {
        if (mt.weapon.kind === 'pd' || mt.weapon.special || mt.disabled > 0 || mt.ammo <= 0) continue;
        if (t.pos.distTo(s.pos) > mt.weapon.range) continue;
        mounts++;
        tmp.subVectors(t.pos, s.pos).normalize();
        const l = worldDirToLocal(tmp, s.yaw, s.pitch, loc);
        if (angleBetween(l, mt.facingLocal) <= mt.def.arc * Math.PI / 180) bear++;
        if (mt.cooldown <= 0 && mt.salvoLeft <= 0) idle++;
      }
    }
    if (n) { push('masked', masked / n); push('range', mean(rng)); }
    if (mounts) { push('bear', bear / mounts); push('idle', idle / mounts); }
    const slow = us.reduce((a: Ship, b) => b.maxSpeed < a.maxSpeed ? b : a);
    push('lag', Math.abs((slow.pos.x - C.x) * ax.x + (slow.pos.z - C.z) * ax.z));
  }
  const us = w.ships.filter(s => s.team === 0), them = w.ships.filter(s => s.team === 1);
  return {
    m, win: w.outcome?.winner === 0 ? 1 : 0,
    dealt: us.reduce((a, s) => a + s.stats.dmgDealt, 0), taken: us.reduce((a, s) => a + s.stats.dmgTaken, 0),
    lost: us.filter(s => s.state !== 'alive').length, kills: them.filter(s => s.state !== 'alive').length,
  };
}

function report(title: string, mine: (a: CpuArch) => ShipSpec[], theirs: () => ShipSpec[]) {
  if (FILTER && !title.startsWith(FILTER)) return;
  console.log(`\n== ${title} (rules ${BATTLE_RULES}, seeds ${SEEDS})`);
  console.log('computer | depth gapCV masked  coh  lag | range  bear  idle | win lost/kills dealt/taken');
  for (const a of ['basic', 'line', 'picket'] as CpuArch[]) {
    const rs = Array.from({ length: SEEDS }, (_, i) => run(mine(a), theirs(), 11 + i * 7));
    const k = (x: string) => mean(rs.map(r => mean(r.m[x] ?? [])).filter(Number.isFinite));
    console.log(`${a.padEnd(8)} | ${r0(k('depth')).padStart(5)} ${f2(k('gapCV'))} ${f2(k('masked')).padStart(6)} ${r0(k('coh')).padStart(4)} ${r0(k('lag')).padStart(4)} | ${r0(k('range')).padStart(5)} ${f2(k('bear'))} ${f2(k('idle'))} | ${f2(mean(rs.map(r => r.win)))} ${f2(mean(rs.map(r => r.lost)))}/${f2(mean(rs.map(r => r.kills)))} ${r0(mean(rs.map(r => r.dealt)))}/${r0(mean(rs.map(r => r.taken)))}`);
  }
}

report('L1 4CA vs 4CA', a => S('cruiser', 'multi', 4, a), () => S('cruiser', 'multi', 4));
report('L2 2BB+2CA (mixed speed) vs 2BB+2CA', a => [...S('battleship', 'std', 2, a), ...S('cruiser', 'multi', 2, a)], () => [...S('battleship', 'std', 2), ...S('cruiser', 'multi', 2)]);
report('L3 5DDstrike vs 5DDstrike', a => S('destroyer', 'strike', 5, a), () => S('destroyer', 'strike', 5));
report('L4 3BB vs 3BB', a => S('battleship', 'std', 3, a), () => S('battleship', 'std', 3));
