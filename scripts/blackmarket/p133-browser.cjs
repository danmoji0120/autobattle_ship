// P13.3 browser check (single-player save of p133-sp-save.ts, served by a freshly built server): the station trade
// tab splits into 일반 시장 | 암시장 only where the player knows a black market; the normal view notes the stolen
// goods it cannot sell; the black-market view shows legality, original owner, unit net price, fee, budget, risk;
// selling and buying through its buttons change real storage and credits (local server state); a station without a
// known market has no toggle; the galaxy list marks the contact station; 1440 and 390 px layouts; no page errors.
//   node scripts/blackmarket/p133-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p133/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
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
    await page.goto(base + '/?sp=continue&name=P133', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const state = (page, fn, arg) => page.evaluate(([f, a]) => (new Function('st', 'me', 'a', f))(window.siderarium.client.state, window.siderarium.client.company, a), [fn, arg]);
  const store = page => state(page, 'return { ...(st.stations[a].storage[me] ?? {}), credits: st.companies[me].credits };', data.station);
  const fits = (page, q) => page.evaluate(q => { const b = document.querySelector(q)?.getBoundingClientRect(); const over = [...document.querySelectorAll(q + ' button, ' + q + ' table')].some(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }); return { w: b && Math.round(b.width), left: b && Math.round(b.left), right: b && Math.round(b.right), overflow: document.documentElement.scrollWidth > window.innerWidth + 1, out: over }; }, q);
  const modal = '#modal';
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await state(page, 'return { me, v: st.blackMarketV, known: Object.keys(st.blackMarkets ?? {}) };');
    check(w.me === data.me && w.v === 1 && w.known.join() === 'bm_lawless', 'client resumes the P13.3 world; it holds only the market the player found', w);
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'market'), data.station); await page.waitForTimeout(800);
    const n = await page.evaluate(() => ({ toggle: [...document.querySelectorAll('[data-mkview]')].map(b => b.innerText), note: document.querySelector('[data-bm-note]')?.innerText ?? '' }));
    check(n.toggle.join('|') === '일반 시장|암시장' && /장물 보관 중/.test(n.note) && /일반 시장·거래소·생산·물류에 쓸 수 없습니다/.test(n.note), 'trade tab: 일반 시장 | 암시장 toggle at the contact station; the normal view notes the stolen goods it cannot trade', n);
    await page.screenshot({ path: `${outDir}/normal-1440.png` });
    await page.click('[data-mkview="black"]'); await page.waitForTimeout(600);
    const bmv = await page.evaluate(() => { const r = document.querySelector('.bm'); const t = r?.innerText ?? ''; return { t: t.slice(0, 900), rows: [...(r?.querySelectorAll('[data-bmsell]') ?? [])].map(b => b.dataset.bmsell), buys: [...(r?.querySelectorAll('[data-bmbuy]') ?? [])].map(b => b.dataset.bmbuy) }; });
    check(/무법지대 암시장|암시장/.test(bmv.t) && /수수료 \d+%/.test(bmv.t) && /매입 자금/.test(bmv.t) && /적발 확률/.test(bmv.t) && /장물/.test(bmv.t) && /원소유 수송 PMC/.test(bmv.t) && /개당 실수령/.test(bmv.t), 'black-market view: tier, fee, budget, inspection risk; each row shows 장물 + original owner and the net unit price', bmv);
    check(bmv.buys.some(x => x.startsWith('mod_ecm|')), 'black-market view: the market\'s real stock with buy buttons', bmv.buys);
    await page.screenshot({ path: `${outDir}/black-1440.png` });
    // sell 10 (or what there is) of the stolen electronics through the button
    const key = Object.keys(data.store).filter(k => k.startsWith('hot:')).sort((a, b) => data.store[b] - data.store[a])[0];
    const s0 = await store(page);
    const btn = bmv.rows.find(r => r.startsWith(key + '|') && !r.split('|')[2]);
    await page.click(`[data-bmsell="${btn}"]`);
    await page.waitForFunction(([st, me, k, n]) => (window.siderarium.client.state.stations[st].storage[me][k] ?? 0) < n, [data.station, data.me, key, s0[key]], { timeout: 15000 }).catch(() => {});
    const s1 = await store(page);
    const sold = s0[key] - (s1[key] ?? 0), gain = s1.credits - s0.credits;
    const log = await state(page, 'return (st.companies[me].bm?.log ?? []).filter(x => x.k === "sell").at(-1) ?? null;');
    check(sold === Number(btn.split('|')[1]) && gain > 0 && Math.abs(gain - log.value) < 1e-6, 'the 처분 button sold exactly that many stolen units from storage; credits rose by the logged net', { key, sold, gain, log });
    await page.waitForTimeout(800);
    const logRow = await page.evaluate(() => [...document.querySelectorAll('.bm table.small tr')].map(r => r.innerText).slice(0, 2));
    check(logRow.some(t => /처분/.test(t)), 'the recent black-market log in the view shows the sale', logRow);
    // buy one restricted module into storage
    const b0 = await store(page);
    await page.click('[data-bmbuy="mod_ecm|1"]');
    await page.waitForFunction(([st, me, n]) => (window.siderarium.client.state.stations[st].storage[me].mod_ecm ?? 0) > n, [data.station, data.me, b0.mod_ecm ?? 0], { timeout: 15000 }).catch(() => {});
    const b1 = await store(page);
    check((b1.mod_ecm ?? 0) - (b0.mod_ecm ?? 0) === 1 && b1.credits < b0.credits, '1 구매 bought one restricted module into storage, paid in credits', { before: b0.mod_ecm ?? 0, after: b1.mod_ecm, paid: Math.round(b0.credits - b1.credits) });
    await page.screenshot({ path: `${outDir}/black-after-1440.png` });
    // a station without a known market: no toggle
    await page.evaluate(id => window.siderarium.hud.openStation(id, 'market'), data.other); await page.waitForTimeout(700);
    const o = await page.evaluate(() => ({ toggle: document.querySelectorAll('[data-mkview]').length, bm: !!document.querySelector('.bm') }));
    check(o.toggle === 0 && !o.bm, 'a station without a known black market has no toggle and no black-market view', o);
    // galaxy list marks the contact station
    await page.evaluate(() => window.siderarium.hud.toggleGalaxy()); await page.waitForTimeout(600);
    const gal = await page.evaluate(async st => { for (const n of document.querySelectorAll('[data-sys]')) { n.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 120)); if (document.querySelector(`[data-gal-station="${st}"]`)) return n.dataset.sys; } return null; }, data.station);
    await page.waitForTimeout(300);
    const galText = await page.evaluate(st => [...document.querySelectorAll(`[data-gal-station="${st}"]`)].map(b => b.innerText).join(' '), data.station);
    check(/암시장 접선처/.test(galText), 'galaxy map: the contact station is marked 암시장 접선처 (only for the player who found it)', { sys: gal, galText });
    await page.screenshot({ path: `${outDir}/galaxy-1440.png` });
    await page.close();
    // mobile
    const m = await open({ width: 390, height: 844 });
    // existing layout (not P13.3): on a phone the selected group's panel is drawn over station windows. Record it on a
    // station without a black market, then clear the selection so the black-market view can be checked on its own.
    await m.waitForTimeout(800);
    await m.evaluate(() => window.siderarium.hud.openStation('astra', 'market')); await m.waitForTimeout(600);
    const pre = await m.evaluate(() => { const t = document.elementFromPoint(195, 620); return { selected: !!window.siderarium.hud.sel, topAt620: t && (t.closest('.modal') ? 'modal' : t.closest('[id]')?.id ?? t.className) }; });
    report.preexisting = { mobileSelectionOverModal: pre };
    console.log('INFO pre-existing 390px: selection panel over a station window (no black market involved)', JSON.stringify(pre));
    await m.screenshot({ path: `${outDir}/preexisting-sel-over-modal-390.png` });
    await m.evaluate(() => { window.siderarium.hud.closeModal(); window.siderarium.hud.select(null); }); await m.waitForTimeout(400);
    await m.evaluate(id => window.siderarium.hud.openStation(id, 'market'), data.station); await m.waitForTimeout(800);
    await m.click('[data-mkview="black"]'); await m.waitForTimeout(600);
    const l1 = await fits(m, '.bm');
    check(l1.w > 0 && l1.right <= 391 && !l1.overflow && !l1.out, '390px: the black-market view fits (no horizontal page scroll, no button or table outside the screen)', l1);
    await m.screenshot({ path: `${outDir}/black-390.png`, fullPage: false });
    await m.click('[data-mkview="normal"]'); await m.waitForTimeout(500);
    const l2 = await fits(m, '[data-bm-note]');
    check(l2.w > 0 && !l2.overflow, '390px: the normal view with the stolen-goods note fits', l2);
    await m.screenshot({ path: `${outDir}/normal-390.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
