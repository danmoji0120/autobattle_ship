// Migration rehearsal (file storage): run a server build against a save file, print its migration log,
// stop it cleanly and summarise the saved file. Used for every save-affecting growth phase:
//   node scripts/rehearse-file.mjs <server.mjs> <world.json> [apply|econ]   (econ: ECON_MIGRATE=apply, value-chain pricing)
// Typical sequence (docs/GROWTH_PLAN.md §6): new build dry run → apply → previous build on the result
// (code rollback) → new build again (roll forward) → copy the backup over world.json (data rollback).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [bin, file, mode] = process.argv.slice(2);
const env = { ...process.env, PORT: '8391', SAVE_FILE: file, DATABASE_URL: '', CONTENT_MIGRATE: mode === 'apply' ? 'apply' : '', ECON_MIGRATE: mode === 'econ' ? 'apply' : '' };
const p = spawn('node', [bin], { env });
let out = '';
p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
const t0 = Date.now();
while (!/listening/.test(out) && Date.now() - t0 < 30000 && p.exitCode === null) await new Promise(r => setTimeout(r, 100));
await new Promise(r => setTimeout(r, 1500));
p.kill('SIGTERM'); await new Promise(r => p.on('exit', r));
for (const l of out.split('\n')) if (/migration|backup|DRY|census|!!!|restored|created|accounts:|econ/.test(l)) console.log('  ' + l.slice(0, 400));
const w = JSON.parse(fs.readFileSync(file, 'utf8')).world;
const ships = Object.values(w.ships);
console.log(`  → file: contentV=${w.contentV} · econ ${w.econ ? `v${w.econ.v} ${w.econ.how} eq=${w.econ.eq} alloyDirect=${w.econ.alloyDirect}` : 'off'} · econLog ${(w.econLog ?? []).map(r => r.how).join(',') || '-'} · ships ${ships.length} · with hull ${ships.filter(s => s.hull).length} · builds with hull ${Object.values(w.stations).flatMap(s => s.builds ?? []).filter(b => b.hull).length} · exit ${p.exitCode}`);
