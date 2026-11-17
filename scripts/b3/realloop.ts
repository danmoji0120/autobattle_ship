// B-3 real first-sovereignty loop. A mining company in the standard world takes an outer system using only the
// normal game systems and the commands a player sends:
//   economic activity (mining fleets selling ore) → funds → ships bought at public yards → a station founded by a
//   constructor → facilities through the construction queue (materials bought by automatic procurement and carried
//   by the company's haulers) → warships bought, officers hired, gates and station patrolled → declaration →
//   governance facility built → administration goods bought at markets and hauled in by logistics jobs every few
//   hours → control rises → stabilisation → sovereignty.
// The only stand-in is the starting capital (a grown company's savings: credits, recorded below). No territory,
// station, facility, ship, cargo or control state is written directly. The whole world runs (sim.update).
//   npx tsx scripts/b3/realloop.ts [system=gloam] [maxHours=72] [capital=4000000] [holdHours=24]
// After establishment the company keeps running the territory for holdHours (upkeep, goods, fleet) to see whether
// a grown company can afford to hold it.
import fs from 'fs';
import { WorldSim } from '../../src/world/sim';
import { STANDARD_WORLD } from '../../src/world/worldPreset';
import { evaluate, stageOf, sovReport, STAGE_NAME, CLASS, regionClass, supplyNeed, govStation, powerIn, powerNeed } from '../../src/world/sovereignty';
import { spot } from '../../tests/helpers/territory';
import { econOf } from '../../src/world/hullops';
import { opsOf } from '../../src/world/operations';
import { qty } from '../../src/world/types';
import { jumps } from '../../src/world/geom';
import { itemPrice } from '../../src/world/industry';
import { bumpStanding } from '../../src/world/territory';
import { rateClass } from '../../src/world/combatRating';

const SYS = process.argv[2] ?? 'gloam', MAX = +(process.argv[3] ?? 72), CAPITAL = +(process.argv[4] ?? 4_000_000), HOLD = +(process.argv[5] ?? 24);
const OUT = process.env.OUT ?? 'artifacts/b3';
const sim = WorldSim.create(41, { ...STANDARD_WORLD });
const w = sim.st;
const A = sim.addPlayer('개척 광업', 'miner');
const co = w.companies[A];
const log: string[] = [];
const say = (s: string) => { const l = `[${((w.time - T0) / 3600).toFixed(2)}h] ${s}`; log.push(l); console.log(l); };
const cmd = (c: any) => { const e = sim.command(A, c); if (e) say(`  ✗ ${c.c}${c.op?.k ? '/' + c.op.k : ''}${c.kind ? '/' + c.kind : ''}: ${e}`); return e; };
for (let i = 0; i < 300; i++) sim.update(1);
const T0 = w.time;
// starting conditions of a grown company (the only stand-ins): savings, and the trust of the shipyard factions a
// company earns over its first weeks of contracts (military hulls are sold only to trusted companies)
co.credits += CAPITAL;
const TRUST = 10;
for (const id of ['astra', 'drakeout', 'bastion']) { const f = w.stations[id]?.faction; if (f) bumpStanding(w, A, f, TRUST - (co.standing?.[f] ?? 0)); }
const credit0 = co.credits;
const sys = w.systems[SYS], cls = regionClass(w, sys), rule = CLASS[cls];
say(`target ${SYS} (${cls}, ${jumps(w.systems, w.stations[co.homeStation] ? sim.sysOf(w.stations[co.homeStation].pos)!.id : SYS, SYS)} jumps), capital ${credit0.toLocaleString()} cr; rule: station ${rule.station}, defence ${rule.defense}, stabilise ${rule.stabH} h`);

// money ledger by category, summed over the whole run (the company ledger keeps 48 h)
const tot = { inc: {} as Record<string, number>, exp: {} as Record<string, number> };
let lastH = -1;
function absorbLedger(all = false) {
  const L = opsOf(co).ledger;
  for (const b of L) if (b.h > lastH && (all || b.h < Math.floor(w.time / 3600))) {
    for (const [k, v] of Object.entries(b.inc)) tot.inc[k] = (tot.inc[k] ?? 0) + v;
    for (const [k, v] of Object.entries(b.exp)) tot.exp[k] = (tot.exp[k] ?? 0) + v;
    lastH = b.h;
  }
}

const shipsOf = (cls?: string) => Object.values(w.ships).filter(s => s.owner === A && (!cls || s.classId === cls));
const yardFor = (c: string) => ['astra', 'drakeout', 'bastion', 'exchange', 'barcaco', 'helios'].find(id => w.stations[id]?.services.shipyard.includes(c))!;
function buy(c: string, lo: string, group?: string) { return cmd({ c: 'buyShip', station: yardFor(c), classId: c, loadoutId: lo, ...(group ? { group } : {}) }); }
/** a warship for a post: patrol frigates where a yard has one in stock, else the next escort hull that does
 *  (public yards keep a small stock and rebuild it from their own materials) */
const WAR: [string, string][] = [['frigate', 'patrol'], ['destroyer', 'aa'], ['corvette', 'torp'], ['light_cruiser', 'gun']];
function buyWarship(group: string): boolean {
  for (const [c, lo] of WAR) for (const y of ['astra', 'drakeout', 'bastion', 'helios']) {
    if (!w.stations[y]?.services.shipyard.includes(c)) continue;
    if (!sim.command(A, { c: 'buyShip', station: y, classId: c, loadoutId: lo, group } as any)) { say(`  bought ${c}/${lo} at ${y}`); return true; }
  }
  return false;
}
const groupOf = (s: { groupId: string }) => w.groups[s.groupId];

// ── 1. economic activity: three more miners join the starting mining fleet; all mine and sell
const mineGroup = Object.values(w.groups).find(g => g.owner === A && sim.subtreeShips(g).some(s => econOf(s).mine > 0))!;
for (let i = 0; i < 3; i++) buy('miner', 'std', mineGroup.id);
// automatic procurement buys construction materials; the company's haulers carry them (logistics pool)
// (a purchase ceiling per material: up to 3× the list price)
for (const item of ['alloy', 'structure', 'machinery', 'weapon_parts', 'electronics', 'chemicals'])
  cmd({ c: 'procPolicy', settings: { enabled: true, autoBuy: true, budget: 1_500_000, minCredits: 150_000, maxRisk: 100, priceItem: item, maxUnitPrice: Math.ceil(itemPrice(item) * 3) } });
for (let i = 0; i < 3; i++) buy('hauler', 'std');
// the constructor that founds the station
buy('constructor', 'std');
const ctor = shipsOf('constructor')[0];
const site = spot(sim, SYS, 0);

let phase = 'found', station: string | undefined, declared = false, govQueued = false, minesSet = false;
const posts: string[] = [];
const need = supplyNeed(cls);
let estAt: number | null = null, govAt: number | null = null, declAt: number | null = null, stationAt: number | null = null, fleetAt: number | null = null;
const timeline: any[] = [], hold: any[] = [];
let estCredits = 0, midSaved = false, estLedger: any = null;

function setMining() {
  // every miner (also the ones that arrived later) mines the home ore field and sells at home
  const op = mineGroup.op as any;
  if (op.k === 'mine' && minesSet) return;
  // the home system's plain ore field (the first-business guide's choice), else the first field there
  const f = w.fields.p9_anvil_ore ?? Object.values(w.fields).filter(x => sim.sysOf(x.pos)?.id === sim.sysOf(w.stations[co.homeStation].pos)?.id).sort((a, b) => a.id < b.id ? -1 : 1)[0];
  for (const m of shipsOf('miner')) if (m.groupId !== mineGroup.id && m.state === 'docked') cmd({ c: 'moveShip', ship: m.id, group: mineGroup.id });
  if (!cmd({ c: 'setOp', group: mineGroup.id, op: { k: 'mine', field: f.id, deliver: co.homeStation, sell: true } })) minesSet = true;
}
/** like a player watching sale prices: when the market the miners sell to is glutted with ore (stock over 4× its
 *  target, so the price has collapsed), deliver to the nearest public market (fewest jumps from the field) that
 *  still wants ore. The field itself regenerates (its gauge sits near empty while miners work it; that is not depletion). */
let lastDeliver = '';
function rotateMarket() {
  const op = mineGroup.op as any; if (op.k !== 'mine') return;
  const cur = w.stations[op.deliver]?.market?.ore; if (cur && cur.stock < cur.target * 4 && !/하역지 사용 불가/.test(mineGroup.status ?? '')) return;
  const fs = sim.sysOf(w.fields[op.field].pos)!.id;
  // the market must buy everything the field yields (an ore field also gives titanium ore): a market that does not
  // take part of the hold leaves the miners waiting with cargo ("하역지 사용 불가")
  const yields = Object.keys(w.fields[op.field].mix ?? { [w.fields[op.field].res]: 1 });
  const m = Object.values(w.stations).filter(x => x.public && x.market && yields.every(k => x.market![k]) && x.id !== op.deliver && yields.every(k => x.market![k].stock < x.market![k].target))
    .map(x => ({ x, j: jumps(w.systems, fs, sim.sysOf(x.pos)!.id) })).sort((a, b) => a.j - b.j || (a.x.id < b.x.id ? -1 : 1))[0]?.x;
  if (m && m.id !== lastDeliver && !cmd({ c: 'setOp', group: mineGroup.id, op: { ...op, deliver: m.id, sell: true } })) { lastDeliver = m.id; say(`  ore glut at ${op.deliver} (stock ${Math.round(cur?.stock ?? 0)} / target ${cur?.target}) → selling at ${m.id}`); }
}

let perPost = 0;
function postWarships() {
  // one squadron per gate and one at the station, each under a hired officer, all patrolling their post
  const st = w.stations[station!];
  const targets = [...sys.gates.map(g => ({ name: `${g.name} 경비`, at: { x: g.pos.x + (sys.origin.x - g.pos.x) * 0.05, y: 0, z: g.pos.z + (sys.origin.z - g.pos.z) * 0.05 } })), { name: '기지 경비', at: st.pos }];
  const pn = powerNeed(sim, A, SYS) * 1.25;
  perPost = Math.ceil(pn / 100 / targets.length);       // patrol frigates rate ≈ 100 (combatRating.ts)
  for (const t of targets) {
    if (cmd({ c: 'newGroup', name: t.name })) continue;
    const g = Object.values(w.groups).filter(x => x.owner === A && x.name === t.name).at(-1)!;
    posts.push(g.id); post.set(g.id, t.at);
  }
  say(`warships: ${posts.length} posts × ${perPost} patrol frigates (requirement ${powerNeed(sim, A, SYS)})`);
}
const post = new Map<string, any>();
let lastBuyFail = -1e9;
function manPosts() {
  for (const id of posts) {
    const g = w.groups[id]; if (!g) continue;
    // buy up to strength (losses are replaced); hire an officer once
    // strength of the post in combat rating (lost or damaged ships are replaced by buying more)
    const have = g.shipIds.reduce((a, x) => a + (w.ships[x] ? rateClass(w.ships[x].classId, w.ships[x].loadoutId) : 0), 0);
    if (have < perPost * 100 && w.time - lastBuyFail > 1800) { let r = have; while (r < perPost * 100) { if (!buyWarship(g.id)) { lastBuyFail = w.time; say('  no warship in stock at any yard — retry in 30 min'); break; } r = g.shipIds.reduce((a, x) => a + (w.ships[x] ? rateClass(w.ships[x].classId, w.ships[x].loadoutId) : 0), 0); } }
    if (!g.commanderId) {
      const free = Object.values(w.commanders).filter(c => !c.owner && c.stationId).sort((a, b) => a.hireCost - b.hireCost || (a.id < b.id ? -1 : 1))[0];
      if (free && !cmd({ c: 'hire', commander: free.id })) cmd({ c: 'assignCmd', group: g.id, commander: free.id });
    }
    if (g.op.k !== 'patrol' && g.shipIds.some(x => w.ships[x]?.state === 'docked' || w.ships[x]?.state === 'space')) {
      const at = post.get(id);
      const o = sys.origin, b = { x: at.x + (o.x - at.x) * 0.04, y: 0, z: at.z + (o.z - at.z) * 0.04 };
      cmd({ c: 'setOp', group: id, op: { k: 'patrol', at, radius: 2500, route: [at, b] } });
    }
  }
}
// administration goods: bought at the nearest market that sells them, hauled to the seat by a logistics job
const markets = () => Object.values(w.stations).filter(s => s.public && s.market).sort((a, b) => jumps(w.systems, sim.sysOf(a.pos)!.id, SYS) - jumps(w.systems, sim.sysOf(b.pos)!.id, SYS));
const inbound = (item: string) => Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === A && j.to === station && j.item === item && j.state !== "cancelled" && j.state !== "complete").reduce((a, j) => a + j.amount - j.delivered, 0);
function supplySeat() {
  const G = govStation(sim, A, SYS); if (!G) return;
  const sto = G.storage[A];
  const res = w.sov?.sys[SYS]?.gov?.[A]?.res ?? {};
  for (const [k, perH] of Object.entries(need)) {
    const have = qty(sto, k) + (res[k] ?? 0) + inbound(k);
    // steady deliveries: the logistics condition counts at most 3 h of need per item per hour of arrival, so a
    // careful player sends about 3 h worth whenever less than 6 h is at the seat or on the way
    if (have >= perH * 6) continue;
    const amount = Math.ceil(perH * 3);
    const m = markets().find(s => (s.market?.[k]?.stock ?? 0) >= amount);
    if (!m) { say(`  no market stocks ${amount} ${k}`); continue; }
    if (cmd({ c: 'buy', station: m.id, res: k, amount })) continue;
    cmd({ c: 'poolCreate', request: { from: m.id, to: G.id, item: k, kind: 'transfer', amount, priority: 8, repeat: false } });
    say(`  admin goods: bought ${amount} ${k} at ${m.id}, logistics job → seat`);
  }
}

const t0 = Date.now();
for (let m = 0; m < MAX * 60; m++) {
  for (let i = 0; i < 60; i++) sim.update(1);
  if (!minesSet) setMining();
  if (minesSet && m % 30 === 0) rotateMarket();
  if (phase === 'found') {
    if (ctor && ctor.state === 'docked' && groupOf(ctor).op.k !== 'found') {
      if (!cmd({ c: 'setOp', group: ctor.groupId, op: { k: 'found', at: site, name: '개척 기지', size: 'M' } })) { phase = 'founding'; say(`constructor sent to found the station in ${SYS}`); }
    }
  } else if (phase === 'founding') {
    const st = Object.values(w.stations).find(s => s.owner === A && sim.sysOf(s.pos)?.id === SYS);
    if (st) {
      station = st.id; stationAt = w.time; phase = 'build';
      say(`station founded: ${st.name} (${st.size})`);
      for (const k of ['power', 'power', 'warehouse', ...Array(rule.defense).fill('defense')]) cmd({ c: 'queueModule', station: st.id, kind: k });
    }
  } else if (phase === 'build') {
    const st = w.stations[station!];
    if (st.modules.some(x => x.kind === 'core' && x.built) && !posts.length) { postWarships(); fleetAt = w.time; }
    if (posts.length && m % 10 === 0) manPosts();
    if (!declared && stageOf(sim, A, SYS) >= 3) {
      if (!cmd({ c: 'sov', op: 'declare', sys: SYS })) { declared = true; declAt = w.time; say('declared'); }
    }
    if (declared && !govQueued) { if (!cmd({ c: 'queueModule', station: st.id, kind: 'governance' })) { govQueued = true; say('governance queued'); } }
    if (govQueued && !govAt && govStation(sim, A, SYS)) { govAt = w.time; say('governance facility running'); }
    if (govAt && m % 30 === 0) supplySeat();
  }
  if (m % 60 === 59) {
    absorbLedger();
    const r = w.sov?.sys[SYS];
    const rep = evaluate(sim, A, SYS);
    const row = { h: +((w.time - T0) / 3600).toFixed(1), stage: STAGE_NAME[stageOf(sim, A, SYS, rep)], credits: Math.round(co.credits), ctl: Math.round(r?.ctl[A] ?? 0), prog: +(((r?.claims[A]?.prog ?? 0) / 3600).toFixed(2)), power: Math.round(powerIn(sim, A, SYS)), need: powerNeed(sim, A, SYS),
      ships: shipsOf().length, sales: Math.round(tot.inc.sales ?? 0), fails: Object.entries(rep).filter(([, c]) => !c.ok).map(([k, c]) => `${k}[${c.miss.join(';')}]`) };
    timeline.push(row);
    say(`${row.stage} ctl ${row.ctl} prog ${row.prog}/${rule.stabH} power ${row.power}/${row.need} ships ${row.ships} cr ${row.credits.toLocaleString()} sales ${row.sales.toLocaleString()} | ${row.fails.join(' ')} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    // a snapshot in the middle of stabilisation (for the real-server browser check of the progress screens)
    if (!midSaved && (r?.claims[A]?.prog ?? 0) >= 3 * 3600) { midSaved = true; fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(`${OUT}/realloop-${SYS}.mid.save.json`, sim.serialize()); say('mid-stabilisation snapshot saved'); if (process.env.STOP_AT_MID) break; }
    if (r?.owner === A && estAt === null) { estAt = w.time; estCredits = co.credits; estLedger = JSON.parse(JSON.stringify(tot)); say('ESTABLISHED'); }
    if (estAt !== null) hold.push({ h: +((w.time - estAt) / 3600).toFixed(1), owner: r?.owner === A, stab: Math.round(r?.stab ?? 0), arrears: Math.round(r?.arrears ?? 0), credits: Math.round(co.credits), stalled: r?.gov?.[A]?.short ?? 0 });
    if (estAt !== null && w.time - estAt >= HOLD * 3600) break;
  }
}
absorbLedger(true);
const row = sovReport(sim, A).rows.find(x => x.sys === SYS);
const result = {
  system: SYS, cls, capital: CAPITAL, established: estAt !== null, hours: estAt !== null ? +((estAt - T0) / 3600).toFixed(2) : null,
  milestones: { station: stationAt && +((stationAt - T0) / 3600).toFixed(2), fleet: fleetAt && +((fleetAt - T0) / 3600).toFixed(2), declared: declAt && +((declAt - T0) / 3600).toFixed(2), governance: govAt && +((govAt - T0) / 3600).toFixed(2) },
  creditsStart: Math.round(credit0), creditsEnd: Math.round(co.credits), netSpent: Math.round(credit0 - co.credits),
  ledger: { income: Object.fromEntries(Object.entries(tot.inc).map(([k, v]) => [k, Math.round(v)])), expense: Object.fromEntries(Object.entries(tot.exp).map(([k, v]) => [k, Math.round(v)])) },
  ships: Object.entries(shipsOf().reduce((a, s) => (a[s.classId] = (a[s.classId] ?? 0) + 1, a), Object.create(null) as Record<string, number>)),
  report: row && { upkeep: (row as any).upkeep, supply: (row as any).supply, power: row.power, needPower: row.needPower },
  hold: estAt !== null ? { hours: hold.at(-1)?.h, ownerAtEnd: hold.at(-1)?.owner, stabMin: Math.min(...hold.map(x => x.stab)), stabEnd: hold.at(-1)?.stab, arrearsMax: Math.max(...hold.map(x => x.arrears)), creditsAtEst: Math.round(estCredits), creditsEnd: Math.round(co.credits), netPerHour: Math.round((co.credits - estCredits) / Math.max(1, (w.time - estAt) / 3600)), stalledMaxS: Math.max(...hold.map(x => x.stalled)) } : null,
  wallS: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(result, null, 1));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/realloop-${SYS}.json`, JSON.stringify({ result, timeline, log }, null, 1));
fs.writeFileSync(`${OUT}/realloop-${SYS}.save.json`, sim.serialize());
if (process.env.DEBUG) {
  const st = station ? w.stations[station] : undefined;
  console.log('modules', JSON.stringify(st?.modules.map(m => ({ k: m.kind, p: +(m.progress ?? 0).toFixed(2), b: m.built, r: m.reserved, u: m.used }))));
  console.log('storage', JSON.stringify(st?.storage[A]));
  console.log('jobs', JSON.stringify(Object.values(w.logisticsJobs ?? {}).filter(j => j.owner === A).map(j => ({ i: j.item, k: j.kind, f: j.from, t: j.to, a: j.amount, s: j.state, d: j.delivered, why: j.reason, ship: j.ship }))));
  console.log('proc', JSON.stringify(Object.values(w.procurementPlans ?? {}).filter(p => p.owner === A).map(p => ({ i: p.item, s: p.state, r: p.reason, short: p.shortage }))).slice(0, 2500));
  for (const s of shipsOf()) console.log(s.classId, s.state, (s.task as any).k, w.groups[s.groupId].op.k, JSON.stringify(s.cargo ?? {}).slice(0, 80), sim.sysOf(s.pos)?.id);
}
