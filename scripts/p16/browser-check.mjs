// P16.4.1 browser smoke + render-cost probe for CI and local runs (headless Chromium / SwiftShader).
// Restores the intent of the parallel branch's script (backup/p164-parallel-2ff8916) against the current client:
//  1. skirmish: the carrier is hidden until the "rules 3 trial" toggle, then flies under rules 3; the craft
//     renderer (render/craftView.ts) draws exactly the airborne craft; rendering never changes the digest
//  2. mobile (390×844): carrier fitting row and battle HUD wing line fit the screen (no horizontal overflow)
//  3. 200 / 400 / 800 craft: carriers close to gun-only targets (no point defence, so the craft stay up) —
//     reports the target, the pool capacity and the ACTUAL airborne count, and fails if fewer than 90 % fly
// Needs a dev server: npm run dev -- --host 127.0.0.1 (BASE overrides http://127.0.0.1:5173).
// Does not touch the multiplayer server or the authenticated combat lab (scripts/p16/p164-browser.cjs covers that).
//   node scripts/p16/browser-check.mjs [outDir=playtest-out/p16]
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const base = process.env.BASE ?? 'http://127.0.0.1:5173';
const out = process.argv[2] ?? 'playtest-out/p16';
const ONLY = process.env.P16_ONLY ?? 'skirmish,mobile,perf';
await fs.mkdir(out, { recursive: true });
const errors = [], results = [], metrics = [];
const check = (ok, label, extra) => { results.push({ ok: !!ok, label, extra }); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 600) : ''}`); };
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const watch = page => {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
};
/** fresh setup screen with the rules-3 trial off, then the trial on, the fleet emptied and a carrier fleet added */
async function carrierFleet(page, escorts) {
  await page.goto(base + '/?skirmish');
  await page.evaluate(() => { try { localStorage.removeItem('fleetcmd.rules3.v1'); } catch { /* */ } });
  await page.reload();
  await page.waitForSelector('#setup');
  const hidden = await page.locator('[data-cat="carrier"]').count() === 0;
  await page.click('#r3');
  await page.waitForSelector('[data-cat="carrier"]');
  for (let i = 0; i < 60 && await page.locator('[data-sdel]').count(); i++) await page.locator('[data-sdel]').first().click();
  await page.click('[data-cat="carrier"]'); await page.click('[data-cat="carrier"] [data-add]');
  for (const cls of escorts) {
    await page.click(`[data-cat="${cls}"]`); await page.click(`[data-cat="${cls}"] [data-add]`);
    if (await page.locator('.budget.over').count()) { await page.locator('[data-sdel]').last().click(); break; }
  }
  return hidden;
}
/** horizontal overflow of the page and of the given elements (px beyond the viewport) */
const overflow = (page, sel) => page.evaluate(sel => {
  const vw = document.documentElement.clientWidth;
  const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length);
  return { vw, page: Math.max(0, document.documentElement.scrollWidth - vw),
    els: els.map(e => { const r = e.getBoundingClientRect(); return { sel: e.id || e.className, left: Math.round(r.left), right: Math.round(r.right), over: Math.max(0, Math.round(r.right - vw), Math.round(-r.left)), clipped: e.scrollWidth > e.clientWidth + 1 }; }) };
}, sel);

try {
  if (ONLY.includes('skirmish')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000); watch(page);
    const hidden = await carrierFleet(page, ['cruiser', 'destroyer', 'destroyer']);
    check(hidden, 'skirmish: carrier hidden until the rules-3 trial');
    check(await page.locator('.srow.cv').count() === 1, 'skirmish: carrier row in the fleet');
    await page.click('#go');
    await page.waitForFunction(() => !!window.fleetcmd.session);
    const smoke = await page.evaluate(() => {
      const s = window.fleetcmd.session; s.stop();                 // drive the frames by hand from here
      s.fastForward(12);
      const w = s.world, v = s.view;
      v.frame(1, w.dt, w.dt, true);
      const before = w.digest();
      v.frame(1, w.dt, w.dt, true);
      let air = 0; for (let i = 0; i < (w.craft?.st.length ?? 0); i++) if (w.craft.st[i] === 2) air++;
      const inst = v.craftView.group.children.filter(x => x.isInstancedMesh).length;
      return { rules: w.rules, pool: !!w.craft, airborne: air, drawn: v.craftView.drawn, instanced: inst, digestStable: before === w.digest() };
    });
    check(smoke.rules === 3 && smoke.pool, 'skirmish: carrier battle runs under rules 3', smoke);
    check(smoke.instanced === 4 && smoke.drawn === smoke.airborne && smoke.airborne > 0, 'renderer: instanced role batches draw exactly the airborne craft', smoke);
    check(smoke.digestStable, 'renderer: drawing does not change the battle digest');
    await page.screenshot({ path: out + '/skirmish-carrier.png' });
    await page.close();
  }

  if (ONLY.includes('mobile')) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage(); page.setDefaultTimeout(30000); watch(page);
    await carrierFleet(page, ['battleship', 'cruiser', 'destroyer', 'destroyer']);
    await page.locator('.srow.cv').scrollIntoViewIfNeeded();
    const setup = await overflow(page, '#setup, .srow.cv, .srow.cv select, .sfoot, .sfoot .r3, #go');
    metrics.push({ mobileSetup: setup });
    check(setup.page === 0 && setup.els.every(e => e.over === 0), 'mobile: carrier fitting row and footer fit 390 px', setup);
    await page.screenshot({ path: out + '/mobile-setup-carrier.png' });
    await page.click('#go');
    await page.waitForFunction(() => { const e = document.getElementById('gwing'); return e && /관제/.test(e.textContent ?? ''); }, null, { timeout: 60000 }).catch(() => null);
    const hud = await overflow(page, '#gwing, #gstat');
    const wing = await page.evaluate(() => document.getElementById('gwing')?.innerText.replace(/\s+/g, ' ') ?? '');
    metrics.push({ mobileHud: hud, wing });
    check(/관제/.test(wing), 'mobile: HUD wing line shown', wing);
    check(hud.page === 0 && hud.els.every(e => e.over === 0), 'mobile: HUD wing line fits the screen', hud);
    await page.screenshot({ path: out + '/mobile-battle-hud.png' });
    await ctx.close();
  }

  if (ONLY.includes('perf')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(600000); watch(page);
    await page.goto(base + '/?skirmish');
    await page.waitForFunction(() => !!window.fleetcmd);
    for (const target of [200, 400, 800]) {
      const probe = await page.evaluate(target => {
        const root = (name, ships) => ({ name, root: { name, commanderId: null, order: 'engage', retreatAt: 0, ships, children: [] } });
        const carriers = Array.from({ length: Math.ceil(target / 30) }, () => ({ classId: 'carrier', loadoutId: 'air_group', cpu: { id: 'cpu_carrier', arch: 'carrier' } }));
        // gun-only targets: no point defence, so launched craft stay airborne and the sky is actually full
        const targets = Array.from({ length: 24 }, () => ({ classId: 'battleship', loadoutId: 'std', fit: { name: 'gun-only target', mounts: [{ weapon: 'heavy_cannon', pos: [0, 0, 20], facing: 0, arc: 180 }] } }));
        window.fleetcmd.startBattle({ seed: 7, scenarioId: 'kestrel', rules: 3, spawnZ: 650, fleets: [root('A', carriers), root('B', targets)] });
        const s = window.fleetcmd.session; s.stop();
        const w = s.world, v = s.view, cv = v.craftView, gl = v.renderer.getContext();
        const air = () => { let n = 0; for (let i = 0; i < (w.craft?.st.length ?? 0); i++) if (w.craft.st[i] === 2) n++; return n; };
        for (let i = 0; i < 300 && !w.outcome; i++) { w.step(); if (w.events.length) v.handleEvents(w.events); }
        for (let k = 0; k < 5; k++) v.frame(1, w.dt, w.dt, true);      // warm shaders / buffers
        const of = cv.frame.bind(cv); let craftMs = 0;
        cv.frame = (...a) => { const t = performance.now(); of(...a); craftMs += performance.now() - t; };
        const frame = [], drawn = [], airborne = [], calls = [];
        for (let k = 0; k < 30; k++) {
          for (let t = 0; t < 2 && !w.outcome; t++) { w.step(); if (w.events.length) v.handleEvents(w.events); }
          v.renderer.info.autoReset = false; v.renderer.info.reset();
          const t0 = performance.now();
          v.frame(1, w.dt * 2, w.dt * 2, true);
          gl.finish();                                                   // include submission + SwiftShader completion
          frame.push(performance.now() - t0);
          calls.push(v.renderer.info.render.calls);
          drawn.push(cv.drawn); airborne.push(air());
        }
        cv.frame = of;
        // same scene with the craft hidden: what the craft batches add to draw calls and frame time
        const hidFrame = [], hidCalls = [];
        cv.group.visible = false;
        for (let k = 0; k < 15; k++) {
          v.renderer.info.reset();
          const t0 = performance.now(); v.frame(1, 0, 0, true); gl.finish(); hidFrame.push(performance.now() - t0);
          hidCalls.push(v.renderer.info.render.calls);
        }
        cv.group.visible = true; v.renderer.info.autoReset = true;
        const agg = a => { const b = a.slice().sort((x, y) => x - y); return { mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(2), p95: +b[Math.floor((b.length - 1) * 0.95)].toFixed(2), max: +b[b.length - 1].toFixed(2) }; };
        const sq = w.craft?.squads ?? [];
        return { target, carriers: carriers.length, complement: carriers.length * 30, slotBuffer: w.craft?.st.length ?? 0, airborneMin: Math.min(...airborne), airborneMax: Math.max(...airborne),
          drawnEqualsAirborne: drawn.every((d, i) => d === airborne[i]), launched: sq.reduce((a, q) => a + q.stats.launched, 0), lost: sq.reduce((a, q) => a + q.stats.lost, 0),
          frameMs: agg(frame), craftCpuMs: +(craftMs / 30).toFixed(3), drawCalls: agg(calls), hiddenFrameMs: agg(hidFrame), hiddenDrawCalls: agg(hidCalls), rules: w.rules, simTime: +w.time.toFixed(1) };
      }, target);
      metrics.push(probe);
      check(probe.rules === 3 && probe.drawnEqualsAirborne, `perf ${target}: renderer draws the actual airborne craft every frame`, { target, airborneMin: probe.airborneMin, airborneMax: probe.airborneMax });
      check(probe.airborneMin >= target * 0.9, `perf ${target}: at least 90 % of the target actually airborne (not pool capacity)`, probe);
      await page.screenshot({ path: `${out}/craft-${target}.png` });
    }
    await page.close();
  }
} catch (e) { check(false, 'browser run', { error: String(e?.stack ?? e).slice(0, 900) }); }
check(errors.length === 0, 'no page / console errors', errors.slice(0, 5));
await browser.close();
await fs.writeFile(out + '/metrics.json', JSON.stringify({ environment: 'headless Chromium, SwiftShader software WebGL (not a user GPU)', results, metrics, errors }, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
