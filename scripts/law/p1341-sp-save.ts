// P13.4.1 browser save: a single-player P13.4 world (real GameServer in-process, lawNew) with every case status the
// finance tab's law record shows:
//   - 단속 완료·미납 있음: a smuggling case from a real guard inspection (guardInspect) of the player's hauler next to
//     Helios shipyard — stolen electronics + heavy cannons seized, 1,000 cr collected at once (all the player had),
//     the rest owed to Helios; afterwards the player earns 60,000 cr (set directly) so it can pay now
//   - 종결: a salvage case seen at Helios and paid
//   - 단속 전: a known extortion case in Astra (no stop yet)
// The hauler stays within 4 km of Helios, so the creditor takes the payment there.
//   npx vite-node scripts/law/p1341-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import { hotKey, guardInspect } from '../../src/world/blackmarket';
import { lawCrime, lawPay } from '../../src/world/law';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, lawNew: true } as any, 133);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '밀수 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '밀수 PMC';
if (sim.st.lawV !== 1) throw Error('not a P13.4 world');
for (const gr of Object.values(sim.st.groups)) if (gr.owner !== 'union') { for (const id of gr.shipIds) delete sim.st.ships[id]; delete sim.st.groups[gr.id]; }
for (const s of Object.values(sim.st.ships)) if (s.owner !== 'union') delete sim.st.ships[s.id];
for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
const rival = sim.addPlayer('원소유 PMC');
const fleet = (o: string, name: string, pos: any, comp: string[]) => { const gr = sim.newGroup(o, name); gr.commanderId = sim.newCommander(o, 2).id; comp.forEach((cl, i) => { const s = sim.spawnShip(o, cl, 'std', gr.id, { x: pos.x + i * 40, y: 0, z: pos.z }); s.logisticsExcluded = true; }); return gr; };
const HE = sim.st.stations.helios, AS = sim.st.stations.astra;
sim.st.companies[co].credits = 5e6;
// 종결: salvage seen at Helios, paid
const old = fleet(co, '인양선', { x: HE.pos.x + 2500, y: 0, z: HE.pos.z + 1500 }, ['hauler']);
const c0 = lawCrime(sim, { kind: 'salvage', by: co, group: old.id, ship: old.shipIds[0], sys: 'helios', pos: sim.st.ships[old.shipIds[0]].pos, value: 4000, key: 'sp:salv' });
if (!c0?.known) throw Error('salvage case not known');
const p0 = lawPay(sim, co, c0.id, undefined); if (typeof p0 === 'string') throw Error(p0);
// 단속 완료·미납 있음: inspection with only 1,000 cr
sim.st.companies[co].credits = 1000;
const smug = fleet(co, '밀수 화물선', { x: HE.pos.x + 2500, y: 0, z: HE.pos.z - 1500 }, ['hauler']);
const ss = sim.st.ships[smug.shipIds[0]];
ss.cargo = { [hotKey('electronics', rival)]: 40, eq_heavy_cannon: 2, mod_ecm: 3, ore: 30 };
const n = guardInspect(sim, ss, sim.st.systems.helios, 'sp-insp', HE);
const sc = Object.values(sim.st.law!.cases).find(c => c.kind === 'smuggling' && c.by === co);
if (!sc || !n || sc.paid !== 1000 || sc.fine <= 1000 || sc.state !== 'open') throw Error('smuggling case ' + JSON.stringify(sc));
// 단속 전: extortion seen at Astra
const raid = fleet(co, '항로 약탈대', { x: AS.pos.x + 5000, y: 0, z: AS.pos.z - 3000 }, ['frigate']);
const c2 = lawCrime(sim, { kind: 'extortion', by: co, group: raid.id, ship: raid.shipIds[0], victim: rival, sys: 'astra', pos: sim.st.ships[raid.shipIds[0]].pos, value: 30000, key: 'sp:ext', how: 'station' });
if (!c2?.known) throw Error('extortion not known');
sim.st.companies[co].credits = 60000;
g.step(0.5);
const out = { save: JSON.parse(g.saveText()), token: tok, me: co, rival, smug: sc.id, smugFine: sc.fine, salv: c0.id, ext: c2.id, creditor: sc.creditor, law: sim.st.companies[co].law };
writeFileSync(process.argv[2] ?? 'p1341-sp.json', JSON.stringify(out));
console.log(JSON.stringify({ me: co, smug: { fine: sc.fine, paid: sc.paid, creditor: sc.creditor, seized: n }, law: out.law && { unpaid: out.law.unpaid, fined: out.law.fined, paid: out.law.paid, cases: out.law.cases.map(c => `${c.kind}:${c.state}:${c.served ?? ''}`) } }));
process.exit(0);
