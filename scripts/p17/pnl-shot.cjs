// P17.4f F1: the HQ finance screen's per-business P&L table after a game hour in a new single-player company.
// Usage: npm run build && node scripts/p17/pnl-shot.cjs   (→ artifacts/p174f/after-finance-pnl.png)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const out = 'artifacts/p174f'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-pnl-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8348', SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [];
const ok = (c, l) => { if (!c) throw Error('FAIL ' + l); console.log('PASS', l); };
(async () => {
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(t); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8348/?sp=new&name=손익');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, undefined, { timeout: 60000 });
  // one game hour in the engine (no rendering in between), plus a ship's own sale and a storage sale
  const r = await page.evaluate(() => {
    const c = window.siderarium.client, sim = c.t.server.sim, me = c.company; c.setSpeed(0);
    const ship = Object.values(sim.st.ships).find(s => s.owner === me);
    sim.st.groups[ship.groupId].op = { k: 'haul' };
    const st = Object.values(sim.st.stations).find(s => s.public && s.market?.ore);
    sim.sellAt(st, me, 'ore', 30, ship); sim.sellAt(st, me, 'ore', 30);
    sim.st.groups[ship.groupId].op = { k: 'idle' };
    for (let t = 0; t < 3600; t++) sim.update(1);
    return (sim.st.companies[me].ops.act ?? []).length;
  });
  console.log('activity buckets', r);
  await page.evaluate(() => window.siderarium.client.setSpeed(1)); await page.waitForTimeout(1500); await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.locator('#opsBtn').click(); await page.waitForSelector('.ops-box');
  await page.locator('nav.ops-tabs [data-a="sect"][data-id="hq"]').click();
  await page.locator('nav.ops-subtabs button', { hasText: '재무' }).click();
  await page.waitForSelector('.ops-pnl');
  const rows = await page.locator('.ops-pnl tbody tr').allInnerTexts();
  console.log(rows.join('\n'));
  ok(await page.locator('.ops-pnl tr[data-act="logistics"]').count() === 1, 'a ship\'s own sale is under its business (물류·수송)');
  ok(await page.locator('.ops-pnl tr[data-act="stock"]').count() === 1, 'a storage sale is "보관 재고 판매"');
  ok(await page.locator('.ops-pnl tfoot').count() === 1, 'the table has a total row');
  await page.locator('.ops-pnl').scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: `${out}/after-finance-pnl.png` });
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  await page.locator('.ops-pnl').scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: `${out}/after-finance-pnl-phone.png` });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll at phone width');
  ok(!errors.length, 'no page errors ' + errors.join(' | '));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); srv.kill(); });
