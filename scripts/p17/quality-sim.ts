// P17.1 short sim: one salvager company works the same derelict with and without quality rules / research.
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { econOf } from '../../src/world/hullops';
import { spawnDerelict } from '../../src/world/derelicts';
import { observeWorld } from '../../src/world/observe';
import { lotValue } from '../../src/world/wrecks';
function go(label: string, tune: (sim: WorldSim, p: string) => void) {
  const sim = WorldSim.create(31, { ...STANDARD_WORLD });
  const p = sim.addPlayer('인양', 'salvager');
  for (const id of Object.keys(sim.st.wrecks ?? {})) delete sim.st.wrecks![id];
  if (sim.st.derelicts) sim.st.derelicts.check = 1e12;
  tune(sim, p);
  const salv = Object.values(sim.st.ships).find(s => s.owner === p && (econOf(s).salv ?? 0) > 0)!;
  const w = spawnDerelict(sim.st, { system: sim.sysOf(salv.pos)!, grade: 'large', region: 't', time: sim.time, life: 86400, near: salv.pos });
  const est = w.lots.reduce((a, l) => a + l.n * lotValue(sim.st, l), 0);
  let rec = 0, recV = 0, lost = 0; let status = '';
  const off = observeWorld(sim.st, e => {
    if (e.ref !== w.id || !e.item) return;
    if (e.kind === 'salvage' && e.reason === 'recover') { rec += e.amount; recV += e.amount * lotValue(sim.st, { item: e.item.replace(/^stolen:/, '') }); }
    if (e.kind === 'consume' && e.reason === 'salvage_loss') lost += e.amount;
  });
  sim.command(p, { c: 'setOp', group: salv.groupId, op: { k: 'recover', wreck: w.id } } as any);
  for (let t = 0; t < 2 * 3600; t++) { sim.update(1); if (t === 1800) status = sim.st.groups[salv.groupId].status; }
  off();
  const taken = w.initial - w.lots.reduce((a, l) => a + l.n, 0);
  console.log(`${label}: taken ${taken} · recovered ${rec} · lost ${lost} · value ${Math.round(recV)} / est ${Math.round(est)} (${(recV / Math.max(1, est) * 100).toFixed(0)}%)\n  status@30m: ${status}`);
}
go('quality off (old rule)', sim => { delete sim.st.salvQV; });
go('quality on, basic S rig', () => {});
go('quality on, + salvage_ops', (sim, p) => { sim.st.companies[p].tech = [...(sim.st.companies[p].tech ?? []), 'salvage_ops']; });
