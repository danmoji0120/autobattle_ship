import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg } from '../src/server/protocol';
import { World } from '../src/sim/world';
import type { WGroup } from '../src/world/types';

const run = (sim: WorldSim, seconds: number, dt = 0.25) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };
const near = (sim: WorldSim, x: number, z: number) => ({ x: sim.st.stations.astra.pos.x + x, y: 0, z: sim.st.stations.astra.pos.z + z });
const groupNamed = (sim: WorldSim, owner: string, name: string) => Object.values(sim.st.groups).find(g => g.owner === owner && g.name === name) as WGroup;

describe('persistent world', () => {
  it('a new PMC starts docked at the free port with a small fleet', () => {
    const sim = WorldSim.create(3);
    const p = sim.addPlayer('테스트');
    const ships = Object.values(sim.st.ships).filter(s => s.owner === p);
    expect(ships.length).toBe(5);
    expect(ships.every(s => s.state === 'docked')).toBe(true);
    expect(sim.st.companies[p].credits).toBeGreaterThan(0);
  });

  it('mining orders move ships into the field and turn ore into credits', () => {
    const sim = WorldSim.create(3);
    const p = sim.addPlayer('광부');
    const g = groupNamed(sim, p, '제1 채굴반');
    expect(sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } })).toBeNull();
    const c0 = sim.st.companies[p].credits;
    run(sim, 300);
    const co = sim.st.companies[p];
    expect(co.stats.mined).toBeGreaterThan(200);
    expect(co.credits).toBeGreaterThan(c0);
    expect(sim.st.fields.kestrel.amount).toBeLessThan(sim.st.fields.kestrel.max);
  });

  it('rejects commands on other companies’ assets and invalid orders', () => {
    const sim = WorldSim.create(3);
    const a = sim.addPlayer('A'), b = sim.addPlayer('B');
    const ga = groupNamed(sim, a, '제1 채굴반');
    expect(sim.command(b, { c: 'setOp', group: ga.id, op: { k: 'idle' } })).not.toBeNull();
    const guard = groupNamed(sim, a, '경비대');
    expect(sim.command(a, { c: 'setOp', group: guard.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } })).toMatch(/채굴선/);
    expect(sim.command(a, { c: 'buyShip', station: 'helios', classId: 'battleship', loadoutId: 'std' })).toMatch(/평판/);
  });

  it('a constructor founds a station and builds its docking hub', () => {
    const sim = WorldSim.create(4);
    const p = sim.addPlayer('건설사');
    sim.st.companies[p].credits = 60000;
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })).toBeNull();
    const cg = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id].classId === 'constructor'))!;
    expect(sim.command(p, { c: 'setOp', group: cg.id, op: { k: 'found', at: near(sim, 2600, 2600), name: '시험기지' } })).toBeNull();
    // prevent pirates from interfering with this test
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e9; }
    run(sim, 200);
    const st = Object.values(sim.st.stations).find(s => s.owner === p)!;
    expect(st).toBeTruthy();
    expect(st.modules.find(m => m.kind === 'core')!.built).toBe(true);
    expect(sim.st.companies[p].milestones).toContain('station');
  });

  it('pirate encounters become battles whose results persist on the PMC', () => {
    const sim = WorldSim.create(5);
    const p = sim.addPlayer('용병');
    sim.st.systems.astra.security = 0; // no Union forces: this test is about the player's own fight
    const guard = groupNamed(sim, p, '경비대');
    // spawn a pirate band next to the guard group
    const pg = sim.newGroup('pirates', '시험 무리', null, { k: 'raid', home: 'redclaw' });
    for (const [c, l] of [['corvette', 'gun'], ['corvette', 'torp']]) sim.spawnShip('pirates', c, l, pg.id, near(sim, 600, -2600));
    sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'attack', group: pg.id } });
    let eng: string | undefined;
    for (let i = 0; i < 2400 && !eng; i++) { sim.update(0.25); eng = Object.values(sim.st.engagements).find(e => e.sides[0].includes(p))?.id; }
    expect(eng).toBeTruthy();
    const e = sim.st.engagements[eng!];
    expect(e.live).toBe(true);
    for (let i = 0; i < 4000 && !e.done; i++) sim.update(0.25);
    expect(e.done).toBe(true);
    const ships = Object.values(sim.st.ships).filter(s => s.owner === p && ECON_MIL.has(s.classId));
    // either some hull damage persisted or ships were lost — the battle changed the PMC
    expect(ships.some(s => s.hp < 1) || ships.length < 3).toBe(true);
    expect(sim.st.events.some(ev => ev.kind === 'battle' && ev.text.startsWith('전투 종료'))).toBe(true);
  });

  it('save/load round-trips the world, including a battle in progress', () => {
    const sim = WorldSim.create(6);
    const p = sim.addPlayer('세이브');
    sim.st.systems.astra.security = 0;
    const guard = groupNamed(sim, p, '경비대');
    const pg = sim.newGroup('pirates', '시험 무리', null, { k: 'raid', home: 'redclaw' });
    sim.spawnShip('pirates', 'corvette', 'gun', pg.id, near(sim, 500, -2500));
    sim.command(p, { c: 'setOp', group: guard.id, op: { k: 'attack', group: pg.id } });
    for (let i = 0; i < 2400 && !Object.values(sim.st.engagements).some(e => !e.done); i++) sim.update(0.25);
    const e = Object.values(sim.st.engagements).find(x => !x.done)!;
    sim.update(2);
    const json = sim.serialize();
    const restored = new WorldSim(JSON.parse(json));
    expect(restored.time).toBeCloseTo(sim.time, 5);
    expect(restored.battles.get(e.id)!.tick).toBe(sim.battles.get(e.id)!.tick);
    expect(restored.battles.get(e.id)!.digest()).toBe(sim.battles.get(e.id)!.digest());
    run(sim, 30); run(restored, 30);
    expect(restored.st.companies[p].credits).toBeCloseTo(sim.st.companies[p].credits, 3);
  });
});

const ECON_MIL = new Set(['corvette', 'destroyer', 'cruiser', 'battleship']);

describe('authoritative server', () => {
  const conn = (id: string, inbox: ServerMsg[]): Conn => ({ id, lastEvent: 0, battles: new Set(), send: m => inbox.push(JSON.parse(JSON.stringify(m))) });

  it('two clients share one world, own separate PMCs and reconnect by token', () => {
    const srv = new GameServer(null, { singleplayer: false, snapInterval: 0.5 }, 9);
    const ia: ServerMsg[] = [], ib: ServerMsg[] = [];
    srv.connect(conn('a', ia)); srv.connect(conn('b', ib));
    srv.handle('a', { t: 'hello', name: 'A사' }); srv.handle('b', { t: 'hello', name: 'B사' });
    const wa = ia.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    const wb = ib.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }>;
    expect(wa.company).not.toBe(wb.company);
    srv.step(0.6);
    const snapB = [...ib].reverse().find(m => m.t === 'snap') as Extract<ServerMsg, { t: 'snap' }>;
    expect(Object.values(snapB.state.ships).some(s => s.owner === wa.company)).toBe(true);
    // B cannot see A's private radio
    const gA = Object.values(srv.sim.st.groups).find(g => g.owner === wa.company && g.name === '제1 채굴반')!;
    srv.handle('a', { t: 'cmd', id: 1, cmd: { c: 'setOp', group: gA.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } });
    srv.step(0.6);
    const evB = ib.filter(m => m.t === 'events').flatMap(m => (m as any).list);
    expect(evB.some((e: any) => e.company === wa.company)).toBe(false);
    // reconnect
    srv.disconnect('a');
    const ic: ServerMsg[] = [];
    srv.connect(conn('c', ic));
    srv.handle('c', { t: 'hello', name: 'whatever', token: wa.token });
    expect((ic.find(m => m.t === 'welcome') as any).company).toBe(wa.company);
  });

  it('battle orders are stamped ahead and replay deterministically on clients', () => {
    const srv = new GameServer(null, { singleplayer: false, snapInterval: 0.5 }, 11);
    const inbox: ServerMsg[] = [];
    srv.connect(conn('a', inbox));
    srv.handle('a', { t: 'hello', name: '지휘' });
    srv.sim.st.systems.astra.security = 0;
    const me = (inbox.find(m => m.t === 'welcome') as any).company as string;
    const sim = srv.sim;
    const guard = Object.values(sim.st.groups).find(g => g.owner === me && g.name === '경비대')!;
    const pg = sim.newGroup('pirates', '시험', null, { k: 'raid', home: 'redclaw' });
    sim.spawnShip('pirates', 'corvette', 'gun', pg.id, near(sim, 500, -2500));
    sim.spawnShip('pirates', 'corvette', 'torp', pg.id, near(sim, 520, -2520));
    sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'attack', group: pg.id } });
    for (let i = 0; i < 2400 && !Object.values(sim.st.engagements).some(e => !e.done); i++) srv.step(0.25);
    const e = Object.values(sim.st.engagements).find(x => !x.done)!;
    srv.handle('a', { t: 'bjoin', eng: e.id });
    const init = inbox.find(m => m.t === 'binit') as Extract<ServerMsg, { t: 'binit' }>;
    const sw = sim.battles.get(e.id)!;
    const myGroup = sw.groups.find(g => g.ref === guard.id)!;
    srv.step(0.2);
    srv.handle('a', { t: 'border', id: 5, eng: e.id, groupId: myGroup.id, order: { type: 'retreat' }, opts: {} });
    const ack = inbox.find(m => m.t === 'ack' && m.id === 5) as any;
    expect(ack.err).toBeNull();
    const stamped = inbox.find(m => m.t === 'border') as Extract<ServerMsg, { t: 'border' }>;
    expect(stamped.rec.tick).toBeGreaterThanOrEqual(sw.tick);
    // a client rebuilds the battle from the setup + stamped orders and must match the authority
    const client = new World(init.setup);
    client.scheduleReplay([...init.orders, stamped.rec].map(o => ({ ...o })));
    for (let i = 0; i < 200; i++) srv.step(0.05);
    const target = sw.outcome ? Infinity : sw.tick;
    while (client.tick < target && !client.outcome) client.step();
    if (!sw.outcome) expect(client.digest()).toBe(sw.digest());
    else expect(client.outcome?.winner).toBe(sw.outcome.winner);
    // nobody else can command this group
    srv.connect(conn('x', []));
    srv.handle('x', { t: 'hello', name: '타사' });
    expect(sim.battleOrder(Object.keys(sim.st.companies).find(c => c !== me && sim.st.companies[c].kind === 'player')!, e.id, myGroup.id, { type: 'engage' }, {})).not.toBeNull();
  });
});
