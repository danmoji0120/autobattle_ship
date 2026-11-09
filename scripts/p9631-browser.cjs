// Isolated single-player browser world. Credits, facilities, blueprints and raw inputs are fixtures.
const { chromium } = require('playwright');
const fs = require('node:fs');
const out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p9631'; fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:5179/?sp=new&name=P9631안전', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    const fixture = await page.evaluate(async () => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      const { TECHS, FACILITIES } = await import('/src/world/industry.ts');
      app.client.setSpeed(0); app.view.frame = () => {}; sim.npcSlow = () => {};
      sim.st.companies[p].credits = 30_000_000; sim.st.companies[p].tech = Object.keys(TECHS).filter(t => t !== 'dreadnought_program');
      sim.st.companies[p].blueprints.bp_battleship_mk1 = { src: 'fixture', t: 0 };
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      const base = sim.st.stations.astra;
      const make = (id, size, modules) => ({ ...structuredClone(base), id, name: id === 'p9631_l' ? '대형 조선소 검증' : '초과 보관 검증', owner: p, public: false, size, market: null,
        services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false }, storage: { [p]: {} },
        modules: modules.map((kind, slot) => ({ kind, slot, progress: 1, built: true })) });
      const yard = make('p9631_l', 'L', ['core', 'yard_l', 'power', 'power', 'hull_works', 'machine_shop', 'armor_plant', 'electronics_fab', 'hangar']);
      const overflow = make('p9631_xl', 'XL', ['core', 'yard_l', 'power', 'power']);
      sim.st.stations[yard.id] = yard; sim.st.stations[overflow.id] = overflow;
      overflow.storage[p].alloy = 70000;
      let error = sim.command(p, { c: 'queueModule', station: overflow.id, kind: 'yard_xl' }); if (error) throw Error(error);
      Object.assign(overflow.storage[p], { ...FACILITIES.yard_xl.mats, alloy: 0 }); sim.tick(0);
      const plan = overflow.modules.find(m => m.kind === 'yard_xl');
      error = sim.command(p, { c: 'planOp', station: overflow.id, plan: plan.id, op: 'cancel' }); if (error) throw Error(error);
      app.client.t.server.step(.6); return { p, yard: yard.id, overflow: overflow.id };
    });
    await page.waitForFunction(({ yard, overflow }) => !!window.siderarium.client.state.stations[yard] && !!window.siderarium.client.state.stations[overflow], fixture);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'yard'), fixture.yard);
    const battleship = page.locator('[data-ghull="battleship_mk1"]');
    await battleship.scrollIntoViewIfNeeded(); await battleship.click();
    check((await page.locator('.bdet').last().innerText()).includes('초대형 이상 조선소 필요'), 'battleship catalog explains the required XL yard');
    check(await page.locator('[data-gbuild="battleship_mk1"]').isDisabled(), 'battleship registration is disabled at an L yard');
    const error = await page.evaluate(async ({ yard }) => window.siderarium.client.cmd({ c: 'buildShip', station: yard, classId: 'battleship', loadoutId: 'std', hull: 'battleship_mk1' }), fixture);
    check(typeof error === 'string' && error.includes('초대형 이상 조선소'), 'the real server command returns the matching yard error');
    await page.mouse.move(6, 6); await page.screenshot({ path: `${out}/yard-1440.png`, animations: 'disabled' });
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), fixture.overflow);
    const xlYard = page.locator('[data-bpick="yard_xl"]');
    await xlYard.scrollIntoViewIfNeeded(); await xlYard.click();
    const facilityDetail = await page.locator('.bdet').last().innerText();
    check(facilityDetail.includes('연구: 대형 선체 (완료)'), 'XL yard detail shows its growth-world research requirement');
    check(!facilityDetail.includes('연구 필요: 드레드노트'), 'XL yard does not demand dreadnought research');
    await page.screenshot({ path: `${out}/facility-1440.png`, animations: 'disabled' });
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'store'), fixture.overflow);
    const text = await page.locator('.sbody2').innerText();
    check(text.includes('81,850') && text.includes('80,000') && text.includes('초과 보관 1,850') && text.includes('신규 입고 불가'), 'overflow screen states exact inventory, capacity and blocked intake');
    await page.screenshot({ path: `${out}/overflow-1440.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    check((await page.locator('.sbody2').innerText()).includes('초과 보관 1,850'), 'mobile storage screen shows the overflow warning');
    check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), 'mobile station panel fits the viewport');
    await page.screenshot({ path: `${out}/overflow-390.png`, animations: 'disabled' });
    check(errors.length === 0, 'browser emitted no runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, errors, fixture, error }, null, 2) + '\n');
  } catch (err) {
    await page.screenshot({ path: `${out}/browser-failure.png`, animations: 'disabled' }).catch(() => {}); throw err;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
