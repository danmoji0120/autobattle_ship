// Markdown tables from docs/a32b-results/*.json (A-3.2b scenario runs)
//   node scripts/a32b/summarize.cjs [dir=docs/a32b-results]
const fs = require('fs');
const dir = process.argv[2] ?? 'docs/a32b-results';
const modes = ['none', 'base', 'derelict', 'all', 'risky', 'compete3'];
const f = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('en-US');
const mm = s => s === null || s === undefined ? '—' : `${Math.round(s / 60)}분`;
for (const at of ['2h', '6h']) {
  console.log(`\n### ${at === '2h' ? '2시간' : '6시간'} 시점\n`);
  console.log('| 시나리오 | 회사 | 발견/작업 대상 | 회수 단위 (기준가) | 계약 수주/완료/실패 | 시장 판매 | 계약 보수 | 운영비 | 수리 | 순현금 | 미판매 재고 가치 | 선박 손실 (정가) | 창고 최대 | 대상 없음(분) | 첫 인양 / 첫 이익 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of modes) {
    const p = `${dir}/${m}-6h-s21.json`; if (!fs.existsSync(p)) continue;
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).snapshots[at]; if (!s) continue;
    s.companies.forEach((c, i) => {
      const k = c.contracts;
      console.log(`| ${i ? '' : m} | ${i + 1} | ${c.targetsSeen}/${c.targetsWorked} | ${f(c.recoveredUnits)} (${f(c.recoveredValue)}) | ${k.accepted}/${k.done}/${k.failed} | ${f(c.marketRevenue)} | ${f(c.contractPay)} | ${f(c.upkeep)} | ${f(c.repair)} | **${f(c.netCash)}** | ${f(c.unsoldValue)} | ${c.shipsLost} (${f(c.shipLossValue ?? 0)}) | ${f(c.warehousePeak)} | ${c.minutesIdleNoTarget} | ${mm(c.firstSalvageAt)} / ${mm(c.firstProfitAt)} |`);
    });
  }
  console.log('\n| 시나리오 | 살아 있는 유기선 | 전장 잔해 | 누적 생성 유기선 (기준가) | 게시된 인양 계약 |');
  console.log('|---|---|---|---|---|');
  for (const m of modes) {
    const p = `${dir}/${m}-6h-s21.json`; if (!fs.existsSync(p)) continue;
    const s = JSON.parse(fs.readFileSync(p, 'utf8')).snapshots[at]; if (!s) continue;
    const w = s.world;
    console.log(`| ${m} | ${w.derelictsLive} | ${w.battleWrecksLive} | ${w.derelictsMade} (${f(w.derelictValueMade)}) | ${w.salvageContractsPosted} |`);
  }
}
console.log('\n### 6시간: 품목별 회수량 · 품목별 판매 · 정체 원인\n');
for (const m of modes) {
  const p = `${dir}/${m}-6h-s21.json`; if (!fs.existsSync(p)) continue;
  const s = JSON.parse(fs.readFileSync(p, 'utf8')).snapshots['6h'];
  s.companies.forEach((c, i) => {
    const items = Object.entries(c.recoveredByItem).map(([k, v]) => `${k} ${f(v)}`).join(', ') || '—';
    const sales = Object.entries(c.salesByItem).map(([k, v]) => `${k} ${f(v)}`).join(', ') || '—';
    const stalls = Object.entries(c.stalls).map(([k, v]) => `${k} ×${v}`).join('; ');
    const fails = Object.entries(c.contracts.failReasons ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const ss = Object.entries(c.salesStatus).map(([k, v]) => `${k}: ${v}`).join('; ');
    console.log(`- **${m}${s.companies.length > 1 ? ` #${i + 1}` : ''}** 회수: ${items} · 판매: ${sales}${fails ? ` · 계약 실패: ${fails}` : ''}${stalls ? ` · 정체: ${stalls}` : ''}${ss ? ` · 판매 대기: ${ss}` : ''}`);
  });
}
