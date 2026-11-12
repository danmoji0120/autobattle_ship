// Escort missions: the escort secures a protective position around its wards and answers threats,
// the wards wait (bounded) for a far escort and keep to its pace. Full scenarios: scripts/escort/scenarios.ts.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import type { V, WGroup, WShip } from '../src/world/types';
import { convoySlot, escortStatus, pickWards, ringSlot } from '../src/world/escort';

const D = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const ships = (sim: WorldSim, g: WGroup) => g.shipIds.map(id => sim.st.ships[id]).filter(Boolean) as WShip[];
const cen = (ss: WShip[]): V => ({ x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, y: 0, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length });

function setup(seed = 7) {
  const sim = WorldSim.create(seed);
  for (const g of Object.values(sim.st.groups)) if (g.owner === 'pirates') { for (const id of g.shipIds) delete sim.st.ships[id]; delete sim.st.groups[g.id]; }
  for (const l of Object.values(sim.st.lairs)) { l.nextBand = 1e12; l.respawnAt = 1e12; }
  const p = sim.addPlayer('호위 시험'); sim.st.companies[p].credits = 1e6;
  const gs = Object.values(sim.st.groups).filter(g => g.owner === p);
  const mining = gs.find(g => g.name.includes('채굴'))!, guard = gs.find(g => g.name.includes('경비'))!;
  const f = sim.st.fields.kestrel;
  return { sim, p, mining, guard, f, astra: sim.st.stations.astra };
}
const go = (sim: WorldSim, p: string, mining: WGroup, guard: WGroup, field: string, focus?: string) => {
  expect(sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id, ...(focus ? { focus } : {}) } } as any)).toBeNull();
  expect(sim.command(p, { c: 'setOp', group: mining.id, op: { k: 'mine', field, deliver: '', sell: true, auto: true } } as any)).toBeNull();
};

describe('escort helpers', () => {
  it('mining escort protects miners, cargo escort the carriers, falls back to everyone', () => {
    const m = { id: 'm' } as WShip, h = { id: 'h' } as WShip, c = { id: 'c' } as WShip;
    const isMiner = (s: WShip) => s === m, isCarrier = (s: WShip) => s === h || s === m;
    expect(pickWards({ k: 'mine', field: 'f', deliver: '' } as any, 'auto', [m, h, c], isMiner, isCarrier)).toEqual([m]);
    expect(pickWards({ k: 'mine', field: 'f', deliver: '' } as any, 'cargo', [m, h, c], isMiner, isCarrier)).toEqual([h]);
    expect(pickWards({ k: 'move', to: { x: 0, y: 0, z: 0 } } as any, 'auto', [m, h, c], isMiner, isCarrier)).toEqual([m, h, c]);
    expect(pickWards({ k: 'mine', field: 'f', deliver: '' } as any, 'work', [h, c], isMiner, isCarrier)).toEqual([h, c]);
  });
  it('convoy slots lead the wards, ring slots surround the centre', () => {
    const c = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 3; i++) expect(convoySlot(i, 3, c, [1, 0]).x).toBeGreaterThan(300);
    const r = [0, 1, 2, 3].map(i => ringSlot(i, 4, c, 900, [0, 1], 0));
    for (const p of r) expect(Math.round(D(p, c))).toBe(900);
    expect(r[0].z).toBeCloseTo(900); // first picket faces the threat direction
  });
  it('status wording covers every phase the player sees', () => {
    const words = ['소실', '경로 차단', '합류 중', '거리 초과', '진형 유지', '광구 경계', '주변 경계', '요격 중', '후퇴 엄호'];
    const all = (['lost', 'blocked', 'join', 'far', 'convoy', 'guard', 'standby', 'intercept', 'cover'] as const).map(p => escortStatus(p, '채굴반')).join('|');
    for (const w of words) expect(all).toContain(w);
  });
});

describe('escort missions in the world', () => {
  it('same station: the escort leads to the field and pickets it while the miners work', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    go(sim, p, mining, guard, f.id);
    let travel = 0, ahead = 0, maxSep = 0, minersAt = -1, escortAt = -1;
    for (let t = 1; t <= 120; t++) {
      sim.tick(1);
      const mc = cen(ships(sim, mining)), ec = cen(ships(sim, guard));
      if (minersAt < 0 && D(mc, f.pos) < f.radius + 300) minersAt = t;
      if (escortAt < 0 && D(ec, f.pos) < f.radius + 900) escortAt = t;
      if (minersAt < 0 && D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800) {
        travel++; maxSep = Math.max(maxSep, D(ec, mc));
        if ((ec.x - mc.x) * (f.pos.x - mc.x) + (ec.z - mc.z) * (f.pos.z - mc.z) > 0) ahead++;
      }
    }
    expect(travel).toBeGreaterThan(10);
    expect(ahead / travel).toBeGreaterThan(0.9);
    expect(maxSep).toBeLessThan(1200);
    expect(escortAt).toBeLessThanOrEqual(minersAt);
    expect(guard.escort?.phase).toBe('guard');
    expect(guard.status).toContain('광구 경계');
  });

  it('far escort: the miners wait docked, undock once it has joined', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 }; }
    go(sim, p, mining, guard, f.id);
    sim.tick(1);
    expect(mining.status).toMatch(/호위 집결 대기 — 경비대 합류까지 약 \d+초/);
    expect(ships(sim, mining).every(s => s.state === 'docked')).toBe(true);
    let undock = -1, sep = -1;
    for (let t = 1; t <= 60 && undock < 0; t++) { sim.tick(1); if (ships(sim, mining).some(s => s.state === 'space')) { undock = t; sep = D(cen(ships(sim, guard)), cen(ships(sim, mining))); } }
    expect(undock).toBeGreaterThan(1);
    expect(sep).toBeLessThanOrEqual(2200);
  });

  it('the wait is bounded: after waitMax the miners leave alone with one warning', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 }; s.vel = { x: 0, y: 0, z: 0 }; }
    go(sim, p, mining, guard, f.id);
    sim.tick(1);
    mining.ward!.waitSince! -= 300;
    sim.tick(1); sim.tick(1);
    expect(ships(sim, mining).some(s => s.state === 'space')).toBe(true);
    expect(sim.st.events.filter(e => e.company === p && /호위 합류 지연/.test(e.text))).toHaveLength(1);
  });

  it('a slow escort sets the pace of the miners', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    for (const s of ships(sim, guard)) delete sim.st.ships[s.id];
    guard.shipIds = [];
    const bc = sim.spawnShip(p, 'battlecruiser', 'std', guard.id, { ...astra.pos }); sim.dockShip(bc, astra); bc.hp = 0.3;
    go(sim, p, mining, guard, f.id);
    let maxV = 0, maxSep = 0;
    for (let t = 1; t <= 120; t++) {
      sim.tick(1);
      const m = ships(sim, mining), mc = cen(m);
      if (D(mc, f.pos) > f.radius + 900 && D(mc, astra.pos) > 800 && m.every(s => s.state === 'space')) {
        for (const s of m) maxV = Math.max(maxV, Math.hypot(s.vel.x, s.vel.z));
        maxSep = Math.max(maxSep, D(bc.pos, mc));
      }
    }
    expect(maxV).toBeLessThanOrEqual(80 * (0.6 + 0.4 * 0.3) * 0.93 + 1);
    expect(maxSep).toBeLessThan(1200);
  });

  it('escort lost or released: the miners keep working and are told once', () => {
    const { sim, p, mining, guard, f } = setup();
    go(sim, p, mining, guard, f.id);
    for (let t = 0; t < 120; t++) sim.tick(1);
    for (const s of ships(sim, guard)) delete sim.st.ships[s.id];
    guard.shipIds = [];
    for (let t = 0; t < 20; t++) sim.tick(1);
    expect(sim.st.events.filter(e => e.company === p && /호위 전력 상실/.test(e.text))).toHaveLength(1);
    expect(guard.status).toContain('호위 전력 상실');
    const m0 = sim.st.companies[p].stats.mined;
    for (let t = 0; t < 300; t++) sim.tick(1);
    expect(sim.st.companies[p].stats.mined).toBeGreaterThan(m0);
    expect(mining.status).not.toMatch(/집결 대기/);
  });

  it('escort order and wait state survive a save/restore', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    for (const s of ships(sim, guard)) { s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: astra.pos.x - 12000, y: 0, z: astra.pos.z + 3000 }; }
    go(sim, p, mining, guard, f.id, 'work');
    sim.tick(1);
    const re = new WorldSim(JSON.parse(sim.serialize()));
    const g2 = re.st.groups[guard.id], m2 = re.st.groups[mining.id];
    expect(g2.op).toEqual({ k: 'escort', group: mining.id, focus: 'work' });
    expect(m2.ward?.waitSince).toBe(mining.ward?.waitSince);
    expect(g2.escort?.phase).toBe(guard.escort?.phase);
    for (let t = 0; t < 150; t++) re.tick(1);
    expect(D(cen(ships(re, g2)), cen(ships(re, m2)))).toBeLessThan(2200);
  });

  it('command validation: bad focus and self/subgroup targets are refused', () => {
    const { sim, p, mining, guard } = setup();
    expect(sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: mining.id, focus: 'nope' } } as any)).toMatch(/오류/);
    const sub = sim.newGroup(p, '하위', guard.id);
    expect(sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: sub.id } } as any)).toMatch(/하위 편대/);
    expect(sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'escort', group: guard.id } } as any)).toMatch(/오류/);
  });

  it('a pirate band warping in is fought by the escort; no miner is lost', () => {
    const { sim, p, mining, guard, f, astra } = setup();
    go(sim, p, mining, guard, f.id);
    for (let t = 0; t < 200 && !(guard.escort?.phase === 'guard' && ships(sim, mining).every(s => D(s.pos, f.pos) < f.radius + 300)); t++) sim.tick(1);
    const dir = { x: f.pos.x - astra.pos.x, z: f.pos.z - astra.pos.z }, l = Math.hypot(dir.x, dir.z);
    const start = { x: f.pos.x + dir.x / l * 9000, y: 0, z: f.pos.z + dir.z / l * 9000 };
    const band = sim.newGroup('pirates', '시험 약탈단', null, { k: 'raid', home: '', target: mining.id } as any);
    band.npc = { role: 'rogue', sys: (sim as any).sysOf(start).id, home: '', homePos: start, template: [], nextRefit: 1e12, born: sim.time } as any;
    (band as any)._nextPick = 1e12;
    sim.spawnShip('pirates', 'corvette', 'gun', band.id, start); sim.spawnShip('pirates', 'corvette', 'gun', band.id, { ...start, x: start.x + 60 });
    let eng: any = null, intercept = false;
    for (let t = 0; t < 400; t++) {
      sim.update(1);
      if (guard.escort?.phase === 'intercept') intercept = true;
      eng ??= Object.values(sim.st.engagements).find(e => e.groupRefs.includes(band.id)) ?? null;
      if (eng?.done || (eng && !sim.st.engagements[eng.id])) break;
    }
    expect(intercept).toBe(true);
    expect(eng?.groupRefs).toContain(guard.id);
    expect(ships(sim, mining)).toHaveLength(2);
  });
});
