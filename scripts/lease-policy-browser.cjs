// Isolated real browser scenario: no production connection, no mocked money/UI.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = 'artifacts/storage-analytics', dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-lease-ui-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8344', SAVE_FILE: path.join(dir, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [], checks = [];
function check(ok, label) { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); }
(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8344/?sp=new&name=임대정책검증');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, { timeout: 60000 });
  await page.evaluate(() => {
    const app = window.siderarium; app.client.setSpeed(0); const sim = app.client.t.server.sim, p = app.client.company, co = sim.st.companies[p];
    // Seed a legitimate old postpaid, shipless company, including existing over-cap inventory.
    for (const id of Object.keys(sim.st.ships)) delete sim.st.ships[id];
    for (const g of Object.values(sim.st.groups)) g.shipIds = [];
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const s of Object.values(sim.st.systems)) s.security = 100;
    sim.st.time = 0; co.credits = 0; co.leases = { rustport: 1 }; delete co.leasePaidUntil; delete co.upkeep;
    sim.st.stations.rustport.storage[p].ore = 4100;
    for (let t = 0; t < 60; t += .25) sim.update(.25);
  });
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].upkeep?.debt === .75);
  await page.locator('[data-upkeep]').click();
  check((await page.locator('.upk').innerText()).includes('0.75 cr'), 'sub-credit debt is legible in the actual upkeep panel');
  check(await page.locator('[data-payarrears]').isDisabled(), 'empty wallet cannot be forced negative');
  await page.screenshot({ animations: 'disabled', path: out + '/lease-upkeep-1440.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ animations: 'disabled', path: out + '/lease-upkeep-390.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { window.siderarium.hud.openStation('rustport', 'store'); });
  check(await page.getByRole('button', { name: '+1 구획 임대', exact: true }).isDisabled(), 'unpaid company cannot lease another block');
  await page.screenshot({ animations: 'disabled', path: out + '/lease-arrears-1440.png' });
  await page.evaluate(() => { const app = window.siderarium; app.hud.closeModal(); const sim = app.client.t.server.sim; for (let t = 60; t < 3600; t += .25) sim.update(.25); });
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].upkeep?.rent?.cancelled?.t === 3600);
  const state = await page.evaluate(() => { const app = window.siderarium, sim = app.client.t.server.sim, co = sim.st.companies[app.client.company]; return { debt: co.upkeep.debt, debtU: co.upkeep.debtU, cancelled: co.upkeep.rent.cancelled, goods: sim.st.stations.rustport.storage[co.id].ore, blocks: co.leases }; });
  check(state.debtU === '45000000000' && state.goods === 4100 && !state.blocks.rustport, 'one unpaid hour cancels extra capacity with exact 45cr debt and all goods retained');
  await page.evaluate(() => window.siderarium.hud.openStation('rustport', 'store'));
  check((await page.locator('.stor').innerText()).includes('한도를 넘었습니다'), 'protected over-cap inventory has an actionable warehouse warning');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ animations: 'disabled', path: out + '/lease-cancelled-1024.png' });
  // Use the existing sell UI; payment occurs through the actual authoritative command path.
  const before = state.debt;
  await page.evaluate(() => { const app = window.siderarium; app.client.t.server.sim.st.stations.rustport.funds = 10; app.hud.openStation('rustport', 'market'); });
  await page.locator('[data-trade^="sell:ore:"]').first().click();
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].upkeep.debt < 45);
  const afterSale = await page.evaluate(() => { const app = window.siderarium, co = app.client.state.companies[app.client.company]; return { debt: co.upkeep.debt, credits: co.credits }; });
  check(afterSale.debt < before && afterSale.credits === 0, 'selling protected inventory prioritizes the arrears balance');
  await page.evaluate(() => { const app = window.siderarium; app.hud.closeModal(); app.client.t.server.sim.st.companies[app.client.company].credits = 100; });
  await page.locator('[data-upkeep]').click();
  await page.waitForFunction(() => { const b = document.querySelector('[data-payarrears]'); return b && !b.disabled; });
  await page.locator('[data-payarrears]').click();
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].upkeep.debt === 0);
  check(await page.locator('[data-payarrears]').count() === 0, 'manual payment clears debt and refreshes the panel');
  await page.evaluate(() => window.siderarium.hud.openStation('rustport', 'store'));
  await page.getByRole('button', { name: '+1 구획 임대', exact: true }).click();
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].leases.rustport === 1);
  check(errors.length === 0, 'fully paid company can lease again without browser errors');
  fs.writeFileSync(out + '/lease-browser-results.json', JSON.stringify({ checks, state, afterSale, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.kill('SIGTERM'); });
