// Isolated single-player Chromium run. Assets are fixtures; commands and simulation use the real client/server.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = 'artifacts/p981'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-p981-browser-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, DATABASE_URL: '', PORT: '8358', SAVE_FILE: path.join(temp, 'world.json') } });
let browser, log = ''; const errors = [], checks = [];
const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); console.log('PASS', text); };
(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8358/?sp=new&name=공용물류검증');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  const fixture = await page.evaluate(() => {
    const { client } = window.siderarium, server = client.t.server, sim = server.sim, p = client.company, a = sim.st.stations.astra;
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const system of Object.values(sim.st.systems)) system.security = 100;
    sim.st.companies[p].credits = 1e7; a.storage[p].ore = 500;
    const station = (id, name, dx) => ({ ...structuredClone(a), id, name, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, builds: [], orders: [], jobs: [], listings: [], modules: ['core', 'power', 'logistics'].map((kind, slot) => ({ kind, slot, progress: 1, built: true })) });
    sim.st.stations.poolbrowser1 = station('poolbrowser1', '오리온 보급항', 500); sim.st.stations.poolbrowser2 = station('poolbrowser2', '오리온 생산항', -600);
    const g = sim.newGroup(p, '오리온 공용 수송'); const ships = [];
    for (let i = 0; i < 3; i++) { const s = sim.spawnShip(p, 'hauler', 'std', g.id, a.pos, `수송선 ${i + 1}`); sim.dockShip(s, a); ships.push(s.id); }
    server.step(1); return { group: g.id, ships };
  });
  await page.waitForFunction(id => !!window.siderarium.client.state.groups[id], fixture.group);
  await page.getByRole('button', { name: '물류 관리', exact: true }).click();
  check(await page.getByRole('button', { name: '공용 배차', exact: true }).getAttribute('aria-pressed') === 'true', 'pool is discoverable on opening logistics');
  await page.locator(`[data-pool-group="${fixture.group}"][data-pool-on="true"]`).click();
  await page.waitForFunction(ids => ids.every(id => window.siderarium.client.state.ships[id].logisticsPool), fixture.ships);
  check(true, 'whole group opts in through authoritative command');
  for (const dest of ['poolbrowser1', 'poolbrowser2']) {
    await page.locator('[data-pool-new]').first().click();
    await page.locator('[data-pool-field="from"]').selectOption('astra'); await page.locator('[data-pool-field="to"]').selectOption(dest);
    await page.locator('[data-pool-field="amount"]').fill('20');
    await page.locator('[data-pool-form] button[type="submit"]').click();
    await page.waitForFunction(n => Object.keys(window.siderarium.client.state.logisticsJobs ?? {}).length === n, dest === 'poolbrowser1' ? 1 : 2);
  }
  check(await page.locator('[data-pool-job]').count() === 2, 'two independent jobs are created through the visible form');
  const result = await page.evaluate(() => {
    const server = window.siderarium.client.t.server, sim = server.sim, p = window.siderarium.client.company;
    for (let t = 0; t < 2; t += .25) sim.update(.25);
    const assigned = Object.values(sim.st.logisticsJobs).map(j => j.ship);
    for (let t = 0; t < 120; t += .25) sim.update(.25);
    server.step(1);
    return { assigned, jobs: Object.values(sim.st.logisticsJobs).map(j => ({ state: j.state, delivered: j.delivered })), delivered: ['poolbrowser1', 'poolbrowser2'].map(id => sim.st.stations[id].storage[p].ore) };
  });
  check(new Set(result.assigned).size === 2 && result.assigned.every(Boolean), 'ships in the same group were assigned different jobs');
  check(result.jobs.every(j => j.state === 'complete' && j.delivered === 20) && result.delivered.every(n => n === 20), 'both jobs physically delivered once');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-pool-job]')].every(el => el.textContent.includes('완료')));
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.screenshot({ path: `${out}/pool-${size.width}.png`, animations: 'disabled' });
    check(await page.evaluate(() => { const r = document.querySelector('.lg-box').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), `pool fits viewport ${size.width}`);
  }
  await page.locator('[data-pool-new]').first().click(); await page.screenshot({ path: `${out}/pool-editor-390.png`, animations: 'disabled' });
  check(await page.locator('[data-pool-form]').isVisible(), 'mobile task editor is visible');
  await page.locator('[data-pool-field="from"]').selectOption('astra'); await page.locator('[data-pool-field="to"]').selectOption('poolbrowser1');
  await page.locator('[data-pool-field="amount"]').fill('20'); await page.locator('[data-pool-form] button[type="submit"]').click();
  await page.waitForFunction(() => Object.keys(window.siderarium.client.state.logisticsJobs ?? {}).length === 3);
  const third = await page.evaluate(() => Object.values(window.siderarium.client.state.logisticsJobs).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0].id);
  await page.locator(`[data-pool-control="${third}"][data-pool-action="pause"]`).click();
  await page.waitForFunction(id => window.siderarium.client.state.logisticsJobs[id].state === 'paused', third);
  await page.locator(`[data-pool-control="${third}"][data-pool-action="resume"]`).click();
  await page.waitForFunction(id => window.siderarium.client.state.logisticsJobs[id].state === 'queued', third);
  check(true, 'mobile task can be created, paused and resumed');
  await page.evaluate(id => {
    const server = window.siderarium.client.t.server, sim = server.sim, p = window.siderarium.client.company;
    sim.st.stations.poolbrowser1.storage[p].ore = 20000;
    for (let t = 0; t < 100; t += .25) sim.update(.25);
    if (sim.st.logisticsJobs[id].code !== 'storage') throw Error('full warehouse did not block');
    server.step(1);
  }, third);
  await page.waitForFunction(id => window.siderarium.client.state.logisticsJobs[id].code === 'storage', third);
  check((await page.locator(`[data-pool-job="${third}"]`).innerText()).includes('목적지 창고 가득'), 'full warehouse reason is visible on the task');
  await page.locator(`[data-pool-job="${third}"]`).scrollIntoViewIfNeeded(); await page.screenshot({ path: `${out}/pool-full-390.png`, animations: 'disabled' });
  await page.evaluate(id => {
    const server = window.siderarium.client.t.server, sim = server.sim, p = window.siderarium.client.company;
    sim.st.stations.poolbrowser1.storage[p].ore -= 20;
    for (let t = 0; t < 70; t += .25) sim.update(.25);
    if (sim.st.logisticsJobs[id].state !== 'complete') throw Error('warehouse recovery did not complete');
    server.step(1);
  }, third);
  await page.waitForFunction(id => window.siderarium.client.state.logisticsJobs[id].state === 'complete', third);
  check(true, 'full warehouse task recovers after space is freed');
  await page.locator('[data-pool-new]').first().click(); await page.locator('[data-pool-field="to"]').selectOption('poolbrowser2');
  await page.locator('[data-pool-field="amount"]').fill('10'); await page.locator('[data-pool-form] button[type="submit"]').click();
  await page.waitForFunction(() => Object.keys(window.siderarium.client.state.logisticsJobs ?? {}).length === 4);
  const fourth = await page.evaluate(() => Object.values(window.siderarium.client.state.logisticsJobs).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0].id);
  await page.locator(`[data-pool-control="${fourth}"][data-pool-action="cancel"]`).click();
  await page.waitForFunction(id => window.siderarium.client.state.logisticsJobs[id].state === 'cancelled', fourth);
  check(true, 'task cancellation works on mobile');
  await page.locator(`[data-pool-ship="${fixture.ships[2]}"]`).click();
  await page.waitForFunction(id => !window.siderarium.client.state.ships[id].logisticsPool, fixture.ships[2]);
  await page.locator(`[data-pool-ship="${fixture.ships[2]}"]`).click();
  await page.waitForFunction(id => window.siderarium.client.state.ships[id].logisticsPool, fixture.ships[2]);
  check(true, 'individual ship exclusion and re-enrollment work on mobile');
  await page.getByRole('button', { name: '기존 운송 노선', exact: true }).click();
  check(await page.locator('[data-lg-new]').count() > 0, 'legacy route management remains accessible');
  check(errors.length === 0, `no browser page errors (${errors.join('; ')})`);
  fs.writeFileSync(`${out}/browser.json`, JSON.stringify({ checks, result, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.kill('SIGTERM'); fs.rmSync(temp, { recursive: true, force: true }); });
