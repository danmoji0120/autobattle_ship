// matchup probe: a start fleet vs real pirate bands (teleported next to each other), outcome per pairing
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { shipValue } from '../../src/world/data';
import { econOf } from '../../src/world/hullops';
const base = WorldSim.create(41, { ...STANDARD_WORLD });
const S = base.addPlayer('경비', 'security'), V = base.addPlayer('퇴역', 'veteran');
for (let i = 0; i < 1800; i++) base.update(1);
const save = JSON.stringify(base.st);
const bands = Object.values(base.st.groups).filter(g => g.owner === 'pirates' && g.shipIds.length);
for (const who of [S, V]) for (const b of bands.slice(0, 12)) {
  const sim = new WorldSim(JSON.parse(save));
  const fg = Object.values(sim.st.groups).find(g => g.owner === who && !g.parentId && g.shipIds.length)!;
  const band = sim.st.groups[b.id];
  const mine = fg.shipIds.map(id => sim.st.ships[id]);
  const pir = band.shipIds.map(id => sim.st.ships[id]).filter(s => econOf(s).military);
  if (!pir.length) continue;
  const at = { ...pir[0].pos };
  for (const s of mine) { s.state = 'space'; s.task = { k: 'none' } as any; s.pos = { x: at.x + 2500, y: at.y, z: at.z }; s.hp = 1; }
  sim.command(who, { c: 'setOp', group: fg.id, op: { k: 'attack', group: band.id } });
  let t = 0; for (; t < 900; t++) { sim.update(1); if (!band.shipIds.length || !fg.shipIds.some(id => sim.st.ships[id])) break; }
  const alive = fg.shipIds.filter(id => sim.st.ships[id]).length;
  console.log(who === S ? 'SEC' : 'VET', mine.map(s => s.classId).join(','), '=', mine.reduce((a, s) => a + shipValue(s.classId), 0), 'vs', b.name, pir.map(s => s.classId).join(','), '=', pir.reduce((a, s) => a + shipValue(s.classId), 0), '→', band.shipIds.length ? `band left ${band.shipIds.length}` : 'band dead', `mine ${alive}/${mine.length}`, `t=${t}`);
}
