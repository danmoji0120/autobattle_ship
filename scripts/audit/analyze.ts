// Summaries of the audit runs as Markdown tables (pasted into docs/P1_WORLD_SIMULATION_AUDIT.md).
//   npx vite-node scripts/audit/analyze.ts autonomy <a.json> [b.json ...]
//   npx vite-node scripts/audit/analyze.ts experiments <exp.json>
import fs from 'node:fs';
import type { Sample, BattleRec, EventRec } from './lib';
import { mean, sd, r1, r3 } from './lib';

type Run = { seed: number; hours: number; samples: Sample[]; battles: BattleRec[]; events: EventRec[]; final?: any };
const mode = process.argv[2];
const files = process.argv.slice(3);
const at = (S: Sample[], h: number) => S.reduce((b, s) => Math.abs(s.t - h * 3600) < Math.abs(b.t - h * 3600) ? s : b, S[0]);
const out: string[] = [];
const p = (s = '') => out.push(s);
const table = (head: string[], rows: (string | number)[][]) => { p(`| ${head.join(' | ')} |`); p(`|${head.map(() => '---').join('|')}|`); for (const r of rows) p(`| ${r.join(' | ')} |`); p(); };

const EVENT_PATTERNS: [string, RegExp][] = [
  ['해적 무리 출격', /해적 무리가 출격/], ['떠돌이 해적 출몰', /떠돌이 해적 .*출몰/], ['떠돌이 해적 이탈', /떠돌이 해적 .*떠났다/],
  ['연합 재편성', /재편성 완료/], ['연합 패퇴', /연합군이 해적에게 밀려났다/], ['연합 대승(3척+)', /연합군이 해적 \d+척을 격침/],
  ['길드 상선 약탈', /길드 상선이 해적에게 약탈/], ['소굴 파괴', /파괴되었다!/], ['소굴 재건', /재건되었다/], ['해방 후 재건', /해방 후 재건/],
];
function events(ev: EventRec[]) { const c: Record<string, number> = {}; for (const e of ev) for (const [k, re] of EVENT_PATTERNS) if (re.test(e.text)) c[k] = (c[k] ?? 0) + 1; return c; }

function marketClass(S: Sample[], from = 0.5) {
  const late = S.slice(Math.floor(S.length * from));
  let n = 0, frozen = 0, atTarget = 0, short = 0, glut = 0, moving = 0;
  const shortList: string[] = [], movingList: string[] = [];
  for (const [stId, m] of Object.entries(late.at(-1)!.mkt)) for (const g of Object.keys(m.g)) {
    const xs = late.map(s => s.mkt[stId]?.g[g]?.[0]).filter((x): x is number => x !== undefined);
    if (!xs.length) continue;
    n++;
    const mu = mean(xs), dev = sd(xs);
    if (dev < 0.01) frozen++;
    if (dev >= 0.05) { moving++; movingList.push(`${stId}:${g}`); }
    if (Math.abs(mu - 1) < 0.05) atTarget++;
    else if (mu < 0.6) { short++; shortList.push(`${stId}:${g}(${r1(mu * 100)}%)`); }
    else if (mu > 1.3) glut++;
  }
  return { n, frozen, atTarget, short, glut, moving, shortList, movingList };
}

if (mode === 'autonomy') {
  const runs: Run[] = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  p('### A1. 함선 수(소유자별)와 활동량');
  const hs = [0, 1, 2, 6, 12, 18, 24];
  for (const r of runs) {
    p(`**시드 ${r.seed}** (${r.hours}h, 플레이어 없음)`); p();
    table(['게임 시각', ...hs.map(h => `${h}h`)], ['union', 'pirates', 'guild'].map(o => [o, ...hs.map(h => at(r.samples, h).ships[o] ?? 0)]).concat([['살아 있는 소굴', ...hs.map(h => at(r.samples, h).lairs)], ['전투 잔해 필드', ...hs.map(h => at(r.samples, h).wrecks)], ['광상 잔량 비율', ...hs.map(h => at(r.samples, h).fieldFill)]]));
    const perH = (a: number, b: number) => r.battles.filter(x => x.t1 >= a * 3600 && x.t1 < b * 3600).length / (b - a);
    p(`전투 수: 총 ${r.battles.length}회 · 시간당 0–6h ${r1(perH(0, 6))} / 6–12h ${r1(perH(6, 12))} / 12–18h ${r1(perH(12, 18))} / 18–24h ${r1(perH(18, 24))}`); p();
  }
  p('### A2. 성계별 전투·치안·세력 영향력 (시드별 24h 종료 시점)');
  for (const r of runs) {
    const bySys: Record<string, { n: number; uw: number; ul: number; guild: number; lair: number }> = {};
    for (const b of r.battles) { const x = (bySys[b.sys ?? '?'] ??= { n: 0, uw: 0, ul: 0, guild: 0, lair: 0 }); x.n++; if (b.sides[0].includes('union')) { if (b.winner === 0) x.uw++; else x.ul++; } if (b.sides[0].includes('guild')) x.guild++; if (b.lair) x.lair++; }
    const S = r.samples, end = S.at(-1)!, h1 = at(S, 1);
    const rows = Object.entries(end.sys).map(([id, s]) => {
      const heats = S.map(x => x.sys[id].heat), effs = S.map(x => x.sys[id].eff);
      const um = mean(S.map(x => x.sys[id].union));
      const b = bySys[id] ?? { n: 0, uw: 0, ul: 0, guild: 0, lair: 0 };
      return [id, b.n, `${b.uw}/${b.ul}`, b.guild, r1(um), `${r1(Math.min(...effs))}–${r1(Math.max(...effs))}`, `${r1(Math.min(...heats))}–${r1(Math.max(...heats))}`, `${h1.sys[id].inf.map(r1).join('/')} → ${s.inf.map(r1).join('/')}`];
    }).sort((a, b) => (b[1] as number) - (a[1] as number));
    p(`**시드 ${r.seed}**`); p();
    table(['성계', '전투', '연합 승/패', '길드 피습', '연합 함선 평균', '실효 치안 범위', '해적 열기 범위', '영향력 연합/해적/길드 1h → 24h'], rows);
  }
  p('### A3. 시장 상태 (후반 12시간, 재고/목표 비율 기준)');
  const mrows = runs.map(r => { const c = marketClass(r.samples); return [r.seed, c.n, c.frozen, c.atTarget, c.short, c.glut, c.moving, c.shortList.slice(0, 8).join(', ') || '-']; });
  table(['시드', '품목 수', '변동 거의 없음(sd<1%)', '목표 ±5% 고정', '부족(<60%)', '과잉(>130%)', '움직임(sd≥5%)', '지속 부족 품목'], mrows);
  for (const r of runs) { const c = marketClass(r.samples); p(`시드 ${r.seed} 움직이는 품목: ${c.movingList.join(', ') || '없음'}`); }
  p();
  p('NPC 구매 예산(공영 정거장 평균 funds/fundsMax): ' + runs.map(r => `시드 ${r.seed} ${hs.map(h => r3(mean(Object.values(at(r.samples, h).mkt).map(m => m.funds)))).join(' → ')}`).join(' · '));
  p();
  p('### A4. 세계 사건 (24h 누계)');
  const evs = runs.map(r => events(r.events));
  const keys = EVENT_PATTERNS.map(e => e[0]);
  table(['사건', ...runs.map(r => `시드 ${r.seed}`)], keys.map(k => [k, ...evs.map(e => e[k] ?? 0)]));
  p('### A5. 소굴 최종 상태');
  for (const r of runs) p(`- 시드 ${r.seed}: ${r.final.lairs.map((l: any) => `${l.id}(${l.sys}) ${l.alive ? '생존' : '파괴'}`).join(', ')}`);
  p();
  p('NPC 회사 자금(24h 후): ' + runs.map(r => `시드 ${r.seed} ` + r.final.companies.map((c: any) => `${c.id} ${c.credits}`).join(' / ')).join(' · '));
} else if (mode === 'experiments') {
  const j = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  const R = j.results as Record<string, Run & { why: string; note: any; hash: string; final: any }>;
  const C = R.control;
  p(`### 결정론 검사: control ${C.hash} / control2 ${R.control2?.hash} → ${C.hash === R.control2?.hash ? '동일' : '불일치'}`); p();
  const series = (r: Run, f: (s: Sample) => number, hs: number[]) => hs.map(h => r1(f(at(r.samples, j.warmH + h))));
  const hs = [0, 0.5, 1, 2, 3, 4, 6].filter(h => h <= j.armH);
  const cmp = (title: string, f: (s: Sample) => number, arms: string[]) => { p(`**${title}**`); p(); table(['조건', ...hs.map(h => `+${h}h`)], arms.filter(a => R[a]).map(a => [a, ...series(R[a], f, hs)])); };
  const good = (st: string, g: string, k = 0) => (s: Sample) => (s.mkt[st]?.g[g]?.[k] ?? NaN) * (k === 0 ? 100 : 1);
  const bat = (r: Run, sys: string) => r.battles.filter(b => b.sys === sys);
  // war
  if (R.war_astra) {
    p('#### B1. 전쟁: 아스트라 침공'); p(R.war_astra.why); p();
    for (const a of ['control', 'war_astra']) { const b = bat(R[a], 'astra'); p(`- ${a}: 아스트라 전투 ${b.length}회 (연합 승 ${b.filter(x => x.sides[0].includes('union') && x.winner === 0).length} / 패 ${b.filter(x => x.sides[0].includes('union') && x.winner !== 0).length}), 길드 피습 ${b.filter(x => x.sides[0].includes('guild')).length}`); }
    p();
    cmp('아스트라 연합 함선 수', s => s.sys.astra.union, ['control', 'war_astra']);
    cmp('아스트라 해적 함선 수', s => s.sys.astra.pirates, ['control', 'war_astra']);
    cmp('아스트라 해적 열기', s => s.sys.astra.heat, ['control', 'war_astra']);
    cmp('아스트라 실효 치안', s => s.sys.astra.eff, ['control', 'war_astra']);
    cmp('아스트라 연합 손실 누계(stats)', s => s.sys.astra.stats[1], ['control', 'war_astra']);
    cmp('아스트라 민간 손실 누계(stats)', s => s.sys.astra.stats[2], ['control', 'war_astra']);
    for (const [st, g] of [['bastion', 'weapon_parts'], ['bastion', 'armor_plate'], ['bastion', 'eq_autocannon'], ['astra', 'ore'], ['astra', 'machinery'], ['nova', 'metal'], ['helios', 'alloy']] as const)
      cmp(`${st} ${g} 재고/목표 %`, good(st, g), ['control', 'war_astra']);
    cmp('bastion weapon_parts 판매가', good('bastion', 'weapon_parts', 1), ['control', 'war_astra']);
    p('계약(종료 시점 미완료): ' + ['control', 'war_astra'].map(a => `${a} ` + JSON.stringify(R[a].final.contracts.reduce((m: any, k: any) => (m[k.kind] = (m[k.kind] ?? 0) + 1, m), {}))).join(' · ')); p();
  }
  if (R.blockade_ember) {
    p('#### B2. 항로 봉쇄: 엠버 해적 열기 100 유지'); p(R.blockade_ember.why); p();
    const goods = Object.keys(C.samples.at(-1)!.mkt.cinderco.g);
    p('**신더(cinderco) 품목별 재고/목표 % (+6h)**'); p();
    table(['품목', 'control', 'blockade'], goods.map(g => [g, r1(at(C.samples, j.warmH + j.armH).mkt.cinderco.g[g][0] * 100), r1(at(R.blockade_ember.samples, j.warmH + j.armH).mkt.cinderco.g[g][0] * 100)]));
    for (const st of ['astra', 'drakeout', 'rustport']) {
      const d = Object.keys(C.samples.at(-1)!.mkt[st].g).map(g => Math.abs(at(C.samples, j.warmH + j.armH).mkt[st].g[g][0] - at(R.blockade_ember.samples, j.warmH + j.armH).mkt[st].g[g][0]));
      p(`- 이웃 시장 ${st}: 품목별 |차이| 평균 ${r3(mean(d) * 100)}%p, 최대 ${r3(Math.max(...d) * 100)}%p`);
    }
    p();
    cmp('엠버 길드 영향력', s => s.sys.ember.inf[2], ['control', 'blockade_ember']);
    cmp('엠버 실효 치안', s => s.sys.ember.eff, ['control', 'blockade_ember']);
    cmp('신더 gas 재고/목표 %', good('cinderco', 'gas'), ['control', 'blockade_ember']);
    cmp('신더 machinery 재고/목표 %', good('cinderco', 'machinery'), ['control', 'blockade_ember']);
    cmp('신더 machinery 판매가', good('cinderco', 'machinery', 1), ['control', 'blockade_ember']);
  }
  if (R.union_wiped_astra) {
    p('#### B3. 함대 손실과 회복: 아스트라 연합 전멸'); p(R.union_wiped_astra.why + ` (제거 ${R.union_wiped_astra.note.removed}척)`); p();
    const hs2 = [0, 0.05, 0.1, 0.25, 0.5, 1, 2];
    p('**아스트라 연합 함선 수**'); p();
    table(['조건', ...hs2.map(h => `+${h}h`)], ['control', 'union_wiped_astra'].map(a => [a, ...hs2.map(h => at(R[a].samples, j.warmH + h).sys.astra.union)]));
    p('표본 간격은 10분이라 +0.05h·+0.1h는 가장 가까운 표본으로 대체된다. 아래 사건 기록에서 정확한 재편성 시각을 확인한다.'); p();
    const re = R.union_wiped_astra.events.filter(e => /재편성 완료/.test(e.text) && e.t <= (j.warmH + 1) * 3600).map(e => `${Math.round(e.t - j.warmH * 3600)}s ${e.text}`);
    p('재편성 사건(+1h 이내): ' + (re.join(' / ') || '없음')); p();
    for (const a of ['control', 'union_wiped_astra']) { const b = bat(R[a], 'astra'); p(`- ${a}: 아스트라 전투 ${b.length}회, 길드 피습 ${b.filter(x => x.sides[0].includes('guild')).length}, 해적 열기 최대 ${Math.max(...R[a].samples.map(s => s.sys.astra.heat))}`); }
    const d = Object.entries(C.samples.at(-1)!.mkt).flatMap(([st, m]) => Object.keys(m.g).map(g => Math.abs(m.g[g][0] - (R.union_wiped_astra.samples.at(-1)!.mkt[st]?.g[g]?.[0] ?? m.g[g][0]))));
    p(`- 전 시장 재고 비율 |차이| 평균 ${r3(mean(d) * 100)}%p, 최대 ${r3(Math.max(...d) * 100)}%p (연합 재건이 시장 자원을 쓰지 않음을 확인)`); p();
  }
  if (R.player_dump_alloy) {
    p('#### B4. 플레이어 시장 개입: 헬리오스 합금 3,000 투매'); p(R.player_dump_alloy.why); p();
    const n = R.player_dump_alloy.note; p(`판매 직후: 재고 ${Math.round(n.before.stock)} → ${Math.round(n.after.stock)}, 판매가 ${n.before.price} → ${n.after.price}, 정거장 예산 ${Math.round(n.before.funds)} → ${Math.round(n.after.funds)}, 플레이어 수입 ${Math.round(n.after.credits - n.before.credits)} cr`); p();
    const hs3 = [0, 0.25, 0.5, 1, 2, 3, 4, 6].filter(h => h <= j.armH);
    table(['조건', ...hs3.map(h => `+${h}h`)], ['control', 'player_dump_alloy'].flatMap(a => [[`${a} 재고/목표 %`, ...hs3.map(h => r1(at(R[a].samples, j.warmH + h).mkt.helios.g.alloy[0] * 100))], [`${a} 판매가`, ...hs3.map(h => at(R[a].samples, j.warmH + h).mkt.helios.g.alloy[1])], [`${a} 헬리오스 예산 %`, ...hs3.map(h => r1(at(R[a].samples, j.warmH + h).mkt.helios.funds * 100))]]));
    const d = ['exchange', 'astra', 'bastion', 'p9_lyra_port'].map(st => `${st} ${r3(Math.abs((at(C.samples, j.warmH + 1).mkt[st]?.g.alloy?.[0] ?? 0) - (at(R.player_dump_alloy.samples, j.warmH + 1).mkt[st]?.g.alloy?.[0] ?? 0)) * 100)}%p`);
    p('+1h 다른 시장 합금 재고 비율 차이: ' + d.join(', ')); p();
  }
  if (R.cap_released) {
    p('#### B6. 정체 원인 검증: 검은 송곳니 주둔 해적 제거'); p(R.cap_released.why + ` (제거 ${R.cap_released.note.removed}척)`); p();
    for (const a of ['control', 'cap_released']) {
      const r = R[a]; const spawns = r.events.filter(e => /해적 무리가 출격/.test(e.text));
      const bys: Record<string, number> = {}; for (const b of r.battles) bys[b.sys ?? '?'] = (bys[b.sys ?? '?'] ?? 0) + 1;
      p(`- ${a}: 해적 무리 출격 ${spawns.length}회 (${spawns.map(e => e.text.split(':')[0]).join(', ') || '-'}), 전투 ${r.battles.length}회 ${JSON.stringify(bys)}`);
    }
    p();
    cmp('전체 해적 함선 수', s => s.ships.pirates ?? 0, ['control', 'cap_released']);
    cmp('드레이크 해적 열기', s => s.sys.drake.heat, ['control', 'cap_released']);
  }
  if (R.player_miner) {
    p('#### B7. 일반 플레이어 활동(채굴·판매)이 세계에 남기는 흔적'); p(R.player_miner.why); p();
    for (const a of ['player_passive', 'player_miner']) { const r = R[a]; p(`- ${a}: 전투 ${r.battles.length}회(플레이어 참여 ${r.battles.filter(b => b.live).length}), 플레이어 ${JSON.stringify(r.final.player)}`); }
    p();
    cmp('플레이어 자금', s => s.playerCredits ?? NaN, ['player_passive', 'player_miner']);
    cmp('astra ore 재고/목표 %', good('astra', 'ore'), ['player_passive', 'player_miner']);
    cmp('astra ore 판매가', good('astra', 'ore', 1), ['player_passive', 'player_miner']);
    cmp('astra silicate 재고/목표 %', good('astra', 'silicate'), ['player_passive', 'player_miner']);
    cmp('광상 잔량 비율', s => s.fieldFill * 100, ['player_passive', 'player_miner']);
    cmp('아스트라 예산 %', s => s.mkt.astra.funds * 100, ['player_passive', 'player_miner']);
    cmp('아스트라 해적 열기', s => s.sys.astra.heat, ['player_passive', 'player_miner']);
  }
  if (R.no_guild) {
    p('#### B8. 길드 상선 제거'); p(R.no_guild.why); p();
    const d = Object.entries(C.samples.at(-1)!.mkt).flatMap(([st, m]) => Object.keys(m.g).map(g => [`${st}:${g}`, Math.abs(m.g[g][0] - (R.no_guild.samples.at(-1)!.mkt[st]?.g[g]?.[0] ?? m.g[g][0]))] as [string, number]));
    d.sort((a, b) => b[1] - a[1]);
    p(`+${j.armH}h 전 시장 재고 비율 |차이| 평균 ${r3(mean(d.map(x => x[1])) * 100)}%p · 상위: ${d.slice(0, 6).map(([k, v]) => `${k} ${r1(v * 100)}%p`).join(', ')}`); p();
    for (const a of ['control', 'no_guild']) p(`- ${a}: 전투 ${R[a].battles.length}회, 길드 피습 ${R[a].battles.filter(b => b.sides[0].includes('guild')).length}`);
    p();
  }
  if (R.player_assault_lair) {
    p('#### B5. 플레이어 군사 개입: 엠버 소굴 공격'); p(R.player_assault_lair.why); p();
    for (const a of ['player_fleet_idle', 'player_assault_lair']) {
      const r = R[a]; const b = bat(r, 'ember');
      p(`- ${a}: 엠버 전투 ${b.length}회(플레이어 참여 ${b.filter(x => x.live).length}), redclaw ${r.final.lairs.find((l: any) => l.id === 'redclaw').alive ? '생존' : '파괴'}, 재건 기한 ${r.final.recover.ember ? Math.round((r.final.recover.ember - j.warmH * 3600) / 60) + '분' : '-'}, 플레이어 ${JSON.stringify(r.final.player)}`);
      const destroyed = r.events.filter(e => /파괴되었다!|재건되었다|해방 후 재건/.test(e.text)).map(e => `${Math.round((e.t - j.warmH * 3600) / 60)}분 ${e.text}`);
      p(`  - 사건: ${destroyed.join(' / ') || '없음'}`);
    }
    p();
    cmp('엠버 영향력: 해적', s => s.sys.ember.inf[1], ['player_fleet_idle', 'player_assault_lair']);
    cmp('엠버 영향력: 길드', s => s.sys.ember.inf[2], ['player_fleet_idle', 'player_assault_lair']);
    cmp('엠버 실효 치안', s => s.sys.ember.eff, ['player_fleet_idle', 'player_assault_lair']);
    cmp('엠버 해적 열기', s => s.sys.ember.heat, ['player_fleet_idle', 'player_assault_lair']);
    cmp('엠버 해적 함선 수', s => s.sys.ember.pirates, ['player_fleet_idle', 'player_assault_lair']);
    cmp('신더 machinery 재고/목표 %', good('cinderco', 'machinery'), ['player_fleet_idle', 'player_assault_lair']);
    cmp('신더 gas 재고/목표 %', good('cinderco', 'gas'), ['player_fleet_idle', 'player_assault_lair']);
    cmp('플레이어 자금', s => s.playerCredits ?? NaN, ['player_fleet_idle', 'player_assault_lair']);
    const ck = (a: string) => R[a].final.contracts.filter((k: any) => k.station === 'cinderco').map((k: any) => `${k.kind}:${k.title}(${k.reward})`).join(', ');
    p(`신더 미완료 계약: idle [${ck('player_fleet_idle')}] / assault [${ck('player_assault_lair')}]`); p();
  }
}
console.log(out.join('\n'));
