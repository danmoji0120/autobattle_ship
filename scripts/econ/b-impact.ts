// Existing-save impact of LIVE value-chain pricing (econChain.ts / econMigrate.ts). Read-only analysis on an
// isolated migrated c4 world (c0 save → content migration → econ migration), never a real save.
//   npx vite-node scripts/econ/b-impact.ts -- [seed=5] [out.json]
// For each equipment policy (chain / keep / margin) it reports:
//   goods     mean public-market base before → after
//   holding   a mid company warehouse at bid
//   hulls     NPC list price (unchanged, c4-b1) vs own-yard build (parts at ask + labour + yard fee), and the
//             finished NPC ship vs own hull + its standard weapons bought at market
//   equipment market price, a market-bought equipment line's profit/h, refit cost of each standard preset
//   facilities capital of a station + facility (credits + materials at ask)
//   approvals share of goods whose new ask exceeds an approval cap set at the old price (+15 %)
//   repair    quote of a half-damaged ship of each class (must not change)
//   fleet     reference fleet running cost (chemicals and machinery are market supplies)
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { newWorld } from '../../src/world/worldgen';
import { hullBuild, hullSale } from '../../src/world/hullops';
import { yardFee, hullCost, saleMul, GRADE_MUL } from '../../src/world/valuation';
import { chainValue } from '../../src/world/econChain';
import { CONTENT } from '../../src/content/registry';
import { RECIPES, EQUIPMENT, FACILITIES } from '../../src/world/industry';
import { migrateEconChain } from '../../src/world/econMigrate';
import { repairQuote } from '../../src/world/repair';
import { marketsOf, ASK, BID, facilityCapex, stationCapex, fleetCostH, haulPerUnit, SMALL_FLEET, MID_FLEET } from './model';
import type { EqPolicy } from '../../src/world/econChain';
import type { WorldState } from '../../src/world/types';

const args = process.argv.slice(2).filter(a => a !== '--');
const seed = Number(args[0] ?? 5), out = args[1];
const r0 = (n: number) => Math.round(n), pct = (a: number, b: number) => Math.round((b / a - 1) * 1000) / 10;

function migrated(): WorldSim {
  const st = newWorld(seed); delete (st as { contentV?: number }).contentV;
  return new WorldSim(JSON.parse(new WorldSim(st, { migrateContent: false }).serialize()), { migrateContent: true });
}
const meanBase = (w: WorldState) => {
  const acc: Record<string, number[]> = {};
  for (const s of Object.values(w.stations)) if (s.public && s.market) for (const [k, e] of Object.entries(s.market)) if (!k.startsWith('bp:')) (acc[k] ??= []).push(e.base);
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
};
const HOLD: Record<string, number> = { ore: 2000, silicate: 800, metal: 1200, alloy: 800, titanium: 300, machinery: 120, structure: 100, electronics: 80, armor_plate: 40 };
const GOAL_ITEMS = ['ore', 'metal', 'titanium', 'silicon', 'chemicals', 'crystal', 'alloy', 'composite', 'machinery', 'precision', 'structure', 'electronics', 'armor_plate', 'weapon_parts', 'engine', 'reactor', 'sensor'];

function measure(sim: WorldSim) {
  const W = sim.st, M = marketsOf(W), mean = meanBase(W);
  const ask = (k: string) => M.ask(k), bid = (k: string) => M.bid(k);
  const hulls = Object.values(CONTENT.hulls).map(h => {
    const s = hullSale(h.id); if (!s) return undefined;
    const b = hullBuild(h.id), build = Object.entries(b.parts).reduce((a, [k, n]) => a + n * ask(k), 0) + b.credits + yardFee(b);
    const pre = Object.values(CONTENT.presets).find(p => p.hull === h.id && p.variant === `${h.id}_std`);
    const weapons = Object.values(pre?.weapons ?? {}).reduce((a, eq) => a + (Number.isFinite(ask(eq)) ? ask(eq) : 0), 0);
    // strip arbitrage: buy the finished NPC ship, take off its standard weapons and sell them to NPC markets
    const strip = Object.values(pre?.weapons ?? {}).reduce((a, eq) => a + (bid(eq) > 0 ? bid(eq) : 0), 0);
    // Option B (comparison only): NPC list price recomputed from this world's part/equipment values
    let optB: number | undefined;
    if (W.econ) {
      const c = hullCost(h.id), parts = Object.entries(b.parts).reduce((a, [k, n]) => a + n * chainValue(k, W.econ!.eq), 0);
      const eqv = Object.values(pre?.weapons ?? {}).reduce((a, eq) => a + chainValue(eq, W.econ!.eq), 0);
      const bp = Object.values(CONTENT.blueprints).find(x => x.target.kind === 'hull' && x.target.id === h.id);
      const mul = saleMul(h.classId ?? h.id.replace(/_mk1$/, ''), b.pricingYard ?? b.yard), grade = GRADE_MUL[bp?.grade ?? 'common'] ?? 1;
      optB = h.sale?.price ?? Math.round((parts + c.labour + c.yard + eqv) * mul * grade / 100) * 100;
    }
    return { hull: h.id, npc: s.price, build: r0(build), buildRatio: Math.round(build / s.price * 100) / 100, weapons: r0(weapons), selfFinished: r0(build + weapons), selfVsNpc: Math.round((build + weapons) / s.price * 100) / 100, strip: r0(strip), stripRatio: Math.round(strip / s.price * 100) / 100, optB };
  }).filter(Boolean) as { hull: string; npc: number; build: number; buildRatio: number; weapons: number; selfFinished: number; selfVsNpc: number; strip: number; stripRatio: number; optB?: number }[];
  const equipment = Object.values(RECIPES).filter(r => EQUIPMENT[Object.keys(r.out)[0]]).map(r => {
    const [o, n] = Object.entries(r.out)[0], perH = 3600 / r.time;
    const inCost = Object.entries(r.in).reduce((a, [k, q]) => a + q * ask(k), 0), sell = bid(o);
    const units = Object.values(r.in).reduce((a, b) => a + b, 0) + n;
    const profitH = sell > 0 ? (sell * n - inCost) * perH - units * haulPerUnit() * perH - 25 : NaN;
    const capex = facilityCapex(r.fac, ask) + (stationCapex(FACILITIES[r.fac]?.minStation === 'M' ? 'M' : 'S', ask)) / 4;
    return { recipe: r.id, item: o, tech: r.tech ?? null, base: mean[o] !== undefined ? r0(mean[o]) : null, inCost: r0(inCost), npcMarket: sell > 0, profitH: Number.isFinite(profitH) ? r0(profitH) : null, paybackH: profitH > 0 ? Math.round(capex / profitH * 10) / 10 : null };
  });
  const refit = Object.values(CONTENT.presets).filter(p => p.variant === `${p.hull}_std` && hullSale(p.hull)).map(p => {
    const items = Object.values(p.weapons ?? {});
    const cost = items.reduce((a, eq) => a + (Number.isFinite(ask(eq)) && ask(eq) < 1e9 ? ask(eq) : 0), 0);
    return { hull: p.hull, items: items.length, cost: r0(cost) };
  });
  const facilities = ['refinery', 'smelter', 'alloy_plant', 'machine_shop', 'electronics_fab', 'armor_plant', 'weapons_factory', 'engine_plant', 'reactor_plant', 'hull_works'].filter(k => FACILITIES[k]).map(k => ({ kind: k, capex: r0(facilityCapex(k, ask)) }));
  const stations = { S: r0(stationCapex('S', ask)), M: r0(stationCapex('M', ask)) };
  const fleets = { small: r0(fleetCostH(W, SMALL_FLEET, M)), mid: r0(fleetCostH(W, MID_FLEET, M)) };
  // repair: half-damaged ship of every NPC-sold hull, quoted at a public yard
  const p = sim.addPlayer('수리 견적'), co = W.companies[p], at = Object.values(W.stations).find(s => s.public && s.services.repair)!;
  const repair = hulls.slice(0, 12).map(h => { const s = sim.spawnHull(p, h.hull, `${h.hull}_std`, undefined, sim.newGroup(p, 'r').id, at.pos); (sim as any).dockShip(s, at); s.hp = 0.5; return { hull: h.hull, cost: repairQuote(W, s, co).cost }; });
  return { mean, hulls, equipment, refit, facilities, stations, fleets, repair, askOf: Object.fromEntries(GOAL_ITEMS.map(k => [k, ask(k)])) };
}

const baseSim = migrated(), before = measure(baseSim);
const policies: EqPolicy[] = ['chain', 'keep', 'margin'];
const result: Record<string, unknown> = { seed, policies: {} };
for (const eq of policies) {
  const sim = migrated(); const rep = migrateEconChain(sim.st, { eq }); if (!rep.ok) throw new Error(rep.why);
  const after = measure(sim);
  const goods = Object.keys(before.mean).filter(k => after.mean[k] !== undefined).map(k => ({ id: k, before: Math.round(before.mean[k] * 10) / 10, after: Math.round(after.mean[k] * 10) / 10, pct: pct(before.mean[k], after.mean[k]) }));
  const hv = (m: Record<string, number>) => Object.entries(HOLD).reduce((a, [k, n]) => a + n * (m[k] ?? 0) * BID, 0);
  const stall = GOAL_ITEMS.filter(k => Number.isFinite(before.askOf[k]) && Number.isFinite(after.askOf[k])).map(k => ({ item: k, oldAsk: Math.round(before.askOf[k] * 10) / 10, cap: Math.ceil(before.askOf[k] * 1.15), newAsk: Math.round(after.askOf[k] * 10) / 10, stalls: after.askOf[k] > Math.ceil(before.askOf[k] * 1.15) }));
  (result.policies as Record<string, unknown>)[eq] = {
    changed: rep.changed, goods,
    holding: { before: r0(hv(before.mean)), after: r0(hv(after.mean)), pct: pct(hv(before.mean), hv(after.mean)) },
    hulls: after.hulls.map(h => { const b = before.hulls.find(x => x.hull === h.hull)!; return { hull: h.hull, npc: h.npc, npcBefore: b.npc, buildBefore: b.build, buildAfter: h.build, ratioBefore: b.buildRatio, ratioAfter: h.buildRatio, selfVsNpcBefore: b.selfVsNpc, selfVsNpcAfter: h.selfVsNpc, stripBefore: b.stripRatio, stripAfter: h.stripRatio, optionB: h.optB, optionBRatio: h.optB ? Math.round(h.build / h.optB * 100) / 100 : undefined }; }),
    equipment: after.equipment.map(e => { const b = before.equipment.find(x => x.recipe === e.recipe)!; return { ...e, baseBefore: b.base, profitHBefore: b.profitH, paybackHBefore: b.paybackH }; }),
    refit: after.refit.map(r => ({ ...r, before: before.refit.find(x => x.hull === r.hull)?.cost })),
    facilities: after.facilities.map(f => ({ ...f, before: before.facilities.find(x => x.kind === f.kind)?.capex })),
    stations: { before: before.stations, after: after.stations },
    fleets: { before: before.fleets, after: after.fleets },
    repair: after.repair.map(r => ({ ...r, before: before.repair.find(x => x.hull === r.hull)?.cost })),
    approvalStall: { items: stall, share: Math.round(stall.filter(s => s.stalls).length / stall.length * 100) },
  };
}
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
const P = result.policies as Record<string, any>;
console.log(`# B impact on a migrated c4 save (seed ${seed}); ASK ${ASK.toFixed(3)} BID ${BID}`);
console.log('good'.padEnd(16), ...policies.map(p => p.padStart(10)));
for (const g of P.chain.goods.sort((a: any, b: any) => a.id.localeCompare(b.id))) console.log(g.id.padEnd(16), String(g.before).padStart(8), ...policies.map(p => `${P[p].goods.find((x: any) => x.id === g.id).pct}%`.padStart(10)));
for (const p of policies) {
  console.log(`\n## equipment=${p}: holding ${P[p].holding.before} → ${P[p].holding.after} (${P[p].holding.pct}%) · fleets ${JSON.stringify(P[p].fleets)} · approval stall ${P[p].approvalStall.share}% of goal goods`);
  for (const h of P[p].hulls) console.log(`  ${h.hull.padEnd(18)} NPC ${h.npc} (was ${h.npcBefore}) · own build ${h.buildBefore} → ${h.buildAfter} (×${h.ratioBefore} → ×${h.ratioAfter}) · own hull+weapons vs NPC ×${h.selfVsNpcBefore} → ×${h.selfVsNpcAfter} · strip ×${h.stripBefore} → ×${h.stripAfter} · optB ${h.optionB} (build ×${h.optionBRatio})`);
  for (const e of P[p].equipment) console.log(`  eq ${e.recipe.padEnd(16)} base ${e.baseBefore ?? '-'} → ${e.base ?? '-'} · line ${e.profitHBefore ?? '—'} → ${e.profitH ?? '—'}/h · payback ${e.paybackHBefore ?? '—'} → ${e.paybackH ?? '—'} h${e.tech ? ' (연구)' : ''}`);
  console.log('  refit (std preset weapons at ask):', P[p].refit.map((r: any) => `${r.hull} ${r.before}→${r.cost}`).join(' · '));
  console.log('  facilities:', P[p].facilities.map((f: any) => `${f.kind} ${f.before}→${f.capex}`).join(' · '), '· stations', JSON.stringify(P[p].stations));
  console.log('  repair (hp 50%):', P[p].repair.map((r: any) => `${r.hull} ${r.before}→${r.cost}`).join(' · '));
  console.log('  stalls:', P[p].approvalStall.items.filter((s: any) => s.stalls).map((s: any) => `${s.item} ${s.oldAsk}→${s.newAsk} (cap ${s.cap})`).join(' · '));
}
