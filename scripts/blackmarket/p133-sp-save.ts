// P13.3 browser save: a single-player P13.3 world where the player plundered a rival's hauler near the lawless
// black market's station (real P13.2 plunder in-process), its hauler unloaded the loot there (which found the
// black market), and a second, plain stash lies at another station. Nothing is sold yet: the browser sells and buys
// through the trade tab's black-market view.
//   npx vite-node scripts/blackmarket/p133-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, blackMarketNew: true } as any, 133);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '약탈 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '약탈 PMC';
if (sim.st.blackMarketV !== 1) throw Error('not a P13.3 world');
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
const rival = sim.addPlayer('수송 PMC');
const L = sim.st.stations[sim.st.blackMarkets!.bm_lawless.station];
const at = (dx: number, dz: number) => ({ x: L.pos.x + dx, y: 0, z: L.pos.z + dz });
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return gr; };
sim.st.companies[co].credits = 5e6;
if (sim.command(co, { c: 'stance', target: rival, v: -1 } as any)) throw Error('stance');
const victim = fleet(rival, '수송 화물선', at(9000, -9000), ['hauler']);
Object.assign(sim.st.ships[victim.shipIds[0]].cargo, { alloy: 200, electronics: 60 }); victim.piracyPolicy = 'survive';
sim.command(rival, { c: 'setOp', group: victim.id, op: { k: 'move', to: at(3000, -9000) } } as any);
const raid = fleet(co, '약탈대', at(9000, -5500), ['destroyer', 'frigate', 'hauler']);
const e = sim.command(co, { c: 'setOp', group: raid.id, op: { k: 'plunder', group: victim.id, policy: 'nonlethal' } } as any); if (e) throw Error(e);
for (let t = 0; t < 1500 && !(raid.op.k === 'idle' && !raid.plx); t += 0.5) g.step(0.5);
const store = L.storage[co] ?? {};
if (!Object.keys(store).some(k => k.startsWith('hot:'))) throw Error('no stolen goods at ' + L.id + ' ' + JSON.stringify(store));
if (!sim.st.companies[co].bm?.known.includes('bm_lawless')) throw Error('market not found');
for (let t = 0; t < 4; t += 0.5) g.step(0.5);
const out = process.argv[2] ?? 'p133-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, rival, station: L.id, store, other: 'astra', raid: raid.id }));
console.log(JSON.stringify({ out, station: L.id, store }));
process.exit(0);
