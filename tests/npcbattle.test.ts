import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { World } from '../src/sim/world';

/** replay a record the way a spectator's client does: fresh World from setup + seed, stamped orders */
function replay(rec: { setup: any; orders: any[] }) {
  const r = JSON.parse(JSON.stringify(rec)); // as it arrives over the wire
  const w = new World(r.setup);
  w.scheduleReplay(r.orders);
  let n = 0;
  while (!w.outcome && n++ < 30 * 900) w.step();
  return w;
}

describe('NPC battles: live, deterministic, replayable', () => {
  const sim = WorldSim.create(1);
  // let the world run until a few NPC fights have been fought to the end in the tactical engine
  const deaths = new Map<string, string[]>(); // eng id → strategic ship refs destroyed
  const before = new Map<string, Set<string>>();
  for (let t = 0; t < 3600 * 1.2 && (sim.st.battleLog?.length ?? 0) < 4; t += 0.5) {
    for (const e of Object.values(sim.st.engagements)) if (!e.done && !before.has(e.id)) before.set(e.id, new Set(Object.values(sim.st.ships).filter(s => s.engagement === e.id).map(s => s.id)));
    sim.update(0.5);
    for (const [id, refs] of before) if (sim.st.engagements[id]?.done !== false && !deaths.has(id)) deaths.set(id, [...refs].filter(r => !sim.st.ships[r]));
  }
  const log = sim.st.battleLog ?? [];

  it('fights are resolved by the tactical engine, not a coin flip', () => {
    expect(log.length).toBeGreaterThanOrEqual(3);
    for (const r of log) { expect(r.setup).toBeTruthy(); expect(r.end).toBeGreaterThan(r.start); }
  });

  it('a spectator replay reproduces the server result exactly: winner and every ship lost', () => {
    let checked = 0;
    for (const r of log) {
      const w = replay(r as any);
      expect(w.outcome?.winner ?? -1).toBe(r.winner);
      const lost: [number, number] = [0, 0];
      const deadRefs: string[] = [];
      for (const s of w.ships) if (s.state === 'dead' || s.state === 'dying') { lost[s.team]++; if (s.ref && !s.ref.includes(':')) deadRefs.push(s.ref); }
      const srv = deaths.get(r.id);
      expect(srv).toBeTruthy();
      expect(deadRefs.sort()).toEqual(srv!.sort());
      checked += deadRefs.length;
    }
    expect(checked).toBeGreaterThan(0); // some ships actually died, so the comparison means something
  });

  it('two spectators get identical simulations (same tick, same positions)', () => {
    const r = log[0] as any;
    const a = new World(JSON.parse(JSON.stringify(r.setup))), b = new World(JSON.parse(JSON.stringify(r.setup)));
    a.scheduleReplay(JSON.parse(JSON.stringify(r.orders))); b.scheduleReplay(JSON.parse(JSON.stringify(r.orders)));
    for (let i = 0; i < 900; i++) { a.step(); b.step(); }
    expect(a.ships.map(s => [s.pos.x, s.pos.z, s.hp])).toEqual(b.ships.map(s => [s.pos.x, s.pos.z, s.hp]));
  });

  it('battle ships move on the strategic map while fighting (mirrored from the engine)', () => {
    const sim2 = WorldSim.create(1);
    let moved = false;
    const last = new Map<string, number>();
    for (let t = 0; t < 3600 && !moved; t += 0.5) {
      sim2.update(0.5);
      for (const s of Object.values(sim2.st.ships)) if (s.state === 'battle' && s.hp > 0) {
        const p = s.pos.x + s.pos.z;
        if (last.has(s.id) && Math.abs(last.get(s.id)! - p) > 5) moved = true;
        last.set(s.id, p);
      }
    }
    expect(moved).toBe(true);
  });

  it('the battle record survives a save/restore', () => {
    const raw = JSON.parse(JSON.stringify(sim.st));
    const sim3 = new WorldSim(raw);
    expect(sim3.st.battleLog?.length).toBe(log.length);
    const w = replay(sim3.st.battleLog![0] as any);
    expect(w.outcome?.winner ?? -1).toBe(log[0].winner);
  });
});
