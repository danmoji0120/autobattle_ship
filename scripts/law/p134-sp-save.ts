// P13.4 browser save: a single-player P13.4 world (real GameServer in-process, lawNew). The player's raid fleet
// extorted cargo next to Astra free port (a real case through the same API the piracy path uses, seen by the
// station); the world then runs until the real Astra patrol has flown out and is demanding a stop. A rival's hauler
// carrying the player's stolen goods was searched by guards in Rime (no customs station there): the goods are held on
// site and the player's hauler waits next to them. One more minor case was paid (closed record in the table).
//   npx vite-node scripts/law/p134-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import { hotKey, guardInspect } from '../../src/world/blackmarket';
import { lawCrime, lawPay } from '../../src/world/law';
import { sysAt } from '../../src/world/geom';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, lawNew: true } as any, 133);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '수배 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '수배 PMC';
if (sim.st.lawV !== 1) throw Error('not a P13.4 world');
for (const gr of Object.values(sim.st.groups)) if (gr.owner !== 'union') { for (const id of gr.shipIds) delete sim.st.ships[id]; delete sim.st.groups[gr.id]; }
for (const s of Object.values(sim.st.ships)) if (s.owner !== 'union') delete sim.st.ships[s.id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
sim.st.companies[co].credits = 5e6;
const rival = sim.addPlayer('피해 PMC');
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return gr; };
const A = sim.st.stations.astra;
// 1. a paid minor case (closed record): salvage seen at Astra, paid near the station
const old = fleet(co, '인양선', { x: A.pos.x + 2500, y: 0, z: A.pos.z + 1500 }, ['hauler']);
const c0 = lawCrime(sim, { kind: 'salvage', by: co, group: old.id, ship: old.shipIds[0], sys: 'astra', pos: sim.st.ships[old.shipIds[0]].pos, value: 4000, key: 'sp:salv' });
if (!c0?.known) throw Error('salvage case not known');
const pay = lawPay(sim, co, c0.id, undefined); if (typeof pay === 'string') throw Error(pay);
// 2. the raid: extortion next to Astra free port → wanted → the real patrol flies out and demands a stop
const raid = fleet(co, '항로 약탈대', { x: A.pos.x + 5000, y: 0, z: A.pos.z - 3000 }, ['destroyer', 'frigate', 'hauler']);
sim.st.ships[raid.shipIds[2]].cargo[hotKey('electronics', rival)] = 40;
const c1 = lawCrime(sim, { kind: 'extortion', by: co, group: raid.id, ship: raid.shipIds[0], victim: rival, sys: 'astra', pos: sim.st.ships[raid.shipIds[0]].pos, value: 30000, key: 'sp:ext' });
if (!c1?.known) throw Error('extortion not known');
let t = 0;
while (t < 900 && raid.lawStop?.phase !== 'demand') { g.step(0.5); t += 0.5; }
if (raid.lawStop?.phase !== 'demand') throw Error('no stop demand ' + JSON.stringify(raid.lawStop));
// 3. on-site hold in Rime (no customs station there): the guards searched a rival hauler carrying the player's goods
const R = sim.st.systems.rime;
const rp = { x: R.origin.x + 2000, y: 0, z: R.origin.z + 1000 };
const rv = fleet(rival, '피해 PMC 화물선', rp, ['hauler']); const rs = sim.st.ships[rv.shipIds[0]]; rs.cargo[hotKey('alloy', co)] = 60;
const n = guardInspect(sim, rs, R, 'sp-rime');
if (n !== 60) throw Error('rime inspection seized ' + n);
const lot = (sim.st.companies[co].bm?.customs ?? []).find(l => !l.station);
if (!lot) throw Error('no on-site lot ' + JSON.stringify(sim.st.companies[co].bm?.customs));
const col = fleet(co, '인수 화물선', { x: lot.pos!.x + 800, y: 0, z: lot.pos!.z }, ['hauler']);
// keep the stop demand open while the save is taken
const out = { save: JSON.parse(g.saveText()), token: tok, me: co, raid: raid.id, collector: col.id, lot: lot.id, rime: R.id, sysOfRaid: sysAt(sim.st.systems, sim.st.ships[raid.shipIds[0]].pos)?.id, demandIn: Math.round((raid.lawStop!.answerBy ?? 0) - sim.st.time), law: sim.st.companies[co].law };
writeFileSync(process.argv[2] ?? 'p134-sp.json', JSON.stringify(out));
console.log(JSON.stringify({ me: co, raid: raid.id, stop: raid.lawStop, lot, law: out.law && { level: out.law.level, unpaid: out.law.unpaid, cases: out.law.cases.length } }));
process.exit(0);
