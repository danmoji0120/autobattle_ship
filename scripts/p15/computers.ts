// P15.1: combat-computer behaviour proof. The same hulls, weapons, commander and seeds; only the fitted
// computer changes. Prints range-over-time, trajectory, firing, cover and torpedo-run numbers per
// computer (docs/P15_1_COMBAT_COMPUTERS.md).
//   npx vite-node scripts/p15/computers.ts [seeds=4] [filter]
import { World, BATTLE_RULES } from '../../src/sim/world';
import { WEAPONS } from '../../src/sim/data/weapons';
import { getLoadout } from '../../src/sim/data/ships';
import type { FleetSpec, ShipSpec, GroupSpec } from '../../src/sim/fleet';
import type { CpuArch } from '../../src/sim/ai/computer';
import type { Ship } from '../../src/sim/types';
import '../../src/content/registry';

const SEEDS = Number(process.argv[2] ?? 4);
const FILTER = process.argv[3] ?? '';
const RULES = Number(process.env.P15_RULES ?? BATTLE_RULES);

const S = (c: string, l: string, n: number, cpu?: CpuArch, extra: Partial<ShipSpec> = {}): ShipSpec[] =>
  Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...(cpu ? { cpu: { id: `cpu_${cpu}`, arch: cpu } } : {}), ...extra }));
const G = (name: string, ships: ShipSpec[], cmd = 'wolf', order: GroupSpec['order'] = 'engage'): GroupSpec => ({ name, commanderId: cmd, order, retreatAt: 0, ships, children: [] });
const F = (...gs: GroupSpec[]): FleetSpec => gs.length === 1 ? { name: 'x', root: gs[0] } : { name: 'x', root: { name: 'root', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships: [], children: gs } };

const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const r0 = (n: number) => Number.isFinite(n) ? Math.round(n) : '-';
const r2 = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '-';

function nearestEnemy(w: World, s: Ship): number {
  let d = Infinity; for (const e of w.ships) if (e.state === 'alive' && w.hostile(s.team, e.team)) d = Math.min(d, e.pos.distTo(s.pos)); return d;
}

interface Probe { label: string; mine: (w: World) => Ship[]; extra?: (w: World, m: Record<string, number[]>) => void }

/** run one battle and sample the probe ships once per second */
function run(a: FleetSpec, b: FleetSpec, seed: number, probe: Probe, T = 180) {
  const w = new World({ seed, scenarioId: 'p151', fleets: [a, b], rules: RULES });
  const m: Record<string, number[]> = {};
  const push = (k: string, v: number) => { (m[k] ??= []).push(v); };
  const path: string[] = [];
  let lastPos = new Map<number, { x: number; z: number }>();
  const fired: Record<string, number> = {};
  const launches: { dist: number; aspect: number }[] = [];
  const seen = new Set<number>();
  let travel = 0;
  while (!w.outcome && w.time < T) {
    w.step();
    for (const e of w.events) if (e.t === 'fire') {
      const s = w.shipById.get(e.ship)!; if (s.team !== 0) continue;
      const k = WEAPONS[e.weapon]?.kind ?? 'shell'; fired[k] = (fired[k] ?? 0) + 1;
    }
    // torpedo launch geometry: distance and aspect on the target (0° bow, 90° beam, 180° stern)
    for (const mu of w.munitions) if (mu.kind === 'torpedo' && mu.team === 0 && !seen.has(mu.id)) {
      seen.add(mu.id);
      const sh = w.shipById.get(mu.ownerId), t = w.shipById.get(mu.targetId);
      if (sh && t) {
        const dx = sh.pos.x - t.pos.x, dz = sh.pos.z - t.pos.z, dl = Math.hypot(dx, dz) || 1;
        launches.push({ dist: Math.hypot(dx, dz), aspect: Math.acos(Math.max(-1, Math.min(1, (dx * t.fwd.x + dz * t.fwd.z) / dl))) * 180 / Math.PI });
      }
    }
    if (w.tick % 30 === 0) {
      const mine = probe.mine(w).filter(s => s.state === 'alive');
      for (const s of mine) {
        const p = lastPos.get(s.id); if (p) travel += Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
      }
      lastPos = new Map(mine.map(s => [s.id, { x: s.pos.x, z: s.pos.z }]));
      if (mine.length) {
        const ds = mine.map(s => nearestEnemy(w, s)).filter(Number.isFinite);
        push('near', mean(ds));
        const tgt = mine.map(s => { const t = w.shipById.get(s.ai.targetId); return t && t.state === 'alive' ? t.pos.distTo(s.pos) : NaN; }).filter(Number.isFinite);
        if (tgt.length) push('tgt', mean(tgt));
        push('acting', mine.filter(s => s.cpu && s.cpu.acting !== 'basic').length / mine.length);
        if (Math.round(w.time) % 15 === 0) path.push(`${Math.round(w.time)}s:(${Math.round(mine[0].pos.x)},${Math.round(mine[0].pos.z)}) d${Math.round(ds[0])}`);
      }
      probe.extra?.(w, m);
    }
  }
  const team0 = w.ships.filter(s => s.team === 0), team1 = w.ships.filter(s => s.team === 1);
  const cpu = probe.mine(w).map(s => s.cpu).filter(Boolean);
  return {
    m, path, fired, launches, travel,
    win: w.outcome?.winner === 0 ? 1 : 0, time: w.time,
    lost0: team0.filter(s => s.state !== 'alive').length, lost1: team1.filter(s => s.state !== 'alive').length,
    dmg0: team0.reduce((a, s) => a + s.stats.dmgDealt, 0), taken0: team0.reduce((a, s) => a + s.stats.dmgTaken, 0),
    breaks: cpu.reduce((a, c) => a + c!.breaks, 0), reentries: cpu.reduce((a, c) => a + c!.reentries, 0),
    digest: w.digest(),
  };
}

const at = (xs: number[] | undefined, sec: number) => xs && xs.length > sec ? xs[sec] : NaN;

function report(title: string, variants: [string, FleetSpec][], enemy: () => FleetSpec, probe: Probe, extraCols: (r: ReturnType<typeof run>[]) => string = () => '') {
  if (FILTER && !title.includes(FILTER)) return;
  console.log(`\n== ${title} (rules ${RULES}, seeds ${SEEDS})`);
  console.log('computer   | mean near | near@20 @40 @60 @90 @120 | tgt mean | travel | shots shell/msl/torp | win  lost(ours/theirs) dmgDealt/taken | acting' );
  for (const [name, fleet] of variants) {
    const rs = Array.from({ length: SEEDS }, (_, i) => run(JSON.parse(JSON.stringify(fleet)), enemy(), 11 + i * 7, probe));
    const near = rs.map(r => mean((r.m.near ?? []).slice(15)));
    const col = (sec: number) => r0(mean(rs.map(r => at(r.m.near, sec)).filter(Number.isFinite)));
    const shots = (k: string) => r0(mean(rs.map(r => r.fired[k] ?? 0)));
    console.log(`${name.padEnd(10)} | ${String(r0(mean(near))).padStart(9)} | ${col(20)} ${col(40)} ${col(60)} ${col(90)} ${col(120)} | ${String(r0(mean(rs.map(r => mean(r.m.tgt ?? []))))).padStart(8)} | ${String(r0(mean(rs.map(r => r.travel)))).padStart(6)} | ${shots('shell')}/${shots('missile')}/${shots('torpedo')} | ${mean(rs.map(r => r.win)).toFixed(2)} ${r2(mean(rs.map(r => r.lost0)))}/${r2(mean(rs.map(r => r.lost1)))} ${r0(mean(rs.map(r => r.dmg0)))}/${r0(mean(rs.map(r => r.taken0)))} | ${r2(mean(rs.map(r => mean(r.m.acting ?? []))))}${extraCols(rs)}`);
    console.log(`           path(seed11): ${rs[0].path.slice(0, 9).join(' ')}`);
  }
}

const team0 = (w: World) => w.ships.filter(s => s.team === 0);

// A. Swarm / Line / Artillery / Picket / basic on the same gun-and-missile cruisers
const archs: CpuArch[] = ['basic', 'swarm', 'line', 'artillery', 'picket'];
report('A1 3CAmulti vs 8DDaa holding position — engagement range by computer',
  archs.map(a => [a, F(G('ca', S('cruiser', 'multi', 3, a === 'basic' ? undefined : a)))]),
  () => F(G('dd', S('destroyer', 'aa', 8), 'vorn', 'hold')), { label: 'ca', mine: team0 });
report('A2 3CAmulti vs 2BB (enemy advancing)',
  archs.map(a => [a, F(G('ca', S('cruiser', 'multi', 3, a === 'basic' ? undefined : a)))]),
  () => F(G('bb', S('battleship', 'std', 2), 'vorn')), { label: 'ca', mine: team0 });

// B. Picket vs Line: destroyers alongside a battleship, against torpedo boats + cruisers
{
  const bbId = (w: World) => w.ships.find(s => s.team === 0 && s.cls.id === 'battleship');
  const extra = (w: World, m: Record<string, number[]>) => {
    const bb = bbId(w); if (!bb || bb.state !== 'alive') return;
    const dds = w.ships.filter(s => s.team === 0 && s.cls.id === 'destroyer' && s.state === 'alive');
    if (!dds.length) return;
    (m.cover ??= []).push(mean(dds.map(d => d.pos.distTo(bb.pos))));
    // between: the destroyer is closer to the nearest enemy of the battleship than the battleship is
    let nearE: Ship | null = null, nd = Infinity;
    for (const e of w.ships) if (e.team === 1 && e.state === 'alive') { const d = e.pos.distTo(bb.pos); if (d < nd) { nd = d; nearE = e; } }
    if (nearE) (m.screen ??= []).push(mean(dds.map(d => d.pos.distTo(nearE!.pos) < nd ? 1 : 0)));
    const raiderTargets = dds.filter(d => w.shipById.get(d.ai.targetId)?.role === 'raider').length;
    (m.raiderTgt ??= []).push(raiderTargets / dds.length);
    // line keeping: spread of the destroyers' distances to the enemy centroid (one line abreast → small)
    const es = w.ships.filter(e => e.team === 1 && e.state === 'alive');
    if (es.length && dds.length > 1) {
      const ex = mean(es.map(e => e.pos.x)), ez = mean(es.map(e => e.pos.z));
      const rs = dds.map(d => Math.hypot(d.pos.x - ex, d.pos.z - ez)), mr = mean(rs);
      (m.depth ??= []).push(Math.sqrt(mean(rs.map(r => (r - mr) ** 2))));
    }
    (m.bbHp ??= []).push(bb.hp / bb.maxHp);
  };
  const cols = (rs: ReturnType<typeof run>[]) => ` | DD-BB dist ${r0(mean(rs.map(r => mean(r.m.cover ?? []))))} screen ${r2(mean(rs.map(r => mean(r.m.screen ?? []))))} raiderTgt ${r2(mean(rs.map(r => mean(r.m.raiderTgt ?? []))))} rangeStd ${r0(mean(rs.map(r => mean(r.m.depth ?? []))))} BBhp@end ${r2(mean(rs.map(r => (r.m.bbHp ?? [0]).at(-1)!)))}`;
  for (const lo of ['strike', 'aa']) report(`B 1BB+3DD${lo} vs 6CVtorp+2CA — picket vs line (DD computer)`,
    (['basic', 'line', 'picket'] as CpuArch[]).map(a => [a, F(G('bb', S('battleship', 'std', 1)), G('dd', S('destroyer', lo, 3, a === 'basic' ? undefined : a), 'song'))]),
    () => F(G('cv', S('corvette', 'torp', 6), 'rask'), G('ca', S('cruiser', 'multi', 2), 'vorn')),
    { label: 'dd', mine: w => w.ships.filter(s => s.team === 0 && s.cls.id === 'destroyer'), extra }, cols);
}

// C. Siege vs the legacy raider run vs swarm: torpedo corvettes on a battleship with escorts
{
  const cols = (rs: ReturnType<typeof run>[]) => {
    const ls = rs.flatMap(r => r.launches);
    return ` | launches ${r2(ls.length / rs.length)} dist ${r0(mean(ls.map(l => l.dist)))} aspect ${r0(mean(ls.map(l => l.aspect)))}° beam/stern(>60°) ${r2(ls.filter(l => l.aspect > 60).length / Math.max(1, ls.length))} breaks ${r2(mean(rs.map(r => r.breaks)))} reentries ${r2(mean(rs.map(r => r.reentries)))}`;
  };
  report('C 6CVtorp vs 1BB+2DDaa — siege torpedo runs',
    (['basic', 'siege', 'swarm'] as CpuArch[]).map(a => [a, F(G('cv', S('corvette', 'torp', 6, a === 'basic' ? undefined : a), 'kostov'))]),
    () => F(G('bb', [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)], 'vorn')), { label: 'cv', mine: team0 }, cols);
  // the same with a low-skill commander: the computer still flies its run
  report('C2 6CVtorp (commander gray, skill 0.32) vs 1BB+2DDaa',
    (['basic', 'siege'] as CpuArch[]).map(a => [a, F(G('cv', S('corvette', 'torp', 6, a === 'basic' ? undefined : a), 'gray'))]),
    () => F(G('bb', [...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)], 'vorn')), { label: 'cv', mine: team0 }, cols);
}

// D. off-role fits: battleship + swarm, corvette + artillery, dreadnought (with torpedo tubes) + siege
{
  const dnTorp = (): ShipSpec['fit'] => {
    const lo = getLoadout('dreadnought', 'std');
    return { name: 'DN torp', mounts: [...lo.mounts, { weapon: 'torpedo', pos: [3, 1, 30], facing: 0, arc: 25 }, { weapon: 'torpedo', pos: [-3, 1, 30], facing: 0, arc: 25 }] };
  };
  report('D1 2BB (swarm vs basic vs artillery) vs 2BB',
    (['basic', 'swarm', 'artillery'] as CpuArch[]).map(a => [a, F(G('bb', S('battleship', 'std', 2, a === 'basic' ? undefined : a)))]),
    () => F(G('bb', S('battleship', 'std', 2), 'vorn')), { label: 'bb', mine: team0 });
  report('D2 4CVgun (artillery vs basic vs swarm) vs 2DDstrike',
    (['basic', 'artillery', 'swarm'] as CpuArch[]).map(a => [a, F(G('cv', S('corvette', 'gun', 4, a === 'basic' ? undefined : a), 'kostov'))]),
    () => F(G('dd', S('destroyer', 'strike', 2), 'vorn')), { label: 'cv', mine: team0 });
  const cols = (rs: ReturnType<typeof run>[]) => { const ls = rs.flatMap(r => r.launches); return ` | torp launches ${r2(ls.length / rs.length)} dist ${r0(mean(ls.map(l => l.dist)))} aspect ${r0(mean(ls.map(l => l.aspect)))}°`; };
  report('D3 1DN+2 torpedo tubes (siege vs basic) vs 2BB',
    (['basic', 'siege'] as CpuArch[]).map(a => [a, F(G('dn', S('dreadnought', 'std', 1, a === 'basic' ? undefined : a, { fit: dnTorp() })))]),
    () => F(G('bb', S('battleship', 'std', 2), 'vorn')), { label: 'dn', mine: team0 }, cols);
  report('D4 1DN std (no torpedoes: siege falls back to basic) vs 2BB',
    (['basic', 'siege'] as CpuArch[]).map(a => [a, F(G('dn', S('dreadnought', 'std', 1, a === 'basic' ? undefined : a)))]),
    () => F(G('bb', S('battleship', 'std', 2), 'vorn')), { label: 'dn', mine: team0 });
}
