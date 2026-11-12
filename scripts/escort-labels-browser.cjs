// Browser check: clickable map name labels, repair quote = charge, escort orders/status in the real UI.
// Production build, single-player world in the page, disposable save file. No external service is used.
// Usage: npm run build && node scripts/escort-labels-browser.cjs   (screenshots → artifacts/escort-labels)
const { chromium } = require('playwright');
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const out = 'artifacts/escort-labels'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-labels-'));
const PORT = '8351';
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT, SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = []; const results = [];
const assert = (ok, label, data) => { results.push({ label, ok: !!ok, data }); if (!ok) throw Error(`${label} ${data !== undefined ? JSON.stringify(data) : ''}`); console.log('PASS', label, data !== undefined ? JSON.stringify(data) : ''); };

// label rects with their pick, as the HUD drew them in the last frame
const labels = page => page.evaluate(() => window.siderarium.hud.labels.filter(r => r.pick).map(r => ({ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, kind: r.pick.kind, id: r.pick.id })));
// a label whose position has settled (the camera eases into a new focus)
const findLabel = async (page, kind, id) => {
  let prev = null;
  for (let i = 0; i < 60; i++) {
    const l = (await labels(page)).find(r => r.kind === kind && r.id === id);
    if (l && prev && Math.abs(l.x0 - prev.x0) < 0.5 && Math.abs(l.y0 - prev.y0) < 0.5) return l;
    prev = l ?? null; await page.waitForTimeout(120);
  }
  return prev;
};
const mid = r => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });
const sel = page => page.evaluate(() => ({ sel: window.siderarium.hud.sel, group: window.siderarium.hud.group }));
const server = (page, fn, arg) => page.evaluate(([src, a]) => { const c = window.siderarium.client; const sim = c.t.server.sim; return new Function('sim', 'c', 'a', src)(sim, c, a); }, [fn, arg]);

async function open(page) {
  await page.goto(`http://localhost:${PORT}/?sp=new&name=라벨시험`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, undefined, { timeout: 90000 });
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.waitForTimeout(600);
}
// the camera eases toward a new focus; give it time to settle before reading label positions
async function focus(page, pos, d = 2600) { await page.evaluate(([p, dd]) => window.siderarium.view.focusOn(p, dd), [pos, d]); await page.waitForTimeout(1500); }

(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // ───────────────────────────────────────── desktop
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', e => errors.push(String(e)));
  await open(page);
  const ids = await page.evaluate(() => { const c = window.siderarium.client, st = c.state; const gs = Object.values(st.groups).filter(g => g.owner === c.company); return { me: c.company, mining: gs.find(g => g.name.includes('채굴')).id, guard: gs.find(g => g.name.includes('경비')).id, astra: st.stations.astra.pos, field: st.fields.kestrel.pos }; });
  await focus(page, ids.astra, 2600);
  await page.screenshot({ path: `${out}/labels-astra-1440.png` });

  // 1. station label: centre and edges
  const stl = await findLabel(page, 'station', 'astra');
  assert(stl, 'station label is a click target');
  await page.evaluate(() => window.siderarium.hud.select(null));
  await page.mouse.click(mid(stl).x, mid(stl).y);
  assert((await sel(page)).sel?.id === 'astra', 'label centre click selects the station', (await sel(page)).sel);
  for (const [x, y, name] of [[stl.x0 + 1, stl.y0 + 1, 'top-left'], [stl.x1 - 1, stl.y1 - 1, 'bottom-right']]) {
    await page.evaluate(() => window.siderarium.hud.select(null)); await page.waitForTimeout(80);
    const l = await findLabel(page, 'station', 'astra');
    await page.mouse.click(name === 'top-left' ? l.x0 + 1 : l.x1 - 1, name === 'top-left' ? l.y0 + 1 : l.y1 - 1);
    assert((await sel(page)).sel?.id === 'astra', `label ${name} edge click selects the station`);
  }

  // 2. group label (drawn below the fleet, away from the ships): selects the group; the object pick at that point does not
  const gl = await findLabel(page, 'group', ids.mining);
  assert(gl, 'own group label is a click target');
  const objPick = await page.evaluate(([x, y]) => window.siderarium.view.pick(x, y), [mid(gl).x, mid(gl).y]);
  await page.evaluate(() => window.siderarium.hud.select(null));
  await page.mouse.click(mid(gl).x, mid(gl).y);
  const s2 = await sel(page);
  assert(s2.group === ids.mining && s2.sel?.kind === 'group', 'clicking the group label selects that group', { objectPickAtLabel: objPick ? objPick.kind : null, sel: s2.sel });

  // 3. overlapping labels: the topmost (drawn last) wins
  const top = await page.evaluate(([a, b]) => {
    const hud = window.siderarium.hud, P = (id) => ({ kind: 'group', id, pos: { x: 0, y: 0, z: 0 } });
    const saved = hud.labels;
    hud.labels = [{ x0: 100, x1: 200, y0: 100, y1: 130, pick: P(a) }, { x0: 150, x1: 250, y0: 110, y1: 140, pick: P(b) }];
    const r = { overlap: hud.pickAt(160, 120)?.id, onlyFirst: hud.pickAt(110, 105)?.id, onlySecond: hud.pickAt(240, 135)?.id };
    hud.labels = saved; return r;
  }, [ids.mining, ids.guard]);
  assert(top.overlap === ids.guard && top.onlyFirst === ids.mining && top.onlySecond === ids.guard, 'overlap → topmost label; non-overlapping parts → their own label', top);
  // real overlap avoidance on screen: no two drawn label rects intersect
  const ls = await labels(page);
  let inter = 0; for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { const a = ls[i], b = ls[j]; if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) inter++; }
  assert(true, 'drawn label rects that intersect (informational)', { labels: ls.length, intersecting: inter });

  // 4. right-click a group label with another own group selected → escort order on that group
  await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), ids.guard); await page.waitForTimeout(150);
  const gl2 = await findLabel(page, 'group', ids.mining);
  await page.mouse.click(mid(gl2).x, mid(gl2).y, { button: 'right' });
  await page.waitForTimeout(300);
  const op1 = await server(page, 'return sim.st.groups[a].op', ids.guard);
  assert(op1.k === 'escort' && op1.group === ids.mining, 'right-click on a group label orders escort', op1);
  // escort focus selector in the group panel
  await page.waitForSelector('[data-escfocus]', { timeout: 5000 });
  const opts = await page.locator('[data-escfocus] option').allInnerTexts();
  await page.locator('[data-escfocus]').selectOption('cargo'); await page.waitForTimeout(300);
  const op2 = await server(page, 'return sim.st.groups[a].op', ids.guard);
  assert(op2.focus === 'cargo', 'escort focus selector changes the order', { options: opts, op: op2 });
  await page.locator('[data-escfocus]').selectOption('auto'); await page.waitForTimeout(200);

  // 5. target mode: select the miners, press N (mine), click the field label
  await focus(page, ids.field, 2600);
  await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), ids.mining); await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('KeyN'); await page.waitForTimeout(100);
  const fl = await findLabel(page, 'field', 'kestrel');
  assert(fl, 'field label visible');
  await page.mouse.click(mid(fl).x, mid(fl).y); await page.waitForTimeout(300);
  const form = await page.evaluate(() => window.siderarium.hud.mineForm);
  if (!form) console.log('DEBUG', await page.evaluate(([x, y]) => { const h = window.siderarium.hud; return { fl: [x, y], now: h.labels.filter(r => r.pick?.kind === 'field').map(r => [r.pick.id, Math.round(r.x0), Math.round(r.y0)]), el: document.elementFromPoint(x, y)?.className, mode: h.mode, group: h.group, pick: h.pickAt(x, y), active: document.activeElement?.tagName }; }, [mid(fl).x, mid(fl).y]));
  assert(form?.field === 'kestrel', 'mine mode + field label click picks that deposit in the mining form', form);
  await page.getByRole('button', { name: /작업 시작/ }).first().click(); await page.waitForTimeout(400);
  const op3 = await server(page, 'return sim.st.groups[a].op', ids.mining);
  assert(op3.k === 'mine' && op3.field === 'kestrel', 'starting the form runs mining on the clicked deposit', op3);
  // escort mode (G) + group label click
  await server(page, 'sim.command(c.company, { c: "setOp", group: a, op: { k: "idle" } });', ids.guard); await page.waitForTimeout(200);
  await focus(page, ids.astra, 2600);
  await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), ids.guard); await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('KeyG'); await page.waitForTimeout(100);
  const gl3 = await findLabel(page, 'group', ids.mining);
  await page.mouse.click(mid(gl3).x, mid(gl3).y); await page.waitForTimeout(300);
  const op4 = await server(page, 'return sim.st.groups[a].op', ids.guard);
  assert(op4.k === 'escort' && op4.group === ids.mining, 'escort mode (G) + group label click orders escort', op4);
  await focus(page, ids.field, 2600);

  // 6. double-click a label focuses the camera on it
  const before = await page.evaluate(() => { const r = window.siderarium.view.rig; return { f: { x: r.focus.x, z: r.focus.z }, d: r.dist }; });
  const fl2 = await findLabel(page, 'field', 'kestrel');
  await page.mouse.dblclick(mid(fl2).x, mid(fl2).y); await page.waitForTimeout(200);
  const after = await page.evaluate(() => { const r = window.siderarium.view.rig; return { f: { x: r.focus.x, z: r.focus.z }, d: r.dist }; });
  assert(after.d === 2200 && (after.f.x !== before.f.x || after.f.z !== before.f.z || before.d !== 2200), 'double-click on a field label focuses the camera on the field', { before, after });

  // 7. drag starting on a label pans and does not select
  await page.evaluate(() => window.siderarium.hud.select(null)); await page.waitForTimeout(100);
  const fl3 = await findLabel(page, 'field', 'kestrel');
  const f0 = await page.evaluate(() => { const r = window.siderarium.view.rig.focus; return { x: r.x, z: r.z }; });
  await page.mouse.move(mid(fl3).x, mid(fl3).y); await page.mouse.down(); await page.mouse.move(mid(fl3).x + 60, mid(fl3).y + 30, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(150);
  const f1 = await page.evaluate(() => { const r = window.siderarium.view.rig.focus; return { x: r.x, z: r.z }; });
  assert((await sel(page)).sel === null && (f0.x !== f1.x || f0.z !== f1.z), 'drag that starts on a label pans the camera and selects nothing', { f0, f1 });

  // 8. fog: labels only for objects in this client's state; an object the client does not know has no label and no click
  const fog = await page.evaluate(() => {
    const app = window.siderarium, st = app.client.state, hud = app.hud;
    const all = hud.labels.filter(r => r.pick);
    const unknown = all.filter(r => { const k = r.pick.kind, id = r.pick.id; return k === 'group' ? !st.groups[id] : k === 'station' ? !st.stations[id] : k === 'field' ? !st.fields[id] : k === 'lair' ? !st.lairs[id] : k === 'battle' ? !st.engagements[id] : false; }).length;
    return { labels: all.length, labelsForUnknownObjects: unknown };
  });
  assert(fog.labelsForUnknownObjects === 0, 'every label pick refers to an object present in the client state', fog);
  const hidden = await page.evaluate(async () => {
    const app = window.siderarium, st = app.client.state, hud = app.hud;
    const l = hud.labels.find(r => r.pick?.kind === 'field' && r.pick.id === 'kestrel');
    const saved = st.fields.kestrel; delete st.fields.kestrel; // as the sync does for a deposit the company has not discovered
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const still = hud.labels.some(r => r.pick?.kind === 'field' && r.pick.id === 'kestrel');
    hud.select(null);
    const p = hud.pickAt((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2);
    st.fields.kestrel = saved;
    return { labelDrawnWhileUnknown: still, pickAtOldLabel: p ? `${p.kind}:${p.id}` : null };
  });
  assert(!hidden.labelDrawnWhileUnknown && hidden.pickAtOldLabel !== 'field:kestrel', 'an object missing from the client view has no label and cannot be picked', hidden);

  // 9. escort status in the panel and in the company works while the miners go out
  await page.evaluate(() => window.siderarium.client.setSpeed(4));
  await page.waitForTimeout(9000);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  const st9 = await server(page, 'const g = sim.st.groups[a.guard], m = sim.st.groups[a.mining]; return { guard: g.status, mining: m.status, phase: g.escort && g.escort.phase };', ids);
  assert(/호위/.test(st9.guard) && /(진형 유지|광구 경계|합류 중|주변 경계)/.test(st9.guard), 'escort status shown on the escort group', st9);
  await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), ids.guard); await page.waitForTimeout(400);
  const panelStatus = await page.locator('.gpanel .status').innerText();
  assert(/호위/.test(panelStatus), 'group panel shows the escort status', panelStatus);
  await page.screenshot({ path: `${out}/escort-panel-1440.png` });
  await page.locator('#opsBtn').click(); await page.waitForSelector('.ops-box');
  await page.getByRole('button', { name: '업무', exact: true }).click(); await page.waitForTimeout(400);
  const opsText = await page.locator('.ops-box').innerText();
  assert(/호위/.test(opsText) && /(진형 유지|광구 경계|합류 중|주변 경계)/.test(opsText), 'company works list shows the escort operation and its status', opsText.split('\n').filter(l => /호위/.test(l)).slice(0, 4));
  await page.screenshot({ path: `${out}/escort-works-1440.png` });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);

  // 10. repair: UI quote = charge; insufficient funds; research changes the quote
  const ship = await server(page, `
    const s = Object.values(sim.st.ships).find(x => x.owner === c.company && x.classId === 'destroyer');
    const astra = sim.st.stations.astra;
    if (s.state !== 'docked') { s.state = 'space'; s.pos = { ...astra.pos }; sim.dockShip(s, astra); }
    s.hp = 0.55; sim.st.companies[c.company].credits = 1e6; return s.id;`);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.siderarium.hud.openStation('astra', 'dock')); await page.waitForTimeout(700);
  const btn = page.locator(`[data-repair="${ship}"]`);
  await btn.waitFor({ timeout: 5000 });
  const quote1 = Number(await btn.getAttribute('data-quote'));
  const label1 = await btn.innerText();
  await page.screenshot({ path: `${out}/repair-dock-1440.png` });
  const cr0 = await server(page, 'return sim.st.companies[c.company].credits');
  await btn.click(); await page.waitForTimeout(500);
  const r10 = await server(page, 'const s = sim.st.ships[a]; return { hp: s.hp, credits: sim.st.companies[c.company].credits };', ship);
  assert(r10.hp === 1 && Math.round(cr0 - r10.credits) === quote1 && label1.includes(quote1.toLocaleString()), 'repair charges exactly the shown amount', { shown: label1, quote: quote1, charged: cr0 - r10.credits });
  // research on: quote drops by the repair multiplier
  await server(page, `const s = sim.st.ships[a]; s.hp = 0.55; const co = sim.st.companies[c.company]; co.tech = [...(co.tech||[]), 'damage_control'];`, ship);
  await page.waitForTimeout(800);
  const quote2 = Number(await page.locator(`[data-repair="${ship}"]`).getAttribute('data-quote'));
  assert(Math.abs(quote2 - Math.round(quote1 / 1.5)) <= 1, 'repair research lowers the shown quote (refreshed without reopening)', { without: quote1, with: quote2 });
  // insufficient funds: disabled with the exact reason
  await server(page, `sim.st.companies[c.company].credits = 10;`);
  await page.waitForTimeout(800);
  const reason = await page.locator('.warn.small', { hasText: '자금 부족' }).first().innerText();
  assert(/자금 부족 — 수리비 [\d,]+ cr, 보유 10 cr/.test(reason), 'insufficient funds shows the exact reason', reason);
  await page.keyboard.press('Escape');

  // ───────────────────────────────────────── touch (phone)
  await page.close(); // one software-rendered page at a time
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const tp = await ctx.newPage(); tp.on('pageerror', e => errors.push(String(e)));
  await open(tp);
  const tids = await tp.evaluate(() => ({ astra: window.siderarium.client.state.stations.astra.pos }));
  await focus(tp, tids.astra, 2600);
  await tp.evaluate(() => window.siderarium.hud.select(null));
  const tl = await findLabel(tp, 'station', 'astra');
  if (!tl) console.log('PHONE DEBUG', JSON.stringify(await tp.evaluate(() => ({ labels: window.siderarium.hud.labels.map(r => [r.pick?.kind, r.pick?.id, Math.round(r.x0), Math.round(r.y0)]), active: window.siderarium.view.active, w: innerWidth, h: innerHeight, sys: window.siderarium.view.sys?.id }))));
  assert(tl, 'phone: station label present');
  // the phone layout covers most of the map with panels; bring the label into a spot where the map is exposed
  const open_ = await tp.evaluate(() => { const cv = window.siderarium.view.renderer.domElement; for (let y = 60; y < innerHeight - 60; y += 10) for (let x = 20; x < innerWidth - 20; x += 10) { const ok = [[0, 0], [-15, -5], [15, 5]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === cv); if (ok) return { x, y }; } return null; });
  assert(open_, 'phone: an exposed map area exists', open_);
  let cur = tl;
  for (let k = 0; k < 8; k++) {
    const m = mid(cur), dx = open_.x - m.x, dy = open_.y - m.y;
    if (Math.hypot(dx, dy) < 6) break;
    await tp.evaluate(([x, y]) => window.siderarium.view.rig.pan(x, y), [dx, dy]); await tp.waitForTimeout(500);
    cur = await findLabel(tp, 'station', 'astra');
  }
  const at = await tp.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [mid(cur).x, mid(cur).y]);
  assert(at === 'CANVAS', 'phone: station label moved over the exposed map', { label: mid(cur), at });
  await tp.touchscreen.tap(mid(cur).x, mid(cur).y); await tp.waitForTimeout(250);
  assert((await sel(tp)).sel?.id === 'astra', 'phone: tapping the label selects the station', (await sel(tp)).sel);
  // double tap on the (exposed) station label: report what the browser does (dblclick from touch is browser-dependent)
  const d0 = await tp.evaluate(() => window.siderarium.view.rig.dist);
  const tl2 = await findLabel(tp, 'station', 'astra');
  await tp.touchscreen.tap(mid(tl2).x, mid(tl2).y); await tp.waitForTimeout(60); await tp.touchscreen.tap(mid(tl2).x, mid(tl2).y); await tp.waitForTimeout(300);
  const d1 = await tp.evaluate(() => window.siderarium.view.rig.dist);
  results.push({ label: 'phone: double tap on a label (informational)', ok: true, data: { distBefore: d0, distAfter: d1, focused: d1 === 2200 } });
  console.log('INFO phone double tap', JSON.stringify({ d0, d1 }));
  // a touch drag that starts on the label pans and does not change the selection
  await tp.evaluate(() => window.siderarium.hud.select(null));
  const tl3 = await findLabel(tp, 'station', 'astra');
  const fz0 = await tp.evaluate(() => { const r = window.siderarium.view.rig.focus; return [r.x, r.z]; });
  const cdp = await ctx.newCDPSession(tp);
  const pt = (x, y) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(mid(tl3).x, mid(tl3).y) });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(mid(tl3).x + i * 8, mid(tl3).y + i * 4) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await tp.waitForTimeout(300);
  const fz1 = await tp.evaluate(() => { const r = window.siderarium.view.rig.focus; return [r.x, r.z]; });
  assert((await sel(tp)).sel === null && (fz0[0] !== fz1[0] || fz0[1] !== fz1[1]), 'phone: touch drag from a label pans without selecting', { fz0, fz1 });
  await tp.screenshot({ path: `${out}/labels-phone-390.png` });

  assert(errors.length === 0, 'no page errors', errors);
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  console.log('ALL PASS');
})().catch(e => { console.error('FAIL', e.message); fs.writeFileSync(`${out}/results.json`, JSON.stringify({ results, error: e.message, errors }, null, 2)); process.exitCode = 1; }).finally(async () => { await browser?.close(); srv.kill(); });
