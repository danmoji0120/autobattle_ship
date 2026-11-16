// AUTO-P0 browser check on a real server (built client + dist-server, standard world): a miner company opens
// 물류 관리, saves a silicate auto-sale and an ore minimum stock with the form, sees them in the table, turns one off
// (1440 px and 390 px). AUTO-P1: also saves mining-hauler sale trips and the automatic repair limits.   node scripts/autop0/autop0-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/autop0/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-autop0-browser-'));
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
    for (const [vp, w, h] of [['1440', 1440, 900], ['390', 390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await ctx.newPage(); watch(page, vp);
      await signUp(page, `autop0_${vp}`, 'autop0-pass-12345');
      await found(page, `재고정책 ${vp}`, 'miner');
      await page.evaluate(() => document.querySelectorAll('.fbwrap').forEach(e => e.remove()));
      await page.evaluate(() => document.getElementById('logisticsBtn').click());
      await page.waitForSelector('.sales-policy [data-sales-form]', { timeout: 20000 });
      const form = '.sales-policy [data-sales-form]';
      await page.selectOption(`${form} select[name=item]`, 'silicate');
      await page.fill(`${form} input[name=minPrice]`, '5');
      await page.click(`${form} button[type=submit]`);
      await page.waitForFunction(() => { const c = window.siderarium.client; return !!c.state.companies[c.company].procurement?.sales?.silicate; }, null, { timeout: 20000 });
      await page.waitForSelector(form, { timeout: 20000 });
      await page.selectOption(`${form} select[name=item]`, 'ore');
      await page.selectOption(`${form} select[name=station]`, 'p9_anvil_port');
      await page.fill(`${form} input[name=keep]`, '500');
      await page.fill(`${form} input[name=minPrice]`, '1');
      await page.click(`${form} button[type=submit]`);
      await page.waitForFunction(() => { const c = window.siderarium.client; return c.state.companies[c.company].procurement?.protectedStock?.p9_anvil_port?.ore === 500; }, null, { timeout: 20000 });
      await page.waitForTimeout(12000);   // one planning pass
      const s = await page.evaluate(() => { const c = window.siderarium.client, p = c.state.companies[c.company].procurement; const el = document.querySelector('.sales-policy'); const r = el.getBoundingClientRect(); return { sales: p.sales, keep: p.protectedStock, status: p.salesStatus, text: el.innerText, l: r.left, r: r.right, vw: innerWidth, sw: document.documentElement.scrollWidth }; });
      check(s.sales.silicate?.minPrice === 5 && s.sales.ore?.minPrice === 1 && s.keep.p9_anvil_port.ore === 500, `${vp}: the form saves the sales policy and the minimum stock on the server`, { sales: s.sales, keep: s.keep });
      check(/규산염/.test(s.text) && /철광석/.test(s.text) && /앤빌 광부조합 500/.test(s.text) && /켜짐 · 최저 5 cr/.test(s.text), `${vp}: the table shows items, the minimum stock and the policy`, { text: s.text.slice(0, 500) });
      check(s.l >= 0 && s.r <= s.vw + 1, `${vp}: the panel fits the screen`, { l: s.l, r: s.r, vw: s.vw, sw: s.sw });
      await page.screenshot({ path: `${outDir}/sales-policy-${vp}.png`, fullPage: false });
      await page.click('.sales-policy [data-sale-off="silicate"]');
      await page.waitForFunction(() => { const c = window.siderarium.client; return !c.state.companies[c.company].procurement?.sales?.silicate; }, null, { timeout: 20000 });
      check(true, `${vp}: the off button turns the item's auto-sale off`);
      // AUTO-P1: allow mining-hauler sale trips and budgeted automatic repair from the same panel
      const ops = '.sales-policy [data-auto-ops-form]';
      await page.waitForSelector(ops, { timeout: 20000 });
      const off = await page.evaluate(() => document.querySelector('[data-auto-ops]').innerText);
      check(/채굴 운반|대기/.test(off) && /내구 100%/.test(off), `${vp}: the hauler list shows each hauler's job and hull`, { text: off.slice(0, 300) });
      await page.check(`${ops} input[name=minerSales]`); await page.check(`${ops} input[name=repair]`);
      await page.fill(`${ops} input[name=minCredits]`, '3000'); await page.fill(`${ops} input[name=maxPerRepair]`, '4000'); await page.fill(`${ops} input[name=perHour]`, '8000');
      await page.click(`${ops} button[type=submit]`);
      await page.waitForFunction(() => { const c = window.siderarium.client, p = c.state.companies[c.company].procurement; return p?.minerSales === true && p?.repair?.enabled === true; }, null, { timeout: 20000 });
      const p1 = await page.evaluate(() => { const c = window.siderarium.client, p = c.state.companies[c.company].procurement; const el = document.querySelector('[data-auto-ops]'), r = el.getBoundingClientRect(); return { minerSales: p.minerSales, repair: { ...p.repair }, checked: [...el.querySelectorAll('input[type=checkbox]')].map(i => i.checked), l: r.left, r: r.right, vw: innerWidth }; });
      check(p1.repair.minCredits === 3000 && p1.repair.maxPerRepair === 4000 && p1.repair.perHour === 8000 && p1.checked.every(Boolean), `${vp}: the form saves sale trips and the repair limits on the server`, p1);
      check(p1.l >= 0 && p1.r <= p1.vw + 1, `${vp}: the auto-ops block fits the screen`, p1);
      await page.evaluate(() => document.querySelector('[data-auto-ops]').scrollIntoView());
      await page.screenshot({ path: `${outDir}/auto-ops-${vp}.png`, fullPage: false });
      await page.fill(`${ops} input[name=perHour]`, '0'); await page.click(`${ops} button[type=submit]`);
      await page.waitForTimeout(1500);
      const rej = await page.evaluate(() => { const c = window.siderarium.client; return { perHour: c.state.companies[c.company].procurement.repair.perHour, body: document.body.innerText }; });
      check(rej.perHour === 8000 && /시간당 수리 예산을 0보다 크게/.test(rej.body), `${vp}: repair with no hourly budget is refused with the reason`, { perHour: rej.perHour });
      await ctx.close();
    }
  } catch (e) { check(false, 'script error', { e: String(e && e.stack || e).slice(0, 800) }); }
  check(report.errors.length === 0, 'no page errors', { errors: report.errors.slice(0, 5) });
  check(report.console.filter(c => c.type === 'error').length === 0, 'no console errors', { errors: report.console.filter(c => c.type === 'error').slice(0, 5) });
  await browser.close(); srv.kill();
  fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1));
  const ok = report.checks.filter(c => c.ok).length; console.log(`${ok}/${report.checks.length}`);
  process.exit(ok === report.checks.length ? 0 : 1);
})();
