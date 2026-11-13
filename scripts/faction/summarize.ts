// Summarize the faction-economy v2 verification batch (scripts/faction/batch.sh) into markdown.
//   npx vite-node scripts/faction/summarize.ts -- [runs dir=docs/econ-results/faction/runs] [out=docs/econ-results/faction/summary.md]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter(a => a !== '--');
const dir = args[0] ?? 'docs/econ-results/faction/runs', outFile = args[1] ?? 'docs/econ-results/faction/summary.md';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const J = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const n = (x: number | null | undefined) => x == null || Number.isNaN(x) ? '—' : Math.round(x).toLocaleString('en-US');
const k = (x: number) => x == null ? '—' : `${Math.round(x / 1000).toLocaleString('en-US')}k`;
const FIDS = ['union', 'guild', 'ceres', 'miners', 'iron', 'pirates'];
const lines: string[] = ['# 세력 경제 v2 검증 결과', '', `원본: \`${dir}\` (${files.length}건). 재현: \`bash scripts/faction/batch.sh\` → \`npx vite-node scripts/faction/summarize.ts\`.`, '',
  '금액은 참조 가격(ITEMS.price) 기준 cr/h. `자급`은 소비 가치 중 구매가 아닌 몫. 부족 = 목표 대비 충족 못 한 수요의 가치.', ''];

// ── faction-only scenarios
const avg = (hs: any[], id: string, key: string, from = 0) => { const xs = hs.slice(from).map(h => h.factions[id]?.perH?.[key]).filter((x: any) => x != null); return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : NaN; };
const fe = files.filter(f => f.startsWith('fe.'));
lines.push('## 1. 세력 단독 시나리오', '', '| 실행 | 시간 | 위반 | 저장 동일 | ms/틱 | 최악 틱 | 저장 KB | 분쟁 |', '|---|---:|---:|---|---:|---:|---:|---|');
const feData: Record<string, any> = {};
for (const f of fe) {
  const d = J(f); feData[f] = d;
  lines.push(`| ${f.replace('.json', '')} | ${d.hours} | ${d.violationCount} | ${d.twinEqual === undefined ? '—' : d.twinEqual ? '예' : '**아니오**'} | ${d.msPerTick} | ${d.worstTickMs} | ${Math.round(d.saveBytes / 1024)} | ${d.conflicts.map((c: any) => `${c.a}-${c.b} ${c.since}–${c.ended ?? '…'}분`).join(', ') || '없음'} |`);
}
for (const f of fe) {
  const d = feData[f], H = d.hourly, last = H.at(-1), from = Math.min(H.length - 1, 2);
  lines.push('', `### ${f.replace('.json', '')}`, '', `평균은 ${from + 1}h 이후. 마지막 시각 h${last.h}.`, '',
    '| 세력 | 전력 | 기반 | 발전 | 효율 | 준비 | 예산 | 수요 가치 | 자체 생산/h | 소비/h | 구매/h | 수입/h | 부족/h | 수출/h | 전쟁 소비/h | 재건 소비/h | 재고 가치 | 주요 부족 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const id of FIDS) {
    const x = last.factions[id]; if (!x) continue;
    lines.push(`| ${id} | ${x.strength} | ${x.infra} | ${x.dev} | ${x.eff} | ${x.rdy} | ${k(x.budget)} | ${k(x.perH.demandValue)} | ${k(avg(H, id, 'ownProduction', from))} | ${k(avg(H, id, 'consumption', from))} | ${k(avg(H, id, 'purchases', from))} | ${k(avg(H, id, 'imports', from))} | ${k(avg(H, id, 'unmet', from))} | ${k(avg(H, id, 'exports', from))} | ${k(avg(H, id, 'warUse', from))} | ${k(avg(H, id, 'rebuildUse', from))} | ${k(x.stockValue)} | ${x.topShort.join(' ')} |`);
  }
  // trajectory of the key faction for the iron scenarios, readiness for all for the others
  lines.push('', '시간별 전력 / 준비도:', '', '| h | ' + FIDS.join(' | ') + ' | 진행 중 분쟁 |', '|---:|' + FIDS.map(() => '---').join('|') + '|---|');
  const step = H.length > 24 ? 6 : 1;
  for (const h of H.filter((x: any, i: number) => (i + 1) % step === 0 || i === 0)) lines.push(`| ${h.h} | ${FIDS.map(id => h.factions[id] ? `${h.factions[id].strength} / ${h.factions[id].rdy}` : '—').join(' | ')} | ${h.wars.join(', ')} |`);
  const mk = [...H].reverse().find((h: any) => h.markets)?.markets;
  if (mk) lines.push('', '시장 (전체 공공 시장 평균 판매가 · 목표 대비 재고 · 총 재고, 마지막 기록): ' + Object.entries<any>(mk).map(([g, m]) => `${g} ${m.price}cr·${m.fill}·${n(m.stock)}`).join('; '));
  if (d.sold?.length) { const tot = d.sold.reduce((a: number, s: any) => a + s.credits, 0); lines.push('', `플레이어 납품: ${d.sold.length}회, 총 ${n(tot)} cr 수입 (${d.sold.slice(0, 2).map((s: any) => `${s.item} ${s.units}개 ${n(s.credits)}cr`).join(', ')} …)`); }
  if (d.violationCount) lines.push('', '**위반:** ' + d.violations.slice(0, 10).join('; '));
}

// ── company runs
const co = files.filter(f => f.startsWith('co.'));
lines.push('', '## 2. 회사 시뮬레이션', '', '| 실행 | 전문 | 안 | 월드 | 시간 | 시드 | 회사 | 투자 | 순이익/h | 정상상태/h | 회수 h | 주요 판매 (수량 · 평균가) | 평균 ms/틱 | 최악 틱 | 저장 KB |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|');
const coData: Record<string, any> = {};
for (const f of co) {
  const d = J(f); coData[f] = d; const cs = d.competitors?.length ?? 1;
  const sold = Object.entries<any>(d.products ?? {}).filter(([, p]) => p.sold).map(([g, p]) => `${g} ${n(p.sold)} · ${p.avgPrice}`).join('; ');
  lines.push(`| ${f.replace('.json', '')} | ${d.spec} | ${d.proposal} | ${d.origin} | ${d.hours} | ${d.seed} | ${cs} | ${n(d.invested)} | ${n(d.netPerH)} | ${n(d.steadyPerH)} | ${d.paybackH ?? '—'} | ${sold} | ${d.avgTickMs ?? '—'} | ${d.worstTickMs} | ${d.saveBytes ? Math.round(d.saveBytes / 1024) : '—'} |`);
}
for (const f of co) {
  const d = coData[f]; if (!d.competitors) continue;
  lines.push('', `### ${f.replace('.json', '')} — 회사별`, '', '| 회사 | 전문 | 투자 | 순이익 | 순이익/h | 판매 (수량 · 금액) |', '|---|---|---:|---:|---:|---|');
  for (const c of d.competitors) lines.push(`| ${c.company} | ${c.spec ?? d.spec} | ${n(c.invested)} | ${n(c.net)} | ${n(c.netPerH)} | ${Object.entries<any>(c.sold).map(([g, s]) => `${g} ${n(s.units)} · ${n(s.value)}`).join('; ')} |`);
}
// faction state with companies present (last hour of each p10fe run)
lines.push('', '### 회사가 있는 월드의 세력 상태 (마지막 시각)', '', '| 실행 | ' + FIDS.join(' | ') + ' |', '|---|' + FIDS.map(() => '---').join('|') + '|');
for (const f of co) {
  const d = coData[f]; const fh = d.factionHourly?.at(-1); if (!fh) continue;
  lines.push(`| ${f.replace('.json', '')} | ${FIDS.map(id => { const x = fh.factions[id]; return x ? `s${x.strength} e${x.eff} r${x.rdy} 부족${k(x.perH.unmet)}` : '—'; }).join(' | ')} |`);
}
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`wrote ${outFile} (${fe.length} faction runs, ${co.length} company runs)`);
