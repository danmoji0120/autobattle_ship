const { chromium } = require('playwright');
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const out = 'artifacts/storage-analytics'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-analytics-ui-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8342', SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [];
const assert = (ok, label) => { if (!ok) throw Error(label); console.log('PASS', label); };
(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8342/?sp=new&name=오리온물류');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, { timeout: 60000 });
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  if (process.env.ANALYTICS_ERRORS_ONLY === '1') {
    await page.evaluate(() => { const app = window.siderarium; window.__analyticsSaved = app.client.t.server.analytics; app.client.t.server.analytics = null; });
    await page.getByRole('button', { name: '경제 · 월드', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('비활성화'));
    assert(await page.locator('[role="alert"]').count() === 1, 'disabled collection produces an actionable error state');
    await page.screenshot({ animations: 'disabled', path: out + '/collection-disabled.png' });
    await page.evaluate(() => { const app = window.siderarium; app.hud.analyticsPanel.close(); app.client.t.server.analytics = window.__analyticsSaved; delete window.__analyticsSaved; app.client.t.server.opts.singleplayer = false; app.client.t.server.opts.accounts = true; app.hud.openAnalytics(); });
    await page.waitForSelector('.an-body .an-stats');
    await page.evaluate(() => { const panel = window.siderarium.hud.analyticsPanel; panel.scope = 'admin'; panel.data = undefined; void panel.load(); });
    await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('관리자 권한'));
    assert(await page.locator('.an-body .an-stats').count() === 0, 'permission denial does not leave private tables on screen');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ animations: 'disabled', path: out + '/permission-denied-390.png' });
    await page.evaluate(() => { const app = window.siderarium; app.hud.analyticsPanel.close(); app.client.t.server.opts.singleplayer = true; app.client.t.server.opts.accounts = false; app.hud.openAnalytics(); });
    await page.waitForSelector('.an-body .an-stats');
    assert(errors.length === 0, 'error recovery restores a usable player view without runtime errors');
    fs.writeFileSync(out + '/browser-error-results.json', JSON.stringify({ disabled: true, denied: true, recovered: true, errors }, null, 2));
    return;
  }

  await page.getByRole('button', { name: '경제 · 월드', exact: true }).click();
  await page.waitForSelector('.an-body .an-stats');
  assert((await page.locator('.an-empty').allTextContents()).some(t => t.includes('관측점')), 'fresh history has an honest insufficient-data state');
  await page.getByRole('button', { name: '분석 닫기' }).click();
  const actual = await page.evaluate(() => {
    const app = window.siderarium, server = app.client.t.server, sim = server.sim, me = app.client.company;
    const second = sim.addPlayer('카이퍼산업'), third = sim.addPlayer('아스트라운송');
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const sys of Object.values(sim.st.systems)) sys.security = 100;
    for (const owner of [me, second]) {
      const g = Object.values(sim.st.groups).find(g => g.owner === owner && g.shipIds.some(id => sim.st.ships[id]?.classId === 'miner'));
      const err = sim.command(owner, { c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } }); if (err) throw Error(err);
    }
    for (let t = 0; t < 1201; t += .5) { sim.update(.5); server.analytics.step(); }
    const report = server.analytics.query('admin', me);
    if (Math.abs(report.health.reconciliation) > .001) throw Error('unreconciled currency: ' + report.health.reconciliation);
    server.step(0); // deliver the real server state; no dummy chart series
    return { companies: report.current.companies.length, buckets: report.points.length, mined: sim.st.companies[me].stats.mined, marketUnits: report.totals.filter(r => r.kind === 'market').reduce((n, r) => n + r.amount, 0), bytes: new TextEncoder().encode(JSON.stringify(server.analytics.snapshot())).length };
  });
  assert(actual.companies === 3 && actual.mined > 0 && actual.marketUnits > 0, 'three-company world supplies actual mining, trade and history');
  console.log(JSON.stringify(actual));
  await page.getByRole('button', { name: '경제 · 월드', exact: true }).click();
  await page.waitForSelector('.an-body .an-stats');
  assert(await page.locator('.an-chart svg').count() >= 1, 'player charts show real observed points');
  await page.screenshot({ animations: 'disabled', path: out + '/player-overview-1440.png' });
  await page.getByRole('button', { name: '관리자 보기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.an-head h2')?.textContent.includes('관리자'));
  for (const tab of ['overview', 'growth', 'market', 'industry', 'research', 'world']) {
    await page.locator(`[data-an-tab="${tab}"]`).click();
    await page.screenshot({ animations: 'disabled', path: `${out}/admin-${tab}-1440.png` });
    assert(await page.locator('.an-body').innerText().then(t => t.length > 30), `admin ${tab} renders`);
  }
  await page.locator('[data-an-tab="growth"]').click();
  assert(await page.locator('[data-company-detail]').count() === 3, 'growth comparison shows three real companies');
  await page.locator('[data-company-detail]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-company-detail]').length === 1);
  assert((await page.locator('[data-filter="company"]').inputValue()).length > 0, 'company drill-down updates both query and filter');
  await page.locator('[data-filter="company"]').selectOption('');
  await page.waitForFunction(() => document.querySelectorAll('[data-company-detail]').length === 3);
  await page.locator('[data-an-tab="market"]').click();
  await page.locator('[data-item]').selectOption('alloy');
  await page.waitForFunction(() => document.querySelector('.an-chart h3')?.textContent.includes('합금'));
  for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.screenshot({ animations: 'disabled', path: `${out}/admin-market-${size.width}.png` });
    assert(await page.evaluate(() => { const r = document.querySelector('.an-box').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), `panel fits ${size.width} viewport`);
  }
  await page.getByRole('button', { name: '플레이어 보기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.an-head h2')?.textContent.includes('회사 · 공개'));
  await page.locator('[data-an-tab="growth"]').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-company-detail]').length === 1);
  assert(!(await page.locator('.an-body').innerText()).includes('카이퍼산업'), 'player view contains only its own private growth data');
  await page.keyboard.press('Escape'); assert(await page.locator('.an-modal').count() === 0, 'Escape closes analysis');
  assert(errors.length === 0, 'no browser runtime errors');
  fs.writeFileSync(out + '/browser-results.json', JSON.stringify({ actual, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.kill('SIGTERM'); });
