// Compare all content and NPC economics with the exact P9.6.3 baseline, offline.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deepStrictEqual, equal } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const baseline = '793ff7746ae08c2500d4c4c44eb39aed99ed9b22';
const tmp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9631-data-')), oldRoot = path.join(tmp, 'old');
mkdirSync(oldRoot);
execFileSync('tar', ['-x', '-C', oldRoot], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 32 * 1024 * 1024 }) });
symlinkSync(path.resolve('node_modules'), path.join(oldRoot, 'node_modules'));
async function bundle(root, name) {
  const entry = path.join(tmp, `${name}.ts`), out = path.join(tmp, `${name}.mjs`);
  const exp = (file, names) => `export { ${names} } from ${JSON.stringify(path.join(root, file))};\n`;
  writeFileSync(entry, exp('src/content/registry.ts','CONTENT') + exp('src/world/industry.ts','FACILITIES, HULLS, ITEMS, RECIPES, TECHS') + exp('src/world/stations.ts','STATION_SIZES') + exp('src/world/hullops.ts','hullBuild, hullEcon, hullSale, hullStock, hullUpkeep, TIER_BASE') + exp('src/world/valuation.ts','hullCost, hullPrice, yardFee, yardRestockNeed') + exp('src/world/sim.ts','WorldSim'));
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}
const old = await bundle(oldRoot, 'old'), now = await bundle(process.cwd(), 'new');
const tiers = { battleship_mk1: 4, miner_l: 3, hauler_l: 3, hauler_meridian: 3, constructor_l: 3, miner_xl: 4, hauler_xl: 4, constructor_xl: 4 };
deepStrictEqual(now.STATION_SIZES, old.STATION_SIZES); deepStrictEqual(now.HULLS, old.HULLS); deepStrictEqual(now.ITEMS, old.ITEMS); deepStrictEqual(now.RECIPES, old.RECIPES); deepStrictEqual(now.TIER_BASE, old.TIER_BASE);
deepStrictEqual(now.CONTENT.variants, old.CONTENT.variants); deepStrictEqual(now.CONTENT.presets, old.CONTENT.presets);
for (const id of Object.keys(old.FACILITIES)) {
  const a = structuredClone(old.FACILITIES[id]), b = structuredClone(now.FACILITIES[id]);
  if (id === 'yard_xl') { delete a.desc; delete b.desc; delete a.tech; delete b.tech; }
  if (id === 'yard_l') { delete a.desc; delete b.desc; }
  deepStrictEqual(b, a, `facility ${id}`);
}
for (const id of Object.keys(old.TECHS)) {
  const a = structuredClone(old.TECHS[id]), b = structuredClone(now.TECHS[id]);
  if (['capital_hulls', 'dreadnought_program'].includes(id)) { delete a.unlocks; delete b.unlocks; }
  deepStrictEqual(b, a, `technology ${id}`);
}
const market = { market: { alloy: {}, structure: {}, armor_plate: {}, electronics: {} } };
const hulls = Object.keys(old.CONTENT.hulls);
deepStrictEqual(Object.keys(now.CONTENT.hulls).sort(), hulls.sort());
for (const id of hulls) {
  const a = structuredClone(old.CONTENT.hulls[id]), b = structuredClone(now.CONTENT.hulls[id]);
  if (id in tiers && id !== 'battleship_mk1') b.build.yard = a.build.yard;
  deepStrictEqual(b, a, `hull content ${id}`);
  const prev = old.hullBuild(id), next = now.hullBuild(id);
  equal(next.yard, tiers[id] ?? prev.yard, `required yard ${id}`);
  const { yard: p, facilities: pf, ...pr } = prev;
  const { yard: q, facilities: qf, pricingYard, ...qr } = next;
  deepStrictEqual(qr, pr, `build terms ${id}`);
  if (!(id in tiers)) deepStrictEqual(qf, pf, `facilities ${id}`);
  for (const facility of pf ?? []) if (!(qf ?? []).includes(facility)) throw Error(`lost ${id}/${facility}`);
  deepStrictEqual(now.hullCost(id), old.hullCost(id), `hull cost ${id}`);
  deepStrictEqual(now.hullPrice(id), old.hullPrice(id), `NPC price ${id}`);
  deepStrictEqual(now.hullSale(id), old.hullSale(id), `NPC sale ${id}`);
  deepStrictEqual(now.hullStock(id), old.hullStock(id), `NPC stock ${id}`);
  deepStrictEqual(now.hullUpkeep(id), old.hullUpkeep(id), `upkeep ${id}`);
  deepStrictEqual(now.hullEcon(id), old.hullEcon(id), `ship performance ${id}`);
  deepStrictEqual(now.yardRestockNeed(id, market), old.yardRestockNeed(id, market), `NPC inputs ${id}`);
}
// Existing private-market edge case: a foreign buyer can buy goods but cannot dock to collect them.
function privateTrade(lib) {
  const sim = lib.WorldSim.create(96319), seller = sim.addPlayer('시험 판매자'), buyer = sim.addPlayer('시험 구매자');
  const base = sim.st.stations.astra, site = { ...structuredClone(base), id: 'private_trade_probe', owner: seller, public: false, size: 'M', market: null,
    storage: { [seller]: { alloy: 10 }, [buyer]: {} }, modules: ['core', 'power', 'trade_hub'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })) };
  sim.st.stations[site.id] = site;
  const listingError = sim.command(seller, { c: 'list', station: site.id, item: 'alloy', qty: 10, price: 10 });
  const buyError = sim.command(buyer, { c: 'buyListing', station: site.id, listing: site.listings[0].id, qty: 10 });
  const group = sim.newGroup(buyer, '시험 수송'), ship = sim.spawnShip(buyer, 'hauler', 'std', group.id, base.pos);
  const routeError = sim.command(buyer, { c: 'putRoute', group: group.id, config: { name: '회수', from: site.id, to: base.id, item: 'alloy', amount: 10, mode: 'transfer', repeat: false } });
  return { listingError, buyError, buyerOwns: site.storage[buyer].alloy, buyerCanDock: sim.canDock(site, buyer), routeError, shipCargo: ship.cargo.alloy ?? 0 };
}
const privateTradeBefore = privateTrade(old), privateTradeAfter = privateTrade(now);
deepStrictEqual(privateTradeAfter, privateTradeBefore, 'pre-existing private-station trading behavior');
equal(privateTradeAfter.buyError, null); equal(privateTradeAfter.buyerOwns, 10); equal(privateTradeAfter.buyerCanDock, false);
const result = { baseline, hullsCompared: hulls.length, facilitiesCompared: Object.keys(old.FACILITIES).length, tiers, unchanged: ['hull build costs and parts', 'NPC prices and restocking', 'ship operations and upkeep', 'station facility prices and capacities', 'industry recipes and research costs'], privateTradeBefore, privateTradeAfter };
mkdirSync('artifacts/p9631', { recursive: true });
writeFileSync('artifacts/p9631/baseline-comparison.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
