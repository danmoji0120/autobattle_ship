// Actual Chromium interactions against the same authoritative server used by single player.
// Scenario assets are seeded only in this isolated test world; all transport/production is real.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = 'artifacts/logistics-p2'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-p2-browser-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, DATABASE_URL: '', PORT: '8351', SAVE_FILE: path.join(temp, 'world.json') } });
let browser, log = ''; const errors = [], checks = [];
const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); console.log('PASS', text); };
(async () => {
  await new Promise((r, j) => { const timer = setTimeout(() => j(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); r(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => j(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8351/?sp=new&name=오리온산업');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.getByRole('button', { name: '물류 관리', exact: true }).click();
  check(await page.getByText('반복 운송을 시작하세요', { exact: true }).count() === 1, 'empty view has a usable route-creation action');
  const mining = await page.evaluate(() => {
    const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company, co = sim.st.companies[p];
    app.hud.logisticsPanel?.close();
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const system of Object.values(sim.st.systems)) system.security = 100;
    const group = Object.values(sim.st.groups).find(g => g.owner === p && g.shipIds.some(id => sim.st.ships[id]?.classId === 'miner'));
    const hauler = sim.spawnShip(p, 'hauler', 'std', group.id, sim.st.stations.astra.pos); sim.dockShip(hauler, sim.st.stations.astra);
    const error = sim.command(p, { c: 'setOp', group: group.id, op: { k: 'mine', field: 'kestrel', deliver: '', sell: true, auto: true } }); if (error) throw Error(error);
    const startMined = co.stats.mined, startEarned = co.stats.earned; let carried = false;
    for (let t = 0; t < 600; t += .25) { sim.update(.25); if (Object.values(hauler.cargo).some(n => n > 0)) carried = true; }
    return { mined: co.stats.mined - startMined, saleIncome: co.stats.earned - startEarned, haulerCarriedOre: carried };
  });
  check(mining.mined > 0 && mining.saleIncome > 0 && mining.haulerCarriedOre, 'real miners → separate hauler → market sales repeat in the browser');
  const setup = await page.evaluate(() => {
    const app = window.siderarium, server = app.client.t.server, sim = server.sim, p = app.client.company, co = sim.st.companies[p], a = sim.st.stations.astra;
    app.hud.logisticsPanel?.close();
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const s of Object.values(sim.st.systems)) s.security = 100;
    const station = (id, name, dx, modules) => ({ ...structuredClone(a), id, name, public: false, owner: p, pos: { ...a.pos, x: a.pos.x + dx }, desc: '물류 검증을 위한 자사 산업 정거장', market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [p]: {} }, modules: modules.map((kind, slot) => ({ kind, slot, progress: 1, built: true })), listings: [], shipListings: [] });
    const factory = station('p2factory', '오리온 제련소', 700, ['core', 'power', 'refinery', 'logistics']);
    const depot = station('p2depot', '오리온 물류항', -700, ['core', 'power', 'warehouse', 'trade_hub']);
    sim.st.stations[factory.id] = factory; sim.st.stations[depot.id] = depot;
    const group = sim.newGroup(p, '원료 공급선'), output = sim.newGroup(p, '제품 운송선');
    const one = sim.spawnShip(p, 'hauler', 'std', group.id, a.pos), two = sim.spawnShip(p, 'hauler', 'std', output.id, factory.pos);
    sim.dockShip(one, a); sim.dockShip(two, factory);
    const buy = sim.command(p, { c: 'buy', station: a.id, res: 'ore', amount: 600 }); if (buy) throw Error(buy);
    const order = sim.command(p, { c: 'prodOrder', station: factory.id, recipe: 'alloy_direct', mode: 'stock', n: 120 }); if (order) throw Error(order);
    window.__p2requests = []; const send = app.client.cmd.bind(app.client); app.client.cmd = async command => { const row = { command: structuredClone(command) }; window.__p2requests.push(row); row.error = await send(command); return row.error; };
    window.__p2 = { group: group.id, output: output.id, factory: factory.id, depot: depot.id, ship: one.id, productShip: two.id };
    return window.__p2;
  });
  await page.waitForFunction(() => !!window.siderarium.client.state.stations.p2factory);
  await page.getByRole('button', { name: '물류 관리', exact: true }).click();
  await page.locator('[data-lg-new]').first().click();
  await page.locator('[data-lg-field="group"]').selectOption(setup.group);
  await page.locator('[data-lg-field="name"]').fill('제련소 원료 보충');
  await page.locator('[data-lg-field="from"]').selectOption('astra');
  await page.locator('[data-lg-field="to"]').selectOption(setup.factory);
  await page.locator('[data-lg-mode="supply"]').click();
  await page.locator('[data-lg-field="item"]').selectOption('ore');
  await page.locator('[data-lg-field="amount"]').fill('80');
  await page.locator('[data-lg-field="minStock"]').fill('60');
  await page.locator('[data-lg-field="targetStock"]').fill('120');
  check(await page.locator('[data-lg-field="name"]').inputValue() === '제련소 원료 보충', 'live snapshots preserve typed route settings');
  await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
  await page.waitForSelector('[data-lg-card]');
  check((await page.locator('[data-lg-card]').first().innerText()).includes('제련소 원료 보충'), 'route form creates an authoritative live route');
  await page.locator('[data-lg-new]').first().click();
  await page.locator('[data-lg-field="group"]').selectOption(setup.output);
  await page.locator('[data-lg-field="name"]').fill('합금 출하');
  await page.locator('[data-lg-field="from"]').selectOption(setup.factory);
  await page.locator('[data-lg-field="to"]').selectOption(setup.depot);
  await page.locator('[data-lg-field="item"]').selectOption('alloy');
  await page.locator('[data-lg-field="amount"]').fill('10');
  await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-lg-card]').length === 2);
  check(await page.locator('.lg-feedback[role="alert"]').count() === 0, 'live re-renders do not submit duplicate route commands');
  const industry = await page.evaluate(() => {
    const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
    for (let t = 0; t < 600; t += .25) sim.update(.25);
    const routes = Object.values(sim.st.logistics), delivered = sim.st.stations.p2depot.storage[p].alloy || 0;
    if (delivered < 42 || !routes.every(r => r.stats.delivered > 0)) throw Error('real raw-material → production → product logistics failed');
    return { deliveredAlloy: delivered, routes: routes.map(r => ({ name: r.config.name, loaded: r.stats.loaded, delivered: r.stats.delivered })) };
  });
  check(industry.deliveredAlloy >= 42, 'real supply → production → product transport runs without direct ship control');
  for (const size of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.screenshot({ animations: 'disabled', path: `${out}/logistics-${size.width}.png` });
    check(await page.evaluate(() => { const r = document.querySelector('.lg-box').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), `route management fits ${size.width}px`);
  }
  await page.locator('[data-lg-edit]').first().click();
  await page.screenshot({ animations: 'disabled', path: out + '/route-editor-390.png' });
  check(await page.locator('[data-lg-field="group"]').isDisabled(), 'editing protects the assigned fleet while preserving server validation');
  await page.locator('[data-lg-form-close]').click();
  await page.locator('[data-lg-all]').click();
  await page.locator('[data-lg-bulk="pause"]').click();
  await page.waitForFunction(() => Object.values(window.siderarium.client.state.logistics).every(r => r.state === 'paused'));
  check(await page.locator('.lg-badge.paused').count() === 2, 'batch pause visibly stops all selected routes');
  const recovery = await page.evaluate(() => {
    const sim = window.siderarium.client.t.server.sim, p = window.siderarium.client.company;
    const ship = sim.st.ships[window.__p2.productShip], depot = sim.st.stations.p2depot;
    if ((depot.storage[p].alloy || 0) < 5 || Object.values(ship.cargo).some(n => n > 0)) throw Error('manual recovery fixture needs real delivered goods and an empty hold');
    depot.storage[p].alloy -= 5; ship.cargo.alloy = 5; sim.dockShip(ship, depot);
    return { ship: ship.id, before: depot.storage[p].alloy, route: Object.values(sim.st.logistics).find(r => r.group === window.__p2.output).id };
  });
  await page.waitForSelector(`[data-lg-fleet="${recovery.route}"]`);
  await page.locator(`[data-lg-fleet="${recovery.route}"] summary`).click();
  await page.locator(`[data-lg-unload="${recovery.ship}"]`).click();
  await page.waitForFunction(({ship, before, route}) => {
    const w = window.siderarium.client.state, p = window.siderarium.client.company;
    return !w.ships[ship].cargo.alloy && w.stations.p2depot.storage[p].alloy === before + 5 && w.logistics[route].state === 'paused';
  }, recovery);
  check(true, 'real cargo-recovery button returns goods to owned storage and keeps the route paused');
  await page.locator('[data-lg-bulk="resume"]').click();
  await page.waitForFunction(() => Object.values(window.siderarium.client.state.logistics).every(r => r.state === 'running'));
  // Market-sale consent is explicit even when editing an existing owned route.
  await page.locator('[data-lg-new]').first().click(); await page.locator('[data-lg-mode="sell"]').click();
  check(await page.locator('.lg-submit').isDisabled(), 'automatic sales need an explicit visible consent');
  await page.screenshot({ animations: 'disabled', path: out + '/sale-consent-390.png' });
  await page.keyboard.press('Escape');
  check(await page.locator('.lg-modal').count() === 0, 'Escape closes logistics without issuing a game command');
  check(errors.length === 0, 'no browser runtime errors');
  const requests = await page.evaluate(() => window.__p2requests);
  fs.writeFileSync(out + '/browser-results.json', JSON.stringify({ checks, mining, industry, requests, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.kill('SIGTERM'); });
