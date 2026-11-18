// P16.3: check of the carrier gear market migration PREPARATION for existing saves (CARRIERS_P16_MIGRATE=1).
// Not run on any production world. Loads a save (or builds a standard world), runs everything on COPIES:
//   1. server start-up with the flag while the carrier is a preview → refused, world identical to a plain load
//   2. migrateCarriers with the release override (simulates the post-release content) → only carrier market rows
//      and the carrierV marker change
//   3. second run is a no-op; a pre-growth (c2) world is refused
//   4. the migrated world keeps running
// The input file is never written.
//   npx vite-node scripts/p16/carrier-migrate-check.ts -- [save.json]
// Production procedure (NOT run; only after carriers are released): back up the save, start the server once with
// CARRIERS_P16_MIGRATE=1, check the log line "[siderarium] P16 항모 장비 판매: 적용 — 시장 N행", remove the variable.
import { readFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { GameServer } from '../../src/server/core';
import type { SaveFile } from '../../src/server/protocol';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { migrateCarriers } from '../../src/world/industrialGear';
import { CARRIER_MARKETS } from '../../src/content/packs/growth/carrier';

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

function standardSave(): SaveFile {
  const sim = WorldSim.create(1631, STANDARD_WORLD);
  sim.addPlayer('항모 이전 검사');
  for (let i = 0; i < 400; i++) sim.update(0.25);
  const ids = new Set(Object.values(CARRIER_MARKETS).flat());
  check(!sim.st.carrierV && !Object.values(sim.st.stations).some(s => s.market && Object.keys(s.market).some(k => ids.has(k))), 'standard world has no carrier gear rows');
  return { v: 1, world: JSON.parse(sim.serialize()), auth: {} };
}

const file = process.argv.slice(2).find(a => a.endsWith('.json'));
const save: SaveFile = file ? JSON.parse(readFileSync(file, 'utf8')) : standardSave();
const before = JSON.parse(JSON.stringify(save.world));
const opts = { singleplayer: false, accounts: true, snapInterval: 1, migrateContent: false, migrateEcon: false } as const;

// 1. the flag while carriers are a preview: refused, nothing changes
const plain = new GameServer(JSON.parse(JSON.stringify(save)), { ...opts }, 1);
const flagged = new GameServer(JSON.parse(JSON.stringify(save)), { ...opts, carrierMigrate: true }, 1);
const ref = JSON.parse(plain.sim.serialize());
check(diff(ref, JSON.parse(flagged.sim.serialize())).length === 0 && !flagged.sim.st.carrierV, 'preview: flag refused, world identical');
{ const r = migrateCarriers(structuredClone(before)); check(!r.applied && /미공개/.test(r.reason ?? ''), 'preview refusal reason', r); }

// 2. after release (override): only carrier market rows + carrierV
const st = flagged.sim.st;
const r = migrateCarriers(st, { released: true });
const after = JSON.parse(flagged.sim.serialize());
const d = diff(ref, after);
const ids = new Set(Object.values(CARRIER_MARKETS).flat());
const allowed = (p: string) => p === '.carrierV' || (/^\.stations\.[^.]+\.market\.[a-z_]+$/.test(p) && ids.has(p.split('.')[4]));
check(r.applied && d.length > 0 && d.every(allowed), 'only carrier market rows and carrierV changed', { r, changed: d.length, other: d.filter(p => !allowed(p)).slice(0, 10) });
const rows = d.filter(p => p.includes('.market.'));
const expected = Object.entries(CARRIER_MARKETS).filter(([sid]) => before.stations[sid]?.public && before.stations[sid]?.market).reduce((n, [, l]) => n + l.length, 0);
check(rows.length === expected && r.markets === expected, 'every listed public station got its rows', { rows: rows.length, expected });
for (const p of rows.slice(0, 3)) { const [, , sid, , id] = p.split('.'); const m = after.stations[sid].market[id]; check(m.stock > 0 && m.target > 0 && m.base > 0, `row ${sid}/${id} has stock and price`, m); }
check(JSON.stringify(save.world) === JSON.stringify(before), 'input save object untouched');

// 3. idempotent, pre-growth refused
const again = migrateCarriers(st, { released: true });
check(!again.applied && again.reason === '이미 적용됨', 'second run is a no-op', again);
const c2 = structuredClone(before); c2.contentV = 2;
{ const x = migrateCarriers(c2, { released: true }); check(!x.applied && !c2.carrierV, 'pre-growth (c2) world refused', x); }

// 4. runs on
for (let i = 0; i < 240; i++) flagged.sim.update(0.25);
check(flagged.sim.st.carrierV === 1, 'migrated world runs on', { time: Math.round(flagged.sim.time) });

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
