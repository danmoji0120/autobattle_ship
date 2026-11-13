// Summarise company simulation runs (scripts/econ/companies.ts JSON) into a markdown table.
//   node scripts/econ/summarize-b.mjs docs/econ-results/b/runs > docs/econ-results/b/summary.md
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] ?? 'docs/econ-results/b/runs';
const runs = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
const n = x => x === null || x === undefined || Number.isNaN(x) ? '—' : Math.round(x).toLocaleString('en-US');
const order = ['mine', 'refine', 'inter', 'parts', 'vertical', 'direct', 'equip'];
runs.sort((a, b) => order.indexOf(a.spec) - order.indexOf(b.spec) || a.proposal.localeCompare(b.proposal) || a.origin.localeCompare(b.origin) || a.hours - b.hours || a.seed - b.seed || (a.competitors?.length ?? 1) - (b.competitors?.length ?? 1));
const lines = [];
lines.push(`# B안 회사 시뮬레이션 결과 (${runs.length}건)`, '', '실제 WorldSim, 회사 자동화로 무인 운영. 시작 자금 500,000 cr. 순이익은 실제 현금 변화(미판매 재고 제외).', '');
lines.push('| 전문 | 안 | 출발 | 시간 | 시드 | 회사 수 | 투자 | 순이익/h | 정상상태/h | 회수(h) | 주요 판매 (수량 · 평균가) | 최악 틱 ms |');
lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|');
for (const r of runs) {
  const prods = Object.entries(r.products ?? {}).filter(([, p]) => p.sold > 0).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 2).map(([k, p]) => `${k} ${n(p.sold)} · ${p.avgPrice}`).join('; ');
  lines.push(`| ${r.spec} | ${r.proposal} | ${r.origin} | ${r.hours} | ${r.seed} | ${r.competitors?.length ?? 1} | ${n(r.invested)} | ${n(r.netPerH)} | ${n(r.steadyPerH)} | ${r.paybackH ?? '—'} | ${prods || '—'} | ${r.worstTickMs} |`);
}
const comps = runs.filter(r => r.competitors);
if (comps.length) {
  lines.push('', '## 경쟁 (같은 시장을 공유하는 동일 회사)', '', '| 전문 | 시간 | 회사 | 순이익 | 순이익/h | 판매 |', '|---|---:|---|---:|---:|---|');
  for (const r of comps) for (const c of r.competitors) lines.push(`| ${r.spec} | ${r.hours} | ${c.company} | ${n(c.net)} | ${n(c.netPerH)} | ${Object.entries(c.sold).map(([k, v]) => `${k} ${n(v.units)} (${n(v.value)} cr)`).join('; ')} |`);
}
console.log(lines.join('\n'));
