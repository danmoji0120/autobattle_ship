// Builds a single-player P12.5 save (AUTO_LOGISTICS_P125 world) for the browser check: 알파 PMC owns stations
// A/B/C (§19 fixture), five unregistered haulers at A, and has ordered a battleship at C, so automatic
// shipments are in flight when the client loads. Output: JSON {save, token, me, haulers}.
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import { WorldSim } from '../../src/world/sim';
import { buildNeeds } from '../../src/world/production';
import { p125Fixture, stockFor, BB } from './p125-fixture';

const g = new GameServer(null, { singleplayer: true, snapInterval: 1, logisticsNew: true } as any, 31);
let tok = '', co = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') { co = m.company; tok = m.token; } }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '알파 PMC', proto: SYNC_PROTO } as any);
const sim = g.sim; sim.st.companies[co].name = '알파 PMC';
if (sim.st.logisticsV !== 1) throw Error('not a P12.5 world');
const fx = p125Fixture(sim, co);
const probe = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
if (probe.command(co, { c: 'buildShip', station: fx.C.id, ...BB } as any)) throw Error('probe build');
const pb = probe.st.stations[fx.C.id].builds![0];
stockFor(sim, co, buildNeeds(pb.classId, pb.loadoutId, pb.fit, pb), fx.A, fx.B);
const err = sim.command(co, { c: 'buildShip', station: fx.C.id, ...BB } as any); if (err) throw Error(err);
for (let t = 0; t < 40; t += 0.25) g.step(0.25);
const live = Object.values(sim.st.logisticsJobs ?? {}).filter(j => j.owner === co && j.ship);
if (live.length < 5) throw Error(`only ${live.length} shipments assigned`);
const out = process.argv[2] ?? 'p125-sp-save.json';
writeFileSync(out, JSON.stringify({ save: JSON.parse(g.saveText()), token: tok, me: co, haulers: fx.haulers.map(s => s.id), escort: fx.escort.id }));
console.log(JSON.stringify({ out, shipments: live.length }));
process.exit(0);
