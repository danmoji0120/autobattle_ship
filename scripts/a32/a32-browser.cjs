// A-3.2a browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world).
//  1. a new hauler company: the first-business guide opens by itself, shows the steps, P&L and real trades (1440 px)
//  2. the player types an amount and presses 구매·출발: the purchase is paid, a pool sale is created; the hauler
//     sails, sells; the guide shows the sale, purchase and upkeep, and the first-profit milestone when cash rises
//  3. the guide does not open by itself again after a reload; the top-bar button toggles it
//  4. a miner company on a 390 px phone: the guide lists fields and delivery choices inside the screen; choosing
//     one starts the mining op; ore is mined and sold, and the guide shows the sales
//   node scripts/a32/a32-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a32/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a32-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '21', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'COMBAT_P11', 'FLEET_OPS_P12', 'AUTO_LOGISTICS_P125', 'SALVAGE_P131', 'PIRACY_P132', 'BLACKMARKET_P133', 'LAW_P134', 'REPUTATION_P14', 'ECON_PRICING']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 160 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { base, checks: [], errors: [], console: [], timeline: [] };
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
  const co = page => page.evaluate(() => { const c = window.siderarium.client, co = c.state.companies[c.company]; return { credits: Math.round(co.credits), milestones: co.milestones, ledger: co.ops?.ledger ?? [], mined: co.stats?.mined ?? 0, time: Math.round(c.state.time) }; });
  const fbText = page => page.evaluate(() => document.querySelector('.fbwrap')?.innerText ?? '');
  try {
    // ---- 1–3: the hauler on a desktop
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await signUp(page, 'a32_hauler', 'a32-hauler-pass-123');
    await found(page, '첫 운송 PMC', 'hauler');
    await page.waitForSelector('.fbwrap .fb', { timeout: 20000 });
    await page.waitForSelector('.fbwrap [data-fbtrade]', { timeout: 20000 });
    const t1 = await fbText(page);
    check(/첫 사업 — 독립 운송업자/.test(t1) && /거래 기회 고르기/.test(t1) && /자금 30,000/.test(t1) && /지금의 거래 기회/.test(t1), 'hauler: the guide opens by itself with steps, cash and trades', { t1: t1.slice(0, 600) });
    const rows = await page.evaluate(() => [...document.querySelectorAll('.fbtrades tr[data-fbrow]')].map(r => ({ i: r.dataset.fbrow, text: r.innerText.replace(/\s+/g, ' '), risk: Number((r.innerText.match(/항로 \S+ (\d+)/) || [])[1]), jumps: Number((r.innerText.match(/(\d+)점프/) || [])[1]) })));
    check(rows.length >= 3 && rows.every(r => /cr|\d/.test(r.text) && /점프/.test(r.text) && /항로/.test(r.text)), 'trade rows: goods, route, jumps, risk, amount, cost, sale, profit', rows.slice(0, 4));
    await page.screenshot({ path: `${outDir}/hauler-guide-1440.png` });
    // the player picks a short, not-dangerous route and lowers the amount a little
    const pick = rows.filter(r => r.risk <= 55).sort((a, b) => a.jumps - b.jumps)[0] ?? rows[0];
    const amt = await page.$eval(`[data-fbamt="${pick.i}"]`, e => Number(e.value));
    const n = Math.max(1, Math.floor(amt * 0.9));
    await page.fill(`[data-fbamt="${pick.i}"]`, String(n));
    const est = await page.evaluate(i => ({ cost: document.querySelector(`[data-fbcost="${i}"]`).textContent, rev: document.querySelector(`[data-fbrev="${i}"]`).textContent, prof: document.querySelector(`[data-fbprof="${i}"]`).textContent }), pick.i);
    const before = await co(page);
    await page.click(`[data-fbtrade="${pick.i}"]`);
    await page.waitForTimeout(2500);
    const after = await co(page);
    const job = await page.evaluate(() => { const c = window.siderarium.client; return Object.values(c.state.logisticsJobs ?? {}).filter(j => j.owner === c.company).map(j => ({ id: j.id, kind: j.kind, item: j.item, from: j.from, to: j.to, amount: j.amount, state: j.state })); });
    const paid = before.credits - after.credits, estCost = Number(est.cost.replace(/,/g, ''));
    check(job.length === 1 && job[0].kind === 'sell' && job[0].amount === n && Math.abs(paid - estCost) <= Math.max(3, estCost * 0.01), 'buy + pool sale created; the price paid is the estimate shown', { pick: pick.text, n, est, paid, job });
    await page.screenshot({ path: `${outDir}/hauler-shipping-1440.png` });
    // wait for the sale (real time, 1x)
    let done = false, last;
    for (let i = 0; i < 80 && !done; i++) {
      await page.waitForTimeout(5000);
      last = await page.evaluate(() => { const c = window.siderarium.client; const j = Object.values(c.state.logisticsJobs ?? {}).find(j => j.owner === c.company); return j ? { state: j.state, delivered: j.delivered, earned: Math.round(j.earned) } : null; });
      report.timeline.push({ t: i * 5, ...last });
      done = last?.state === 'complete';
    }
    // running costs are billed in batches: wait until the first bill is booked
    for (let i = 0; i < 40; i++) { const c = await co(page); if (c.ledger.some(b => (b.exp?.upkeep ?? 0) > 0)) break; await page.waitForTimeout(5000); }
    await page.waitForTimeout(3000);
    const t2 = await fbText(page), c2 = await co(page);
    check(done && /판매 \+/.test(t2) && /구매 −/.test(t2) && /운영비 −/.test(t2), 'after the sale the guide shows sales, purchase and upkeep', { last, t2: t2.slice(0, 900) });
    const gain = c2.credits - 30000;
    check(gain > 0 ? c2.milestones.includes('first_profit') && /첫 사업 완료/.test(t2) : !c2.milestones.includes('first_profit'), 'first profit is marked exactly when cash is above the founding funds', { gain, milestones: c2.milestones });
    await page.screenshot({ path: `${outDir}/hauler-result-1440.png` });
    // 3: reload — no automatic reopen, the button toggles
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    await page.waitForFunction(() => window.siderarium?.client?.state, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
    const reopened = !!(await page.$('.fbwrap'));
    await page.click('#fbBtn'); await page.waitForTimeout(800);
    const opened = !!(await page.$('.fbwrap'));
    await page.click('#fbBtn'); await page.waitForTimeout(800);
    check(!reopened && opened && !(await page.$('.fbwrap')), 'after reload the guide stays closed; the top-bar button opens and closes it', { reopened, opened });
    await ctx.close();

    // ---- 4: the miner on a phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await signUp(page, 'a32_miner', 'a32-miner-pass-123');
    await found(page, '첫 채굴 PMC', 'miner', true);
    await page.waitForSelector('.fbwrap [data-fbmine]', { timeout: 20000 });
    const g = await page.evaluate(() => { const e = document.querySelector('.fbwrap'), r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, text: e.innerText }; });
    check(g.l >= 0 && g.r <= g.vw + 1 && !g.overflow && /앤빌 철광대/.test(g.text) && /100단위당/.test(g.text) && /안 팔림/.test(g.text) && /채굴선 3척/.test(g.text), '390px: the miner guide fits and lists fields, delivery value, unsold share and roles', { l: g.l, r: g.r, vw: g.vw, text: g.text.slice(0, 500) });
    await page.screenshot({ path: `${outDir}/miner-guide-390.png`, fullPage: false });
    const btn = await page.$('[data-fbmine^="p9_anvil_ore|p9_anvil_port"]');
    await btn.scrollIntoViewIfNeeded(); await btn.tap();
    await page.waitForTimeout(2000);
    const op = await page.evaluate(() => { const c = window.siderarium.client; return Object.values(c.state.groups).filter(g => g.owner === c.company).map(g => g.op); });
    check(op.some(o => o.k === 'mine' && o.field === 'p9_anvil_ore' && o.deliver === 'p9_anvil_port' && o.sell), 'choosing a field and delivery starts the mining op', op);
    let sold = 0;
    for (let i = 0; i < 60 && !sold; i++) { await page.waitForTimeout(5000); const c = await co(page); sold = c.ledger.reduce((a, b) => a + (b.inc?.sales ?? 0), 0); }
    await page.waitForTimeout(2000);
    const t3 = await fbText(page), c3 = await co(page);
    check(sold > 0 && c3.mined > 0 && /품목별 판매/.test(t3) && /판매 \+/.test(t3), 'ore is mined and sold; the guide shows the sales by item', { sold: Math.round(sold), mined: Math.round(c3.mined), credits: c3.credits, t3: t3.slice(0, 700) });
    await page.screenshot({ path: `${outDir}/miner-result-390.png` });
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
