// P13.1 §14 conversion check for existing saves. Reads a save (or builds a legacy world with random derelicts,
// fleets on derelict survey / salvage orders, a legacy battle-debris field and waiting pendingLoot), converts a
// COPY with enableSalvageP131 and checks that nothing of value changed: credits, station storage, ship cargo,
// blueprints, unique holders, pendingLoot, debris fields, ship positions. The original save is never written
// and must be byte-identical afterwards. Then the copy runs on for an hour of game time: pendingLoot keeps being
// delivered, no derelict comes back, nothing throws. The conversion is idempotent (second call is a no-op).
//   npx vite-node scripts/salvage/p131-convert-check.ts -- [save.json]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WorldSim } from '../../src/world/sim';
import type { WorldState } from '../../src/world/types';
import { enableSalvageP131 } from '../../src/world/salvageMigrate';

const file = process.argv.slice(2).find(a => a.endsWith('.json'));
const checks: { ok: boolean; label: string; extra?: unknown }[] = [];
const check = (ok: unknown, label: string, extra?: unknown) => { checks.push({ ok: !!ok, label, ...(extra === undefined ? {} : { extra }) }); console.log(ok ? 'PASS' : 'FAIL', label, extra === undefined ? '' : JSON.stringify(extra)); };

function legacyWorld(): WorldSim {
  const sim = WorldSim.create(1312, { ops: 'p12' });
  const p = sim.addPlayer('변환 검사'), co = sim.st.companies[p]; co.credits = 2e6;
  const a = sim.st.stations.astra;
  // run until some derelicts exist, then make one known to the player and put fleets on survey / salvage
  for (let i = 0; i < 400 && Object.keys(sim.st.sites ?? {}).length < 2; i++) sim.update(1);
  const sites = Object.values(sim.st.sites ?? {});
  const s0 = sites[0];
  if (s0) { s0.seen.push(p); s0.born = Math.min(s0.born, sim.st.time); }
  const g1 = sim.newGroup(p, '탐사'); sim.spawnShip(p, 'constructor', 'std', g1.id, a.pos);
  const g2 = sim.newGroup(p, '인양'); sim.spawnShip(p, 'hauler', 'std', g2.id, a.pos);
  const g3 = sim.newGroup(p, '경비'); sim.spawnShip(p, 'destroyer', 'std', g3.id, a.pos);
  g1.op = { k: 'survey', system: sim.sysOf(a.pos)!.id } as any;
  if (s0) g2.op = { k: 'salvage', site: s0.id } as any;
  // a legacy battle-debris field and remote recovery waiting for storage room
  const f = Object.values(sim.st.fields)[0];
  if (f) sim.st.fields['cv_debris'] = { ...structuredClone(f), id: 'cv_debris', salvage: true, expires: sim.st.time + 3600 } as any;
  a.storage[p] = { ore: 500, alloy: 100 } as any;
  for (let i = 0; i < 20; i++) sim.update(.5);
  co.pendingLoot = { [a.id]: { alloy: 40, electronics: 12 } } as any; // set last: it is delivered on the next ticks
  return sim;
}

// a save file may be a bare world, a server save ({ v, world, … }) or a client save ({ save: '<json>' })
const unwrap = (txt: string) => { const j = JSON.parse(txt); return j.world ? JSON.stringify(j.world) : typeof j.save === 'string' ? j.save : txt; };
const fileText = file ? readFileSync(file, 'utf8') : '';
const raw = file ? unwrap(fileText) : legacyWorld().serialize();
const hashOrig = createHash('sha256').update(raw).digest('hex');
const before: WorldState = JSON.parse(raw);
const sim = new WorldSim(JSON.parse(raw), { migrateContent: false });

const value = (st: WorldState) => ({
  credits: Object.fromEntries(Object.values(st.companies).map(c => [c.id, Math.round(c.credits)])),
  storage: Object.fromEntries(Object.values(st.stations).map(s => [s.id, s.storage])),
  cargo: Object.fromEntries(Object.values(st.ships).map(s => [s.id, s.cargo])),
  blueprints: Object.fromEntries(Object.values(st.companies).map(c => [c.id, c.blueprints ?? {}])),
  uniques: st.uniques ?? {},
  pendingLoot: Object.fromEntries(Object.values(st.companies).map(c => [c.id, c.pendingLoot ?? {}])),
  debris: Object.values(st.fields).filter(f => (f as any).salvage).map(f => f.id).sort(),
  ships: Object.keys(st.ships).sort(),
  pos: Object.fromEntries(Object.values(st.ships).map(s => [s.id, s.pos])),
});
const v0 = JSON.stringify(value(before));
const sitesBefore = Object.keys(before.sites ?? {}).length;
const opsBefore = Object.values(before.groups).filter(g => g.op.k === 'salvage' || g.op.k === 'survey').map(g => `${g.id}:${g.op.k}`);
check(!before.salvageV, 'source is a legacy save (no salvageV)', { sites: sitesBefore, derelictOps: opsBefore });

const conv = enableSalvageP131(sim);
console.log('conversion', JSON.stringify(conv));
check(!conv.already && conv.sitesRetired === sitesBefore, 'every random derelict site retired', { retired: conv.sitesRetired, knownUnsalvaged: conv.sitesKnownUnsalvaged });
check(!sim.st.sites, 'no derelict sites left in the converted copy');
check(sim.st.salvageV === 1 && sim.st.combatV === 2 && sim.st.opsV === 1 && sim.st.logisticsV === 1, 'P11 / P12 / P12.5 / P13.1 flags on');
check(Object.values(sim.st.groups).every(g => g.op.k !== 'salvage'), 'no fleet left on a derelict salvage order', conv.groupsStopped);
check(JSON.stringify(value(sim.st)) === v0, 'credits, storage, cargo, blueprints, uniques, pendingLoot, debris fields, ships and positions unchanged');
check(JSON.stringify(conv.debrisFieldsKept) === JSON.stringify(value(before).debris), 'legacy debris fields kept', conv.debrisFieldsKept);
check(JSON.stringify(conv.pendingLootKept) === JSON.stringify(Object.values(before.companies).filter(c => c.pendingLoot && Object.keys(c.pendingLoot).length).map(c => c.id).sort()), 'pendingLoot holders kept', conv.pendingLootKept);
check(enableSalvageP131(sim).already, 'conversion is idempotent');
check(createHash('sha256').update(raw).digest('hex') === hashOrig && (!file || readFileSync(file, 'utf8') === fileText), 'original save untouched');

// run the converted copy for an hour of game time
const pl0 = JSON.stringify(Object.values(sim.st.companies).map(c => c.pendingLoot ?? {}));
let err: unknown = null;
try { for (let i = 0; i < 3600; i++) sim.update(1); } catch (e) { err = e; }
check(!err, 'converted copy runs one game hour without error', err ? String(err) : undefined);
check(!sim.st.sites, 'no random derelict spawns after conversion');
check(Object.values(sim.st.groups).every(g => g.op.k !== 'salvage'), 'no derelict salvage order after an hour');
const pl1 = JSON.stringify(Object.values(sim.st.companies).map(c => c.pendingLoot ?? {}));
console.log('pendingLoot before / after hour', pl0, pl1);
if (pl0 !== pl1 || !file) check(pl0 !== '[{},{},{},{}]' && JSON.parse(pl1).every((m: object) => !Object.keys(m).length), 'pendingLoot delivered after conversion', { before: pl0, after: pl1 });
const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
check(restored.st.salvageV === 1 && JSON.stringify(restored.st.wrecks) === JSON.stringify(sim.st.wrecks), 'converted copy saves / restores as a P13.1 world');

const ok = checks.every(c => c.ok);
mkdirSync('docs/salvage-results', { recursive: true });
writeFileSync('docs/salvage-results/p131-convert-check.json', JSON.stringify({ source: file ?? 'built legacy world (seed 1312, P12 ops, derelicts + derelict orders + debris field + pendingLoot)', conversion: conv, checks, ok }, null, 2));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
process.exit(ok ? 0 : 1);
