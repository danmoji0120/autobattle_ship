// A-1 early-game check: a new company's starting funds against the running cost of its starter fleet.
// For the standard world (and the P9 world for comparison), four ways a new player might open, 6 h each:
//   idle    — no orders
//   mine    — 제1 채굴반 mines the nearest belt (kestrel) and sells at Astra (what the in-game hint suggests)
//   mine+escort — as mine, 경비대 escorts the miners
//   mine+reserve — as mine, the three combat ships are put in reserve at Astra (the game's own cost lever)
// Recorded hourly: credits, debt, arrears stage, fleet cost/h, mining income, ships alive.
//   npx vite-node scripts/a1/a1-startup.ts [out.json] [std|p9]
import { writeFileSync } from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { forecast, shipRate, upkeepOf } from '../../src/world/upkeep';
import { hullIdOf } from '../../src/world/hullops';

const HOURS = 6, SEEDS = [21, 41];
const ALL = { std: { ...STANDARD_WORLD }, p9: {} };
// one world per process (argv[3] = std | p9) so the two can run side by side
const only = process.argv[3] as keyof typeof ALL | undefined;
const worlds = only ? { [only]: ALL[only] } as typeof ALL : ALL;
type Plan = 'idle' | 'mine' | 'mine+escort' | 'mine+reserve';
const plans: Plan[] = ['idle', 'mine', 'mine+escort', 'mine+reserve'];
const res: any = { hours: HOURS, seeds: SEEDS, breakdown: {}, runs: {} };

function run(world: keyof typeof worlds, seed: number, plan: Plan) {
  const sim = WorldSim.create(seed, worlds[world]);
  const me = sim.addPlayer('창업 검증');
  const w = sim.st, co = w.companies[me];
  const groups = Object.values(w.groups).filter(g => g.owner === me);
  const miners = groups.find(g => g.name === '제1 채굴반')!, guard = groups.find(g => g.name !== '제1 채굴반')!;
  if (!res.breakdown[world]) {
    const f = forecast(w, co);
    res.breakdown[world] = {
      startCredits: co.credits, perHour: Math.round(f.perHour), runwayH: +(co.credits / f.perHour).toFixed(2),
      ships: Object.values(w.ships).filter(s => s.owner === me).map(s => ({ hull: hullIdOf(s), group: w.groups[s.groupId]?.name, perHour: Math.round(shipRate(w, s).credits * 1.1) })),
      shipCredits: Math.round(f.credits), overhead: Math.round(f.overhead), supplies: Math.round(f.suppliesCr), lease: Math.round(f.lease), dock: f.dock,
    };
  }
  const errs: string[] = [];
  if (plan !== 'idle') { const e = sim.command(me, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } } as any); if (e) errs.push(`mine: ${e}`); }
  if (plan === 'mine+escort') { const e = sim.command(me, { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } } as any); if (e) errs.push(`escort: ${e}`); }
  if (plan === 'mine+reserve') for (const s of Object.values(w.ships)) if (s.owner === me && s.groupId === guard.id) { const e = sim.command(me, { c: 'reserve', ship: s.id, on: true } as any); if (e) errs.push(`reserve: ${e}`); }
  const hourly: any[] = [];
  let firstDebtH: number | null = null, stage3H: number | null = null;
  for (let h = 1; h <= HOURS; h++) {
    for (let i = 0; i < 3600; i++) {
      sim.update(1);
      const u = upkeepOf(co);
      if (firstDebtH === null && u.debt > 1) firstDebtH = +((h - 1) + i / 3600).toFixed(2);
      if (stage3H === null && u.stage >= 3) stage3H = +((h - 1) + i / 3600).toFixed(2);
    }
    const u = upkeepOf(co);
    hourly.push({ h, credits: Math.round(co.credits), debt: Math.round(u.debt), stage: u.stage, perHour: Math.round(forecast(w, co).perHour), earned: Math.round(co.stats.earned), mined: Math.round(co.stats.mined), ships: Object.values(w.ships).filter(s => s.owner === me).length });
  }
  return { errs, firstDebtH, stage3H, hourly };
}

for (const world of Object.keys(worlds) as (keyof typeof worlds)[]) for (const plan of plans) for (const seed of SEEDS) {
  const r = run(world, seed, plan);
  (res.runs[`${world}/${plan}`] ??= []).push({ seed, ...r });
  const last = r.hourly.at(-1);
  console.log(world, plan, seed, JSON.stringify({ errs: r.errs, firstDebtH: r.firstDebtH, stage3H: r.stage3H, end: last, earnedPerH: Math.round(last.earned / HOURS) }));
}
console.log(JSON.stringify(res.breakdown));
writeFileSync(process.argv[2] ?? 'a1-startup.json', JSON.stringify(res, null, 1));
process.exit(0);
