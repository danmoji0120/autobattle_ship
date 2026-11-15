// P13.4 browser check (single-player save of p134-sp-save.ts, served by a freshly built server):
//  - fleet panel of the stopped raid fleet: stop demand, countdown, guard last seen, comply / flee / resist buttons;
//    clicking 협조 really puts the fleet on hold (the server state changes)
//  - finance tab: law record (level, unpaid, case table incl. a closed paid case), pay button pays (credits fall)
//  - system bar: enforcement-area badge with the stop warning
//  - Rime collector fleet panel: on-site held goods with a claim button that moves them into the real hold
//  - 1440 and 390 px layouts; no page errors
//   node scripts/law/p134-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p134/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 500) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp: viewport.width, type: m.type(), text: m.text().slice(0, 300) }); });
    page.on('dialog', d => d.accept());
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto(base + '/?sp=continue&name=P134', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const state = (page, fn, arg) => page.evaluate(([f, a]) => (new Function('st', 'me', 'a', f))(window.siderarium.client.state, window.siderarium.client.company, a), [fn, arg]);
  const fits = (page, q) => page.evaluate(q => { const b = document.querySelector(q)?.getBoundingClientRect(); const over = [...document.querySelectorAll(q + ' button, ' + q + ' table')].some(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }); return { w: b && Math.round(b.width), left: b && Math.round(b.left), right: b && Math.round(b.right), overflow: document.documentElement.scrollWidth > window.innerWidth + 1, out: over }; }, q);
  const select = async (page, id) => { await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), id); await page.waitForTimeout(900); };
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await state(page, 'return { me, v: st.lawV, stop: st.groups[a]?.lawStop?.phase, level: st.companies[me].law?.level, unpaid: st.companies[me].law?.unpaid, book: "law" in st && !!st.law };', data.raid);
    check(w.me === data.me && w.v === 1 && w.stop === 'demand' && w.level >= 2 && w.unpaid > 0 && !w.book, 'client resumes the P13.4 world: the raid fleet is under a stop demand, A is wanted with unpaid fines; the law book itself is not in the client state', w);
    // fleet panel: stop demand
    await select(page, data.raid);
    const s = await page.evaluate(() => { const r = document.querySelector('[data-law-stop]'); return { phase: r?.dataset.lawStop, t: r?.innerText ?? '', btns: [...(r?.querySelectorAll('[data-law]') ?? [])].map(b => b.dataset.law) }; });
    check(s.phase === 'demand' && /정선 요구/.test(s.t) && /초 안에 선택/.test(s.t) && /응답이 없으면 협조/.test(s.t) && /아스트라 순찰대|경비대|순찰/.test(s.t) && s.btns.join() === 'comply,flee,resist', 'fleet panel: stop demand with the guard name, countdown, "no answer = comply" and the three answers', s);
    const bar = await page.evaluate(() => document.querySelector('[data-law-area]')?.closest('*')?.parentElement?.innerText ?? '');
    const area = await page.evaluate(() => ({ area: document.querySelector('[data-law-area]')?.dataset.lawArea, pursuit: !!document.querySelector('[data-law-pursuit]') }));
    check(area.area === 'policed' && area.pursuit && /치안 집행/.test(bar) && /단속 1/.test(bar), 'system bar: Astra is an enforcement area and the bar warns about this fleet\'s stop (short badge, details in the tooltip)', { ...area, bar: bar.slice(0, 200) });
    await page.screenshot({ path: `${outDir}/stop-demand-1440.png` });
    await page.click('[data-law="comply"]');
    await page.waitForFunction(id => window.siderarium.client.state.groups[id]?.lawStop?.phase === 'hold', data.raid, { timeout: 15000 }).catch(() => {});
    const h = await state(page, 'return st.groups[a]?.lawStop;', data.raid);
    check(h?.phase === 'hold' && /협조/.test(h.note ?? ''), '협조 button: the fleet holds for inspection (server state changed)', h);
    await page.waitForTimeout(500);
    const s2 = await page.evaluate(() => document.querySelector('[data-law-stop]')?.innerText ?? '');
    check(/검문/.test(s2), 'the panel now shows the inspection hold', { t: s2.slice(0, 200) });
    await page.screenshot({ path: `${outDir}/stop-hold-1440.png` });
    // wait for the inspection to finish (15 s): released, fines billed from credits during the stop
    await page.waitForFunction(id => window.siderarium.client.state.groups[id]?.lawStop?.phase === 'released', data.raid, { timeout: 40000 }).catch(() => {});
    const rel = await state(page, 'return { stop: st.groups[a]?.lawStop, law: st.companies[me].law, hot: Object.keys(st.ships[st.groups[a].shipIds[2]].cargo).filter(k => k.startsWith("hot:")).length };', data.raid);
    check(rel.stop?.phase === 'released' && rel.stop?.end === 'inspected' && rel.hot === 0 && (rel.law?.unpaid ?? 0) === 0, 'after the inspection: released, stolen goods seized, the fines were paid from credits', { stop: rel.stop, unpaid: rel.law?.unpaid, hot: rel.hot });
    // finance tab
    await page.evaluate(() => window.siderarium.hud.openOperations('finance')); await page.waitForTimeout(900);
    const f = await page.evaluate(() => { const r = document.querySelector('[data-law-panel]'); return { t: r?.innerText ?? '', rows: r?.querySelectorAll('.law-cases tbody tr').length ?? 0, level: r?.querySelector('[data-law-level]')?.dataset.lawLevel, pay: !!r?.querySelector('[data-a="lawpay"]') }; });
    check(/수배 등급/.test(f.t) && /미납 벌금/.test(f.t), 'finance tab: law record panel present', { t: f.t.slice(0, 200) });
    check(f.rows >= 2 && /무단 인양/.test(f.t) && /화물 갈취/.test(f.t) && /벌금 완납/.test(f.t) && /연합 보안국/.test(f.t), 'finance tab: case table lists the paid salvage case and the extortion case with jurisdiction and fine', { rows: f.rows, t: f.t.slice(0, 400) });
    await page.screenshot({ path: `${outDir}/finance-law-1440.png` });
    await page.evaluate(() => window.siderarium.hud.openOperations && document.querySelector('.ops-close, [data-a="close"]')?.click());
    // Rime collector: on-site held goods → claim into the hold
    await page.keyboard.press('Escape');
    await select(page, data.collector);
    const hl = await page.evaluate(() => { const r = document.querySelector('.law-held'); return { t: r?.innerText ?? '', btn: r?.querySelector('[data-heldclaim]')?.dataset.heldclaim }; });
    check(/현장 보관/.test(hl.t) && /60/.test(hl.t) && hl.btn?.startsWith(data.lot + '|'), 'Rime collector panel: the on-site held goods (60, no customs station in Rime) with a claim button', hl);
    await page.screenshot({ path: `${outDir}/held-lot-1440.png` });
    const shipId = hl.btn?.split('|')[1];
    const hold0 = await state(page, 'return st.ships[a]?.cargo.alloy ?? 0;', shipId);
    await page.click('[data-heldclaim]');
    await page.waitForFunction(id => (window.siderarium.client.state.ships[id]?.cargo.alloy ?? 0) > 0, shipId, { timeout: 15000 }).catch(() => {});
    const hold1 = await state(page, 'return { n: st.ships[a]?.cargo.alloy ?? 0, lots: (st.companies[me].bm?.customs ?? []).length };', shipId);
    check(hold1.n - hold0 === 60 && hold1.lots === 0, 'the claim button moved all 60 units into the collector\'s real hold; the lot is gone', { hold0, hold1 });
    await page.close();
    // 390 px: stop demand panel + finance law panel
    const m = await open({ width: 390, height: 844 });
    await m.waitForTimeout(600);
    await select(m, data.raid);
    const f1 = await fits(m, '[data-law-stop]');
    check(f1.w > 0 && !f1.overflow && !f1.out, '390px: the stop demand panel with its three buttons fits', f1);
    await m.screenshot({ path: `${outDir}/stop-demand-390.png` });
    await m.evaluate(() => window.siderarium.hud.select(null)); await m.waitForTimeout(300);
    await m.evaluate(() => window.siderarium.hud.openOperations('finance')); await m.waitForTimeout(900);
    await m.evaluate(() => document.querySelector('[data-law-panel]')?.scrollIntoView());
    await m.waitForTimeout(300);
    const f2 = await fits(m, '[data-law-panel]');
    const inner = await m.evaluate(() => { const p = document.querySelector('[data-law-panel]'); let x = p?.parentElement, worst = 0; while (x && x !== document.body) { worst = Math.max(worst, x.scrollWidth - x.clientWidth > 1 && getComputedStyle(x).overflowX !== 'auto' ? x.scrollWidth - x.clientWidth : 0, x.scrollLeft); x = x.parentElement; } const r = p.getBoundingClientRect(); return { worst, left: Math.round(r.left), right: Math.round(r.right) }; });
    check(f2.w > 0 && !f2.overflow && inner.worst === 0 && inner.left >= 0 && inner.right <= 391, '390px: the finance law panel fits (no horizontal page scroll, no container pushed sideways; the case table scrolls inside its own box)', { ...f2, inner });
    await m.screenshot({ path: `${outDir}/finance-law-390.png` });
    // pay button (fresh save: fines unpaid, the stop is running → payable now)
    const p0 = await state(m, 'return { cr: st.companies[me].credits, unpaid: st.companies[me].law?.unpaid ?? 0 };');
    const hasPay = await m.evaluate(() => !!document.querySelector('[data-a="lawpay"]'));
    if (hasPay) await m.click('[data-a="lawpay"]');
    await m.waitForFunction(() => (window.siderarium.client.state.companies[window.siderarium.client.company].law?.unpaid ?? 0) === 0, null, { timeout: 15000 }).catch(() => {});
    const p1 = await state(m, 'return { cr: st.companies[me].credits, unpaid: st.companies[me].law?.unpaid ?? 0 };');
    check(hasPay && p0.unpaid > 0 && p1.unpaid === 0 && p0.cr - p1.cr >= p0.unpaid - 1, '벌금 납부 button pays every unpaid fine (credits fall by at least that amount)', { p0, p1 });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
