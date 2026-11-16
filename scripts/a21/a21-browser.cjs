// A-2.1 browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world).
//  1. an account founds its PMC through the real UI; the server saves and stops
//  2. harness: the save is edited so that company is two hours into arrears (stage 4, debt 15,000 cr, no credits) —
//     the state a player finds after a long absence; the server restarts from that save
//  3. through the real page: the running-cost panel shows the debt, its growth, the restrictions, the recovery
//     tools and the return condition; the two miners are named for a recovery sortie with the panel's buttons;
//     a mining order makes them leave the dock while the guard ships stay held; 1440 and 390 px; no page errors
//   node scripts/a21/a21-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a21/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a21-browser-'));
  const save = path.join(dir, 'world.json');
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: save, WORLD_SEED: '41', SAVE_INTERVAL_S: '1' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'COMBAT_P11', 'FLEET_OPS_P12', 'AUTO_LOGISTICS_P125', 'SALVAGE_P131', 'PIRACY_P132', 'BLACKMARKET_P133', 'LAW_P134', 'REPUTATION_P14', 'ECON_PRICING']) delete env[k];
  let log = '', srv;
  const start = async () => {
    srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
    const mark = log.length;
    srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
    for (let i = 0; i < 160 && !log.slice(mark).includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  };
  const stop = () => new Promise(r => { srv.once('exit', r); srv.kill('SIGTERM'); });
  const base = `http://127.0.0.1:${port}`;
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = (page, vp) => {
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp, type: m.type(), text: m.text().slice(0, 300) }); });
  };
  const LOGIN = 'a21_browser', PASS = 'a21-browser-pass-123';
  try {
    await start();
    // ---- 1. found the PMC through the page
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([id, pw]) => fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw, confirm: pw }) }), [LOGIN, PASS]);
    report.console.splice(0);   // the signed-out first load's 401 on /api/auth/me is the normal path (see A-1)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    await page.waitForSelector('#pmcCreate #pmcNew', { timeout: 30000 });
    await page.fill('#pmcNew', '회생 검증 PMC'); await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    const me = await page.evaluate(() => window.siderarium.client.company);
    await page.waitForTimeout(2500);
    await ctx.close();
    await stop();
    // ---- 2. harness: the company is two hours into arrears after a long absence
    const raw = JSON.parse(fs.readFileSync(save, 'utf8'));
    const w = typeof raw.world === 'string' ? JSON.parse(raw.world) : raw.world ?? raw;
    const co = w.companies[me]; const u = co.upkeep;
    co.credits = 0;
    u.debt = 15000; u.debtU = (15000n * 1000000000n).toString();
    u.debtSince = u.since = w.time - 7300; u.stage = 4;
    if (typeof raw.world === 'string') raw.world = JSON.stringify(w); else if (raw.world) raw.world = w; else Object.assign(raw, w);
    fs.writeFileSync(save, JSON.stringify(raw));
    check(true, 'harness: save edited to arrears stage 4, debt 15,000 cr, credits 0', { company: me, saveKeys: Object.keys(raw).slice(0, 8) });
    await start();
    // ---- 3. back in through the page
    for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
      page = await ctx.newPage(); watch(page, vp.width);
      await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(async ([id, pw]) => fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw }) }), [LOGIN, PASS]);
      report.console.splice(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
      await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state && window.siderarium.hud, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const top = await page.evaluate(() => document.querySelector('[data-upkeep]')?.innerText ?? '');
      if (vp.width === 1440) check(/예비역 전환 제안/.test(top), 'top bar shows the arrears stage (no other HUD change)', { top });
      await page.evaluate(() => document.querySelector('[data-upkeep]').click());
      await page.waitForSelector('.upk .recov', { timeout: 10000 });
      const panel = await page.evaluate(() => document.querySelector('.upk').innerText);
      if (vp.width === 1440) {
        check(/총체납\s*1[45],\d{3}/.test(panel) && /시간당 약/.test(panel), 'panel: total debt and how fast it grows', { text: panel.slice(0, 300) });
        check(/적용 중인 제약/.test(panel) && /신규 출항 보류/.test(panel) && /군사 작전/.test(panel), 'panel: restrictions in force');
        check(/회생 운항/.test(panel) && /긴급 매각/.test(panel) && /재고 판매/.test(panel), 'panel: recovery tools listed');
        check(/정상 운용 복귀 조건: 미납금 0 cr/.test(panel), 'panel: the condition for normal operation');
        const btn = await page.evaluate(() => [...document.querySelectorAll('[data-recov]')].map(b => b.innerText));
        check(btn.filter(t => t === '회생 운항').length === 2 && btn.filter(t => t === '회생 이동').length === 3, 'panel: 회생 운항 on both miners, 회생 이동 on the three warships', btn);
        check(await page.evaluate(() => document.querySelectorAll('[data-recsell]').length) >= 3, 'panel: emergency-sale buttons with the yard price');
        await page.screenshot({ path: `${outDir}/panel-before-1440.png` });
        // name both miners with the panel's buttons
        for (let i = 0; i < 2; i++) {
          await page.evaluate(() => [...document.querySelectorAll('[data-recov]')].find(b => b.innerText === '회생 운항').click());
          await page.waitForTimeout(1200);
        }
        const s1 = await page.evaluate(() => { const st = window.siderarium.client.state, me = window.siderarium.client.company; return { named: Object.values(st.ships).filter(s => s.owner === me && s.recovery).map(s => s.hull ?? s.classId), recovery: !!st.companies[me].upkeep.recovery }; });
        check(s1.named.length === 2 && s1.named.every(h => /miner/.test(h)) && s1.recovery, 'two miners named through the panel; the recovery is open', s1);
        const panel2 = await page.evaluate(() => document.querySelector('.upk').innerText);
        check(/2\/2척 지정/.test(panel2) && /회생 진행/.test(panel2) && /상환/.test(panel2), 'panel: sortie state and repayment progress', { text: panel2.slice(0, 400) });
        await page.screenshot({ path: `${outDir}/panel-named-1440.png` });
        // order the miners to mine (the normal order); they leave, the guard stays
        const ok = await page.evaluate(async () => { const st = window.siderarium.client.state, me = window.siderarium.client.company; const g = Object.values(st.groups).find(g => g.owner === me && g.name === '제1 채굴반'); return window.siderarium.hud.cmd({ c: 'setOp', group: g.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } }); });
        await page.waitForTimeout(20000);
        const s2 = await page.evaluate(() => { const st = window.siderarium.client.state, me = window.siderarium.client.company; const ships = Object.values(st.ships).filter(s => s.owner === me); return { miners: ships.filter(s => /miner/.test(s.hull ?? s.classId)).map(s => s.state), others: ships.filter(s => !/miner/.test(s.hull ?? s.classId)).map(s => s.state) }; });
        check(ok && s2.miners.every(x => x !== 'docked') && s2.others.every(x => x === 'docked'), 'mining order: the named miners left the dock, the warships stayed held', s2);
      } else {
        const g = await page.evaluate(() => ({ pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, panel: (() => { const r = document.querySelector('.upkwrap').getBoundingClientRect(); return { left: r.left, right: r.right, vw: window.innerWidth }; })() }));
        check(!g.pageOverflow && g.panel.left >= 0 && g.panel.right <= g.panel.vw + 1, '390px: the panel with the recovery block fits, no horizontal page scroll', g);
        await page.screenshot({ path: `${outDir}/panel-390.png` });
      }
      await ctx.close();
    }
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 800) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outDir}/server.log`, log);
  await browser.close();
  try { await stop(); } catch {}
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length}`);
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
