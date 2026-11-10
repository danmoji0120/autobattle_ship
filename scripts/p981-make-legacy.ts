// Run from an extracted 86fa5f7 tree to create a real pre-P9.8 in-flight route fixture.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { WorldSim } from '../src/world/sim';
import type { Station } from '../src/world/types';
const sim = WorldSim.create(98170), p = sim.addPlayer('P9.7 저장'); sim.st.companies[p].credits = 1e7;
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const s of Object.values(sim.st.systems)) s.security = 100;
const a = sim.st.stations.astra; a.storage[p].ore = 100;
const b: Station = { ...structuredClone(a), id: 'legacy_depot', name: '구형 저장 물류항', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 500 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
sim.st.stations[b.id] = b;
const oldGroup = sim.newGroup(p, '기존 노선'), newGroup = sim.newGroup(p, '추가 공용');
const oldShip = sim.spawnShip(p, 'hauler', 'std', oldGroup.id, a.pos), newShip = sim.spawnShip(p, 'hauler', 'std', newGroup.id, a.pos);
(sim as any).dockShip(oldShip, a); (sim as any).dockShip(newShip, a);
const error = sim.command(p, { c: 'putRoute', group: oldGroup.id, config: { name: 'P9.7 운송', from: a.id, to: b.id, item: 'ore', mode: 'transfer', amount: 20, repeat: false } }); if (error) throw Error(error);
sim.tick(0); const route = Object.values(sim.st.logistics!)[0]; if (route.manifests[oldShip.id]?.amount !== 20) throw Error('legacy fixture did not load');
writeFileSync(process.argv[2], gzipSync(JSON.stringify({ base: '86fa5f7320c3b62a149c7acf116b84d0e1b9dedf', p, source: a.id, target: b.id, route: route.id, oldShip: oldShip.id, newShip: newShip.id, world: JSON.parse(sim.serialize()) })));
