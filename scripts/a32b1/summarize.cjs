// Markdown tables from docs/a32b1-results/*.json (A-3.2b.1 scenario runs)
//   node scripts/a32b1/summarize.cjs [dir=docs/a32b1-results]
const fs = require('fs');
const dir = process.argv[2] ?? 'docs/a32b1-results';
const f = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n ?? 0)).toLocaleString('en-US');
const mm = s => s === null || s === undefined ? '—' : `${Math.round(s / 60)}분`;
const OP = { ok: '정상 운영', limited: '능력 부족', transport: '운송 병목', halted: '사업 중단' };
const can = c => [c.cargo && '화물', c.hull && '선체', c.equip && '장비'].filter(Boolean).join('·') || '없음';
const load = (m, h, s) => { const p = `${dir}/${m}-${h}h-s${s}.json`; return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const head = '| 시나리오 | 시드 | 시점 | 회수 단위 (기준가) | 시장 판매 | 계약 보수 (완료/실패) | 운영비 | 수리 | 순현금 변화 | 미판매 재고 가치 | 선박 손실 (정가) | 운영 상태 · 남은 회수 능력 | 판매 왕복 (완료/복귀 · 판매량 · 매출) | 첫 인양 / 첫 이익 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
const row = (m, seed, at, c) => `| ${m} | ${seed} | ${at} | ${f(c.recoveredUnits)} (${f(c.recoveredValue)}) | ${f(c.marketRevenue)} | ${f(c.contractPay)} (${c.contracts.done}/${c.contracts.failed}) | ${f(c.upkeep)} | ${f(c.repair)} | **${f(c.netCash)}** | ${f(c.unsoldValue)} | ${c.shipsLost} (${f(c.shipLossValue)}) | ${OP[c.operating.state]} · ${can(c.operating.can)} · 작업선 ${c.operating.workers} | ${c.saleTrips.n} (${c.saleTrips.done}/${c.saleTrips.returned} · ${f(c.saleTrips.sold)} · ${f(c.saleTrips.earned)}) | ${mm(c.firstSalvageAt)} / ${mm(c.firstProfitAt)} |`;

console.log('\n### 추천 대상만 쓰는 신규 인양업자 (safe, 2시간)\n');
console.log(head);
for (const s of [21, 22, 23, 24]) { const o = load('safe', 2, s); if (o) for (const c of o.snapshots['2h'].companies) console.log(row('safe', s, '2h', c)); }

console.log('\n### 비교 (시드 21, 6시간 — 회수량은 엔진 인양 이벤트 기준, 모든 모드 같은 집계)\n');
console.log(head);
for (const m of ['base', 'all', 'risky']) { const o = load(m, 6, 21); if (!o) continue; for (const at of ['2h', '6h']) for (const c of o.snapshots[at]?.companies ?? []) console.log(row(m, 21, at, c)); }

console.log('\n### 회수 집계 대조 (이벤트 집계 vs 회사 장부 `co.salvage`)\n');
console.log('| 시나리오 | 시드 | 이벤트 회수 단위 | 장부 회수 단위 | 이벤트 기준가 | 장부 기준가 |\n|---|---|---|---|---|---|');
for (const [m, h, ss] of [['safe', 2, [21, 22, 23, 24]], ['base', 6, [21]], ['all', 6, [21]], ['risky', 6, [21]]]) for (const s of ss) {
  const o = load(m, h, s); if (!o) continue; const c = o.snapshots[`${h}h`].companies[0];
  console.log(`| ${m} | ${s} | ${f(c.recoveredUnits)} | ${f(c.ledgerUnits)} | ${f(c.recoveredValue)} | ${f(c.ledgerValue)} |`);
}

console.log('\n### 운영 상태 상세 (마지막 시점)\n');
for (const [m, h, ss] of [['safe', 2, [21, 22, 23, 24]], ['base', 6, [21]], ['all', 6, [21]], ['risky', 6, [21]]]) for (const s of ss) {
  const o = load(m, h, s); if (!o) continue; const c = o.snapshots[`${h}h`].companies[0], op = c.operating;
  const items = Object.entries(c.recoveredByItem).map(([k, v]) => `${k} ${f(v)}`).join(', ') || '—';
  const trips = Object.entries(c.saleTrips.items ?? {}).map(([k, v]) => `${k} ${f(v)}`).join(', ');
  const stalls = Object.entries(c.stalls).map(([k, v]) => `${k} ×${v}`).join('; ');
  console.log(`- **${m} s${s}** — ${OP[op.state]}; 남은 함선: ${c.shipsLeft.join(', ') || '없음'}; 회수: ${items}${trips ? `; 판매 왕복 판매: ${trips}` : ''}${op.issues.length ? `; 문제: ${op.issues.join(' / ')}` : ''}${op.comeback ? `; 재기 안내: 현금 ${f(op.comeback.credits)} cr, 대체 함선 ${op.comeback.offers.join(', ') || '없음'} — ${op.comeback.steps.join(' / ')}` : ''}${stalls ? `; 정체: ${stalls}` : ''}`);
}
