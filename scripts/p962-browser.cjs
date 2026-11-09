// Isolated single-player UI check. The starting credits and a partial delivery are fixture data;
// size selection, foundation, server-side reservation and the displayed shortage use game paths.
const { chromium } = require('playwright');
const fs = require('node:fs');
const out = 'artifacts/p962'; fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:5177/?sp=new&name=P962비용검증', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    const f = await page.evaluate(() => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      app.client.setSpeed(0); sim.npcSlow = () => {}; sim.st.companies[p].credits = 5_000_000;
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      const sys = sim.st.systems.quiet, at = { x: sys.origin.x + 10000, y: 0, z: 0 };
      const group = sim.newGroup(p, '비용 검증 공작반');
      sim.spawnShip(p, 'constructor', 'std', group.id, at);
      app.client.t.server.step(.6);
      return { p, at, group: group.id };
    });
    await page.waitForFunction(({group}) => !!window.siderarium.client.state.groups[group], f);
    const center = await page.evaluate(({group, at}) => {
      const app = window.siderarium; app.view.focusOn(at, 2200);
      for (let i = 0; i < 10; i++) app.view.rig.update(1, 1);
      app.view.rig.camera.updateMatrixWorld(); app.hud.select({ kind: 'group', id: group }); app.hud.refresh(true);
      return { x: innerWidth / 2, y: innerHeight / 2 };
    }, f);
    const selector = page.locator('[data-found-size]');
    const expected = {
      S: ['16,000', '합금 600'],
      M: ['60,000', '합금 1,800', '구조재 60'],
      L: ['250,000', '합금 7,000', '구조재 400', '기계부품 150'],
      XL: ['1,200,000', '합금 30,000', '구조재 2,000', '기계부품 800', '전자부품 300'],
    };
    for (const [size, values] of Object.entries(expected)) {
      await selector.selectOption(size);
      const text = await page.locator('.station-found-choice').innerText();
      check(values.every(v => text.includes(v)), `${size}: founding price and all materials are displayed`);
    }
    await page.mouse.move(6, 6);
    await page.screenshot({ path: `${out}/xl-founding-1440.png`, animations: 'disabled' });
    await page.locator('[data-op="found"]').click();
    page.once('dialog', dialog => dialog.accept('XL 비용 검증 현장'));
    await page.mouse.click(center.x, center.y);
    await page.waitForFunction(({group}) => window.siderarium.client.t.server.sim.st.groups[group]?.op.k === 'found', f);
    const order = await page.evaluate(({p, group}) => {
      const sim = window.siderarium.client.t.server.sim;
      return { paid: sim.st.companies[p].foundingEscrow?.[group], credits: sim.st.companies[p].credits, op: sim.st.groups[group].op };
    }, f);
    check(order.paid === 1_200_000 && order.credits === 3_800_000 && order.op.size === 'XL', 'UI founding command pre-pays the XL fee once');
    const site = await page.evaluate(({p}) => {
      const app = window.siderarium, sim = app.client.t.server.sim; app.view.frame = () => {};
      for (let t = 0; t < 180 && !Object.values(sim.st.stations).some(s => s.owner === p); t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return Object.values(sim.st.stations).find(s => s.owner === p)?.id;
    }, f);
    check(!!site, 'constructor establishes the site');
    await page.waitForFunction(id => !!window.siderarium.client.state.stations[id], site);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    const row = async name => page.locator('.construction-supply-table tr').filter({ hasText: name }).locator('td').allInnerTexts();
    for (const [name, amount] of [['합금', '30,000'], ['구조재', '2,000'], ['기계부품', '800'], ['전자부품', '300']]) {
      const cells = await row(name);
      check(cells[1]?.trim() === amount && cells[5]?.trim() === amount, `${name}: required and missing values match the XL plan`);
    }
    await page.mouse.move(6, 6);
    await page.screenshot({ path: `${out}/xl-shortage-1440.png`, animations: 'disabled' });
    const partial = await page.evaluate(({p, at, site}) => {
      const app = window.siderarium, sim = app.client.t.server.sim, g = sim.newGroup(p, '합금 반입');
      const ship = sim.spawnHull(p, 'hauler_l', 'hauler_l_std', undefined, g.id, { ...at, x: at.x + 500 });
      ship.cargo.alloy = 3000;
      const error = sim.command(p, { c: 'setOp', group: g.id, op: { k: 'build', station: site } }); if (error) throw Error(error);
      const st = sim.st.stations[site];
      for (let t = 0; t < 120 && (st.modules[0].reserved?.alloy ?? 0) < 3000; t += .25) sim.update(.25);
      app.client.t.server.step(.6);
      return { reserved: st.modules[0].reserved?.alloy, progress: st.modules[0].progress, cargo: ship.cargo.alloy };
    }, { ...f, site });
    check(partial.reserved === 3000 && partial.progress === 0 && !partial.cargo, 'physical partial delivery is reserved and construction waits');
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), site);
    const alloy = await row('합금');
    check(alloy[1]?.trim() === '30,000' && alloy[3]?.trim() === '3,000' && alloy[5]?.trim() === '27,000', 'UI shows the remaining shortage after delivery');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${out}/xl-shortage-390.png`, animations: 'disabled' });
    check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), 'mobile construction panel fits the viewport');
    check(errors.length === 0, 'browser emitted no runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, order, partial, errors }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
