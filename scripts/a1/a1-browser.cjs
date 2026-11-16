// A-1 browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, empty storage, no
// world flags → the integrated standard world). Through the real UI:
//  - the menu finds the server; a signed-in account joins and gets the PMC-creation screen, which states the real
//    starting funds and station; founding the PMC enters the world
//  - client state: six P10 factions, the integrated rule versions; the company's funds equal what the screen promised
//  - the HUD reads 신용도; 본부 → 평판·관계 lists the six factions; 1440 and 390 px; no page or console errors
//   node scripts/a1/a1-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a1/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a1-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '41', SAVE_INTERVAL_S: '1' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'COMBAT_P11', 'FLEET_OPS_P12', 'AUTO_LOGISTICS_P125', 'SALVAGE_P131', 'PIRACY_P132', 'BLACKMARKET_P133', 'LAW_P134', 'REPUTATION_P14', 'ECON_PRICING']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 120 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
  async function join(viewport, loginId, pmc) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp: viewport.width, type: m.type(), text: m.text().slice(0, 300) }); });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const st = await page.evaluate(async id => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'a1-browser-pass-123', confirm: 'a1-browser-pass-123' }) })).status, loginId);
    // a signed-out visitor's first load asks /api/auth/me and gets 401 (the menu then offers sign-in): that is the
    // normal signed-out path, so what the console showed before the account existed is kept apart
    report.preSignup = (report.preSignup ?? []).concat(report.console.splice(0).filter(c => c.vp === viewport.width));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 });
    await page.click('#mpJoin');
    await page.waitForSelector('#pmcCreate #pmcNew', { timeout: 30000 });
    const prompt = await page.evaluate(() => { const d = document.querySelector('#pmcCreate [data-pmc-start]'); return { start: Number(d?.dataset.pmcStart), text: d?.innerText ?? '' }; });
    await page.screenshot({ path: `${outDir}/pmc-create-${viewport.width}.png` });
    await page.fill('#pmcNew', pmc);
    await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    return { page, ctx, signup: st, prompt };
  }
  const state = page => page.evaluate(() => { const st = window.siderarium.client.state, me = window.siderarium.client.company; return { factions: Object.keys(st.factions ?? {}).sort(), systems: Object.keys(st.systems).length, v: { factionEcon: st.factionEcon, combatV: st.combatV, opsV: st.opsV, logisticsV: st.logisticsV, salvageV: st.salvageV, piracyV: st.piracyV, blackMarketV: st.blackMarketV, lawV: st.lawV, repV: st.repV }, credits: st.companies[me].credits, home: st.companies[me].homeStation, homeName: st.stations[st.companies[me].homeStation]?.name, ships: Object.values(st.ships).filter(s => s.owner === me).length }; });
  try {
    check(log.includes('world created') && /"layout":"p10"/.test(log), 'server: an empty storage with no flags created the standard world', /rules=[^\n]*/.exec(log)?.[0]);
    const { page, ctx, signup, prompt } = await join({ width: 1440, height: 900 }, 'a1_browser_a', '통합 검증 PMC');
    check(signup === 200, 'signup through the page', { signup });
    const s = await state(page);
    check(prompt.start > 0 && prompt.text.includes(`${prompt.start.toLocaleString('en-US')} cr`) && prompt.text.includes(s.homeName), 'PMC-creation screen states the starting funds and the home station', prompt);
    check(JSON.stringify(s.factions) === JSON.stringify(['ceres', 'guild', 'iron', 'miners', 'pirates', 'union']), 'client: six P10 factions', s.factions);
    check(s.v.factionEcon === 2 && s.v.combatV === 2 && s.v.opsV === 1 && s.v.logisticsV === 1 && s.v.salvageV === 1 && s.v.piracyV === 1 && s.v.blackMarketV === 1 && s.v.lawV === 1 && s.v.repV === 1, 'client: every integrated rule is on', s.v);
    check(s.systems >= 1, 'client: the map has systems', { systems: s.systems });
    check(Math.abs(s.credits - prompt.start) < 50 && s.ships === 5, 'the new company holds the promised funds and the five starter ships', { credits: s.credits, ships: s.ships });
    check(await page.evaluate(() => document.body.innerText.includes('신용도')), 'HUD reads 신용도');
    await page.screenshot({ path: `${outDir}/map-1440.png` });
    await page.evaluate(() => window.siderarium.hud.openOperations('rep')); await page.waitForTimeout(900);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-rep-panel] [data-rep-faction]')].map(r => r.dataset.repFaction).sort());
    check(rows.length === 6, '본부 → 평판·관계: six faction rows', rows);
    await page.screenshot({ path: `${outDir}/rep-1440.png` });
    await ctx.close();
    const m = await join({ width: 390, height: 844 }, 'a1_browser_b', '모바일 PMC');
    const g = await m.page.evaluate(() => ({ pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 }));
    check(m.prompt.start > 0 && !g.pageOverflow, '390px: a second account founds its PMC; no horizontal page scroll', { prompt: m.prompt.start, ...g });
    await m.page.screenshot({ path: `${outDir}/map-390.png` });
    await m.ctx.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outDir}/server.log`, log);
  await browser.close();
  srv.kill('SIGTERM');
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length}`);
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
