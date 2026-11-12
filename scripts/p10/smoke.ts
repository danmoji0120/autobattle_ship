// P10 quick smoke: build a p10 world, check topology, run N simulated hours, print faction state.
import { WorldSim } from '../../src/world/sim';
import { jumps } from '../../src/world/geom';
const hours = Number(process.argv[2] ?? 2);
const t0 = performance.now();
const sim = WorldSim.create(7, { layout: 'p10' });
const w = sim.st;
console.log('systems', Object.keys(w.systems).length, 'stations', Object.keys(w.stations).length, 'fields', Object.keys(w.fields).length, 'create ms', (performance.now() - t0).toFixed(1));
let maxJ = 0; for (const a of Object.keys(w.systems)) for (const b of Object.keys(w.systems)) { const j = jumps(w.systems, a, b); if (j >= 99) console.log('UNREACH', a, b); maxJ = Math.max(maxJ, j); }
console.log('diameter', maxJ);
const t1 = performance.now();
for (let i = 0; i < hours * 3600; i++) sim.tick(1);
const ms = performance.now() - t1;
console.log('ticks', hours * 3600, 'ms/tick', (ms / (hours * 3600)).toFixed(3));
for (const f of Object.values(w.factions!)) console.log(f.id, 'str', f.strength.toFixed(1), 'infra', f.infra.toFixed(1), 'made', JSON.stringify(f.made, (k, v) => typeof v === 'number' ? Math.round(v * 10) / 10 : v), 'stock', JSON.stringify(f.stock, (k, v) => typeof v === 'number' ? Math.round(v) : v), 'claimed', f.claimed ?? []);
console.log('conflicts', Object.values(w.conflicts!).map(c => `${c.a}-${c.b} ${Math.round(c.since)}..${c.ended ? Math.round(c.ended) : 'now'}`));
console.log('save bytes', sim.serialize().length);
