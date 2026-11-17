// B-2 profitability comparison in the real world (STANDARD_WORLD, seed 41). One player company per run, played by a
// simple scripted operator that only uses ordinary commands (accept with a fleet, repair at a dock, nothing else):
//   idle  — never takes a contract (the running-cost baseline of the start)
//   safe  — only patrol / defend / escort offers the guide marks as a fit ('ok')
//   any   — any 'ok' offer, picked by expected net per hour (includes hunts)
//   bold  — also 'weak' offers (hunts / strikes below the recommended strength)
// Reports credits, contract pay, bounty, repair, ship losses, upkeep, contracts done / failed per run.
//   npx tsx scripts/b2/profit.ts <hours> <bg,bg> <strategy,strategy>
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { milGuide, isMil } from '../../src/world/military';
import { repairQuote } from '../../src/world/repair';

const hours = Number(process.argv[2] ?? 4);
const bgs = (process.argv[3] ?? 'security,veteran').split(',');
const strategies = (process.argv[4] ?? 'idle,safe,any').split(',');
const verbose = process.argv.includes('-v');

function run(bg: string, strat: string) {
  const sim = WorldSim.create(41, { ...STANDARD_WORLD });
  const me = sim.addPlayer(`B2 ${bg}`, bg as never);
  const co = sim.st.companies[me];
  const c0 = co.credits;
  const worth0 = () => Object.values(sim.st.ships).filter(s => s.owner === me).length;
  const ships0 = worth0();
  let accepted = 0, repairs = 0;
  const taken = new Map<string, { type: string; title: string; power: number; fleet: number; fit: string; at: number }>();
  const rows: { type: string; ok: boolean; why: string; net: number; lostShips: number; bounty: number; power: number; fleet: number; fit: string }[] = [];
  const t0 = Date.now();
  for (let t = 0; t < hours * 3600; t++) {
    sim.update(1);
    for (const [id, a] of taken) { const k = sim.st.contracts[id]; const r = isMil(k) ? k.mil.result : undefined; if (r) { rows.push({ type: a.type, ok: r.ok, why: r.why, net: r.net, lostShips: r.lostShips, bounty: r.bounty, power: a.power, fleet: a.fleet, fit: a.fit }); taken.delete(id); if (verbose) console.error(`  [${bg}/${strat} t=${Math.round(t / 60)}m] ${a.title} (권장 ${a.power}, 투입 ${a.fleet}, ${a.fit}) → ${r.ok ? '완수' : '실패'} ${r.why} net ${r.net} 손실 ${r.lostShips}척`); } }
    if (strat === 'idle' || t % 20) continue;
    const g = milGuide(sim.st, me); if (!g) break;
    // repair docked damaged ships (only at a station that repairs)
    for (const s of Object.values(sim.st.ships)) {
      if (s.owner !== me || s.state !== 'docked' || s.hp > 0.97) continue;
      const q = repairQuote(sim.st, s, co); if (q.why || !q.cost) continue;
      if (sim.command(me, { c: 'repair', ship: s.id, quote: q.cost }) === null) repairs++;
    }
    if (g.active.length) continue;
    const f = g.fleets.filter(x => !x.busy && x.hp >= 0.75).sort((a, b) => b.power - a.power)[0]; if (!f) continue;
    const ok = (o: typeof g.board[number]) => strat === 'safe' ? o.fit === 'ok' && ['patrol', 'defend', 'escort'].includes(o.type)
      : strat === 'any' ? o.fit === 'ok' : o.fit !== 'danger';
    const pick = g.board.filter(ok).map(o => ({ o, v: ((o.netMin + o.netMax) / 2) / ((o.est + o.jumps * 90) / 3600) })).sort((a, b) => b.v - a.v)[0];
    if (pick && sim.command(me, { c: 'accept', contract: pick.o.id, group: f.id }) === null) { accepted++; taken.set(pick.o.id, { type: pick.o.type, title: pick.o.title, power: pick.o.power, fleet: f.power, fit: pick.o.fit, at: t }); }
  }
  const led = co.ops?.ledger ?? [];
  const sum = (side: 'inc' | 'exp', cat: string) => Math.round(led.reduce((a, b) => a + ((b as never as Record<string, Record<string, number>>)[side][cat] ?? 0), 0));
  return {
    bg, strat, hours, ms: Date.now() - t0,
    credits: Math.round(co.credits), delta: Math.round(co.credits - c0), debt: Math.round(co.upkeep?.debt ?? 0),
    ships: `${worth0()}/${ships0}`, accepted, repairs,
    done: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok).length,
    contractPay: sum('inc', 'mil_contract'), bounty: sum('inc', 'bounty'), repairCost: sum('exp', 'repair'), upkeep: sum('exp', 'upkeep'),
    opNet: rows.reduce((a, r) => a + r.net, 0), lostShips: rows.reduce((a, r) => a + r.lostShips, 0), opBounty: rows.reduce((a, r) => a + r.bounty, 0),
    byType: Object.entries(rows.reduce((m, r) => { const x = (m[r.type] ??= { n: 0, ok: 0, net: 0 }); x.n++; if (r.ok) x.ok++; x.net += r.net; return m; }, {} as Record<string, { n: number; ok: number; net: number }>)).map(([t, r]) => `${t} ${r.ok}/${r.n} net ${Math.round(r.net)}`).join(' · '),
    firstProfit: co.milestones.includes('first_profit'),
  };
}

for (const bg of bgs) for (const s of strategies) console.log(JSON.stringify(run(bg, s)));
