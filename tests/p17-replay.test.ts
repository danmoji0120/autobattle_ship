// P17.3g short battle / replay check: a mixed battle with every new mechanism and tuned computers finishes
// cleanly, replays bit-identically from its order log, and render-side randomness (Math.random, used only by
// render/mech17Fx.ts) never reaches the combat RNG. docs/P17_3_ARSENAL.md
import { describe, expect, it } from 'vitest';
import { World, CPU_BEHAVIOUR, type BattleSetup } from '../src/sim/world';
import { WEAPONS } from '../src/sim/data/weapons';
import { getLoadout, type MountDef } from '../src/sim/data/ships';
import { CONTENT } from '../src/content/registry';
import { EQUIPMENT } from '../src/world/industry';
import type { FleetSpec, GroupSpec, ShipSpec } from '../src/sim/fleet';

void CONTENT;
function ship(classId: string, loadoutId: string, weapon: string | null, pd?: string, cpu?: string): ShipSpec {
  const lo = getLoadout(classId, loadoutId);
  const mounts: MountDef[] = lo.mounts.map(m => ({ ...m, weapon: WEAPONS[m.weapon].kind === 'pd' ? (pd ?? m.weapon) : (weapon ?? m.weapon) }));
  const c = cpu ? EQUIPMENT[cpu]!.cpu! : undefined;
  return { classId, loadoutId, fit: { name: 'p17', mounts }, ...(c ? { cpu: { id: cpu!, arch: c.arch, ...(c.react ? { react: c.react } : {}), ...(c.tune ? { tune: c.tune } : {}) } } : {}) };
}
const G = (ships: ShipSpec[]): GroupSpec => ({ name: 'g', commanderId: 'wolf', order: 'engage', retreatAt: 0, ships, children: [] });
const F = (g: GroupSpec, name: string): FleetSpec => ({ name, root: g });
// cpuV: new battles stamp CPU_BEHAVIOUR; 0 = a battle recorded before P17.3.1 (the key absent, as stored then)
const setup = (seed: number, cpuV = CPU_BEHAVIOUR): BattleSetup => ({
  seed, scenarioId: 'p173g', rules: 2, ...(cpuV ? { cpuV } : {}), fleets: [
    F(G([ship('cruiser', 'aa', 'swarm_box', 'flak_prox', 'cpu_missile'), ship('destroyer', 'aa', 'charge_m', undefined, 'cpu_energy'), ship('destroyer', 'strike', 'beam_cutter', undefined, 'cpu_flanker'),
      ship('frigate', 'aa', 'arc_s', 'flak_heavy', 'cpu_aegis'), ship('destroyer', 'aa', 'mine_layer')]), 'A'),
    F(G([ship('cruiser', 'aa', 'missile_2stage', 'flak_prox', 'cpu_lineholder'), ship('destroyer', 'aa', 'missile_decoy', undefined, 'cpu_missile_lite'), ship('destroyer', 'aa', 'plasma_burst', undefined, 'cpu_assault'),
      ship('frigate', 'aa', 'missile_tot'), ship('destroyer', 'aa', 'arc_projector', undefined, 'cpu_longbow')]), 'B'),
  ],
});
const digest = (w: World) => `${w.time.toFixed(2)}|${w.outcome?.winner ?? '-'}|` + w.ships.map(s => `${s.id}:${s.state}:${s.hp.toFixed(3)}:${s.pos.x.toFixed(2)}:${s.pos.z.toFixed(2)}`).join('|');

describe('P17.3g short battle + replay', () => {
  it('a mixed P17 battle finishes, every mechanism fires, no NaN', () => {
    const w = new World(setup(31));
    const seen = new Set<string>();
    while (!w.outcome && w.time < 240) { w.step(); for (const e of w.events) seen.add(e.t); }
    for (const t of ['split', 'stage', 'decoy', 'charge', 'beam', 'chain', 'burst', 'flak', 'mineArm']) expect(seen.has(t), t).toBe(true);
    for (const s of w.ships) { expect(Number.isFinite(s.hp)).toBe(true); expect(Number.isFinite(s.pos.x)).toBe(true); }
    expect(w.ships.some(s => s.state !== 'alive')).toBe(true);
  });

  it('replays bit-identically from the order log, with render randomness in between', () => {
    const live = new World(setup(44));
    const g = live.groups.find(x => x.team === 0)!;
    while (!live.outcome && live.time < 120) {
      live.step();
      if (Math.abs(live.time - 30) < live.dt / 2) live.issueOrder(g.id, { type: 'move', point: { x: 0, y: 0, z: 0 } });
      if (Math.abs(live.time - 45) < live.dt / 2) live.issueOrder(g.id, { type: 'engage' });
      Math.random(); Math.random();             // what the renderer's visual RNG would draw each frame
    }
    const rep = new World(setup(44));
    rep.scheduleReplay(live.orderLog);
    while (!rep.outcome && rep.time < 120) rep.step();
    expect(live.orderLog.length).toBeGreaterThan(0);
    expect(digest(rep)).toBe(digest(live));
  });

  // P17.3.1 replay compatibility. A stored battle is re-run from its setup + order log, so a battle recorded before
  // the flank rework (its setup has no cpuV) must re-run with the flank it was fought with. RECORDED is this exact
  // battle (seed 44, the order log below) recorded by the code before P17.3.1 (commit 82db115, P17.3f flank).
  const RECORDED_ORDERS = [{"tick":900,"groupId":1,"order":{"type":"move","point":{"x":0,"y":0,"z":0}}},{"tick":1350,"groupId":1,"order":{"type":"engage"}}];
  const RECORDED = '120.00|-|2:alive:5000.000:-621.34:-30.78|3:dead:-42.159:-13.28:-206.04|4:dead:-42.602:313.88:1114.38|5:alive:1278.493:-566.43:308.79|6:dead:-44.083:14.63:204.01|8:alive:3242.247:-194.79:970.73|9:dead:-38.192:-368.58:1867.16|10:dead:-10.618:335.31:126.62|11:dead:-24.853:145.15:1722.50|12:dead:-4.299:117.66:611.58';
  it('a battle recorded before P17.3.1 (no cpuV) replays to its recorded result (the old flank computer)', () => {
    const rep = new World(setup(44, 0));
    expect(rep.cpuV).toBe(0);
    rep.scheduleReplay(RECORDED_ORDERS as never);
    while (!rep.outcome && rep.time < 120) rep.step();
    expect(digest(rep)).toBe(RECORDED);
  });

  it('a new battle (cpuV stamped) runs the new flank computer and replays bit-identically', () => {
    const live = new World(setup(44));
    expect(live.cpuV).toBe(CPU_BEHAVIOUR);
    const g = live.groups.find(x => x.team === 0)!;
    while (!live.outcome && live.time < 120) {
      live.step();
      if (Math.abs(live.time - 30) < live.dt / 2) live.issueOrder(g.id, { type: 'move', point: { x: 0, y: 0, z: 0 } });
      if (Math.abs(live.time - 45) < live.dt / 2) live.issueOrder(g.id, { type: 'engage' });
    }
    const rep = new World(setup(44));
    rep.scheduleReplay(live.orderLog);
    while (!rep.outcome && rep.time < 120) rep.step();
    expect(digest(rep)).toBe(digest(live));
    expect(digest(live)).not.toBe(RECORDED);                // the new flank really is what new battles fight with
  });
});
