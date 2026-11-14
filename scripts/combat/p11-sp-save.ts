// Builds a single-player save holding a running P11 battle (A vs B, C joined for A, D hostile to all) so the
// browser check can open the real battle HUD from the viewer's own perspective. Output: JSON {save, token}.
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import type { V } from '../../src/world/types';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, combatNew: true } as any, 21);
const toks: Record<string, string> = {}, cos: Record<string, string> = {};
for (const id of ['a', 'b', 'c', 'd', 'e']) {
  const conn: Conn = { id, lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { cos[id] = m.company; toks[id] = m.token; } }, sendText: () => {} };
  g.connect(conn); g.handle(id, { t: 'hello', name: `PMC ${id.toUpperCase()}`, proto: SYNC_PROTO } as any);
}
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(x => cos[x]);
const names: Record<string, string> = { [A]: '알파 PMC', [B]: '브라보 PMC', [C]: '찰리 PMC', [D]: '델타 PMC' };
for (const [co, n] of Object.entries(names)) g.sim.st.companies[co].name = n;
let seq = 1;
const cmd = (id: string, c: any) => g.handle(id, { t: 'cmd', id: seq++, cmd: c } as any);
const FAR: V = { x: 640000, y: 0, z: 640000 };
function fleet(owner: string, pos: V, comp: string[]) {
  const grp = g.sim.newGroup(owner, `${names[owner]} 편대`);
  const c = g.sim.newCommander(owner, 2); grp.commanderId = c.id;
  comp.forEach((cl, i) => g.sim.spawnShip(owner, cl, 'std', grp.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return grp;
}
const ga = fleet(A, FAR, ['destroyer', 'destroyer', 'frigate']);
fleet(B, { ...FAR, x: FAR.x + 350 }, ['destroyer', 'frigate', 'frigate']);
cmd('a', { c: 'stance', target: B, v: -1 }); cmd('a', { c: 'stance', target: C, v: 1 });
cmd('c', { c: 'stance', target: A, v: 1 }); cmd('c', { c: 'stance', target: B, v: -1 });
for (const x of [A, B, C]) cmd('d', { c: 'stance', target: x, v: -1 });
const step = (s: number) => { for (let t = 0; t < s; t += 0.25) g.step(0.25); };
for (let i = 0; i < 120 && !g.sim.st.ships[ga.shipIds[0]].engagement; i++) step(0.25);
const id = g.sim.st.ships[ga.shipIds[0]].engagement!;
const e = g.sim.st.engagements[id];
step(3);
fleet(C, { x: e.pos.x - 1300, y: 0, z: e.pos.z + 200 }, ['destroyer', 'frigate']);
step(2);
fleet(D, { x: e.pos.x + 200, y: 0, z: e.pos.z - 1400 }, ['destroyer', 'destroyer']);
step(2);
if (e.sides.length !== 4) throw Error(`expected 4 sides, got ${e.sides.length}`);
const out = process.argv[2] ?? 'p11-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: toks.a, specToken: toks.e, eng: id, me: A, companies: names }));
console.log(JSON.stringify({ out, eng: id, sides: e.sides.map(s => names[s[0]] ?? s[0]) }));
process.exit(0);
