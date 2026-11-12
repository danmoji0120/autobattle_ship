// BB / BB-EX are account-exclusive: one commander and one ship in the whole world, bound to one
// verified account. These tests are the ten required scenarios of the ownership rule.
import { describe, it, expect } from 'vitest';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg, SaveFile } from '../src/server/protocol';
import { legacyView } from '../src/server/sync';
import { CONTENT, isExclusive } from '../src/content/registry';
import { validateContent } from '../src/content/validate';
import { BBEX_HULL, BBEX_PRESET, BBEX_VARIANT } from '../src/content/packs/bbex';
import { BBEX_CLASS, BBEX_MOUNTS, BB_COMMANDER } from '../src/sim/bbex/data';
import { SHIP_CLASSES } from '../src/sim/data/ships';
import { COMMANDERS } from '../src/sim/data/commanders';
import { EQUIPMENT, RECIPES, TECHS } from '../src/world/industry';
import { generateCommander } from '../src/world/data';
import { yardHulls } from '../src/world/hullops';
import { BBEX_SHIP_ID, BB_COMMANDER_ID, EXCLUSIVE_RECOVER_S, enforceExclusive, isExclusiveEquip } from '../src/world/exclusive';
import { Rng } from '../src/sim/rng';
import type { WorldSim } from '../src/world/sim';

const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222', THIRD = '33333333-3333-4333-8333-333333333333';
const mk = (save: SaveFile | null = null, owner: string | undefined = OWNER) => new GameServer(save, { singleplayer: false, accounts: true, snapInterval: 0.5, ...(owner ? { exclusiveOwner: owner } : {}) }, 7);
const conn = (id: string, account?: string) => { const inbox: ServerMsg[] = []; const c: Conn = { id, account, lastEvent: 0, battles: new Set(), send: m => inbox.push(JSON.parse(JSON.stringify(m))) }; return { c, inbox }; };
function join(srv: GameServer, id: string, account: string, pmc: string) {
  const x = conn(id, account); srv.connect(x.c);
  srv.handle(id, { t: 'hello', name: 'ignored', token: 'ignored' });
  if (x.inbox.some(m => m.t === 'needPmc')) srv.handle(id, { t: 'createPmc', name: pmc });
  return x;
}
let seq = 1;
const cmd = (srv: GameServer, id: string, x: { inbox: ServerMsg[] }, c: Record<string, unknown>) => {
  const n = seq++; srv.handle(id, { t: 'cmd', id: n, cmd: c as never });
  const ack = x.inbox.find(m => m.t === 'ack' && (m as { id: number }).id === n) as { err?: string | null } | undefined;
  return ack?.err ?? null;
};
const census = (sim: WorldSim) => ({
  ships: Object.values(sim.st.ships).filter(s => s.classId === BBEX_CLASS || isExclusive(s.hull)),
  cmdrs: Object.values(sim.st.commanders).filter(c => c.causal || c.id === BB_COMMANDER_ID),
});
const world = () => { const srv = mk(); const a = join(srv, 'a', OWNER, '오너 PMC'); const b = join(srv, 'b', OTHER, '다른 PMC'); return { srv, a, b, A: srv.companyOf(OWNER)!, B: srv.companyOf(OTHER)! }; };

describe('1–2. grant: the owner account gets exactly one BB and one BB-EX, nobody else', () => {
  it('grants on PMC creation, fully fitted and docked', () => {
    const { srv, A, B } = world();
    const { ships, cmdrs } = census(srv.sim);
    expect(ships.map(s => [s.id, s.owner])).toEqual([[BBEX_SHIP_ID, A]]);
    expect(cmdrs.map(c => [c.id, c.owner])).toEqual([[BB_COMMANDER_ID, A]]);
    const s = ships[0];
    expect(s.hull).toBe(BBEX_HULL); expect(s.variant).toBe(BBEX_VARIANT); expect(s.state).toBe('docked');
    expect(Object.keys(s.fitting!.hp)).toHaveLength(45);
    expect(Object.keys(s.fitting!.bay)).toHaveLength(8);
    const g = srv.sim.st.groups[s.groupId];
    expect(g.owner).toBe(A); expect(g.commanderId).toBe(BB_COMMANDER_ID);
    expect(Object.values(srv.sim.st.ships).some(x => x.owner === B && x.classId === BBEX_CLASS)).toBe(false);
    expect(srv.sim.st.exclusive!.bbex!.account).toBe(OWNER);
  });
  it('without a configured owner nothing is granted, and a non-owner PMC never triggers a grant', () => {
    const srv = mk(null, '');
    join(srv, 'a', OWNER, '오너 PMC'); join(srv, 'b', OTHER, '다른 PMC');
    expect(census(srv.sim).ships).toHaveLength(0); expect(census(srv.sim).cmdrs).toHaveLength(0);
    expect(srv.grantExclusive()).toBe('unconfigured');
    const srv2 = mk();
    join(srv2, 'b', OTHER, '다른 PMC');
    expect(census(srv2.sim).ships).toHaveLength(0);
    expect(srv2.grantExclusive()).toBe('no-company');   // the owner has no PMC yet: stays pending
    join(srv2, 'a', OWNER, '오너 PMC');
    expect(census(srv2.sim).ships.map(s => s.owner)).toEqual([srv2.companyOf(OWNER)]);
  });
  it('the owner is identified by the verified account only (names and messages cannot claim it)', () => {
    const srv = mk();
    join(srv, 'b', OTHER, 'BB');             // a PMC that calls itself BB
    const x = conn('anon'); srv.connect(x.c);
    srv.handle('anon', { t: 'hello', name: 'BB', token: OWNER });
    srv.handle('anon', { t: 'createPmc', name: OWNER });
    expect(census(srv.sim).ships).toHaveLength(0);
  });
});

describe('3. nobody can build, buy, recruit, sell or strip it — refused by the server', () => {
  it('other players', () => {
    const { srv, b, B } = world();
    const sim = srv.sim;
    Object.assign(sim.st.companies[B], { credits: 1e9, rep: 1e6 });
    const own = Object.values(sim.st.stations).find(x => x.owner === B)?.id ?? 'astra';
    for (const c of [
      { c: 'buyShip', station: 'helios', classId: BBEX_CLASS, loadoutId: 'angel' },
      { c: 'buyShip', station: 'helios', classId: 'cruiser', loadoutId: 'multi', hull: BBEX_HULL },
      { c: 'buyShip', station: 'helios', classId: 'cruiser', loadoutId: 'multi', hull: BBEX_HULL, variant: BBEX_VARIANT, preset: BBEX_PRESET },
      { c: 'buildShip', station: own, classId: BBEX_CLASS, loadoutId: 'angel' },
      { c: 'buildShip', station: own, classId: 'cruiser', loadoutId: 'multi', hull: BBEX_HULL },
      { c: 'hire', commander: BB_COMMANDER_ID },
      { c: 'dismiss', commander: BB_COMMANDER_ID },
      { c: 'moveShip', ship: BBEX_SHIP_ID, group: Object.values(sim.st.groups).find(g => g.owner === B)!.id },
      { c: 'listShip', ship: BBEX_SHIP_ID, price: 100 },
      { c: 'assignCmd', group: Object.values(sim.st.groups).find(g => g.owner === B)!.id, commander: BB_COMMANDER_ID },
      { c: 'reserve', ship: BBEX_SHIP_ID, on: true },
    ]) expect(cmd(srv, 'b', b, c), JSON.stringify(c)).toBeTruthy();
    // exclusive equipment cannot be fitted to another ship, produced or traded
    const mine = Object.values(sim.st.ships).find(s => s.owner === B && s.classId === 'destroyer')!;
    expect(cmd(srv, 'b', b, { c: 'fitShip', ship: mine.id, variant: mine.variant, hp: { [Object.keys(mine.fitting?.hp ?? { hp01: 1 })[0]]: 'eq_dcp_omega' }, bay: {}, buy: true })).toBeTruthy();
    expect(cmd(srv, 'b', b, { c: 'buy', station: 'helios', res: 'eq_abyss_lance', amount: 1 })).toBeTruthy();
    expect(cmd(srv, 'b', b, { c: 'prodOrder', station: own, recipe: 'eq_dcp_omega', n: 1 })).toBeTruthy();
    const { ships, cmdrs } = census(sim);
    expect(ships).toHaveLength(1); expect(cmdrs).toHaveLength(1);
    expect(ships[0].owner).not.toBe(B); expect(cmdrs[0].owner).not.toBe(B);
    expect(Object.values(sim.st.ships).some(s => s.owner === B && Object.values(s.fitting?.hp ?? {}).some(isExclusiveEquip))).toBe(false);
  });
  it('the owner cannot sell, transfer, dismiss, refit or duplicate it either', () => {
    const { srv, a, A } = world();
    const sim = srv.sim;
    Object.assign(sim.st.companies[A], { credits: 1e9, rep: 1e6 });
    const s = sim.st.ships[BBEX_SHIP_ID];
    expect(cmd(srv, 'a', a, { c: 'listShip', ship: BBEX_SHIP_ID, price: 5000 })).toBeTruthy();
    expect(cmd(srv, 'a', a, { c: 'dismiss', commander: BB_COMMANDER_ID })).toBeTruthy();
    expect(cmd(srv, 'a', a, { c: 'fitShip', ship: BBEX_SHIP_ID, variant: BBEX_VARIANT, hp: {}, bay: {} })).toBeTruthy();
    expect(cmd(srv, 'a', a, { c: 'refit', ship: BBEX_SHIP_ID, loadoutId: 'x' })).toBeTruthy();
    expect(cmd(srv, 'a', a, { c: 'buildShip', station: 'astra', classId: BBEX_CLASS, loadoutId: 'angel' })).toBeTruthy();
    expect(cmd(srv, 'a', a, { c: 'buyShip', station: 'helios', classId: BBEX_CLASS, loadoutId: 'angel' })).toBeTruthy();
    expect(Object.keys(s.fitting!.hp)).toHaveLength(45);
    // but it is an ordinary ship of the fleet otherwise: regroup it, assign BB elsewhere and back
    const g2 = Object.values(sim.st.groups).find(g => g.owner === A && g.id !== s.groupId)!;
    expect(cmd(srv, 'a', a, { c: 'moveShip', ship: BBEX_SHIP_ID, group: g2.id })).toBeNull();
    expect(cmd(srv, 'a', a, { c: 'assignCmd', group: g2.id, commander: BB_COMMANDER_ID })).toBeNull();
    expect(sim.st.ships[BBEX_SHIP_ID].groupId).toBe(g2.id);
    expect(census(sim).ships).toHaveLength(1);
  });
  it('the engine itself refuses to spawn the hull outside the grant', () => {
    const { srv, B } = world();
    const g = Object.values(srv.sim.st.groups).find(x => x.owner === B)!;
    expect(() => srv.sim.spawnShip(B, BBEX_CLASS, 'angel', g.id, { x: 0, y: 0, z: 0 })).toThrow();
    expect(() => srv.sim.spawnHull(B, BBEX_HULL, BBEX_VARIANT, BBEX_PRESET, g.id, { x: 0, y: 0, z: 0 })).toThrow();
  });
});

describe('4. it is outside the content economy: no blueprint, recipe, research, sale, drop or recruit pool', () => {
  it('content validates and nothing references it', () => {
    expect(validateContent(CONTENT).filter(i => i.level === 'error')).toEqual([]);
    const h = CONTENT.hulls[BBEX_HULL];
    expect(h.exclusive).toBe(true); expect(h.sale).toBeUndefined(); expect(h.build).toBeUndefined();
    expect(Object.values(CONTENT.blueprints).filter(b => b.target.id === BBEX_HULL || b.target.id === BBEX_VARIANT || isExclusive(b.target.id))).toEqual([]);
    const ex = [...CONTENT.exclusive].filter(id => EQUIPMENT[id]);
    expect(ex).toHaveLength(6 + 8);
    for (const id of ex) {
      expect(RECIPES[id], id).toBeUndefined();
      expect(Object.values(RECIPES).some(r => r.out[id] || r.in[id]), id).toBe(false);
      expect(EQUIPMENT[id].tech, id).toBeUndefined();
      expect(Object.values(TECHS).some(t => JSON.stringify(t).includes(id)), id).toBe(false);
    }
    // every catalogue the game enumerates: classes, the commander roster, public yards, presets of other hulls
    expect(Object.keys(SHIP_CLASSES)).not.toContain(BBEX_CLASS);
    expect(SHIP_CLASSES[BBEX_CLASS].loadouts[0].mounts).toHaveLength(45);
    expect(COMMANDERS.some(c => c.id === BB_COMMANDER.id || c.causal)).toBe(false);
    expect(Object.values(CONTENT.legacy).some(l => l.hull === BBEX_HULL || l.classId === BBEX_CLASS)).toBe(false);
    expect(Object.values(CONTENT.presets).filter(p => p.hull !== BBEX_HULL && Object.values(p.weapons).some(w => CONTENT.exclusive.has(w)))).toEqual([]);
    expect(BBEX_MOUNTS).toHaveLength(45);
  });
  it('no public yard stocks it, no generated commander is BB, pirate wrecks never carry its equipment', () => {
    const srv = mk(null, '');
    for (const st of Object.values(srv.sim.st.stations)) { expect(yardHulls(st)).not.toContain(BBEX_HULL); expect(Object.keys(st.shipStock ?? {})).not.toContain(BBEX_HULL); }
    const rng = new Rng(5);
    for (let i = 0; i < 2000; i++) { const c = generateCommander(rng, 1 + (i % 5)); expect((c as { causal?: boolean }).causal).toBeUndefined(); expect(c.name).not.toBe('BB'); }
    for (const c of Object.values(SHIP_CLASSES)) for (const l of c.loadouts) for (const m of l.mounts) expect(isExclusiveEquip(`eq_${m.weapon}`)).toBe(false);
  });
});

describe('5–7. restart, repeated grants and save/load keep one owner and one copy', () => {
  it('duplicate grant requests never clone', () => {
    const { srv, A } = world();
    for (let i = 0; i < 20; i++) expect(srv.grantExclusive()).toBe('present');
    for (let i = 0; i < 5; i++) join(srv, `a${i}`, OWNER, '무시');   // more tabs of the owner
    for (let i = 0; i < 5; i++) expect(srv.sim.grantExclusive(OWNER, A)).toBe('present');
    const { ships, cmdrs } = census(srv.sim);
    expect(ships).toHaveLength(1); expect(cmdrs).toHaveLength(1);
  });
  it('ownership never moves to another account, by grant or by a changed setting', () => {
    const { srv, A, B } = world();
    expect(srv.sim.grantExclusive(OTHER, B)).toBe('bound-elsewhere');
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    const srv2 = mk(save, OTHER);                       // operator points the setting at someone else
    expect(srv2.grantExclusive()).toBe('bound-elsewhere');
    const { ships, cmdrs } = census(srv2.sim);
    expect(ships.map(s => s.owner)).toEqual([A]); expect(cmdrs.map(c => c.owner)).toEqual([A]);
  });
  it('survives restart and save/load exactly; a restart with the setting removed keeps it too', () => {
    const { srv, A } = world();
    for (let i = 0; i < 40; i++) srv.step(0.5);
    const before = JSON.stringify(srv.sim.st.ships[BBEX_SHIP_ID].fitting);
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    for (const owner of [OWNER, '']) {
      const srv2 = mk(JSON.parse(JSON.stringify(save)), owner);
      const { ships, cmdrs } = census(srv2.sim);
      expect(ships.map(s => [s.id, s.owner])).toEqual([[BBEX_SHIP_ID, A]]);
      expect(cmdrs.map(c => [c.id, c.owner, c.causal])).toEqual([[BB_COMMANDER_ID, A, true]]);
      expect(JSON.stringify(srv2.sim.st.ships[BBEX_SHIP_ID].fitting)).toBe(before);
      join(srv2, 'a', OWNER, '무시');
      for (let i = 0; i < 20; i++) srv2.step(0.5);
      expect(census(srv2.sim).ships).toHaveLength(1);
      // a second save/load generation
      const srv3 = mk(JSON.parse(JSON.stringify(srv2.snapshotFile())), owner);
      expect(census(srv3.sim).ships.map(s => s.owner)).toEqual([A]);
    }
  });
  it('a tampered save cannot smuggle in a copy, a foreign owner or loose exclusive equipment', () => {
    const { srv, A, B } = world();
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    const w = save.world;
    const real = w.ships[BBEX_SHIP_ID];
    const gB = Object.values(w.groups).find(g => g.owner === B)!;
    w.ships.clone1 = { ...JSON.parse(JSON.stringify(real)), id: 'clone1', owner: B, groupId: gB.id }; gB.shipIds.push('clone1');
    w.ships.clone2 = { ...JSON.parse(JSON.stringify(real)), id: 'clone2', owner: A };
    w.commanders.fake = { ...JSON.parse(JSON.stringify(w.commanders[BB_COMMANDER_ID])), id: 'fake', owner: B };
    w.stations.astra.storage[B] = { ...(w.stations.astra.storage[B] ?? {}), eq_dcp_omega: 3, eq_purple_rain: 9 };
    const victim = Object.values(w.ships).find(s => s.owner === B && s.fitting && s.id !== 'clone1')!;
    victim.fitting!.hp[Object.keys(victim.fitting!.hp)[0]] = 'eq_abyss_lance';
    const srv2 = mk(save);
    const sim = srv2.sim;
    expect(census(sim).ships.map(s => [s.id, s.owner])).toEqual([[BBEX_SHIP_ID, A]]);
    expect(census(sim).cmdrs.map(c => [c.id, c.owner])).toEqual([[BB_COMMANDER_ID, A]]);
    expect(Object.keys(sim.st.stations.astra.storage[B]).some(isExclusiveEquip)).toBe(false);
    expect(Object.values(sim.st.ships[victim.id].fitting!.hp).some(isExclusiveEquip)).toBe(false);
    expect(gB.id in sim.st.groups && sim.st.groups[gB.id].shipIds.includes('clone1')).toBe(false);
    // stealing the real one by editing its owner: it goes back
    const save2 = JSON.parse(JSON.stringify(srv2.snapshotFile())) as SaveFile;
    save2.world.ships[BBEX_SHIP_ID].owner = B; save2.world.commanders[BB_COMMANDER_ID].owner = B;
    const srv3 = mk(save2);
    expect(census(srv3.sim).ships.map(s => s.owner)).toEqual([A]);
    expect(census(srv3.sim).cmdrs.map(c => c.owner)).toEqual([A]);
    expect(enforceExclusive(srv3.sim.st)).toBe(0);
  });
});

describe('8. destroyed in battle: the same hull recovers, nothing drops, never a second one', () => {
  it('goes to the home port in recovery, cannot depart, comes back as the same ship', () => {
    const { srv, a, A } = world();
    const sim = srv.sim, st = sim.st;
    const s = st.ships[BBEX_SHIP_ID];
    // put it into a fight against a pirate band and let the authority decide it is lost
    const home = st.stations[st.companies[A].homeStation];
    s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: home.pos.x + 9000, y: 0, z: home.pos.z };
    const pg = sim.newGroup('pirates', '시험 해적단');
    sim.spawnShip('pirates', 'corvette', 'gun', pg.id, { x: s.pos.x + 300, y: 0, z: s.pos.z });
    const e = sim.createEngagement(s.pos, [pg], [st.groups[s.groupId]]);
    const fieldsBefore = Object.keys(st.fields).length;
    (sim as unknown as { finishEngagement(e: unknown, r: unknown, t: boolean): void }).finishEngagement(e, { winner: 1, ships: [{ ref: BBEX_SHIP_ID, dead: true, hp: 0, escaped: false, dmg: 0 }], groupKills: new Map() }, true);
    const after = st.ships[BBEX_SHIP_ID];
    expect(after).toBeDefined(); expect(after.owner).toBe(A); expect(after.state).toBe('docked');
    expect(after.recover!.until).toBeGreaterThan(sim.time);
    expect(st.exclusive!.bbex!.state).toBe('recovering');
    expect(st.commanders[BB_COMMANDER_ID].owner).toBe(A);
    expect(st.commanders[BB_COMMANDER_ID].injuredUntil).toBeGreaterThan(sim.time);   // BB is hurt, not gone, not for hire
    expect(Object.values(st.commanders).filter(c => c.owner === null && (c.causal || c.name === 'BB'))).toEqual([]);
    expect(Object.keys(st.fields).length).toBe(fieldsBefore);                           // no wreck field, no salvage
    expect(Object.values(st.stations).some(x => Object.values(x.storage).some(c => Object.keys(c).some(k => k.startsWith('bpf:') && k.includes('bbex'))))).toBe(false);
    expect(census(sim).ships).toHaveLength(1);
    // while recovering: no second hull by any route, and it stays in port
    expect(srv.grantExclusive()).toBe('present');
    expect(cmd(srv, 'a', a, { c: 'buildShip', station: 'astra', classId: BBEX_CLASS, loadoutId: 'angel' })).toBeTruthy();
    cmd(srv, 'a', a, { c: 'setOp', group: after.groupId, op: { k: 'move', to: { x: home.pos.x + 4000, y: 0, z: home.pos.z } } });
    for (let i = 0; i < 60; i++) srv.step(0.5);
    expect(st.ships[BBEX_SHIP_ID].state).toBe('docked');
    expect(census(sim).ships).toHaveLength(1);
    // a restart in the middle of recovery changes nothing
    const srv2 = mk(JSON.parse(JSON.stringify(srv.snapshotFile())));
    expect(census(srv2.sim).ships.map(x => [x.id, !!x.recover])).toEqual([[BBEX_SHIP_ID, true]]);
    // recovery completes: the same id, whole again
    srv2.sim.st.time += EXCLUSIVE_RECOVER_S;
    for (let i = 0; i < 8; i++) srv2.step(0.5);
    const back = srv2.sim.st.ships[BBEX_SHIP_ID];
    expect(back.recover).toBeUndefined(); expect(back.hp).toBe(1);
    expect(srv2.sim.st.exclusive!.bbex!.state).toBe('active'); expect(srv2.sim.st.exclusive!.bbex!.losses).toBe(1);
    expect(census(srv2.sim).ships).toHaveLength(1);
  });
});

describe('9–10. others can meet and watch it; it fights with all its systems under BB', () => {
  it('a world battle: BB-EX fights pirates with its exotic systems, others can spectate, the ledger is never sent', () => {
    const { srv, b, A, B } = world();
    const sim = srv.sim, st = sim.st;
    const s = st.ships[BBEX_SHIP_ID];
    const home = st.stations[st.companies[A].homeStation];
    s.state = 'space'; s.task = { k: 'none' }; s.pos = { x: home.pos.x + 9000, y: 0, z: home.pos.z };
    const pg = sim.newGroup('pirates', '시험 해적 함대');
    for (const [c, l, n] of [['battleship', 'std', 4], ['cruiser', 'missile', 6], ['destroyer', 'aa', 6], ['corvette', 'torp', 8]] as const)
      for (let i = 0; i < n; i++) sim.spawnShip('pirates', c, l, pg.id, { x: s.pos.x + 400 + i * 20, y: 0, z: s.pos.z + 200 });
    const e = sim.createEngagement(s.pos, [pg], [st.groups[s.groupId]]);
    expect(e.live).toBe(true);
    // what any client is told: the ship is visible in the system, the ledger is not in the view
    const view = legacyView(st, { company: B }, 'astra');
    expect(view.ships[BBEX_SHIP_ID]).toBeDefined();
    expect(view.ships[BBEX_SHIP_ID].owner).toBe(A);
    expect((view as { exclusive?: unknown }).exclusive).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(OWNER);
    // another player joins the battle as a spectator and receives a setup that re-simulates it
    srv.handle('b', { t: 'bjoin', eng: e.id });
    const init = b.inbox.find(m => m.t === 'binit') as Extract<ServerMsg, { t: 'binit' }>;
    expect(init).toBeDefined();
    const spec = JSON.stringify(init.setup);
    expect(spec).toContain(`"classId":"${BBEX_CLASS}"`); expect(spec).toContain('"causal":true'); expect(spec).toContain('dcp_omega');
    expect(srv.sim.battleOrder(B, e.id, 1, { type: 'retreat' }, {})).toBeTruthy();     // a spectator commands nothing
    // run the authoritative battle to its end
    const w = sim.battles.get(e.id)!;
    const ex = w.exShips[0];
    expect(ex).toBeDefined(); expect(ex.ex!.causal.on).toBe(true); expect(ex.mounts).toHaveLength(45);
    for (let i = 0; i < 4000 && !e.done; i++) srv.step(0.25);
    expect(e.done).toBe(true); expect(e.winner).toBe(0);
    expect(ex.ex!.dcp.shots).toBeGreaterThan(0);
    expect(ex.ex!.paradox.hits).toBeGreaterThan(0);
    expect(Object.keys(ex.ex!.stats.weapon).length).toBeGreaterThanOrEqual(5);
    expect(st.ships[BBEX_SHIP_ID].state).toBe('space');
    expect(st.ships[BBEX_SHIP_ID].hp).toBeGreaterThan(0.5);
    expect(st.commanders[BB_COMMANDER_ID].battles).toBe(1);
    expect(census(sim).ships).toHaveLength(1);
    // the finished battle is replayable by anyone from its record
    const rec = st.battleLog!.find(r => r.id === e.id)!;
    expect(JSON.stringify(rec.setup)).toContain(BBEX_CLASS);
    void THIRD;
  });
});
