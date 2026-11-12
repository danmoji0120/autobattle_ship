// P10: expanded universe, territory, unidentified deposits, per-company intel, faction economies.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { jumps, nextGate, sysAt } from '../src/world/geom';
import { cargoSum, type Cargo } from '../src/world/types';
import { gateOpen, foundingRule, REGION_RULES } from '../src/world/territory';
import { factionEconStep, startConflict, RESERVE, doctrineOf } from '../src/world/factionEcon';
import { localMix, trueMix } from '../src/world/geology';
import { fieldReport, sysLevel, knowsField } from '../src/world/intel';
import { legacyView, applySync, ClientSync, SyncHub, syncMessage, type SyncMsg } from '../src/server/sync';
import { P10_TERRITORY } from '../src/world/worldgen-p10';

const quiet = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e12; } };
const run = (sim: WorldSim, s: number, dt = .5) => { for (let t = 0; t < s; t += dt) sim.update(dt); };

describe('P10 layout', () => {
  it('adds 18 systems, keeps every P9 system, gate and object, and connects everything', () => {
    const p9 = WorldSim.create(11), p10 = WorldSim.create(11, { layout: 'p10' });
    const a = p9.st, b = p10.st;
    expect(Object.keys(b.systems)).toHaveLength(40);
    for (const [id, s] of Object.entries(a.systems)) {
      expect(b.systems[id].idx).toBe(s.idx);
      expect(b.systems[id].origin).toEqual(s.origin);
      for (const g of s.gates) expect(b.systems[id].gates.find(x => x.id === g.id)).toEqual(g);
    }
    for (const id of Object.keys(a.stations)) expect(b.stations[id].pos).toEqual(a.stations[id].pos);
    for (const id of Object.keys(a.fields)) expect(b.fields[id].pos).toEqual(a.fields[id].pos);
    const idx = new Set(Object.values(b.systems).map(s => s.idx));
    expect(idx.size).toBe(40);
    for (const x of Object.keys(b.systems)) for (const y of Object.keys(b.systems)) expect(jumps(b.systems, x, y)).toBeLessThan(99);
    for (const s of Object.values(b.systems)) {
      expect(s.region).toBeDefined();
      for (const g of s.gates) expect(b.systems[g.to].gates.some(e => e.id === g.exit)).toBe(true);
    }
    expect(b.worldLayout).toBe('p10');
    expect(a.factions).toBeUndefined();
    expect(a.fog).toBeUndefined();
  });

  it('assigns 6 factions with capitals and a large uncharted region', () => {
    const w = WorldSim.create(12, { layout: 'p10' }).st;
    const factions = new Set(Object.values(w.systems).map(s => s.faction).filter(Boolean));
    expect(factions.size).toBe(6);
    const uncharted = Object.values(w.systems).filter(s => s.charted === false);
    expect(uncharted.length).toBe(8);
    for (const r of Object.keys(REGION_RULES)) expect(Object.values(P10_TERRITORY).some(t => t.r === r)).toBe(true);
    expect(Object.values(w.stations).filter(s => s.public && s.market).every(s => !!s.faction || !sysAt(w.systems, s.pos)?.faction)).toBe(true);
  });
});

describe('territory rules', () => {
  it('forbids founding in a capital and charges a logged licence elsewhere', () => {
    const sim = WorldSim.create(13, { layout: 'p10' }); quiet(sim);
    const p = sim.addPlayer('개척');
    expect(foundingRule(sim.st, sim.st.systems.ceres, p)).toMatchObject({ ok: false });
    const kiln = foundingRule(sim.st, sim.st.systems.kiln, p);
    expect(kiln).toMatchObject({ ok: true, feeShare: REGION_RULES.industrial.found });
    expect(foundingRule(sim.st, sim.st.systems.cradle, p)).toMatchObject({ ok: true, feeShare: 0 });
    const group = sim.newGroup(p, '공작반'), sys = sim.st.systems.ceres;
    sim.spawnShip(p, 'constructor', 'std', group.id, { x: sys.origin.x + 9000, y: 0, z: 0 });
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'found', at: { x: sys.origin.x + 9000, y: 0, z: 0 }, name: '금지' } })).toMatch(/수도/);
  });

  it('refuses docking at a faction market when standing is hostile', () => {
    const sim = WorldSim.create(14, { layout: 'p10' });
    const p = sim.addPlayer('적대');
    const st = sim.st.stations.p10_bulwark_yard;
    expect(sim.canDock(st, p)).toBe(true);
    sim.st.companies[p].standing = { iron: -40 };
    expect(sim.canDock(st, p)).toBe(false);
    expect(sim.canDock(sim.st.stations.p10_crossroads_bazaar, p)).toBe(true);
  });
});

describe('unidentified deposits', () => {
  it('mines discrete units from the hidden composition and conserves the extracted amount', () => {
    const sim = WorldSim.create(15, { layout: 'p10' }); quiet(sim);
    const p = sim.addPlayer('광부'); sim.st.companies[p].credits = 1e7;
    const f = sim.st.fields.p10_cradle_field, before = f.amount;
    f.regen = 0;
    const group = sim.newGroup(p, '시험 채굴');
    const ship = sim.spawnShip(p, 'miner', 'std', group.id, { x: f.pos.x + 300, y: 0, z: f.pos.z });
    const dock = Object.values(sim.st.stations).find(s => s.public && sysAt(sim.st.systems, s.pos)?.id === 'quiet') ?? sim.st.stations.p9_harbor_port;
    // under fog the deposit must be found first: an unknown field is refused, the arriving ship discovers it
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: f.id, deliver: dock.id, sell: false } })).toBeTruthy();
    run(sim, 2);
    expect(sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: f.id, deliver: dock.id, sell: false } })).toBeNull();
    run(sim, 120);
    const mined = before - f.amount;
    expect(mined).toBeGreaterThan(5);
    const held = cargoSum(ship.cargo) + (ship.mineAcc?.a ?? 0) + cargoSum(dock.storage[p] ?? {});
    expect(Math.abs(held - mined)).toBeLessThan(1e-6);
    for (const v of Object.values(ship.cargo)) expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9);
    const fi = sim.st.intel![p].fields[f.id];
    expect(fi.n).toBe(f.geo!.draws);
    expect(fieldReport(fi).confidence).not.toBe('high');
    expect(fieldReport(fi).unseenMax).toBeGreaterThan(0);
  });

  it('opens rare veins only after long mining, in some zones', () => {
    const w = WorldSim.create(16, { layout: 'p10' }).st;
    const geo = w.fields.p10_deepmine_shaft.geo!;
    expect(localMix(geo, 2).singular_ore).toBeUndefined();
    geo.mined = 9000;
    expect(localMix(geo, 2).singular_ore).toBeGreaterThan(0);
    expect(localMix(geo, 1).singular_ore).toBeUndefined();
    expect(trueMix(geo).rare_ore).toBeGreaterThan(.2);
  });

  it('keeps legacy core fields identified and P9 frontier fields unidentified in P10 only', () => {
    const p9 = WorldSim.create(17).st, p10 = WorldSim.create(17, { layout: 'p10' }).st;
    expect(p9.fields.p9_dusk_vein.mix).toBeDefined();
    expect(p9.fields.p9_dusk_vein.geo).toBeUndefined();
    expect(p10.fields.p9_dusk_vein.geo).toBeDefined();
    expect(p10.fields.p9_dusk_vein.mix).toBeUndefined();
    expect(p10.fields.garden.geo).toBeUndefined();
    expect(p10.fields.p9_anvil_ore.geo).toBeUndefined();
  });
});

describe('per-company intel and replication', () => {
  function view(sim: WorldSim, company: string) {
    return legacyView(sim.st, { company }, 'helios');
  }
  it('never shows another company\'s exploration and redacts deposits', () => {
    const sim = WorldSim.create(18, { layout: 'p10' }); quiet(sim);
    const a = sim.addPlayer('탐사 A'), b = sim.addPlayer('경쟁 B');
    const ga = sim.newGroup(a, '정찰');
    const cradle = sim.st.systems.cradle;
    sim.spawnShip(a, 'corvette', 'gun', ga.id, { x: cradle.origin.x + 9000, y: 0, z: 0 });
    run(sim, 3);
    expect(sysLevel(sim.st, a, 'cradle')).toBe(2);
    expect(sysLevel(sim.st, b, 'cradle')).toBe(0);
    const f = sim.st.fields.p10_cradle_field;
    expect(knowsField(sim.st, a, f)).toBe(true);
    expect(knowsField(sim.st, b, f)).toBe(false);
    const va = view(sim, a), vb = view(sim, b);
    expect(va.fields[f.id]).toBeDefined();
    expect((va.fields[f.id] as any).mix).toBeUndefined();
    expect((va.fields[f.id] as any).geo).toBeUndefined();
    expect(vb.fields[f.id]).toBeUndefined();
    expect(va.systems.cradle.name).toBe(cradle.name);
    // B sees nothing of cradle: not adjacent to anything B visited (quiet is charted, not visited)
    expect(vb.systems.cradle).toBeUndefined();
    expect(Object.keys(va.intel ?? {})).toEqual([a]);
    expect(Object.keys(vb.intel ?? {})).toEqual([b]);
    expect(vb.intel![b].sys.cradle).toBeUndefined();
    expect(JSON.stringify(vb)).not.toContain('p10_cradle_field');
    expect(JSON.stringify(va)).not.toMatch(/"layers"/);
  });

  it('does not leak unknown system names through gate names', () => {
    const sim = WorldSim.create(20, { layout: 'p10' }); quiet(sim);
    const b = sim.addPlayer('B');
    run(sim, 2);
    const vb = view(sim, b), text = JSON.stringify(vb);
    const unknown = Object.values(sim.st.systems).filter(s => sysLevel(sim.st, b, s.id) === 0 && !vb.systems[s.id]);
    expect(unknown.length).toBeGreaterThan(5);
    for (const s of unknown) expect(text).not.toContain(s.name);
    // a charted system bordering unknown space keeps the gate, under a neutral name
    const edge = Object.values(vb.systems).find(s => s.gates.some(g => sysLevel(sim.st, b, g.to) < 1))!;
    expect(edge).toBeDefined();
    expect(edge.gates.filter(g => sysLevel(sim.st, b, g.to) < 1).every(g => g.name === '미확인 점프게이트')).toBe(true);
  });

  it('protocol-2 replication equals the reference view on a fog world', () => {
    const sim = WorldSim.create(19, { layout: 'p10' }); quiet(sim);
    const a = sim.addPlayer('A'), b = sim.addPlayer('B');
    const ga = sim.newGroup(a, '정찰');
    sim.spawnShip(a, 'corvette', 'gun', ga.id, { x: sim.st.systems.mire.origin.x + 9000, y: 0, z: 0 });
    const hub = new SyncHub();
    const cs = { [a]: new ClientSync(), [b]: new ClientSync() };
    const state: Record<string, any> = {};
    for (let i = 0; i < 4; i++) {
      run(sim, 2);
      const frame = hub.frame(sim.st, sim.st.time, 1);
      for (const c of [a, b]) {
        const m = syncMessage(frame, cs[c], { company: c }, 'helios', true);
        state[c] = applySync(state[c] ?? null, JSON.parse(m!) as SyncMsg);
        expect(JSON.parse(JSON.stringify(state[c]))).toEqual(JSON.parse(JSON.stringify(legacyView(sim.st, { company: c }, 'helios'))));
      }
      hub.done(frame);
    }
    expect(state[a].systems.mire.name).toBe(sim.st.systems.mire.name);
    expect(state[b].systems.mire).toBeUndefined();
  });
});

describe('faction economy and conflicts', () => {
  it('draws only real market stock above a reserve and converts it into strength without losing goods', () => {
    const sim = WorldSim.create(20, { layout: 'p10' });
    const w = sim.st, f = w.factions!.iron;
    f.strength = 50; f.infra = doctrineOf('iron').infra;
    const markets = Object.values(w.stations).filter(s => s.faction === 'iron');
    const total = (k: string) => markets.reduce((n, s) => n + (s.market?.[k]?.stock ?? 0), 0);
    const items = Object.keys(doctrineOf('iron').ship);
    const before = Object.fromEntries(items.map(k => [k, total(k)]));
    const heldBefore: Cargo = { ...f.stock }, madeBefore = f.made.ships;
    const strBefore = f.strength;
    factionEconStep(sim, w, 60);
    const built = f.made.ships - madeBefore;
    expect(f.strength).toBeLessThanOrEqual(strBefore + built + 1e-9);
    for (const k of items) {
      const drawn = before[k] - total(k);
      if (k === 'weapon_parts') continue; // also drawn by upkeep
      expect(drawn).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.abs(drawn - (built * (doctrineOf('iron').ship[k]) + (f.stock[k] ?? 0) - (heldBefore[k] ?? 0)))).toBeLessThan(1e-6);
    }
    for (const s of markets) for (const k of items) if (s.market?.[k] && before[k] > 0) expect(s.market[k].stock).toBeGreaterThanOrEqual(Math.min(s.market[k].target * RESERVE, s.market[k].stock) - 1e-9);
  });

  it('a border conflict closes its gates; ships and managed routes detour', () => {
    const sim = WorldSim.create(21, { layout: 'p10' }); quiet(sim);
    const w = sim.st;
    const before = nextGate(w.systems, 'crossroads', 'muster')!;
    expect(before.to).toBe('rampart');
    const c = startConflict(sim, w, 'iron', 'guild', [['crossroads', 'rampart']]);
    const closed = w.systems.crossroads.gates.find(g => g.to === 'rampart')!;
    expect(gateOpen(w, closed)).toBe(false);
    const detour = nextGate(w.systems, 'crossroads', 'muster', g => gateOpen(w, g))!;
    expect(detour.to).not.toBe('rampart');
    const p = sim.addPlayer('운송'), g = sim.newGroup(p, '편대');
    const ship = sim.spawnShip(p, 'corvette', 'gun', g.id, { x: w.systems.crossroads.origin.x + 5000, y: 0, z: 0 });
    sim.command(p, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: w.systems.muster.origin.x + 5000, y: 0, z: 0 } } });
    const visited = new Set<string>();
    for (let t = 0; t < 4000 && sysAt(w.systems, ship.pos)?.id !== 'muster'; t += .5) { sim.update(.5); visited.add(sysAt(w.systems, ship.pos)!.id); }
    expect(sysAt(w.systems, ship.pos)?.id).toBe('muster');
    expect(visited.has('rampart')).toBe(false);
    c.ended = w.time;
    expect(gateOpen(w, closed)).toBe(true);
  });

  it('long-run faction activity is bounded and observable', () => {
    const sim = WorldSim.create(22, { layout: 'p10' });
    for (let t = 0; t < 2 * 3600; t++) sim.tick(1);
    for (const f of Object.values(sim.st.factions!)) {
      const d = doctrineOf(f.id);
      expect(f.strength).toBeLessThanOrEqual(d.strength + 1e-6);
      expect(f.infra).toBeLessThanOrEqual(Math.max(d.infra, f.infra));
      for (const v of Object.values(f.stock)) expect(v).toBeGreaterThanOrEqual(-1e-9);
    }
    for (const s of Object.values(sim.st.stations)) for (const m of Object.values(s.market ?? {})) expect(m.stock).toBeGreaterThanOrEqual(0);
  });
});

describe('company-ops deposit goals', () => {
  function setup(seed: number) {
    const sim = WorldSim.create(seed, { layout: 'p10' }); quiet(sim);
    const p = sim.addPlayer('광구 회사'); sim.st.companies[p].credits = 1e7;
    const f = sim.st.fields.p10_cradle_field;
    const g = sim.newGroup(p, '시험 채굴반');
    for (let i = 0; i < 2; i++) sim.spawnShip(p, 'miner', 'std', g.id, { x: f.pos.x + 600 + i * 50, y: 0, z: f.pos.z });
    run(sim, 3); // the ships are in cradle: the deposit is discovered by visiting
    return { sim, p, f, g };
  }
  it('survey_field test-mines, records only real samples and reports', () => {
    const { sim, p, f, g } = setup(30);
    sim.st.companies[p].ops = { ...(sim.st.companies[p].ops ?? {} as any), policy: { ...(sim.st.companies[p].ops?.policy ?? {} as any), maxRisk: 100 } } as any;
    if (!sim.st.companies[p].ops!.ledger) (sim.st.companies[p].ops as any).ledger = [];
    if (!sim.st.companies[p].ops!.spend) (sim.st.companies[p].ops as any).spend = [];
    expect(sim.command(p, { c: 'workCreate', goal: { k: 'survey_field', field: f.id, group: g.id, samples: 40 } } as any)).toBeNull();
    const w = Object.values(sim.st.works!).find(x => x.kind === 'survey_field')!;
    for (let t = 0; t < 1800 && w.state !== 'done'; t += 1) sim.update(1);
    expect(w.state).toBe('done');
    expect(w.result).toMatch(/표본/);
    const fi = sim.st.intel![p].fields[f.id];
    expect(fi.n).toBeGreaterThanOrEqual(40);
    expect(sim.st.groups[g.id].op.k).toBe('idle');
    // the operation work for the mining order is a child of the goal
    expect(Object.values(sim.st.works!).some(x => x.parent === w.id && x.kind === 'operation')).toBe(true);
  });
  it('a risky deposit asks for approval before sending ships', () => {
    const { sim, p, g } = setup(31);
    const abyss = sim.st.fields.p10_abyss_core;
    sim.st.intel![p].fields[abyss.id] = { found: 0, n: 0, units: {}, first: {}, last: 0 };
    expect(sim.command(p, { c: 'workCreate', goal: { k: 'survey_field', field: abyss.id, group: g.id, samples: 50 } } as any)).toBeNull();
    const w = Object.values(sim.st.works!).find(x => x.kind === 'survey_field')!;
    expect(w.state).toBe('waiting');
    expect(Object.values(sim.st.approvals!).some(a => a.work === w.id && a.kind === 'risk' && a.state === 'open')).toBe(true);
    expect(sim.st.groups[g.id].op.k).not.toBe('mine');
  });
  it('develop_field keeps mining and tracks value; a player re-order pauses it', () => {
    const { sim, p, f, g } = setup(32);
    const ops = sim.st.companies[p].ops; if (ops) ops.policy.maxRisk = 100;
    expect(sim.command(p, { c: 'workCreate', goal: { k: 'develop_field', field: f.id, group: g.id, sell: false, miners: 2 } } as any)).toBeNull();
    const w = Object.values(sim.st.works!).find(x => x.kind === 'develop_field')!;
    run(sim, 600, 1);
    expect(w.rt?.profit ?? 0).toBeGreaterThan(0);
    expect(['running', 'waiting']).toContain(w.state);
    sim.command(p, { c: 'setOp', group: g.id, op: { k: 'idle' } });
    run(sim, 20, 1);
    expect(w.state).toBe('paused');
  });
  it('refuses deposit goals on worlds without exploration intel', () => {
    const sim = WorldSim.create(33); const p = sim.addPlayer('구세계');
    const g = sim.newGroup(p, 'x'); sim.spawnShip(p, 'miner', 'std', g.id, sim.st.fields.garden.pos);
    expect(sim.command(p, { c: 'workCreate', goal: { k: 'survey_field', field: 'garden', group: g.id, samples: 40 } } as any)).toMatch(/P10/);
  });
});
