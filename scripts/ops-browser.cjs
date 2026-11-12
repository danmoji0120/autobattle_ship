// Browser check of the company HQ (회사 본부): real server build, single-player world, actual commands.
// Usage: npm run build && node scripts/ops-browser.cjs   (screenshots → artifacts/company-ops)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const out = 'artifacts/company-ops'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-ops-ui-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8343', SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [];
const assert = (ok, label) => { if (!ok) throw Error(label); console.log('PASS', label); };
(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8343/?sp=new&name=본부시험');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, undefined, { timeout: 60000 });
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  assert(await page.locator('#opsBtn').count() === 1, 'top bar offers the company HQ button');

  // A: a simple purchase through the normal command path is a finished work immediately
  const buy = await page.evaluate(async () => { const c = window.siderarium.client; const before = c.state.companies[c.company].credits; const err = await c.cmd({ c: 'buy', station: 'astra', res: 'alloy', amount: 100 }); return { err, before }; });
  assert(buy.err === null, 'simple purchase succeeds');
  await page.evaluate(() => { const c = window.siderarium.client; c.t.server.sim.st.companies[c.company].credits = 1_000_000; });
  // B: a stockpile goal from the HQ form (no budget → one approval)
  await page.locator('#opsBtn').click();
  await page.waitForSelector('.ops-box');
  await page.screenshot({ animations: 'disabled', path: out + '/hq-1440.png' });
  await page.getByRole('button', { name: '업무', exact: true }).click();
  await page.locator('[data-a="form"]').click();
  await page.locator('[name="g-station"]').selectOption('astra');
  await page.locator('[name="g-item"]').selectOption('alloy');
  await page.locator('[name="g-n"]').fill('400');
  await page.getByRole('button', { name: '목표 등록' }).click();
  await page.waitForFunction(() => Object.values(window.siderarium.client.state.works ?? {}).some(w => w.kind === 'stockpile'), undefined, { timeout: 10000 });
  assert(await page.locator('.ops-work').count() >= 1, 'works tab lists the new goal');
  await page.screenshot({ animations: 'disabled', path: out + '/works-1440.png' });
  const works = await page.evaluate(() => Object.values(window.siderarium.client.state.works).map(w => ({ kind: w.kind, state: w.state, reason: w.reason })));
  assert(works.some(w => w.kind === 'buy' && w.state === 'done'), 'the purchase is recorded as a finished work');
  // finance tab: approval document with options; approve for this goal
  await page.getByRole('button', { name: /재무·결재/ }).click();
  await page.waitForSelector('.ops-approval', { timeout: 10000 }).catch(async e => { console.log(JSON.stringify(await page.evaluate(() => ({ works: Object.values(window.siderarium.client.state.works).map(w => [w.kind, w.state, w.reason]), aps: window.siderarium.client.state.approvals })))); throw e; });
  await page.screenshot({ animations: 'disabled', path: out + '/approval-1440.png' });
  const doc = await page.locator('.ops-approval').first().innerText();
  assert(doc.includes('추정') && doc.includes('거절 시'), 'approval shows estimate (labelled) and the effect of rejecting');
  await page.locator('[data-scope]').first().selectOption('work');
  await page.locator('.ops-approval [data-opt="approve"]').first().click();
  await page.waitForFunction(() => !Object.values(window.siderarium.client.state.approvals ?? {}).some(a => a.state === 'open'), undefined, { timeout: 10000 });
  assert(true, 'approval decided from the panel');
  await page.evaluate(() => window.siderarium.client.setSpeed(8));
  await page.waitForFunction(() => { const c = window.siderarium.client; return (c.state.stations.astra.storage[c.company]?.alloy ?? 0) >= 400 && Object.values(c.state.works).some(w => w.kind === 'stockpile' && w.state === 'running' && w.reason.includes('유지')); }, undefined, { timeout: 120000 }).catch(async e => { console.log(JSON.stringify(await page.evaluate(() => Object.values(window.siderarium.client.state.works).map(w => [w.kind, w.state, w.reason, w.budget])))); throw e; });
  assert(true, 'maintained stockpile goal reaches its target after approval');
  const goalItem = await page.evaluate(() => Object.values(window.siderarium.client.state.works).find(w => w.kind === 'stockpile').goal.item);
  assert(goalItem === 'alloy', 'form selections survive live snapshot re-renders (item = alloy)');
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  for (const [tab, file] of [['재고', 'stock'], ['산업', 'industry'], ['연구', 'research'], ['물류', 'logistics'], ['건설·조선', 'build'], ['본부', 'hq-after']]) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(150);
    await page.screenshot({ animations: 'disabled', path: `${out}/${file}-1440.png` });
  }
  await page.getByRole('button', { name: '재고', exact: true }).click();
  await page.locator('.ops-table tr[data-a="item"]').first().click();
  assert(await page.locator('.ops-inv-detail').count() === 1, 'inventory row expands to locations, transport and actions');
  await page.screenshot({ animations: 'disabled', path: out + '/stock-detail-1440.png' });
  // mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '본부', exact: true }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ animations: 'disabled', path: out + '/hq-390.png' });
  const overflow = await page.evaluate(() => { const b = document.querySelector('.ops-box'); return b.scrollWidth - b.clientWidth; });
  assert(overflow <= 1, 'no horizontal overflow of the HQ panel at 390 px');
  await page.getByRole('button', { name: '업무', exact: true }).click();
  await page.screenshot({ animations: 'disabled', path: out + '/works-390.png' });
  assert(errors.length === 0, 'no runtime errors: ' + errors.join(' | '));
  fs.writeFileSync(out + '/results.json', JSON.stringify({ works, errors }, null, 2));
})().catch(e => { console.error('FAIL', e.message.slice(0, 2000)); process.exitCode = 1; }).finally(async () => { await browser?.close(); srv.kill(); });
