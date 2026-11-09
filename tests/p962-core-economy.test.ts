import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { queueShortfall } from '../src/world/construction';
import { observeWorld } from '../src/world/observe';
import { STATION_SIZES } from '../src/world/stations';
import type { Size } from '../src/content/schema';
import type { Cargo } from '../src/world/types';

const cases: { size: Size; credits: number; mats: Cargo; oldCredits: number; oldMats: Cargo }[] = [
  { size: 'S', credits: 16_000, mats: { alloy: 600 }, oldCredits: 8_000, oldMats: { alloy: 300 } },
  { size: 'M', credits: 60_000, mats: { alloy: 1_800, structure: 60 }, oldCredits: 20_000, oldMats: { alloy: 600, structure: 20 } },
  { size: 'L', credits: 250_000, mats: { alloy: 7_000, structure: 400, machinery: 150 }, oldCredits: 50_000, oldMats: { alloy: 1_400, structure: 80, machinery: 30 } },
  { size: 'XL', credits: 1_200_000, mats: { alloy: 30_000, structure: 2_000, machinery: 800, electronics: 300 }, oldCredits: 120_000, oldMats: { alloy: 3_000, structure: 200, machinery: 80, electronics: 30 } },
];

function quiet(sim: WorldSim) {
  (sim as any).npcSlow = () => {};
  for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
}
function fixture() {
  const sim = WorldSim.create(962); quiet(sim);
  const p = sim.addPlayer('코어 비용 검증'); sim.st.companies[p].credits = 10_000_000;
  const g = sim.newGroup(p, '공작반'), at = { ...sim.st.systems.quiet.origin, x: sim.st.systems.quiet.origin.x + 10000 };
  const builder = sim.spawnShip(p, 'constructor', 'std', g.id, at);
  return { sim, p, g, at, builder };
}
function until(sim: WorldSim, condition: () => boolean, seconds: number) {
  for (let t = 0; t < seconds && !condition(); t += .25) sim.update(.25);
  expect(condition()).toBe(true);
}
function carry(sim: WorldSim, p: string, group: string, at: { x: number; y: number; z: number }, item: string, amount: number) {
  for (let left = amount; left > 0;) {
    const ship = sim.spawnHull(p, 'hauler_xl', 'hauler_xl_std', undefined, group, { ...at, x: at.x + 500 });
    const load = Math.min(left, 9_000); ship.cargo[item] = load; left -= load;
  }
}

describe('P9.6.2 station foundation terms', () => {
  it('does not alter operating, power, capacity, berth or processing limits', () => {
    const capabilities = Object.fromEntries(Object.entries(STATION_SIZES).map(([size, { work, power, storage, capacity, berth, berths, industrialTier, upkeep, cargoRate }]) =>
      [size, { work, power, storage, capacity, berth, berths, industrialTier, upkeep, cargoRate }]));
    expect(capabilities).toEqual({
      S: { work: 60, power: 20, storage: 4_000, capacity: 8, berth: 'M', berths: 4, industrialTier: 1, upkeep: 100, cargoRate: 12 },
      M: { work: 100, power: 40, storage: 12_000, capacity: 14, berth: 'L', berths: 8, industrialTier: 2, upkeep: 300, cargoRate: 20 },
      L: { work: 180, power: 80, storage: 30_000, capacity: 24, berth: 'L', berths: 14, industrialTier: 3, upkeep: 800, cargoRate: 35 },
      XL: { work: 300, power: 160, storage: 80_000, capacity: 39, berth: 'XL', berths: 24, industrialTier: 4, upkeep: 2_000, cargoRate: 60 },
    });
  });

  it.each(cases)('pre-pays and completes $size only after the exact on-site materials are delivered', ({ size, credits, mats }) => {
    const f = fixture(); let sim = f.sim; const { p, at } = f, g = f.g.id;
    const before = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'setOp', group: g, op: { k: 'found', at, name: `신규 ${size}`, size, foundationMats: { alloy: 1 } } })).toBeNull();
    expect(sim.st.companies[p].credits).toBe(before - credits);
    expect(sim.st.companies[p].foundingEscrow?.[g]).toBe(credits);
    const op = sim.st.groups[g].op; expect(op.k === 'found' && op.foundationMats).toEqual(mats);
    sim.update(.25);
    const site = Object.values(sim.st.stations).find(st => st.owner === p)!;
    expect(site.modules[0].materials).toEqual(mats); expect(site.modules[0].paid).toBe(credits);
    expect(queueShortfall(site)).toEqual(mats); expect(site.modules[0].progress).toBe(0);
    expect(sim.st.companies[p].credits).toBe(before - credits);
    const partial = Math.min(9_000, Math.floor(mats.alloy / 2));
    carry(sim, p, g, at, 'alloy', partial);
    until(sim, () => (site.modules[0].reserved?.alloy ?? 0) === partial, 120);
    expect(site.modules[0].progress).toBe(0);
    const saved = JSON.parse(sim.serialize());
    sim = new WorldSim(saved, { migrateContent: false }); quiet(sim);
    const restored = sim.st.stations[site.id], plan = restored.modules[0];
    expect(plan.paid).toBe(credits); expect(plan.materials).toEqual(mats); expect(plan.reserved?.alloy).toBe(partial);
    expect(queueShortfall(restored)).toEqual({ ...mats, alloy: mats.alloy - partial });
    const consumed: Cargo = {};
    observeWorld(sim.st, e => { if (e.kind === 'consume' && e.reason === 'facility_construction' && e.station === site.id && e.item) consumed[e.item] = (consumed[e.item] ?? 0) + e.amount; });
    for (const [item, amount] of Object.entries(mats)) carry(sim, p, g, at, item, amount - (item === 'alloy' ? partial : 0));
    until(sim, () => plan.built, 800);
    expect(plan.paid).toBe(credits); expect(plan.materials).toEqual(mats);
    for (const [item, amount] of Object.entries(mats)) expect(consumed[item], item).toBeCloseTo(amount, 4);
    expect(sim.st.companies[p].credits + (sim.st.companies[p].upkeep?.total.paid ?? 0)).toBeCloseTo(before - credits, 5);
    expect(sim.st.companies[p].foundingEscrow).toBeUndefined();
  });

  it.each(cases)('preserves P9.6 $size terms for a saved order before the constructor arrives', ({ size, credits, oldCredits, oldMats }) => {
    const { sim, p, g, at } = fixture(), before = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: `기존 ${size}`, size } })).toBeNull();
    const saved = JSON.parse(sim.serialize());
    delete saved.groups[g.id].op.foundationMats;
    saved.companies[p].credits = before - oldCredits;
    saved.companies[p].foundingEscrow[g.id] = oldCredits;
    const unchanged = new WorldSim(structuredClone(saved), { migrateContent: false }); quiet(unchanged); unchanged.update(.25);
    const original = Object.values(unchanged.st.stations).find(st => st.owner === p)!.modules[0];
    expect(original.paid).toBe(oldCredits); expect(original.materials).toEqual(oldMats);
    expect(unchanged.st.companies[p].credits).toBe(before - oldCredits);
    const untrusted = structuredClone(saved); untrusted.groups[g.id].op.foundationMats = { alloy: 1 };
    const oldClient = new WorldSim(untrusted, { migrateContent: false }); quiet(oldClient); oldClient.update(.25);
    expect(Object.values(oldClient.st.stations).find(st => st.owner === p)!.modules[0].materials).toEqual(oldMats);
    const restored = new WorldSim(saved, { migrateContent: false }); quiet(restored);
    expect(restored.st.companies[p].credits).toBe(before - oldCredits);
    expect(restored.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: `기존 ${size}`, size } })).toBeNull();
    expect(restored.st.companies[p].credits).toBe(before - oldCredits);
    const again = new WorldSim(JSON.parse(restored.serialize()), { migrateContent: false }); quiet(again); again.update(.25);
    const plan = Object.values(again.st.stations).find(st => st.owner === p)!.modules[0];
    expect(plan.paid).toBe(oldCredits); expect(plan.materials).toEqual(oldMats);
    expect(again.st.companies[p].credits).toBe(before - oldCredits);
    expect(credits).toBeGreaterThan(oldCredits);
  });

  it('rejects XL with insufficient funds and settles each change using only the difference', () => {
    const { sim, p, g, at, builder } = fixture(), co = sim.st.companies[p];
    co.credits = 1_000_000;
    builder.cargo.alloy = 50;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '자금 부족', size: 'XL' } })).toMatch(/1,200,000/);
    expect(co.credits).toBe(1_000_000); expect(co.foundingEscrow).toBeUndefined(); expect(builder.cargo.alloy).toBe(50);
    co.credits = 2_000_000;
    for (const { size, credits } of [...cases, cases[0]]) {
      expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '규모 변경', size } })).toBeNull();
      expect(co.credits).toBe(2_000_000 - credits); expect(co.foundingEscrow?.[g.id]).toBe(credits);
    }
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(co.credits).toBe(2_000_000); expect(co.foundingEscrow).toBeUndefined();
  });

  it('settles only the difference when a restored old order changes size and refunds it once', () => {
    const { sim, p, g, at } = fixture(), before = sim.st.companies[p].credits;
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '이전 M', size: 'M' } })).toBeNull();
    const saved = JSON.parse(sim.serialize());
    delete saved.groups[g.id].op.foundationMats; saved.companies[p].credits = before - 20_000; saved.companies[p].foundingEscrow[g.id] = 20_000;
    const restored = new WorldSim(saved, { migrateContent: false }); quiet(restored);
    expect(restored.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '새 XL', size: 'XL' } })).toBeNull();
    expect(restored.st.companies[p].credits).toBe(before - 1_200_000);
    expect(restored.st.companies[p].foundingEscrow?.[g.id]).toBe(1_200_000);
    const op = restored.st.groups[g.id].op; expect(op.k === 'found' && op.foundationMats).toEqual(cases[3].mats);
    const again = new WorldSim(JSON.parse(restored.serialize()), { migrateContent: false }); quiet(again);
    expect(again.command(p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(again.st.companies[p].credits).toBe(before);
    expect(again.command(p, { c: 'setOp', group: g.id, op: { k: 'idle' } })).toBeNull();
    expect(again.st.companies[p].credits).toBe(before); expect(again.st.companies[p].foundingEscrow).toBeUndefined();
  });

  it('keeps a partially reserved legacy site and its paid amount intact after restore', () => {
    const { sim, p, g, at } = fixture();
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'found', at, name: '기존 공사', size: 'S' } })).toBeNull();
    sim.update(.25);
    const site = Object.values(sim.st.stations).find(st => st.owner === p)!;
    const plan = site.modules[0]; plan.materials = { alloy: 300 }; plan.paid = 8_000; plan.reserved = { alloy: 100 }; plan.used = { alloy: 0 };
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); quiet(restored);
    const old = restored.st.stations[site.id].modules[0];
    expect(old.paid).toBe(8_000); expect(old.materials).toEqual({ alloy: 300 }); expect(old.reserved).toEqual({ alloy: 100 });
    expect(queueShortfall(restored.st.stations[site.id])).toEqual({ alloy: 200 });
  });
});
