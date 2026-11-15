// P13.1 browser check: loads a single-player P13.1 save (p131-sp-save.ts) into the real client, shows the
// battlefield wreck on the map, opens its info (contents, owners, protection), orders the salvage fleet to
// recover it from the panel, toggles automatic on-site salvage, checks the old derelict UI is gone, and the
// 390px layout. Needs `npm run dev` on 5173.   node scripts/salvage/p131-browser.cjs <save.json> [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p131'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { checks: [], errors: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto('http://127.0.0.1:5173/?sp=continue&name=P131', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const focusWreck = (page) => page.evaluate(id => { const S = window.siderarium, w = S.client.state.wrecks[id]; S.hud.v.focusOn(w.pos, 3500); }, data.wreck);
  const bodyText = page => page.evaluate(() => document.body.innerText);
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await page.evaluate(id => { const st = window.siderarium.client.state; return { me: window.siderarium.client.company, v: st.salvageV, sites: st.sites, wreck: st.wrecks?.[id] }; }, data.wreck);
    check(w.me === data.me && w.v === 1 && !w.sites, 'client resumes the P13.1 world (salvageV, no derelict sites)', { me: w.me, v: w.v, sites: !!w.sites });
    check(!!w.wreck && w.wreck.known && w.wreck.lots.length > 0, 'the wreck reaches the client with its contents (the company fought there)', { name: w.wreck?.name, lots: w.wreck?.lots?.length });
    await focusWreck(page); await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/map-wreck-1440.png` });
    const lab = await page.evaluate(id => (window.siderarium.hud.labels ?? []).filter(r => r.pick?.kind === 'wreck' && r.pick.id === id).length, data.wreck);
    check(lab > 0, 'the wreck has a clickable label on the map (map-wreck-1440.png)', { labels: lab });
    // info panel
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'wreck', id }), data.wreck);
    await page.waitForSelector('.wreck-info', { timeout: 8000 });
    let t = await page.innerText('.wreck-info');
    check(/전장 잔해/.test(t) && /선체 고철/.test(t) && /원소유/.test(t) && /분 후 소멸/.test(t) && /출처/.test(t), 'wreck info shows source ships, lots with original owner, size and time left', { head: t.slice(0, 260) });
    await page.screenshot({ path: `${outDir}/wreck-info-1440.png` });
    // order the salvage fleet from the panel
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), data.salvage);
    await page.waitForTimeout(500);
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'wreck', id }), data.wreck);
    await page.waitForSelector('.wreck-info [data-salv-recover]', { timeout: 8000 });
    await page.click('.wreck-info [data-salv-recover]');
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'recover', data.salvage, { timeout: 15000 }).catch(() => {});
    const op = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.salvage);
    check(op?.k === 'recover' && op.wreck === data.wreck, 'the 인양 button orders the selected fleet to recover the wreck (server accepted)', { op });
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), data.salvage);
    await page.waitForFunction(g => /전장 잔해 인양|지정 인양/.test(window.siderarium.client.state.groups[g]?.status ?? ''), data.salvage, { timeout: 30000 }).catch(() => {});
    const status = await page.evaluate(g => window.siderarium.client.state.groups[g]?.status, data.salvage);
    check(/(전장 잔해 인양|지정 인양): (잔해로 이동|인양 중)/.test(status ?? ''), 'fleet status reads 지정 인양 with its phase', { status });
    const panel = await page.evaluate(() => ({ salv: document.querySelector('.salv-panel')?.innerText ?? '', stop: !!document.querySelector('.salv-panel [data-quick]') }));
    check(/현장 자동 인양/.test(panel.salv) && panel.stop, 'fleet panel has the automatic on-site salvage switch and a stop control', panel);
    await page.screenshot({ path: `${outDir}/fleet-salvage-1440.png` });
    // auto toggle
    await page.click('.salv-panel [data-salv-auto]');
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.autoSalvage === false, data.salvage, { timeout: 10000 }).catch(() => {});
    const off = await page.evaluate(g => window.siderarium.client.state.groups[g]?.autoSalvage, data.salvage);
    await page.click('.salv-panel [data-salv-auto]');
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.autoSalvage === undefined, data.salvage, { timeout: 10000 }).catch(() => {});
    const on = await page.evaluate(g => window.siderarium.client.state.groups[g]?.autoSalvage, data.salvage);
    check(off === false && on === undefined, 'automatic on-site salvage turns off and back on per fleet', { off, on });
    // the old derelict UI is gone
    const old = await page.evaluate(() => ({ survey: [...document.querySelectorAll('button')].some(b => /이 성계 탐사$/.test(b.innerText.trim())), salvage: !!document.querySelector('[data-salvage]') }));
    check(!old.survey && !old.salvage, 'no derelict survey / site salvage controls in a P13.1 world', old);
    // progress after a while: cargo in the real hold
    await page.waitForFunction(g => { const st = window.siderarium.client.state; return st.groups[g].shipIds.some(id => Object.values(st.ships[id]?.salvaged ?? {}).some(n => n > 0)); }, data.salvage, { timeout: 120000 }).catch(() => {});
    const got = await page.evaluate(([g, id]) => { const st = window.siderarium.client.state, me = window.siderarium.client.company; return { held: st.groups[g].shipIds.map(x => st.ships[x]?.salvaged ?? {}), taken: st.wrecks[id]?.taken?.[me], stored: Object.values(st.stations).map(s => s.storage?.[me] ?? {}).filter(x => Object.values(x).some(n => n > 0)), status: st.groups[g].status }; }, [data.salvage, data.wreck]);
    check(got.held.some(h => Object.keys(h).length) || (got.taken && got.stored.length), 'recovered goods appear in the salvage ships\' holds (or, after docking, in storage)', got);
    await page.screenshot({ path: `${outDir}/salvaging-1440.png` });
    await page.close();
    // mobile
    const m = await open({ width: 390, height: 844 });
    await m.evaluate(id => window.siderarium.hud.select({ kind: 'wreck', id }), data.wreck);
    await m.waitForSelector('.wreck-info', { timeout: 8000 });
    await m.waitForTimeout(600);
    const lay = await m.evaluate(() => { const b = document.querySelector('.wreck-info')?.getBoundingClientRect(); return { w: b?.width, left: b?.left, right: b?.right, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
    check(lay.w > 0 && lay.left >= 0 && lay.right <= 391 && !lay.overflow, '390px: wreck info fits the screen without horizontal scrolling', lay);
    await m.screenshot({ path: `${outDir}/wreck-info-390.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
