// A-3.2b.1 browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world):
//  1. the salvager guide shows the operating status and the band/threat labels; recommended targets first
//  2. a caution target (31–55) asks and cancel sends nothing (when one is listed)
//  3. a hostile armed ship at a safe target (client-view injection, the server is untouched): shown apart from route
//     risk; asks; cancel sends nothing; confirm sends exactly that target
//  4. 사업 중단 (client-view injection: our ships removed from the view) shows cash, replacement ships and the way back
//  5. 390 px: fits; a recommended target is sent without a question
//   node scripts/a32b1/a32b1-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a32b1/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a32b1-browser-'));
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
  // the guide's own rows; `name` is what the confirmation names
  const rows = page => page.evaluate(() => [...document.querySelectorAll('.fbtrades tr[data-fbsalv]')].map(r => ({ i: r.dataset.fbsalv, text: r.innerText.replace(/\s+/g, ' '), name: r.querySelector('b')?.innerText ?? '', id: r.querySelector('[data-fbrecover]') ? null : null })));
  const reopen = async page => { await page.evaluate(() => document.querySelector('[data-fbclose]')?.click()); await page.evaluate(() => document.getElementById('fbBtn')?.click()); await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 }); };
  try {
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await signUp(page, 'a32b1_salv', 'a32b1-salvager-pass-123');
    await found(page, '안정화 인양', 'salvager');
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    // 1. operating status and recommended targets
    const t1 = await fbText(page);
    check(/운영 상태: 정상 운영/.test(t1) && /작업선 3척/.test(t1) && /회수 가능: 화물·선체·장비·설계도 조각/.test(t1), 'the guide shows the operating status (정상 운영, 3 work ships, what can be recovered)', { t1: t1.slice(0, 600) });
    const r1 = await rows(page);
    check(r1.length >= 3 && /추천 — 안전 경로/.test(r1[0].text) && r1.every(r => /(추천 — 안전 경로|안전 경로 · 현장 위협|주의 — 출발 전 확인|위험 — 격침 가능)/.test(r.text) && /(적대 함대 미확인|적대 함대 \d+척)/.test(r.text)), 'target rows carry a band label and a separate site-threat line; recommended first', r1.slice(0, 4).map(r => r.text.slice(0, 220)));
    await page.screenshot({ path: `${outDir}/guide-status-1440.png` });
    // 2. a caution target (route risk 31–55) if one is listed: cancel sends nothing, accept sends that very target
    const caution = r1.find(r => /주의 — 출발 전 확인/.test(r.text));
    if (caution) {
      let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
      await page.click(`[data-fbrecover="${caution.i}"]`); await page.waitForTimeout(1500);
      const s = await state(page);
      check(/주의/.test(asked) && /보낼까요/.test(asked) && s.op?.k !== 'recover', 'caution target: asks first; cancel sends no order', { asked, op: s.op });
    } else check(true, 'no caution (31–55) target listed within 3 jumps of Ceres at this time — the caution dialog is covered by the injected-threat check below and unit tests', { bands: r1.map(r => r.text.match(/(추천|주의|위험|현장 위협)/)?.[0]) });
    // 3. a hostile armed ship shown at a safe target (client view injection: a pirate corvette next to the first row's
    //    target). The server is not changed; this checks the guide's text and the confirmation it asks.
    const inj = await page.evaluate(() => {
      const c = window.siderarium.client, w = c.state, o = Object.values(w.wrecks ?? {}).find(x => document.querySelector('.fbtrades tr[data-fbsalv="0"] b')?.textContent === x.name);
      if (!o) return null;
      const any = Object.values(w.ships).find(s => s.owner === 'pirates') ?? Object.values(w.ships)[0];
      const pir = any.owner === 'pirates', copy = JSON.parse(JSON.stringify(any));
      if (!pir) { delete copy.hull; delete copy.variant; copy.classId = 'corvette'; copy.loadoutId = 'gun'; }
      w.ships.zz_probe = { ...copy, id: 'zz_probe', owner: 'pirates', state: 'space', pos: { ...o.pos, x: o.pos.x + 600 }, groupId: 'zz_probe_g', task: { k: 'none' } };
      w.groups.zz_probe_g = { id: 'zz_probe_g', owner: 'pirates', name: 'probe', op: { k: 'idle' }, shipIds: ['zz_probe'] };
      return o.name;
    });
    await reopen(page); await page.waitForTimeout(500);
    const r3 = await rows(page), hit = r3.find(r => r.name === inj);
    check(!!inj && !!hit && /현장\(8k 안\)에 적대 함대 1척 확인/.test(hit.text) && /안전 경로 · 현장 위협/.test(hit.text) && /경로 안전 \d+/.test(hit.text), 'a hostile ship at the site is shown apart from the (unchanged, safe) route risk', { inj, row: hit?.text?.slice(0, 300) });
    if (hit) {
      let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
      await page.click(`[data-fbrecover="${hit.i}"]`); await page.waitForTimeout(1500);
      const s = await state(page);
      check(/경로는 안전/.test(asked) && /적대 무장 함선 1척/.test(asked) && s.op?.k !== 'recover', 'site threat on a safe route: asks first; cancel sends no order', { asked, op: s.op });
      await page.screenshot({ path: `${outDir}/threat-row-1440.png` });
      // confirm: the same target is ordered (never swapped)
      const wid = await page.evaluate(n => Object.values(window.siderarium.client.state.wrecks).find(x => x.name === n)?.id, inj);
      page.once('dialog', d => d.accept());
      await page.click(`[data-fbrecover="${hit.i}"]`); await page.waitForTimeout(2000);
      const s2 = await state(page);
      check(s2.op?.k === 'recover' && s2.op.wreck === wid, 'confirming sends the fleet to exactly the chosen target', { op: s2.op, wid });
    }
    // 4. halted: the client view without our ships (injection) shows 사업 중단 and the comeback block with real yard prices
    await page.evaluate(() => { const c = window.siderarium.client, w = c.state; for (const s of Object.values(w.ships)) if (s.owner === c.company) delete w.ships[s.id]; });
    await reopen(page); await page.waitForTimeout(500);
    const t4 = await fbText(page);
    check(/운영 상태: 사업 중단/.test(t4) && /사업 재개 방법/.test(t4) && /현금 [\d,]+ cr/.test(t4) && /(대체 함선 구입 가능|가장 싼 대체 함선|재고가 없습니다)/.test(t4) && /달성한 이정표는 그대로/.test(t4), 'halted: 사업 중단 with cash, replacement ships and how to restart', { t4: t4.slice(0, 1400) });
    await page.screenshot({ path: `${outDir}/halted-1440.png`, fullPage: false });
    await ctx.close();
    // 5. phone width
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await signUp(page, 'a32b1_phone', 'a32b1-phone-pass-123');
    await found(page, '모바일 안정화', 'salvager', true);
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    const g = await page.evaluate(() => { const e = document.querySelector('.fbwrap'), r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, text: e.innerText }; });
    check(g.l >= 0 && g.r <= g.vw + 1 && !g.overflow && /운영 상태/.test(g.text) && /추천 — 안전 경로/.test(g.text), '390px: the guide with status and bands fits the screen', { l: g.l, r: g.r, vw: g.vw, overflow: g.overflow });
    await page.screenshot({ path: `${outDir}/guide-390.png` });
    // a recommended target sends at once (no question)
    let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
    await page.tap('[data-fbrecover="0"]'); await page.waitForTimeout(2000);
    const s5 = await state(page);
    check(!asked && s5.op?.k === 'recover', 'a recommended target is sent without a question', { asked, op: s5.op });
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
