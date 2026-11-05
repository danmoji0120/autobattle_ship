// Long accelerated progression run: a scripted "reasonable player" takes a new PMC through the whole
// loop — mining/trade → own station → refining & parts → research → first own-built ship → fitting →
// expansion — on the real server sim, and reports when each milestone happened, the economy, research,
// conservation sanity and performance.
//   npx vite-node scripts/pmcbot.ts [hours=12] [seed=7] [-v]
import { WorldSim } from '../src/world/sim';
import { ECON, MODULES } from '../src/world/data';
import { HULLS, TECHS, RECIPES, itemPrice } from '../src/world/industry';
import { buildNeeds, stationNeeds, yardSlots } from '../src/world/production';
import { qty } from '../src/world/types';
import type { Station } from '../src/world/types';

const hours = Number(process.argv[2] ?? 12);
const seed = Number(process.argv[3] ?? 7);
const verbose = process.argv.includes('-v');
const shipFirst = process.argv.includes('--ships');
const sim = WorldSim.create(seed);
const me = sim.addPlayer('검증 PMC');
const st = sim.st;
const co = st.companies[me];
const groups = () => Object.values(st.groups).filter(g => g.owner === me);
const G = (name: string) => groups().find(g => g.name === name);
const errs: Record<string, number> = {};
const cmd = (c: any) => { const e = sim.command(me, c); if (e) { const k = `${c.c}: ${e}`; errs[k] = (errs[k] ?? 0) + 1; if (verbose) console.log('  ! ', k); } return e; };
const ships = () => Object.values(st.ships).filter(s => s.owner === me);
const own = (): Station | undefined => Object.values(st.stations).find(s => s.owner === me);
const built = (s: Station, k: string) => s.modules.filter(m => m.kind === k && m.built).length;
const planned = (s: Station, k: string) => s.modules.filter(m => m.kind === k).length;
const milestones: [string, number][] = [];
const mark = (name: string) => { if (!milestones.some(m => m[0] === name)) { milestones.push([name, st.time]); console.log(`★ ${(st.time / 3600).toFixed(2)}h ${name}`); } };

cmd({ c: 'setOp', group: G('제1 채굴반')!.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
cmd({ c: 'setOp', group: G('경비대')!.id, op: { k: 'escort', group: G('제1 채굴반')!.id } });

// facility build order of a sensible industrial start (each needs its credits; tech-gated ones wait)
const PLAN = shipFirst ? ['power', 'refinery', 'smelter', 'alloy_plant', 'hull_works', 'armor_plant', 'warehouse', 'yard_s', 'machine_shop', 'electronics_fab', 'logistics', 'lab_basic', 'weapons_factory', 'power', 'yard_s', 'fitting', 'lab_propulsion', 'engine_plant', 'reactor_plant', 'warehouse'] : ['power', 'refinery', 'warehouse', 'smelter', 'alloy_plant', 'machine_shop', 'hull_works', 'lab_basic', 'armor_plant', 'logistics', 'electronics_fab', 'yard_s', 'power', 'gas_plant', 'weapons_factory', 'lab_propulsion', 'fitting', 'engine_plant', 'reactor_plant', 'design_bureau', 'lab_industry', 'power', 'yard_s', 'warehouse'];
const RESEARCH = ['process_control', 'station_engineering', 'research_methods', 'mining_lasers', 'fusion_reactors', 'ship_propulsion', 'frigate_design', 'refining_2', 'logistics_ai', 'modular_assembly', 'medium_hulls', 'lean_production', 'fire_control', 'composites'];
const STOCK: [string, number][] = [['metal', 300], ['alloy', 400], ['titanium', 80], ['silicon', 120], ['machinery', 60], ['structure', 80], ['armor_plate', 30], ['electronics', 30], ['precision', 16], ['chemicals', 60], ['weapon_parts', 10], ['eq_autocannon', 4], ['eq_pd_gun', 2], ['engine', 2], ['reactor', 2], ['sensor', 2]];
const RAW_BUY = ['titanium_ore', 'silicate', 'crystal', 'gas', 'chemicals'];
let founded = false, hauler: string | undefined;
const perf: number[] = [];
let produced = 0;
const t0 = Date.now();
let lastPolicy = -1e9, lastLog = 0;

function marketBuy(at: string, item: string, n: number, reserve: number) {
  const m = st.stations[at]?.market?.[item]; if (!m) return 0;
  const p = sim.price(st.stations[at], item, 'buy');
  const k = Math.floor(Math.min(n, m.stock - 1, (co.credits - reserve) / Math.max(1, p)));
  if (k < 1) return 0;
  return cmd({ c: 'buy', station: at, res: item, amount: k }) ? 0 : k;
}

function policy() {
  const sh = ships();
  const mg = G('제1 채굴반')!;
  for (const k of Object.values(st.contracts)) if (!k.takenBy && !k.done && (k.kind === 'bounty' || (k.kind === 'delivery' && k.res === 'ore' && k.stationId === 'astra' && !founded)) && Object.values(st.contracts).filter(x => x.takenBy === me && !x.done).length < 3) cmd({ c: 'accept', contract: k.id });
  for (const s of sh) if (s.hp < 0.7 && s.state === 'docked') cmd({ c: 'repair', ship: s.id });
  const base = own();
  // ---- before the station: mine & sell, grow the mining wing
  if (!founded) {
    if (!sh.some(s => s.classId === 'hauler') && co.credits > 6000) cmd({ c: 'buyShip', station: 'astra', classId: 'hauler', loadoutId: 'std', group: mg.id });
    else if (sh.filter(s => s.classId === 'miner').length < 4 && co.credits > 6000) cmd({ c: 'buyShip', station: 'astra', classId: 'miner', loadoutId: 'std', group: mg.id });
    else if (co.credits > 30000) {
      if (!cmd({ c: 'buyShip', station: 'astra', classId: 'constructor', loadoutId: 'std' })) {
        const cg = groups().find(g => g.shipIds.some(id => st.ships[id]?.classId === 'constructor'))!;
        const f = st.fields.kestrel.pos;
        if (!cmd({ c: 'setOp', group: cg.id, op: { k: 'found', at: { x: f.x + 2200, y: 0, z: f.z - 1800 }, name: '제1 공업 기지' } })) { founded = true; mark('정거장 착공'); }
      }
    }
    return;
  }
  if (!base || !base.modules.find(m => m.kind === 'core')?.built) return;
  mark('정거장 코어 완공');
  // miners now feed the station (ore + silicate), keep selling surplus via the market later
  // the first wing keeps selling ore for cash; a second wing feeds the station once it can refine
  if (mg.op.k !== 'mine' || (mg.op as any).deliver !== 'astra') cmd({ c: 'setOp', group: mg.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
  let m2 = G('제2 채굴반');
  if (built(base, 'refinery') && co.credits > 9000 && (!m2 || m2.shipIds.length < 3)) {
    if (!m2) { cmd({ c: 'newGroup', name: '제2 채굴반' }); m2 = G('제2 채굴반'); }
    if (m2) cmd({ c: 'buyShip', station: 'astra', classId: 'miner', loadoutId: 'std', group: m2.id });
  }
  if (m2 && m2.shipIds.length && (m2.op.k !== 'mine' || (m2.op as any).deliver !== base.id)) cmd({ c: 'setOp', group: m2.id, op: { k: 'mine', field: 'grey', deliver: base.id, sell: false } });
  // a dedicated logistics hauler group
  if (!hauler) {
    const hs = sh.find(s => s.classId === 'hauler');
    if (hs) { cmd({ c: 'newGroup', name: '보급선단', ships: [hs.id] }); hauler = G('보급선단')?.id; }
  }
  // facilities
  const S = base.storage[me];
  const queued = base.modules.filter(m => !m.built).length;
  const waitingBuild = (base.builds ?? []).some(b => !b.started);
  if (queued < 2 && !waitingBuild) {
    const counts: Record<string, number> = {};
    for (const k of PLAN) {
      counts[k] = (counts[k] ?? 0) + 1;
      if (planned(base, k) >= counts[k]) continue;
      const f = MODULES[k];
      if (f.tech && !co.tech?.includes(f.tech)) continue;
      if (co.credits < f.credits + 1500) break;
      if (!cmd({ c: 'queueModule', station: base.id, kind: k })) break;
    }
  }
  // standing production orders for what exists
  for (const [item, n] of STOCK) {
    const r = Object.values(RECIPES).find(x => x.out[item] && (!x.tech || co.tech?.includes(x.tech)) && built(base, x.fac) > 0 && x.id !== 'alloy_direct' && x.id !== 'alloy_scrap');
    if (!r) continue;
    if ((base.orders ?? []).some(o => RECIPES[o.recipe].out[item])) continue;
    cmd({ c: 'prodOrder', station: base.id, recipe: r.id, mode: 'stock', n });
  }
  if (built(base, 'refinery') && !built(base, 'alloy_plant') && !(base.orders ?? []).some(o => o.recipe === 'alloy_direct')) cmd({ c: 'prodOrder', station: base.id, recipe: 'alloy_direct', mode: 'stock', n: 600 });
  // research
  if (built(base, 'lab_basic')) for (const t of RESEARCH) {
    if (co.tech?.includes(t) || co.research?.some(r => r.tech === t)) continue;
    if ((co.research ?? []).length >= 3) break;
    if (co.credits < TECHS[t].credits + 3000) break;
    cmd({ c: 'research', station: base.id, tech: t });
  }
  // buy what the station is short of (raw inputs, parts that cannot be made yet) and haul it home
  const need = stationNeeds(base);
  for (const m of base.modules) if (!m.built) for (const [r, n] of Object.entries(MODULES[m.kind].mats)) { const x = n - (m.reserved?.[r] ?? 0) - (m.used?.[r] ?? 0) - qty(S, r); if (x > 0) need[r] = Math.max(need[r] ?? 0, x); }
  for (const b of base.builds ?? []) if (!b.started) for (const [r, n] of Object.entries(buildNeeds(b.classId, b.loadoutId, b.fit))) { const x = n - qty(S, r); if (x > 0) need[r] = Math.max(need[r] ?? 0, x); }
  for (const r of RAW_BUY) if (qty(S, r) < 60) need[r] = Math.max(need[r] ?? 0, 120);
  let bought = 0;
  for (const [r, n] of Object.entries(need).sort((a, b) => itemPrice(b[0]) * b[1] - itemPrice(a[0]) * a[1])) {
    const makeable = Object.values(RECIPES).some(x => x.out[r] && built(base, x.fac) > 0 && (!x.tech || co.tech?.includes(x.tech)));
    if (makeable && !['engine', 'reactor', 'sensor'].includes(r) && r !== 'alloy') continue;
    for (const at of ['astra', 'bastion', 'nova', 'barcaco', 'helios']) { const k = marketBuy(at, r, Math.ceil(n), ['engine', 'reactor', 'sensor', 'eq_autocannon', 'eq_pd_gun', 'eq_torpedo'].includes(r) ? 3000 : 25000); if (k) { bought += k * itemPrice(r); if (hauler) cmd({ c: 'setOp', group: hauler, op: { k: 'haul', from: at, to: base.id, res: built(base, 'logistics') ? '*auto' : '*all' } }); break; } }
  }
  // the first own hulls
  if (yardSlots(base).length) {
    mark('조선소 가동');
    const mine = (base.builds ?? []).length;
    if (mine < 1 && co.credits > HULLS.corvette.credits + 15000) cmd({ c: 'buildShip', station: base.id, classId: co.tech?.includes('frigate_design') && sh.filter(s => s.classId === 'corvette').length > 3 ? 'frigate' : 'corvette', loadoutId: co.tech?.includes('frigate_design') && sh.filter(s => s.classId === 'corvette').length > 3 ? 'patrol' : 'gun' });
  }
  // fitting: put stored modules on docked warships at home
  for (const s of sh) if (s.state === 'docked' && (s.task as any).station === base.id && !s.fit?.length && qty(S, 'mod_engine') >= 1 && HULLS[s.classId]) cmd({ c: 'fitShip', ship: s.id, fit: ['mod_engine'] });
  // expansion: a second mining group once the base runs
  if (built(base, 'logistics') && mg.shipIds.length < 6 && co.credits > 40000) cmd({ c: 'buyShip', station: 'astra', classId: 'miner', loadoutId: 'std', group: mg.id });
  void bought;
}

const DT = 0.5;
for (let step = 0; st.time < hours * 3600; step++) {
  const a = performance.now();
  sim.update(DT);
  perf.push(performance.now() - a);
  if (st.time - lastPolicy >= 30) { lastPolicy = st.time; policy(); }
  for (const s of ships()) if ((s as any)._seen !== true) {
    (s as any)._seen = true;
    if (st.time > 10 && HULLS[s.classId] && !['miner', 'hauler', 'constructor'].includes(s.classId) && st.events.slice(-30).some(e => e.company === me && /진수/.test(e.text))) mark(`첫 자체 건조 ${s.classId}`);
  }
  if (co.tech?.length && !milestones.some(m => m[0] === '첫 연구 완료')) mark('첫 연구 완료');
  if (st.time - lastLog >= (process.argv.includes('--fine') ? 900 : 3600)) {
    lastLog = st.time;
    const base = own();
    const sh = ships();
    const nw = co.credits + sh.reduce((x, s) => x + (ECON[s.classId]?.price ?? 0), 0);
    let neg = 0, nan = 0;
    for (const x of Object.values(st.stations)) for (const c of Object.values(x.storage)) for (const v of Object.values(c)) { if (v < -1e-6) neg++; if (!Number.isFinite(v)) nan++; }
    produced = (base?.orders ?? []).reduce((x, o) => x + o.done, 0);
    const p = perf.slice(-7200).sort((x, y) => x - y);
    console.log(`[${(st.time / 3600).toFixed(0)}h] cr=${Math.round(co.credits).toLocaleString()} 순자산≈${Math.round(nw).toLocaleString()} 함선=${sh.length} (${[...new Set(sh.map(s => s.classId))].map(c => c + '×' + sh.filter(s => s.classId === c).length).join(' ')}) 시설=${base ? base.modules.filter(m => m.built).length + '/' + base.modules.length : '-'} 기술=${co.tech?.length ?? 0} 연구중=${co.research?.length ?? 0} 주문완료=${produced} 건조대기=${base?.builds?.length ?? 0} 평판=${co.rep} 격침=${co.stats.kills} 손실=${co.stats.lost} | 음수=${neg} NaN=${nan} | tick p50=${p[p.length >> 1]?.toFixed(2)}ms p99=${p[Math.floor(p.length * 0.99)]?.toFixed(2)}ms 세이브=${(sim.serialize().length / 1024).toFixed(0)}KB heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
    if (base?.builds?.length) console.log('   builds', base.builds.map(b => `${b.classId}:${b.started ? Math.round((1 - b.left / b.total) * 100) + '%' : ''} ${b.why}`).join(' | '), '| hauler', hauler ? `${st.groups[hauler]?.status} ${JSON.stringify(st.groups[hauler]?.op)}` : '-');
    if (base && verbose) console.log('   storage', Object.entries(base.storage[me]).filter(([, v]) => v >= 1).map(([k, v]) => `${k}:${Math.round(v)}`).join(' '));
    if (base && verbose) console.log('   orders', (base.orders ?? []).map(o => `${o.recipe}:${o.done}${o.why ? '(' + o.why + ')' : ''}`).join(' '));
  }
}
const base = own();
console.log('\n== milestones'); for (const [n, t] of milestones) console.log(`  ${(t / 3600).toFixed(2)}h  ${n}`);
console.log('== tech', co.tech?.join(', '));
console.log('== built', base?.modules.filter(m => m.built).map(m => m.kind).join(', '));
console.log('== ships', ships().map(s => s.classId + (s.fit?.length ? '[' + s.fit + ']' : '')).join(', '));
console.log('== orders', (base?.orders ?? []).map(o => `${o.recipe}:${o.done}${o.why ? '(' + o.why + ')' : ''}`).join(' '));
console.log('== command errors (count)'); for (const [k, n] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n}× ${k}`);
const p = perf.sort((x, y) => x - y);
console.log(`== perf: ${(hours).toFixed(1)}h sim in ${((Date.now() - t0) / 1000).toFixed(0)}s wall (×${(hours * 3600 / ((Date.now() - t0) / 1000)).toFixed(0)}), tick(${DT}s) p50 ${p[p.length >> 1].toFixed(2)}ms p99 ${p[Math.floor(p.length * 0.99)].toFixed(2)}ms max ${p[p.length - 1].toFixed(1)}ms; save ${(sim.serialize().length / 1024).toFixed(0)} KB`);
// restart: the save restores and keeps running identically for 10 minutes
const sim2 = new WorldSim(JSON.parse(sim.serialize()));
for (let i = 0; i < 1200; i++) { sim.update(DT); sim2.update(DT); }
const canon = (x: any): any => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])])) : x;
console.log('== restart determinism (10 min after reload):', JSON.stringify(canon(JSON.parse(sim.serialize()))) === JSON.stringify(canon(JSON.parse(sim2.serialize()))) ? 'identical' : 'DIFFERENT');
{
  const a = JSON.parse(sim.serialize()), b = JSON.parse(sim2.serialize());
  const out: string[] = [];
  const walk = (x: any, y: any, p: string) => {
    if (out.length > 12) return;
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) { if (x !== y) out.push(`${p}: ${JSON.stringify(x)?.slice(0, 80)} vs ${JSON.stringify(y)?.slice(0, 80)}`); return; }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p + '.' + k);
  };
  walk(a, b, '');
  console.log(out.join('\n'));
}
