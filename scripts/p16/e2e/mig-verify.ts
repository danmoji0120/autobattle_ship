// P16.6 §3 — existing-world migration check on a COPY of a pre-P16.6 save (made by mig-make.ts with the old code).
// The original file is never written: every step works on copies, and its sha256 is checked at the end.
//   1. in-process: new code loads the copy (B0) · migrateCarriers once (B1) · twice (B2, idempotent) → deep diff
//   2. every saved battle record re-simulates on the new code to the same digest as on the old code
//   3. real servers: new server + CARRIERS_P16_MIGRATE=1 (applied) → again (already applied) → old server on the
//      migrated save (forward/rollback compatibility) → old server on the original (restore = rollback)
// OLD=<old worktree> npx vite-node scripts/p16/e2e/mig-verify.ts <dir made by mig-make>
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WorldSim } from '../../../src/world/sim';
import { World } from '../../../src/sim/world';
import { migrateCarriers } from '../../../src/world/industrialGear';
import { CARRIER_MARKETS } from '../../../src/content/packs/growth/carrier';
import { Server, freePort, delay } from './harness';

const OLD = path.resolve(process.env.OLD ?? '');
const dir = path.resolve(process.argv[2] ?? 'mig16');
const orig = path.join(dir, 'original.json');
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const sha0 = sha(orig);
const out: Record<string, unknown> = { originalSha256: sha0 };
const checks: string[] = [];
function check(ok: unknown, label: string, extra?: unknown) { if (!ok) throw Error('FAIL ' + label + (extra ? ' ' + JSON.stringify(extra) : '')); checks.push(label); console.log('PASS', label, extra ? JSON.stringify(extra) : ''); }

/** every differing leaf path between two JSON values */
function diff(a: any, b: any, p = '', acc: string[] = []): string[] {
  if (a === b) return acc;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) { acc.push(p); return acc; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], p ? `${p}.${k}` : k, acc);
  return acc;
}
const file = JSON.parse(readFileSync(orig, 'utf8'));
const w0 = file.world;
// 1. in-process
const b0 = JSON.parse(new WorldSim(structuredClone(w0), { migrateContent: false }).serialize());
const loadDiff = diff(w0, b0);
out.loadOnlyDiff = loadDiff.slice(0, 40); out.loadOnlyDiffN = loadDiff.length;
const s1 = new WorldSim(structuredClone(w0), { migrateContent: false });
const r1 = migrateCarriers(s1.st);
const b1 = JSON.parse(s1.serialize());
const r2 = migrateCarriers(s1.st);
const b2 = JSON.parse(s1.serialize());
const d01 = diff(b0, b1);
const want = new Set(Object.entries(CARRIER_MARKETS).flatMap(([st, items]) => items.map(k => `stations.${st}.market.${k}`)));
check(r1.applied && r1.markets === want.size, '1: migrateCarriers applies once to the pre-P16.6 save', r1);
check(!r2.applied && r2.reason === '이미 적용됨' && diff(b1, b2).length === 0, '1: a second run changes nothing (idempotent)', r2);
const rows = new Set(d01.map(p => p.split('.').slice(0, 4).join('.')).filter(p => p.startsWith('stations.')));
const other = d01.filter(p => !p.startsWith('stations.') || !want.has(p.split('.').slice(0, 4).join('.')));
check(other.length === 1 && other[0] === 'carrierV' && [...rows].every(r => want.has(r)) && rows.size === want.size, '1: the only differences are the carrier market rows + carrierV', { rows: [...rows], other });
const sections = ['companies', 'ships', 'groups', 'battleLog', 'engagements', 'wrecks', 'contracts', 'commanders', 'blueprints', 'factions', 'systems'];
const same = Object.fromEntries(sections.filter(k => k in b0).map(k => [k, JSON.stringify(b0[k]) === JSON.stringify(b1[k])]));
const marketsBesides = Object.keys(b0.stations).every(id => Object.keys(b0.stations[id].market ?? {}).every(k => JSON.stringify(b0.stations[id].market[k]) === JSON.stringify(b1.stations[id].market?.[k])));
const storageSame = Object.keys(b0.stations).every(id => JSON.stringify(b0.stations[id].storage) === JSON.stringify(b1.stations[id].storage));
out.compare = { ...same, existingMarketRows: marketsBesides, storage: storageSame };
check(Object.values(same).every(Boolean) && marketsBesides && storageSame, '1: companies / ships / groups / blueprints / existing market rows / storage / battle records unchanged', out.compare);
const counts = (w: any) => ({ companies: Object.keys(w.companies).length, players: Object.values<any>(w.companies).filter(c => c.kind === 'player').length, ships: Object.keys(w.ships).length, groups: Object.keys(w.groups).length, battleLog: (w.battleLog ?? []).length, credits: Math.round(Object.values<any>(w.companies).reduce((a, c) => a + (c.credits ?? 0), 0)), marketRows: Object.values<any>(w.stations).reduce((a, s) => a + Object.keys(s.market ?? {}).length, 0), bpHeld: Object.values<any>(w.companies).reduce((a, c) => a + Object.keys(c.blueprints ?? {}).length, 0) });
out.counts = { before: counts(b0), after: counts(b1) };
console.log('counts', JSON.stringify(out.counts));

// 2. saved battle records: old-code replay digest == new-code replay digest
const { World: OldWorld } = await import(path.join(OLD, 'src/sim/world.ts'));
const replay = (W: any, rec: any) => { const w = new W(structuredClone(rec.setup)); w.scheduleReplay(structuredClone(rec.orders)); while (!w.outcome && w.tick < 30 * 1200) w.step(); return { d: w.digest(), tick: w.tick, winner: w.outcome?.winner ?? null }; };
const recs = b1.battleLog ?? [];
const rep = recs.map((r: any) => { const o = replay(OldWorld, r), n = replay(World, r); return { id: r.id, rules: r.setup.rules ?? 0, same: o.d === n.d && o.tick === n.tick, tick: n.tick, recWinner: r.winner, replayWinner: n.winner }; });
out.replays = rep;
check(recs.length > 0 && rep.every((x: any) => x.same), `2: all ${recs.length} saved battle records re-simulate identically on old and new code`, { rules: [...new Set(rep.map((x: any) => x.rules))] });

// 3. real servers on copies
const port = await freePort();
const copy = path.join(dir, 'migrated.json');
copyFileSync(orig, copy);
// a published (non-development) build refuses the migration flag outright — production stays untouched
{ const psrv = new Server(port, copy, undefined, { NODE_ENV: 'production', P16_DEV_CARRIER_RELEASE: '' });
  let refused = '';
  try { await psrv.start({ CARRIERS_P16_MIGRATE: '1' }); await psrv.stop(); } catch (e) { refused = String(e); }
  check(refused.includes('운영 마이그레이션 미승인') && sha(copy) === sha0, '3: a production-mode server refuses CARRIERS_P16_MIGRATE=1 and does not touch the save', refused.split('\n').find(l => l.includes('P16'))); }
const nsrv = new Server(port, copy, undefined, { NODE_ENV: 'development', P16_DEV_CARRIER_RELEASE: '1' });
await nsrv.start({ CARRIERS_P16_MIGRATE: '1' });
const l1 = nsrv.log.split('\n').find(l => l.includes('P16 항모'));
await delay(1500); await nsrv.stop();
check(l1?.includes('적용 — 시장 10행'), '3: new server with CARRIERS_P16_MIGRATE=1 applies it', l1);
const mig = JSON.parse(readFileSync(copy, 'utf8'));
check(mig.world.carrierV === 1 && Object.keys(mig.accounts ?? {}).length === Object.keys(file.accounts ?? {}).length && JSON.stringify(Object.keys(mig.auth ?? {})) === JSON.stringify(Object.keys(file.auth ?? {})), '3: migrated save keeps accounts and logins', { accounts: Object.keys(mig.accounts ?? {}).length });
await nsrv.start({ CARRIERS_P16_MIGRATE: '1' });
const l2 = nsrv.log.split('\n').find(l => l.includes('P16 항모'));
await delay(1000); await nsrv.stop();
check(l2?.includes('건너뜀 — 이미 적용됨'), '3: restart with the flag still set: skipped (already applied)', l2);
// old server on the migrated save: does a rollback of the *code* alone work?
const osrv = new Server(port, copy, path.join(OLD, 'dist-server/server.mjs'));
let oldOnMigrated = 'ok';
try { await osrv.start(); await delay(1500); await osrv.stop(); } catch (e) { oldOnMigrated = String(e).slice(0, 300); }
out.oldServerOnMigrated = oldOnMigrated;
const after = JSON.parse(readFileSync(copy, 'utf8')).world;
out.oldServerKeepsRows = Object.entries(CARRIER_MARKETS).every(([st, items]) => items.every(k => after.stations[st]?.market?.[k]));
console.log('old server on migrated save:', oldOnMigrated, 'carrier rows kept:', out.oldServerKeepsRows);
// rollback = restore the original file; the old server must start on it
const restored = path.join(dir, 'restored.json');
copyFileSync(orig, restored);
const rsrv = new Server(port, restored, path.join(OLD, 'dist-server/server.mjs'));
await rsrv.start(); await delay(1500); await rsrv.stop();
check(JSON.parse(readFileSync(restored, 'utf8')).world.carrierV === undefined, '3: rollback — the old server runs on the restored original (no carrierV, no carrier rows)');
check(sha(orig) === sha0, '3: the original save file was never modified', { sha256: sha0 });
writeFileSync(path.join(dir, 'verify.json'), JSON.stringify({ checks, ...out }, null, 1));
console.log(`ALL ${checks.length} CHECKS PASSED`);
