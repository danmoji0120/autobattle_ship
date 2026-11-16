// A-3.1 browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world).
//  1. a new account opens the PMC creation screen: six backgrounds with the server's real terms (1440 px)
//  2. a card shows its detail (station, ships, funds, standing, running cost, activities, difficulty); founding
//     without a background is refused on the page; the company is founded with the chosen background
//  3. the client state matches the background (home station, fleet docked there, funds, standing)
//  4. the server restarts from its save; re-login enters the same company with the same assets (no second grant)
//  5. a second account founds a different background on a 390 px phone: the cards fit, the detail opens, the
//     company starts somewhere else; no page or console errors
//   node scripts/a31/a31-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a31/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a31-browser-'));
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
  const signIn = async (page, id, pw, signup) => {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([id, pw, signup]) => fetch(signup ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signup ? { loginId: id, password: pw, confirm: pw } : { loginId: id, password: pw }) }), [id, pw, signup]);
    report.console.splice(0);   // the signed-out first load's 401 on /api/auth/me is the normal path (see A-1)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
  };
  const stateOf = page => page.evaluate(() => {
    const st = window.siderarium.client.state, me = window.siderarium.client.company, co = st.companies[me];
    const ships = Object.values(st.ships).filter(s => s.owner === me);
    return { me, name: co.name, background: co.background, home: co.homeStation, credits: Math.round(co.credits), standing: co.standing, ships: ships.map(s => ({ id: s.id, hull: s.hull ?? s.classId, state: s.state, at: s.task && s.task.station })) };
  });
  const A = { id: 'a31_browser', pw: 'a31-browser-pass-123' }, B = { id: 'a31_phone', pw: 'a31-phone-pass-123' };
  try {
    await start();
    // ---- 1–3: desktop, the salvager
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await signIn(page, A.id, A.pw, true);
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-bg]')].map(c => ({ id: c.dataset.bg, text: c.innerText.replace(/\s+/g, ' ') })));
    check(cards.length === 6 && ['hauler', 'miner', 'salvager', 'security', 'veteran', 'raider'].every(id => cards.some(c => c.id === id)), 'six background cards', cards);
    check(cards.every(c => /cr/.test(c.text) && /난이도/.test(c.text) && /운영비/.test(c.text)), 'each card: faction, place, funds, ships, running cost, difficulty', cards.map(c => c.text));
    await page.screenshot({ path: `${outDir}/create-1440.png` });
    // refused without a background
    await page.fill('#pmcNew', '인양 검증 PMC'); await page.click('#pmcGo');
    check(/창업 배경을 선택/.test(await page.innerText('#pmcErr')), 'founding without a background is refused on the page');
    await page.click('[data-bg="salvager"]');
    const det = await page.innerText('#bgDetail');
    check(/세레스 제련단지/.test(det) && /공작선/.test(det) && /12,000 cr/.test(det) && /세레스 공업연맹 \+10/.test(det) && /시간당 약/.test(det) && /추천 활동/.test(det) && /난이도 보통/.test(det), 'detail: station, ships, funds, standing, running cost, activities, difficulty', { det: det.slice(0, 700) });
    const shownUpkeep = Number(await page.getAttribute('[data-bg-upkeep]', 'data-bg-upkeep'));
    await page.screenshot({ path: `${outDir}/salvager-detail-1440.png` });
    await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    const s1 = await stateOf(page);
    check(s1.background === 'salvager' && s1.home === 'p9_ceres_works' && s1.credits >= 11900 && s1.ships.length === 3 && s1.ships.every(s => s.state === 'docked' && s.at === 'p9_ceres_works') && s1.standing?.ceres === 10,
      'founded at Ceres with the salvage fleet, funds and standing shown', s1);
    const up = await page.evaluate(() => document.querySelector('[data-upkeep]')?.innerText ?? '');
    check(up.length > 0, 'top bar running cost after founding', { up, shownUpkeep });
    await page.screenshot({ path: `${outDir}/after-found-1440.png` });
    await ctx.close();
    await stop();
    // ---- 4: restart, re-login
    await start();
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage(); watch(page, 1440);
    await signIn(page, A.id, A.pw, false);
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const s2 = await stateOf(page);
    check(s2.me === s1.me && s2.background === 'salvager' && s2.home === s1.home && JSON.stringify(s2.ships.map(s => s.id).sort()) === JSON.stringify(s1.ships.map(s => s.id).sort()) && !(await page.$('#pmcCreate')),
      'after restart and re-login: same company, origin and ships, no creation screen', s2);
    await ctx.close();
    // ---- 5: phone, the miner
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await signIn(page, B.id, B.pw, true);
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    const g = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, cards: [...document.querySelectorAll('[data-bg]')].map(c => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; }), vw: window.innerWidth }));
    check(!g.overflow && g.cards.length === 6 && g.cards.every(c => c.l >= 0 && c.r <= g.vw + 1), '390px: six cards fit, no horizontal scroll', g);
    await page.screenshot({ path: `${outDir}/create-390.png`, fullPage: true });
    await page.fill('#pmcNew', '앤빌 채굴 PMC');
    await page.tap('[data-bg="miner"]');
    await page.waitForTimeout(600);
    const d2 = await page.evaluate(() => { const e = document.querySelector('#bgDetail'); const r = e.getBoundingClientRect(); return { text: e.innerText, l: r.left, r: r.right, vw: window.innerWidth }; });
    check(/앤빌 광부조합/.test(d2.text) && /채굴선/.test(d2.text) && d2.l >= 0 && d2.r <= d2.vw + 1, '390px: the miner detail opens inside the screen', { l: d2.l, r: d2.r, text: d2.text.slice(0, 300) });
    await page.screenshot({ path: `${outDir}/miner-detail-390.png` });
    await page.tap('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(2000);
    const s3 = await stateOf(page);
    check(s3.background === 'miner' && s3.home === 'p9_anvil_port' && s3.ships.length === 4 && s3.ships.every(s => s.at === 'p9_anvil_port') && s3.me !== s1.me, 'phone account founded at Anvil — a different place from the first', s3);
    await page.screenshot({ path: `${outDir}/after-found-390.png` });
    await ctx.close();
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
