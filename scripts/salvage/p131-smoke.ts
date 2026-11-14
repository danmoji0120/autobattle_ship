// P13.1 quick smoke: A attacks B's loaded hauler near a public station; wreck appears; A auto-salvages; C recovers.
import { WorldSim } from '../../src/world/sim';
import { cargoSum } from '../../src/world/types';
import type { V } from '../../src/world/types';
const sim = WorldSim.create(7, { salvage: 'p131' });
const [A, B, C] = ['A', 'B', 'C'].map(n => sim.addPlayer('PMC-' + n));
console.log('flags', sim.st.salvageV, sim.st.combatV, sim.st.opsV, sim.st.logisticsV, 'sites', !!sim.st.sites);
const sta = Object.values(sim.st.stations).find(s => s.public)!;
const P = (dx: number, dz: number): V => ({ x: sta.pos.x + 4000 + dx, y: 0, z: sta.pos.z + 4000 + dz });
const fleet = (o: string, pos: V, comp: string[]) => { const g = sim.newGroup(o, o + '편대'); const c = sim.newCommander(o, 2); g.commanderId = c.id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', g.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return g; };
const gb = fleet(B, P(600, 0), ['hauler', 'corvette']);
const hb = sim.st.ships[gb.shipIds[0]]; hb.logisticsExcluded = true; hb.cargo.metal = 300; hb.cargo.electronics = 100;
const ga = fleet(A, P(0, 0), ['destroyer', 'destroyer', 'destroyer', 'frigate']);
const gc = fleet(C, P(-3000, 2000), ['hauler', 'constructor', 'miner']);
console.log('A attack', sim.command(A, { c: 'setOp', group: ga.id, op: { k: 'attack', group: gb.id } } as any));
const run = (sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.5) { sim.update(0.5); if (until?.()) return t; } return -1; };
console.log('wreck after', run(2400, () => Object.values(sim.st.wrecks ?? {}).some(w => w.lots.some(l => l.k === 'cargo'))));
const w = Object.values(sim.st.wrecks ?? {}).find(w => w.lots.some(l => l.k === 'cargo'))!;
console.log(JSON.stringify({ name: w?.name, lots: w?.lots, seen: w?.seen, pos: w?.pos }));
console.log('A op', JSON.stringify(sim.st.groups[ga.id].op), sim.st.groups[ga.id].status);
run(120);
console.log('A status', sim.st.groups[ga.id].status, JSON.stringify(sim.st.groups[ga.id].salv));
for (const id of ga.shipIds) { const s = sim.st.ships[id]; if (s) console.log(' ', s.classId, JSON.stringify(s.cargo), JSON.stringify(s.salvaged)); }
console.log('C recover', sim.command(C, { c: 'setOp', group: gc.id, op: { k: 'recover', wreck: w.id } } as any));
console.log('C recover illegal', sim.command(C, { c: 'setOp', group: gc.id, op: { k: 'salvzone', at: w.pos, radius: 3000 } } as any));
for (let i = 0; i < 12; i++) { run(60); console.log(i, sim.st.groups[gc.id].status, '| wreck left', sim.st.wrecks?.[w.id]?.lots.reduce((a, l) => a + l.n, 0)); }
for (const id of gc.shipIds) { const s = sim.st.ships[id]; console.log(' C', s.classId, s.state, JSON.stringify(s.cargo), JSON.stringify(s.salvaged)); }
const store = Object.values(sim.st.stations).map(s => [s.name, s.storage[C]]).filter(x => x[1] && Object.keys(x[1] as object).length);
console.log('C storage', JSON.stringify(store));
console.log('taken', JSON.stringify(sim.st.wrecks?.[w.id]?.taken));
console.log('events', sim.st.events.filter(e => (e as any).tag === 'salvage' || /잔해|인양/.test(e.text)).slice(-10).map(e => e.text));
