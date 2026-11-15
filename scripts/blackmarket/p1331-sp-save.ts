// P13.3.1 browser save: a single-player P13.3 world (real GameServer in-process). A rival's hauler carried the
// player's goods (stolen from the player) and was caught by a dock inspection at Helios: the goods wait at Helios
// customs for the player, whose hauler is docked there. A second lot waits at Helios. The player's raid
// fleet runs a lane raid without knowing any black market (the panel must say why it picks no target).
//   npx vite-node scripts/blackmarket/p1331-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import { BM, hotKey } from '../../src/world/blackmarket';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, blackMarketNew: true } as any, 133);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '운송 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '운송 PMC';
if (sim.st.blackMarketV !== 1) throw Error('not a P13.3 world');
for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
const rival = sim.addPlayer('약탈 PMC');
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return gr; };
const H = sim.st.stations.astra, O = sim.st.stations.helios;   // the player docks only at Astra (Helios hosts a black market it must not find)
sim.st.companies[co].credits = 5e6;
// the rival's haulers carrying the player's stolen goods are caught docking (certain catch for this setup)
const base = { ...BM }; BM.dockBase = 10; BM.maxChance = 1;
for (const [st, item, n] of [[H, 'alloy', 120], [O, 'electronics', 40]] as const) {
  const r = fleet(rival, '약탈 운반선', { x: st.pos.x + 300, y: 0, z: st.pos.z }, ['hauler']);
  const s = sim.st.ships[r.shipIds[0]]; s.cargo[hotKey(item, co)] = n; sim.dockShip(s, st);
}
Object.assign(BM, base);
if ((sim.st.companies[co].bm?.customs ?? []).length !== 2) throw Error('no customs lots ' + JSON.stringify(sim.st.companies[co].bm));
// the player's hauler docked at Astra (claims) — part of its hold already used
const mine = fleet(co, '인수 화물선', { x: H.pos.x + 300, y: 0, z: H.pos.z - 200 }, ['hauler']);
const ms = sim.st.ships[mine.shipIds[0]]; ms.cargo.ore = 100; sim.dockShip(ms, H);
// a lane raid without any known black market (target: the rival's loaded hauler on the lane)
if (sim.command(co, { c: 'stance', target: rival, v: -1 } as any)) throw Error('stance');
const lane = { x: H.pos.x + 9000, y: 0, z: H.pos.z - 9000 };
const v = fleet(rival, '약탈 PMC 화물선', { x: lane.x + 1500, y: 0, z: lane.z }, ['hauler']); sim.st.ships[v.shipIds[0]].cargo.alloy = 300;
sim.command(rival, { c: 'setOp', group: v.id, op: { k: 'move', to: { x: lane.x - 6000, y: 0, z: lane.z } } } as any);
const raid = fleet(co, '항로 약탈대', { x: lane.x, y: 0, z: lane.z + 2500 }, ['destroyer', 'frigate']);
const e = sim.command(co, { c: 'setOp', group: raid.id, op: { k: 'plunder', at: lane, radius: 3000, policy: 'nonlethal' } } as any); if (e) throw Error(e);
for (let t = 0; t < 20 && !raid.plx?.why; t += 0.5) g.step(0.5);
if (!raid.plx?.why?.includes('암시장 미발견')) throw Error('raid reason ' + raid.plx?.why);
const out = process.argv[2] ?? 'p1331-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, rival, station: H.id, other: O.id, ship: ms.id, raid: raid.id, hold: { free: 0 } }));
console.log(JSON.stringify({ out, lots: sim.st.companies[co].bm?.customs, why: raid.plx.why }));
process.exit(0);
