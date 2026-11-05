import { WorldSim } from '../src/world/sim';
import { World } from '../src/sim/world';
const sim = WorldSim.create(7);
const me = sim.addPlayer('T');
const st = sim.st;
const G = (n: string) => Object.values(st.groups).find(g => g.owner === me && g.name === n)!;
sim.command(me, { c: 'setOp', group: G('제1 채굴반').id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
sim.command(me, { c: 'setOp', group: G('경비대').id, op: { k: 'escort', group: G('제1 채굴반').id } });
let e: any = null;
for (let i = 0; i < 200000 && !e; i++) { sim.update(0.2); e = Object.values(st.engagements).find(x => x.live); }
console.log('engagement at', (st.time / 60).toFixed(1), 'min');
console.log(JSON.stringify(e.setup.fleets.map((f: any) => f.root.children.map((c: any) => ({ n: c.name, o: c.order, s: c.ships.map((s: any) => s.classId + ':' + (s.hp ?? 1).toFixed(2)), k: c.children.length })))));
const w = new World(e.setup);
let last = 0;
while (!w.outcome) { w.step(); if (w.time - last > 30) { last = w.time; console.log(w.time.toFixed(0), w.ships.map(s => `${s.team}${s.cls.id[0]}:${s.state[0]}${Math.round(s.hp)} @${Math.round(s.pos.x)},${Math.round(s.pos.z)}`).join(' ')); } }
console.log(w.outcome);
console.log(w.groups.map(g => `${g.team}:${g.name}:${g.order.type}`).join(' | '));
