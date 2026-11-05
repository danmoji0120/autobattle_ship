// End-to-end UI check: drives real clicks through the HUD and verifies sim state changes.
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`); if (!c) process.exitCode = 1; };
await page.goto('http://localhost:5173/?manual=1');
await page.waitForFunction(() => window.fleetcmd);
// setup screen interactions
await page.click('[data-cat=destroyer]');
await page.click('[data-cat=destroyer] [data-add]');
ok(await page.evaluate(() => document.querySelector('.budget').textContent.startsWith('1755')), 'adding a destroyer updates budget (1755)');
ok(await page.evaluate(() => document.querySelector('#go').disabled), 'over-budget fleet cannot sortie');
await page.click('.srow:last-of-type .x').catch(() => {});
await page.evaluate(() => { const xs = [...document.querySelectorAll('[data-sdel]')]; xs[xs.length - 1].click(); });
await page.waitForTimeout(200);
ok(await page.evaluate(() => !document.querySelector('#go').disabled), 'removing it re-enables sortie');
await page.click('#go');
await page.waitForFunction(() => window.fleetcmd.session);
const meshes = await page.evaluate(() => { let n = 0; window.fleetcmd.session.view.scene.traverse(o => { if (o.isMesh && o.visible) n++; }); return n; });
console.log('visible meshes in scene:', meshes);
await page.evaluate(() => { const s = window.fleetcmd.session; s.fastForward(8); s.tick(1 / 30); });
// select the strike group from the tree
await page.evaluate(() => { [...document.querySelectorAll('.node .nm')].find(e => e.textContent.startsWith('뇌격 1편대'))?.closest('.node')?.click(); });
let sel = await page.evaluate(() => window.hud.selected && window.fleetcmd.session.world.groupById.get(window.hud.selected).name);
if (sel !== '뇌격 1편대') {
  // expand 강습 전대 first
  await page.evaluate(() => { [...document.querySelectorAll('.node .nm')].find(e => e.textContent.startsWith('강습 전대')).closest('.node').querySelector('.tog').click(); });
  await page.evaluate(() => { [...document.querySelectorAll('.node .nm')].find(e => e.textContent.startsWith('뇌격 1편대')).closest('.node').click(); });
  sel = await page.evaluate(() => window.fleetcmd.session.world.groupById.get(window.hud.selected).name);
}
ok(sel === '뇌격 1편대', 'tree click selects nested group: ' + sel);
// press attack, then click on enemy main line in the tree
await page.click('[data-o=attack]');
await page.evaluate(() => { [...document.querySelectorAll('.node.enemyn .nm')].find(e => e.textContent.startsWith('중앙 전열')).closest('.node').click(); });
await page.evaluate(() => { const s = window.fleetcmd.session; s.world.step(); });
const ord = await page.evaluate(() => { const w = window.fleetcmd.session.world; const g = w.groupById.get(window.hud.selected); return { type: g.order.type, tgt: w.groupById.get(g.order.targetGroup)?.name, ov: g.playerOverride }; });
ok(ord.type === 'attack' && ord.tgt === '중앙 전열' && ord.ov, 'attack order via button + tree target: ' + JSON.stringify(ord));
// right-click on an enemy ship on screen → attack its group
await page.evaluate(() => window.fleetcmd.session.tick(1 / 30));
const pos = await page.evaluate(() => {
  const s = window.fleetcmd.session; const v = s.view; const w = s.world;
  const e = w.ships.find(x => x.team === 1 && x.state === 'alive' && x.cls.id === 'battleship');
  const o = new (v.rig.camera.position.constructor)(); v.project(v.views.get(e.id).wpos, o, innerWidth, innerHeight);
  return { x: o.x, y: o.y, g: w.groupById.get(e.groupId).name };
});
// re-select the main battle group then right click
await page.evaluate(() => { [...document.querySelectorAll('.node .nm')].find(e => e.textContent.startsWith('주력 전대')).closest('.node').click(); });
await page.mouse.click(pos.x, pos.y, { button: 'right' });
await page.evaluate(() => window.fleetcmd.session.world.step());
const ord2 = await page.evaluate(() => { const w = window.fleetcmd.session.world; const g = w.groupById.get(window.hud.selected); return { name: g.name, type: g.order.type, tgt: g.order.targetGroup !== undefined ? w.groupById.get(g.order.targetGroup)?.name : null }; });
ok(ord2.type === 'attack' && ord2.tgt === pos.g, 'right-click on enemy ship issues attack: ' + JSON.stringify(ord2));
// release command back to admiral
await page.keyboard.press('KeyT');
await page.evaluate(() => window.fleetcmd.session.world.step());
ok(await page.evaluate(() => !window.fleetcmd.session.world.groupById.get(window.hud.selected).playerOverride), 'T releases command to superior');
// radio acknowledgements appear
const radio = await page.evaluate(() => [...document.querySelectorAll('#radioBody .msg .tx')].map(e => e.textContent).slice(-4));
console.log('radio:', radio);
ok(radio.length > 0, 'radio shows acknowledgements');
// speed + pause
await page.keyboard.press('Space');
ok(await page.evaluate(() => window.fleetcmd.session.paused), 'space pauses');
await page.keyboard.press('Space');
// play to the end, check the result modal, then the replay reproduces the same outcome
await page.evaluate(() => window.fleetcmd.session.fastForward(700));
const live = await page.evaluate(() => ({ o: window.fleetcmd.session.world.outcome, d: window.fleetcmd.session.world.digest() }));
await page.evaluate(() => window.fleetcmd.session.tick(1 / 30));
await page.waitForSelector('.result', { timeout: 8000 });
ok(true, 'result modal shown: ' + JSON.stringify(live.o));
await page.click('[data-a=replay]');
await page.waitForFunction(() => window.hud && document.querySelector('#topbar'));
await page.evaluate(() => window.fleetcmd.session.fastForward(700));
const rep = await page.evaluate(() => ({ o: window.fleetcmd.session.world.outcome, d: window.fleetcmd.session.world.digest() }));
ok(rep.d === live.d && rep.o.winner === live.o.winner, `replay reproduces battle exactly (${rep.d} vs ${live.d})`);
ok(errors.length === 0, 'no page errors ' + errors.slice(0, 3).join(' | '));
await browser.close();
