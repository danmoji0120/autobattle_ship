// P17.4f F3: balance check — per-industry cash and allocated costs (industryPnl.ts) of starter companies left on their business in the
// standard world. Miner starter: best field from the first-business field options, sell at the best delivery.
// Salvager starter: P17.0 salvage business. Repair: a default company whose industrial ship carries M repair gear,
// running the P17.2 repair business next to the busiest navy system (as scripts/p17/repairbiz-sim.ts).
// Usage: HOURS=12 SEED=31 npx tsx scripts/p17/industry-balance.ts
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { fieldOptions } from '../../src/world/firstBusiness';
import { pnlRows } from '../../src/world/industryPnl';

const HOURS = Number(process.env.HOURS ?? 12), SEED = Number(process.env.SEED ?? 31);
const sim = WorldSim.create(SEED, { ...STANDARD_WORLD });
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const step = (sec: number) => { for (let t = 0; t < sec; t++) sim.update(1); };

const M = sim.addPlayer('채굴 스타터', 'miner'), S = sim.addPlayer('인양 스타터', 'salvager'), R = sim.addPlayer('수리업');
step(30);
const groupOf = (p: string) => Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.length)!;
// miner: the best-paying field and delivery the first-business screen offers
const fo = fieldOptions(sim.st, M).filter(f => !f.depleted && f.deliveries.length).sort((a, b) => (b.deliveries[0].per100 - a.deliveries[0].per100) || a.jumps - b.jumps)[0];
console.log('miner field', fo?.name, 'jumps', fo?.jumps, 'deliver', fo?.deliveries[0]?.station, 'per100', fo?.deliveries[0]?.per100,
  'setOp', sim.command(M, { c: 'setOp', group: groupOf(M).id, op: { k: 'mine', field: fo.field, deliver: fo.deliveries[0].station, sell: true } } as never));
// salvager: salvage business from where it is
const sg = groupOf(S), sp = sim.st.ships[sg.shipIds[0]].pos;
console.log('salvager setOp', sim.command(S, { c: 'setOp', group: sg.id, op: { k: 'salvzone', at: { ...sp }, radius: 6000, biz: true } } as never));
// repair business near the busiest navy system
const rep = Object.values(sim.st.ships).find(s => s.owner === R && s.ind && s.fitting)!;
rep.fitting!.bay = { [Object.keys(rep.fitting!.bay)[0] ?? 'ind1']: 'ind_rep_m' };
sim.command(R, { c: 'newGroup', name: '수리업', ships: [rep.id] } as never);
const navy: Record<string, number> = {};
for (const s of Object.values(sim.st.ships)) if (sim.st.companies[s.owner]?.kind === 'union') { const y = sim.sysOf(s.pos)?.id; if (y) navy[y] = (navy[y] ?? 0) + 1; }
const base = Object.values(sim.st.stations).filter(x => x.public && navy[sim.sysOf(x.pos)?.id ?? '']).sort((a, b) => navy[sim.sysOf(b.pos)!.id] - navy[sim.sysOf(a.pos)!.id])[0];
rep.state = 'space'; rep.task = { k: 'idle' } as never; rep.pos = { ...base.pos, x: base.pos.x + 800 };
console.log('repair base', base.name, 'setOp', sim.command(R, { c: 'setOp', group: rep.groupId, op: { k: 'repairbiz', at: { ...rep.pos }, jumps: 1, mul: 1.2, clients: 'all', minFee: 200, avoidRisk: true } } as never));

const cos = [['채굴', M], ['인양', S], ['수리', R]] as const;
const c0 = Object.fromEntries(cos.map(([, p]) => [p, sim.st.companies[p].credits]));
for (let h = 1; h <= HOURS; h++) {
  step(3600);
  if (h % 4 === 0 || h === HOURS) {
    console.log(`\n== ${h}h`);
    for (const [label, p] of cos) {
      const co = sim.st.companies[p];
      const rows = pnlRows(co, sim.time, h);
      console.log(`${label} credits Δ ${n0(co.credits - c0[p])} | ` + rows.map(r => `${r.name}: +${n0(r.inc)} −${n0(r.exp + r.operating)} = ${n0(r.net)} (${r.ships.toFixed(1)}척)`).join(' | '));
    }
  }
}
