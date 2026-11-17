// P15.1.1: siege-computer analysis. Where does a siege corvette's time go (waiting for reload, run-in, final
// run, break-away) and does a beam / rear-quarter launch actually pay (hit rate, interception, damage per
// hit by hit facing)? Same hulls, weapons, commander and seeds; only the computer changes.
//   npx vite-node scripts/p15/siege.ts [seeds=4] [T=180]
import { World, BATTLE_RULES } from '../../src/sim/world';
import { cpuRange } from '../../src/sim/ai/computer';
import type { FleetSpec, ShipSpec, GroupSpec } from '../../src/sim/fleet';
import type { CpuArch } from '../../src/sim/ai/computer';
import '../../src/content/registry';

const SEEDS = Number(process.argv[2] ?? 4), T = Number(process.argv[3] ?? 180);
const S = (c: string, l: string, n: number, cpu?: CpuArch): ShipSpec[] =>
  Array.from({ length: n }, () => ({ classId: c, loadoutId: l, ...(cpu && cpu !== 'basic' ? { cpu: { id: `cpu_${cpu}`, arch: cpu } } : {}) }));
const G = (ships: ShipSpec[], cmd: string): GroupSpec => ({ name: 'g', commanderId: cmd, order: 'engage', retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec): FleetSpec => ({ name: 'x', root: g });
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f1 = (n: number) => Number.isFinite(n) ? n.toFixed(1) : '-';
const f2 = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '-';

/** aspect of a point seen from the target: 0° bow, 90° beam, 180° stern */
function aspect(tx: number, tz: number, fx: number, fz: number, px: number, pz: number) {
  const dx = px - tx, dz = pz - tz, l = Math.hypot(dx, dz) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / l))) * 180 / Math.PI;
}
const BIN = (a: number) => a < 60 ? 'bow <60' : a < 120 ? 'beam 60-120' : 'stern >120';

function run(arch: CpuArch, enemy: () => FleetSpec, cmd: string, seed: number) {
  const w = new World({ seed, scenarioId: 'p1511', fleets: [F(G(S('corvette', 'torp', 6, arch), cmd)), enemy()], rules: BATTLE_RULES });
  const phase: Record<string, number> = {};
  const torp = new Map<number, { asp: number; pos: { x: number; z: number }; ph: string; d: number }>();
  const out: { asp: number; res: string; dmg: number; facing: string; ph: string; d: number }[] = [];
  const lastPh = new Map<number, string>();
  const deaths: string[] = [];
  let firstLaunch = NaN;
  const dt = 1 / 30;
  while (!w.outcome && w.time < T) {
    w.step();
    const hits = w.events.filter(e => e.t === 'hit' && e.weapon === 'torpedo') as Extract<typeof w.events[number], { t: 'hit' }>[];
    const icp = w.events.filter(e => e.t === 'intercept' && e.kind === 'torpedo') as Extract<typeof w.events[number], { t: 'intercept' }>[];
    const live = new Set<number>();
    for (const m of w.munitions) if (m.kind === 'torpedo' && m.team === 0 && !m.dead) {
      live.add(m.id);
      if (!torp.has(m.id)) {
        const sh = w.shipById.get(m.ownerId), t = w.shipById.get(m.targetId);
        if (Number.isNaN(firstLaunch)) firstLaunch = w.time;
        torp.set(m.id, { asp: sh && t ? aspect(t.pos.x, t.pos.z, t.fwd.x, t.fwd.z, sh.pos.x, sh.pos.z) : NaN, pos: { x: m.pos.x, z: m.pos.z }, ph: (lastPh.get(m.ownerId) ?? '?').split(':')[0], d: sh && t ? sh.pos.distTo(t.pos) : NaN });
      } else { const p = torp.get(m.id)!.pos; p.x = m.pos.x; p.z = m.pos.z; }
    }
    for (const [id, r] of torp) if (!live.has(id)) {
      torp.delete(id);
      const near = (p: { x: number; z: number }) => Math.hypot(p.x - r.pos.x, p.z - r.pos.z) < 80;
      const h = hits.find(e => near(e.pos));
      if (h) out.push({ asp: r.asp, res: 'hit', dmg: h.dmg, facing: h.facing, ph: r.ph, d: r.d });
      else if (icp.some(e => near(e.pos))) out.push({ asp: r.asp, res: 'intercepted', dmg: 0, facing: '', ph: r.ph, d: r.d });
      else out.push({ asp: r.asp, res: 'miss', dmg: 0, facing: '', ph: r.ph, d: r.d });
    }
    for (const e of w.events) if (e.t === 'dying') { const sh = w.shipById.get(e.ship); if (sh && sh.team === 0) deaths.push((lastPh.get(sh.id) ?? '?').split(':')[0]); }
    // where the time goes (alive torpedo boats)
    for (const s of w.ships) if (s.team === 0 && s.state === 'alive') {
      const tubes = s.mounts.filter(m => m.weapon.kind === 'torpedo' && m.disabled <= 0 && m.ammo > 0);
      const ready = tubes.some(m => m.cooldown <= 0.4 || m.salvoLeft > 0);
      const t = w.shipById.get(s.ai.targetId);
      let k: string;
      if (!s.cpu || s.cpu.acting !== 'siege') k = ready ? 'basic:ready' : 'basic:reload';
      else if (s.cpu.mode === 'break') k = ready ? 'break:ready' : 'break:reload';
      else {
        const L = cpuRange('siege', s.cpu.bands!) ?? 0, d = t ? t.pos.distTo(s.pos) : Infinity;
        k = !ready && d > L * 1.4 ? 'wait' : d > L * 1.25 ? (ready ? 'runin:ready' : 'runin:reload') : (ready ? 'final:ready' : 'final:reload');
      }
      phase[k] = (phase[k] ?? 0) + dt; lastPh.set(s.id, k);
    }
  }
  const lost = w.ships.filter(s => s.team === 0 && s.state !== 'alive').length;
  const bb = w.ships.find(s => s.team === 1 && s.cls.id === 'battleship')!;
  return { phase, out, deaths, firstLaunch, lost, bbDmg: bb.maxHp - Math.max(0, bb.hp), bbDead: bb.state !== 'alive' ? 1 : 0, time: w.time };
}

function report(title: string, enemy: () => FleetSpec, cmd: string, archs: CpuArch[] = ['basic', 'siege']) {
  console.log(`\n== ${title} (rules ${BATTLE_RULES}, seeds ${SEEDS}, T ${T}s)`);
  for (const a of archs) {
    const rs = Array.from({ length: SEEDS }, (_, i) => run(a, enemy, cmd, 11 + i * 7));
    const all = rs.flatMap(r => r.out);
    const ph: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.phase)) ph[k] = (ph[k] ?? 0) + v / SEEDS;
    const tot = Object.values(ph).reduce((x, y) => x + y, 0);
    const readyT = Object.entries(ph).filter(([k]) => k.endsWith('ready')).reduce((x, [, v]) => x + v, 0);
    console.log(`${a.padEnd(6)} launches ${f1(all.length / SEEDS)} first@${f1(mean(rs.map(r => r.firstLaunch)))}s | hit ${f2(all.filter(o => o.res === 'hit').length / all.length)} intercepted ${f2(all.filter(o => o.res === 'intercepted').length / all.length)} miss ${f2(all.filter(o => o.res === 'miss').length / all.length)} | dmg/launch ${f1(all.reduce((x, o) => x + o.dmg, 0) / all.length)} | BB dmg ${Math.round(mean(rs.map(r => r.bbDmg)))} BB killed ${f2(mean(rs.map(r => r.bbDead)))} | our lost ${f2(mean(rs.map(r => r.lost)))} | ship-time with a ready tube ${f2(readyT / tot)}`);
    console.log(`       time share: ${Object.entries(ph).sort().map(([k, v]) => `${k} ${f2(v / tot)}`).join(' · ')}`);
    const by = (key: (o: typeof all[number]) => string) => { const m: Record<string, typeof all> = {}; for (const o of all) (m[key(o)] ??= []).push(o); return m; };
    console.log(`       launch phase: ${Object.entries(by(o => o.ph)).sort().map(([k, b]) => `${k} n${b.length} hit ${f2(b.filter(o => o.res === 'hit').length / b.length)} miss ${f2(b.filter(o => o.res === 'miss').length / b.length)} d${Math.round(mean(b.map(o => o.d)))}`).join(' · ')}`);
    const dz: Record<string, number> = {}; for (const r of rs) for (const k of r.deaths) dz[k] = (dz[k] ?? 0) + 1 / SEEDS;
    console.log(`       losses by phase: ${Object.entries(dz).sort().map(([k, v]) => `${k} ${f2(v)}`).join(' · ')}`);
    for (const bin of ['bow <60', 'beam 60-120', 'stern >120']) {
      const b = all.filter(o => BIN(o.asp) === bin); if (!b.length) continue;
      const h = b.filter(o => o.res === 'hit');
      const fc = (f: string) => h.filter(o => o.facing === f);
      console.log(`       launch ${bin.padEnd(11)} n ${String(b.length).padStart(3)} hit ${f2(h.length / b.length)} icp ${f2(b.filter(o => o.res === 'intercepted').length / b.length)} | dmg/hit ${Math.round(mean(h.map(o => o.dmg)))} | hit facing front/side/rear ${fc('front').length}/${fc('side').length}/${fc('rear').length} (dmg ${Math.round(mean(fc('front').map(o => o.dmg)))}/${Math.round(mean(fc('side').map(o => o.dmg)))}/${Math.round(mean(fc('rear').map(o => o.dmg)))})`);
    }
  }
}

const escorted = () => F(G([...S('battleship', 'std', 1), ...S('destroyer', 'aa', 2)], 'vorn'));
const lone = () => F(G(S('battleship', 'std', 1), 'vorn'));
const filter = process.argv[4] ?? '';
if (!filter || filter === 'C') report('C 6CVtorp vs 1BB+2DDaa', escorted, 'kostov');
if (!filter || filter === 'C2') report('C2 6CVtorp (gray) vs 1BB+2DDaa', escorted, 'gray');
if (!filter || filter === 'L') report('L 6CVtorp vs lone BB (geometry only)', lone, 'kostov');
