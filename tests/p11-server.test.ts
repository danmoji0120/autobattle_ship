// P11 §14 on the real multiplayer server (GameServer + protocol 2 connections, no shortcuts into the
// battle): four PMCs fight in one battle instance; every client re-simulates the battle from the server's
// binit/border stream and must match the authority's hash at the same tick (T13 spectator joining late,
// T14 reconnect after a reinforcement, T19 four PMCs commanding at once, ownership refused server-side),
// B withdraws and the rest fight on, the server restarts mid-battle from its save (T15) and the finished
// record replays to the same final hash (T16); settlement happens once per company (T20).
import { describe, it, expect } from 'vitest';
import { GameServer, type Conn } from '../src/server/core';
import { applySync, SYNC_PROTO, type SyncMsg } from '../src/server/sync';
import type { ServerMsg, WorldView } from '../src/server/protocol';
import { World } from '../src/sim/world';
import type { OrderRecord } from '../src/sim/types';
import type { BattleSetup } from '../src/sim/world';
import type { V } from '../src/world/types';

const wire = (x: unknown) => JSON.parse(JSON.stringify(x));

/** a client: replicated world state + (like BattleLink) a deterministic re-simulation of one battle */
class Client {
  conn: Conn; inbox: ServerMsg[] = []; state: WorldView | null = null; company = ''; token = '';
  setup: BattleSetup | null = null; orders: OrderRecord[] = []; w: World | null = null; replay = false; rebuilds = 0;
  acks = new Map<number, string | null>();
  constructor(readonly g: GameServer, readonly id: string) {
    this.conn = {
      id, lastEvent: 0, battles: new Set(),
      send: m => this.recv(wire(m)),
      sendText: s => this.recv(JSON.parse(s)),
    };
  }
  private recv(m: any) {
    this.inbox.push(m);
    if (m.t === 'sd') this.state = applySync(this.state, m as SyncMsg);
    else if (m.t === 'snap') this.state = m.state;
    else if (m.t === 'welcome') { this.company = m.company; this.token = m.token; }
    else if (m.t === 'ack') this.acks.set(m.id, m.err);
    else if (m.t === 'binit') { this.setup = m.setup; this.orders = m.orders.slice(); this.replay = !!m.replay; this.build(); }
    else if (m.t === 'border') {
      this.orders.push(m.rec);
      if (!this.w) return;
      if (m.rec.tick >= this.w.tick) this.w.scheduleOrder({ ...m.rec });
      else this.build();                     // ran ahead: rebuild from the full log, as BattleLink does
    }
  }
  private build() { this.rebuilds++; this.w = new World(wire(this.setup)); this.w.scheduleReplay(this.orders.map(o => ({ ...o }))); }
  /** catch up to the authority's tick and report our hash there */
  stepTo(tick: number) { while (this.w && this.w.tick < tick && !this.w.outcome) this.w.step(); return this.w?.digest(); }
  hello(token?: string) { this.g.connect(this.conn); this.g.handle(this.id, { t: 'hello', name: `PMC-${this.id}`, token, proto: SYNC_PROTO }); }
  seq = 1;
  cmd(cmd: any) { const id = this.seq++; this.g.handle(this.id, { t: 'cmd', id, cmd }); return this.acks.get(id); }
  order(eng: string, groupId: number, order: any, opts: any = {}) { const id = this.seq++; this.g.handle(this.id, { t: 'border', id, eng, groupId, order, opts }); return this.acks.get(id); }
}

const FAR: V = { x: 640000, y: 0, z: 640000 };
function fleet(g: GameServer, owner: string, pos: V, comp: string[]) {
  const grp = g.sim.newGroup(owner, `${g.sim.st.companies[owner].name} 편대`);
  const c = g.sim.newCommander(owner, 2); grp.commanderId = c.id;
  comp.forEach((cl, i) => g.sim.spawnShip(owner, cl, 'std', grp.id, { x: pos.x + i * 40, y: 0, z: pos.z }));
  return grp;
}

describe('P11 §14 on the multiplayer server', () => {
  it('four PMCs, reinforcements, late spectator, reconnect, withdrawal, server restart, replay — all consistent', () => {
    const opts = { singleplayer: false, snapInterval: 1, combatNew: true } as const;
    let g = new GameServer(null, opts, 21);
    expect(g.sim.st.combatV).toBe(2);
    const [a, b, c, d, spec] = ['a', 'b', 'c', 'd', 'spec'].map(id => new Client(g, id));
    for (const cl of [a, b, c, d, spec]) cl.hello();
    const [A, B, C, D] = [a, b, c, d].map(x => x.company);
    expect(new Set([A, B, C, D]).size).toBe(4);
    const ga = fleet(g, A, FAR, ['destroyer', 'destroyer', 'frigate']);
    const gb = fleet(g, B, { ...FAR, x: FAR.x + 350 }, ['destroyer', 'frigate', 'frigate']);
    // relations through the protocol: A declares on B; C allies with A (both ways) and declares on B
    expect(a.cmd({ c: 'stance', target: B, v: -1 })).toBeNull();
    expect(a.cmd({ c: 'stance', target: C, v: 1 })).toBeNull();
    expect(c.cmd({ c: 'stance', target: A, v: 1 })).toBeNull();
    expect(c.cmd({ c: 'stance', target: B, v: -1 })).toBeNull();
    expect(b.cmd({ c: 'stance', target: B, v: -1 })).toBe('대상 회사 오류');
    const step = (sec: number, until?: () => boolean) => { for (let t = 0; t < sec; t += 0.25) { g.step(0.25); if (until?.()) return true; } return false; };
    const engId = () => g.sim.st.ships[ga.shipIds[0]]?.engagement;
    expect(step(30, () => !!engId())).toBe(true);
    const id = engId()!;
    const srv = () => (g.sim as any).battles.get(id) as World;
    // A and B open the battle view
    for (const cl of [a, b]) g.handle(cl.id, { t: 'bjoin', eng: id });
    expect(a.w && b.w).toBeTruthy();
    step(5);
    const check = (cls: Client[], label: string) => { const t = srv().tick, h = srv().digest(); for (const cl of cls) expect(cl.stepTo(t), `${label}: ${cl.id} @${t}`).toBe(h); };
    check([a, b], 'start');
    // T12/T19: everyone commands only their own; the server refuses the rest
    const tg = (co: string) => srv().groups.find(x => x.ref && g.sim.st.groups[x.ref]?.owner === co)!;
    expect(a.order(id, tg(A).id, { type: 'attack', targetGroup: tg(B).id })).toBeNull();
    expect(b.order(id, tg(B).id, { type: 'engage' })).toBeNull();
    expect(b.order(id, tg(A).id, { type: 'retreat' })).toBe('지휘 권한 없음');
    expect(spec.order(id, tg(A).id, { type: 'retreat' })).toBe('지휘 권한 없음');
    expect(a.order(id, srv().groups.find(x => x.ref === 'co:' + B)!.id, { type: 'retreat' })).toBe('지휘 권한 없음');
    step(5); check([a, b], 'after orders');
    // C's fleet approaches through the world and joins the running battle
    const e = g.sim.st.engagements[id];
    const gc = fleet(g, C, { x: e.pos.x - 1300, y: 0, z: e.pos.z + 200 }, ['destroyer', 'frigate']);
    step(2);
    expect(g.sim.st.ships[gc.shipIds[0]].engagement).toBe(id);
    g.handle(c.id, { t: 'bjoin', eng: id });
    step(3); check([a, b, c], 'C joined');
    // D arrives hostile to A, B and C
    for (const x of [A, B, C]) expect(d.cmd({ c: 'stance', target: x, v: -1 })).toBeNull();
    const gd = fleet(g, D, { x: e.pos.x + 200, y: 0, z: e.pos.z - 1400 }, ['destroyer', 'destroyer']);
    step(2);
    expect(g.sim.st.ships[gd.shipIds[0]].engagement).toBe(id);
    expect(e.sides.map(x => x[0])).toEqual(expect.arrayContaining([A, B, C, D]));
    expect(srv().sides.length).toBe(4);
    // T13: a spectator and D open the view mid-battle (after two joins) and are in sync immediately
    for (const cl of [d, spec]) g.handle(cl.id, { t: 'bjoin', eng: id });
    step(1); check([a, b, c, d, spec], 'late spectator');
    // T19: four PMCs order at the same moment (the same server tick)
    const t0 = srv().tick;
    expect(a.order(id, tg(A).id, { type: 'attack', targetGroup: tg(D).id })).toBeNull();
    expect(b.order(id, tg(B).id, { type: 'hold' })).toBeNull();
    expect(c.order(id, tg(C).id, { type: 'attack', targetGroup: tg(B).id })).toBeNull();
    expect(d.order(id, tg(D).id, { type: 'attack', targetGroup: tg(A).id })).toBeNull();
    expect(c.order(id, tg(C).id, { type: 'attack', targetGroup: tg(A).id })).toMatch(/적대 관계가 아닌/);  // ally: refused
    expect(e.orders.filter(o => o.tick === t0 + 4 && !o.ev).length).toBeGreaterThanOrEqual(4);
    step(4); check([a, b, c, d, spec], 'simultaneous orders');
    // T14 + edge: B disconnects mid-battle (its fleet keeps fighting) and reconnects with its token
    g.disconnect(b.id);
    step(4);
    const b2 = new Client(g, 'b2'); b2.hello(b.token);
    expect(b2.company).toBe(B);
    g.handle(b2.id, { t: 'bjoin', eng: id });
    step(1); check([a, b2, c, d, spec], 'reconnect');
    // T10: B pulls out; A, C, D fight on
    expect(b2.order(id, -1, null, { withdraw: true })).toBeNull();
    const kB = e.sides.findIndex(x => x[0] === B);
    expect(step(240, () => !!srv().sides[kB].out || !!srv().outcome)).toBe(true);
    step(1);
    if (!srv()?.outcome) { expect(e.done).toBe(false); expect(e.released).toContain(B); }
    check([a, b2, c, d, spec].filter(() => !!srv()), 'after withdraw');
    // T15: the server restarts from its save in the middle of the battle
    const save = g.saveText();
    const tickAtSave = srv().tick, hashAtSave = srv().digest();
    const old = g;
    g = new GameServer(JSON.parse(save), opts, 99);
    expect((g.sim as any).battles.get(id).tick).toBe(tickAtSave);
    expect((g.sim as any).battles.get(id).digest()).toBe(hashAtSave);
    // the old process keeps running in this test as the reference: both must end identically
    const ends: Record<string, number> = { old: 0, new: 0 };
    const finals: Record<string, string> = {};
    old.sim.onBattleEnd = x => { if (x.id === id) { ends.old++; finals.old = ((old.sim as any).battles.get(id) as World).digest(); } };
    g.sim.onBattleEnd = x => { if (x.id === id) { ends.new++; finals.new = ((g.sim as any).battles.get(id) as World).digest(); } };
    const credits0 = Object.fromEntries([A, B, C, D].map(x => [x, g.sim.st.companies[x].credits]));
    for (let t = 0; t < 1200 && !(old.sim.st.engagements[id].done && g.sim.st.engagements[id].done); t += 0.25) { old.step(0.25); g.step(0.25); }
    expect(ends).toEqual({ old: 1, new: 1 });              // settled exactly once on each
    expect(finals.new).toBe(finals.old);
    const fe = g.sim.st.engagements[id];
    expect(fe.summary).toBe(old.sim.st.engagements[id].summary);
    for (const x of [A, B, C, D]) expect(g.sim.st.companies[x].credits).toBe(old.sim.st.companies[x].credits);
    expect(g.sim.st.battleLog!.filter(r => r.id === id).length).toBe(1);
    // T16: anyone can replay the finished battle (joins, orders, withdrawal) to the same final hash
    const r = new Client(g, 'r'); r.hello();
    g.handle(r.id, { t: 'bjoin', eng: id });
    expect(r.replay).toBe(true);
    r.stepTo(1e9);
    expect(r.w!.digest()).toBe(finals.old);
    const rec = g.sim.st.battleLog!.find(x => x.id === id)!;
    console.log('[§14]', JSON.stringify({ seed: rec.setup.seed, sides: rec.sides, names: rec.names, losses: rec.losses, summary: rec.summary, joins: fe.joins?.map(j => ({ co: g.sim.st.companies[j.company].name, tick: j.tick, ships: j.ships })), orders: rec.orders.length, finalTick: r.w!.tick, hash: finals.old, credits: Object.fromEntries([A, B, C, D].map(x => [g.sim.st.companies[x].name, Math.round(g.sim.st.companies[x].credits - credits0[x])])) }));
  });
});
