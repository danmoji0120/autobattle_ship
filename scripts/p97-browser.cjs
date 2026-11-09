// A disposable browser-local single-player world. Test capital, research and facilities are seeded;
// mining, routing, production, fitting and persistence go through the game's existing UI/server.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p97';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-p97-browser-'));
fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5187', '--strictPort'], {
  env: { PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(temp, 'config'), XDG_CACHE_HOME: path.join(temp, 'cache'), XDG_DATA_HOME: path.join(temp, 'data'), NODE_ENV: 'production', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let serverLog = '', browser, page;
server.stdout.on('data', d => serverLog += d); server.stderr.on('data', d => serverLog += d);
(async () => {
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`local preview startup: ${serverLog}`)), 30000);
      const onData = () => { if (serverLog.includes('Local:')) { clearTimeout(timer); resolve(); } };
      server.stdout.on('data', onData); server.once('exit', () => reject(Error(serverLog)));
    });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto('http://127.0.0.1:5187/?sp=new&name=P97검증', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state?.regionalV === 1, null, { timeout: 60000 });
    const fixture = await page.evaluate(() => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      app.client.setSpeed(0); sim.npcSlow = () => {}; sim.npcs = () => {};
      for (const lair of Object.values(sim.st.lairs)) { lair.alive = false; lair.respawnAt = 1e10; }
      Object.assign(sim.st.companies[p], { credits: 10000000, tech: ['rare_processing', 'reactive_armor'] });
      const home = sim.st.stations.astra, source = sim.st.stations.p9_anvil_port, field = sim.st.fields.p97_anvil_dense;
      const factory = { ...structuredClone(home), id: 'p97_browser_factory', name: '검증용 산업 거점', owner: p, public: false, size: 'L', market: null,
        pos: { ...home.pos, x: home.pos.x + 3500 }, storage: { [p]: { titanium: 10, metal: 10, armor_plate: 6, composite: 8, chemicals: 6 } },
        modules: ['core', 'power', 'smelter', 'armor_plant', 'fitting', 'trade_hub'].map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), orders: [], jobs: [], builds: [], listings: [], seq: 0 };
      sim.st.stations[factory.id] = factory;
      const miners = sim.newGroup(p, '앤빌 채굴 시험'), miner = sim.spawnShip(p, 'miner', 'std', miners.id, field.pos);
      const carriers = sim.newGroup(p, '원광 운송 시험'), carrier = sim.spawnShip(p, 'hauler', 'std', carriers.id, source.pos);
      const combat = sim.newGroup(p, '피팅 시험'), ship = sim.spawnShip(p, 'cruiser', 'gun', combat.id, factory.pos);
      if (!sim.dockShip(ship, factory)) throw Error('fixture ship could not dock');
      app.client.t.server.step(.6);
      return { p, field: field.id, source: source.id, factory: factory.id, miners: miners.id, miner: miner.id, carriers: carriers.id, carrier: carrier.id, ship: ship.id };
    });
    await page.waitForFunction(x => !!window.siderarium.client.state.groups[x.miners], fixture);
    await page.evaluate(x => { const a = window.siderarium; a.hud.select({ kind: 'group', id: x.miners }); a.hud.toggleGalaxy(); }, fixture);
    await page.locator('[data-sys="anvil"]').click();
    const fieldRow = page.locator(`[data-gal-field="${fixture.field}"]`);
    await fieldRow.waitFor();
    const mapText = await fieldRow.innerText();
    check(mapText.includes('지역 희귀') && mapText.includes('30%') && mapText.includes('재생') && mapText.includes('위험'), 'galaxy map shows origin, mixture, reserves, regeneration and risk');
    await page.screenshot({ path: `${out}/regional-map-1440.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${out}/regional-map-390.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await fieldRow.click();
    const detail = await page.locator('#sel').innerText();
    check(detail.includes('고밀도 티타늄 원광') && detail.includes('제련소') && detail.includes('재생') && detail.includes('위험'), 'field details explain the rare material and actual processing facility');
    await page.screenshot({ path: `${out}/field-detail-1440.png`, animations: 'disabled' });
    await page.locator(`[data-minehere="${fixture.field}"]`).click();
    await page.locator('[data-mf="sell"]').selectOption('0');
    await page.locator('[data-mf="deliver"]').selectOption(fixture.source);
    await page.locator('[data-mf-start]').click();
    await page.waitForFunction(x => window.siderarium.client.t.server.sim.st.groups[x.miners].op.k === 'mine', fixture);
    const mined = await page.evaluate(x => {
      const app = window.siderarium, sim = app.client.t.server.sim; app.view.frame = () => {};
      for (let t = 0; t < 4000 && (sim.st.stations[x.source].storage[x.p]?.dense_titanium_ore ?? 0) < 40; t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return sim.st.stations[x.source].storage[x.p]?.dense_titanium_ore ?? 0;
    }, fixture);
    check(mined >= 40, 'UI mining command produces regional ore at the selected source station');
    await page.evaluate(x => window.siderarium.hud.openStation(x.factory, 'prod'), fixture);
    await page.locator('[data-rsel="dense_alloy"]').click();
    const recipe = await page.locator('.bdet').innerText();
    check(recipe.includes('고밀도 티타늄 원광') && recipe.includes('앤빌 광구') && recipe.includes('40') && recipe.includes('부족'), 'production details show server materials, origin and shortage');
    await page.screenshot({ path: `${out}/production-shortage-1440.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.bdet .bmat').scrollIntoViewIfNeeded();
    check(await page.evaluate(() => [...document.querySelectorAll('.smodal .tabs .btn')].every(b => {
      const r = b.getBoundingClientRect(); return getComputedStyle(b).whiteSpace === 'nowrap' && r.left >= 0 && r.right <= innerWidth;
    })), 'mobile station tabs remain readable inside the viewport');
    await page.screenshot({ path: `${out}/production-shortage-390.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-pn]').fill('1');
    await page.locator('[data-porder="dense_alloy"]').click();
    await page.waitForFunction(x => window.siderarium.client.t.server.sim.st.stations[x.factory].orders.some(o => o.recipe === 'dense_alloy' && o.why.includes('부족')), fixture);
    await page.evaluate(() => window.siderarium.hud.openLogistics());
    await page.locator('[data-lg-new]').first().click();
    await page.locator('[data-lg-field="group"]').selectOption(fixture.carriers);
    await page.locator('[data-lg-field="from"]').selectOption(fixture.source);
    await page.locator('[data-lg-field="to"]').selectOption(fixture.factory);
    await page.locator('[data-lg-field="item"]').selectOption('dense_titanium_ore');
    await page.locator('[data-lg-field="name"]').fill('앤빌 원광 공급');
    await page.locator('[data-lg-field="amount"]').fill('40');
    await page.locator('[data-lg-field="repeat"]').uncheck();
    await page.screenshot({ path: `${out}/logistics-1440.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
    await page.waitForFunction(x => Object.values(window.siderarium.client.t.server.sim.st.logistics ?? {}).some(r => r.group === x.carriers), fixture);
    const delivered = await page.evaluate(x => {
      const app = window.siderarium, sim = app.client.t.server.sim;
      const route = Object.values(sim.st.logistics).find(r => r.group === x.carriers);
      for (let t = 0; t < 6000 && (sim.st.stations[x.factory].storage[x.p]?.dense_alloy ?? 0) < 12; t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return { loaded: route.stats.loaded, delivered: route.stats.delivered, alloy: sim.st.stations[x.factory].storage[x.p]?.dense_alloy ?? 0, cargo: sim.st.ships[x.carrier].cargo.dense_titanium_ore ?? 0 };
    }, fixture);
    check(delivered.loaded === 40 && delivered.delivered === 40 && delivered.alloy === 12 && delivered.cargo === 0, 'managed route physically delivers exactly one refining batch');
    await page.waitForFunction(x => window.siderarium.client.state.stations[x.factory].storage[x.p]?.dense_alloy === 12, fixture);
    await page.evaluate(x => window.siderarium.hud.openStation(x.factory, 'prod'), fixture);
    await page.locator('[data-rsel="mod_armor2"]').click();
    check((await page.locator('.bdet').innerText()).includes('고강도 특수 합금') && (await page.locator('.bdet').innerText()).includes('앤빌 광구'), 'advanced equipment shows its regional input and origin');
    await page.locator('[data-pn]').fill('1');
    await page.locator('[data-porder="mod_armor2"]').click();
    await page.waitForFunction(x => window.siderarium.client.t.server.sim.st.stations[x.factory].jobs.some(j => j.recipe === 'mod_armor2'), fixture);
    const made = await page.evaluate(x => {
      const app = window.siderarium, sim = app.client.t.server.sim;
      for (let t = 0; t < 3000 && (sim.st.stations[x.factory].storage[x.p]?.mod_armor2 ?? 0) < 1; t += .25) sim.update(.25);
      app.client.t.server.step(.6); return sim.st.stations[x.factory].storage[x.p]?.mod_armor2 ?? 0;
    }, fixture);
    check(made === 1, 'production consumes refined regional material and creates the armor module');
    await page.waitForFunction(x => window.siderarium.client.state.stations[x.factory].storage[x.p]?.mod_armor2 === 1, fixture);
    await page.evaluate(x => window.siderarium.hud.openStation(x.factory, 'market'), fixture);
    await page.locator('[data-lit]').selectOption('mod_armor2');
    check((await page.locator('[data-list-reference]').innerText()).includes('참고 가치'), 'player exchange explains the regional production reference without fixing a market price');
    await page.locator('[data-use-reference]').click();
    check(Number(await page.locator('[data-lp]').inputValue()) > 100, 'listing reference can be explicitly entered as a starting price');
    await page.evaluate(x => window.siderarium.hud.openStation(x.factory, 'dock'), fixture);
    await page.locator(`[data-openfit="${fixture.ship}"]`).click();
    await page.locator('.fitmodal [data-fsel="bay:bay1"]').click();
    await page.locator('.fitmodal [data-fpick="mod_armor2"]').click();
    await page.screenshot({ path: `${out}/fitting-1440.png`, animations: 'disabled' });
    await page.locator('.fitmodal [data-fapply]').click();
    await page.waitForFunction(x => Object.values(window.siderarium.client.t.server.sim.st.ships[x.ship].fitting.bay).includes('mod_armor2'), fixture);
    check(await page.evaluate(x => (window.siderarium.client.t.server.sim.st.stations[x.factory].storage[x.p]?.mod_armor2 ?? 0) === 0, fixture), 'fitting consumes the produced module exactly once');
    await page.evaluate(() => window.siderarium.client.t.saveNow());
    await page.goto('http://127.0.0.1:5187/?sp=continue&name=P97검증', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(x => window.siderarium?.client?.state?.ships[x.ship], fixture);
    const saved = await page.evaluate(x => { const s = window.siderarium.client.state; return { region: s.regionalV, fitted: Object.values(s.ships[x.ship].fitting.bay).includes('mod_armor2'), alloy: s.stations[x.factory].storage[x.p]?.dense_alloy, route: Object.values(s.logistics ?? {}).find(r => r.group === x.carriers)?.stats }; }, fixture);
    check(saved.region === 1 && saved.fitted && saved.alloy === 8 && saved.route?.delivered === 40, 'browser save/reload preserves the regional world, inventory, route and fitting');
    check(errors.length === 0, 'browser reports no runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, fixture, mined, delivered, saved, errors, seeded: 'capital, ordinary inputs, research, ships and facilities; NPC threats disabled' }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, errors }));
  } catch (e) {
    console.error(e); process.exitCode = 1;
    const failure = `${out}/browser-failure-${Date.now()}`;
    if (page) await page.screenshot({ path: `${failure}.png`, animations: 'disabled' }).catch(() => {});
    fs.writeFileSync(`${failure}.json`, JSON.stringify({ checks, errors, failure: String(e) }, null, 2));
  } finally {
    if (browser) await browser.close();
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already exited */ }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
