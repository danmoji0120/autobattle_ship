// P17.2 short sim: one repair business (one M field repair ship) left alone near a faction capital for 6 h
// in the standard world — NPC navy customers only (no player has consented), real damage from real fights.
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { observeWorld } from '../../src/world/observe';
const sim = WorldSim.create(31, { ...STANDARD_WORLD });
const A = sim.addPlayer('수리업');
const rep = Object.values(sim.st.ships).find(s => s.owner === A && s.ind && s.fitting)!;
rep.fitting!.bay = { [Object.keys(rep.fitting!.bay)[0] ?? 'ind1']: 'ind_rep_m' };
sim.command(A, { c: 'newGroup', name: '수리업', ships: [rep.id] } as any);
// base: the public station of the busiest navy system (most union ships), the ship starts in space next to it
for (let t = 0; t < 300; t++) sim.update(1);
const navy: Record<string, number> = {};
for (const s of Object.values(sim.st.ships)) if (sim.st.companies[s.owner]?.kind === 'union') { const y = sim.sysOf(s.pos)?.id; if (y) navy[y] = (navy[y] ?? 0) + 1; }
const base = Object.values(sim.st.stations).filter(x => x.public && navy[sim.sysOf(x.pos)?.id ?? ''])
  .sort((a, b) => navy[sim.sysOf(b.pos)!.id] - navy[sim.sysOf(a.pos)!.id])[0];
rep.state = 'space'; rep.task = { k: 'idle' } as any; rep.pos = { ...base.pos, x: base.pos.x + 800 };
console.log('base', base.name, sim.sysOf(base.pos)?.name, 'navy ships in system', navy[sim.sysOf(base.pos)!.id]);
const g = sim.st.groups[rep.groupId];
console.log('setOp', sim.command(A, { c: 'setOp', group: g.id, op: { k: 'repairbiz', at: { ...rep.pos }, jumps: 1, mul: 1.2, clients: 'all', minFee: 200, avoidRisk: true } } as any));
const c0 = sim.st.companies[A].credits;
const m = { income: 0, cost: 0, upkeep: 0 };
observeWorld(sim.st, e => {
  if (e.reason === 'repair_service' && e.kind === 'income' && e.company === A) m.income += e.amount;
  if (e.reason === 'repair_service' && e.kind === 'cost') m.cost += e.amount;
  if (e.company === A && e.kind === 'cost' && e.reason !== 'repair_service' && e.ship === rep.id) m.upkeep += e.amount;
});
for (let h = 1; h <= Number(process.env.HOURS ?? 6); h++) {
  for (let t = 0; t < 3600; t++) { sim.update(1); if (process.env.DBG && t % 120 === 0 && h === 1) console.log(t, rep.state, rep.hp.toFixed(2), g.status, g.rbiz?.target ?? ''); }
  console.log(`${h}h income ${Math.round(m.income)} · customers paid ${Math.round(m.cost)} · jobs ${g.rbiz?.jobs.length ?? 0} · status: ${g.status}`);
}
const co = sim.st.companies[A];
console.log('jobs', (g.rbiz?.jobs ?? []).slice(0, 5).map(j => `${j.name}/${sim.st.companies[j.client]?.kind} ${j.hull}% ${j.fee}cr`).join(' | '));
console.log(`company credits Δ ${Math.round(co.credits - c0)} (repair income ${Math.round(m.income)}; the rest is the company's ordinary upkeep)`);
if (process.env.DBG) {  // debug: groups near the repair ship at the end
  const c = rep.pos;
  for (const p of Object.values(sim.st.groups)) {
    if (!p.shipIds.length || p.owner === A) continue;
    const pc = sim.groupCenter(p); if (!pc) continue;
    const d = Math.hypot(pc.x - c.x, pc.z - c.z);
    if (d < 4000) console.log('near', p.owner, p.name, Math.round(d), p.cooldown, (sim as any).st.companies[p.owner]?.kind);
  }
  console.log('fleeing', g.fleeing, rep.state, rep.hp);
}
