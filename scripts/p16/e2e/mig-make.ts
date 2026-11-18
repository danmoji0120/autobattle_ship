// P16.6 §3 — make a *pre-P16.6* world save to migrate (stand-in for a copy of the production save, which is not
// available in the development environment). Everything is done by the OLD code (commit 15de811):
//   1. the old server binary creates a standard world and three real accounts (createPmc backgrounds);
//   2. with that server stopped, the old WorldSim advances the world N hours (NPC economy, NPC battles → battleLog);
//   3. the old server starts on the result once (it must load it) and saves it again.
// OLD=<old worktree> npx vite-node scripts/p16/e2e/mig-make.ts <outDir> [hours]
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Server, Pilot, freePort, delay } from './harness';

const OLD = path.resolve(process.env.OLD ?? '');
const out = path.resolve(process.argv[2] ?? 'mig16'), hours = Number(process.argv[3] ?? 6);
mkdirSync(out, { recursive: true });
const save = path.join(out, 'world.json');
const { WorldSim } = await import(path.join(OLD, 'src/world/sim.ts'));
const srv = new Server(await freePort(), save, path.join(OLD, 'dist-server/server.mjs'), { WORLD_SEED: '9466' });
await srv.start();
const pilots = [new Pilot(srv, 'Old 운송 PMC', 'hauler'), new Pilot(srv, 'Old 경비 PMC', 'security'), new Pilot(srv, 'Old 인양 PMC', 'salvager')];
for (const [i, p] of pilots.entries()) { await p.signup(`p166_old_${i}`); await p.connect(); }
// a few ordinary commands of a running world on the old server
const s = pilots[0].snap();
const g = Object.values<any>(s.groups).find(x => x.owner === pilots[0].id);
console.log('old server: companies', Object.keys(s.companies).length, 'BATTLE carriers market rows', JSON.stringify(Object.values<any>(s.stations).flatMap(st => Object.keys(st.market?.stock ?? {})).filter(k => k.startsWith('eq_wing') || k === 'cpu_carrier')));
if (g) console.log('hauler group', g.id, await pilots[0].command({ c: 'setOp', group: g.id, op: { k: 'idle' } }));
await delay(3000);
await srv.stop();
const file = JSON.parse(readFileSync(save, 'utf8'));
const sim = new WorldSim(file.world, { migrateContent: false });
const t0 = sim.time;
for (let t = 0; t < hours * 3600; t += 0.5) sim.update(0.5);
file.world = JSON.parse(sim.serialize());
writeFileSync(save, JSON.stringify(file));
console.log('advanced', (sim.time - t0) / 3600, 'h; battleLog', sim.st.battleLog?.length ?? 0, 'engagements', Object.keys(sim.st.engagements ?? {}).length);
await srv.start();
await delay(2500);
await srv.stop();
const lines = srv.log.split('\n').filter(l => l.includes('[siderarium]')).slice(0, 12);
console.log(lines.join('\n'));
copyFileSync(save, path.join(out, 'original.json'));
console.log('original sha256', createHash('sha256').update(readFileSync(path.join(out, 'original.json'))).digest('hex'));
