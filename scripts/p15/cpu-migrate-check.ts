// P15.1.1: check of the combat-computer market migration for EXISTING saves (COMPUTERS_P151_MIGRATE=1).
// Loads a save (or builds a legacy standard world without computers), runs the server start-up migration on
// a COPY and verifies that only the computer market rows and the cpuV marker were added; then that a second
// start is a no-op, a pre-growth (c2) world is refused, and the migrated world keeps running. The input file is
// never written.
//   npx vite-node scripts/p15/cpu-migrate-check.ts -- [save.json]
// Production procedure (NOT run here): back up the save, start the server once with COMPUTERS_P151_MIGRATE=1,
// check the log line "[siderarium] P15.1 전투 컴퓨터 판매: 적용 — 시장 N행", then remove the variable.
import { readFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { GameServer } from '../../src/server/core';
import type { SaveFile } from '../../src/server/protocol';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { migrateComputers } from '../../src/world/industrialGear';
import { CPU_MARKETS } from '../../src/content/packs/growth/computers';

let fail = 0;
const check = (ok: unknown, label: string, extra?: unknown) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', label, extra === undefined ? '' : JSON.stringify(extra)); };

function diff(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (out.length > 200) return out;
  if (a === b) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) { out.push(path || '(root)'); return out; }
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  return out;
}

function legacySave(): SaveFile {
  const { computers: _skip, ...legacy } = STANDARD_WORLD;
  const sim = WorldSim.create(1511, legacy);
  const p = sim.addPlayer('이전 검사');
  for (let i = 0; i < 400; i++) sim.update(0.25);
  check(!sim.st.cpuV && !Object.values(sim.st.stations).some(s => s.market && Object.keys(s.market).some(k => k.startsWith('cpu_'))), 'legacy world has no computer rows', { player: p });
  return { v: 1, world: JSON.parse(sim.serialize()), auth: {} };
}

const file = process.argv.slice(2).find(a => a.endsWith('.json'));
const save: SaveFile = file ? JSON.parse(readFileSync(file, 'utf8')) : legacySave();
const before = JSON.parse(JSON.stringify(save.world));
const opts = { singleplayer: false, accounts: true, snapInterval: 1, migrateContent: false, migrateEcon: false } as const;

// 1. without the flag nothing changes
const plain = new GameServer(JSON.parse(JSON.stringify(save)), { ...opts }, 1);
check(!plain.sim.st.cpuV, 'no flag: no migration');

// 2. with the flag: only computer market rows + cpuV
const srv = new GameServer(JSON.parse(JSON.stringify(save)), { ...opts, cpuMigrate: true }, 1);
const after = JSON.parse(srv.sim.serialize());
const ref = JSON.parse(plain.sim.serialize());   // same load path without migration (normalisation on load excluded)
const d = diff(ref, after);
const allowed = (p: string) => p === '.cpuV' || /^\.stations\.[^.]+\.market\.cpu_[a-z]+$/.test(p);
check(d.length > 0 && d.every(allowed), 'only computer market rows and cpuV changed', { changed: d.length, other: d.filter(p => !allowed(p)).slice(0, 10) });
const rows = d.filter(p => p.includes('.market.cpu_'));
const expected = Object.entries(CPU_MARKETS).filter(([sid]) => before.stations[sid]?.public && before.stations[sid]?.market).reduce((n, [, ids]) => n + ids.length, 0);
check(rows.length === expected, 'every listed public station got its rows', { rows: rows.length, expected });
for (const p of rows.slice(0, 3)) { const [, , sid, , id] = p.split('.'); const r = after.stations[sid].market[id]; check(r.stock > 0 && r.target > 0 && r.base > 0, `row ${sid}/${id} has stock and price`, r); }
check(JSON.stringify(save.world) === JSON.stringify(before), 'input save object untouched');

// 3. idempotent and refused for pre-growth worlds
const again = migrateComputers(srv.sim.st);
check(!again.applied && again.reason === '이미 적용됨', 'second run is a no-op', again);
const c2 = structuredClone(before); c2.contentV = 2; delete c2.cpuV;
{ const r = migrateComputers(c2); check(!r.applied && !c2.cpuV, 'pre-growth (c2) world refused', r); }

// 4. the migrated world keeps running
for (let i = 0; i < 240; i++) srv.sim.update(0.25);
check(srv.sim.st.cpuV === 1, 'migrated world runs on', { time: Math.round(srv.sim.time) });

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
