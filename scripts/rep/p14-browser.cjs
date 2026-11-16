// P14.0 browser check of 본부 → 평판·관계 (single-player save of p14-sp-save.ts, freshly built client):
//  - company credit with its band; six faction rows with value and band equal to the client state
//  - iron: the battleship blueprint shown as unlocked (trust 46+, 12 contracts); a faction with locked items shows
//    "다음 혜택" with "신뢰도 v / need" and contracts
//  - union: the grudge timer after the strike; the recent-change log lists the strike
//  - the rival's trust is not in the client state; the HUD top bar reads 신용도; 1440 and 390 px; no page errors
//   node scripts/rep/p14-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p14/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
const BANDS = [[-100, '극단적 적대'], [-60, '적대'], [-25, '불신'], [0, '중립'], [10, '협력'], [25, '우호'], [40, '신뢰'], [60, '핵심 협력사'], [80, '최고 신뢰']];
const bandOf = v => { let b = BANDS[0][1]; for (const [m, n] of BANDS) if (v >= m - 1e-9) b = n; return b; };
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 600) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ vp: viewport.width, type: m.type(), text: m.text().slice(0, 300) }); });
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto(base + '/?sp=continue&name=P14', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const state = (page, fn, arg) => page.evaluate(([f, a]) => (new Function('st', 'me', 'a', f))(window.siderarium.client.state, window.siderarium.client.company, a), [fn, arg]);
  const openRep = async page => { await page.evaluate(() => window.siderarium.hud.openOperations('rep')); await page.waitForTimeout(900); };
  const panel = page => page.evaluate(() => {
    const r = document.querySelector('[data-rep-panel]'); if (!r) return null;
    const rows = [...r.querySelectorAll('[data-rep-faction]')].map(tr => ({ f: tr.dataset.repFaction, v: Number(tr.dataset.repValue), band: tr.querySelector('[data-rep-band]')?.dataset.repBand, next: tr.querySelector('[data-rep-next]')?.innerText ?? null, locked: tr.querySelectorAll('[data-rep-locked]').length, text: tr.innerText.replace(/\s+/g, ' ') }));
    return { kind: r.dataset.repPanel, credit: Number(r.querySelector('[data-rep-credit]')?.dataset.repCredit), rows, text: r.innerText };
  });
  const fits = (page, q) => page.evaluate(q => { const p = document.querySelector(q); const b = p?.getBoundingClientRect(); let x = p?.parentElement, worst = 0; while (x && x !== document.body) { worst = Math.max(worst, x.scrollWidth - x.clientWidth > 1 && getComputedStyle(x).overflowX !== 'auto' ? x.scrollWidth - x.clientWidth : 0, x.scrollLeft); x = x.parentElement; } return { w: b && Math.round(b.width), left: b && Math.round(b.left), right: b && Math.round(b.right), pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, worst }; }, q);
  // a cell whose text runs past its own box is clipped (the first browser pass showed the 혜택 column cut off at 1440)
  const clipped = page => page.evaluate(() => [...document.querySelectorAll('[data-rep-panel] td')].filter(td => td.scrollWidth > td.clientWidth + 1).map(td => td.innerText.slice(0, 40)));
  try {
    const page = await open({ width: 1440, height: 900 });
    const s0 = await state(page, 'return { repV: st.repV, rep: st.companies[me].rep, standing: st.companies[me].standing, keys: st.companies[me].repx?.keys, cases: st.companies[me].repx?.cases, rival: st.companies[a] && { standing: st.companies[a].standing, rep: st.companies[a].rep, repx: st.companies[a].repx } };', data.rival);
    // single-player hosts run the server in the page: the rival's full record is replicated only if it is "own"
    check(s0.repV === 1 && Math.abs(s0.rep - data.credit) < 0.5 && s0.keys === undefined && s0.cases === undefined, 'client state: repV world, own credit as saved; no applied-event keys or crime tallies', { repV: s0.repV, rep: s0.rep });
    check(!s0.rival?.standing && !s0.rival?.repx && s0.rival?.rep === 0, 'the rival company\'s trust and record are not in the client state', s0.rival);
    const top = await page.evaluate(() => document.body.innerText.includes('신용도'));
    check(top, 'the HUD reads 신용도 (not 연합 평판) on a repV world', {});
    await openRep(page);
    const p = await panel(page);
    check(p?.kind === 'p14' && Math.abs(p.credit - s0.rep) < 1e-6 && /회사 신용도/.test(p.text) && p.text.includes(bandOf(s0.rep)), '평판·관계 tab: company credit and its band (' + bandOf(s0.rep) + ')', { credit: p?.credit });
    const fs6 = (p?.rows ?? []).map(r => r.f).sort();
    check(JSON.stringify(fs6) === JSON.stringify(['ceres', 'guild', 'iron', 'miners', 'pirates', 'union']), 'six faction rows', fs6);
    const mism = (p?.rows ?? []).filter(r => Math.abs(r.v - (s0.standing?.[r.f] ?? 0)) > 1e-6 || r.band !== bandOf(r.v));
    check(!mism.length, 'each row shows that faction\'s trust and band as in the client state', { mism, bands: p?.rows.map(r => `${r.f}:${r.v.toFixed(1)}:${r.band}`) });
    const iron = p.rows.find(r => r.f === 'iron'), guild = p.rows.find(r => r.f === 'guild'), union = p.rows.find(r => r.f === 'union'), pir = p.rows.find(r => r.f === 'pirates');
    check(/해금:.*전함/.test(iron.text) && /계약 12\/20건/.test(iron.text), 'iron (신뢰): the battleship blueprint is listed as unlocked; the next gate shows 계약 12/20건', { text: iron.text.slice(0, 400) });
    check(guild.next && /신뢰도 \d+(\.\d)? \/ \d+/.test(guild.next), 'guild: 다음 혜택 names the item with "신뢰도 v / need"', { next: guild.next });
    check(/불신 기간 \d+분/.test(union.text) && union.band === '불신', 'union: 불신 band and the grudge timer after the strike', { text: union.text.slice(0, 300) });
    check(pir.band === '적대', 'pirates −30: 적대', { band: pir.band });
    check(/연합 경비대 공격/.test(p.text) && /최근 변동/.test(p.text), 'the recent-change log lists the strike', {});
    const c1440 = await clipped(page);
    check(!c1440.length, '1440px: no table cell is clipped (benefit column wraps)', { clipped: c1440.slice(0, 5) });
    await page.screenshot({ path: `${outDir}/rep-1440.png` });
    await page.evaluate(() => document.querySelector('[data-rep-faction="guild"] details')?.setAttribute('open', ''));
    await page.evaluate(() => document.querySelector('[data-rep-faction="guild"]')?.scrollIntoView());
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}/rep-1440-locked.png` });
    await page.close();
    const m = await open({ width: 390, height: 844 });
    await m.waitForTimeout(600);
    await openRep(m);
    const g = await fits(m, '[data-rep-panel]');
    check(g.w > 0 && !g.pageOverflow && g.worst === 0 && g.left >= 0 && g.right <= 391, '390px: the panel fits (no page scroll; tables scroll inside their own box)', g);
    const c390 = await clipped(m);
    check(!c390.length, '390px: no table cell is clipped', { clipped: c390.slice(0, 5) });
    await m.screenshot({ path: `${outDir}/rep-390.png` });
    await m.evaluate(() => document.querySelector('[data-rep-faction="iron"]')?.scrollIntoView());
    await m.waitForTimeout(300);
    await m.screenshot({ path: `${outDir}/rep-390-iron.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
