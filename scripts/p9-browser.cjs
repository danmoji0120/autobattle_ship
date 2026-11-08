// Exercises the actual single-player UI with isolated browser storage; no remote server or database.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  fs.mkdirSync('artifacts/p9', { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const results = [], errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:5173/?sp=new&name=P9', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    // Freeze the expensive 3D scene while measuring the SVG map itself in software WebGL.
    await page.evaluate(() => { window.siderarium.client.setSpeed(0); window.siderarium.view.frame = () => {}; window.siderarium.hud.toggleGalaxy(); });
    await page.addStyleTag({ content: '*,*::before,*::after { animation: none !important; transition: none !important; }' });
    await page.locator('.galsvg').waitFor();
    for (const [width, height] of [[1920,1080],[1440,900],[1024,768],[390,844]]) {
      console.log(`Checking ${width}x${height}`);
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { const hud = window.siderarium.hud; hud.galZoom = null; hud.galSel = null; hud.renderGalaxy(); });
      await page.waitForTimeout(500);
      const facts = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('.galname')].map(e => { const r = e.getBoundingClientRect(); return { name: e.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; });
        const overlaps = [];
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) { const a = texts[i], b = texts[j]; if (a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) overlaps.push([a.name, b.name]); }
        const viewport = document.querySelector('.galviewport');
        return { names: texts.length, overlaps, svgWidth: document.querySelector('.galsvg').getBoundingClientRect().width, viewportWidth: viewport.clientWidth, viewportScroll: viewport.scrollWidth, current: document.querySelector('.galinfo')?.textContent.includes('아스트라') };
      });
      if (facts.names !== 22 || facts.overlaps.length || !facts.current) throw Error(`${width}: invalid map ${JSON.stringify(facts)}`);
      await page.screenshot({ path: `artifacts/p9/map-${width}.png` });
      const before = await page.locator('.galsvg').getAttribute('width');
      await page.locator('[data-zoom="in"]').click();
      const after = await page.locator('.galsvg').getAttribute('width');
      if (+after <= +before) throw Error(`${width}: zoom did not change map size`);
      const scroll = await page.locator('.galviewport').evaluate(el => { el.scrollLeft = 120; return el.scrollLeft; });
      await page.waitForTimeout(700);
      const retained = await page.locator('.galviewport').evaluate(el => el.scrollLeft);
      if (scroll > 0 && retained !== scroll) throw Error(`${width}: map scroll reset during refresh`);
      await page.locator('[data-sys="shard"]').click();
      if (!(await page.locator('.galinfo').innerText()).includes('파편 결정대')) throw Error(`${width}: selected resource details missing`);
      await page.locator('[data-zoom="fit"]').click();
      if (width === 1440) {
        const live = await page.evaluate(() => {
          const app = window.siderarium, state = app.client.state, hud = app.hud, sys = state.systems.shard;
          const ship = Object.values(state.ships).find(s => s.owner === app.client.company), oldPos = ship.pos, oldSec = sys.security;
          try {
            sys.security = 34; ship.pos = { ...sys.origin, x: sys.origin.x + 1000 }; hud.renderGalaxy();
            const node = document.querySelector('[data-sys="shard"]');
            return node.getAttribute('aria-label').includes('34') && node.textContent.includes('함선 1');
          } finally { ship.pos = oldPos; sys.security = oldSec; hud.renderGalaxy(); }
        });
        if (!live) throw Error('map failed to refresh a changed security or fleet location');
      }
      const renderMs = width === 1440 ? await page.evaluate(() => {
        const app = window.siderarium, state = app.client.state, hud = app.hud, original = state.systems;
        const five = Object.fromEntries(['helios', 'astra', 'drake', 'ember', 'fang'].map(id => [id, original[id]]));
        const measure = (systems, force) => { state.systems = systems; hud.galSel = 'astra'; hud.renderGalaxy(); const start = performance.now(); for (let i = 0; i < 20; i++) hud.renderGalaxy(force); return (performance.now() - start) / 20; };
        try { return { fiveChanged: measure(five, true), expandedChanged: measure(original, true), expandedUnchanged: measure(original, false), iterations: 20 }; }
        finally { state.systems = original; hud.renderGalaxy(); }
      }) : undefined;
      const samples = await page.evaluate(() => new Promise(resolve => { let last = performance.now(), arr = []; const tick = t => { arr.push(t - last); last = t; if (arr.length < 12) requestAnimationFrame(tick); else resolve(arr); }; requestAnimationFrame(tick); }));
      samples.sort((a,b) => a-b);
      results.push({ width, height, ...facts, zoomBefore: +before, zoomAfter: +after, scrollRetained: retained, renderMs, frameMedianMs: samples[Math.floor(samples.length / 2)], frameP95Ms: samples[Math.floor(samples.length * .95)] });
    }
    if (errors.length) throw Error(errors.join('\n'));
  } finally {
    fs.writeFileSync('artifacts/p9/browser-results.json', JSON.stringify({ results, errors }, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify({ results, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
