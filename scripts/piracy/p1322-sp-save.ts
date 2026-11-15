// P13.2.2 browser save: a single-player P13.2 world with the player's raid group (2 destroyers + frigate), an idle
// 2-hauler group (for 약탈 회수 지원) and a hostile rival's laden hauler holding still 6 km away (for the lane-raid
// estimate line). Nothing is ordered yet: the browser gives every order through the UI.
//   npx vite-node scripts/piracy/p1322-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, piracyNew: true } as any, 1322);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '약탈 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '약탈 PMC';
if (sim.st.piracyV !== 1) throw Error('not a P13.2 world');
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
for (const sys of Object.values(sim.st.systems)) sys.security = 10;
const rival = sim.addPlayer('수송 PMC');
const a = sim.st.stations.astra;
const at = (dx: number, dz: number) => ({ x: a.pos.x + dx, y: 0, z: a.pos.z + dz });
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z }); if (cl === 'hauler') s.logisticsExcluded = true; }); return gr; };
sim.st.companies[co].credits = 5e6;
if (sim.command(co, { c: 'stance', target: rival, v: -1 } as any)) throw Error('stance');
const raid = fleet(co, '약탈대', at(10000, -24000), ['destroyer', 'destroyer', 'frigate']);
const tender = fleet(co, '회수 편대', at(10000, -25500), ['hauler', 'hauler']);
const victim = fleet(rival, '수송 화물선', at(16000, -24000), ['hauler']);
const h = sim.st.ships[victim.shipIds[0]]; h.cargo.metal = 300; h.cargo.electronics = 100; victim.piracyPolicy = 'survive';
for (let t = 0; t < 4; t += 0.5) g.step(0.5);
const out = process.argv[2] ?? 'p1322-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, raid: raid.id, tender: tender.id, victim: victim.id, victimPos: h.pos }));
console.log(JSON.stringify({ out, raid: raid.id, tender: tender.id, victim: victim.id }));
process.exit(0);
