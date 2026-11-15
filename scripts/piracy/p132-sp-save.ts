// Builds a single-player P13.2 save (PIRACY_P132 world) for the browser check. The player's raiding group
// (destroyer, frigate, hauler) made a real non-destructive plunder of a hostile rival's convoy: the demand,
// the victim's decision, the jettison and the container are all the simulation's own (nothing is placed by
// hand). A second rival convoy is left flying for the UI-issued plunder order. The player also has an idle
// hauler group (for the container recover button). Output: JSON {save, token, me, drop, raid, spare, target}.
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, piracyNew: true } as any, 132);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '약탈 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '약탈 PMC';
if (sim.st.piracyV !== 1) throw Error('not a P13.2 world');
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const sys of Object.values(sim.st.systems)) sys.security = 10;
const rival = sim.addPlayer('수송 PMC'); sim.addPlayer('제3 PMC');
const a = sim.st.stations.astra;
const at = (dx: number, dz: number) => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z })); return gr; };
sim.st.companies[co].credits = 5e6;
if (sim.command(co, { c: 'stance', target: rival, v: -1 } as any)) throw Error('stance');
const convoy = fleet(rival, '수송 호송대', at(10000, -25000), ['hauler']);
const h = sim.st.ships[convoy.shipIds[0]]; h.cargo.metal = 300; h.cargo.electronics = 120; h.logisticsExcluded = true;
sim.command(rival, { c: 'setOp', group: convoy.id, op: { k: 'move', to: at(4000, -25000) } } as any);
convoy.piracyPolicy = 'survive';
const raid = fleet(co, '약탈대', at(10000, -24100), ['destroyer', 'frigate']);
let err = sim.command(co, { c: 'setOp', group: raid.id, op: { k: 'plunder', group: convoy.id, policy: 'nonlethal' } } as any); if (err) throw Error(err);
for (let t = 0; t < 600 && !Object.keys(sim.st.drops ?? {}).length; t += 0.5) g.step(0.5);
const drop = Object.values(sim.st.drops ?? {})[0];
if (!drop) throw Error('no drop: ' + JSON.stringify(sim.st.piracy?.log));
// stop the raid before it recovers anything: the browser recovers it with the spare hauler
sim.command(co, { c: 'setOp', group: raid.id, op: { k: 'idle' } } as any);
const spare = fleet(co, '회수대', { x: drop.pos.x + 1500, y: 0, z: drop.pos.z }, ['hauler']);
const target = fleet(rival, '제2 호송대', at(14000, -22000), ['hauler']);
const h2 = sim.st.ships[target.shipIds[0]]; h2.cargo.ore = 400; h2.logisticsExcluded = true;
sim.command(rival, { c: 'setOp', group: target.id, op: { k: 'move', to: at(8000, -22000) } } as any);
for (let t = 0; t < 4; t += 0.5) g.step(0.5);
const out = process.argv[2] ?? 'p132-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, drop: drop.id, raid: raid.id, spare: spare.id, target: target.id, log: sim.st.piracy?.log }));
console.log(JSON.stringify({ out, drop: drop.name, initial: drop.initial, lots: drop.lots, log: sim.st.piracy?.log.map(e => e.kind) }));
process.exit(0);
