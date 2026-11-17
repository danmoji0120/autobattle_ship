// B-2 military contract UI browser check on a real server (built client + `node dist-server/server.mjs`, standard world with B-2).
//  1. desktop 1440: a new security company sees the 군사 계약 screen open once by itself, with the first-business steps,
//     its fleet (power, hull, officer) and the next-step advice; the top bar has the 군사 계약 button
//  2. the board fills from the real world: offers show pay, bonus, time, risk, recommended power, fit and net range
//  3. accepting on the page with the chosen fleet reaches the server: contract taken, fleet sortied; the progress tab shows it
//  4. abandoning (two clicks) settles it as a failure; the results tab shows the operation P&L row
//  5. a station's contract tab routes military contracts to this screen; the escort-request tab renders
//  6. phone 390 (veteran start): screen opens, tabs and cards fit without horizontal scroll; no page / console errors
//   node scripts/b2/b2-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/b2/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-b2-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '41', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'OFFICERS_B1_MIGRATE', 'MILITARY_B2_MIGRATE']) delete env[k];
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
    await page.fill('#pmcNew', `B2 ${bg}`); await page.click(`[data-bg="${bg}"]`); await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
  };
  const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const boxNoHScroll = page => page.evaluate(() => { const b = document.querySelector('.mil-scroll'); return !b || b.scrollWidth <= b.clientWidth + 1; });
  try {
    // ---- desktop
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await found(page, 'b2_desk', 'b2-desk-pass-123', 'security');
    const w0 = await page.evaluate(() => ({ milV: window.siderarium.client.state.milV, bg: window.siderarium.client.state.companies[window.siderarium.client.company].background }));
    check(w0.milV === 1 && w0.bg === 'security', 'standard world runs B-2; security start', w0);
    const auto = await page.waitForSelector('.mil-modal', { timeout: 10000 }).then(() => true, () => false);
    check(auto, 'the military screen opens by itself once for a new security company');
    const guide = auto ? await page.innerText('.mil-guide') : '';
    check(/첫 군사 사업/.test(guide) && /계약 게시판/.test(guide) && /전력/.test(guide), 'guide: steps, fleet power, advice', { guide: guide.slice(0, 700) });
    await page.screenshot({ path: `${outDir}/guide-1440.png` });
    await page.click('[data-a="close"]'); await page.waitForTimeout(300);
    check(await page.isVisible('#milBtn') && !(await page.$('.mil-modal')), 'closes; the top bar keeps a 군사 계약 button', { text: await page.innerText('#milBtn').catch(() => '') });
    // wait for real offers (stations post on a rotating sweep)
    let offers = 0;
    for (let i = 0; i < 90 && offers < 2; i++) { await page.waitForTimeout(2000); offers = await page.evaluate(() => Object.values(window.siderarium.client.state.contracts).filter(k => k.kind === 'mil' && !k.done && !k.takenBy).length); }
    check(offers >= 1, 'the world posts military contracts', { offers });
    await page.click('#milBtn'); await page.waitForSelector('.mil-modal', { timeout: 5000 });
    await page.click('[data-a="tab"][data-id="board"]'); await page.waitForTimeout(400);
    const cards = await page.$$eval('.mil-card', c => c.map(x => x.innerText.replace(/\s+/g, ' ')));
    check(cards.length >= 1 && cards.every(t => /기본 보수/.test(t) && /권장 전력/.test(t) && /예상 순익/.test(t) && /위험/.test(t) && /예상 시간/.test(t)), 'board cards: pay, bonus, time, risk, recommended power, net range', cards.slice(0, 3));
    await page.screenshot({ path: `${outDir}/board-1440.png` });
    // accept the best-fitting offer (first card: the board sorts fit first)
    const pick = await page.evaluate(() => { const c = document.querySelector('.mil-card [data-a="accept"]'); const s = c?.closest('.mil-card')?.querySelector('select'); return { id: c?.getAttribute('data-id'), group: s?.value }; });
    if (pick.id) {
      await page.click(`[data-a="accept"][data-id="${pick.id}"]`); await page.waitForTimeout(2500);
      const after = await page.evaluate(([id, g]) => { const st = window.siderarium.client.state, me = window.siderarium.client.company; const k = st.contracts[id]; return { taken: k?.takenBy === me, group: k?.mil?.group, op: st.groups[g]?.op?.k, type: k?.mil?.type }; }, [pick.id, pick.group]);
      check(after.taken && after.group === pick.group && after.op && after.op !== 'idle' && after.op !== 'dock', 'accept on the page: taken by us with the chosen fleet, which sorties', after);
      const act = await page.innerText('.mil-body');
      check(/투입/.test(act) && /기한/.test(act) && (await page.$('.mil-bar')), 'progress tab shows the contract with a progress bar', { act: act.slice(0, 400) });
      await page.screenshot({ path: `${outDir}/active-1440.png` });
      // station contract tab routes military contracts here
      await page.click('[data-a="close"]'); await page.waitForTimeout(300);
      const sid = await page.evaluate(id => window.siderarium.client.state.contracts[id].stationId, pick.id);
      await page.evaluate(id => window.siderarium.hud?.openStation?.(id, 'contracts'), sid);
      await page.waitForTimeout(500);
      const route = await page.$(`[data-milopen="${pick.id}"]`);
      check(!!route || !(await page.evaluate(() => !!window.siderarium.hud)), 'station contract tab shows a 군사 계약 button for military contracts', { hud: await page.evaluate(() => !!window.siderarium.hud) });
      if (route) { await route.click(); await page.waitForSelector('.mil-modal', { timeout: 5000 }); check(await page.$(`.mil-card.focus[data-k="${pick.id}"]`), 'the button opens the military screen on that contract'); }
      else { await page.keyboard.press('Escape'); await page.click('#milBtn'); await page.waitForSelector('.mil-modal'); }
      await page.click('[data-a="tab"][data-id="active"]'); await page.waitForTimeout(300);
      // abandon: two clicks
      await page.click(`[data-a="cancel"][data-id="${pick.id}"]`); await page.waitForTimeout(200);
      const warn = await page.innerText('.mil-body');
      check(/정말 포기/.test(warn) && /신뢰도/.test(warn), 'abandon asks for confirmation and states the penalty');
      await page.click(`[data-a="cancel"][data-id="${pick.id}"]`); await page.waitForTimeout(2500);
      const done = await page.evaluate(id => { const st = window.siderarium.client.state; const k = st.contracts[id]; const co = st.companies[window.siderarium.client.company]; return { done: k?.done, log: (co.milLog ?? []).map(r => ({ id: r.id, ok: r.ok, why: r.why, net: r.net, refund: r.refund })) }; }, pick.id);
      check(done.done && done.log.some(r => r.id === pick.id && !r.ok), 'abandon settles on the server as a failure with a P&L row', done);
      await page.click('[data-a="tab"][data-id="results"]'); await page.waitForTimeout(300);
      const tab = await page.$$eval('.mil-table tbody tr', r => r.map(x => x.innerText.replace(/\s+/g, ' ')));
      check(tab.length >= 1 && /계약 포기/.test(tab[0]), 'results tab shows the settled row', tab);
      await page.screenshot({ path: `${outDir}/results-1440.png` });
    } else check(false, 'no accept button on the board', { cards });
    await page.click('[data-a="tab"][data-id="post"]'); await page.waitForTimeout(300);
    check(/호위 의뢰/.test(await page.innerText('.mil-body')), 'escort-request tab renders');
    await page.screenshot({ path: `${outDir}/post-1440.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'desktop: no horizontal scroll');
    await ctx.close();
    // ---- phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await found(page, 'b2_phone', 'b2-phone-pass-123', 'veteran');
    const pauto = await page.waitForSelector('.mil-modal', { timeout: 10000 }).then(() => true, () => false);
    check(pauto, 'phone: the screen opens by itself for a veteran start');
    await page.screenshot({ path: `${outDir}/guide-390.png` });
    check(await noHScroll(page) && await boxNoHScroll(page), 'phone: guide without horizontal scroll');
    await page.click('[data-a="tab"][data-id="board"]'); await page.waitForTimeout(400);
    check(await noHScroll(page) && await boxNoHScroll(page), 'phone: board without horizontal scroll', { cards: await page.$$eval('.mil-card', c => c.length) });
    await page.evaluate(() => document.querySelector('.mil-card')?.scrollIntoView());
    await page.screenshot({ path: `${outDir}/board-390.png` });
    await page.click('[data-a="tab"][data-id="results"]'); await page.waitForTimeout(300);
    check(await noHScroll(page), 'phone: results tab without page-level horizontal scroll');
    await page.click('[data-a="close"]'); await page.waitForTimeout(300);
    const btn = await page.evaluate(() => { const e = document.getElementById('milBtn'); if (!e) return null; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { w: r.width, h: r.height, covered: !!hit && !e.contains(hit) }; });
    check(btn && btn.w > 0 && !btn.covered, 'phone: top-bar button reachable', btn);
    await page.screenshot({ path: `${outDir}/hud-390.png` });
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
