// P13.2.2 browser check against a freshly built server (`node dist-server/server.mjs` serving dist/) with the
// single-player save of p1322-sp-save.ts: the 약탈 회수 지원 button (hauler group only), the UI order (mode + click
// on the player's raid → server-accepted lootTender), the tender state block and its 지원 중단 control, a lane
// raid ordered through the UI (항로 약탈 + click on the map) and the estimate line it shows once it picks a
// target, the 390px layout, page and console errors.
//   node scripts/piracy/p1322-browser.cjs <save.json> <outDir> <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p1322/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
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
    await page.goto(base + '/?sp=continue&name=P1322', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const sel = (page, kind, id) => page.evaluate(([kind, id]) => window.siderarium.hud.select({ kind, id }), [kind, id]);
  const fits = (page, q) => page.evaluate(q => { const b = document.querySelector(q)?.getBoundingClientRect(); const over = [...document.querySelectorAll(q + ' button')].some(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }); return { w: b?.width, left: b?.left, right: b?.right, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, buttonsOut: over }; }, q);
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await page.evaluate(() => ({ me: window.siderarium.client.company, v: window.siderarium.client.state.piracyV }));
    check(w.me === data.me && w.v === 1, 'client resumes the P13.2 world (piracyV)', w);
    // the button: hauler group yes, raid group (warships) no
    await sel(page, 'group', data.raid); await page.waitForSelector('.pir-panel', { timeout: 8000 }); await page.waitForTimeout(400);
    const onRaid = await page.evaluate(() => !!document.querySelector('.pir-panel [data-op="loot_tender"]'));
    await sel(page, 'group', data.tender); await page.waitForTimeout(500);
    const onTender = await page.evaluate(() => ({ btn: !!document.querySelector('.pir-panel [data-op="loot_tender"]'), title: document.querySelector('.pir-panel [data-op="loot_tender"]')?.getAttribute('title') ?? '' }));
    check(!onRaid && onTender.btn && /4,000m/.test(onTender.title) && /전투력은 늘지 않습니다/.test(onTender.title), 'fleet panel: 약탈 회수 지원 only for a hauler group without warships (tooltip states the 4,000 m rule and no combat power)', { onRaid, onTender });
    await page.screenshot({ path: `${outDir}/tender-button-1440.png` });
    // UI order: press the button, click the player's raid
    await page.click('.pir-panel [data-op="loot_tender"]');
    const hint = await page.evaluate(() => document.getElementById('modeHint')?.innerText ?? '');
    await page.evaluate(gid => { const S = window.siderarium, st = S.client.state, g = st.groups[gid], s = st.ships[g.shipIds[0]]; S.hud.applyMode({ kind: 'group', id: gid, pos: s.pos }, 0, 0); }, data.raid);
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'lootTender', data.tender, { timeout: 15000 }).catch(() => {});
    const op = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.tender);
    check(/지원할 자사 약탈 편대/.test(hint) && op?.k === 'lootTender' && op.group === data.raid, 'UI mode: 약탈 회수 지원 + click on the raid sends lootTender (server accepted)', { hint, op });
    await page.waitForTimeout(2500);
    const ts = await page.evaluate(() => { const s = [...document.querySelectorAll('.pir-panel .pir-state')].find(x => /약탈 회수 지원/.test(x.innerText)); return { text: s?.innerText ?? '', stop: !!s?.querySelector('[data-quick]') }; });
    check(/약탈 회수 지원/.test(ts.text) && /약탈대/.test(ts.text) && ts.stop && /지원 중단/.test(ts.text), 'fleet panel shows the tender state (supported raid, status) with 지원 중단', ts);
    await page.screenshot({ path: `${outDir}/tender-state-1440.png` });
    // a click on the tender itself in the mode is refused with a hint (no order)
    await page.click('.pir-panel [data-op="loot_tender"]');
    await page.evaluate(gid => { const S = window.siderarium, st = S.client.state, g = st.groups[gid], s = st.ships[g.shipIds[0]]; S.hud.applyMode({ kind: 'group', id: gid, pos: s.pos }, 0, 0); }, data.tender);
    const hint2 = await page.evaluate(() => document.getElementById('modeHint')?.innerText ?? '');
    check(/지원할 자사 약탈 편대를 클릭/.test(hint2), 'UI mode: clicking the tender itself is refused with a hint', { hint2 });
    await page.keyboard.press('Escape');
    // lane raid through the UI: 항로 약탈, click on the map next to the rival hauler
    await sel(page, 'group', data.raid); await page.waitForTimeout(400);
    await page.click('.pir-panel [data-pir-plunder="nonlethal"]');
    await page.click('.pir-panel [data-op="plunder_lane"]');
    await page.evaluate(p => window.siderarium.hud.v.focusOn(p, 9000), data.victimPos); await page.waitForTimeout(1200);
    // the camera is centred on the victim: a click at the screen centre is a click on that spot of the map
    const pt = await page.evaluate(() => { const r = window.siderarium.hud.v.screenToPlane(innerWidth / 2, innerHeight / 2, 0); return { cx: innerWidth / 2, cy: innerHeight / 2, plane: r && { x: Math.round(r.x), z: Math.round(r.z) } }; });
    await page.evaluate(([x, y]) => window.siderarium.hud.applyMode(null, x, y), [pt.cx, pt.cy]);
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'harass', data.raid, { timeout: 15000 }).catch(() => {});
    const lane = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.raid);
    const dz = lane?.at ? Math.hypot(lane.at.x - data.victimPos.x, lane.at.z - data.victimPos.z) : null;
    check(lane?.k === 'harass' && lane.plunder === 'nonlethal' && dz !== null && dz < 3000, 'UI lane raid: 항로 약탈 + map click sends a lane plunder order around the clicked point (server accepted)', { op: lane, fromVictim: dz && Math.round(dz), focus: pt });
    const estLine = await page.waitForFunction(() => { const s = document.querySelector('.pir-panel .pir-state'); const t = s?.innerText ?? ''; return /예상: 응낙/.test(t) ? t : null; }, null, { timeout: 90000 }).then(h => h.jsonValue()).catch(() => null);
    const est = await page.evaluate(g => window.siderarium.client.state.groups[g]?.plx?.est ?? null, data.raid);
    check(!!estLine && /수송 화물선/.test(estLine) && /실판매/.test(estLine) && /기대 수익/.test(estLine) && est && est.profit >= 400, 'fleet panel shows the target and the estimate line (응낙 % · 실판매 · 위험 · 기대 수익) once the lane raid picks it', { estLine, est });
    await page.screenshot({ path: `${outDir}/lane-estimate-1440.png` });
    // the tender follows the raid (it keeps its order)
    const tf = await page.evaluate(([t, r]) => { const st = window.siderarium.client.state; const c = g => { const ss = st.groups[g].shipIds.map(id => st.ships[id]).filter(Boolean); return { x: ss.reduce((a, s) => a + s.pos.x, 0) / ss.length, z: ss.reduce((a, s) => a + s.pos.z, 0) / ss.length }; }; const a = c(t), b = c(r); return { op: st.groups[t].op, d: Math.round(Math.hypot(a.x - b.x, a.z - b.z)), status: st.groups[t].status }; }, [data.tender, data.raid]);
    check(tf.op?.k === 'lootTender' && tf.d < 4000, 'the tender keeps its order and stays close behind the raid', tf);
    // 지원 중단
    await sel(page, 'group', data.tender); await page.waitForTimeout(400);
    await page.evaluate(() => { const s = [...document.querySelectorAll('.pir-panel .pir-state')].find(x => /약탈 회수 지원/.test(x.innerText)); s?.querySelector('[data-quick]')?.click(); });
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'idle', data.tender, { timeout: 15000 }).catch(() => {});
    const op3 = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.tender);
    check(op3?.k === 'idle', '지원 중단 ends the tender order (server state)', op3);
    await page.close();
    // mobile
    const m = await open({ width: 390, height: 844 });
    await sel(m, 'group', data.tender); await m.waitForSelector('.pir-panel', { timeout: 8000 }); await m.waitForTimeout(600);
    await m.evaluate(() => document.querySelector('.pir-panel')?.scrollIntoView());
    const l1 = await fits(m, '.pir-panel');
    check(l1.w > 0 && l1.right <= 391 && !l1.overflow && !l1.buttonsOut, '390px: the hauler group panel with 약탈 회수 지원 fits', l1);
    await m.screenshot({ path: `${outDir}/tender-button-390.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
