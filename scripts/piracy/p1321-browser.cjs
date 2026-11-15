// P13.2.1 browser recheck (all P13.2 checks re-run, nothing reused) against a freshly built server
// (`node dist-server/server.mjs` serving dist/), plus: recovery status words (투하 화물 회수 / 약탈품 회수 중 /
// 회수품 하역 중), the state after a truce is ended by a direct attack, console errors and warnings.
//   node scripts/piracy/p1321-browser.cjs <save.json> <outDir> <baseUrl>
// (P13.2 description:) loads the single-player P13.2 save (p1321-sp-save.ts) into the real client. Checks the
// jettisoned-cargo container on the map (◈ label distinct from ✕ wrecks), its info panel (position, contents,
// owner, drop time, time left, recover button), recovery ordered from the panel by the spare hauler, the fleet
// panel's raid section (three policies, target / lane plunder, neutral toggle, victim response policy), a
// plunder order issued through the UI mode on a second convoy (server-accepted), the company default policy
// in HQ → 재무·결재, raid events in the log, and the 390px layout. Needs `npm run dev` on 5173.
//   node scripts/piracy/p132-browser.cjs <save.json> [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p1321/browser', base = 'http://127.0.0.1:5173'] = process.argv.slice(2);
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
    await page.goto(base + '/?sp=continue&name=P1321', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const sel = (page, kind, id) => page.evaluate(([kind, id]) => window.siderarium.hud.select({ kind, id }), [kind, id]);
  const fits = (page, q) => page.evaluate(q => { const b = document.querySelector(q)?.getBoundingClientRect(); const over = [...document.querySelectorAll(q + ' button')].some(x => { const r = x.getBoundingClientRect(); return r.right > window.innerWidth + 1 || r.left < -1; }); return { w: b?.width, left: b?.left, right: b?.right, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, buttonsOut: over }; }, q);
  try {
    const page = await open({ width: 1440, height: 900 });
    const w = await page.evaluate(id => { const st = window.siderarium.client.state; return { me: window.siderarium.client.company, v: st.piracyV, drop: st.drops?.[id], piracy: st.piracy }; }, data.drop);
    check(w.me === data.me && w.v === 1, 'client resumes the P13.2 world (piracyV)', { me: w.me, v: w.v });
    // first thing after loading (the sim runs on): the raid that is recovering its own plunder reads 약탈품 회수 중, later 회수품 하역 중
    await sel(page, 'group', data.raid2); await page.waitForTimeout(500);
    const r2 = await page.evaluate(g => { const gr = window.siderarium.client.state.groups[g]; return { status: gr?.status, salv: document.querySelector('.salv-panel .salv-state')?.innerText ?? '', pir: document.querySelector('.pir-state')?.innerText ?? '' }; }, data.raid2);
    check(/^약탈품 회수 중/.test(r2.status ?? '') && /약탈품 회수 중/.test(r2.salv) && /약탈품 회수 중/.test(r2.pir), 'P13.2.1: a raid recovering its plunder container reads 약탈품 회수 중 (status line, salvage tag, raid panel phase)', r2);
    await page.screenshot({ path: `${outDir}/raid-collect-1440.png` });
    // the unload leg of the raid is short (about 20 s of game time) — watched right away with the raid selected
    const un = await page.waitForFunction(g => /^회수품 하역 중/.test(window.siderarium.client.state.groups[g]?.status ?? '') ? window.siderarium.client.state.groups[g].status : null, data.raid2, { timeout: 120000, polling: 100 }).then(h => h.jsonValue()).catch(() => null);
    // the fleet panel re-renders on its own cadence — wait for it to show the unload leg (up to 10 s)
    const unp = await page.waitForFunction(() => { const t = document.querySelector('.salv-panel .salv-state')?.innerText ?? ''; return /회수품 하역 중/.test(t) ? t : null; }, null, { timeout: 10000, polling: 100 }).then(h => h.jsonValue()).catch(() => page.evaluate(() => document.querySelector('.salv-panel .salv-state')?.innerText ?? ''));
    check(!!un && /회수품 하역 중/.test(unp), 'P13.2.1: after recovery the raid heading for a warehouse reads 회수품 하역 중', { status: un, panel: unp });
    if (un) await page.screenshot({ path: `${outDir}/raid-unload-1440.png` });
    check(!!w.drop && w.drop.kind === 'drop' && w.drop.lots.length > 0 && w.piracy === undefined, 'the container reaches the client with its contents; the raid book stays on the server', { name: w.drop?.name, lots: w.drop?.lots, piracy: w.piracy });
    await page.evaluate(id => { const S = window.siderarium, d = S.client.state.drops[id]; S.hud.v.focusOn(d.pos, 3500); }, data.drop);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${outDir}/map-drop-1440.png` });
    const lab = await page.evaluate(id => (window.siderarium.hud.labels ?? []).filter(r => r.pick?.kind === 'drop' && r.pick.id === id).map(r => r.text ?? r.t ?? ''), data.drop);
    check(lab.length > 0, 'the container has its own clickable ◈ label on the map (map-drop-1440.png)', { labels: lab.length });
    // info
    await sel(page, 'drop', data.drop);
    await page.waitForSelector('.drop-info', { timeout: 8000 });
    const t = await page.innerText('.drop-info');
    check(/◈/.test(t) && /위치/.test(t) && /원소유/.test(t) && /투하 .*분 전/.test(t) && /분 후 소멸/.test(t) && /잔여/.test(t) && /전자/.test(t), 'container info: position, contents, original owner, drop time, time left', { text: t.slice(0, 300) });
    await page.screenshot({ path: `${outDir}/drop-info-1440.png` });
    // recover with the spare hauler from the panel
    await sel(page, 'group', data.spare); await page.waitForTimeout(400);
    await sel(page, 'drop', data.drop);
    await page.waitForSelector('.drop-info [data-salv-recover]', { timeout: 8000 });
    await page.click('.drop-info [data-salv-recover]');
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'recover', data.spare, { timeout: 15000 }).catch(() => {});
    const op = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.spare);
    check(op?.k === 'recover' && op.wreck === data.drop, 'the recover button orders the selected fleet to the container (server accepted)', { op });
    // P13.2.1 §7: an ordinary recovery of a jettisoned container reads 투하 화물 회수 (status line and fleet panel)
    await sel(page, 'group', data.spare);
    await page.waitForFunction(g => /^투하 화물 회수/.test(window.siderarium.client.state.groups[g]?.status ?? ''), data.spare, { timeout: 30000 }).catch(() => {});
    const sp = await page.evaluate(g => ({ status: window.siderarium.client.state.groups[g]?.status, panel: document.querySelector('.salv-panel .salv-state')?.innerText ?? '' }), data.spare);
    check(/^투하 화물 회수/.test(sp.status ?? '') && /투하 화물 회수/.test(sp.panel) && !/전장 잔해|약탈품/.test(sp.status + sp.panel), 'P13.2.1: recovering a jettisoned container reads 투하 화물 회수 (status line + fleet panel)', sp);
    await page.screenshot({ path: `${outDir}/salvage-drop-status-1440.png` });
    // after the container is emptied and removed, unloading its goods still reads 투하 화물 회수 (never 전장 잔해 인양)
    const spU = await page.waitForFunction(g => { const gr = window.siderarium.client.state.groups[g]; return gr?.salv?.phase === 'unload' ? { status: gr.status, panel: document.querySelector('.salv-panel .salv-state')?.innerText ?? '' } : null; }, data.spare, { timeout: 180000, polling: 100 }).then(h => h.jsonValue()).catch(() => null);
    check(!!spU && /^투하 화물 회수/.test(spU.status ?? '') && /투하 화물 회수/.test(spU.panel) && !/전장 잔해|약탈품/.test(spU.status + spU.panel), 'P13.2.1: unloading the goods of an emptied container still reads 투하 화물 회수', spU);
    // raid panel
    await sel(page, 'group', data.raid); await page.waitForTimeout(500);
    const pan = await page.evaluate(() => { const p = document.querySelector('.pir-panel'); return { text: p?.innerText ?? '', pol: p?.querySelectorAll('[data-pir-plunder]').length, target: !!p?.querySelector('[data-op="plunder"]'), lane: !!p?.querySelector('[data-op="plunder_lane"]'), neutral: !!p?.querySelector('[data-pir-neutral]'), victim: !!p?.querySelector('[data-pir-policy]') }; });
    check(pan.pol === 3 && pan.target && pan.lane && pan.neutral && pan.victim && /비파괴 우선/.test(pan.text) && /수송망 파괴 우선/.test(pan.text), 'fleet panel: three plunder policies, target / lane plunder, neutral toggle, victim response policy', pan);
    await page.screenshot({ path: `${outDir}/fleet-raid-1440.png` });
    // victim policy override on the spare group
    await sel(page, 'group', data.spare); await page.waitForTimeout(400);
    await page.selectOption(`[data-pir-policy="${data.spare}"]`, 'protect');
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.piracyPolicy === 'protect', data.spare, { timeout: 10000 }).catch(() => {});
    const vp = await page.evaluate(g => window.siderarium.client.state.groups[g]?.piracyPolicy, data.spare);
    check(vp === 'protect', 'group victim policy override is set from the fleet panel (server state)', { vp });
    // plunder via the UI mode: pick force, press 대상 약탈, click the second convoy
    await sel(page, 'group', data.raid); await page.waitForTimeout(400);
    await page.click('.pir-panel [data-pir-plunder="force"]');
    await page.click('.pir-panel [data-op="plunder"]');
    const hint = await page.evaluate(() => document.getElementById('modeHint')?.innerText ?? '');
    await page.evaluate(gid => { const S = window.siderarium, st = S.client.state, g = st.groups[gid], s = st.ships[g.shipIds[0]]; S.hud.applyMode({ kind: 'group', id: gid, pos: s.pos }, 0, 0); }, data.target);
    await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'plunder', data.raid, { timeout: 15000 }).catch(() => {});
    const op2 = await page.evaluate(g => window.siderarium.client.state.groups[g]?.op, data.raid);
    check(/약탈할 다른 회사 편대/.test(hint) && op2?.k === 'plunder' && op2.group === data.target && op2.policy === 'force', 'UI plunder mode sends a plunder order on the clicked convoy with the chosen policy (server accepted)', { hint, op: op2 });
    await page.waitForTimeout(3000);
    const st2 = await page.evaluate(() => document.querySelector('.pir-state')?.innerText ?? '');
    check(/약탈 · 무력 사용 허용/.test(st2) && /작전 중단/.test(st2), 'fleet panel shows the raid with its phase and a stop control', { st2 });
    await page.screenshot({ path: `${outDir}/fleet-raid-active-1440.png` });
    // events: the jettison and recovery are in the log
    const log = await page.evaluate(() => document.getElementById('logBody')?.innerText ?? '');
    check(/화물 요구/.test(log), 'raid events appear in the event log', { log: log.split('\n').filter(l => /화물|약탈|투하|회수/.test(l)).slice(0, 6) });
    // company default in HQ
    await page.evaluate(() => document.getElementById('opsBtn')?.click()); await page.waitForTimeout(600);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.ops-modal [data-a="tab"]')].find(x => x.dataset.id === 'finance'); b?.click(); }); await page.waitForTimeout(600);
    const has = await page.evaluate(() => !!document.querySelector('.ops-modal [data-pir-default]'));
    if (has) { await page.selectOption('.ops-modal [data-pir-default]', 'survive'); await page.waitForFunction(() => { const c = window.siderarium.client; return c.state.companies[c.company]?.piracyPolicy === 'survive'; }, null, { timeout: 10000 }).catch(() => {}); }
    const cp = await page.evaluate(() => { const c = window.siderarium.client; return c.state.companies[c.company]?.piracyPolicy; });
    check(has && cp === 'survive', 'HQ → 재무·결재 sets the company default response policy (server state)', { has, cp });
    await page.screenshot({ path: `${outDir}/hq-policy-1440.png` });
    await page.evaluate(() => document.querySelector('.ops-modal [data-a="close"]')?.click());
    // P13.2.1: a direct attack order on the escort of 제3 호송대 (a party of that truce) ends it: a real battle starts
    await page.waitForTimeout(500);
    await sel(page, 'group', data.raid2); await page.waitForTimeout(400);
    // the real UI path: 공격 button of the fleet panel, then click the escort (the PvP confirmation is accepted)
    await page.click('[data-op="attack"]');
    // the escort may be out of the player's sensor range by now (the raid left to unload): its ships are then not in
    // the client state; the click target is the group itself (the order goes to the simulation like any click)
    await page.evaluate(([gid, d2]) => { const S = window.siderarium, st = S.client.state, g = st.groups[gid], s = g && st.ships[g.shipIds[0]]; S.hud.applyMode({ kind: 'group', id: gid, pos: s?.pos ?? st.drops?.[d2]?.pos ?? { x: 0, y: 0, z: 0 } }, 0, 0); }, [data.escort3, data.drop2]);
    const err = await page.waitForFunction(g => window.siderarium.client.state.groups[g]?.op?.k === 'attack', data.raid2, { timeout: 15000 }).then(() => null).catch(() => 'attack order not accepted');
    const eng = await page.waitForFunction(([g, t]) => { const st = window.siderarium.client.state; return Object.values(st.engagements ?? {}).find(e => (e.groupRefs ?? []).includes(g) && (e.groupRefs ?? []).includes(t)) ?? null; }, [data.raid2, data.escort3], { timeout: 60000 }).then(h => h.jsonValue()).catch(() => null);
    const after = await page.evaluate(g => ({ op: window.siderarium.client.state.groups[g]?.op, status: window.siderarium.client.state.groups[g]?.status, pir: document.querySelector('.pir-state')?.innerText ?? null }), data.raid2);
    check(!!eng && after.op?.k === 'attack', 'P13.2.1: a direct attack on the truce partner (the escort) ends the truce — the client shows a real battle between them and the attack order', { cmd: err, eng: eng && { id: eng.id, groups: eng.groupRefs }, after });
    await page.screenshot({ path: `${outDir}/truce-ended-battle-1440.png` });
    // the spare hauler really recovers the cargo
    await page.waitForFunction(g => { const st = window.siderarium.client.state; return st.groups[g].shipIds.some(id => Object.values(st.ships[id]?.salvaged ?? {}).some(n => n > 0)); }, data.spare, { timeout: 120000 }).catch(() => {});
    const got = await page.evaluate(([g, id]) => { const st = window.siderarium.client.state, me = window.siderarium.client.company; return { held: st.groups[g].shipIds.map(x => st.ships[x]?.salvaged ?? {}), left: st.drops?.[id]?.left, taken: st.drops?.[id]?.taken?.[me] }; }, [data.spare, data.drop]);
    check(got.held.some(h => Object.keys(h).length), 'the recovered cargo is in the spare hauler\'s hold (and leaves the container)', got);
    await page.close();
    // mobile
    const m = await open({ width: 390, height: 844 });
    await sel(m, 'drop', data.drop); await m.waitForSelector('.drop-info', { timeout: 8000 }); await m.waitForTimeout(600);
    const l1 = await fits(m, '.drop-info');
    check(l1.w > 0 && l1.left >= 0 && l1.right <= 391 && !l1.overflow && !l1.buttonsOut, '390px: container info fits without horizontal scrolling', l1);
    await m.screenshot({ path: `${outDir}/drop-info-390.png` });
    await sel(m, 'group', data.raid); await m.waitForSelector('.pir-panel', { timeout: 8000 }); await m.waitForTimeout(600);
    await m.evaluate(() => document.querySelector('.pir-panel')?.scrollIntoView());
    const l2 = await fits(m, '.pir-panel');
    const overlap = await m.evaluate(() => { const bs = [...document.querySelectorAll('.pir-panel button, .pir-panel select, .pir-panel label')].map(b => b.getBoundingClientRect()).filter(r => r.width); let n = 0; for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = bs[i], b = bs[j]; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++; } return n; });
    check(l2.w > 0 && l2.right <= 391 && !l2.overflow && !l2.buttonsOut && overlap === 0, '390px: raid section fits, no overlapping controls', { ...l2, overlap });
    await m.screenshot({ path: `${outDir}/fleet-raid-390.png` });
    await sel(m, 'group', data.spare); await m.waitForSelector('.salv-panel', { timeout: 8000 }).catch(() => {}); await m.waitForTimeout(600);
    await m.evaluate(() => document.querySelector('.salv-panel')?.scrollIntoView());
    const l3 = await fits(m, '.salv-panel');
    check(l3.w > 0 && l3.right <= 391 && !l3.overflow && !l3.buttonsOut, '390px: the salvage status panel fits without horizontal scrolling', l3);
    await m.screenshot({ path: `${outDir}/salvage-status-390.png` });
    await m.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 600) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors (warnings listed in browser-results.json)', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
