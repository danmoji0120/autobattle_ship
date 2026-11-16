// A-3.2b.2 browser check on a real multiplayer server (built client + `node dist-server/server.mjs`, standard world):
//  1. a recent-battle wreck (client view: a real listed target re-labelled as a battle wreck made 5 minutes ago) shows
//     "최근 전투 n분 전" on its own line, apart from the hostile-fleet line, and is no longer marked 추천
//  2. sending it asks first; cancel sends nothing; confirm sends exactly that target (the server accepts the real id)
//  3. a recommended derelict still goes without a question
//  4. replacement ships (client view: our ships re-labelled → 사업 중단) carry "조선소 열기"; it opens that station's
//     existing shipyard tab with the hull's card picked out; the purchase is confirmed there with the existing button
//     and the server really sells one ship (price taken, one new ship)
//  5. 390 px: the comeback block fits, "조선소 열기" works by tap
//   node scripts/a32b2/a32b2-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/a32b2/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-a32b2-browser-'));
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
    page.on('pageerror', e => report.errors.push(`[${report.checks.length} after: ${report.checks.at(-1)?.label ?? 'start'}] ` + e.message + ' @ ' + String(e.stack ?? '').split('\n').slice(1, 4).join(' | ')));
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
  const op = page => page.evaluate(() => { const c = window.siderarium.client, g = Object.values(c.state.groups).find(x => x.owner === c.company); return g?.op; });
  const rows = page => page.evaluate(() => [...document.querySelectorAll('.fbtrades tr[data-fbsalv]')].map(r => ({ i: r.dataset.fbsalv, text: r.innerText.replace(/\s+/g, ' '), name: r.querySelector('b')?.innerText ?? '', battle: r.querySelector('[data-fbbattle]')?.getAttribute('data-fbbattle') ?? null, threat: r.querySelector('[data-fbthreat]')?.innerText ?? r.querySelector('.fbband')?.innerText ?? '' })));
  const reopen = async page => { await page.evaluate(() => document.querySelector('[data-fbclose]')?.click()); await page.evaluate(() => document.getElementById('fbBtn')?.click()); await page.waitForSelector('.fbwrap', { timeout: 30000 }); await page.waitForTimeout(400); };
  /** the client view only: a real listed derelict re-labelled as a battlefield wreck made `ago` seconds ago */
  const asBattle = (page, ago) => page.evaluate(ago => {
    const w = window.siderarium.client.state;
    const names = [...document.querySelectorAll('.fbtrades tr[data-fbsalv] b')].map(b => b.textContent);
    const o = Object.values(w.wrecks ?? {}).find(x => x.origin === 'derelict' && names.includes(x.name));
    if (!o) return null;
    delete o.origin; o.created = w.time - ago; o.eng = 'zz_eng'; o.ships = 2;
    return { id: o.id, name: o.name };
  }, ago);
  try {
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await signUp(page, 'a32b2_salv', 'a32b2-salvager-pass-123');
    await found(page, '마무리 인양', 'salvager');
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    // 1. recent battle line, separate from the hostile-fleet line
    const bw = await asBattle(page, 300);
    await reopen(page);
    const r1 = await rows(page), hit = r1.find(r => r.name === bw?.name);
    check(!!bw && !!hit && hit.battle === 'recent' && /최근 전투 5분 전/.test(hit.text) && /현장 주변 적대 함대 미확인/.test(hit.text) && !/추천 — 안전 경로/.test(hit.text) && /안전 경로 · 최근 전투/.test(hit.text),
      'a recent-battle wreck shows "최근 전투 n분 전" on its own line apart from the hostile-fleet line and is not 추천', { bw, row: hit?.text?.slice(0, 400) });
    const idx = r1.indexOf(hit), firstNonRec = r1.findIndex(r => !/추천 — 안전 경로/.test(r.text));
    check(hit && idx >= firstNonRec, 'it sorts after every recommended target', { idx, firstNonRec, order: r1.map(r => r.text.slice(0, 40)) });
    await page.screenshot({ path: `${outDir}/recent-battle-1440.png` });
    // 2. asks; cancel → nothing; confirm → that very target
    if (hit) {
      let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
      await page.click(`[data-fbrecover="${hit.i}"]`); await page.waitForTimeout(1500);
      const o1 = await op(page);
      check(/5분 전에 이곳에서 전투/.test(asked) && /지금 보이는 적대 함대는 없지만/.test(asked) && o1?.k !== 'recover', 'recent-battle target: asks first (battle time, no fleet details); cancel sends no order', { asked, op: o1 });
      page.once('dialog', d => d.accept());
      await page.click(`[data-fbrecover="${hit.i}"]`);
      await page.waitForFunction(id => { const c = window.siderarium.client, g = Object.values(c.state.groups).find(x => x.owner === c.company); return g?.op?.k === 'recover' && g.op.wreck === id; }, bw.id, { timeout: 8000 }).catch(() => {});
      const o2 = await op(page);
      check(o2?.k === 'recover' && o2.wreck === bw.id, 'confirming sends the fleet to exactly the chosen target (never refused or swapped)', { op: o2, id: bw.id });
    }
    // 4. halted view → replacement ships → 조선소 열기 → existing yard tab → buy there
    const before = await page.evaluate(() => { const c = window.siderarium.client, w = c.state; return { credits: Math.round(w.companies[c.company].credits), ships: Object.values(w.ships).filter(s => s.owner === c.company).map(s => s.id) }; });
    await page.evaluate(() => { const c = window.siderarium.client, w = c.state; for (const s of Object.values(w.ships)) if (s.owner === c.company) s.owner = 'zz_view_only'; });
    await reopen(page);
    const t4 = await fbText(page);
    const yardBtns = await page.evaluate(() => [...document.querySelectorAll('[data-fbyard]')].map(b => ({ v: b.getAttribute('data-fbyard'), text: b.innerText, row: b.closest('tr')?.innerText.replace(/\s+/g, ' ') })));
    check(/사업 중단/.test(t4) && yardBtns.length >= 1 && yardBtns.every(b => b.text === '조선소 열기') && /구매는 열린 조선소 화면에서 직접 확정/.test(t4), 'each replacement ship has "조선소 열기"; the guide says the purchase is confirmed in the yard screen', { yardBtns });
    await page.screenshot({ path: `${outDir}/comeback-yard-buttons-1440.png` });
    const pick = yardBtns.find(b => /hauler_mk1/.test(b.v)) ?? yardBtns[0];
    if (pick) {
      const [st, hull] = pick.v.split('|');
      await page.click(`[data-fbyard="${pick.v}"]`);
      await page.waitForSelector(`.smodal [data-ycard="${hull}"]`, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(800);
      const y = await page.evaluate(h => { const m = document.querySelector('.smodal'); const card = m?.querySelector(`[data-ycard="${h}"]`); const r = card?.getBoundingClientRect();
        return { open: !!m, tab: m?.querySelector('.tabs .on')?.innerText, title: m?.querySelector('.stitle')?.innerText, focus: !!card?.classList.contains('yfocus'), focusCount: m?.querySelectorAll('.yfocus').length, inView: r ? r.top >= 0 && r.bottom <= window.innerHeight + 1 : false, buy: card?.querySelector(`[data-buyhull="${h}"]`)?.disabled === false, card: card?.innerText.replace(/\s+/g, ' ').slice(0, 200), guideClosed: !document.querySelector('.fbwrap') }; }, hull);
      const stName = await page.evaluate(id => window.siderarium.client.state.stations[id]?.name, st);
      check(y.open && y.tab === '조선소' && y.title === stName && y.focus && y.focusCount === 1 && y.inView && y.guideClosed, '"조선소 열기" opens that station\'s existing shipyard tab with the hull\'s card picked out and in view', { ...y, stName, pick });
      // live updates re-render the modal: the mark stays
      await page.waitForTimeout(2500);
      const still = await page.evaluate(h => !!document.querySelector(`.smodal [data-ycard="${h}"].yfocus`), hull);
      check(still, 'the picked hull stays marked across live re-renders', { still });
      await page.screenshot({ path: `${outDir}/yard-focus-1440.png` });
      // nothing is bought by opening the screen
      const mid = await page.evaluate(() => { const c = window.siderarium.client; return Math.round(c.state.companies[c.company].credits); });
      check(Math.abs(mid - before.credits) < 50, 'opening the yard buys nothing', { before: before.credits, mid });
      // the purchase through the existing button (server-validated: stock, rep, credits)
      const price = await page.evaluate(h => { const t = document.querySelector(`.smodal [data-ycard="${h}"] .money`)?.innerText ?? ''; return Number(t.replace(/[^\d]/g, '')); }, hull);
      if (y.buy) {
        await page.click(`.smodal [data-buyhull="${hull}"]`);
        await page.waitForFunction(n => { const c = window.siderarium.client, w = c.state; return Object.values(w.ships).filter(s => s.owner === c.company).length > 0 && Object.keys(w.ships).length >= n; }, 0, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const after = await page.evaluate(ids => { const c = window.siderarium.client, w = c.state; const mine = Object.values(w.ships).filter(s => s.owner === c.company && !ids.includes(s.id)); return { credits: Math.round(w.companies[c.company].credits), fresh: mine.map(s => ({ id: s.id, hull: s.hull, at: s.task?.station })) }; }, before.ships);
        check(after.fresh.length === 1 && after.fresh[0].hull === hull && before.credits - after.credits >= price - 50, 'the existing buy button really buys one ship of that hull at the yard price', { before: before.credits, after, price });
      } else check(false, 'the buy button of the picked hull is enabled (stock and credits suffice at a fresh start)', { y });
    } else check(false, 'a replacement offer exists', { t4: t4.slice(0, 800) });
    await page.evaluate(() => document.querySelector('.smodal [data-close]')?.click());
    await ctx.close();
    // 3 + 5. phone: recommended sends at once; the comeback block fits; 조선소 열기 by tap
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await signUp(page, 'a32b2_phone', 'a32b2-phone-pass-123');
    await found(page, '모바일 마무리', 'salvager', true);
    await page.waitForSelector('.fbwrap [data-fbrecover]', { timeout: 30000 });
    let asked = ''; page.once('dialog', d => { asked = d.message(); d.dismiss(); });
    const first = (await rows(page))[0];
    await page.tap('[data-fbrecover="0"]');
    await page.waitForFunction(() => { const c = window.siderarium.client, g = Object.values(c.state.groups).find(x => x.owner === c.company); return g?.op?.k === 'recover'; }, null, { timeout: 8000 }).catch(() => {});
    const o5 = await op(page);
    check(!asked && o5?.k === 'recover' && /추천 — 안전 경로/.test(first?.text ?? ''), 'a recommended (low-risk, no recent battle) target is sent without a question', { asked, op: o5, first: first?.text?.slice(0, 160) });
    await page.evaluate(() => { const c = window.siderarium.client, w = c.state; for (const s of Object.values(w.ships)) if (s.owner === c.company) s.owner = 'zz_view_only'; });
    await reopen(page);
    const g = await page.evaluate(() => { const e = document.querySelector('.fbwrap [data-fbcomeback]'), r = e?.getBoundingClientRect(); return { found: !!e, l: r?.left, r: r?.right, vw: window.innerWidth, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, btns: document.querySelectorAll('[data-fbyard]').length }; });
    check(g.found && g.l >= 0 && g.r <= g.vw + 1 && !g.overflow && g.btns >= 1, '390px: the comeback block with "조선소 열기" fits the screen', g);
    await page.evaluate(() => document.querySelector('[data-fbyard]')?.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${outDir}/comeback-390.png` });
    const v = await page.evaluate(() => document.querySelector('[data-fbyard]')?.getAttribute('data-fbyard'));
    await page.tap('[data-fbyard]');
    await page.waitForTimeout(1200);
    const y5 = await page.evaluate(h => { const m = document.querySelector('.smodal'); const card = m?.querySelector(`[data-ycard="${h}"]`); const r = card?.getBoundingClientRect(); return { tab: m?.querySelector('.tabs .on')?.innerText, focus: !!card?.classList.contains('yfocus'), inView: r ? r.top >= 0 && r.bottom <= window.innerHeight + 1 : false, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }; }, v?.split('|')[1]);
    check(y5.tab === '조선소' && y5.focus && y5.inView && !y5.overflow, '390px: tapping "조선소 열기" opens the yard tab with the hull picked out', { ...y5, v });
    await page.screenshot({ path: `${outDir}/yard-focus-390.png` });
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
