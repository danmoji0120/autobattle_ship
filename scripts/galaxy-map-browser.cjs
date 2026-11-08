// Real strategic UI in a disposable browser world; the 3D background is paused for map inspection.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const out = 'artifacts/p9-map-redesign'; fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const checks = [], layouts = [], errors = [];
  const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); console.log('PASS', text); };
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:5173/?sp=new&name=P9', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && Object.keys(window.siderarium.client.state?.systems ?? {}).length === 22, null, { timeout: 60000 });
    await page.evaluate(() => { window.siderarium.client.setSpeed(0); window.siderarium.view.frame = () => {}; window.siderarium.hud.toggleGalaxy(); });
    await page.addStyleTag({ content: '*,*::before,*::after { animation: none !important; transition: none !important; }' });
    const topology = await page.evaluate(() => JSON.stringify(Object.values(window.siderarium.client.t.server.sim.st.systems).map(s => [s.id, s.idx, s.map, s.origin, s.gates])));
    for (const [width, height] of [[1920,1080], [1440,900], [1024,768], [390,844], [320,640]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { const h = window.siderarium.hud; h.galZoom = null; h.galSel = null; h.galCentered = false; h.renderGalaxy(true); });
      await page.waitForTimeout(300);
      const facts = await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('.gnode')];
        const texts = nodes.flatMap(n => [...n.querySelectorAll('text')].map(e => { const r = e.getBoundingClientRect(); return { sys: n.dataset.sys, text: e.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
        const overlaps = [];
        for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i], b = texts[j];
          if (a.sys !== b.sys && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y) overlaps.push([a.sys, a.text, b.sys, b.text]);
        }
        const regionOverlaps = [];
        for (const region of document.querySelectorAll('.gal-regions text')) {
          const r = region.getBoundingClientRect();
          for (const label of texts) if (r.left < label.right && r.right > label.x && r.top < label.bottom && r.bottom > label.y) regionOverlaps.push([region.textContent, label.sys, label.text]);
        }
        const v = document.querySelector('.galviewport').getBoundingClientRect(), d = document.querySelector('.galinfo').getBoundingClientRect();
        const badHits = [];
        for (const n of nodes) for (const part of [n.querySelector('.gal-node-star'), n.querySelector('.galname')]) {
          if (!part) continue;
          const r = part.getBoundingClientRect(), x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
          if (x <= v.left || x >= v.right || y <= v.top || y >= v.bottom) continue;
          const hit = document.elementFromPoint(x, y)?.closest('[data-sys]');
          if (hit?.dataset.sys !== n.dataset.sys) badHits.push([n.dataset.sys, hit?.dataset.sys ?? null]);
        }
        const action = document.querySelector('[data-view]').getBoundingClientRect();
        return { nodes: nodes.length, names: document.querySelectorAll('.galname').length, edges: document.querySelectorAll('.gal-link').length, overlaps, regionOverlaps, badHits,
          viewport: { x: v.x, y: v.y, width: v.width, height: v.height }, panel: { x: d.x, y: d.y, width: d.width, height: d.height },
          actionsVisible: action.top >= 0 && action.bottom <= innerHeight, zoom: document.querySelector('.galcontrols span').textContent };
      });
      check(facts.nodes === 22 && facts.names === 22 && facts.edges === 28 && !facts.overlaps.length, `${width}: 22 readable systems, 28 real links, no label overlap`);
      check(!facts.regionOverlaps.length, `${width}: region labels do not obscure system information ${JSON.stringify(facts.regionOverlaps)}`);
      check(!facts.badHits.length, `${width}: visible stars and names have the correct click targets ${JSON.stringify(facts.badHits)}`);
      check(width > 900 ? facts.panel.x >= facts.viewport.x + facts.viewport.width - 1 : facts.panel.y >= facts.viewport.y + facts.viewport.height - 1, `${width}: details occupy a separate responsive panel`);
      check(facts.actionsVisible, `${width}: primary system action remains visible`);
      await page.screenshot({ path: `${out}/map-${width}.png` });
      const before = Number(await page.locator('.galsvg').getAttribute('width'));
      await page.locator('[data-zoom="in"]').click();
      const after = Number(await page.locator('.galsvg').getAttribute('width'));
      check(after > before, `${width}: zoom enlarges the chart`);
      const scroll = await page.locator('.galviewport').evaluate(el => { el.scrollLeft = 120; return el.scrollLeft; });
      await page.waitForTimeout(600);
      check(scroll === await page.locator('.galviewport').evaluate(el => el.scrollLeft), `${width}: pan position survives live refresh`);
      if (width === 1440) {
        const start = await page.locator('.galviewport').evaluate(el => { el.scrollLeft = 180; const r = el.getBoundingClientRect(); return { left: el.scrollLeft, x: r.left + 20, y: r.top + 20 }; });
        await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 70, start.y, { steps: 4 }); await page.mouse.up();
        check(await page.locator('.galviewport').evaluate(el => el.scrollLeft) < start.left - 30, 'dragging the map pans it');
        const beforeWheel = Number(await page.locator('.galsvg').getAttribute('width'));
        await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control');
        await page.waitForFunction(n => Number(document.querySelector('.galsvg')?.getAttribute('width')) > n, beforeWheel);
        check(true, 'Ctrl + wheel zooms the map');
      }
      await page.locator('[data-sys="blackgate"]').click();
      const detail = await page.locator('.galinfo').innerText();
      check(detail.includes('검은 관문') && detail.includes('5회 점프') && await page.locator('.gal-link.is-route').count() === 5, `${width}: selected destination shows its actual five-gate route`);
      if (width === 1440) { await page.locator('[data-zoom="fit"]').click(); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/selected-${width}.png` }); }
      if (width === 390) await page.screenshot({ path: `${out}/selected-${width}.png` });
      if (width === 1440) {
        await page.locator('[data-sys="shard"] .galname').click();
        check((await page.locator('.galinfo').innerText()).includes('파편 결정대') && await page.locator('.gal-link.is-route').count() === 3, 'a system name is clickable and updates the selected route');
      }
      await page.locator('[data-zoom="fit"]').click();
      const fit = await page.evaluate(() => { const v = document.querySelector('.galviewport'), s = document.querySelector('.galsvg'); return { vw: v.clientWidth, vh: v.clientHeight, sw: s.getBoundingClientRect().width, sh: s.getBoundingClientRect().height }; });
      check(fit.sw <= fit.vw + 2 && fit.sh <= fit.vh + 2, `${width}: overview fits the chart into the viewport`);
      if (width === 1440) facts.renderMs = await page.evaluate(() => {
        const hud = window.siderarium.hud;
        const measure = force => { hud.renderGalaxy(force); const start = performance.now(); for (let i = 0; i < 20; i++) hud.renderGalaxy(force); return (performance.now() - start) / 20; };
        return { changed: measure(true), unchanged: measure(false), iterations: 20 };
      });
      if (width === 390) {
        check(await page.locator('.galname').count() === 0 && await page.locator('.gal-regions text').count() === 4 && (await page.locator('.gal-touch-help').innerText()).includes('확대'), 'mobile overview uses readable region labels and explains how to reveal system names');
        await page.waitForTimeout(500); await page.screenshot({ path: `${out}/overview-390.png` });
        await page.locator('[data-sys="shard"] .gal-node-hit').click();
        check((await page.locator('.galinfo').innerText()).includes('파편 항로') && await page.locator('.gal-link.is-route').count() === 3, 'mobile overview can select a system and reveal its route');
      }
      layouts.push({ width, height, ...facts, zoomBefore: before, zoomAfter: after, fit });
    }

    // Inspect invalidation and keyboard navigation against the live HUD, without modifying the authority.
    await page.setViewportSize({ width: 1440, height: 900 });
    const legacy = await page.evaluate(() => {
      const app = window.siderarium, state = app.client.state, h = app.hud, original = state.systems, layout = state.worldLayout;
      try {
        state.systems = Object.fromEntries(['helios', 'astra', 'drake', 'ember', 'fang'].map(id => [id, original[id]])); delete state.worldLayout;
        h.galSel = 'astra'; h.renderGalaxy(true);
        return { count: document.querySelectorAll('.gnode').length, regions: document.querySelectorAll('.gal-regions').length };
      } finally { state.systems = original; state.worldLayout = layout; h.renderGalaxy(true); }
    });
    check(legacy.count === 5 && legacy.regions === 0, 'legacy five-system saves use their own positions and no P9 region labels');
    const disconnected = await page.evaluate(() => {
      const app = window.siderarium, state = app.client.state, hud = app.hud;
      const a = state.systems.junction.gates, b = state.systems.shard.gates;
      try {
        state.systems.junction.gates = a.filter(g => g.to !== 'shard'); state.systems.shard.gates = b.filter(g => g.to !== 'junction');
        hud.galZoom = null; hud.galSel = 'blackgate'; hud.renderGalaxy(true);
        return !document.querySelector('.gal-link.is-route') && document.querySelector('[data-goto]')?.disabled && document.querySelector('.galinfo').textContent.includes('연결 없음');
      } finally { state.systems.junction.gates = a; state.systems.shard.gates = b; hud.renderGalaxy(true); }
    });
    check(disconnected, 'a disconnected gate route is not highlighted or offered as a valid move');
    await page.evaluate(() => { const h = window.siderarium.hud; h.galZoom = null; h.galSel = 'shard'; h.renderGalaxy(true); });
    const live = await page.evaluate(() => {
      const app = window.siderarium, state = app.client.state, hud = app.hud, sys = state.systems.shard;
      const ship = Object.values(state.ships).find(s => s.owner === app.client.company), oldPos = ship.pos, oldSec = sys.security;
      try {
        sys.security = 34; ship.pos = { ...sys.origin, x: sys.origin.x + 1000 }; hud.renderGalaxy();
        const node = document.querySelector('[data-sys="shard"]');
        return node.getAttribute('aria-label').includes('34') && node.textContent.includes('함선 1');
      } finally { ship.pos = oldPos; sys.security = oldSec; hud.renderGalaxy(); }
    });
    check(live, 'security and fleet indicators update from live state');
    await page.locator('[data-sys="astra"]').focus();
    const speed = await page.evaluate(() => window.siderarium.client.speed);
    await page.keyboard.press('Space');
    check(await page.evaluate(() => window.siderarium.client.speed) === speed, 'keyboard system selection does not change simulation speed');
    await page.evaluate(() => {
      const rig = window.siderarium.view.rig;
      window.originalMapTestPan = rig.pan; window.mapTestPanCalls = 0;
      rig.pan = function (...args) { window.mapTestPanCalls++; return window.originalMapTestPan.apply(this, args); };
    });
    await page.keyboard.down('w');
    await page.evaluate(() => window.siderarium.hud.frame(.1));
    await page.keyboard.up('w');
    check(await page.evaluate(() => window.mapTestPanCalls) === 0, 'keyboard input in the map does not pan the game camera');
    await page.keyboard.press('Tab');
    check(await page.locator('.galaxy').count() === 1 && await page.evaluate(() => document.querySelector('.galaxy').contains(document.activeElement)), 'Tab navigates controls inside the map');
    await page.keyboard.press('Escape');
    check(await page.locator('.galaxy').count() === 0, 'Escape closes the map');
    await page.keyboard.down('w');
    await page.evaluate(() => window.siderarium.hud.frame(.1));
    await page.keyboard.up('w');
    check(await page.evaluate(() => window.mapTestPanCalls) > 0, 'camera keyboard controls work again after closing the map');
    await page.evaluate(() => { window.siderarium.view.rig.pan = window.originalMapTestPan; delete window.originalMapTestPan; delete window.mapTestPanCalls; });

    await page.evaluate(() => { const h = window.siderarium.hud; h.galSel = 'astra'; h.galZoom = null; h.toggleGalaxy(); });
    await page.locator('[data-gal-station="astra"]').click();
    check(await page.evaluate(() => window.siderarium.hud.modalStation === 'astra'), 'station detail opens its actual station screen');
    await page.evaluate(() => { const h = window.siderarium.hud; h.closeModal(); h.galSel = 'shard'; h.toggleGalaxy(); });
    await page.locator('[data-gal-field="p9_shard_crystal"]').click();
    check(await page.evaluate(() => window.siderarium.view.sys?.id === 'shard' && window.siderarium.hud.sel?.id === 'p9_shard_crystal'), 'resource detail focuses and selects the actual field');
    await page.evaluate(() => { const app = window.siderarium; app.view.setSystem('astra'); app.hud.galSel = 'blackgate'; app.hud.toggleGalaxy(); });
    const group = await page.evaluate(() => window.siderarium.hud.group);
    await page.locator('[data-goto="blackgate"]').click();
    await page.waitForFunction(id => window.siderarium.client.t.server.sim.st.groups[id]?.op?.k === 'move', group);
    check(await page.evaluate(id => { const sim = window.siderarium.client.t.server.sim, op = sim.st.groups[id].op; return sim.sysOf(op.to)?.id === 'blackgate'; }, group), 'the map issues a real move command to the selected system');
    const afterTopology = await page.evaluate(() => JSON.stringify(Object.values(window.siderarium.client.t.server.sim.st.systems).map(s => [s.id, s.idx, s.map, s.origin, s.gates])));
    check(afterTopology === topology, 'opening and operating the chart does not alter saved systems or gates');
    check(errors.length === 0, 'no browser runtime errors');
  } catch (e) {
    errors.push(String(e)); if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {}); throw e;
  } finally {
    fs.writeFileSync(`${out}/browser-results.json`, JSON.stringify({ checks, layouts, errors }, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify({ passed: checks.length, errors }, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
