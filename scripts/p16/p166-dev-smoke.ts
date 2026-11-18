// P16.6: run with NODE_ENV=development P16_DEV_CARRIER_RELEASE=1
// npx vite-node scripts/p16/p166-dev-smoke.ts
// Runs entirely in memory. No admin-granted equipment, no remote DB, no production save.
import { BATTLE_RULES } from '../../src/sim/world';
import { DEV_CARRIER_RELEASE } from '../../src/content/carrierRelease';
import { CONTENT, gearReleased, hullReleased } from '../../src/content/registry';
import { CARRIER_HULL, CARRIER_MARKETS } from '../../src/content/packs/growth/carrier';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { offersAt } from '../../src/world/blueprints';
import { migrateCarriers } from '../../src/world/industrialGear';

function check(ok: unknown, description: string): asserts ok {
  if (!ok) throw new Error('FAIL P16.6: ' + description);
  console.log('PASS P16.6:', description);
}
check(DEV_CARRIER_RELEASE, 'explicit development-only release active');
check(BATTLE_RULES === 3, 'default new-battle rules = 3');
check(CONTENT.hulls[CARRIER_HULL].preview === true, 'content remains a preview outside the development gate');
check(hullReleased(CARRIER_HULL), 'carrier build/purchase gate opens in development');
for (const id of Object.values(CARRIER_MARKETS).flat()) check(gearReleased(id), 'gear unlocked: ' + id);

const sim = WorldSim.create(166, { ...STANDARD_WORLD });
check(sim.st.carrierV === 1, 'new development worlds receive carrier market marker');
for (const [sid, ids] of Object.entries(CARRIER_MARKETS)) {
  const market = sim.st.stations[sid]?.market;
  for (const id of ids) check(!!market?.[id], 'market ' + sid + ' lists ' + id);
}
const player = sim.addPlayer('P16 개발 검증');
const co = sim.st.companies[player];
co.credits = 20_000_000; // Disposable test fixture budget; never used in a real saved world.
co.rep = 1000;
co.standing = Object.fromEntries(['union','guild','ceres','miners','iron','pirates'].map(f => [f, 100]));
const offers = offersAt(sim.st, sim.st.stations.helios, co);
check(offers.some(o => o.bp.id === 'bp_carrier_dawn'), 'carrier blueprint appears in the public offers list');
const before = sim.storage(sim.st.stations.helios, player).eq_wing_fighter ?? 0;
const buy = sim.command(player, { c: 'buy', station: 'helios', res: 'eq_wing_fighter', amount: 1 });
check(buy === null, 'player buys a craft weapon through the ordinary market command: ' + buy);
check((sim.storage(sim.st.stations.helios, player).eq_wing_fighter ?? 0) > before, 'purchased weapon arrives in player storage');

const serialized = sim.serialize();
const reload = new WorldSim(JSON.parse(serialized), { migrateContent: false, migrateEcon: false });
check(reload.serialize() === serialized, 'world JSON save and restore round trip');

const old = structuredClone(sim.st);
old.carrierV = undefined;
for (const [sid, ids] of Object.entries(CARRIER_MARKETS)) for (const id of ids) delete old.stations[sid]?.market?.[id];
const locked = JSON.stringify({ ships: old.ships, groups: old.groups, companies: old.companies, engagements: old.engagements, events: old.events });
const first = migrateCarriers(old);
check(first.applied && first.markets > 0 && old.carrierV === 1, 'carrier market migration applies on a development save copy');
check(!migrateCarriers(old).applied, 'carrier market migration is idempotent');
check(JSON.stringify({ ships: old.ships, groups: old.groups, companies: old.companies, engagements: old.engagements, events: old.events }) === locked, 'market migration preserves existing assets, events and engagements');
console.log('ALL P16.6 DEV SMOKE CHECKS PASSED');
