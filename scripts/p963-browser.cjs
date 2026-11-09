// Isolated single-player station; funding, station and local inventory are test fixtures.
const { chromium } = require('playwright');
const fs = require('node:fs');
const out = process.env.SIDERARIUM_ARTIFACT_DIR || 'artifacts/p963'; fs.mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (ok, label) => { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(String(e)));
  try {
    await page.goto('http://127.0.0.1:5178/?sp=new&name=P963시설경제', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    const fixture = await page.evaluate(() => {
      const app = window.siderarium, sim = app.client.t.server.sim, p = app.client.company;
      app.client.setSpeed(0); app.view.frame = () => {}; sim.npcSlow = () => {}; sim.st.companies[p].credits = 3_000_000;
      for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
      const base = sim.st.stations.astra, station = { ...structuredClone(base), id: 'p963_ui', name: '시설 비용 검증 기지', desc: '격리 시험용 소형 정거장', owner: p, public: false, size: 'S', market: null,
        services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false }, storage: { [p]: { alloy: 100, machinery: 3 } },
        modules: [{ kind: 'core', slot: 0, progress: 1, built: true }] };
      sim.st.stations[station.id] = station; app.client.t.server.step(.6);
      return { p, station: station.id };
    });
    await page.waitForFunction(({station}) => !!window.siderarium.client.state.stations[station], fixture);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'build'), fixture.station);
    const refinery = page.locator('[data-bpick="refinery"]');
    check(await refinery.count() === 1, 'refinery appears in the facility catalog');
    await refinery.scrollIntoViewIfNeeded(); await refinery.click();
    const refineryText = await page.locator('.bdet').innerText();
    check(['20,000', '500', '10', '400 부족', '7 부족', '최소 소형(S)급', '전력 소모 15'].every(v => refineryText.includes(v)), 'refinery price, materials, shortage, size and power match server data');
    check(await page.locator('[data-module="refinery"]').isEnabled(), 'a shortage leaves registration available');
    const medium = page.locator('[data-bpick="yard_m"]');
    check(await medium.count() === 1, 'ineligible medium yard remains visible');
    await medium.scrollIntoViewIfNeeded(); await medium.click();
    const yard = await page.locator('.bdet').innerText();
    check(['250,000', '5,500', '350', '150', '60', '중형(M)급 이상 필요', '중형 선체', '소형 조선소'].every(v => yard.includes(v)), 'medium yard shows all cost and blocking requirements');
    check(await page.locator('[data-module="yard_m"]').isDisabled(), 'server-ineligible yard action is disabled');
    check(await page.evaluate(() => { const r = document.querySelector('.bdet').getBoundingClientRect(), b = document.querySelector('.sbody2').getBoundingClientRect(); return r.top >= b.top - 2 && r.top < b.bottom && r.bottom > b.top; }), 'desktop detail stays visible after selecting a lower catalog entry');
    await page.mouse.move(6, 6); await page.screenshot({ path: `${out}/facility-1440.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    const comms = page.locator('[data-bpick="comms"]'); await comms.scrollIntoViewIfNeeded(); await comms.click();
    check((await page.locator('.bdet').innerText()).includes('35,000') && (await page.locator('.bdet').innerText()).includes('중형(M)급 이상 필요'), 'mobile details show the M-only communications facility and price');
    check(await page.evaluate(() => { const r = document.querySelector('.bdet').getBoundingClientRect(), b = document.querySelector('.sbody2').getBoundingClientRect(); return r.top >= b.top - 2 && r.top < b.bottom; }), 'mobile selection scrolls its details into view');
    check(await page.evaluate(() => { const r = document.querySelector('.sbox').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), 'mobile station screen fits the viewport');
    await page.screenshot({ path: `${out}/facility-390.png`, animations: 'disabled' });
    check(errors.length === 0, 'browser emitted no runtime errors');
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, errors, fixture }, null, 2) + '\n');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
