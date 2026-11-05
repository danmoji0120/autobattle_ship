// Usage: node scripts/shot.mjs <url-query> <out-prefix> <script-json>
// script: [{t: simSeconds, cam?: {...}, shot: name}]
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [, , query = '', out = 'playtest-out/shot', stepsJson = '[]'] = process.argv;
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/?manual=1&${query}`);
await page.waitForFunction(() => window.session, null, { timeout: 30000 });
for (const st of steps) {
  const t0 = Date.now();
  await page.evaluate(async ({ st }) => {
    const s = window.session;
    if (st.eval) (new Function('s', st.eval))(s);
    // advance simulation: coarse ticks render each frame; use fast mode with few renders
    if (st.ff !== false) s.fastForward(st.t - 0.5);
    while (s.world.time < st.t && !s.world.outcome) s.tick(1 / 30);
    for (let i = 0; i < (st.settle ?? 2); i++) s.tick(1 / 30);
  }, { st });
  if (st.shot) await page.screenshot({ path: `${out}-${st.shot}.png` });
  console.log('step', st.shot ?? '', 't=', await page.evaluate(() => window.session.world.time.toFixed(1)), (Date.now() - t0) + 'ms', JSON.stringify(await page.evaluate(() => window.session.view.stats)));
}
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
