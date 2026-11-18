// P16.5.1: air-to-air attrition in the mirrored carrier duel (air-strike.ts 'duel'), seeds 1..N, 180 s.
// Per seed and in total: craft lost by cause (ship point defence / craft guns, and of those how many were already
// breaking off for home), fighters' spares left at 60 / 120 / 180 s, torpedo hits and carrier damage.
//   npx vite-node scripts/p16/air-attrition.ts [-- seeds=12] [-- secs=180]
import '../../src/content/registry';
process.env.AIR_STRIKE_LIB = '1';
const { AIR_SCEN } = await import('./air-strike');
import { World } from '../../src/sim/world';
import { CRAFT_ST } from '../../src/sim/craft';

const arg = (k: string, d: number) => Number(process.argv.find(a => a.startsWith(k + '='))?.slice(k.length + 1) ?? d);
const SEEDS = arg('seeds', 12), SECS = arg('secs', 180);
const T = { pd: 0, craft: 0, craftOnReturn: 0, fighterLost: 0, fighterSpares: [0, 0, 0], exhaustedAt120: 0, torpHits: 0, cvDmg: 0, airKillsByRole: {} as Record<string, number> };
for (let seed = 1; seed <= SEEDS; seed++) {
  const w = new World(AIR_SCEN.duel(seed));
  const c = w.craft!;
  // a craft brought down: by a ship's PD (pdKills) or by a craft gun (the rest); was it already heading home?
  const pd0 = () => c.pdKills.reduce((a, v) => a + (v ?? 0), 0);
  let lastPd = 0;
  const cvIds = new Set(w.ships.filter(s => s.cls.id === 'carrier').map(s => s.id));
  while (!w.outcome && w.time < SECS) {
    const lostBefore = c.squads.reduce((a, q) => a + q.stats.lost, 0);
    const retBefore: boolean[] = [];
    for (let i = 0; i < c.n; i++) retBefore[i] = c.st[i] === CRAFT_ST.OUT && c.mode[i] === 2;
    w.step();
    const pdNow = pd0(), lostNow = c.squads.reduce((a, q) => a + q.stats.lost, 0);
    const byPd = pdNow - lastPd; lastPd = pdNow;
    const byCraft = lostNow - lostBefore - byPd;
    T.pd += byPd; T.craft += byCraft;
    for (let i = 0; i < c.n; i++) if (retBefore[i] && c.st[i] === CRAFT_ST.LOST) T.craftOnReturn++;
    for (const e of w.events as any[]) if (e.t === 'hit' && e.weapon === 'air_torpedo') { T.torpHits++; if (cvIds.has(e.target)) T.cvDmg += e.dmg ?? 0; }
    for (const [k, t] of [[60, 0], [120, 1], [180, 2]] as const) if (w.tick === k * 30) {
      const f = c.squads.filter(q => q.cs.role === 'fighter');
      T.fighterSpares[t] += f.reduce((a, q) => a + q.spares, 0) / f.length;
      if (k === 120) T.exhaustedAt120 += f.filter(q => q.spares === 0).length / f.length;
    }
  }
  T.fighterLost += c.squads.filter(q => q.cs.role === 'fighter').reduce((a, q) => a + q.stats.lost, 0);
}
const r = (x: number) => +(x / SEEDS).toFixed(2);
console.log(JSON.stringify({ seeds: SEEDS, secs: SECS, perSeed: { lostToPd: r(T.pd), lostToCraft: r(T.craft), lostWhileReturning: r(T.craftOnReturn), fighterLost: r(T.fighterLost),
  fighterSparesLeft_60_120_180: T.fighterSpares.map(r), fighterSquadsExhaustedAt120: r(T.exhaustedAt120), torpHits: r(T.torpHits), carrierTorpDmg: Math.round(T.cvDmg / SEEDS) } }));
