// In-process run of the P13.2.1 server scenarios S5–S7 (same steps as on the real server) for tuning:
//   npx vite-node scripts/piracy/p1321-local.ts [seed] [567]
import { WorldSim } from '../../src/world/sim';
import { place, type Driver } from './p132-scenarios';
import { placeP1321, scenario5, scenario6, scenario7a, s7compare } from './p1321-scenarios';
const seed = Number(process.argv[2] ?? 9413);
let sim = WorldSim.create(seed, { piracy: 'p132' });
const [A, B, C] = ['A 약탈 PMC', 'B 운송 PMC', 'C 인양 PMC'].map(n => sim.addPlayer(n));
const ids = { ...place(sim, A, B, C), ...placeP1321(sim, A, B, C) };
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
const save = () => JSON.parse(sim.serialize());
const facts: any = {}; console.log('IDS', JSON.stringify(Object.fromEntries(Object.entries(ids).filter(([k]) => /^s[567]/.test(k)))));
void tick();
const which = (process.argv[3] ?? '567').split('');
const runs: Record<string, any> = { '5': scenario5, '6': scenario6, '7': scenario7a };
const res = await Promise.allSettled(which.map(k => runs[k](d, ids, A, B, C, facts, save)));
res.forEach((r, i) => { if (r.status === 'rejected') console.log('ERROR scenario', which[i], String(r.reason)); });
if (which.includes('7')) { running = false; const w1 = save(); sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); const w2 = save(); s7compare(d, ids, w1, w2, facts); }
running = false;
console.log(JSON.stringify(facts));
process.exit(0);
