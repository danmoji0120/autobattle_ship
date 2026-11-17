// B-3 territory UI on a real server with a world played by the engine (no client-state injection).
// The server (built `dist-server/server.mjs`) loads a save produced by scripts/b3/realloop.ts — a company that took
// gloam through the normal systems. The browser signs up a new account and takes that company over through the
// existing "PMC from before accounts" path (a random browser token in the save's `auth` map), so every number on
// screen is computed by the real server from the real world.
//   node scripts/b3/b3-browser-real.cjs <realloop save> <label> <outDir> [expect=established|stabilising]
// Checks (desktop 1440 and phone 390):
//  - the 영토 button and the territory screen; the owner row of gloam with stage, the seven conditions and reasons,
//    control and stabilisation, supply with the governance reservation (재고 · 예약) and its state
//  - a declaration in another system is refused by the server with its reason, shown to the player
//  - the galaxy map marks gloam and its info section opens the territory screen
//  - phone: no horizontal scroll; no page or console errors
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const [savePath, label = 'real', outDir = 'artifacts/b3/browser-real', expect = 'established'] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const world = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const co = Object.values(world.companies).find(c => c.kind === 'player' && c.name === '개척 광업');
  if (!co) throw new Error('no realloop company in the save');
  const token = crypto.randomBytes(16).toString('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-b3-real-'));
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ v: 1, world, auth: { [token]: co.id }, accounts: {} }));
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), SAVE_INTERVAL_S: '30' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'TERRITORY_B3_MIGRATE', 'MILITARY_B2_MIGRATE', 'WORLD_SEED']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 240 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { label, save: savePath, company: co.id, checks: [], errors: [], console: [] };
  const check = (ok, l, extra) => { report.checks.push({ ok: !!ok, label: l, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', l, extra ? JSON.stringify(extra).slice(0, 700) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = (page, vp) => {
    page.on('pageerror', e => report.errors.push(`${vp}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') report.console.push({ vp, text: m.text().slice(0, 300) }); });
  };
  const ID = 'b3real_' + label.replace(/\W/g, ''), PW = 'b3-real-pass-123';
  /** first visit: sign up, carry the save's company over with the legacy browser token; later visits: log in */
  const enter = async (page, first) => {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    if (first) {
      await page.evaluate(async ([id, pw, tok]) => { localStorage.setItem('siderarium.mp.token', tok); await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw, confirm: pw }) }); }, [ID, PW, token]);
    } else {
      await page.evaluate(async ([id, pw]) => { await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw }) }); }, [ID, PW]);
    }
    report.console.splice(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    if (first) {
      await page.waitForSelector('#pmcLegacy', { timeout: 30000 });
      await page.check('#pmcLegacy'); await page.click('#pmcGo');
    }
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state?.companies?.[window.siderarium.client.company]?.sovx, null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    if (await page.$('.mil-modal:not(.sov-modal)')) { await page.click('.mil-modal [data-a="close"]'); await page.waitForTimeout(300); }
  };
  const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const boxNoHScroll = page => page.evaluate(() => { const b = document.querySelector('.sov-modal .mil-scroll'); return !b || b.scrollWidth <= b.clientWidth + 1; });
  const openGloam = async page => {
    await page.click('#sovBtn'); await page.waitForSelector('.sov-modal', { timeout: 5000 });
    await page.evaluate(() => { const b = document.querySelector('.sov-modal [data-a="pick"][data-id="gloam"]'); b && b.click(); });
    await page.waitForTimeout(500);
  };
  try {
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await enter(page, true);
    const me = await page.evaluate(() => { const c = window.siderarium.client, x = c.state.companies[c.company]; const row = x.sovx?.rows?.find(r => r.sys === 'gloam'); return { id: c.company, name: x.name, hasSov: 'sov' in c.state, row: row && { stage: row.stage, status: row.status, ctl: row.ctl, stab: row.stab, claim: row.claim, power: row.power, need: row.needPower, supply: row.supply, fails: Object.entries(row.rep).filter(([, v]) => !v.ok).map(([k, v]) => k + ':' + v.miss.join(';')) } }; });
    check(me.id === co.id && !me.hasSov, 'real server: the engine-played company is controlled by this account; server state is not sent', { id: me.id, name: me.name });
    check(!!me.row, 'the server report has gloam', me.row);
    const sup = me.row?.supply;
    check(sup && sup.reserved && Object.keys(sup.demand).every(k => typeof sup.reserved[k] === 'number'), 'report: governance reservation per item (server computed)', sup);
    if (expect === 'established') check(me.row?.stage === 8 && me.row?.status === 'established', 'gloam is established for this company (from the real loop)', me.row);
    else check(me.row?.claim && me.row.claim.prog > 0 && me.row.claim.prog < me.row.claim.need, 'gloam is mid-stabilisation (from the real loop)', me.row?.claim);
    check(await page.isVisible('#sovBtn'), 'top bar has the 영토 button');
    await openGloam(page);
    const det = await page.innerText('.sov-modal');
    check(/경제력/.test(det) && /기반시설/.test(det) && /물류/.test(det) && /군사/.test(det) && /실효 지배/.test(det) && /정당성/.test(det), 'detail: the seven conditions table', { text: det.slice(0, 700) });
    check(/행정 물자/.test(det) && /예약/.test(det) && /통치청은 다음 1시간 운영분/.test(det), 'detail: supply shows stock and the reservation with its explanation', {});
    check(/지배/.test(det) && (expect === 'established' ? /안정도|확립/.test(det) : /안정화/.test(det)), `detail: control and ${expect === 'established' ? 'stability' : 'stabilisation progress'}`, {});
    if (expect !== 'established') check(/미달|부족|측정|필요|\//.test(det), 'detail: unmet conditions show their reasons', {});
    await page.screenshot({ path: `${outDir}/${label}-gloam-1440.png` });
    await page.evaluate(() => document.querySelector('.sov-modal .mil-scroll')?.scrollTo(0, 99999)); await page.waitForTimeout(200);
    await page.screenshot({ path: `${outDir}/${label}-gloam-bottom-1440.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'desktop: no horizontal scroll');
    // a declaration where the company has no footing: the server refuses and the reason reaches the player
    const r = await page.evaluate(async () => window.siderarium.client.cmd({ c: 'sov', op: 'declare', sys: 'mire' }));
    check(typeof r === 'string' && r.length > 3, 'real server refuses a declaration without footing, with a reason', { err: r });
    await page.click('.sov-modal [data-a="close"]'); await page.waitForTimeout(300);
    // galaxy map
    const gal = await page.evaluate(() => { const h = window.siderarium.hud; if (!h) return { hud: false }; h.galSel = 'gloam'; if (!h.galaxy) h.toggleGalaxy(); else h.renderGalaxy(true); return { hud: true, terr: window.siderarium.client.state.systems.gloam?.terr }; });
    await page.waitForTimeout(1200);
    const mark = await page.evaluate(() => { const t = document.body.innerText; return { own: /자사 영토/.test(t), btn: !!document.querySelector('[data-sov-open]') }; });
    check(gal.hud && (expect !== 'established' || gal.terr?.owner === co.id), 'galaxy: gloam carries the public territory record from the server', gal.terr);
    check(mark.btn && (expect !== 'established' || mark.own), 'galaxy info: 영유권 section (자사 영토) and the territory button', mark);
    await page.screenshot({ path: `${outDir}/${label}-galaxy-1440.png` });
    await ctx.close();
    // phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await enter(page, false);
    await page.screenshot({ path: `${outDir}/${label}-phone-top-390.png` });
    // every top-bar button: is it covered by another panel at its centre? (to tell a B-3 problem from the phone layout)
    const bar = await page.evaluate(() => [...document.querySelectorAll('#ptop button[id]')].map(e => { const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { id: e.id, top: Math.round(r.top), left: Math.round(r.left), covered: !!hit && !e.contains(hit), by: hit && !e.contains(hit) ? (hit.closest('[id]')?.id ?? hit.className) : '' }; }));
    report.topbar390 = bar; console.log('topbar 390', JSON.stringify(bar));
    const btn = await page.evaluate(() => { const e = document.getElementById('sovBtn'); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { w: r.width, h: r.height, covered: !!hit && !e.contains(hit) }; });
    check(btn && btn.w > 0 && !btn.covered, 'phone: top-bar 영토 button reachable', btn);
    await openGloam(page);
    const pdet = await page.innerText('.sov-modal');
    check(/예약/.test(pdet) && /실효 지배/.test(pdet), 'phone: detail with conditions and reservation', {});
    await page.screenshot({ path: `${outDir}/${label}-gloam-390.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'phone: detail without horizontal scroll');
    for (const t of ['sys', 'war', 'help']) {
      await page.click(`.sov-modal [data-a="tab"][data-id="${t}"]`); await page.waitForTimeout(300);
      const ok = await noHScroll(page) && await boxNoHScroll(page);
      if (!ok) console.log('overflow', t, JSON.stringify(await page.evaluate(() => { const b = document.querySelector('.sov-modal .mil-scroll'); const W = b ? b.getBoundingClientRect().right : window.innerWidth; return { doc: [document.documentElement.scrollWidth, window.innerWidth], box: b && [b.scrollWidth, b.clientWidth], wide: [...document.querySelectorAll('.sov-modal *')].filter(e => e.getBoundingClientRect().right > W + 1).slice(0, 6).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right) + ' ' + (e.textContent || '').slice(0, 60)) }; })));
      check(ok, `phone: tab ${t} without horizontal scroll`);
    }
    await page.click('.sov-modal [data-a="close"]'); await page.waitForTimeout(300);
    await ctx.close();
    check(report.errors.length === 0, 'no page errors', report.errors);
    check(report.console.length === 0, 'no console errors', report.console);
  } catch (e) { check(false, 'script error', String(e && e.stack || e)); }
  finally {
    await browser.close(); srv.kill('SIGTERM');
    fs.writeFileSync(`${outDir}/${label}-report.json`, JSON.stringify(report, null, 1));
    const fail = report.checks.filter(c => !c.ok).length;
    console.log(`\n${report.checks.length - fail}/${report.checks.length} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
