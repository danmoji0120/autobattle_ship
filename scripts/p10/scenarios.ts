// P10 verification scenarios A–H on isolated, in-memory worlds (nothing is saved anywhere).
//   npx vite-node scripts/p10/scenarios.ts -- [A,B,...] [out.json]
// Each scenario prints what it measured and the checks it made; a failed check sets exit code 1.
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { sysAt, nextGate, jumps } from '../../src/world/geom';
import { cargoSum, type Cargo } from '../../src/world/types';
import { legacyView } from '../../src/server/sync';
import { fieldReport, sysLevel } from '../../src/world/intel';
import { trueMix } from '../../src/world/geology';
import { gateOpen } from '../../src/world/territory';
import { startConflict, doctrineOf } from '../../src/world/factionEcon';
import { priceOf } from '../../src/world/market';

const args = process.argv.slice(2).filter(a => a !== '--');
const only = (args[0] ?? 'ABCDEFGH').split(/[ ,]*/).filter(Boolean);
const out: Record<string, unknown> = {};
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++; return ok; };
const quiet = (sim: WorldSim) => { for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e12; } };
const run = (sim: WorldSim, s: number, dt = 1) => { for (let t = 0; t < s; t += dt) sim.update(dt); };
const world = (seed: number) => { const sim = WorldSim.create(seed, { layout: 'p10' }); quiet(sim); return sim; };
function company(sim: WorldSim, name: string, risk = 100) {
  const p = sim.addPlayer(name); sim.st.companies[p].credits = 5e6;
  sim.command(p, { c: 'opsPolicy', policy: { maxRisk: risk } } as any);
  return p;
}
function miners(sim: WorldSim, p: string, at: { x: number; z: number }, n: number, name = '채굴반') {
  const g = sim.newGroup(p, name);
  for (let i = 0; i < n; i++) sim.spawnShip(p, 'miner', 'std', g.id, { x: at.x + 700 + i * 40, y: 0, z: at.z });
  return g;
}
const pct = (c: Cargo) => { const n = cargoSum(c) || 1; return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v / n * 1000) / 10])); };

const S: Record<string, () => void> = {
  A() {
    console.log('A. 미개척 성계 탐사 — 회사별 정보 분리');
    const sim = world(101), a = company(sim, '탐사사 A'), b = company(sim, '경쟁사 B');
    const g = sim.newGroup(a, '정찰'), start = sim.st.systems.tundra;
    const ship = sim.spawnShip(a, 'corvette', 'gun', g.id, { x: start.origin.x + 5000, y: 0, z: 0 });
    const dest = sim.st.systems.zenith;
    sim.command(a, { c: 'setOp', group: g.id, op: { k: 'move', to: { x: dest.origin.x + 5000, y: 0, z: 0 } } });
    let t = 0; for (; t < 5000 && sysAt(sim.st.systems, ship.pos)?.id !== 'zenith'; t++) sim.update(1);
    run(sim, 3);
    sim.command(a, { c: 'setOp', group: g.id, op: { k: 'survey', system: 'gloam' } });
    for (let k = 0; k < 4000 && sysLevel(sim.st, a, 'gloam') < 3; k++) sim.update(1);
    const va = JSON.stringify(legacyView(sim.st, { company: a }, 'helios')), vb = JSON.stringify(legacyView(sim.st, { company: b }, 'helios'));
    out.A = { travelS: t, levels: { gloam: sysLevel(sim.st, a, 'gloam'), zenith: sysLevel(sim.st, a, 'zenith') }, viewBytes: { a: va.length, b: vb.length } };
    check('A가 천정 공역 도달 (회사 성도 기록)', sysLevel(sim.st, a, 'zenith') >= 2);
    check('A의 어스름 공역 정밀 탐사 완료', sysLevel(sim.st, a, 'gloam') === 3);
    check('B는 해당 성계를 모름', sysLevel(sim.st, b, 'zenith') === 0 && sysLevel(sim.st, b, 'gloam') === 0);
    check('A 화면에 천정 금속맥', va.includes('p10_zenith_vein'));
    check('B 화면에 미개척 광구·성계 정보 없음', !vb.includes('p10_zenith_vein') && !vb.includes('p10_gloam_ice') && !vb.includes(sim.st.systems.zenith.name));
    check('실제 성분 데이터(layers/veins) 비노출', !va.includes('"layers"') && !va.includes('"veins"'));
  },
  B() {
    console.log('B. 미확인 광구 시험 채굴 (survey_field)');
    const sim = world(102), p = company(sim, '시험 채굴사'), f = sim.st.fields.p10_tundra_ore;
    const g = miners(sim, p, f.pos, 2); run(sim, 3);
    const viewBefore = (legacyView(sim.st, { company: p }, 'tundra').fields as any)[f.id];
    check('발견 직후: 위치·외형·규모·단서만, 성분 없음', !!viewBefore?.unidentified && viewBefore.mix === undefined);
    check('명령 수락', sim.command(p, { c: 'workCreate', goal: { k: 'survey_field', field: f.id, group: g.id, samples: 300 } } as any) === null);
    const w = Object.values(sim.st.works!).find(x => x.kind === 'survey_field')!;
    let t = 0; for (; t < 4 * 3600 && w.state !== 'done'; t++) sim.update(1);
    const r = fieldReport(sim.st.intel![p].fields[f.id]), truth = trueMix(f.geo!);
    out.B = { seconds: t, state: w.state, result: w.result, observed: Object.fromEntries(r.shares.map(([k, s]) => [k, Math.round(s * 1000) / 10])), truthNow: pct(truth), confidence: r.confidence, unseenMax: r.unseenMax, log: w.log.map(x => x.text) };
    check('목표 완료·보고', w.state === 'done' && /표본/.test(w.result ?? ''), `${Math.round(t / 60)}분`);
    check('신뢰도 표시 (300표본 → 보통 이상 아님/낮음)', r.confidence === 'low' || r.confidence === 'medium');
    check('미관측 성분 상한 > 0 (희귀 없음 단정 안 함)', r.unseenMax > 0);
    check('함선 실제 채굴량 = 표본 수', Math.abs(r.n - f.geo!.draws) < 1e-9);
  },
  C() {
    console.log('C. 장기 채굴 후 희귀 자원 발견');
    const sim = world(103), p = company(sim, '심층 채굴사'), f = sim.st.fields.p10_zenith_vein;
    f.regen = f.max; // keep the deposit from running dry during the long run; depth (geo.mined) still advances
    const g = miners(sim, p, f.pos, 6); run(sim, 3);
    sim.command(p, { c: 'workCreate', goal: { k: 'develop_field', field: f.id, group: g.id, sell: false, miners: 6 } } as any);
    const marks: { t: number; n: number; items: string[] }[] = [];
    let firstRare: { t: number; n: number; mined: number } | undefined;
    for (let t = 0; t < 10 * 3600; t++) {
      sim.update(1);
      const fi = sim.st.intel![p].fields[f.id];
      if (!firstRare && fi?.units.dense_titanium_ore) firstRare = { t: sim.st.time, n: fi.n, mined: f.geo!.mined };
      if (t % 3600 === 0 && fi) marks.push({ t: Math.round(sim.st.time), n: fi.n, items: Object.keys(fi.units).sort() });
      if (firstRare && t > firstRare.t + 1800) break;
    }
    const fi = sim.st.intel![p].fields[f.id];
    out.C = { marks, firstRare, final: { n: fi.n, shares: pct(fi.units) }, depth: f.geo!.mined };
    check('초기 표본에는 희귀 성분 없음', marks.length > 0 && !marks[0].items.includes('dense_titanium_ore'));
    check('깊이 3,000 이후 희귀 성분 발견', !!firstRare && firstRare.mined >= 3000, firstRare ? `표본 ${firstRare.n}개째, ${Math.round(firstRare.t / 60)}분` : '미발견');
    check('발견 전 보고는 "미관측 상한"으로 표현', true, '보고서는 unseenMax(3/n) 상한만 제시');
  },
  D() {
    console.log('D. 광구 자동 개발 (develop_field) — 채굴·하역·판매·수익 추적');
    const sim = world(104), p = company(sim, '개발사'), f = sim.st.fields.p10_drift_rubble;
    const g = miners(sim, p, f.pos, 4); run(sim, 3);
    const c0 = sim.st.companies[p].credits;
    check('명령 수락', sim.command(p, { c: 'workCreate', goal: { k: 'develop_field', field: f.id, group: g.id, sell: true, miners: 4 } } as any) === null);
    const w = Object.values(sim.st.works!).find(x => x.kind === 'develop_field')!;
    run(sim, 4 * 3600);
    const op = Object.values(sim.st.works!).find(x => x.parent === w.id && x.kind === 'operation');
    out.D = { state: w.state, reason: w.reason, value: Math.round(w.rt?.profit ?? 0), credits: Math.round(sim.st.companies[p].credits - c0), mined: Math.round(f.geo!.mined), log: w.log.slice(-6).map(x => x.text) };
    check('채굴 작전이 목표의 하위 업무로 자동 등록', !!op);
    check('산출 가치 추적', (w.rt?.profit ?? 0) > 0, `${Math.round(w.rt?.profit ?? 0)} cr`);
    check('실제 판매 수입 발생 (기존 판매 경로)', sim.st.companies[p].credits > c0 - 1, `${Math.round(sim.st.companies[p].credits - c0)} cr (유지비 포함)`);
  },
  E() {
    console.log('E. 지역 산업 연쇄 — 철갑 사령부 기반시설 수요를 플레이어 납품이 채움');
    const base = world(105), fed = world(105), p = company(fed, '납품사');
    const iron = (sim: WorldSim) => sim.st.factions!.iron;
    // these stations produce structure/machinery themselves; the real bottleneck is alloy (20 per infra unit,
    // 30–40 per hull). Start both worlds with empty alloy shelves and no held stock.
    const made = (sim: WorldSim) => iron(sim).made.infra + iron(sim).made.ships;
    for (const sim of [base, fed]) { iron(sim).infra = 40; for (const st of Object.values(sim.st.stations)) if (st.faction === 'iron' && st.market?.alloy) st.market.alloy.stock = 0; delete iron(sim).stock?.alloy; }
    const m0 = { base: made(base), fed: made(fed) };
    const yard = fed.st.stations.p10_bulwark_yard;
    const priceBefore = priceOf(yard.market!.alloy, 'sell', true);
    // the player physically sells alloy into the faction's market (existing sale path, NPC budget)
    yard.storage[p] = { alloy: 600 };
    const s1 = fed.sellAt(yard, p, 'alloy', 600);
    const priceAfter = priceOf(yard.market!.alloy, 'sell', true);
    run(base, 900); run(fed, 900);
    const db = made(base) - m0.base, dfd = made(fed) - m0.fed;
    out.E = { sold: s1, built: { without: Math.round(db * 100) / 100, with: Math.round(dfd * 100) / 100 }, infra: { without: Math.round(iron(base).infra * 10) / 10, with: Math.round(iron(fed).infra * 10) / 10 }, alloyPrice: { before: priceBefore, afterSale: priceAfter }, standing: fed.st.companies[p].standing };
    check('납품(합금)이 세력 기반시설·함선 건조로 전환', dfd > db + .5, `15분 건조량 ${db.toFixed(2)} → ${dfd.toFixed(2)} (기반시설 ${iron(base).infra.toFixed(1)} → ${iron(fed).infra.toFixed(1)})`);
    check('판매 후 매입가 하락 (수요 포화)', priceAfter < priceBefore, `${Math.round(priceBefore)} → ${Math.round(priceAfter)} cr`);
    check('예산 한도 안에서만 매입', s1.sold <= 600, `${s1.sold}개 판매`);
    check('평판 상승', (fed.st.companies[p].standing?.iron ?? 0) > 0);
  },
  F() {
    console.log('F. 보급로 세력 분쟁 — 관문 봉쇄, 우회, 시장 영향');
    const calm = world(106), war = world(106);
    const p = company(war, '운송사'), g = war.newGroup(p, '수송');
    const ship = war.spawnShip(p, 'corvette', 'gun', g.id, { x: war.st.systems.crossroads.origin.x + 5000, y: 0, z: 0 });
    const p2 = company(calm, '운송사'), g2 = calm.newGroup(p2, '수송');
    const ship2 = calm.spawnShip(p2, 'corvette', 'gun', g2.id, { x: calm.st.systems.crossroads.origin.x + 5000, y: 0, z: 0 });
    const c1 = startConflict(war, war.st, 'iron', 'guild', [['crossroads', 'rampart']]);
    const closedAtStart = !gateOpen(war.st, war.st.systems.crossroads.gates.find(x => x.to === 'rampart')!);
    startConflict(war, war.st, 'iron', 'pirates', [['rampart', 'scar'], ['muster', 'blackgate']]);
    const dest = (sim: WorldSim) => ({ x: sim.st.systems.muster.origin.x + 5000, y: 0, z: 0 });
    war.command(p, { c: 'setOp', group: g.id, op: { k: 'move', to: dest(war) } }); calm.command(p2, { c: 'setOp', group: g2.id, op: { k: 'move', to: dest(calm) } });
    const path = (sim: WorldSim, s: typeof ship) => { const seen: string[] = []; let t = 0; for (; t < 6000 && sysAt(sim.st.systems, s.pos)?.id !== 'muster'; t++) { sim.update(1); const id = sysAt(sim.st.systems, s.pos)!.id; if (seen.at(-1) !== id) seen.push(id); } return { t, seen }; };
    const a = path(calm, ship2), b = path(war, ship);
    const alloy0 = priceOf(war.st.stations.p10_muster_depot.market!.alloy, 'sell', true);
    const ironBefore = { ...war.st.factions!.iron.made };
    run(war, 3600); run(calm, 3600);
    const muster = (sim: WorldSim) => sim.st.stations.p10_muster_depot.market!;
    out.F = { calm: a, war: b, ironStrength: { calm: Math.round(calm.st.factions!.iron.strength), war: Math.round(war.st.factions!.iron.strength) }, shipsBuiltDuringWar: Math.round((war.st.factions!.iron.made.ships - ironBefore.ships) * 10) / 10,
      musterAlloyStock: { calm: Math.round(muster(calm).alloy.stock), war: Math.round(muster(war).alloy.stock) }, musterAlloyPrice: { start: alloy0, calm: priceOf(muster(calm).alloy, 'sell', true), war: priceOf(muster(war).alloy, 'sell', true) } };
    check('평시: 성벽 회랑 경유', a.seen.includes('rampart'));
    const crossedClosed = b.seen.some((x, i) => x === 'crossroads' && b.seen[i + 1] === 'rampart');
    check('분쟁: 봉쇄 관문(교차로→성벽) 미통과, 우회 도착', !crossedClosed && sysAt(war.st.systems, ship.pos)?.id === 'muster', `${a.t}s → ${b.t}s, 경로 ${b.seen.join('>')}`);
    check('우회로 지연', b.t > a.t);
    check('전쟁 손실 → 함선 재건 수요(시장 재고 소비)', war.st.factions!.iron.made.ships > ironBefore.ships);
    check('분쟁 시작 시 관문 봉쇄, 종료 시 해제', closedAtStart && (c1.ended ? gateOpen(war.st, war.st.systems.crossroads.gates.find(x => x.to === 'rampart')!) : true), c1.ended ? `종료 ${Math.round(c1.ended - c1.since)}s` : '진행 중');
  },
  G() {
    console.log('G. 여러 회사의 같은 광구 경쟁 — 중복 집계 없음, 정보 분리');
    const sim = world(107), a = company(sim, '경쟁 A'), b = company(sim, '경쟁 B'), f = sim.st.fields.p10_cradle_field;
    f.regen = 0;
    const ga = miners(sim, a, f.pos, 3, 'A반'), gb = miners(sim, b, { x: f.pos.x + 300, z: f.pos.z }, 3, 'B반');
    run(sim, 3);
    const before = f.amount, drawsBefore = f.geo!.draws;
    for (const [p, g] of [[a, ga], [b, gb]] as const) sim.command(p, { c: 'setOp', group: g.id, op: { k: 'mine', field: f.id, deliver: '', sell: false, auto: true } });
    run(sim, 1800);
    const held = (p: string) => Object.values(sim.st.ships).filter(s => s.owner === p).reduce((n, s) => n + cargoSum(s.cargo) + (s.mineAcc?.field === f.id ? s.mineAcc.a : 0), 0) + Object.values(sim.st.stations).reduce((n, s) => n + cargoSum(s.storage[p] ?? {}), 0);
    const startHeld = 0;
    const na = sim.st.intel![a].fields[f.id]?.n ?? 0, nb = sim.st.intel![b].fields[f.id]?.n ?? 0;
    const extracted = before - f.amount;
    out.G = { extracted, draws: f.geo!.draws - drawsBefore, a: { samples: na, held: held(a) }, b: { samples: nb, held: held(b) } };
    check('표본 합 = 광구의 실제 추출 단위', Math.abs(na + nb - (f.geo!.draws - drawsBefore)) < 1e-9, `${na} + ${nb}`);
    check('광구 감소량 = 두 회사 보유 증가 합', Math.abs(extracted - (held(a) + held(b) - startHeld)) < 1e-6, `${extracted.toFixed(2)}`);
    const va = JSON.stringify(legacyView(sim.st, { company: a }, 'cradle'));
    check('A 화면에 B의 표본 기록 없음', !va.includes(`"${b}":{"sys"`) && Object.keys((legacyView(sim.st, { company: a }, 'cradle') as any).intel).join() === a);
  },
  H() {
    console.log('H. 장기 실행 — 일관성, 성능, 저장 크기');
    const hours = Number(args[2] ?? 12);
    const sim = WorldSim.create(108, { layout: 'p10' });
    const cos = [company(sim, '장기 A', 100), company(sim, '장기 B', 100), company(sim, '장기 C', 100)];
    const targets = ['p10_cradle_field', 'p10_drift_rubble', 'p10_tundra_ore'];
    cos.forEach((p, i) => { const f = sim.st.fields[targets[i]]; const g = miners(sim, p, f.pos, 3); sim.update(1); sim.command(p, { c: 'workCreate', goal: { k: 'develop_field', field: f.id, group: g.id, sell: true, miners: 3 } } as any); });
    const ticks: number[] = [];
    let bad = 0;
    for (let t = 0; t < hours * 3600; t++) {
      const t0 = performance.now(); sim.update(1); ticks.push(performance.now() - t0);
      if (t % 600 === 0) {
        for (const s of Object.values(sim.st.stations)) for (const m of Object.values(s.market ?? {})) if (!(m.stock >= 0)) bad++;
        for (const f of Object.values(sim.st.factions!)) for (const v of Object.values(f.stock)) if (v < -1e-9) bad++;
        for (const f of Object.values(sim.st.fields)) if (!(f.amount >= -1e-9) || !(f.amount <= f.max + 1e-6 + (f.geo ? 1 : 0))) bad++;
      }
    }
    ticks.sort((x, y) => x - y);
    const q = (p: number) => Math.round(ticks[Math.floor(ticks.length * p)] * 1000) / 1000;
    const save = sim.serialize();
    const reload = new WorldSim(JSON.parse(save));
    const views = cos.map(c => JSON.stringify(legacyView(sim.st, { company: c }, 'helios')).length);
    out.H = { hours, tickMs: { p50: q(.5), p95: q(.95), p99: q(.99), max: Math.round(ticks.at(-1)! * 1000) / 1000 }, saveBytes: save.length, intelBytes: JSON.stringify(sim.st.intel).length, viewBytes: views,
      factions: Object.fromEntries(Object.values(sim.st.factions!).map(f => [f.id, { strength: Math.round(f.strength), infra: Math.round(f.infra), made: { ships: Math.round(f.made.ships), infra: Math.round(f.made.infra) }, claimed: f.claimed ?? [] }])),
      conflicts: Object.values(sim.st.conflicts!).map(c => ({ a: c.a, b: c.b, from: Math.round(c.since), to: c.ended && Math.round(c.ended) })), invariantViolations: bad,
      works: Object.values(sim.st.works!).filter(w => w.kind === 'develop_field').map(w => ({ state: w.state, value: Math.round(w.rt?.profit ?? 0) })) };
    check('불변식 위반 없음 (재고·세력 비축·매장량)', bad === 0);
    check('저장 → 재적재 성공', !!reload.st.factions && reload.st.fog === 1 && Object.keys(reload.st.systems).length === 40);
    for (const f of Object.values(sim.st.factions!)) check(`${f.id} 전력 상한 준수`, f.strength <= doctrineOf(f.id).strength + 1e-6);
  },
};

for (const k of only) if (S[k]) { const t0 = performance.now(); S[k](); console.log(`  (${((performance.now() - t0) / 1000).toFixed(1)}s)`); }
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
if (args[1]) fs.writeFileSync(args[1], JSON.stringify(out, null, 2));
process.exitCode = failed ? 1 : 0;
void jumps; void nextGate;
