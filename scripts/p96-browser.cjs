// Isolated single-player GameServer in Chromium. Only the initial ships and test funds are seeded;
// founding, purchases, route configuration, travel, save/reload and construction use game paths.
const { chromium } = require('playwright');
const fs = require('node:fs');
const out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p96'; fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:5175/?sp=new&name=P96시설', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    const fixture = await page.evaluate(() => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      app.client.setSpeed(0); sim.st.companies[p].credits = 500000;
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      sim.npcSlow = () => {};
      const sys = sim.st.systems.quiet, at = { x: sys.origin.x + 10000, y: 0, z: 0 };
      const builders = sim.newGroup(p, '변경 공작반'), freight = sim.newGroup(p, '변경 수송반'), machineryFreight = sim.newGroup(p, '기계부품 수송반');
      const builder = sim.spawnShip(p, 'constructor', 'std', builders.id, at);
      const hauler = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, freight.id, sim.st.stations.astra.pos); sim.dockShip(hauler, sim.st.stations.astra);
      const machineryHauler = sim.spawnHull(p, 'hauler_m', 'hauler_m_std', undefined, machineryFreight.id, sim.st.stations.astra.pos); sim.dockShip(machineryHauler, sim.st.stations.astra);
      app.client.t.server.step(.6);
      return { p, at, builder: builder.id, builders: builders.id, freight: freight.id, hauler: hauler.id, machineryFreight: machineryFreight.id };
    });
    await page.waitForFunction(({builders}) => !!window.siderarium.client.state.groups[builders], fixture);
    const center = await page.evaluate(({builders, at}) => {
      const app = window.siderarium; app.view.focusOn(at, 2200); for (let i = 0; i < 10; i++) app.view.rig.update(1, 1); app.view.rig.camera.updateMatrixWorld();
      app.hud.select({ kind: 'group', id: builders }); app.hud.refresh(true);
      const hit = app.view.screenToPlane(innerWidth / 2, innerHeight / 2, 0);
      return { x: innerWidth / 2, y: innerHeight / 2, plane: hit && { x: hit.x, z: hit.z }, target: { x: at.x, z: at.z }, element: document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.tagName };
    }, fixture);
    const selector = page.locator('[data-found-size]');
    check(await selector.locator('option').count() === 4, 'founding screen offers all four sizes');
    for (const size of ['S', 'M', 'L', 'XL']) {
      await selector.selectOption(size);
      check((await page.locator('.station-found-choice').innerText()).includes(size === 'XL' ? '1,200,000' : size === 'L' ? '250,000' : size === 'M' ? '60,000' : '16,000'), `${size} shows its own founding cost`);
    }
    await selector.selectOption('S');
    await page.screenshot({ path: `${out}/founding-1440.png`, animations: 'disabled' });
    await page.locator('[data-op="found"]').click();
    page.once('dialog', dialog => dialog.accept('고요 개척 기지'));
    await page.mouse.click(center.x, center.y);
    await page.waitForFunction(({builders}) => window.siderarium.client.t.server.sim.st.groups[builders]?.op.k === 'found', fixture);
    check(await page.evaluate(({p,builders}) => window.siderarium.client.t.server.sim.st.companies[p].foundingEscrow?.[builders] === 16000, fixture), 'founding through the game UI takes a refundable prepayment');
    const site = await page.evaluate(({p}) => {
      const app = window.siderarium, sim = app.client.t.server.sim; app.view.frame = () => {};
      for (let t = 0; t < 180 && !Object.values(sim.st.stations).some(s => s.owner === p); t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return Object.values(sim.st.stations).find(s => s.owner === p)?.id;
    }, fixture);
    check(!!site, 'constructor physically establishes an initially empty frontier site');
    await page.waitForFunction(id => !!window.siderarium.client.state.stations[id], site);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    check((await page.locator('.construction-supply').innerText()).includes('600') && (await page.locator('.construction-supply').innerText()).includes('부족'), 'construction panel explains the shortage before any purchase');
    await page.evaluate(() => window.siderarium.hud.openStation('astra', 'market'));
    const buyButton = page.locator('[data-trade^="buy:alloy:"]');
    const lot = Number((await buyButton.getAttribute('data-trade')).split(':')[2]);
    let purchased = 0;
    while (purchased < 600) {
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
    await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
    await page.waitForFunction(({freight}) => Object.values(window.siderarium.client.t.server.sim.st.logistics ?? {}).some(r => r.group === freight), fixture);
    const traveling = await page.evaluate(({freight, hauler}) => {
      const app = window.siderarium, sim = app.client.t.server.sim, route = Object.values(sim.st.logistics).find(r => r.group === freight);
      for (let t = 0; t < 1200; t += .25) { sim.update(.25); if (route.manifests[hauler] && sim.sysOf(sim.st.ships[hauler].pos)?.id !== 'astra') break; }
      app.client.t.server.step(.6);
      return { id: route.id, manifest: route.manifests[hauler], system: sim.sysOf(sim.st.ships[hauler].pos)?.id, source: sim.st.stations.astra.storage[app.client.company].alloy || 0 };
    }, fixture);
    check(traveling.manifest?.amount === 600 && traveling.system !== 'astra', 'actual loaded carrier passes a jump gate with a tracked manifest');
    await page.evaluate(() => window.siderarium.client.t.saveNow());
    await page.goto('http://127.0.0.1:5175/?sp=continue', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(({id, hauler}) => !!window.siderarium?.client?.state?.logistics?.[id]?.manifests?.[hauler], { id: traveling.id, hauler: fixture.hauler }, { timeout: 60000 });
    await page.evaluate(() => { window.siderarium.client.setSpeed(0); window.siderarium.view.frame = () => {}; });
    const restored = await page.evaluate(({id, hauler, site}) => {
      const app = window.siderarium, w = app.client.t.server.sim.st; app.hud.openStation(site, 'build');
      return { manifest: w.logistics[id].manifests[hauler].amount, cargo: w.ships[hauler].cargo.alloy, progress: w.stations[site].modules[0].progress };
    }, { id: traveling.id, hauler: fixture.hauler, site });
    check(restored.manifest === 600 && restored.cargo === 600 && restored.progress === 0, 'browser reload restores in-flight cargo, manifest and waiting plan');
    check((await page.locator('.construction-supply').innerText()).includes('600') && (await page.locator('.construction-supply').innerText()).includes('노선 운송 중'), 'construction screen distinguishes shipment from on-site materials');
    for (const size of [{width:1920,height:1080}, {width:1440,height:900}, {width:1024,height:768}, {width:390,height:844}]) {
      await page.setViewportSize(size);
      check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), `construction screen fits ${size.width}px`);
      if (size.width === 390) check(await page.evaluate(() => {
        const box = document.querySelector('.construction-supply-table'), r = box.getBoundingClientRect();
        return ['부족', '노선 화물'].every(name => [...box.querySelectorAll('.construction-mobile-label')].some(e => { const b = e.getBoundingClientRect(); return e.textContent === name && b.width > 0 && b.left >= r.left && b.right <= r.right; }));
      }), 'mobile shortage and shipment amounts are visible without horizontal scrolling');
    }
    await page.locator('[data-logistics-build]').click();
    check(await page.evaluate(() => { const r = document.querySelector('.lg-editor').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), 'mobile construction-supply editor fits the viewport');
    await page.locator('[data-lg-close]').click();
    const done = await page.evaluate(({site, id}) => {
      const app = window.siderarium, sim = app.client.t.server.sim; sim.npcSlow = () => {};
      for (let t = 0; t < 1800 && !sim.st.stations[site].modules[0].built; t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return { built: sim.st.stations[site].modules[0].built, route: sim.st.logistics[id].stats, held: sim.st.stations[site].storage[app.client.company].alloy || 0 };
    }, { site, id: traveling.id });
    check(done.built && done.route.loaded === 600 && done.route.delivered === 600, 'real transport delivers and the constructor completes the core once');
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    check((await page.locator('.station-facts').innerText()).includes('S급') && (await page.locator('.station-facts').innerText()).includes('시설 용량'), 'completed station displays size, capacity and operating limits');
    await page.locator('[data-bpick="refinery"]').click();
    check((await page.locator('.bdet').innerText()).includes('500') && (await page.locator('.bdet').innerText()).includes('기계부품') && (await page.locator('.bdet').innerText()).includes('부족'), 'facility details explain cost and local shortage');
    await page.locator('[data-module="refinery"]').click();
    await page.evaluate(() => window.siderarium.client.t.server.step(.6));
    check(await page.evaluate(site => window.siderarium.client.t.server.sim.st.stations[site].modules.some(m => m.kind === 'refinery' && !m.built), site), 'facility plan is registered through the UI');
    for (const size of [{width:1920,height:1080}, {width:1440,height:900}, {width:1024,height:768}, {width:390,height:844}]) {
      await page.setViewportSize(size);
      await page.screenshot({ path: `${out}/facilities-${size.width}.png`, animations: 'disabled' });
      check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), `facility management fits ${size.width}px`);
    }
    await page.locator('[data-bpick="warehouse"]').scrollIntoViewIfNeeded();
    await page.locator('[data-bpick="warehouse"]').click();
    await page.locator('.bdet').scrollIntoViewIfNeeded();
    check((await page.locator('.bdet').innerText()).includes('창고 건설'), 'mobile facility selection reaches the detail and build action');
    await page.screenshot({ path: `${out}/facility-detail-390.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => window.siderarium.hud.openStation('astra', 'market'));
    let facilityPurchase = 0;
    while (facilityPurchase < 500) {
      await page.locator('[data-trade^="buy:alloy:"]').click(); facilityPurchase += lot;
      await page.evaluate(() => window.siderarium.client.t.server.step(.6));
      await page.waitForFunction(({p, facilityPurchase}) => (window.siderarium.client.state.stations.astra.storage[p]?.alloy ?? 0) >= facilityPurchase, { p: fixture.p, facilityPurchase });
    }
    const machineryButton = page.locator('[data-trade^="buy:machinery:"]');
    const machineryLot = Number((await machineryButton.getAttribute('data-trade')).split(':')[2]);
    let machineryPurchased = 0;
    while (machineryPurchased < 10) {
      await machineryButton.click(); machineryPurchased += machineryLot;
      await page.evaluate(() => window.siderarium.client.t.server.step(.6));
      await page.waitForFunction(({p, machineryPurchased}) => (window.siderarium.client.state.stations.astra.storage[p]?.machinery ?? 0) >= machineryPurchased, { p: fixture.p, machineryPurchased });
    }
    const refinery = await page.evaluate(({site, id, machineryFreight, p}) => {
      const app = window.siderarium, sim = app.client.t.server.sim;
      const error = sim.command(p, { c: 'putRoute', group: machineryFreight, config: { name: '기계부품 건설 공급', from: 'astra', to: site, item: 'machinery', amount: 10, mode: 'construction', repeat: true } });
      if (error) throw Error(error);
      const machinery = Object.values(sim.st.logistics).find(r => r.group === machineryFreight);
      for (let t = 0; t < 2400 && !sim.st.stations[site].modules.some(m => m.kind === 'refinery' && m.built); t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return { built: sim.st.stations[site].modules.some(m => m.kind === 'refinery' && m.built), delivered: sim.st.logistics[id].stats.delivered, machineryDelivered: machinery.stats.delivered };
    }, { site, id: traveling.id, machineryFreight: fixture.machineryFreight, p: fixture.p });
    check(refinery.built && refinery.delivered >= 1100 && refinery.machineryDelivered === 10, 'physical supply and construction complete the refinery');
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    check((await page.locator('.station-installed').allInnerTexts()).some(t => t.includes('광석 정제소')), 'completed facility is visible in management');
    await page.screenshot({ path: `${out}/facilities-completed-1440.png`, animations: 'disabled' });
    const retry = await page.evaluate(async () => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company, st = sim.st.stations.astra;
      const before = { credits: sim.st.companies[p].credits, stock: st.market.alloy.stock, owned: st.storage[p].alloy || 0, price: sim.price(st, 'alloy', 'buy') };
      const order = { c: 'buy', station: 'astra', res: 'alloy', amount: 100 };
      const replies = await Promise.all([app.client.cmd(order), app.client.cmd(order)]);
      return { replies, debit: before.credits - sim.st.companies[p].credits, expected: before.price * 100, stock: before.stock - st.market.alloy.stock, owned: (st.storage[p].alloy || 0) - before.owned };
    });
    check(retry.replies.every(x => x === null) && Math.abs(retry.debit - retry.expected) < 1e-6 && retry.stock === 100 && retry.owned === 100, 'concurrent copies of one browser purchase debit and deliver only once');
    check(errors.length === 0, 'no browser runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, fixture, center, afterBuy, traveling, restored, done, refinery, retry, errors }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, errors }));
  } catch (err) {
    await page.screenshot({ path: `${out}/browser-failure.png`, animations: 'disabled' }).catch(() => {});
    throw err;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
