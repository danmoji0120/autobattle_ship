// B-2 profitability comparison in the real world (STANDARD_WORLD, seed 41). One player company per run, played by a
// simple scripted operator that only uses ordinary commands (accept with a fleet, repair at a dock, nothing else):
//   idle  — never takes a contract (the running-cost baseline of the start)
//   safe  — only patrol / defend / escort offers the guide marks as a fit ('ok')
//   any   — any 'ok' offer, picked by expected net per hour (includes hunts)
//   bold  — also 'weak' offers (hunts / strikes below the recommended strength)
//   grow  — like 'any', and reinvests: buys the cheapest military hull a public yard sells into the main fleet
//           whenever cash stays 6,000 cr above the founding funds after the purchase
//   growsafe — 'safe' contract choice with the same reinvestment
// Reports credits, contract pay, bounty, repair, ship losses, upkeep, contracts done / failed per run.
//   npx tsx scripts/b2/profit.ts <hours> <bg,bg> <strategy,strategy>
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { milGuide, isMil } from '../../src/world/military';
import { repairQuote } from '../../src/world/repair';
import { yardHulls, yardShipPrice, econOf } from '../../src/world/hullops';
import { CONTENT } from '../../src/content/registry';

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
  let accepted = 0, repairs = 0, bought = 0, spent = 0, offLost = 0;
  const owned = new Map<string, string>(), inMil = new Set<string>();
  const sysOf = (p: { x: number; z: number }) => Object.values(sim.st.systems).find(y => Math.hypot(p.x - y.origin.x, p.z - y.origin.z) < y.radius)?.name ?? '?';
  const taken = new Map<string, { type: string; title: string; power: number; fleet: number; fit: string; at: number }>();
  const rows: { type: string; ok: boolean; why: string; net: number; lostShips: number; bounty: number; power: number; fleet: number; fit: string }[] = [];
  const t0 = Date.now();
  for (let t = 0; t < hours * 3600; t++) {
    sim.update(1);
    for (const [id, a] of taken) { const k = sim.st.contracts[id]; const r = isMil(k) ? k.mil.result : undefined; if (r) { rows.push({ type: a.type, ok: r.ok, why: r.why, net: r.net, lostShips: r.lostShips, bounty: r.bounty, power: a.power, fleet: a.fleet, fit: a.fit }); taken.delete(id); if (verbose) console.error(`  [${bg}/${strat} t=${Math.round(t / 60)}m] ${a.title} (권장 ${a.power}, 투입 ${a.fleet}, ${a.fit}) → ${r.ok ? '완수' : '실패'} ${r.why} net ${r.net} 손실 ${r.lostShips}척`); } }
    if (t % 20 === 0) {   // ships lost outside any contract (e.g. flying home through a dangerous system after settlement)
      const now = new Set(Object.values(sim.st.ships).filter(s => s.owner === me).map(s => s.id));
      for (const [id, st] of owned) if (!now.has(id)) { if (!inMil.has(id)) { offLost++; if (verbose) console.error(`  [${bg}/${strat} t=${Math.round(t / 60)}m] 계약 밖 함선 손실 ${id} (직전 ${st})`); } owned.delete(id); }
      inMil.clear(); for (const k of Object.values(sim.st.contracts)) if (isMil(k) && k.takenBy === me && !k.done && k.mil.group) for (const sid of sim.st.groups[k.mil.group]?.shipIds ?? []) inMil.add(sid);
      for (const s of Object.values(sim.st.ships)) if (s.owner === me) owned.set(s.id, `${s.state}@${sysOf(s.pos)}`);
    }
    if (strat === 'idle' || t % 20) continue;
    const g = milGuide(sim.st, me); if (!g) break;
    // repair docked damaged ships (only at a station that repairs)
    for (const s of Object.values(sim.st.ships)) {
      if (s.owner !== me || s.state !== 'docked' || s.hp > 0.97) continue;
      const q = repairQuote(sim.st, s, co); if (q.why || !q.cost) continue;
      if (sim.command(me, { c: 'repair', ship: s.id, quote: q.cost }) === null) repairs++;
    }
    if ((strat === 'grow' || strat === 'growsafe') && t % 300 === 0) {
      const main = g.fleets.slice().sort((a, b) => b.ships - a.ships)[0];
      const offers = Object.values(sim.st.stations).flatMap(st => yardHulls(st).filter(hh => econOf({ classId: CONTENT.hulls[hh].classId }).military).map(hh => ({ st, hh, price: yardShipPrice(st, hh) }))).filter(o => o.price > 0).sort((a, b) => a.price - b.price);
      const o = offers[0];
      if (main && o && co.credits - o.price >= c0 + 6000 && sim.command(me, { c: 'buyShip', station: o.st.id, classId: CONTENT.hulls[o.hh].classId, loadoutId: '', hull: o.hh, group: main.id }) === null) { bought++; spent += o.price; if (verbose) console.error(`  [${bg}/${strat} t=${Math.round(t / 60)}m] 함선 구입 ${o.hh} ${o.price} cr @ ${o.st.name}`); }
    }
    if (g.active.length) continue;
    const f = g.fleets.filter(x => !x.busy && x.hp >= 0.75).sort((a, b) => b.power - a.power)[0]; if (!f) continue;
    const ok = (o: typeof g.board[number]) => strat === 'safe' || strat === 'growsafe' ? o.fit === 'ok' && ['patrol', 'defend', 'escort'].includes(o.type)
      : strat === 'any' || strat === 'grow' ? o.fit === 'ok' : o.fit !== 'danger';
    const pick = g.board.filter(ok).map(o => ({ o, v: ((o.netMin + o.netMax) / 2) / ((o.est + o.jumps * 90) / 3600) })).sort((a, b) => b.v - a.v)[0];
    if (pick && sim.command(me, { c: 'accept', contract: pick.o.id, group: f.id }) === null) { accepted++; taken.set(pick.o.id, { type: pick.o.type, title: pick.o.title, power: pick.o.power, fleet: f.power, fit: pick.o.fit, at: t }); }
  }
  const led = co.ops?.ledger ?? [];
  const sum = (side: 'inc' | 'exp', cat: string) => Math.round(led.reduce((a, b) => a + ((b as never as Record<string, Record<string, number>>)[side][cat] ?? 0), 0));
  return {
    bg, strat, hours, ms: Date.now() - t0,
    credits: Math.round(co.credits), delta: Math.round(co.credits - c0), debt: Math.round(co.upkeep?.debt ?? 0),
    ships: `${worth0()}/${ships0}`, offLost, accepted, repairs, bought, spent,
    done: rows.filter(r => r.ok).length, failed: rows.filter(r => !r.ok).length,
    contractPay: sum('inc', 'mil_contract'), bounty: sum('inc', 'bounty'), repairCost: sum('exp', 'repair'), upkeep: sum('exp', 'upkeep'),
    opNet: rows.reduce((a, r) => a + r.net, 0), lostShips: rows.reduce((a, r) => a + r.lostShips, 0), opBounty: rows.reduce((a, r) => a + r.bounty, 0),
    byType: Object.entries(rows.reduce((m, r) => { const x = (m[r.type] ??= { n: 0, ok: 0, net: 0 }); x.n++; if (r.ok) x.ok++; x.net += r.net; return m; }, {} as Record<string, { n: number; ok: number; net: number }>)).map(([t, r]) => `${t} ${r.ok}/${r.n} net ${Math.round(r.net)}`).join(' · '),
    firstProfit: co.milestones.includes('first_profit'),
  };
}

for (const bg of bgs) for (const s of strategies) console.log(JSON.stringify(run(bg, s)));
