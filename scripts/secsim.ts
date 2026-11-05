// Long headless run: does each system settle into the security profile it is meant to have?
//   npx vite-node scripts/secsim.ts [hours=2] [seeds=1,2,3]
import { WorldSim } from '../src/world/sim';
const hours = Number(process.argv[2] ?? 2);
const seeds = (process.argv[3] ?? '1,2,3').split(',').map(Number);
for (const seed of seeds) {
  const sim = WorldSim.create(seed);
  sim.addPlayer('관찰자'); // a docked PMC that never acts
  const res: Record<string, { uWin: number; uLoss: number; fights: number }> = {};
  sim.onBattleEnd = e => { const s = e.sys ?? '?'; const r = (res[s] ??= { uWin: 0, uLoss: 0, fights: 0 }); r.fights++; if (e.sides[0].includes('union')) { if (e.winner === 0) r.uWin++; else r.uLoss++; } };
  let worst = 0;
  const T = hours * 3600;
  console.log(`\n=== seed ${seed} — ${hours}h ===`);
  for (let t = 0, next = 0; t < T; t += 0.25) {
    const t0 = performance.now(); sim.update(0.25); worst = Math.max(worst, performance.now() - t0);
    if (t >= next) {
      next += 1800;
      const rows = Object.values(sim.st.systems).map(sys => {
        const inSys = (o: string) => Object.values(sim.st.ships).filter(s => s.owner === o && sim.sysOf(s.pos)?.id === sys.id).length;
        const r = res[sys.id] ?? { uWin: 0, uLoss: 0, fights: 0 };
        return `${sys.name.padEnd(8)} sec ${sys.security} eff ${sim.effSec(sys).toFixed(0).padStart(3)} heat ${sys.heat.toFixed(0).padStart(3)} | 연합 ${String(inSys('union')).padStart(2)} 해적 ${String(inSys('pirates')).padStart(2)} 상선 ${inSys('guild')} | 전투 ${r.fights} 연합 승/패 ${r.uWin}/${r.uLoss} | 격침 해적 ${sys.stats.pirateKills} 연합 ${sys.stats.unionLosses} 민간 ${sys.stats.civLosses} 출격 ${sys.stats.bands}`;
      });
      console.log(`t=${(t / 60).toFixed(0)}m\n  ` + rows.join('\n  '));
    }
  }
  console.log(`worst tick ${worst.toFixed(1)}ms, lairs: ${Object.values(sim.st.lairs).map(l => `${l.id}:${l.alive ? 'alive' : 'dead'}`).join(' ')}`);
}
