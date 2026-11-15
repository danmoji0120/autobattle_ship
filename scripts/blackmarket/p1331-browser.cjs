// P13.3.1 browser check (single-player save of p1331-sp-save.ts, served by a freshly built server): the station
// storage tab shows the customs return lots (here and elsewhere) with claim buttons for a docked ship; claiming moves
// the goods into the real hold; the lane-raid panel says why it picks no target without a known black market;
// 1440 and 390 px layouts; no page errors.
//   node scripts/blackmarket/p1331-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p1331/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp: viewport.width, type: m.type(), text: m.text().slice(0, 300) }); });
    page.on('dialog', d => d.accept());
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto(base + '/?sp=continue&name=P1331', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const state = (page, fn, arg) => page.evaluate(([f, a]) => (new Function('st', 'me', 'a', f))(window.siderarium.client.state, window.siderarium.client.company, a), [fn, arg]);
  const store = page => state(page, 'return { ...(st.stations[a].storage[me] ?? {}), credits: st.companies[me].credits };', data.station);
  const fits = (page, q) => page.evaluate(q => { const b = document.querySelector(q)?.getBoundingClientRect(); const over = [...document.querySelectorAll(q + ' button, ' + q + ' table')].some(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }); return { w: b && Math.round(b.width), left: b && Math.round(b.left), right: b && Math.round(b.right), overflow: document.documentElement.scrollWidth > window.innerWidth + 1, out: over }; }, q);
  const lots = page => state(page, 'return (st.companies[me].bm?.customs ?? []).map(l => ({ id: l.id, item: l.item, n: l.n, station: l.station }));');
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await state(page, 'return { me, v: st.blackMarketV, known: Object.keys(st.blackMarkets ?? {}), lots: (st.companies[me].bm?.customs ?? []).length };');
    check(w.me === data.me && w.v === 1 && w.known.length === 0 && w.lots === 2, 'client resumes the P13.3 world: two customs lots, no known black market', w);
    // storage tab: customs return section
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'store'), data.station); await page.waitForTimeout(800);
    const c = await page.evaluate(() => { const r = document.querySelector('.customs'); return { t: r?.innerText ?? '', claims: [...(r?.querySelectorAll('[data-cuclaim]') ?? [])].map(b => b.dataset.cuclaim), ship: !!r?.querySelector('[data-cu-ship]') }; });
    check(/세관 반환 대기/.test(c.t) && /생산·판매·건설에 쓸 수 없습니다/.test(c.t) && /합금|alloy/i.test(c.t) && /120/.test(c.t) && /다른 정거장 세관/.test(c.t) && c.claims.length === 2 && c.ship, 'storage tab: 세관 반환 대기 shows the lot here (120, seized from 약탈 PMC) with hold/storage claim buttons, the docked ship picker, and the lot waiting at another station', c);
    await page.screenshot({ path: `${outDir}/customs-1440.png` });
    const l0 = await lots(page);
    const hold0 = await state(page, 'return st.ships[a].cargo.alloy ?? 0;', data.ship);
    await page.click(`[data-cuclaim$="|hold"]`);
    await page.waitForFunction(([me]) => (window.siderarium.client.state.companies[me].bm?.customs ?? []).length < 2, [data.me], { timeout: 15000 }).catch(() => {});
    const l1 = await lots(page), hold1 = await state(page, 'return st.ships[a].cargo.alloy ?? 0;', data.ship);
    check(hold1 - hold0 === 120 && l1.length === 1 && l1[0].station !== data.station && l0.length === 2, 'the 함선 화물칸으로 button moved all 120 units into the docked hauler’s hold; the lot is gone, the other station’s lot stays', { hold0, hold1, before: l0, after: l1 });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => document.querySelector('.customs')?.innerText ?? '');
    check(!/함선 화물칸으로/.test(after) && /다른 정거장 세관/.test(after), 'the section updates: no claim buttons here any more, the remote lot still listed', { after: after.slice(0, 300) });
    await page.evaluate(() => window.siderarium.hud.closeModal());
    // fleet panel of the lane raid: the reason and the hint
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), data.raid); await page.waitForTimeout(1200);
    const p = await page.evaluate(() => ({ state: [...document.querySelectorAll('.pir-state')].map(x => x.innerText).join(' '), hint: document.querySelector('.pir-nobm')?.innerText ?? '' }));
    check(/암시장 미발견/.test(p.state) && /직접 지정/.test(p.state) && /아는 암시장이 없습니다/.test(p.hint) && /대상 약탈\(직접 지정\)은 가능/.test(p.hint), 'fleet panel: the lane raid says it picks no target until a black market is found (direct plunder still possible), with a hint under the raid buttons', p);
    await page.screenshot({ path: `${outDir}/raid-nobm-1440.png` });
    await page.close();
    // 390 px
    const m = await open({ width: 390, height: 844 });
    await m.waitForTimeout(800);
    await m.evaluate(() => { window.siderarium.hud.select(null); }); await m.waitForTimeout(300);
    await m.evaluate(id => window.siderarium.hud.openStation(id, 'store'), data.station); await m.waitForTimeout(800);
    const f1 = await fits(m, '.customs');
    check(f1.w > 0 && f1.right <= 391 && !f1.overflow && !f1.out, '390px: the customs section fits (no horizontal page scroll, nothing outside the screen)', f1);
    await m.screenshot({ path: `${outDir}/customs-390.png` });
    await m.evaluate(() => window.siderarium.hud.closeModal());
    await m.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), data.raid); await m.waitForTimeout(1000);
    const f2 = await fits(m, '.pir-panel');
    check(f2.w > 0 && !f2.overflow, '390px: the raid panel with the hint fits', f2);
    await m.screenshot({ path: `${outDir}/raid-nobm-390.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
