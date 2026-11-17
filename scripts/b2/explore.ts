// B-2 analysis: what military activity a standard world has around the security / veteran starts
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { sysAt } from '../../src/world/geom';
const sim = WorldSim.create(41, { ...STANDARD_WORLD });
const a = sim.addPlayer('경비', 'security'), b = sim.addPlayer('퇴역', 'veteran');
const sysOf = (p: any) => sysAt(sim.st.systems, p)?.id;
const snap = (t: string) => {
  const st = sim.st;
  const by = (o: string) => Object.values(st.groups).filter(g => g.owner === o && g.shipIds.length);
  const pir = by('pirates').map(g => `${g.npc?.role}:${g.op.k}@${sysOf(st.ships[g.shipIds[0]].pos)}(${g.shipIds.length})`);
  const guild = by('guild').map(g => `${g.npc?.role}:${g.op.k}@${sysOf(st.ships[g.shipIds[0]].pos)}`);
  const union = by('union').map(g => `${g.npc?.role}:${g.op.k}`);
  const k = Object.values(st.contracts).filter(x => !x.done).map(x => `${x.kind}@${x.stationId}:${x.reward}`);
  console.log(t, JSON.stringify({ pir: pir.length, pirS: pir.slice(0, 40), guild: guild.length, guildS: guild.slice(0, 20), union: union.length, unionKinds: [...new Set(union)], lairs: Object.values(st.lairs).map(l => `${l.id}:${sysOf(l.pos)}:t${l.tier}:${l.alive}`), contracts: k, battles: Object.keys(st.engagements).length }));
};
snap('t0');
console.log('homes', sim.st.companies[a].homeStation, sysOf(sim.st.stations.helios.pos), sim.st.stations.helios.funds, sim.st.companies[b].homeStation, sysOf(sim.st.stations.p10_bulwark_yard.pos), sim.st.stations.p10_bulwark_yard.funds, sim.st.stations.p10_bulwark_yard.public, sim.st.stations.p10_bulwark_yard.services);
console.log('systems', Object.values(sim.st.systems).map(s => `${s.id}:${s.faction}:${s.security}`).join(' '));
for (let h = 1; h <= 2; h++) { for (let i = 0; i < 3600; i++) sim.update(1); snap('h' + h); }
