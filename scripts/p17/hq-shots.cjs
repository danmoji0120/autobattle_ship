// P17.4e: before/after screenshots of the company HQ (every tab, the fleet goal form, phone width).
// Usage: npm run build && node scripts/p17/hq-shots.cjs <label>   (→ artifacts/p174e/<label>-*.png)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const label = process.argv[2] || 'shot', out = 'artifacts/p174e'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-hq-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8347', SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [];
const slug = s => s.replace(/\s+\d+$/, '').replace(/[^\p{L}\p{N}]+/gu, '_');
(async () => {
  await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(t); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8347/?sp=new&name=본부');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, undefined, { timeout: 60000 });
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  // something to show: a delivery contract taken, a little stock, a fleet goal
  await page.evaluate(async () => {
    const c = window.siderarium.client, sim = c.t.server.sim, me = c.company; sim.st.companies[me].credits = 2_000_000;
    await c.cmd({ c: 'buy', station: 'astra', res: 'alloy', amount: 200 });
    // a delivery contract at astra (posted by the fixture when the seed has none open there)
    let k = Object.values(sim.st.contracts).find(x => x.kind === 'delivery' && !x.takenBy && !x.done && x.stationId === 'astra');
    if (!k) { k = { id: 'k_shot', stationId: 'astra', kind: 'delivery', title: '합금 납품', desc: '', reward: 12000, rep: 1, res: 'alloy', amount: 500, progress: 0, expires: sim.time + 3000, takenBy: null, done: false }; sim.st.contracts[k.id] = k; }
    return { accept: await c.cmd({ c: 'accept', contract: k.id }), id: k.id };
  }).then(r => console.log('fixture', JSON.stringify(r)));
  await page.evaluate(() => window.siderarium.client.setSpeed(4)); await page.waitForTimeout(1500); await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.locator('#opsBtn').click(); await page.waitForSelector('.ops-box');
  const shot = async name => { await page.waitForTimeout(200); await page.screenshot({ animations: 'disabled', path: `${out}/${label}-${name}.png` }); console.log('shot', name); };
  const nav = await page.locator('nav.ops-tabs button').allInnerTexts();
  for (let i = 0; i < nav.length; i++) {
    await page.locator('nav.ops-tabs button').nth(i).click(); await page.waitForTimeout(150);
    const sub = await page.locator('nav.ops-subtabs button').allInnerTexts();
    if (!sub.length) { await shot(`${String(i).padStart(2, '0')}-${slug(nav[i])}`); continue; }
    for (let j = 0; j < sub.length; j++) { await page.locator('nav.ops-subtabs button').nth(j).click(); await shot(`${String(i).padStart(2, '0')}${'abcdefgh'[j]}-${slug(nav[i])}-${slug(sub[j])}`); }
  }
  // fleet goal form: the fleet tab (after) or the works tab with the "fleet" kind (before)
  if (await page.locator('[data-a="sect"][data-id="fleet"]').count()) { await page.locator('[data-a="sect"][data-id="fleet"]').click(); await page.locator('[data-a="form"]').first().click(); }
  else { await page.locator('nav.ops-tabs button', { hasText: '업무' }).first().click(); await page.locator('[data-a="form"]').first().click(); await page.locator('[data-goalkind]').selectOption('fleet'); }
  await shot('fleet-form');
  if (label !== 'before') {
    const ok = (c, l) => { if (!c) throw Error('FAIL ' + l); console.log('PASS', l); };
    // E2: contract → its goods in stock → transport status → back → back to the contract list
    await page.locator('[data-a="sect"][data-id="ops"]').click();
    await page.locator('nav.ops-subtabs [data-id="contracts"]').click();
    ok(await page.locator('.ops-work .ops-kind', { hasText: '납품' }).count() >= 1, 'contracts area lists the taken delivery contract');
    await page.locator('[data-a="goto"][data-id="stock"]').first().click();
    ok(await page.locator('nav.ops-subtabs button.on', { hasText: '재고' }).count() === 1, 'contract link opens stock');
    ok(await page.locator('.ops-inv-detail').count() === 1, 'the contract item detail is open in stock');
    await shot('e2-stock-from-contract');
    // P17.4b deferred check: the sale search block renders inside the item detail
    ok(await page.locator('.ops-inv-detail').innerText().then(t => /판매처/.test(t)), 'stock item detail shows the sale search (P17.4b)');
    await page.locator('.ops-inv-detail [data-a="goto"][data-id="logistics"]').click();
    ok(await page.locator('nav.ops-subtabs button.on', { hasText: '운송' }).count() === 1, 'stock link opens transport');
    await shot('e2-logistics');
    await page.locator('[data-a="back"]').click();
    ok(await page.locator('.ops-inv-detail').count() === 1, 'back returns to stock with the item still open');
    await page.locator('[data-a="back"]').click();
    ok(await page.locator('nav.ops-subtabs button.on', { hasText: '계약' }).count() === 1 && await page.locator('[data-a="back"]').count() === 0, 'second back returns to the contract list; return path empty');
    // section memory: industry → facilities, away, back to industry opens facilities
    await page.locator('[data-a="sect"][data-id="industry"]').click(); await page.locator('nav.ops-subtabs button', { hasText: '시설 건설' }).click();
    await page.locator('[data-a="sect"][data-id="hq"]').click(); await page.locator('[data-a="sect"][data-id="industry"]').click();
    ok(await page.locator('nav.ops-subtabs button.on', { hasText: '시설 건설' }).count() === 1, 'a section reopens its last sub-screen');
    // fleet form: estimate renders; the repair table separates four kinds
    await page.locator('[data-a="sect"][data-id="fleet"]').click();
    ok(await page.locator('.ops-fleet-est').count() === 1, 'fleet goal form shows the estimate');
    ok((await page.locator('.ops-repair tbody tr').count()) === 4, 'fleet area lists four repair kinds separately (AUD-17)');
    await page.locator('.ops-repair').scrollIntoViewIfNeeded(); await shot('fleet-repair');
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('nav.ops-tabs button').first().click(); await shot('phone-hq');
  console.log('errors', JSON.stringify(errors));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await browser?.close(); srv.kill(); });
