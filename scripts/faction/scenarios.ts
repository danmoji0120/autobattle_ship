// Faction economy v2 scenarios in real WorldSim (isolated P10 dev worlds; nothing is saved to disk
// except the JSON result). Each scenario prints/writes hourly faction metrics and invariant checks.
//   npx vite-node scripts/faction/scenarios.ts -- <scenario> <hours> <seed> [out.json] [chain]
// scenarios:
//   peace     no wars (relations held at 0 every cycle)
//   war       natural P10 conflicts (front tension starts them)
//   ironwar   peace except an iron–pirates war forced at hour 1 (reference for the next two)
//   cut       ironwar + munitions supply cut: iron and pirates lose weapon_parts/armor_plate production, every
//             market's stock of those goods is removed each cycle (blockade) and iron's munitions stockpile is
//             seized when the war starts (recorded in its ledger as `lost`)
//   recover   cut (Bulwark exempt from the blockade), but from hour 3 a player company sells weapon_parts and armor_plate at Bulwark every hour
//   save      natural run; at half time the world is saved and restored, both continue; must stay equal
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { startConflict } from '../../src/world/factionEcon';
import { FE_CYCLE, PROFILES2, writeOff } from '../../src/world/factionEcon2';
import { P10_FRONTS } from '../../src/world/worldgen-p10';
import { qty, type Cargo } from '../../src/world/types';
import { snapshot, flows, marketView, KEY_GOODS, val } from './metrics';

const args = process.argv.slice(2).filter(a => a !== '--');
const scen = args[0] ?? 'peace', hours = Number(args[1] ?? 6), seed = Number(args[2] ?? 5), out = args[3] && args[3] !== '-' ? args[3] : undefined;
const chain = args.includes('chain');
const make = () => WorldSim.create(seed, { layout: 'p10', factionEcon: 'v2', ...(chain ? { econ: 'chain' as const } : {}) });
let sim = make();
const W = () => sim.st;

const calm = () => { for (const f of Object.values(W().factions!)) for (const g of Object.keys(f.rel)) f.rel[g] = 0; for (const c of Object.values(W().conflicts ?? {})) if (!c.ended) c.ended = W().time; };
const calmExcept = (a: string, b: string) => { for (const f of Object.values(W().factions!)) for (const g of Object.keys(f.rel)) if (!((f.id === a && g === b) || (f.id === b && g === a))) f.rel[g] = 0; };
const MUN = ['weapon_parts', 'armor_plate'];
if (scen === 'cut' || scen === 'recover') {
  // iron and pirates lose their munitions plants for this run (in memory only)
  for (const id of ['iron', 'pirates']) for (const k of MUN) delete PROFILES2[id].sectors[k];
}

const violations: string[] = [];
function check(tag: string) {
  const w = W();
  for (const f of Object.values(w.factions!)) {
    const e = f.econ!;
    for (const [k, n] of Object.entries(f.stock)) if (n! < -1e-6) violations.push(`${tag} ${f.id} negative stock ${k}`);
    if (e.budget < -1e-6) violations.push(`${tag} ${f.id} negative budget`);
    if (!Number.isFinite(e.budget + f.strength + f.infra)) violations.push(`${tag} ${f.id} non-finite`);
    const L = e.led;
    for (const k of new Set([...Object.keys(f.stock), ...Object.keys(L.used), ...Object.keys(L.bought), ...Object.keys(L.made), ...Object.keys(L.extracted)])) {
      const q = (c: Cargo) => qty(c, k);
      const exp = q(L.opening) + q(L.extracted) + q(L.made) - q(L.inputs) + q(L.bought) - q(L.used) - q(L.exported) - q(L.lost ?? {});
      if (Math.abs(exp - qty(f.stock, k)) > 1e-6 * Math.max(1, Math.abs(exp))) violations.push(`${tag} ${f.id} ledger ${k} ${exp} vs ${qty(f.stock, k)}`);
    }
  }
  for (const s of Object.values(w.stations)) {
    for (const [k, m] of Object.entries(s.market ?? {})) if (m.stock < -1e-6) violations.push(`${tag} ${s.id} market ${k} negative`);
    if (s.fundsMax !== undefined && ((s.funds ?? 0) < -1e-6 || (s.funds ?? 0) > s.fundsMax * 1.5 + 1e-6)) violations.push(`${tag} ${s.id} funds out of range`);
  }
}

// player company for the recovery run: holds munitions at Bulwark and sells a batch every hour
let seller: string | undefined; let sold: { h: number; item: string; units: number; credits: number }[] = [];
const hourly: unknown[] = [];
let snap = snapshot(W());
const t0 = performance.now(); let worst = 0;
let twin: WorldSim | undefined, twinEqual: boolean | undefined;

for (let h = 1; h <= hours; h++) {
  if (scen === 'ironwar' || scen === 'cut' || scen === 'recover') {
    if (h === 2) { const fr = P10_FRONTS.find(x => x.a === 'iron' && x.b === 'pirates')!; W().factions!.iron.rel.pirates = -90; W().factions!.pirates.rel.iron = -90; startConflict(sim, W(), fr.a, fr.b, fr.edges); }
  }
  if (scen === 'recover' && h >= 3) {
    if (!seller) seller = sim.addPlayer('군수 납품');
    const yard = W().stations.p10_bulwark_yard;
    for (const [k, n] of [['weapon_parts', 150], ['armor_plate', 200]] as const) {
      yard.storage[seller] = { ...(yard.storage[seller] ?? {}), [k]: n } as any;
      const c0 = W().companies[seller].credits;
      const err = sim.command(seller, { c: 'sell', station: yard.id, res: k, amount: n });
      sold.push({ h, item: k, units: n - qty(yard.storage[seller] as Cargo, k), credits: Math.round(W().companies[seller].credits - c0) });
      if (err) sold.at(-1)!.item += ` (${err.slice(0, 40)})`;
    }
  }
  for (let t = 0; t < 3600; t++) {
    if (t % FE_CYCLE === 0) {
      if (scen === 'peace') calm();
      if (scen === 'ironwar' || scen === 'cut' || scen === 'recover') { calmExcept('iron', 'pirates'); if (h < 2) calm(); }
      if ((scen === 'cut' || scen === 'recover') && h >= 2) {
        // blockade: munitions vanish from every market each cycle (recover: except Bulwark, where the player sells);
        // iron's own munitions stockpile is seized once when the war starts (recorded write-off)
        if (h === 2 && t === 0) for (const k of MUN) writeOff(W().factions!.iron, k, qty(W().factions!.iron.stock, k));
        for (const s of Object.values(W().stations)) if (s.market && !(scen === 'recover' && s.id === 'p10_bulwark_yard')) for (const k of MUN) if (s.market[k]) s.market[k].stock = 0;
      }
    }
    const s = performance.now(); sim.tick(1); worst = Math.max(worst, performance.now() - s);
    if (twin) twin.tick(1);
  }
  if (scen === 'save' && h === Math.floor(hours / 2)) { twin = new WorldSim(JSON.parse(sim.serialize())); }
  check(`h${h}`);
  const now = snapshot(W());
  hourly.push({ h, wars: Object.values(W().conflicts ?? {}).filter(c => !c.ended).map(c => `${c.a}-${c.b}`), factions: flows(W(), snap, now), markets: h % 6 === 0 || h === hours ? marketView(W(), KEY_GOODS) : undefined });
  snap = now;
  if (!out) { const f = (hourly.at(-1) as any).factions; console.log(`h${h}`, Object.entries<any>(f).map(([id, x]) => `${id} s${x.strength} e${x.eff} r${x.rdy} own${Math.round(x.perH.ownProduction / 1000)}k buy${Math.round(x.perH.purchases / 1000)}k short${Math.round(x.perH.unmet / 1000)}k`).join(' | ')); }
}
if (twin) twinEqual = JSON.stringify(twin.st.factions) === JSON.stringify(sim.st.factions) && JSON.stringify(Object.values(twin.st.stations).map(s => [s.market, s.funds])) === JSON.stringify(Object.values(sim.st.stations).map(s => [s.market, s.funds]));
const conflicts = Object.values(W().conflicts ?? {}).map(c => ({ a: c.a, b: c.b, since: Math.round(c.since / 60), ended: c.ended ? Math.round(c.ended / 60) : null, lost: Object.fromEntries(Object.entries(c.lost).map(([k, v]) => [k, +v.toFixed(1)])) }));
const totals = Object.fromEntries(Object.values(W().factions!).map(f => { const L = f.econ!.led; return [f.id, { income: Math.round(L.income), exportRev: Math.round(L.exportRev), spent: Math.round(L.spent), sunk: Math.round(L.sunk), usedValue: Math.round(val(L.used)), boughtValue: Math.round(val(L.bought)), importValue: Math.round(val(L.imported)), unmetValue: Math.round(val(L.short)), warValue: Math.round(val(L.war)), rebuildValue: Math.round(val(L.rebuild)), lostStr: +L.lostStr.toFixed(1), builtStr: +L.builtStr.toFixed(1), war: Object.fromEntries(Object.entries(L.war).map(([k, v]) => [k, Math.round(v!)])) }]; }));
const result = { scenario: scen, hours, seed, chain, msPerTick: +((performance.now() - t0) / (hours * 3600)).toFixed(2), worstTickMs: Math.round(worst), saveBytes: sim.serialize().length,
  violations: violations.slice(0, 50), violationCount: violations.length, twinEqual, conflicts, sold, totals, hourly };
if (out) fs.writeFileSync(out, JSON.stringify(result)); else console.log(JSON.stringify({ ...result, hourly: undefined }, null, 1).slice(0, 4000));
