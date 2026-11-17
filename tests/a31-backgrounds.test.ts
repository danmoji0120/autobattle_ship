// A-3.1: founding backgrounds — what each grants, server-side resolution, no duplicate grants, persistence, legacy.
import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { STANDARD_WORLD } from '../src/world/worldPreset';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg, SaveFile } from '../src/server/protocol';
import { BACKGROUNDS, BACKGROUND, ORIGIN_TRUST, backgroundUpkeep, backgroundValue, backgroundShips } from '../src/world/backgrounds';
import { forecast } from '../src/world/upkeep';
import { hullIdOf, hullEcon, shipWorth } from '../src/world/hullops';
import { dockRefused } from '../src/world/territory';
import { REP, nextReq } from '../src/world/reputation';
import { BBEX_CLASS } from '../src/sim/bbex/data';

const own = (sim: WorldSim, id: string) => Object.values(sim.st.ships).filter(s => s.owner === id);

describe('A-3.1 backgrounds in the standard world', () => {
  const sim = WorldSim.create(21, { ...STANDARD_WORLD });
  const terms = sim.starterTerms();

  it('offers six backgrounds, each at a different real public station, with what it grants', () => {
    expect(terms.backgrounds?.map(b => b.id)).toEqual(['hauler', 'miner', 'salvager', 'security', 'veteran', 'raider']);
    const stations = new Set(BACKGROUNDS.map(b => b.station));
    expect(stations.size).toBe(6);
    expect(new Set(terms.backgrounds!.map(b => b.system)).size).toBe(6);
    for (const b of BACKGROUNDS) {
      const st = sim.st.stations[b.station];
      expect(st?.public, b.station).toBe(true);
      expect(st.faction, b.id).toBe(b.faction);
      expect(st.market, b.id).toBeTruthy();
    }
  });

  it('founds each company at its station with exactly the shown fleet, funds, standing and running cost', () => {
    for (const t of terms.backgrounds!) {
      const b = BACKGROUND[t.id];
      const id = sim.addPlayer(`배경 ${t.id}`, t.id);
      const co = sim.st.companies[id];
      expect(co.background).toBe(t.id);
      expect(co.homeStation).toBe(b.station);
      expect(co.credits).toBe(t.credits);
      const ships = own(sim, id);
      expect(ships.length).toBe(t.ships.reduce((n, s) => n + s.n, 0));
      for (const s of ships) {
        expect(s.state).toBe('docked');
        expect((s.task as any).station).toBe(b.station);
      }
      // the same hulls / presets the table lists, standard fits
      const want = backgroundShips(sim.st, b).flatMap(s => Array(s.n).fill(`${s.hull}/${s.preset}`)).sort();
      expect(ships.map(s => `${hullIdOf(s)}/${s.fitting?.preset}`).sort()).toEqual(want);
      // shown running cost = the real forecast; shown value = the ships' worth
      expect(t.upkeep).toBe(Math.round(forecast(sim.st, co).perHour));
      expect(t.value).toBe(Math.round(ships.reduce((n, s) => n + shipWorth(sim.st, s), 0)));
      // standing: origin at the first friendly band, nothing at a record-gated band, every faction still docks
      expect(co.standing?.[b.faction]).toBe(ORIGIN_TRUST);
      for (const x of t.standing) expect(co.standing?.[x.faction]).toBe(x.value);
      for (const v of Object.values(co.standing ?? {})) expect(v).toBeLessThan(REP.gates[0].at);
      expect(Object.values(sim.st.stations).filter(st => st.public && dockRefused(sim.st, st, id))).toHaveLength(0);
      expect(co.rep).toBe(0);
      // commander only where the background says so
      const cms = Object.values(sim.st.commanders).filter(c => c.owner === id);
      expect(cms.length).toBe(b.groups.filter(g => g.commander).length);
      // nothing is locked: the next band is reachable by the normal record
      expect(nextReq(sim.st, co, b.faction)?.at).toBe(REP.gates[0].at);
    }
  });

  it('keeps every start cheap to liquidate: no destroyer, fleet value far below the original start', () => {
    for (const b of BACKGROUNDS) {
      expect(b.ships.every(s => !/destroyer|cruiser|battle|dread/.test(s.hull)), b.id).toBe(true);
      expect(backgroundValue(b)).toBeLessThan(50000);
      // warships only where the background is a combat one
      const war = b.ships.some(s => hullEcon(s.hull, s.variant).military);
      expect(war).toBe(['security', 'veteran', 'raider'].includes(b.id));
      expect(b.credits / backgroundUpkeep(sim.st, b)).toBeGreaterThan(5);
    }
  });

  it('the raider stays an independent player company; pirate NPCs stay hostile (A-3.3)', () => {
    const id = sim.addPlayer('무법 테스트', 'raider');
    const co = sim.st.companies[id];
    expect(co.kind).toBe('player');
    expect(co.standing?.pirates).toBe(ORIGIN_TRUST);
    expect(co.standing?.union).toBeLessThan(0);
    expect(co.standing?.iron).toBeLessThan(0);
  });

  it('save and restore keep the origin and every asset', () => {
    const id = sim.addPlayer('보존 테스트', 'salvager');
    const back = new WorldSim(JSON.parse(sim.serialize()));
    expect(back.st.companies[id].background).toBe('salvager');
    expect(back.st.companies[id].homeStation).toBe('p9_ceres_works');
    expect(JSON.stringify(own(back, id))).toBe(JSON.stringify(own(sim, id)));
    expect(back.st.companies[id].standing).toEqual(sim.st.companies[id].standing);
  });

  it('an unknown or non-string background gives the original start (the server refuses it before that)', () => {
    for (const bad of ['nope', 42, { id: 'miner' }, '__proto__', 'constructor']) {
      const id = sim.addPlayer(`잘못 ${String(bad).slice(0, 6)}`, bad);
      const co = sim.st.companies[id];
      expect(co.background).toBeUndefined();
      expect(co.homeStation).toBe('astra');
      expect(own(sim, id).length).toBe(5);
    }
  });
});

describe('A-3.1 legacy worlds', () => {
  it('offer no backgrounds and keep the original start', () => {
    const sim = WorldSim.create(3);
    expect(sim.starterTerms().backgrounds).toBeUndefined();
    const id = sim.addPlayer('구 월드', 'miner');
    expect(sim.st.companies[id].background).toBeUndefined();
    expect(sim.st.companies[id].homeStation).toBe('astra');
    expect(own(sim, id).map(s => s.classId).sort()).toEqual(['corvette', 'corvette', 'destroyer', 'miner', 'miner']);
  });
});

// ───────────────────────────────────────────── server
const ACC_A = '11111111-1111-4111-8111-111111111111', ACC_B = '22222222-2222-4222-8222-222222222222';
const conn = (id: string, account?: string) => { const inbox: ServerMsg[] = []; const c: Conn = { id, account, lastEvent: 0, battles: new Set(), send: m => inbox.push(JSON.parse(JSON.stringify(m))) }; return { c, inbox }; };
const welcome = (inbox: ServerMsg[]) => inbox.find(m => m.t === 'welcome') as Extract<ServerMsg, { t: 'welcome' }> | undefined;
function join(srv: GameServer, id: string, account: string) {
  const x = conn(id, account); srv.connect(x.c);
  srv.handle(id, { t: 'hello', name: 'ignored', token: 'ignored' });
  return x;
}

describe('A-3.1 server: background chosen by id, resolved on the server', () => {
  const save0 = (() => { const s = new GameServer(null, { singleplayer: false, accounts: true, snapInterval: 0.5, worldPreset: 'standard' }, 7); return JSON.parse(JSON.stringify(s.snapshotFile())) as SaveFile; })();
  const mk = (save: SaveFile = save0, owner?: string) => new GameServer(JSON.parse(JSON.stringify(save)), { singleplayer: false, accounts: true, snapInterval: 0.5, ...(owner ? { exclusiveOwner: owner } : {}) }, 7);

  it('needPmc carries the six backgrounds; a chosen one is granted once, client values ignored, and survives a restart', () => {
    const srv = mk();
    const a = join(srv, 'a', ACC_A), a2 = join(srv, 'a2', ACC_A);
    const need = a.inbox.find(m => m.t === 'needPmc') as Extract<ServerMsg, { t: 'needPmc' }>;
    expect(need.start?.backgrounds?.length).toBe(6);
    // unknown background: refused, nothing created
    srv.handle('a', { t: 'createPmc', name: '알파 인양', background: 'admiral' });
    expect((a.inbox.find(m => m.t === 'pmcErr') as any)?.msg).toMatch(/창업 배경/);
    expect(Object.values(srv.sim.st.companies).filter(c => c.kind === 'player')).toHaveLength(0);
    // extra fields a client might add are not read
    srv.handle('a', { t: 'createPmc', name: '알파 인양', background: 'salvager', credits: 9e9, ships: ['bbex'] } as any);
    srv.handle('a', { t: 'createPmc', name: '알파 인양 2', background: 'veteran' });   // duplicate request: enters the same PMC
    srv.handle('a2', { t: 'createPmc', name: '알파 인양 3', background: 'raider' });  // second tab
    const players = Object.values(srv.sim.st.companies).filter(c => c.kind === 'player');
    expect(players).toHaveLength(1);
    const A = welcome(a.inbox)!.company;
    expect(welcome(a2.inbox)!.company).toBe(A);
    const co = srv.sim.st.companies[A];
    expect(co.background).toBe('salvager');
    expect(co.credits).toBe(BACKGROUND.salvager.credits);
    expect(own(srv.sim, A).length).toBe(3);
    expect(own(srv.sim, A).some(s => s.classId === BBEX_CLASS)).toBe(false);
    // reconnect: no second grant
    const a3 = join(srv, 'a3', ACC_A);
    expect(welcome(a3.inbox)!.company).toBe(A);
    expect(own(srv.sim, A).length).toBe(3);
    // restart from the save: same company, origin, assets
    for (let i = 0; i < 4; i++) srv.step(0.5);
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    const srv2 = mk(save);
    const b = join(srv2, 'b', ACC_A);
    expect(welcome(b.inbox)!.company).toBe(A);
    expect(srv2.sim.st.companies[A].background).toBe('salvager');
    expect(JSON.stringify(own(srv2.sim, A))).toBe(JSON.stringify(own(srv.sim, A)));
    expect(own(srv2.sim, A).length).toBe(3);
  });

  it('an old client without a background still founds the original start; different accounts get different places', () => {
    const srv = mk();
    const a = join(srv, 'a', ACC_A), b = join(srv, 'b', ACC_B);
    srv.handle('a', { t: 'createPmc', name: '옛 클라이언트' });
    srv.handle('b', { t: 'createPmc', name: '경비 회사', background: 'security' });
    const A = welcome(a.inbox)!.company, B = welcome(b.inbox)!.company;
    expect(srv.sim.st.companies[A].homeStation).toBe('astra');
    expect(srv.sim.st.companies[A].background).toBeUndefined();
    expect(own(srv.sim, A).length).toBe(5);
    expect(srv.sim.st.companies[B].homeStation).toBe('helios');
  });

  it('BB-EX grant is unchanged: the exclusive owner gets it once, at the home station of a background company', () => {
    const srv = mk(save0, ACC_A);
    const a = join(srv, 'a', ACC_A);
    srv.handle('a', { t: 'createPmc', name: '소유자 회사', background: 'miner' });
    const A = welcome(a.inbox)!.company;
    const bb = own(srv.sim, A).filter(s => s.classId === BBEX_CLASS);
    expect(bb).toHaveLength(1);
    join(srv, 'a2', ACC_A);
    expect(own(srv.sim, A).filter(s => s.classId === BBEX_CLASS)).toHaveLength(1);
    // the other account never receives it
    const b = join(srv, 'b', ACC_B);
    srv.handle('b', { t: 'createPmc', name: '다른 회사', background: 'miner' });
    expect(own(srv.sim, welcome(b.inbox)!.company).some(s => s.classId === BBEX_CLASS)).toBe(false);
  });

  it('an existing company from before backgrounds is not reset or granted anything', () => {
    const srv = mk();
    const a = join(srv, 'a', ACC_A);
    srv.handle('a', { t: 'createPmc', name: '기존 회사' });
    const A = welcome(a.inbox)!.company;
    const before = JSON.stringify({ co: srv.sim.st.companies[A], ships: own(srv.sim, A) });
    const save = JSON.parse(JSON.stringify(srv.snapshotFile())) as SaveFile;
    const srv2 = mk(save);
    const a2 = join(srv2, 'a', ACC_A);
    srv2.handle('a', { t: 'createPmc', name: '다시 창업', background: 'veteran' });
    expect(welcome(a2.inbox)!.company).toBe(A);
    expect(JSON.stringify({ co: srv2.sim.st.companies[A], ships: own(srv2.sim, A) })).toBe(before);
  });
});
