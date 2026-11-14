// P12.5 browser check: loads a single-player P12.5 save (p125-sp-save.ts) into the real client, opens 물류 현황,
// checks the summary / shipments / haulers sections, opens a shipment's details, excludes and re-includes a
// hauler, turns automatic logistics off and on, checks that no route / haul creation UI exists, and the
// 390px layout. Needs `npm run dev` on 5173.   node scripts/logistics/p125-browser.cjs <save.json> [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p125'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { checks: [], errors: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('dialog', d => d.dismiss());
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto('http://127.0.0.1:5173/?sp=continue&name=P125', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const text = page => page.evaluate(() => document.querySelector('.autolg')?.innerText ?? '');
  const state = (page, id) => page.evaluate(id => { const st = window.siderarium.client.state, s = st.ships[id]; return { excluded: !!s?.logisticsExcluded, job: s?.logisticsJob ?? null, auto: st.companies[window.siderarium.client.company]?.autoLogistics }; }, id);
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await page.evaluate(() => ({ me: window.siderarium.client.company, v: window.siderarium.client.state.logisticsV, routes: Object.keys(window.siderarium.client.state.logistics ?? {}).length }));
    check(w.me === data.me && w.v === 1, 'single-player client resumes the P12.5 world as 알파 PMC', w);
    await page.waitForSelector('#logisticsBtn', { timeout: 20000 });
    check(/물류 현황/.test(await page.innerText('#logisticsBtn')), 'the HUD button reads 물류 현황 (status), not route management');
    await page.click('#logisticsBtn');
    await page.waitForSelector('.autolg [data-al-job]', { timeout: 20000 });
    await page.waitForTimeout(900); // .modal fades in over 0.6 s
    let t = await text(page);
    check(/수송선/.test(t) && /진행 중 운송/.test(t) && /부족 자재/.test(t) && /문제/.test(t), 'summary shows haulers, shipments in progress, shortages and problems', { head: t.slice(0, 300) });
    const jobs = await page.$$eval('.autolg [data-al-job]', els => els.length);
    check(jobs >= 5, 'every automatic shipment of the battleship build is listed', { jobs });
    const queue = await page.evaluate(() => ({ note: document.querySelector('.autolg-note')?.innerText ?? '', badges: [...document.querySelectorAll('.autolg .lg-badge')].map(b => b.innerText), legacy: /참여 설정/.test(document.querySelector('.autolg')?.innerText ?? '') }));
    check(!queue.legacy && (queue.badges.includes('수송선 대기') ? /수송선 대기 \d+건/.test(queue.note) : true), 'shipments waiting for a free hauler are shown as queueing (수송선 대기), with no registration wording', queue);
    const forms = await page.evaluate(() => ({ route: !!document.querySelector('.autolg [data-lg-new], .autolg [data-route-form], .autolg .lg-route-form'), text: /노선 만들기|새 노선|노선 추가|수동 배차/.test(document.querySelector('.autolg')?.innerText ?? '') }));
    check(!forms.route && !forms.text, 'no route creation, repeat-route or manual dispatch form exists', forms);
    check(await page.$('.autolg details[data-al-adv]:not([open])') !== null, 'advanced settings (procurement / auto-buy) are collapsed by default');
    await page.screenshot({ path: `${outDir}/logistics-1440.png` });
    // shipment details
    await page.click('.autolg [data-al-open]');
    await page.waitForSelector('.autolg .lg-metrics', { timeout: 5000 });
    t = await page.innerText('.autolg .lg-metrics');
    check(/목적/.test(t) && /배송 완료/.test(t) && /적재·운송 중/.test(t), 'a shipment opens to show purpose, delivered and in-transit amounts', { t: t.slice(0, 200) });
    await page.screenshot({ path: `${outDir}/logistics-detail-1440.png` });
    // exclude / include a hauler that is not carrying anything: pick the first hauler row with an exclude button
    const target = await page.evaluate(() => { const b = document.querySelector('.autolg [data-al-excl][data-al-on="false"]'); return b ? b.dataset.alExcl : null; });
    check(!!target, 'each hauler has a per-ship exclusion control', { target });
    if (target) {
      const before = await state(page, target);
      await page.click(`.autolg [data-al-excl="${target}"][data-al-on="false"]`);
      await page.waitForFunction(id => window.siderarium.client.state.ships[id]?.logisticsExcluded === undefined ? false : true, target, { timeout: 10000 }).catch(() => {});
      const ex = await page.evaluate(id => { const s = window.siderarium.client.state.ships[id]; return { cargo: s?.cargo, row: document.querySelector(`.autolg [data-al-excl="${id}"]`)?.dataset.alOn }; }, target);
      check(ex.row === 'true', 'excluding a hauler takes it out of automatic logistics (button flips to 포함)', { before, ex });
      await page.click(`.autolg [data-al-excl="${target}"][data-al-on="true"]`);
      await page.waitForFunction(id => document.querySelector(`.autolg [data-al-excl="${id}"]`)?.dataset.alOn === 'false', target, { timeout: 10000 }).catch(() => {});
      check(await page.evaluate(id => document.querySelector(`.autolg [data-al-excl="${id}"]`)?.dataset.alOn === 'false', target), 'including it again returns it to automatic logistics');
    }
    // global off / on
    await page.click('.autolg [data-al-toggle]');
    await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company]?.autoLogistics === false, null, { timeout: 10000 }).catch(() => {});
    t = await text(page);
    check(/자동 물류 꺼짐/.test(t) && /새 운송을 시작하지 않습니다/.test(t), 'global switch off: panel says no new shipments start', { off: /자동 물류 꺼짐/.test(t) });
    await page.screenshot({ path: `${outDir}/logistics-off-1440.png` });
    await page.click('.autolg [data-al-toggle]');
    await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company]?.autoLogistics !== false, null, { timeout: 10000 }).catch(() => {});
    check(/자동 물류 켜짐/.test(await text(page)), 'global switch back on');
    // hauler group panel: no haul order button
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => document.querySelector('.autolg [data-al-close]')?.click());
    const grp = await page.evaluate(id => window.siderarium.client.state.ships[id].groupId, data.haulers[0]);
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), grp);
    await page.waitForTimeout(800);
    const haulBtn = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent && /^운송$|화물 운송|운송 명령/.test(b.innerText.trim())).map(b => b.innerText.trim()));
    check(!haulBtn.length, 'the hauler group panel offers no manual haul order', { haulBtn });
    await page.screenshot({ path: `${outDir}/hauler-group-1440.png` });
    await page.close();
    // mobile
    const m = await open({ width: 390, height: 844 });
    await m.waitForSelector('#logisticsBtn', { timeout: 20000 });
    await m.evaluate(() => document.getElementById('logisticsBtn').click());
    await m.waitForSelector('.autolg [data-al-job]', { timeout: 20000 });
    await m.waitForTimeout(900);
    const lay = await m.evaluate(() => { const b = document.querySelector('.autolg-box')?.getBoundingClientRect(); return { w: b?.width, left: b?.left, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, toggle: !!document.querySelector('.autolg [data-al-toggle]')?.getBoundingClientRect().width }; });
    check(lay.w <= 390 && lay.left >= 0 && !lay.overflow && lay.toggle, '390px: panel fits the screen without horizontal scrolling; controls reachable', lay);
    await m.screenshot({ path: `${outDir}/logistics-390.png`, fullPage: false });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
