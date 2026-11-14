// Builds a single-player P12 save (FLEET_OPS_P12 world) for the browser check: 알파 PMC's guard fleet is out in
// space on an area-defence order near Astra. Output: JSON {save, token, me, group}.
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, opsNew: true } as any, 23);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '알파 PMC', proto: SYNC_PROTO } as any);
g.sim.st.companies[co].name = '알파 PMC';
const guard = Object.values(g.sim.st.groups).find(x => x.owner === co && x.shipIds.some(id => g.sim.st.ships[id].classId === 'destroyer'))!;
const astra = g.sim.st.stations.astra.pos;
const at = { x: astra.x + 6000, y: 0, z: astra.z + 4000 };
const err = g.sim.command(co, { c: 'setOp', group: guard.id, op: { k: 'defend', at, radius: 2500 } } as any);
if (err) throw Error(err);
for (let t = 0; t < 90; t += 0.25) g.step(0.25);
if (g.sim.st.opsV !== 1 || guard.opx?.phase !== 'hold') throw Error(`not holding: ${guard.opx?.phase} ${guard.status}`);
const out = process.argv[2] ?? 'p12-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, group: guard.id }));
console.log(JSON.stringify({ out, group: guard.id, status: guard.status }));
process.exit(0);
