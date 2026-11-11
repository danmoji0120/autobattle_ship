// BB-EX combat trials (headless, real battle engine, ordinary opponents).
//   npx vite-node scripts/bbex-trials.ts [trial ids…] [--seeds 1,2,3] [--json out.json]
import { World } from '../src/sim/world';
import '../src/content/registry';
import { TRIALS, trialSetup } from '../src/sim/bbex/trials';
import { exReport } from '../src/sim/bbex/system';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const seeds = (flag('--seeds') ?? '1,2,3').split(',').map(Number);
const json = flag('--json');
const ids = args.length ? args : TRIALS.map(t => t.id);
const out: unknown[] = [];

for (const id of ids) {
  const t = TRIALS.find(x => x.id === id); if (!t) { console.error('unknown trial', id); continue; }
  for (const seed of seeds) {
    const w = new World(trialSetup(t, seed));
    const n = w.ships.filter(s => s.team === 1).length;
    const ex = w.exShips[0];
    const t0 = performance.now();
    let maxStep = 0, half = -1, minHp = 1; const dcp: number[] = []; let lastKills = 0;
    while (!w.outcome) {
      const s0 = performance.now(); w.step(); const d = performance.now() - s0; if (d > maxStep) maxStep = d;
      if (ex.state === 'alive') minHp = Math.min(minHp, ex.hp / ex.maxHp);
      for (const e of w.events) if (e.t === 'exDcpEnd') { const k = ex.ex!.stats.weapon.dcp_omega?.kills ?? 0; dcp.push(k - lastKills); lastKills = k; }
      if (half < 0 && w.tick % 30 === 0 && w.ships.filter(s => s.team === 1 && s.state === 'alive').length <= n / 2) half = w.time;
    }
    const wall = performance.now() - t0;
    const dead = w.ships.filter(s => s.team === 1 && (s.state === 'dead' || s.state === 'dying')).length;
    const esc = w.ships.filter(s => s.team === 1 && s.state === 'escaped').length;
    const r = exReport(ex);
    const row = { trial: id, name: t.name, seed, ships: n, winner: w.outcome!.winner, reason: w.outcome!.reason, time: +w.outcome!.time.toFixed(1), half: +half.toFixed(1), destroyed: dead, escaped: esc,
      minHp: +minHp.toFixed(3), dcpKillsPerShot: dcp, msPerTick: +(wall / w.tick).toFixed(3), maxStepMs: +maxStep.toFixed(1), ...r };
    out.push(row);
    const wp = Object.entries(r.weapons).sort((a, b) => b[1].dmg - a[1].dmg).map(([k, v]) => `${k.replace(/_.*/, '')} ${Math.round(v.dmg / 1000)}k dmg/${v.kills} kills`).join(' · ');
    console.log(`${id.padEnd(12)} seed ${seed} n=${n} → ${w.outcome!.winner === 0 ? 'WIN ' : w.outcome!.winner === 1 ? 'LOSS' : 'DRAW'} ${w.outcome!.time.toFixed(0).padStart(4)}s (half ${half.toFixed(0)}s) dead ${dead} esc ${esc} | hull ${(r.hp * 100).toFixed(0)}% (min ${(minHp * 100).toFixed(0)}%) | funnels ${r.funnels.alive}/12 lost ${r.funnels.lost} | PARADOX ${r.paradox.displaced}/${r.paradox.hits} abs ${Math.round(r.paradox.absorbed / 1000)}k ovl ${r.paradox.overloads} | DCP ${r.dcpShots} GO ${r.gameOvers} veto ${r.vetoes} shift ${r.shifts} | ${(wall / w.tick).toFixed(2)} ms/tick (max ${maxStep.toFixed(0)})\n   ${wp}  [${w.outcome!.reason}] dcp kills/shot ${dcp.join(',')}`);
  }
}
if (json) writeFileSync(json, JSON.stringify(out, null, 1));
