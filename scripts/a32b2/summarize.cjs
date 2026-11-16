// Markdown tables from docs/a32b2-results/*.json (A-3.2b.2 short scenario runs, loss trace on)
//   node scripts/a32b2/summarize.cjs [dir=docs/a32b2-results]
const fs = require('fs');
const dir = process.argv[2] ?? 'docs/a32b2-results';
const f = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n ?? 0)).toLocaleString('en-US');
const OP = { ok: '정상 운영', limited: '능력 부족', transport: '운송 병목', halted: '사업 중단' };
const load = (m, h, s) => { const p = `${dir}/${m}-${h}h-s${s}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
console.log('\n### 추천 대상만 쓰는 신규 인양업자 (safe, 2시간, A-3.2b.2 코드)\n');
console.log('| 시드 | 회수 단위 (기준가) | 시장 판매 | 계약 보수 | 운영비 | 순현금 변화 | 선박 손실 | 운영 상태 | 판매 왕복 (완료/복귀 · 판매량 · 매출) | 고른 대상 (전장 잔해 수) |\n|---|---|---|---|---|---|---|---|---|---|');
for (const s of [21, 22, 23, 24]) {
  const o = load('safe', 2, s); if (!o) continue; const c = o.snapshots['2h'].companies[0];
  const picks = Object.values(o.picks)[0] ?? [];
  console.log(`| ${s} | ${f(c.recoveredUnits)} (${f(c.recoveredValue)}) | ${f(c.marketRevenue)} | ${f(c.contractPay)} | ${f(c.upkeep)} | **${f(c.netCash)}** | ${c.shipsLost} | ${OP[c.operating.state]} | ${c.saleTrips.n} (${c.saleTrips.done}/${c.saleTrips.returned} · ${f(c.saleTrips.sold)} · ${f(c.saleTrips.earned)}) | ${picks.length} (${picks.filter(p => p.kind === 'wreck').length}) |`);
}
console.log('\n### 판매 왕복 판단 기록 (숫자 생략, 횟수)\n');
for (const s of [21, 22, 23, 24]) {
  const o = load('safe', 2, s); if (!o) continue; const c = o.snapshots['2h'].companies[0];
  const notes = Object.entries(c.tripNotes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`- **s${s}** — ${notes.map(([k, v]) => `${k} ×${v}`).join('; ') || '기록 없음'}`);
}
console.log('\n### 선박 손실 추적\n');
for (const s of [21, 22, 23, 24]) {
  const o = load('safe', 2, s); if (!o) continue;
  if (!(o.losses ?? []).length) { console.log(`- **s${s}** — 손실 없음`); continue; }
  for (const l of o.losses) {
    const e = l.engagements[0];
    const job = [...(l.path ?? [])].reverse().find(p => p.job)?.job;
    console.log(`- **s${s}** — ${l.at}s ${l.last.name} (${l.last.hull}) · 성계 ${l.last.sys} · 편대 작전 ${l.last.op} "${l.last.gstatus}" · 직전 물류 작업: ${job ?? '없음'} · 교전 ${e ? `${e.id} (시작 ${e.start}s, 진영 ${e.sides.map(x => x.join('+')).join(' / ')}; ${e.groups.filter(g => g.kind === 'pirate').map(g => `${g.id} ${g.op} ${g.ships}척`).join(', ')})` : '없음'} · 회피: ${(l.groupHistory ?? []).filter(h => /회피/.test(h.status)).map(h => `${h.t}s ${h.status}`).join(', ') || '기록 없음'}`);
  }
}
