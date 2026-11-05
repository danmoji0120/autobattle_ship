import { WorldSim } from '../src/world/sim';
const sim = WorldSim.create(7);
const me = sim.addPlayer('T');
const st = sim.st;
const mg = Object.values(st.groups).find(g => g.owner === me && g.name === '제1 채굴반')!;
sim.command(me, { c: 'setOp', group: mg.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
st.companies[me].credits = 99999;
console.log(sim.command(me, { c: 'buyShip', station: 'astra', classId: 'hauler', loadoutId: 'std', group: mg.id }));
for (let i = 0; i < 4800; i++) {
  sim.update(0.05);
  if (i % 100 === 0) {
    const ss = mg.shipIds.map(id => st.ships[id]);
    console.log(`t=${st.time.toFixed(0)} ` + ss.map(s => `${s.classId[0]}:${s.state}/${s.task.k}${(s.task as any).why ? ':' + (s.task as any).why : ''} c=${Math.round(s.cargo.ore)} d=${Math.round(Math.hypot(s.pos.x - 2900, s.pos.z + 2100))}`).join(' | ') + ' cr=' + Math.round(st.companies[me].credits));
  }
}
