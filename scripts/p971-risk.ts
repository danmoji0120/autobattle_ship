// Isolated trials: all ships/capital are fixture grants, but every sale is a real game command.
// Run: npx vite-node scripts/p971-risk.ts [seeds] [game-seconds] [no-buyer]
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorldSim } from '../src/world/sim';
import { cargoSum, qty } from '../src/world/types';
import { hashId, miningSpot } from '../src/world/geom';
import { shipWorth } from '../src/world/hullops';
import { shipRate } from '../src/world/upkeep';

type Scenario = 'A' | 'B' | 'C' | 'D';
const cases: Scenario[] = ['A', 'B', 'C', 'D'];
const seeds = Number(process.argv[2] ?? 3), duration = Number(process.argv[3] ?? 1800);
const buyerEnabled = process.argv[4] !== 'no-buyer';
if (!Number.isInteger(seeds) || seeds < 1 || duration < 60 || duration % 60) throw Error('positive seeds and duration divisible by 60 required');
const trials: unknown[] = [];
for (let seed = 97100; seed < 97100 + seeds; seed++) for (const scenario of cases) {
  const sim = WorldSim.create(seed), owner = sim.addPlayer('광업사'), buyer = sim.addPlayer('시험 구매사');
  const co = sim.st.companies[owner]; co.credits = 1_000_000; sim.st.companies[buyer].credits = 1_000_000;
  const field = sim.st.fields[scenario === 'A' ? 'kestrel' : 'p97_blackgate_singular'];
  const primary = scenario === 'A' ? 'ore' : 'singular_ore';
  const source = sim.st.stations[scenario === 'A' ? 'astra' : 'drakeout'];
  const destination = scenario === 'D' ? sim.st.stations.astra : source;
  const group = sim.newGroup(owner, '시험 채굴 편대');
  const miner = sim.spawnShip(owner, 'miner', 'std', group.id, field.pos);
  miner.pos = miningSpot(field, hashId(miner.id) % field.rocks);
  const fleet = [miner];
  const escorts = scenario === 'C' ? ['corvette'] : scenario === 'D' ? ['destroyer', 'corvette', 'corvette'] : [];
  const escortShips = escorts.map(cls => sim.spawnShip(owner, cls, 'gun', group.id, field.pos));
  fleet.push(...escortShips);
  const fail = (err: string | null, action: string) => { if (err) throw Error(`${scenario} ${action}: ${err}`); };
  fail(sim.command(owner, { c: 'setOp', group: group.id, op: { k: 'mine', field: field.id, deliver: source.id, sell: false } }), 'mine');
  let routeId: string | undefined;
  if (scenario === 'D') {
    const freight = sim.newGroup(owner, '자동 운송');
    fleet.push(sim.spawnShip(owner, 'hauler', 'std', freight.id, source.pos));
    fail(sim.command(owner, { c: 'putRoute', group: freight.id, config: { name: '희귀 광석 수송', from: source.id, to: destination.id, item: primary, amount: 30, mode: 'transfer', repeat: true } }), 'route');
    routeId = Object.values(sim.st.logistics!)[0].id;
  }
  const losses: Record<string, number> = Object.fromEntries(fleet.map(s => [s.id, shipWorth(sim.st, s)]));
  const startCredits = co.credits;
  let sold = 0, primarySold = 0, revenue = 0, primaryRevenue = 0, arrivedSource = 0, escortBasicUpkeep = 0;
  let lastSource = 0, lastLoaded = 0;
  const activity: Record<string, number> = {};
  for (let t = 1; t <= duration; t++) {
    sim.update(1);
    if (t % 10 === 0) {
      for (const escort of escortShips) {
        const live = sim.st.ships[escort.id];
        if (live) { const rate = shipRate(sim.st, live); escortBasicUpkeep += (rate.credits * 1.1 + rate.dock) * 10 / 3600; }
      }
      const ship = sim.st.ships[miner.id];
      const k = !ship ? 'lost' : ship.state === 'battle' ? 'battle' : ship.task.k === 'mine' ? 'mining' : ship.task.k === 'goto' ? 'travel' : ship.task.k === 'docked' ? 'docked' : 'waiting_or_other';
      activity[k] = (activity[k] ?? 0) + 10;
    }
    if (t % 60) continue;
    const sourceStock = qty(source.storage[owner], primary);
    const loaded = routeId ? sim.st.logistics![routeId].stats.loaded : 0;
    arrivedSource += Math.max(0, sourceStock - lastSource + loaded - lastLoaded);
    lastLoaded = loaded;
    // Sell only goods the NPC market actually buys; use the resulting cash and inventory deltas.
    for (const item of Object.keys(source.storage[owner] ?? {})) {
      if (!source.market?.[item] || (scenario !== 'A' && item === primary)) continue;
      const beforeQty = qty(source.storage[owner], item), beforeCr = co.credits;
      if (beforeQty < 1) continue;
      if (!sim.command(owner, { c: 'sell', station: source.id, res: item, amount: Math.floor(beforeQty) })) {
        const n = beforeQty - qty(source.storage[owner], item);
        sold += n; if (item === primary) { primarySold += n; primaryRevenue += co.credits - beforeCr; } revenue += co.credits - beforeCr;
      }
    }
    // A funded test company offers a finite, explicit bid (220 cr/unit); no fictional NPC sale.
    if (scenario !== 'A') {
      const stock = Math.floor(qty(destination.storage[owner], primary));
      if (stock > 0 && (destination.listings ?? []).filter(l => l.seller === owner).length < 20) {
        const beforeIds = new Set((destination.listings ?? []).map(l => l.id));
        if (!sim.command(owner, { c: 'list', station: destination.id, item: primary, qty: stock, price: 220 })) {
          const listing = destination.listings!.find(l => !beforeIds.has(l.id))!;
          const beforeCr = co.credits, beforeQty = listing.qty;
          if (buyerEnabled && !sim.command(buyer, { c: 'buyListing', station: destination.id, listing: listing.id, qty: stock })) {
            const n = beforeQty - (destination.listings!.find(l => l.id === listing.id)?.qty ?? 0);
            primarySold += n; sold += n; primaryRevenue += co.credits - beforeCr; revenue += co.credits - beforeCr;
          }
        }
      }
    }
    lastSource = qty(source.storage[owner], primary);
  }
  const lostIds = fleet.filter(s => !sim.st.ships[s.id]).map(s => s.id);
  const replacement = lostIds.reduce((sum, id) => sum + losses[id], 0);
  const operating = co.upkeep?.total.paid ?? 0;
  const otherIncome = co.stats.earned - revenue;
  const debit = startCredits + revenue + otherIncome - co.credits;
  const net = revenue - debit - replacement;
  const route = routeId ? sim.st.logistics?.[routeId] : undefined;
  trials.push({ seed, scenario, seconds: duration, field: field.id, primary, extractedTotal: co.stats.mined,
    primaryExtracted: co.stats.mined * (field.mix?.[primary] ?? 1), arrivedSource, route: route?.stats,
    primaryAtSaleDestination: scenario === 'D' ? route?.stats.delivered ?? 0 : arrivedSource,
    soldTotal: sold, primarySold, realizedRevenue: revenue, primaryRevenue, excludedOtherIncome: otherIncome, escortBasicUpkeep,
    cashOperatingDebit: debit, upkeepPaid: operating, unpaidAccrual: co.upkeep?.acc ?? 0,
    shipLosses: lostIds.length, replacementEstimate: replacement, netCashAfterReplacement: net, netPerGameHour: net * 3600 / duration,
    inOwnStorage: Object.values(sim.st.stations).reduce((n, st) => n + qty(st.storage[owner], primary), 0),
    inFleetCargo: fleet.reduce((n, s) => n + qty(sim.st.ships[s.id]?.cargo, primary), 0),
    unsoldListings: (destination.listings ?? []).filter(l => l.seller === owner && l.item === primary).reduce((n, l) => n + l.qty, 0),
    buyerInventory: qty(destination.storage[buyer], primary), activitySampleSeconds: activity,
    minerStatus: sim.st.groups[group.id]?.status, buyerCashRemaining: sim.st.companies[buyer].credits });
  console.log(`seed=${seed} scenario=${scenario} completed`);
}
const result = { assumptions: `Isolated worlds, normal NPC simulation. All trials start with the same granted capital and starter fleet; one additional miner starts at the field. C adds one corvette; D adds one destroyer, two corvettes, and a managed hauler. D escorts stay with the mining group, not the hauler. A mines Kestrel into Astra; B/C mine Blackgate into Drakeout; D hauls the rare ore to Astra. NPCs buy only their existing market goods. ${buyerEnabled ? 'A separate fixture-funded player offers to buy singular ore at 220 cr/unit whenever it arrives; inventory and cash are finite.' : 'No player purchases the listed rare ore.'} Unsold material is never revenue. Ships and test funds are grants, not earnings. Cash debit includes all player fleet operating costs and any unclassified cash changes; lost ships are charged at the game hull list reference, not a guaranteed replacement quote. Activities are sampled every 10 seconds. No valuation of unsold inventory or initial grants is included in net cash.`, trials };
mkdirSync('artifacts/p971', { recursive: true });
writeFileSync(`artifacts/p971/risk${buyerEnabled ? '' : '-no-buyer'}.json`, JSON.stringify(result, null, 2) + '\n');
