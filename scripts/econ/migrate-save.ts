// Value-chain econ migration rehearsal on DEVELOPMENT save copies (never a production save).
//   npx vite-node scripts/econ/migrate-save.ts -- make <out.json> [seed]   build a busy dev c4 save
//   npx vite-node scripts/econ/migrate-save.ts -- rehearse <save.json> <outdir>
//   npx vite-node scripts/econ/migrate-save.ts -- rollback <migrated.json> <out.json>   econ rollback of a (dev) save file
// `rehearse` never touches its input: it copies it, records sha256, then on the copy runs exactly the
// transform the server runs (node.ts: census → new WorldSim(…, {migrateEcon}) → census → round trip),
// checks idempotency, the changed-path set, running jobs, a post-migration run, and both rollbacks
// (econ rollback on the migrated save; data rollback = the verified backup copy).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorldSim } from '../../src/world/sim';
import { census, compareCensus } from '../../src/world/migrate';
import { migrateEconChain, rollbackEconChain } from '../../src/world/econMigrate';
import { CONTENT } from '../../src/content/registry';
import { recipeFor } from '../../src/world/industry';
import type { Station, WorldState } from '../../src/world/types';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const step = (sim: WorldSim, s: number) => { for (let t = 0; t < s; t += .25) sim.update(.25); };
const must = (e: string | null, what: string) => { if (e) throw new Error(`${what}: ${e}`); };

function make(out: string, seed: number) {
  const sim = WorldSim.create(seed);
  const p = sim.addPlayer('이관 리허설 A'), q = sim.addPlayer('이관 리허설 B');
  const co = sim.st.companies[p]; co.credits = 3e6; sim.st.companies[q].credits = 8e5;
  const a = sim.st.stations.astra;
  const home: Station = { ...structuredClone(a), id: 'reh_home', name: '리허설 공장', public: false, owner: p, pos: { ...a.pos, x: a.pos.x + 650 }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: { ore: 6000, metal: 120 } }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'power', 'refinery', 'logistics', 'warehouse', 'warehouse', 'yard_s'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[home.id] = home;
  const pool = sim.newGroup(p, '공용 수송');
  const haulers = Array.from({ length: 3 }, () => { const s = sim.spawnShip(p, 'hauler', 'std', pool.id, a.pos); (sim as any).dockShip(s, a); return s; });
  must(sim.command(p, { c: 'poolShips', ships: haulers.map(s => s.id), on: true }), 'pool');
  // a running batch on the direct alloy recipe (keeps its terms through the migration)
  must(sim.command(p, { c: 'prodOrder', station: home.id, recipe: 'alloy_direct', mode: 'count', n: 40 }), 'prodOrder');
  // goals with budgets and approved unit prices, a recurring trade, a player listing, a warship bought from a yard
  const ask = (k: string) => sim.price(a, k, 'buy');
  must(sim.command(p, { c: 'workCreate', goal: { k: 'stockpile', station: home.id, item: 'electronics', target: 80, maintain: true, buy: true, produce: false }, budget: 200_000, maxPrice: Math.ceil(ask('electronics') * 1.15) }), 'stockpile');
  must(sim.command(p, { c: 'workCreate', goal: { k: 'trade', item: 'machinery', from: 'astra', to: 'cinderco', amount: 60, maxBuy: ask('machinery') * 1.3, minSell: 0, minProfit: 0, cycles: 0 }, budget: 300_000 }), 'trade');
  a.storage[q] = { ...(a.storage[q] ?? {}), metal: 40 };
  must(sim.command(q, { c: 'list', station: a.id, item: 'metal', qty: 25, price: Math.round(sim.price(a, 'metal', 'sell') * 1.4) }), 'list');
  sim.st.companies[q].rep = 100;
  const preset = Object.values(CONTENT.presets).find(pr => pr.hull === 'corvette_mk1' && Object.keys(pr.weapons ?? {}).length);
  const yard = Object.values(sim.st.stations).find(s => s.public && s.services.shipyard.length && preset && !sim.command(q, { c: 'buyShip', station: s.id, classId: '', loadoutId: '', hull: preset.hull, variant: preset.variant, preset: preset.id }));
  if (!yard) console.warn('no corvette bought (save still usable)');
  step(sim, 1800);
  const save = { v: 1, world: JSON.parse(sim.serialize()), auth: {}, accounts: { '00000000-0000-4000-8000-00000000000a': p, '00000000-0000-4000-8000-00000000000b': q } };
  fs.writeFileSync(out, JSON.stringify(save));
  const w: WorldState = save.world;
  console.log(`dev save ${out}: contentV ${w.contentV} · econ ${w.econ ? 'on' : 'off'} · companies ${Object.keys(w.companies).length} · ships ${Object.keys(w.ships).length} · works ${Object.keys(w.works ?? {}).length} · approvals ${Object.keys(w.approvals ?? {}).length} · jobs@home ${w.stations.reh_home.jobs?.length} · listings@astra ${w.stations.astra.listings?.length} · sha ${sha(JSON.stringify(save)).slice(0, 12)}`);
}

/** every JSON path whose value differs (bounded) */
function diff(a: unknown, b: unknown, p = '', out: string[] = []): string[] {
  if (out.length > 5000) return out;
  if (a === b) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) { out.push(p); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b as object)])) diff((a as never)[k], (b as never)[k], `${p}/${k}`, out);
  return out;
}

function rehearse(file: string, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(file, 'utf8'), h0 = sha(raw);
  const backup = path.join(dir, 'backup-pre-e1.json');
  fs.writeFileSync(backup, raw);
  const checks: [string, boolean, string?][] = [];
  const ok = (name: string, v: boolean, note?: string) => { checks.push([name, v, note]); console.log(`${v ? 'PASS' : 'FAIL'} ${name}${note ? ` — ${note}` : ''}`); };
  ok('backup written and byte-identical (sha256)', sha(fs.readFileSync(backup, 'utf8')) === h0, h0.slice(0, 16));
  const save = JSON.parse(raw), w0: WorldState = save.world;
  // the server transform (node.ts), on a copy
  const b = census(w0);
  const sim = new WorldSim(structuredClone(w0), { migrateEcon: true });
  const rep = sim.econReport!;
  ok('migration applied', rep.ok && rep.changed > 0, `markets ${rep.markets} · goods ${rep.goods} · bases changed ${rep.changed} · skipped ${rep.skipped.length}`);
  ok('asset census identical', compareCensus(b, census(sim.st)).length === 0, compareCensus(b, census(sim.st)).join('; '));
  const s1 = sim.serialize();
  ok('save → restore round trip identical', new WorldSim(JSON.parse(s1), { migrateEcon: true }).serialize() === s1);
  // nothing but market bases, st.econ and st.econLog differs from the constructor run without the flag
  const plain = JSON.parse(new WorldSim(structuredClone(w0)).serialize()), mig = JSON.parse(s1);
  const paths = diff(plain, mig);
  const stray = paths.filter(x => !/^\/stations\/[^/]+\/market\/[^/]+\/base$/.test(x) && !/^\/econ(Log)?(\/|$)/.test(x));
  ok('only market bases + econ state changed', stray.length === 0, `${paths.length} paths changed${stray.length ? ` · stray: ${stray.slice(0, 8).join(', ')}` : ''}`);
  const bp = paths.filter(x => /\/market\/bp:/.test(x));
  ok('blueprint prices untouched', bp.length === 0);
  // idempotent: a second run changes nothing
  const again = JSON.parse(s1) as WorldState, r2 = migrateEconChain(again);
  ok('idempotent (second migration changes 0, save identical)', r2.changed === 0 && JSON.stringify(again) === JSON.stringify(mig));
  // running jobs keep their recorded output; new jobs use the world output
  const jobs = Object.values(mig.stations as Record<string, Station>).flatMap(s => s.jobs ?? []);
  ok('running jobs unchanged', JSON.stringify(Object.values(plain.stations as Record<string, Station>).flatMap(s => s.jobs ?? [])) === JSON.stringify(jobs), `${jobs.length} jobs`);
  ok('alloy_direct output in the migrated world', recipeFor(mig, 'alloy_direct')!.out.alloy === mig.econ.alloyDirect, `${mig.econ.alloyDirect}`);
  // play on: 2 h of world time after the migration — no negative or non-finite money/stock
  step(sim, 7200);
  const bad: string[] = [];
  for (const c of Object.values(sim.st.companies)) if (!Number.isFinite(c.credits) || c.credits < -1e-6) bad.push(`credits ${c.id}`);
  for (const s of Object.values(sim.st.stations)) {
    for (const [k, e] of Object.entries(s.market ?? {})) if (!Number.isFinite(e.stock) || e.stock < 0 || !Number.isFinite(e.base)) bad.push(`market ${s.id}:${k}`);
    for (const [o, st] of Object.entries(s.storage)) for (const [k, n] of Object.entries(st ?? {})) if (!Number.isFinite(n) || n < -1e-6) bad.push(`storage ${s.id}/${o}:${k}`);
    if (s.funds !== undefined && (!Number.isFinite(s.funds) || s.funds < -1e-6)) bad.push(`funds ${s.id}`);
  }
  ok('2h after migration: no negative/non-finite money or stock', bad.length === 0, bad.slice(0, 6).join(', '));
  // econ rollback on the migrated save: back to the exact old bases, rule removed
  const rb = JSON.parse(s1) as WorldState, rr = rollbackEconChain(rb);
  const rbPaths = diff(plain, JSON.parse(new WorldSim(rb).serialize())).filter(x => !/^\/econLog(\/|$)/.test(x));
  ok('econ rollback restores every base and removes the rule', rr.ok && rbPaths.length === 0 && !rb.econ, `restored ${rr.restored}${rbPaths.length ? ` · left: ${rbPaths.slice(0, 6).join(', ')}` : ''}`);
  ok('rolled-back save is not re-migrated without the flag', new WorldSim(structuredClone(rb)).st.econ === undefined);
  // data rollback: the backup is the original save, unchanged
  ok('data rollback: backup equals the original input', sha(fs.readFileSync(backup, 'utf8')) === sha(fs.readFileSync(file, 'utf8')));
  ok('input save file never modified', sha(fs.readFileSync(file, 'utf8')) === h0);
  fs.writeFileSync(path.join(dir, 'migrated.json'), JSON.stringify({ ...save, world: mig }));
  fs.writeFileSync(path.join(dir, 'rolled-back.json'), JSON.stringify({ ...save, world: rb }));
  const report = { input: path.basename(file), sha256: h0, report: rep, changedPaths: paths.length, checks: checks.map(([name, pass, note]) => ({ name, pass, note })) };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
  const failed = checks.filter(c => !c[1]).length;
  console.log(failed ? `${failed} check(s) FAILED` : `all ${checks.length} checks passed`);
  if (failed) process.exit(1);
}

function rollback(file: string, out: string) {
  if (path.resolve(file) === path.resolve(out)) throw new Error('입력과 출력이 같으면 안 됨 (입력은 백업으로 남김)');
  const save = JSON.parse(fs.readFileSync(file, 'utf8')), b = census(save.world);
  const r = rollbackEconChain(save.world);
  if (!r.ok) { console.error(`rollback refused: ${r.why}`); process.exit(1); }
  const sim = new WorldSim(save.world), bad = compareCensus(b, census(sim.st));
  if (bad.length) throw new Error(`센서스 불일치 ${bad.join('; ')}`);
  const s1 = sim.serialize();
  if (new WorldSim(JSON.parse(s1)).serialize() !== s1) throw new Error('복원 왕복 불일치');
  fs.writeFileSync(out, JSON.stringify({ ...save, world: JSON.parse(s1) }));
  console.log(`econ rollback: restored ${r.restored} bases · census OK · round trip OK → ${out}`);
}

const [mode, a1, a2] = process.argv.slice(2).filter(x => x !== '--');
if (mode === 'make') make(a1, Number(a2 ?? 4401));
else if (mode === 'rehearse') rehearse(a1, a2);
else if (mode === 'rollback') rollback(a1, a2);
else { console.error('usage: make <out.json> [seed] | rehearse <save.json> <outdir> | rollback <migrated.json> <out.json>'); process.exit(2); }
