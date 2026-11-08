// Isolated single-player GameServer in Chromium. Only the initial ships and test funds are seeded;
// founding, purchases, route configuration, travel, save/reload and construction use game paths.
const { chromium } = require('playwright');
const fs = require('node:fs');
const out = 'artifacts/p95'; fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:5174/?sp=new&name=P95개척', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    const fixture = await page.evaluate(() => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      app.client.setSpeed(0); sim.st.companies[p].credits = 500000;
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      sim.npcSlow = () => {};
      const sys = sim.st.systems.quiet, at = { x: sys.origin.x + 10000, y: 0, z: 0 };
      const builders = sim.newGroup(p, '변경 공작반'), freight = sim.newGroup(p, '변경 수송반');
      const builder = sim.spawnShip(p, 'constructor', 'std', builders.id, at);
      const hauler = sim.spawnShip(p, 'hauler', 'std', freight.id, sim.st.stations.astra.pos); sim.dockShip(hauler, sim.st.stations.astra);
      app.client.t.server.step(.6);
      return { p, at, builder: builder.id, builders: builders.id, freight: freight.id, hauler: hauler.id };
    });
    await page.waitForFunction(({builders}) => !!window.siderarium.client.state.groups[builders], fixture);
    const center = await page.evaluate(({builders, at}) => {
      const app = window.siderarium; app.view.focusOn(at, 2200); for (let i = 0; i < 10; i++) app.view.rig.update(1, 1); app.view.rig.camera.updateMatrixWorld();
      app.hud.select({ kind: 'group', id: builders }); app.hud.refresh(true);
      const hit = app.view.screenToPlane(innerWidth / 2, innerHeight / 2, 0);
      return { x: innerWidth / 2, y: innerHeight / 2, plane: hit && { x: hit.x, z: hit.z }, target: { x: at.x, z: at.z }, element: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName };
    }, fixture);
    await page.locator('[data-op="found"]').click();
    page.once('dialog', dialog => dialog.accept('고요 개척 기지'));
    await page.mouse.click(center.x, center.y);
    await page.waitForFunction(({builders}) => window.siderarium.client.t.server.sim.st.groups[builders]?.op.k === 'found', fixture);
    check(await page.evaluate(({p,builders}) => window.siderarium.client.t.server.sim.st.companies[p].foundingEscrow?.[builders] === 8000, fixture), 'founding through the game UI takes a refundable prepayment');
    const site = await page.evaluate(({p}) => {
      const app = window.siderarium, sim = app.client.t.server.sim; app.view.frame = () => {};
      for (let t = 0; t < 180 && !Object.values(sim.st.stations).some(s => s.owner === p); t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return Object.values(sim.st.stations).find(s => s.owner === p)?.id;
    }, fixture);
    check(!!site, 'constructor physically establishes an initially empty frontier site');
    await page.waitForFunction(id => !!window.siderarium.client.state.stations[id], site);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    check((await page.locator('.construction-supply').innerText()).includes('300') && (await page.locator('.construction-supply').innerText()).includes('부족'), 'construction panel explains the shortage before any purchase');
    await page.screenshot({ path: `${out}/construction-waiting-1440.png`, animations: 'disabled' });
    await page.evaluate(() => window.siderarium.hud.openStation('astra', 'market'));
    const buyButton = page.locator('[data-trade^="buy:alloy:"]');
    const lot = Number((await buyButton.getAttribute('data-trade')).split(':')[2]);
    let purchased = 0;
    while (purchased < 300) {
      await buyButton.click(); purchased += lot;
      await page.evaluate(() => window.siderarium.client.t.server.step(.6));
      await page.waitForFunction(({p, purchased}) => (window.siderarium.client.state.stations.astra.storage[p]?.alloy ?? 0) >= purchased, { p: fixture.p, purchased });
    }
    const afterBuy = await page.evaluate(({p, site}) => {
      const sim = window.siderarium.client.t.server.sim;
      return { source: sim.st.stations.astra.storage[p].alloy, destination: sim.st.stations[site].storage[p].alloy || 0, progress: sim.st.stations[site].modules[0].progress };
    }, { p: fixture.p, site });
    check(afterBuy.source === purchased && afterBuy.destination === 0 && afterBuy.progress === 0, 'market purchase stays at the source until physically shipped');
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    await page.locator('[data-logistics-build]').click();
    check(await page.locator('[data-lg-field="to"]').inputValue() === site && await page.locator('[data-lg-mode="construction"]').getAttribute('aria-pressed') === 'true', 'construction panel opens a destination-prefilled supply editor');
    await page.locator('[data-lg-field="group"]').selectOption(fixture.freight);
    await page.locator('[data-lg-field="from"]').selectOption('astra');
    await page.screenshot({ path: `${out}/supply-editor-1440.png`, animations: 'disabled' });
    await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
    await page.waitForFunction(({freight}) => Object.values(window.siderarium.client.t.server.sim.st.logistics ?? {}).some(r => r.group === freight), fixture);
    const traveling = await page.evaluate(({freight, hauler}) => {
      const app = window.siderarium, sim = app.client.t.server.sim, route = Object.values(sim.st.logistics).find(r => r.group === freight);
      for (let t = 0; t < 1200; t += .25) { sim.update(.25); if (route.manifests[hauler] && sim.sysOf(sim.st.ships[hauler].pos)?.id !== 'astra') break; }
      app.client.t.server.step(.6);
      return { id: route.id, manifest: route.manifests[hauler], system: sim.sysOf(sim.st.ships[hauler].pos)?.id, source: sim.st.stations.astra.storage[app.client.company].alloy || 0 };
    }, fixture);
    check(traveling.manifest?.amount === 300 && traveling.system !== 'astra', 'actual loaded carrier passes a jump gate with a tracked manifest');
    await page.evaluate(() => window.siderarium.client.t.saveNow());
    await page.goto('http://127.0.0.1:5174/?sp=continue', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(({id, hauler}) => !!window.siderarium?.client?.state?.logistics?.[id]?.manifests?.[hauler], { id: traveling.id, hauler: fixture.hauler }, { timeout: 60000 });
    await page.evaluate(() => { window.siderarium.client.setSpeed(0); window.siderarium.view.frame = () => {}; });
    const restored = await page.evaluate(({id, hauler, site}) => {
      const app = window.siderarium, w = app.client.t.server.sim.st; app.hud.openStation(site, 'build');
      return { manifest: w.logistics[id].manifests[hauler].amount, cargo: w.ships[hauler].cargo.alloy, progress: w.stations[site].modules[0].progress };
    }, { id: traveling.id, hauler: fixture.hauler, site });
    check(restored.manifest === 300 && restored.cargo === 300 && restored.progress === 0, 'browser reload restores in-flight cargo, manifest and waiting plan');
    check((await page.locator('.construction-supply').innerText()).includes('300') && (await page.locator('.construction-supply').innerText()).includes('노선 운송 중'), 'construction screen distinguishes shipment from on-site materials');
    for (const size of [{width:1920,height:1080}, {width:1440,height:900}, {width:1024,height:768}, {width:390,height:844}]) {
      await page.setViewportSize(size); await page.screenshot({ path: `${out}/construction-${size.width}.png`, animations: 'disabled' });
      check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), `construction screen fits ${size.width}px`);
      if (size.width === 390) check(await page.evaluate(() => {
        const box = document.querySelector('.construction-supply-table'), r = box.getBoundingClientRect();
        return ['부족', '노선 화물'].every(name => [...box.querySelectorAll('.construction-mobile-label')].some(e => { const b = e.getBoundingClientRect(); return e.textContent === name && b.width > 0 && b.left >= r.left && b.right <= r.right; }));
      }), 'mobile shortage and shipment amounts are visible without horizontal scrolling');
    }
    await page.locator('[data-logistics-build]').click();
    await page.screenshot({ path: `${out}/supply-editor-390.png`, animations: 'disabled' });
    check(await page.evaluate(() => { const r = document.querySelector('.lg-editor').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), 'mobile construction-supply editor fits the viewport');
    await page.locator('[data-lg-close]').click();
    const done = await page.evaluate(({site, id}) => {
      const app = window.siderarium, sim = app.client.t.server.sim; sim.npcSlow = () => {};
      for (let t = 0; t < 1800 && !sim.st.stations[site].modules[0].built; t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return { built: sim.st.stations[site].modules[0].built, route: sim.st.logistics[id].stats, held: sim.st.stations[site].storage[app.client.company].alloy || 0 };
    }, { site, id: traveling.id });
    check(done.built && done.route.loaded === 300 && done.route.delivered === 300, 'real transport delivers and the constructor completes the core once');
    const retry = await page.evaluate(async () => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company, st = sim.st.stations.astra;
      const before = { credits: sim.st.companies[p].credits, stock: st.market.alloy.stock, owned: st.storage[p].alloy || 0, price: sim.price(st, 'alloy', 'buy') };
      const order = { c: 'buy', station: 'astra', res: 'alloy', amount: 100 };
      const replies = await Promise.all([app.client.cmd(order), app.client.cmd(order)]);
      return { replies, debit: before.credits - sim.st.companies[p].credits, expected: before.price * 100, stock: before.stock - st.market.alloy.stock, owned: (st.storage[p].alloy || 0) - before.owned };
    });
    check(retry.replies.every(x => x === null) && Math.abs(retry.debit - retry.expected) < 1e-6 && retry.stock === 100 && retry.owned === 100, 'concurrent copies of one browser purchase debit and deliver only once');
    check(errors.length === 0, 'no browser runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, fixture, center, afterBuy, traveling, restored, done, retry, errors }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, errors }));
  } catch (err) {
    await page.screenshot({ path: `${out}/browser-failure.png`, animations: 'disabled' }).catch(() => {});
    throw err;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
