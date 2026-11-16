// A-3.2a real play: a new hauler or miner company in the standard world, played only through the guide's
// choices and ordinary commands (the same ones the guide panel sends). Writes a timeline with cash, the
// booked P&L (sales, purchases, upkeep) and what is held, so the profit can be checked against real activity.
//   npx vite-node scripts/a32/a32-play.ts hauler|miner|miner-local|miner-crowd [hours] [outDir]
import fs from 'fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { fieldOptions, firstBusinessStatus, movableGroups, relocationOptions, tradeOpportunities, type TradeOption } from '../../src/world/firstBusiness';
import { upkeepOf } from '../../src/world/upkeep';
import { econOf } from '../../src/world/hullops';
import { itemName } from '../../src/world/industry';

const mode = process.argv[2] ?? 'hauler', hours = Number(process.argv[3] ?? 2), outDir = process.argv[4] ?? 'artifacts/a32';
const sim = WorldSim.create(21, { ...STANDARD_WORLD });
const w = sim.st;
const bg = mode.startsWith('miner') ? 'miner' : 'hauler';
const me = sim.addPlayer(`첫사업-${mode}`, bg);
const rivals = mode === 'miner-crowd' ? [1, 2, 3].map(i => sim.addPlayer(`경쟁-${i}`, 'miner')) : [];
const co = w.companies[me];
const log: string[] = [], timeline: any[] = [], trades: any[] = [];
const say = (s: string) => { const line = `[${(w.time / 60).toFixed(0)}m] ${s}`; log.push(line); console.log(line); };
const cmd = (c: any, who = me) => { const e = sim.command(who, c); if (who === me) say(`${c.c} ${JSON.stringify(c).slice(0, 160)} → ${e ?? 'ok'}`); return e; };
const t0 = w.time;
const snap = () => {
  const s = firstBusinessStatus(w, me)!, u = upkeepOf(co);
  const row = { min: Math.round((w.time - t0) / 60), credits: Math.round(co.credits), cash: Math.round(s.cash), debt: Math.round(u.debt), stage: u.stage, sales: Math.round(s.pnl.income.sales ?? 0), purchase: Math.round(s.pnl.expense.purchase ?? 0), upkeep: Math.round(s.pnl.expense.upkeep ?? 0), other: Math.round((s.pnl.income.other ?? 0) - (s.pnl.expense.other ?? 0)), net: Math.round(s.pnl.net), mined: Math.round(co.stats.mined), stored: Object.fromEntries(Object.entries(s.stored).map(([k, n]) => [k, Math.round(n)])), aboard: Object.fromEntries(Object.entries(s.aboard).map(([k, n]) => [k, Math.round(n)])), steps: s.steps.filter(x => x.done).map(x => x.id), warnings: s.warnings, firstProfit: co.milestones.includes('first_profit') };
  timeline.push(row); say(`cash ${row.cash >= 0 ? '+' : ''}${row.cash} (credits ${row.credits}) sales ${row.sales} purchase ${row.purchase} upkeep ${row.upkeep} other ${row.other} net ${row.net} debt ${row.debt} ${row.warnings.join(' | ')}`);
};

function takeTrade(o: TradeOption) {
  const name = itemName(o.item);
  if (cmd({ c: 'buy', station: o.from, res: o.item, amount: o.amount })) return false;
  if (cmd({ c: 'poolCreate', request: { from: o.from, to: o.to, item: o.item, kind: 'sell', amount: o.amount, priority: 5, repeat: false } })) return false;
  const job = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me).sort((a, b) => b.created - a.created)[0];
  trades.push({ at: Math.round((w.time - t0) / 60), item: o.item, name, from: o.from, to: o.to, jumps: o.jumps, risk: o.risk, amount: o.amount, cost: Math.round(o.cost), estRevenue: Math.round(o.revenue), estProfit: Math.round(o.profit), job: job?.id });
  say(`trade ${name} ×${o.amount} ${o.from}→${o.to} (${o.jumps} jumps) cost ${Math.round(o.cost)} est +${Math.round(o.profit)} risk ${o.risk} [limit: ${o.limit}]`);
  return true;
}

if (bg === 'miner') {
  const opts = fieldOptions(w, me);
  const local = mode === 'miner-local' || mode === 'miner-crowd';
  // the guide lists the home system's fields first; the player picks the plain ore field and either the best-paying
  // neighbour (1 jump) or the home station
  const f = opts.find(x => x.field === 'p9_anvil_ore') ?? opts[0];
  const d = local ? f.deliveries.find(x => x.station === co.homeStation)! : f.deliveries[0];
  say(`field ${f.name} → deliver ${d.station} (${d.jumps} jumps, est ${d.per100} cr / 100 units, budget ${d.funds})`);
  const g = Object.values(w.groups).find(x => x.owner === me && sim.subtreeShips(x).some(s => econOf(s).mine > 0))!;
  cmd({ c: 'setOp', group: g.id, op: { k: 'mine', field: f.field, deliver: d.station, sell: true } });
  // rivals mine the other home fields and sell at home (they compete for the same union budget)
  const others = ['p9_anvil_ore', 'p9_anvil_titanium', 'p97_anvil_dense'];
  rivals.forEach((r, i) => { const rg = Object.values(w.groups).find(x => x.owner === r && sim.subtreeShips(x).some(s => econOf(s).mine > 0))!; cmd({ c: 'setOp', group: rg.id, op: { k: 'mine', field: others[i % 3], deliver: 'p9_anvil_port', sell: true } }, r); });
}

snap();
let switched = false, moving: string | null = null;
for (let m = 1; m <= hours * 60; m++) {
  for (let i = 0; i < 60; i++) sim.update(1);
  if (bg === 'hauler') {
    // the player looks at the guide whenever a hauler is free and takes the best real opportunity
    const busy = Object.values(w.logisticsJobs ?? {}).some(j => j.owner === me && (j.state === 'queued' || (j.state === 'waiting' && !j.ship)));
    if (!busy) {
      const o = tradeOpportunities(w, me).find(x => x.risk <= 55); /* a careful player skips '위험' routes */
      if (o) takeTrade(o);
      else if (!moving) {
        // nothing pays here: the guide offers to move the empty haulers to where a trade starts
        const r = relocationOptions(w, me)[0];
        if (r) { for (const g of movableGroups(w, me, r.from)) cmd({ c: 'setOp', group: g, op: { k: 'dock', station: r.station } }); moving = r.station; say(`relocate empty → ${r.station} (${r.jumps} jumps, risk ${r.risk}) for ${itemName(r.best.item)} est +${Math.round(r.best.profit)}`); }
      }
    }
    if (moving) { const gs = [...new Set(Object.values(w.ships).filter(s => s.owner === me && s.classId === 'hauler').map(s => s.groupId))]; if (gs.every(g => { const gr = w.groups[g]; return gr.op.k !== 'dock' || sim.subtreeShips(gr).every(s => s.state === 'docked' && (s.task as any).station === moving); })) { for (const g of gs) if (w.groups[g].op.k === 'dock') cmd({ c: 'setOp', group: g, op: { k: 'idle' } }); moving = null; } }
  } else if (!switched) {
    // the guide warns when the field is exhausted: move the group to the next field with the same delivery choice
    const s = firstBusinessStatus(w, me)!;
    if (s.warnings.some(x => x.includes('고갈'))) {
      const g = Object.values(w.groups).find(x => x.owner === me && x.op.k === 'mine')!;
      const cur = (g.op as any).field, next = fieldOptions(w, me).find(x => x.field !== cur && !x.depleted && x.jumps === 0 && x.deliveries.some(d => d.unsold === 0))
        ?? fieldOptions(w, me).find(x => x.field !== cur && !x.depleted)!;
      const d = mode === 'miner' ? next.deliveries[0] : next.deliveries.find(x => x.station === co.homeStation) ?? next.deliveries[0];
      say(`field exhausted → switch to ${next.name}, deliver ${d.station}`);
      cmd({ c: 'setOp', group: g.id, op: { k: 'mine', field: next.field, deliver: d.station, sell: true } });
      switched = true;
    }
  }
  if (process.env.A32_DEBUG) { for (const e of ((w as any).events ?? []).filter((e: any) => e.company === me && e.t > w.time - 60)) say(`  ev ${e.kind} ${e.text}`); const b = co.ops?.ledger.at(-1); say(`ledger ${JSON.stringify(b?.inc)} ${JSON.stringify(b?.exp)} credits ${Math.round(co.credits)}`); }
  if (m % 10 === 0) snap();
}
// settle trades with the real job results
for (const t of trades) { const j = t.job ? w.logisticsJobs?.[t.job] : undefined; Object.assign(t, { state: j?.state, delivered: Math.round(j?.delivered ?? 0), earned: Math.round(j?.earned ?? 0), realProfit: Math.round((j?.earned ?? 0) - t.cost) }); }
const fin = firstBusinessStatus(w, me)!;
const jobs = Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === me).map(j => ({ id: j.id, kind: j.kind, item: j.item, from: j.from, to: j.to, amount: j.amount, state: j.state, reason: j.reason, code: j.code, carried: j.carried, reserved: j.reserved, delivered: j.delivered, lost: j.lost, withdrawn: j.withdrawn, earned: Math.round(j.earned) }));
const ships = Object.values(w.ships).filter(s => s.owner === me).map(s => ({ id: s.id, name: s.name, classId: s.classId, state: s.state, hp: s.hp, task: s.task.k, at: (s.task as any).station, cargo: s.cargo }));
const out = { mode, jobs, ships, lostShips: co.stats.lost, hours, seed: 21, company: me, background: bg, start: fin.start, end: Math.round(co.credits), cash: Math.round(fin.cash), pnl: fin.pnl, stored: fin.stored, aboard: fin.aboard, firstProfit: co.milestones.includes('first_profit'), upkeepPerHour: Math.round(upkeepOf(co).total?.credits ?? 0), trades, timeline, rivals: rivals.map(r => ({ id: r, credits: Math.round(w.companies[r].credits) })), anvil: { funds: Math.round(w.stations.p9_anvil_port.funds ?? 0), fundsMax: w.stations.p9_anvil_port.fundsMax }, log };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/play-${mode}.json`, JSON.stringify(out, null, 1));
say(`DONE ${mode}: cash ${out.cash >= 0 ? '+' : ''}${out.cash}, first profit ${out.firstProfit}`);
