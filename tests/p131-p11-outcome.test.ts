// P13.1 supplement: P11 battle outcomes — a side's recorded status must match what happened to its ships.
// "destroyed" (전멸) only when every ship of that side was lost; a side whose last ships escaped is "withdrawn"
// (철수), one that broke after losses is "routed" (패주). Real attack orders in a P13.1 world, nothing edited.
// Before the fix a 2-side battle in which a lone hauler escaped was recorded as "destroyed" with 0 losses.
import { describe, it, expect } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { LAYOUTS, runTrial, type Trial } from '../scripts/salvage/convoy-fixture';

const consistent = (t: Trial) => {
  for (const e of t.engagements) {
    expect(e.sides.length).toBeGreaterThan(0);
    e.sides.forEach((s, k) => {
      if (s.status === 'destroyed') { expect(s.lost).toBeGreaterThan(0); expect(s.escaped).toBe(0); expect(s.alive).toBe(0); }
      if (s.status === 'withdrawn') expect(s.escaped).toBeGreaterThan(0);
      if (s.status === 'routed' || s.status === 'withdrawn' || s.status === 'destroyed') expect(s.alive).toBe(0);
      // the strategic battle record counts the same losses as the tactical battle
      if (e.strategicLosses) expect(e.strategicLosses[k]).toBe(s.lost);
    });
  }
};

describe('P11 side outcome vs real losses (P13.1 supplement)', () => {
  it('escorts lost then the rest flees = routed; a lone hauler that escapes a second attack = withdrawn with 0 losses (was "destroyed")', () => {
    const t = runTrial(9401, LAYOUTS.base, 600);
    consistent(t);
    expect(t.haulerSunk).toBe(false);
    const [first, ...later] = t.engagements;
    const b0 = first.sides.find(s => s.co !== first.sides.find(x => x.status === 'victor')?.co)!;
    expect(b0.status).toBe('routed'); expect(b0.lost).toBeGreaterThan(0); expect(b0.escaped).toBe(1);
    const lone = later.map(e => e.sides.find(s => s.status !== 'victor')!).filter(s => s.lost === 0);
    expect(lone.length).toBeGreaterThan(0);
    for (const s of lone) { expect(s.status).toBe('withdrawn'); expect(s.escaped).toBe(1); }
  }, 120000);

  it('a hauler caught and sunk = destroyed with its loss counted; the victor keeps its living ships', () => {
    const t = runTrial(9400, LAYOUTS.close, 600);
    consistent(t);
    expect(t.haulerSunk).toBe(true);
    const last = t.engagements.at(-1)!;
    const lost = last.sides.find(s => s.status !== 'victor')!;
    expect(lost.status).toBe('destroyed'); expect(lost.lost).toBeGreaterThan(0); expect(lost.escaped).toBe(0);
    const win = last.sides.find(s => s.status === 'victor')!;
    expect(win.alive).toBeGreaterThan(0);
    expect(Object.keys(t.cargoInWrecks).length).toBeGreaterThan(0);
  }, 120000);

  it('three sides: the side whose only ship escapes leaves as withdrawn (0 lost) while the other two fight on', () => {
    const sim = WorldSim.create(1317, { salvage: 'p131' });
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    const cos = ['갑', '을', '병'].map(n => sim.addPlayer(n));
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    for (const id of Object.keys(sim.st.groups)) delete sim.st.groups[id];
    for (const c of cos) for (const d of cos) if (c !== d) sim.command(c, { c: 'stance', target: d, v: -1 } as any);
    const a = sim.st.stations.astra.pos, at = (dx: number) => ({ x: a.x + 4000 + dx, y: 0, z: a.z + 2500 });
    const mk = (c: string, comp: string[], dx: number) => { const g = sim.newGroup(c, c); g.commanderId = sim.newCommander(c, 2).id; comp.forEach((cl, i) => sim.spawnShip(c, cl, 'std', g.id, { ...at(dx), x: at(dx).x + i * 40 })); return g; };
    const g0 = mk(cos[0], ['destroyer', 'destroyer', 'destroyer'], 0), g1 = mk(cos[1], ['destroyer', 'destroyer', 'destroyer'], 600);
    mk(cos[2], ['hauler'], 300);
    expect(sim.command(cos[0], { c: 'setOp', group: g0.id, op: { k: 'attack', group: g1.id } } as any)).toBeNull();
    expect(sim.command(cos[1], { c: 'setOp', group: g1.id, op: { k: 'attack', group: g0.id } } as any)).toBeNull();
    const battles: Map<string, any> = (sim as any).battles;
    const seen = new Map<string, any>();
    let releasedWhileFighting = false;
    for (let t = 0; t < 600; t += .5) {
      sim.update(.5);
      for (const [id, w] of battles) { seen.set(id, w); if (!w.outcome && w.sides.some((s: any, k: number) => s.out === 'withdrawn' && sim.st.engagements[id].sides[k][0] === cos[2])) releasedWhileFighting = true; }
      if (t > 60 && !Object.values(sim.st.engagements).some(e => !e.done)) break;
    }
    const e = Object.values(sim.st.engagements).find(x => x.sides.flat().includes(cos[2]));
    expect(e).toBeTruthy();
    const w = seen.get(e!.id), k = e!.sides.findIndex(x => x[0] === cos[2]);
    const side = w.outcome.sides[k];
    expect(side.status).toBe('withdrawn'); expect(side.lost).toBe(0); expect(side.escaped).toBe(1);
    expect(releasedWhileFighting).toBe(true);
    for (const s of w.outcome.sides) if (s.status === 'destroyed') { expect(s.lost).toBeGreaterThan(0); expect(s.escaped).toBe(0); }
  }, 120000);
});
