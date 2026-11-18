// P16.4 browser check on the production build served by the real server (disposable save, synthetic accounts):
//  1. skirmish: the carrier is hidden until the rules-3 trial is on; carrier row fitting (air modules, carrier
//     computer, wing line); a carrier fleet cannot start without the trial; battle under rules 3 with rendered craft
//     matching the sim; HUD wing line (control, airborne/deck/lost, squadrons, CAP-held); replay determinism
//  2. dev lab: rules selector exposes the carrier, lab fitting shows the H slots / wing rows, watch starts rules 3
//  3. frame time at ~200 / 400 / 800 craft (real carriers + hangar extension modules)
//   node scripts/p16/p164-browser.cjs [outDir]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/p164';
const delay = ms => new Promise(r => setTimeout(r, ms));
function hash(password) { const salt = crypto.randomBytes(16), n = 32768, r = 8, p = 3; const key = crypto.scryptSync(password.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * n * r }); return `scrypt$${n}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`; }

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-p164-'));
  const pw = crypto.randomBytes(18).toString('base64url'), labPw = crypto.randomBytes(18).toString('base64url');
  const admin = crypto.randomUUID(), t = Date.now();
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: { [admin]: { id: admin, loginId: 'p164_admin', pwHash: hash(pw), recoveryHash: null, email: null, createdAt: t, lastLogin: null, pwChanged: t } }, sessions: {} }));
  const env = { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '164', SAVE_INTERVAL_S: '600', ANALYTICS_ADMIN_ACCOUNTS: admin, DEV_COMBAT_LAB_PASSWORD_HASH: hash(labPw) };
  let log = '';
  const srv = spawn(process.execPath, [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await delay(100); }
  const report = { checks: [], errors: [], console: [], perf: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra !== undefined ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = page => {
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) report.console.push(m.text().slice(0, 300)); });
  };
  // digest every 150 ticks of the running battle (installed before the first step of a fresh session)
  const hookDigest = page => page.evaluate(() => {
    const w = window.session.world; window.__dig = []; const step = w.step.bind(w);
    w.step = () => { step(); if (w.tick % 150 === 0) window.__dig.push([w.tick, w.digest()]); };
  });
  // airborne craft by the sim vs instances the renderer drew in the same frame
  const craftState = page => page.evaluate(() => {
    const s = window.session, w = s.world, c = w.craft;
    if (!c) return null;
    let out = 0; for (let i = 0; i < c.st.length; i++) if (c.st[i] === 2) out++;
    const sq = c.squads.map(q => ({ role: q.cs.role, task: q.task, held: q.heldNow, ...q.stats, tasks: undefined }));
    return { time: Math.round(w.time), rules: w.rules, out, drawn: s.view.craftView.drawn, squads: sq };
  });
  try {
    const ONLY = process.env.P164_ONLY ?? 'skirmish,lab,perf';
    let ctx, page;
    if (ONLY.includes('skirmish')) {
    // ------------------------------------------------------------------ 1. skirmish
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage(); watch(page);
    await page.goto(base + '/?skirmish', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#setup');
    check(await page.locator('[data-cat="carrier"]').count() === 0, 'skirmish: carrier hidden while the rules-3 trial is off');
    await page.click('#r3');
    await page.waitForSelector('[data-cat="carrier"]');
    check(true, 'skirmish: rules-3 trial shows the carrier in the catalog');
    // empty the default fleet, then carrier + two destroyers
    for (let i = 0; i < 60 && await page.locator('[data-sdel]').count(); i++) await page.locator('[data-sdel]').first().click();
    await page.click('[data-cat="carrier"]');
    await page.waitForSelector('[data-cat="carrier"] [data-add]');
    const catText = await page.innerText('[data-cat="carrier"]');
    check(/전투기 8기/.test(catText) && /비행대 4 · 관제 3/.test(catText), 'catalog: craft summary and wing/control line instead of gun firepower', catText.replace(/\s+/g, ' ').slice(0, 400));
    await page.click('[data-cat="carrier"] [data-add]');
    // escorts (a lone carrier dies before its wing does anything): add while the budget allows
    for (const cls of ['battleship', 'battleship', 'cruiser', 'cruiser', 'destroyer', 'destroyer', 'destroyer']) {
      await page.click(`[data-cat="${cls}"]`); await page.click(`[data-cat="${cls}"] [data-add]`);
      if (await page.locator('.budget.over').count()) { await page.locator('[data-sdel]').last().click(); break; }
    }
    const row = await page.evaluate(() => { const s = document.querySelector('.srow.cv'); return s && { text: s.innerText.replace(/\s+/g, ' '), air: [...s.querySelectorAll('[data-sair] option')].map(o => o.value), cpu: [...s.querySelectorAll('[data-scpu] option')].map(o => o.value) }; });
    check(row && /비행대 4 · 관제 3 \(1개 CAP 대기\)/.test(row.text) && row.air.length === 5 && row.cpu.includes('cpu_carrier'), 'carrier row: wing line with the CAP-held squadron, aviation fits, carrier computer', row);
    const otherCpu = await page.evaluate(() => [...document.querySelectorAll('.srow:not(.cv) [data-scpu] option')].map(o => o.value));
    check(!otherCpu.includes('cpu_carrier'), 'carrier computer offered on carriers only');
    const airSel = await page.locator('[data-sair]').getAttribute('data-sair');
    await page.selectOption(`[data-sair="${airSel}"]`, 'ctl');
    check(/비행대 4 · 관제 4/.test(await page.innerText('.srow.cv')) && !/CAP 대기/.test(await page.innerText('.srow.cv')), 'air control module raises the limit (no squadron held)');
    await page.selectOption(`[data-sair="${airSel}"]`, '');
    await page.selectOption(`[data-scpu="${airSel}"]`, 'cpu_carrier');
    await page.screenshot({ path: `${outDir}/skirmish-setup.png` });
    await page.click('#r3');
    check(await page.locator('#go').isDisabled() && /규칙 3/.test(await page.getAttribute('#go', 'title') ?? ''), 'carrier fleet cannot start with the trial off');
    await page.click('#r3');
    check(!(await page.locator('#go').isDisabled()), 'trial on: the carrier fleet can start');
    await page.click('#go');
    await page.waitForFunction(() => window.session && window.session.world, null, { timeout: 60000 });
    await hookDigest(page);
    await page.evaluate(() => { window.session.timeScale = 2; window.hud.select(window.session.world.roots[0]); });
    // HUD wing line while the carrier is alive (a sunk carrier leaves the group, and its wing with it)
    let held = null, hudText = '', hudShot = false;
    for (let i = 0; i < 240 && !held; i++) {
      await delay(250);
      const h = await page.evaluate(() => ({ t: document.getElementById('gwing')?.innerText.replace(/\s+/g, ' ') ?? '', alive: window.session.world.ships.some(s => s.cls.id === 'carrier' && s.state === 'alive'), time: window.session.world.time }));
      if (h.t) hudText = h.t;
      if (h.t && !hudShot) { hudShot = true; await page.screenshot({ path: `${outDir}/skirmish-battle-hud.png` }); }
      if (/CAP 대기/.test(h.t)) { held = h.t; await page.screenshot({ path: `${outDir}/skirmish-hud-cap-held.png` }); }
      if (!report.closeup && /비행 ([89]|\d\d)/.test(h.t)) {
        // close-up of the strike while it happens: focus the camera on the airborne craft
        report.closeup = await page.evaluate(() => {
          const s = window.session, c = s.world.craft; let x = 0, z = 0, n = 0;
          for (let i = 0; i < c.st.length; i++) if (c.st[i] === 2) { x += c.px[i]; z += c.pz[i]; n++; }
          s.view.rig.setMode('tactical'); s.view.rig.focus.set(x / n, 0, z / n); s.view.rig.dist = 380; s.view.rig.pitch = 0.5; s.timeScale = 0.5;
          return { n, time: Math.round(s.world.time) };
        });
        await delay(1800);
        await page.screenshot({ path: `${outDir}/skirmish-craft-closeup.png` });
        await page.evaluate(() => { window.session.timeScale = 2; });
      }
      if (!h.alive) break;
    }
    check(/관제 \d\/3/.test(hudText) && /비행 \d+ · 갑판 \d+ · 손실 \d+/.test(hudText), 'HUD: control in use / limit and airborne · deck · lost', hudText);
    check(!!held, 'HUD: a squadron kept on CAP by the control limit is marked', held);
    await page.evaluate(() => { window.session.timeScale = 3; });
    await page.waitForFunction(() => window.session.world.time > 30, null, { timeout: 180000 });
    let cs = await craftState(page);
    check(cs && cs.rules === 3 && cs.squads.length === 4, 'battle runs under rules 3 with the four squadrons', cs && { rules: cs.rules, squads: cs.squads.length });
    // rendered = airborne (sampled in the same frame)
    const sync = await page.evaluate(() => new Promise(res => { const s = window.session; const f = s.onFrame; let n = 0; const out = []; s.onFrame = dt => { f?.(dt); const c = s.world.craft; let o = 0; for (let i = 0; i < c.st.length; i++) if (c.st[i] === 2) o++; out.push([o, s.view.craftView.drawn]); if (++n >= 60) { s.onFrame = f; res(out); } }; }));
    check(sync.some(([o]) => o > 0) && sync.every(([o, d]) => o === d), 'every frame draws exactly the airborne craft of the sim', sync.slice(0, 8));
    check(!!report.closeup, 'close-up captured during the strike', report.closeup);
    const stats = await craftState(page);
    const sum = k => stats.squads.reduce((a, q) => a + (q[k] ?? 0), 0);
    check(sum('launched') > 0, 'craft launched (stats)', { launched: sum('launched'), recovered: sum('recovered'), lost: sum('lost'), ord: sum('ordFired'), held: sum('held') });
    // spectate: the result screen / replay of the same battle
    await page.waitForFunction(() => window.session.world.time > 90 || window.session.world.outcome, null, { timeout: 240000 });
    const live = await page.evaluate(() => window.__dig.slice());
    await page.evaluate(() => window.hud.opts.onReplay());
    await page.waitForFunction(() => window.session && window.session.world.tick < 30, null, { timeout: 30000 });
    await hookDigest(page);
    await page.evaluate(() => { window.session.timeScale = 3; });
    const last = live[live.length - 1][0];
    await page.waitForFunction(t => window.session.world.tick >= t || window.session.world.outcome, last, { timeout: 300000 });
    const rep = await page.evaluate(() => window.__dig.slice());
    const n = Math.min(live.length, rep.length);
    check(n >= 5 && live.slice(0, n).every((d, i) => d[0] === rep[i][0] && d[1] === rep[i][1]), 'replay reproduces the live battle digest for digest', { compared: n, live: live.slice(-2), replay: rep.slice(n - 2, n) });
    await page.screenshot({ path: `${outDir}/skirmish-replay.png` });
    await ctx.close();
    }
    if (ONLY.includes('lab')) {

    // ------------------------------------------------------------------ 2. dev lab
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const r = await ctx.request.post(`${base}/api/auth/login`, { headers: { origin: base }, data: { loginId: 'p164_admin', password: pw } });
    check(r.status() === 200, 'lab: admin login');
    page = await ctx.newPage(); watch(page);
    await page.goto(`${base}/?devskirmish=1`, { waitUntil: 'domcontentloaded' });
    await page.locator('#devPw').fill(labPw); await page.locator('#devAuth button[type=submit]').click();
    await page.locator('.lab-setup').waitFor({ timeout: 30000 });
    check(await page.locator('[data-cat="carrier_dawn"]').count() === 0, 'lab: carrier hidden under the default rules');
    await page.click('[data-lab-controls]');
    await page.selectOption('[data-rules]', '3');
    await page.screenshot({ path: `${outDir}/lab-rules-select.png` });
    await page.click('[data-close-controls]');
    await page.waitForSelector('[data-cat="carrier_dawn"]');
    check(true, 'lab: rules 3 selected — carrier in the catalog');
    await page.screenshot({ path: `${outDir}/lab-rules3.png` });
    await page.click('[data-cat="carrier_dawn"]');
    await page.click('[data-cat="carrier_dawn"] [data-add="1"]');
    const sfit = await page.evaluate(() => [...document.querySelectorAll('.lab-srow')].find(r => r.innerText.includes('여명급'))?.querySelector('[data-sfit]')?.dataset.sfit);
    check(!!sfit, 'lab: the carrier row is in the BLUE fleet', sfit);
    await page.click(`[data-sfit="${sfit}"]`);
    await page.locator('.lab-fitmodal .fbox').waitFor();
    const fit = await page.evaluate(() => ({
      h: [...document.querySelectorAll('.lab-fitmodal [data-fsel^="hp:h"]')].map(e => e.innerText.replace(/\s+/g, ' ')),
      bays: [...document.querySelectorAll('.lab-fitmodal [data-fsel^="bay:fl"]')].map(e => e.innerText.replace(/\s+/g, ' ')),
      stat: document.querySelector('.lab-fitmodal .fstat').innerText.replace(/\s+/g, ' '),
    }));
    check(fit.h.length === 4 && fit.h.every(t => /격납\(H\)/.test(t) && /\d+기 · 예비 \d+ · 반경 \d+/.test(t)), 'lab fitting: four H slots show complement · spares · radius', fit.h);
    check(fit.bays.length === 3 && fit.bays.every(t => /항공 장비 베이/.test(t)), 'lab fitting: three aviation bays', fit.bays);
    check(/비행대 4 · 관제 3/.test(fit.stat) && /1 CAP 대기/.test(fit.stat) && /함재기 30기 · 예비 15/.test(fit.stat) && /작전 반경/.test(fit.stat) && !/지속 화력/.test(fit.stat), 'lab fitting: wing rows replace gun firepower', fit.stat);
    await page.click('.lab-fitmodal [data-fsel="bay:fl1"]');
    await page.click('[data-fpick="air_control"]');
    const stat2 = await page.innerText('.lab-fitmodal .fstat');
    check(/관제 4/.test(stat2) && !/CAP 대기/.test(stat2), 'lab fitting: an air control module lifts the limit (preview)', stat2.replace(/\s+/g, ' '));
    await page.screenshot({ path: `${outDir}/lab-fitting-carrier.png` });
    await page.click('[data-fapply]');
    await page.click('[data-lab-controls]');
    await page.click('[data-watch]');
    await page.waitForFunction(() => window.session && window.session.world && window.session.world.time > 20, null, { timeout: 120000 }).catch(() => null);
    const lab = await page.evaluate(() => { const w = window.session?.world; return w && { rules: w.rules, craft: !!w.craft, control: w.craft?.wings.map(x => x.control) }; });
    check(lab && lab.rules === 3 && lab.craft && lab.control.includes(4), 'lab: watch starts a rules-3 battle with the fitted air wing', lab);
    await page.screenshot({ path: `${outDir}/lab-battle.png` });
    await ctx.close();
    }
    if (ONLY.includes('perf')) {

    // ------------------------------------------------------------------ 3. frame time at 200 / 400 / 800 craft
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage(); watch(page);
    await page.goto(base + '/?skirmish', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#setup');
    for (const target of [200, 400, 800]) {
      const res = await page.evaluate(async target => {
        // carrier with three hangar extensions: 14+14+12+14 = 54 craft; per side target/2
        const per = 54, n = Math.ceil(target / 2 / per);
        const side = (name, team) => ({ name, root: { name, commanderId: null, order: 'engage', retreatAt: 0, ships: [
          ...Array.from({ length: n }, () => ({ classId: 'carrier', loadoutId: 'air_group', fx: { air: { complement: 6 } } })),
          ...Array.from({ length: 4 }, () => ({ classId: 'cruiser', loadoutId: 'std' })) ], children: [] } });
        window.fleetcmd.startBattle({ seed: 7, scenarioId: 'kestrel', fleets: [side('A', 0), side('B', 1)], rules: 3 });
        const s = window.session; s.timeScale = 1;
        await new Promise(r => { const t0 = performance.now(); const tick = () => { if (s.world.time > 45 || performance.now() - t0 > 240000) r(); else setTimeout(tick, 250); }; tick(); });
        const cap = s.world.craft.n ?? s.world.craft.st.length;
        const measure = (ms, hide) => new Promise(r => {
          s.view.craftView.group.visible = !hide;
          const v = s.view, cv = v.craftView, of = cv.frame.bind(cv); let craftMs = 0;
          cv.frame = (...a) => { const t = performance.now(); of(...a); craftMs += performance.now() - t; };
          const dts = [], drawn = [], calls = []; let last = performance.now(); const end = last + ms;
          const loop = () => { const now = performance.now(); dts.push(now - last); last = now; drawn.push(cv.drawn); calls.push(v.renderer.info.render.calls);
            if (now < end) requestAnimationFrame(loop); else { cv.frame = of; cv.group.visible = true; const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)]; r({ frames: dts.length, avg: dts.reduce((a, b) => a + b, 0) / dts.length, p95: q(dts, 0.95), craftCpuPerFrame: craftMs / dts.length, drawnAvg: drawn.reduce((a, b) => a + b, 0) / drawn.length, drawnMax: Math.max(...drawn), calls: q(calls, 0.5) }); } };
          requestAnimationFrame(loop);
        });
        const on = await measure(6000, false), off = await measure(6000, true);
        return { target, slots: cap, carriersPerSide: n, on, off };
      }, target);
      report.perf.push(res);
      check(res.on.drawnMax > 0, `perf ${target}: craft airborne and drawn`, { slots: res.slots, drawnAvg: Math.round(res.on.drawnAvg), drawnMax: res.on.drawnMax, frameAvg: res.on.avg.toFixed(1), p95: res.on.p95.toFixed(1), craftCpu: res.on.craftCpuPerFrame.toFixed(2), hiddenAvg: res.off.avg.toFixed(1), calls: res.on.calls });
      await page.screenshot({ path: `${outDir}/perf-${target}.png` });
    }
    await ctx.close();
    }
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 900) }); }
  check(!report.errors.length, 'no page errors', report.errors.slice(0, 5));
  check(!report.console.length, 'no console errors', report.console.slice(0, 5));
  fs.writeFileSync(`${outDir}/browser-results${process.env.P164_ONLY ? '-' + process.env.P164_ONLY.replace(/,/g, '-') : ''}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outDir}/server.log`, log);
  await browser.close(); srv.kill('SIGTERM');
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length}`);
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
