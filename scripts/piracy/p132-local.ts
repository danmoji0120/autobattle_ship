// In-process run of the §16 scenarios (same steps as the real server run) for tuning:  npx vite-node scripts/piracy/p132-local.ts [seed]
import { WorldSim } from '../../src/world/sim';
import { place, scenario1, scenario2, scenario3, scenario4, type Driver } from './p132-scenarios';
const seed = Number(process.argv[2] ?? 9413);
const sim = WorldSim.create(seed, { piracy: 'p132' });
const [A, B, C] = ['A 약탈 PMC', 'B 운송 PMC', 'C 인양 PMC'].map(n => sim.addPlayer(n));
const ids = place(sim, A, B, C);
const who = { A, B, C } as const;
let running = true;
const tick = async () => { while (running) { for (let i = 0; i < 4; i++) sim.update(0.5); await new Promise(r => setImmediate(r)); } };
const d: Driver = {
  async cmd(w, c) { return sim.command(who[w], c) ?? null; },
  view() { return sim.st; },
  time: () => sim.time,
  async wait(fn, why, s) { const end = sim.time + s; for (;;) { const v = fn(); if (v) return v as any; if (sim.time > end) throw Error(why); await new Promise(r => setImmediate(r)); } },
  log(ok, label, extra) { console.log(ok ? 'PASS' : 'FAIL', `[${Math.round(sim.time)}]`, label, extra ? JSON.stringify(extra) : ''); },
  info(label, extra) { console.log('INFO', label, extra ? JSON.stringify(extra) : ''); },
};
const facts: any = {};
void tick();
const which = (process.argv[3] ?? '1234').split('');
const runs = { '1': scenario1, '2': scenario2, '3': scenario3, '4': scenario4 } as const;
const res = await Promise.allSettled(which.map(k => runs[k as '1'](d, ids, A, B, C, facts)));
running = false;
res.forEach((r, i) => { if (r.status === 'rejected') console.log('ERROR scenario', which[i], String(r.reason)); });
console.log(JSON.stringify(facts));
console.log('log', JSON.stringify(sim.st.piracy?.log.map(e => [Math.round(e.t), e.kind, e.by, e.to])));
process.exit(0);
