// Campaign playtest driver: node scripts/campshot.mjs <out-prefix> '<steps json>'
// step: { wait?: ms, eval?: js (has `c` = window.siderarium), shot?: name, click?: selector, move?: [x, y], key?: name }
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [, , out = 'playtest-out/camp', stepsJson = '[]', query = 'sp=new&name=시데라%20PMC'] = process.argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.VW ?? 1280), height: Number(process.env.VH ?? 720) } });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !logs.includes(m.text().slice(0,3000))) logs.push(m.text().slice(0,3000)); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/?${query}`);
await page.waitForFunction(() => window.siderarium && window.siderarium.client.state, null, { timeout: 60000 });
for (const st of JSON.parse(stepsJson)) {
  if (st.eval) { const r = await page.evaluate(`(async () => { const c = window.siderarium; ${st.eval} })()`); if (r !== undefined) console.log('eval →', JSON.stringify(r)); }
  if (st.click) await page.click(st.click);
  if (st.move) await page.mouse.move(st.move[0], st.move[1], { steps: 4 });
  if (st.key) await page.keyboard.press(st.key);
  if (st.mclick) await page.mouse.click(st.mclick[0], st.mclick[1], { button: st.button ?? 'left' });
  if (st.pickAt) { const r = await page.evaluate(`(() => { const c = window.siderarium; ${st.pickAt} })()`); if (r) { await page.mouse.move(r[0], r[1]); await page.mouse.click(r[0], r[1], { button: st.button ?? 'left' }); console.log('clicked', r); } }
  if (st.select) await page.selectOption(st.select[0], st.select[1]);
  if (st.wait) await page.waitForTimeout(st.wait);
  if (st.shot) { await page.screenshot({ path: `${out}-${st.shot}.png` }); console.log('shot', st.shot); }
}
console.log(logs.slice(0, 20).join('\n'));
await browser.close();
