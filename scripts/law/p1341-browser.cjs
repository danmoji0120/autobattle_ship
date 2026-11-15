// P13.4.1 browser check of 본부 → 재무 → 치안 기록 (single-player save of p1341-sp-save.ts, freshly built client):
//  - totals: 총 부과 / 납부 / 미납 match the player's own record and fined = paid + unpaid
//  - per-case status: 단속 전 (extortion), 단속 완료·미납 있음 (smuggling seizure), 종결 (paid salvage) with 부과/납부/미납
//  - 일부 (partial) on the smuggling case: the prompt amount is paid, the case stays 단속 완료·미납 있음 with less owed
//  - 완납 on the smuggling case: exactly the rest is paid, the case becomes 종결, the other cases are untouched
//  - no other company's record in the client state; 1440 and 390 px layouts; no page errors
//   node scripts/law/p1341-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p1341/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { base, checks: [], errors: [], console: [], dialogs: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
  let answer = '';
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp: viewport.width, type: m.type(), text: m.text().slice(0, 300) }); });
    page.on('dialog', d => { report.dialogs.push({ type: d.type(), message: d.message(), default: d.defaultValue(), answer }); d.type() === 'prompt' ? d.accept(answer) : d.accept(); });
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto(base + '/?sp=continue&name=P1341', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const state = (page, fn, arg) => page.evaluate(([f, a]) => (new Function('st', 'me', 'a', f))(window.siderarium.client.state, window.siderarium.client.company, a), [fn, arg]);
  const lawOf = page => state(page, 'const L = st.companies[me].law; return { cr: st.companies[me].credits, L };');
  const panel = page => page.evaluate(() => {
    const r = document.querySelector('[data-law-panel]'); if (!r) return null;
    const num = s => Number(r.querySelector(s)?.getAttribute(s.slice(1, -1)) ?? NaN);
    const rows = [...r.querySelectorAll('[data-law-case-row]')].map(tr => ({ id: tr.dataset.lawCaseRow, status: tr.dataset.lawStatus, owe: Number(tr.querySelector('[data-law-owe]')?.dataset.lawOwe ?? -1), text: tr.innerText.replace(/\s+/g, ' '), pay: !!tr.querySelector('[data-a="lawpay"]:not([data-law-amount])'), part: !!tr.querySelector('[data-law-amount="ask"]') }));
    return { fined: num('[data-law-fined]'), paid: num('[data-law-paid]'), unpaid: num('[data-law-unpaid]'), rows, text: r.innerText };
  });
  const openFinance = async page => { await page.evaluate(() => window.siderarium.hud.openOperations('finance')); await page.waitForTimeout(900); };
  const fits = (page, q) => page.evaluate(q => { const p = document.querySelector(q); const b = p?.getBoundingClientRect(); let x = p?.parentElement, worst = 0; while (x && x !== document.body) { worst = Math.max(worst, x.scrollWidth - x.clientWidth > 1 && getComputedStyle(x).overflowX !== 'auto' ? x.scrollWidth - x.clientWidth : 0, x.scrollLeft); x = x.parentElement; } const out = [...document.querySelectorAll(q + ' button')].filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); }).length; return { w: b && Math.round(b.width), left: b && Math.round(b.left), right: b && Math.round(b.right), pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, worst, out }; }, q);
  const waitPaid = (page, id, paid) => page.waitForFunction(([id, paid]) => (window.siderarium.client.state.companies[window.siderarium.client.company].law?.cases ?? []).find(c => c.id === id)?.paid >= paid, [id, paid], { timeout: 15000 }).catch(() => {});
  try {
    const page = await open({ width: 1440, height: 900 });
    const s0 = await lawOf(page);
    const rivalLaw = await state(page, 'return { law: st.companies[a]?.law, book: "law" in st && !!st.law };', data.rival);
    check(s0.L && s0.L.fined === s0.L.paid + s0.L.unpaid && !rivalLaw.law && !rivalLaw.book, 'client state: the player\'s own record only (fined = paid + unpaid); no other company\'s record, no law book', { fined: s0.L?.fined, paid: s0.L?.paid, unpaid: s0.L?.unpaid, rival: rivalLaw });
    await openFinance(page);
    await page.evaluate(() => document.querySelector('[data-law-panel]')?.scrollIntoView());
    const f0 = await panel(page);
    check(f0 && f0.fined === s0.L.fined && f0.paid === s0.L.paid && f0.unpaid === s0.L.unpaid && /총 부과/.test(f0.text) && /납부/.test(f0.text) && /미납/.test(f0.text), '재무 → 치안 기록: 총 부과 / 납부 / 미납 shown, equal to the record', { fined: f0?.fined, paid: f0?.paid, unpaid: f0?.unpaid });
    const row = (f, id) => f.rows.find(r => r.id === id);
    const sm0 = row(f0, data.smug), ex0 = row(f0, data.ext), sv0 = row(f0, data.salv);
    check(sm0?.status === 'served-owed' && /단속 완료 · 미납 있음/.test(sm0.text) && sm0.owe === data.smugFine - 1000 && /부과/.test(sm0.text) && sm0.pay && sm0.part, 'smuggling seizure: 단속 완료 · 미납 있음, 부과/납부/미납 (owed = fine − 1,000 collected at once), 완납 and 일부 buttons', sm0);
    check(ex0?.status === 'pending' && /단속 전/.test(ex0.text), 'extortion not yet enforced: 단속 전', ex0);
    check(sv0?.status === 'closed' && /종결/.test(sv0.text) && sv0.owe === 0 && !sv0.pay, 'paid salvage: 종결, nothing owed, no pay button', sv0);
    await page.screenshot({ path: `${outDir}/law-record-1440.png`, fullPage: false });
    // partial payment through the prompt
    answer = '2000';
    await page.click(`[data-law-case-row="${data.smug}"] [data-law-amount="ask"]`);
    await waitPaid(page, data.smug, 3000);
    await page.waitForTimeout(600);
    const s1 = await lawOf(page), f1 = await panel(page), sm1 = row(f1, data.smug);
    const c1 = s1.L.cases.find(c => c.id === data.smug);
    check(c1.paid === 3000 && s0.cr - s1.cr === 2000 && sm1.status === 'served-owed' && sm1.owe === data.smugFine - 3000 && f1.unpaid === f0.unpaid - 2000 && f1.paid === f0.paid + 2000 && f1.fined === f0.fined, '일부 2,000 cr: credits −2,000, the case stays 단속 완료 · 미납 있음 with 2,000 less owed; totals updated (fined unchanged)', { case: c1, cr: [s0.cr, s1.cr], row: sm1, totals: [f1.fined, f1.paid, f1.unpaid] });
    const dlg = report.dialogs.at(-1);
    check(dlg?.type === 'prompt' && Number(dlg.default) === data.smugFine - 1000, 'the 일부 prompt offers the amount still owed on that case as its default', dlg);
    // pay the rest of that case
    await page.click(`[data-law-case-row="${data.smug}"] [data-a="lawpay"]:not([data-law-amount])`);
    await waitPaid(page, data.smug, data.smugFine);
    await page.waitForTimeout(600);
    const s2 = await lawOf(page), f2 = await panel(page), sm2 = row(f2, data.smug), ex2 = row(f2, data.ext);
    const c2 = s2.L.cases.find(c => c.id === data.smug), e2 = s2.L.cases.find(c => c.id === data.ext), e0 = s0.L.cases.find(c => c.id === data.ext);
    check(c2.paid === c2.fine && c2.state === 'closed' && s1.cr - s2.cr === data.smugFine - 3000 && sm2.status === 'closed' && sm2.owe === 0 && !sm2.pay, '완납: exactly the rest is paid, the smuggling case becomes 종결 (no pay button)', { case: c2, cr: [s1.cr, s2.cr], row: sm2 });
    check(e2.paid === e0.paid && ex2.status === 'pending' && f2.unpaid === e2.fine - e2.paid && f2.fined === f2.paid + f2.unpaid, 'the per-case payment touched no other case; the totals now show only the extortion fine as unpaid', { ext: e2, totals: [f2.fined, f2.paid, f2.unpaid] });
    check(!/미납 있음/.test(sm2.text), 'no stale "미납 있음" guidance on the closed case', { t: sm2.text });
    await page.screenshot({ path: `${outDir}/law-record-paid-1440.png` });
    await page.close();
    // 390 px
    const m = await open({ width: 390, height: 844 });
    await m.waitForTimeout(600);
    await openFinance(m);
    await m.evaluate(() => document.querySelector('[data-law-panel]')?.scrollIntoView());
    await m.waitForTimeout(300);
    const g = await fits(m, '[data-law-panel]');
    check(g.w > 0 && !g.pageOverflow && g.worst === 0 && g.left >= 0 && g.right <= 391, '390px: the law record panel fits (no page scroll, no container pushed sideways; the table scrolls inside its own box)', g);
    await m.screenshot({ path: `${outDir}/law-record-390.png` });
    await m.evaluate(() => document.querySelector(`.law-cases`)?.closest('.ops-table-wrap')?.scrollTo({ left: 9999 }));
    await m.waitForTimeout(200);
    await m.screenshot({ path: `${outDir}/law-record-390-money.png` });
    const m0 = await lawOf(m);
    await m.click('[data-law-panel] .row [data-a="lawpay"]');
    await m.waitForFunction(() => (window.siderarium.client.state.companies[window.siderarium.client.company].law?.unpaid ?? 0) === 0, null, { timeout: 15000 }).catch(() => {});
    await m.waitForTimeout(500);
    const m1 = await lawOf(m), fm = await panel(m);
    check(m0.L.unpaid > 0 && m1.L.unpaid === 0 && m0.cr - m1.cr === m0.L.unpaid && fm.unpaid === 0 && fm.fined === fm.paid && !/미납 벌금 납부/.test(fm.text), '390px: 미납 벌금 납부 pays everything left exactly once; 미납 0, the pay button disappears', { before: { cr: m0.cr, unpaid: m0.L.unpaid }, after: { cr: m1.cr, unpaid: m1.L.unpaid }, totals: [fm.fined, fm.paid, fm.unpaid] });
    await m.screenshot({ path: `${outDir}/law-record-390-paid.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
