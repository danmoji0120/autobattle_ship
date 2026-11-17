// B-3 territory UI browser check on a real server (built client + `node dist-server/server.mjs`, standard world with B-3).
//  1. desktop 1440: the top bar has the 영토 button; it opens the territory screen; a new company has no territory and
//     the empty state explains the path; the system / war / help tabs render
//  2. real server authority: asking to declare in a system where the company has nothing is refused by the server and
//     the refusal is shown (no client-side shortcut)
//  3. populated screen: the owner report and public territory produced by the real engine (scripts/b3/fixture.ts, a
//     sovereign of gloam with a rival claimant at war) are put into the client state; the stage chips, the seven
//     conditions, supply, income, policy form, war cards and the galaxy overlay / info section render
//  4. phone 390: screen, tabs and detail fit without horizontal scroll; the button is reachable; no page / console errors
//   node scripts/b3/b3-browser.cjs <fixture.json> <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const fix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outDir = process.argv[3] ?? 'artifacts/b3/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-b3-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '41', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'TERRITORY_B3_MIGRATE', 'MILITARY_B2_MIGRATE']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 160 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = (page, vp) => {
    page.on('pageerror', e => report.errors.push(`${vp}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') report.console.push({ vp, text: m.text().slice(0, 300) }); });
  };
  const found = async (page, id, pw, bg) => {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([id, pw]) => fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw, confirm: pw }) }), [id, pw]);
    report.console.splice(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    await page.fill('#pmcNew', `B3 ${bg}`); await page.click(`[data-bg="${bg}"]`); await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    // a security / veteran start opens the military guide once by itself
    if (await page.$('.mil-modal:not(.sov-modal)')) { await page.click('.mil-modal [data-a="close"]'); await page.waitForTimeout(300); }
  };
  /** put the engine-produced territory data into the client state (owner = this company), kept on every snapshot */
  const inject = page => page.evaluate(fx => {
    const c = window.siderarium.client, me = c.company;
    const swap = o => JSON.parse(JSON.stringify(o).split(fx.B).join(me));
    const owner = swap(fx.owner), terr = swap(fx.terr);
    const apply = () => {
      const st = c.state; if (!st) return;
      st.companies[me].sovx = owner;
      if (!st.companies[fx.A]) st.companies[fx.A] = { id: fx.A, name: fx.names[fx.A], kind: 'player', credits: 0 };
      const g = st.systems.gloam; if (g) g.terr = terr;
    };
    apply(); if (!window.__b3inj) { window.__b3inj = true; c.onSnap.unshift(apply); }
    return { known: !!c.state.systems.gloam, rows: owner.rows.length, wars: owner.wars.length };
  }, fix);
  const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const boxNoHScroll = page => page.evaluate(() => { const b = document.querySelector('.sov-modal .mil-scroll'); return !b || b.scrollWidth <= b.clientWidth + 1; });
  try {
    // ---- desktop
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await found(page, 'b3_desk', 'b3-desk-pass-123', 'security');
    const w0 = await page.evaluate(() => { const c = window.siderarium.client; return { sovV: c.state.sovV, hasSov: 'sov' in c.state, terr: Object.values(c.state.systems).filter(s => s.terr).length, sovx: !!c.state.companies[c.company].sovx }; });
    check(w0.sovV === 1 && !w0.hasSov, 'standard world runs B-3; the server-side state is not sent', w0);
    check(await page.isVisible('#sovBtn'), 'top bar has the 영토 button', { text: await page.innerText('#sovBtn').catch(() => '') });
    await page.click('#sovBtn'); await page.waitForSelector('.sov-modal', { timeout: 5000 });
    const empty = await page.innerText('.sov-modal');
    check(/영토 활동이 없습니다|단계/.test(empty) && /정거장 건설이나 비용 지불만으로 생기지 않습니다/.test(empty), 'territory screen opens; a new company sees the path and the rule', { text: empty.slice(0, 500) });
    await page.screenshot({ path: `${outDir}/empty-1440.png` });
    for (const t of ['sys', 'war', 'help']) {
      await page.click(`.sov-modal [data-a="tab"][data-id="${t}"]`); await page.waitForTimeout(300);
      const txt = await page.innerText('.sov-modal .mil-body');
      check(txt.length > 20, `tab ${t} renders`, { text: txt.slice(0, 300) });
      await page.screenshot({ path: `${outDir}/tab-${t}-1440.png` });
    }
    // the server decides: a declaration where the company has nothing is refused, and the refusal is shown
    const r = await page.evaluate(async () => { const c = window.siderarium.client; const err = await c.cmd({ c: 'sov', op: 'declare', sys: 'gloam' }); return { err };  });
    check(r.err && /영향력|거점|정거장|지배/.test(r.err), 'the server refuses a declaration without footing', r);
    await page.click('.sov-modal [data-a="close"]'); await page.waitForTimeout(300);
    check(!(await page.$('.sov-modal')), 'closes');
    // populated
    const inj = await inject(page);
    check(inj.rows > 0, 'engine fixture injected (owner report of gloam)', inj);
    await page.click('#sovBtn'); await page.waitForSelector('.sov-modal', { timeout: 5000 });
    await page.evaluate(() => { const b = document.querySelector('.sov-modal [data-a="pick"][data-id="gloam"]'); b && b.click(); });
    await page.waitForTimeout(400);
    const det = await page.innerText('.sov-modal');
    check(/확립/.test(det) && /경제력/.test(det) && /기반시설/.test(det) && /물류/.test(det) && /군사/.test(det) && /실효 지배/.test(det) && /정당성/.test(det), 'detail: stage and the seven conditions', { text: det.slice(0, 900) });
    check(/행정 물자/.test(det) && /유지비/.test(det), 'detail: supply and upkeep / income', {});
    check(/통치 정책/.test(det) && (await page.$('.sov-modal [data-pol]')), 'owner policy form', {});
    check(/아르고|전쟁/.test(det), 'rival / war shown', {});
    await page.screenshot({ path: `${outDir}/owner-1440.png`, fullPage: false });
    await page.evaluate(() => document.querySelector('.sov-modal .mil-scroll')?.scrollTo(0, 99999)); await page.waitForTimeout(200);
    await page.screenshot({ path: `${outDir}/owner-policy-1440.png` });
    await page.click('.sov-modal [data-a="tab"][data-id="war"]'); await page.waitForTimeout(300);
    const war = await page.innerText('.sov-modal .mil-body');
    check(/전쟁/.test(war) && /(예고|개전|교전)/.test(war), 'war tab: the war card', { text: war.slice(0, 400) });
    await page.screenshot({ path: `${outDir}/war-1440.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'desktop: no horizontal scroll');
    await page.click('.sov-modal [data-a="close"]'); await page.waitForTimeout(300);
    // galaxy map: info section with the territory button
    const gal = await page.evaluate(() => { const h = window.siderarium.hud; if (!h) return { hud: false }; h.galSel = 'gloam'; if (!h.galaxy) h.toggleGalaxy(); else h.renderGalaxy(true); return { hud: true }; });
    await page.waitForTimeout(1200);
    const gi = await page.$('[data-sov-open]');
    check(gal.hud && !!gi, 'galaxy info: 영유권 section with the 영토 화면 button', gal);
    await page.screenshot({ path: `${outDir}/galaxy-1440.png` });
    if (gi) { await gi.click(); await page.waitForSelector('.sov-modal', { timeout: 5000 }).catch(() => {}); check(!!(await page.$('.sov-modal')), 'the button opens the territory screen on that system'); await page.click('.sov-modal [data-a="close"]').catch(() => {}); }
    await ctx.close();
    // ---- phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await found(page, 'b3_phone', 'b3-phone-pass-123', 'veteran');
    await inject(page);
    const btn = await page.evaluate(() => { const e = document.getElementById('sovBtn'); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { w: r.width, h: r.height, covered: !!hit && !e.contains(hit) }; });
    check(btn && btn.w > 0 && !btn.covered, 'phone: top-bar 영토 button reachable', btn);
    await page.click('#sovBtn'); await page.waitForSelector('.sov-modal', { timeout: 5000 });
    await page.evaluate(() => { const b = document.querySelector('.sov-modal [data-a="pick"][data-id="gloam"]'); b && b.click(); }); await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/owner-390.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'phone: detail without horizontal scroll');
    for (const t of ['sys', 'war', 'help']) {
      await page.click(`.sov-modal [data-a="tab"][data-id="${t}"]`); await page.waitForTimeout(300);
      check(await noHScroll(page) && await boxNoHScroll(page), `phone: tab ${t} without horizontal scroll`);
    }
    await page.screenshot({ path: `${outDir}/war-390.png` });
    await page.click('.sov-modal [data-a="close"]'); await page.waitForTimeout(300);
    await ctx.close();
    check(report.errors.length === 0, 'no page errors', report.errors);
    check(report.console.length === 0, 'no console errors', report.console);
  } catch (e) { check(false, 'script error', String(e && e.stack || e)); }
  finally {
    await browser.close(); srv.kill('SIGTERM');
    fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1));
    const fail = report.checks.filter(c => !c.ok).length;
    console.log(`\n${report.checks.length - fail}/${report.checks.length} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
