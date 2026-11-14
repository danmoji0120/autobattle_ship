// Builds a single-player P13.1 save (SALVAGE_P131 world) for the browser check: the player's salvage fleet
// (hauler, miner, constructor) waits near astra, and a rival company's convoy sank near it in a real P11
// fight (the player's warships attacked it), so a battlefield wreck with cargo / equipment / hull scrap is
// on the map. Output: JSON {save, token, me, wreck, salvage, war}.
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, salvageNew: true } as any, 131);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '인양 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '인양 PMC';
if (sim.st.salvageV !== 1) throw Error('not a P13.1 world');
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const sys of Object.values(sim.st.systems)) sys.security = 100;
const rival = sim.addPlayer('수송 PMC'); sim.addPlayer('제3 PMC');
const a = sim.st.stations.astra;
const at = (dx: number, dz: number) => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
const fleet = (o: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, o === co ? (comp.includes('hauler') ? '인양대' : '전투단') : '수송 호송대'); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return gr; };
const convoy = fleet(rival, at(4000, 2500), ['hauler', 'corvette']);
const h = sim.st.ships[convoy.shipIds[0]]; h.cargo.metal = 300; h.cargo.electronics = 120; h.logisticsExcluded = true; h.hp = 0.3;
const war = fleet(co, at(3000, 2500), ['destroyer', 'destroyer', 'destroyer', 'frigate']);
const salv = fleet(co, at(1500, 0), ['hauler', 'miner', 'constructor']);
sim.st.companies[co].credits = 5e6;
let err = sim.command(co, { c: 'setOp', group: war.id, op: { k: 'attack', group: convoy.id } } as any); if (err) throw Error(err);
// P11 outcomes vary (an unarmed hauler often slips away): keep the same order up until it is really sunk
for (let t = 0; t < 14400 && sim.st.ships[h.id]; t += 0.5) { sim.update(0.5); if (t % 1200 === 0) console.error(t, sim.st.groups[war.id]?.status, '|', sim.st.groups[convoy.id]?.status, h.state, h.hp); }
if (sim.st.ships[h.id]) throw Error('hauler survived');
sim.command(co, { c: 'setOp', group: war.id, op: { k: 'idle' } } as any);
for (let t = 0; t < 4; t += 0.5) g.step(0.5);
const wreck = Object.values(sim.st.wrecks ?? {}).find(w => w.sources.some(s => s.ship === h.id));
if (!wreck) throw Error('no wreck');
const out = process.argv[2] ?? 'p131-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, wreck: wreck.id, salvage: salv.id, war: war.id }));
console.log(JSON.stringify({ out, wreck: wreck.name, lots: wreck.lots.length, units: wreck.initial }));
process.exit(0);
