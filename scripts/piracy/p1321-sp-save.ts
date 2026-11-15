// P13.2.1: the P13.2 single-player browser save (p132-sp-save.ts) plus a second raid in progress: the player's
// group 약탈대 2 (destroyer, frigate, hauler) made a real plunder of 제3 호송대 (escorted by 제3 호위대) and is
// recovering its container when the save is taken, so the browser sees 약탈품 회수 중 / 회수품 하역 중 and can end
// that truce with a direct attack on the escort. Everything else as in p132-sp-save.ts.
// P13.2 part — the player's raiding group (destroyer, frigate, hauler) made a real non-destructive plunder of a hostile rival's convoy: the demand,
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
// P13.2.1: the extra simulated minutes below must not let the idle raid / spare hauler auto-salvage the first
// container (the browser recovers it with the panel button) — their automatic on-site salvage is switched off
for (const gid of [raid.id, spare.id]) { const e = sim.command(co, { c: 'autoSalvage', group: gid, on: false } as any); if (e) throw Error(e); }
// P13.2.1: a second raid that is recovering its plunder when the save is taken
const c3 = fleet(rival, '제3 호송대', at(-6000, 30000), ['hauler']);
const h3 = sim.st.ships[c3.shipIds[0]]; h3.cargo.electronics = 200; h3.logisticsExcluded = true; c3.piracyPolicy = 'survive';
const e3 = fleet(rival, '제3 호위대', at(-6000, 30400), ['corvette']);
sim.command(rival, { c: 'setOp', group: e3.id, op: { k: 'escort', group: c3.id } } as any);
const raid2 = fleet(co, '약탈대 2', at(-6000, 29200), ['destroyer', 'frigate', 'hauler']);
for (const id of raid2.shipIds) if (sim.st.ships[id].classId === 'hauler') sim.st.ships[id].logisticsExcluded = true;
err = sim.command(co, { c: 'setOp', group: raid2.id, op: { k: 'plunder', group: c3.id, policy: 'nonlethal' } } as any); if (err) throw Error(err);
let drop2: any;
for (let t = 0; t < 600 && !(drop2 = Object.values(sim.st.drops ?? {}).find(d => d.id !== drop.id)); t += 0.5) g.step(0.5);
if (!drop2) throw Error('no second drop: ' + JSON.stringify(sim.st.piracy?.log));
for (let t = 0; t < 600 && raid2.plx?.phase !== 'collect'; t += 0.5) g.step(0.5);
for (let t = 0; t < 4; t += 0.5) g.step(0.5);
const truce2 = sim.st.piracy?.truces.find(t => t.id === drop2.id);
if (!truce2 || !truce2.pb?.includes(e3.id)) throw Error('second truce missing or escort not a party: ' + JSON.stringify(sim.st.piracy?.truces));
const out = process.argv[2] ?? 'p1321-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, drop: drop.id, raid: raid.id, spare: spare.id, target: target.id, raid2: raid2.id, drop2: drop2.id, convoy3: c3.id, escort3: e3.id, truce2: { until: truce2.until, now: sim.time }, log: sim.st.piracy?.log }));
console.log(JSON.stringify({ out, raid2: raid2.plx?.phase, status2: raid2.status, truce2, drop: drop.name, initial: drop.initial, lots: drop.lots, log: sim.st.piracy?.log.map(e => e.kind) }));
process.exit(0);
