// quick trace: starter mining group + guard escort from astra
import { WorldSim } from '../../src/world/sim';
const sim = WorldSim.create(7);
const p = sim.addPlayer('호위 시험'); sim.st.companies[p].credits = 1e6;
const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
const astra = sim.st.stations.astra;
const fields = Object.values(sim.st.fields).filter(f => !f.salvage && sim.st.systems && Math.hypot(f.pos.x - astra.pos.x, f.pos.z - astra.pos.z) < 30000).sort((a, b) => Math.hypot(a.pos.x - astra.pos.x, a.pos.z - astra.pos.z) - Math.hypot(b.pos.x - astra.pos.x, b.pos.z - astra.pos.z));
const f = fields[0];
console.log('field', f.id, Math.round(Math.hypot(f.pos.x - astra.pos.x, f.pos.z - astra.pos.z)));
console.log('escort', sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id } } as any));
console.log('mine', sim.command(p, { c: 'setOp', group: mining.id, op: { k: 'mine', field: f.id, deliver: '', sell: true, auto: true } } as any));
const D = (a: any, b: any) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const cen = (ids: string[]) => { const ss = ids.map(i => sim.st.ships[i]).filter(Boolean); return { x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length }; };
for (let t = 0; t <= 400; t++) {
  sim.tick(1);
  if (t % 20 === 0) {
    const mc = cen(mining.shipIds), ec = cen(guard.shipIds);
    const lead = (ec.x - mc.x) * (f.pos.x - mc.x) + (ec.z - mc.z) * (f.pos.z - mc.z);
    console.log(t, 'miners→field', D(mc, f.pos), 'escort→miners', D(ec, mc), 'lead', Math.sign(lead), '|', mining.status, '|', guard.status, mining.shipIds.map(i => sim.st.ships[i].state[0]).join(''), guard.shipIds.map(i => sim.st.ships[i].state[0]).join(''));
  }
}
