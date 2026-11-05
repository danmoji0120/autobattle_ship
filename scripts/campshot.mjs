// Campaign playtest driver: node scripts/campshot.mjs <out-prefix> '<steps json>'
// step: { wait?: ms, eval?: js (has `c` = window.siderarium), shot?: name, click?: selector }
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [, , out = 'playtest-out/camp', stepsJson = '[]', query = 'sp=new&name=시데라%20PMC'] = process.argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/?${query}`);
await page.waitForFunction(() => window.siderarium && window.siderarium.client.state, null, { timeout: 60000 });
for (const st of JSON.parse(stepsJson)) {
  if (st.eval) { const r = await page.evaluate(`(async () => { const c = window.siderarium; ${st.eval} })()`); if (r !== undefined) console.log('eval →', JSON.stringify(r)); }
  if (st.click) await page.click(st.click);
  if (st.wait) await page.waitForTimeout(st.wait);
  if (st.shot) { await page.screenshot({ path: `${out}-${st.shot}.png` }); console.log('shot', st.shot); }
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
