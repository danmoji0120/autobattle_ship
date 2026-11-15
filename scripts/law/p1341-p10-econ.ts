// P13.4.1 §6 — limited economic comparison in a P10 40-system world (factions v2, natural NPC economy, Union guards).
// The same script runs unchanged on the P13.4 code (02c5a41) and on P13.4.1; only shared APIs are used
// (WorldSim, lawCrime, lawPay through the command API, hotKey). Two scenarios on the same seed and initial world:
//   A — no crime: the natural economy only (faction ledgers, markets, NPC trade, losses, Union fleets, tick time)
//   B — enforcement: 3 player companies (credits 0 / 3,000 / ample) with 4 groups each in policed systems carrying a
//       victim's stolen goods, transit-banned heavy cannons, ECM modules and ordinary ore, each wanted for a real
//       extortion case → real dispatches, stops, (offline = compliance) inspections and seizures; afterwards every
//       company gets credits and pays what it owes next to a policed station (lawPay). Seized / held / confiscated
//       goods, fines assessed / collected / owed / paid later and where the money went are read from the world and
//       from its own observation stream (currency.transfer / currency.destroy).
// DETCLOCK=1 (default): performance.now is frozen, so NPC battles never run out of their wall-time budget and the
// outcome does not depend on machine load (P13.2.2 §D.1). Tick time is measured with process.hrtime (not frozen).
//   npx vite-node scripts/law/p1341-p10-econ.ts <tag> [hours] [seed]
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
if ((process.env.DETCLOCK ?? '1') !== '0') { (globalThis.performance as any).now = () => 0; }
import { WorldSim } from '../../src/world/sim';
import type { V, WShip } from '../../src/world/types';
import { lawCrime, policedSystems } from '../../src/world/law';
import { hotKey } from '../../src/world/blackmarket';
import { observeWorld, moneySupply } from '../../src/world/observe';
import { sysAt } from '../../src/world/geom';

const [tag = 'run', hArg = '0.5', sArg = '133'] = process.argv.slice(2);
const hours = Number(hArg), seed = Number(sArg), dt = 0.5;
const code = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() + (execSync('git status --porcelain src', { encoding: 'utf8' }).trim() ? '+dirty' : ''); } catch { return '?'; } })();
const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, n) => a + n, 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

function snapshot(sim: WorldSim) {
  const st = sim.st;
  const factions: Record<string, unknown> = {};
  for (const [id, f] of Object.entries(st.factions ?? {})) {
    const e = f.econ, L = e?.led;
    factions[id] = { strength: r1(f.strength), infra: r1(f.infra), stock: r1(sum(f.stock)), budget: e ? Math.round(e.budget) : undefined,
      income: L ? Math.round(L.income) : undefined, spent: L ? Math.round(L.spent) : undefined, exportRev: L ? Math.round(L.exportRev) : undefined,
      extracted: L ? r1(sum(L.extracted)) : undefined, made: L ? r1(sum(L.made)) : undefined, used: L ? r1(sum(L.used)) : undefined, bought: L ? r1(sum(L.bought)) : undefined };
  }
  let mStock = 0, sFunds = 0; const byItem: Record<string, number> = {};
  for (const s of Object.values(st.stations)) {
    if (!s.public) continue;
    sFunds += s.funds ?? 0;
    for (const [k, m] of Object.entries(s.market ?? {})) { const n = (m as any)?.stock ?? 0; mStock += n; byItem[k] = (byItem[k] ?? 0) + n; }
  }
  const npcGroups: Record<string, number> = {};
  for (const g of Object.values(st.groups)) if (g.npc && g.shipIds.length) { const k = g.owner === 'union' ? `union:${g.npc.role}` : g.owner; npcGroups[k] = (npcGroups[k] ?? 0) + 1; }
  return { time: Math.round(st.time), factions, marketStock: r1(mStock), marketTop: Object.fromEntries(Object.entries(byItem).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => [k, r1(n)])),
    stationFunds: Math.round(sFunds), money: Math.round(moneySupply(st)), unionShips: Object.values(st.ships).filter(s => s.owner === 'union').length,
    ships: Object.keys(st.ships).length, haulers: Object.values(st.ships).filter(s => s.classId === 'hauler' || s.classId === 'freighter').length, npcGroups };
}

function scenario(name: 'A' | 'B') {
  const sim = WorldSim.create(seed, { layout: 'p10', law: 'p134', factionEcon: 'v2' } as any);
  sim.update(1);
  const flows: Record<string, { n: number; amount: number }> = {};
  const money: Record<string, number> = {};
  observeWorld(sim.st, (e: any) => {
    const k = `${e.kind}:${e.reason ?? ''}`;
    const f = (flows[k] ??= { n: 0, amount: 0 }); f.n++; f.amount += Number(e.amount) || 0;
    if (e.kind === 'currency.transfer' || e.kind === 'currency.destroy' || e.kind === 'currency.create') {
      if (/fine/.test(e.reason ?? '')) { const kk = `${e.kind}:${e.reason}:${e.to ? (sim.st.stations[e.to] ? 'station' : sim.st.companies[e.to] ? 'company' : e.to) : '-'}`; money[kk] = (money[kk] ?? 0) + Number(e.amount); }
    }
  });
  const start = snapshot(sim);
  const players: { id: string; cr0: number; groups: string[] }[] = [];
  let victim = '';
  if (name === 'B') {
    victim = sim.addPlayer('원소유');
    const pol = [...policedSystems(sim)].sort();
    const sts = Object.values(sim.st.stations).filter(s => s.public && pol.includes(sysAt(sim.st.systems, s.pos)?.id ?? '')).sort((a, b) => a.id.localeCompare(b.id));
    const credits = [0, 3000, 2e6];
    for (let p = 0; p < 3; p++) {
      const co = sim.addPlayer(`밀수${p + 1}`); sim.st.companies[co].credits = credits[p];
      const rec = { id: co, cr0: credits[p], groups: [] as string[] }; players.push(rec);
      for (let i = 0; i < 4; i++) {
        const at = sts[(p * 4 + i) % sts.length];
        const pos: V = { x: at.pos.x + 3000 + i * 300, y: 0, z: at.pos.z - 2500 - p * 400 };
        const g = sim.newGroup(co, `밀수${p + 1}-${i + 1}`); g.commanderId = sim.newCommander(co, 1).id;
        const s = sim.spawnShip(co, 'hauler', 'std', g.id, pos) as WShip; s.logisticsExcluded = true;
        s.cargo[hotKey('electronics', victim)] = 40; s.cargo.eq_heavy_cannon = 2; s.cargo.mod_ecm = 3; s.cargo.ore = 30;
        rec.groups.push(g.id);
        lawCrime(sim, { kind: 'extortion', by: co, group: g.id, ship: s.id, sys: sysAt(sim.st.systems, pos)!.id, pos, value: 20000, key: `econ:${p}:${i}` });
      }
      sim.st.companies[co].online = false;      // nobody answers: every stop is treated as compliance
    }
  }
  let worst = 0, total = 0n; const n = Math.round(hours * 3600 / dt);
  for (let i = 0; i < n; i++) { const a = process.hrtime.bigint(); sim.update(dt); const d = process.hrtime.bigint() - a; total += d; worst = Math.max(worst, Number(d) / 1e6); }
  const end = snapshot(sim);
  const out: any = { scenario: name, seed, hours, dt, code, start, end, flows: Object.fromEntries(Object.entries(flows).filter(([k]) => /^(market|trade|production|logistics|ship|combat|currency|blackmarket|law|piracy|faction)/.test(k)).sort()), fineMoney: money,
    meanTickMs: +(Number(total) / 1e6 / n).toFixed(3), worstTickMs: +worst.toFixed(1), saveBytes: sim.serialize().length };
  if (name === 'B') {
    const st = sim.st;
    const per = players.map(p => {
      const co = st.companies[p.id];
      const log = co.bm?.log ?? [];
      const seizes = log.filter(e => e.k === 'seize');
      const seized: Record<string, number> = {};
      for (const e of seizes) for (const [k, v] of Object.entries(e.items ?? {})) seized[k] = (seized[k] ?? 0) + v;
      const cs = Object.values(st.law?.cases ?? {}).filter(c => c.by === p.id);
      const smug = cs.filter(c => c.kind === 'smuggling');
      const aboard: Record<string, number> = {};
      for (const gid of p.groups) for (const id of st.groups[gid]?.shipIds ?? []) for (const [k, v] of Object.entries(st.ships[id]?.cargo ?? {})) if (v > 0) aboard[k] = (aboard[k] ?? 0) + v;
      const before = { credits: Math.round(co.credits), unpaid: co.law?.unpaid ?? 0 };
      // afterwards: money comes in, one ship next to a policed station, pay everything owed
      co.credits += 1e6;
      const pol = [...policedSystems(sim)];
      const stn = Object.values(st.stations).find(s => s.public && pol.includes(sysAt(st.systems, s.pos)?.id ?? ''))!;
      const anyShip = st.ships[st.groups[p.groups[0]]?.shipIds[0]];
      if (anyShip) anyShip.pos = { x: stn.pos.x + 1500, y: 0, z: stn.pos.z };
      const c0 = co.credits;
      const err = sim.command(p.id, { c: 'lawPay' } as any);
      const later = Math.round(c0 - co.credits);
      // what is still owed after the payment (P13.4: only Union cases are payable there; P13.4.1: also station-billed seizures)
      const owedAfter = co.law?.unpaid ?? 0;
      return { company: p.id, credits0: p.cr0, seizures: seizes.length, seized, aboard,
        seizureValue: Math.round(seizes.reduce((a, e) => a + (e.value ?? 0), 0)), seizureFineCollected: seizes.reduce((a, e) => a + (e.fine ?? 0), 0),
        seizureFineOwedLogged: seizes.reduce((a, e) => a + ((e as any).owed ?? 0), 0),
        smugglingCases: smug.map(c => ({ fine: c.fine, paid: c.paid, state: c.state, end: c.end, served: c.served !== undefined, creditor: (c as any).creditor })),
        lawCases: cs.filter(c => c.kind !== 'smuggling').map(c => ({ kind: c.kind, fine: c.fine, paid: c.paid, state: c.state })),
        before, payErr: err, paidLater: later, owedAfter, creditsEnd: Math.round(co.credits) };
    });
    const vco = st.companies[victim];
    const held = (vco.bm?.customs ?? []).reduce((a, l) => a + l.n, 0);
    out.enforcement = { players: per, victimCustomsHeld: held, victimLots: (vco.bm?.customs ?? []).map(l => ({ item: l.item, n: l.n, station: l.station || `site:${l.sys}` })),
      ops: Object.values(st.law?.ops ?? {}).length, opsEnded: Object.values(st.law?.ops ?? {}).map(o => o.end ?? o.phase) };
  }
  return out;
}

const res = { A: scenario('A'), B: scenario('B') };
mkdirSync('docs/law-results', { recursive: true });
writeFileSync(`docs/law-results/p1341-p10-econ-${tag}.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ tag, code, A: { tick: res.A.meanTickMs, worst: res.A.worstTickMs, end: res.A.end.money }, B: res.B.enforcement.players.map((p: any) => ({ s: p.seizures, coll: p.seizureFineCollected, owed: p.before.unpaid, later: p.paidLater, after: p.owedAfter })) }));
