// A-3.2b browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world).
//  1. a new salvager company (1440 px): the first-business guide opens by itself with the salvager steps, the fleet's
//     roles, nearby targets (kind, jumps, security, route risk, expected goods and value, legality) and the
//     "회수품 자동 판매" choice
//  2. 인양 시작 on a safe derelict: the group's order is `recover` on that target and the sales policy is set;
//     the fleet recovers, unloads (first_salvage) and the goods are sold; the guide shows recovered goods and sales
//  3. the contract board: 수주 is an explicit click; the reward is reserved from the station (escrow)
//  4. a second salvager on a 390 px phone: the guide fits; a risky target asks first and cancelling sends nothing
//   node scripts/a32b/a32b-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a32b/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a32b-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '21', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'COMBAT_P11', 'FLEET_OPS_P12', 'AUTO_LOGISTICS_P125', 'SALVAGE_P131', 'PIRACY_P132', 'BLACKMARKET_P133', 'LAW_P134', 'REPUTATION_P14', 'ECON_PRICING', 'DERELICTS_A32B_MIGRATE']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 160 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 700) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = (page, vp) => {
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp, type: m.type(), text: m.text().slice(0, 300) }); });
  };
  const signUp = async (page, id, pw) => {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([id, pw]) => fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw, confirm: pw }) }), [id, pw]);
    report.console.splice(0);   // the signed-out first load's 401 on /api/auth/me is the normal path (see A-1)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
  };
  const found = async (page, name, bg, tap) => {
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    await page.fill('#pmcNew', name);
    if (tap) await page.tap(`[data-bg="${bg}"]`); else await page.click(`[data-bg="${bg}"]`);
    if (tap) await page.tap('#pmcGo'); else await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
  };
  const fbText = page => page.evaluate(() => document.querySelector('.fbwrap')?.innerText ?? '');
  const state = page => page.evaluate(() => {
    const c = window.siderarium.client, w = c.state, co = w.companies[c.company];
    const g = Object.values(w.groups).find(x => x.owner === c.company);
    return { credits: Math.round(co.credits), milestones: co.milestones, op: g?.op, sales: Object.keys(co.procurement?.sales ?? {}), salvage: co.salvage, ledger: co.ops?.ledger ?? [], time: Math.round(w.time),
      contracts: Object.values(w.contracts).filter(k => k.kind === 'salvage').map(k => ({ id: k.id, takenBy: k.takenBy, escrow: k.escrow, reward: k.reward, station: k.stationId, done: k.done })) };
  });
  try {
    // ---- 1–3: the salvager on a desktop
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await signUp(page, 'a32b_salv', 'a32b-salvager-pass-123');
    await found(page, '첫 인양 PMC', 'salvager');
    await page.waitForSelector('.fbwrap .fb', { timeout: 20000 });
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    const t1 = await fbText(page);
    check(/첫 사업 — 우주 인양업자/.test(t1) && /인양 대상 고르기/.test(t1) && /자금 12,000/.test(t1) && /회수품 자동 판매/.test(t1), 'salvager: the guide opens by itself with steps, cash and the auto-sale choice', { t1: t1.slice(0, 700) });
    check(/수송선 —/.test(t1) && /채굴선 —/.test(t1) && /공작선 —/.test(t1), 'the guide explains what each starting ship does on a site', { t1: t1.slice(0, 900) });
    const rows = await page.evaluate(() => [...document.querySelectorAll('.fbtrades tr[data-fbsalv]')].map(r => ({ i: r.dataset.fbsalv, text: r.innerText.replace(/\s+/g, ' '), risky: !!r.querySelector('button.warn') })));
    check(rows.length >= 3 && rows.every(r => /치안 \d+/.test(r.text) && /경로 (안전|주의|위험) \d+/.test(r.text) && /(점프|같은 성계)/.test(r.text)) && rows.some(r => /유기선 \(소형·초보\)/.test(r.text) && /소유자 없음 — 합법 인양/.test(r.text)), 'target rows: kind, distance, security, route risk, expected goods/value and legality', rows.slice(0, 4));
    await page.screenshot({ path: `${outDir}/salvager-guide-1440.png` });
    const pick = rows.find(r => !r.risky && /유기선/.test(r.text));
    await page.click(`[data-fbrecover="${pick.i}"]`);
    await page.waitForFunction(() => { const c = window.siderarium.client, g = Object.values(c.state.groups).find(x => x.owner === c.company); return g?.op?.k === 'recover'; }, null, { timeout: 20000 });
    const s1 = await state(page);
    check(s1.op.k === 'recover' && s1.sales.includes('alloy') && s1.sales.includes('metal'), '인양 시작 orders recover on that target and turns the salvage auto-sale on', { op: s1.op, sales: s1.sales, pick: pick.text.slice(0, 160) });
    // recover → unload → sale (real time on the server, 1 s = 1 game s)
    await page.waitForFunction(() => { const c = window.siderarium.client; return c.state.companies[c.company].milestones.includes('first_salvage'); }, null, { timeout: 300000, polling: 2000 });
    const s2 = await state(page);
    check(s2.milestones.includes('first_salvage') && s2.salvage?.units > 0, 'the fleet recovers and unloads: first salvage', { time: s2.time, salvage: s2.salvage });
    await page.waitForFunction(() => { const c = window.siderarium.client; return (c.state.companies[c.company].ops?.ledger ?? []).some(b => (b.inc?.sales ?? 0) > 0); }, null, { timeout: 240000, polling: 2000 });
    await page.evaluate(() => document.querySelector('[data-fbclose]')?.click());
    await page.evaluate(() => document.getElementById('fbBtn')?.click());
    await page.waitForTimeout(1500);
    const t2 = await fbText(page);
    check(/회수 누계/.test(t2) && /품목별 판매/.test(t2) && /✓ 정거장 하역/.test(t2), 'after unloading the guide shows the recovered goods, the sales and the step done', { t2: t2.slice(0, 900) });
    await page.screenshot({ path: `${outDir}/salvager-result-1440.png` });
    // ---- 3: contract board (explicit accept → reward reserved from the station)
    const hasBoard = await page.waitForSelector('.fbwrap [data-fbaccept]', { timeout: 420000 }).then(() => true, () => false);
    if (hasBoard) {
      const before = await state(page);
      const id = await page.$eval('.fbwrap [data-fbaccept]', b => b.dataset.fbaccept);
      check(!before.contracts.find(k => k.id === id)?.takenBy, 'a posted salvage contract is not taken until the player clicks 수주', { id });
      await page.click(`[data-fbaccept="${id}"]`);
      await page.waitForFunction(id => { const c = window.siderarium.client; return c.state.contracts[id]?.takenBy === c.company; }, id, { timeout: 20000 });
      const after = await state(page), k = after.contracts.find(x => x.id === id);
      check(k.takenBy && k.escrow === k.reward, '수주: the contract is ours and its reward is reserved from the station (escrow)', k);
      const t3 = await fbText(page);
      check(/내 인양 계약/.test(t3), 'the guide shows the accepted contract with its progress', { t3: t3.slice(0, 400) });
    } else check(false, 'a salvage contract appeared on the board within 7 minutes', { contracts: (await state(page)).contracts });
    await ctx.close();
    // ---- 4: a phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await signUp(page, 'a32b_phone', 'a32b-phone-pass-123');
    await found(page, '모바일 인양', 'salvager', true);
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    const g = await page.evaluate(() => { const e = document.querySelector('.fbwrap'), r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, text: e.innerText }; });
    check(g.l >= 0 && g.r <= g.vw + 1 && !g.overflow && /인양 시작/.test(g.text), '390px: the salvager guide fits the screen', { l: g.l, r: g.r, vw: g.vw, overflow: g.overflow });
    await page.screenshot({ path: `${outDir}/salvager-guide-390.png` });
    const risky = await page.$('.fbwrap button.warn[data-fbrecover]');
    if (risky) {
      let asked = '';
      page.once('dialog', d => { asked = d.message(); d.dismiss(); });
      await risky.tap(); await page.waitForTimeout(1500);
      const s4 = await state(page);
      check(/경로 위험/.test(asked) && s4.op?.k !== 'recover', 'a risky target asks first; cancelling sends no order', { asked, op: s4.op });
    } else check(true, 'no risky target listed within 3 jumps for this start (nothing to confirm)');
    await ctx.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 800) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outDir}/server.log`, log);
  await browser.close();
  await new Promise(r => { srv.once('exit', r); srv.kill('SIGTERM'); });
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length}`);
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
