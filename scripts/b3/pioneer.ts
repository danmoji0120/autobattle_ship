// B-3 full-loop measurement: a grown company pioneers an outer system with everything moving (pirates, NPC traffic,
// faction AI, the company's own ships under their officers). Stand-ins as in tests/helpers/territory.ts: the finished
// station + facilities, the warships (launched) and the hourly business income / administration goods.
// usage: npx tsx scripts/b3/pioneer.ts [system] [cruisers|frigates] [maxHours]
import { world, run, kit, garrison, outpost, deliver, earn, addMods } from '../../tests/helpers/territory';
import { evaluate, stageOf, sovReport, STAGE_NAME, CLASS, regionClass, powerNeed } from '../../src/world/sovereignty';
import { shipValue } from '../../src/world/data';
import { shipRate } from '../../src/world/upkeep';
const SYS = process.argv[2] ?? 'gloam', MIX = process.argv[3] ?? 'cruisers', MAX = +(process.argv[4] ?? 30);
const sim = world();
const A = sim.addPlayer('개척사');
run(sim, 600);
const cls = regionClass(sim.st, sim.st.systems[SYS]), rule = CLASS[cls];
let st;
if (MIX === 'frigates') {
  st = outpost(sim, A, SYS, rule.station === 'M' ? 'M' : 'L', ['power', 'power', 'warehouse']);
  const need = powerNeed(sim, A, SYS) * 1.3, gates = sim.st.systems[SYS].gates.length;
  const per = Math.ceil(need / shipValue('frigate') / (gates + 2));
  garrison(sim, A, SYS, st, Array(per).fill('frigate'), Array(per * 2).fill('frigate'));
  sim.st.companies[A].credits += 2_000_000;
} else st = kit(sim, A, SYS, { size: rule.station === 'M' ? 'M' : 'L' }).st;
const ships = Object.values(sim.st.ships).filter(s => s.owner === A);
console.log(`${SYS} (${cls}) fleet ${ships.length} ships, value ${ships.reduce((a, s) => a + shipValue(s.classId), 0)} / need ${powerNeed(sim, A, SYS)}`);
const t0 = Date.now(); let declared = false;
for (let h = 0; h < MAX; h++) {
  const tH = Date.now();
  run(sim, 3600);
  earn(sim, A, 16_000);
  if (st.modules.some(m => m.kind === 'governance')) deliver(sim, A, st, 1.2);
  // the garrison's own ship supplies come out of the same warehouse first (upkeep.ts settle): haul those in too
  const sto = st.storage[A] as Record<string, number>;
  for (const s of Object.values(sim.st.ships)) if (s.owner === A) for (const [k, n] of Object.entries(shipRate(sim.st, s).supplies)) sto[k] = (sto[k] ?? 0) + n * 1.2;
  const r = sim.st.sov!.sys[SYS];
  if (!declared && stageOf(sim, A, SYS) >= 3) { console.log('declare', sim.command(A, { c: 'sov', op: 'declare', sys: SYS } as never)); declared = true; addMods(st, ['governance', ...Array(rule.defense).fill('defense')]); }
  const rep = evaluate(sim, A, SYS), alive = Object.values(sim.st.ships).filter(s => s.owner === A);
  console.log(`h${h + 1} ${STAGE_NAME[stageOf(sim, A, SYS, rep)]} ctl ${Math.round(r.ctl[A] ?? 0)} prog ${((r.claims[A]?.prog ?? 0) / 3600).toFixed(1)}/${rule.stabH} ships ${alive.length} hp ${(alive.reduce((a, s) => a + s.hp, 0) / Math.max(1, alive.length)).toFixed(2)} cr ${Math.round(sim.st.companies[A].credits)} fails: ${Object.entries(rep).filter(([, c]) => !c.ok).map(([k, c]) => k + '[' + c.miss.join(';') + ']').join(' ')} (${((Date.now() - tH) / 1000).toFixed(0)}s)`);
  if (r.owner === A) { console.log('ESTABLISHED at hour', h + 1); break; }
}
console.log('wall s', ((Date.now() - t0) / 1000).toFixed(0));
const row = sovReport(sim, A).rows.find(x => x.sys === SYS);
console.log('report', JSON.stringify({ income: row?.income, upkeep: (row as any)?.upkeep, supply: (row as any)?.supply }));
console.log('owners across systems:', Object.values(sim.st.sov!.sys).filter(x => x.owner).map(x => x.id + ':' + x.owner).join(' '));
