// Print faction state at chosen hours for v2 scenario results (stabilization comparison).
//   npx vite-node scripts/faction/compare.ts -- <result.json>... [hours=12,24,48,72]
import fs from 'node:fs';
const a = process.argv.slice(2).filter(x => x !== '--');
const hs = (a.find(x => x.startsWith('hours='))?.slice(6) ?? '12,24,48,72').split(',').map(Number);
for (const f of a.filter(x => !x.startsWith('hours='))) {
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`${f.split('/').pop()} — 위반 ${d.violationCount}${d.twinEqual === undefined ? '' : `, 저장 동일 ${d.twinEqual}`}, ms/틱 ${d.msPerTick}, 분쟁 ${d.conflicts.length}`);
  for (const h of d.hourly.filter((x: any) => hs.includes(x.h)))
    console.log(`  h${h.h} ${Object.entries<any>(h.factions).map(([id, x]) => `${id.slice(0, 4)} s${Math.round(x.strength)} e${x.eff.toFixed(2)} r${x.rdy.toFixed(2)} d${x.dev.toFixed(2)}`).join(' | ')}${h.wars.length ? '  전쟁:' + h.wars.join(',') : ''}`);
  const p = d.totals?.pirates; if (p) console.log(`  해적 누적: 재건 ${p.builtStr} 손실 ${p.lostStr} 수입 ${p.income} 수출 ${p.exportRev}`);
}
