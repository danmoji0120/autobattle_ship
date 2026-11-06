// Model pipeline browser checks (P8). Needs `npm run build`. Run from the repo root:
//   node scripts/models/check-preview.cjs   — ?modelview previews + 404 fallback + MIME
//   node scripts/models/check-game.cjs      — spawn/move/zoom/fit/battle/destroy/many/reload/fallback in a real game
//   node scripts/models/check-perf.cjs      — frame time, draw calls, geometry/heap over rebuilds (models vs ?models=0)
// Screenshots go to $OUT (default shots/models). Uses the pre-installed Playwright Chromium (swiftshader).
// P8-pre in-game check: testbed_destroyer (military) + testbed_hauler (industrial), external GLB models
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const OUT = (process.env.OUT ?? 'shots/models') + '/'; require('fs').mkdirSync(OUT, { recursive: true });
const srv = spawn('node', ['dist-server/server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '8326', SAVE_FILE: require('os').tmpdir() + '/sid-modelcheck-game.json', DATABASE_URL: '' } });
let started = false;
srv.stdout.on('data', async d => { if (started || !String(d).includes('listening')) return; started = true;
  const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.on('console', m => { if (m.text().startsWith('LOD camera')) console.log(m.text()); });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  const shot = n => p.screenshot({ path: OUT + `${n}.png`, timeout: 240000 });
  const S = 'window.siderarium.client.t.server.sim', V = 'window.siderarium.view', hud = 'window.siderarium.hud';
  const states = ids => p.evaluate(`JSON.stringify(${JSON.stringify(ids)}.map(id => { const v = ${V}.ships.get(id); return v ? (v.model.model?.state ?? 'none') : 'absent'; }))`).then(JSON.parse);
  const waitModels = async (ids, want = 'model', t = 60) => { for (let i = 0; i < t; i++) { const s = await states(ids); if (s.every(x => x === want)) return s; await p.waitForTimeout(500); } return states(ids); };
  try {
    await p.goto('http://localhost:8326/?sp=new&name=모델PMC');
    await p.waitForFunction(() => { const c = window.siderarium?.client; return c?.company && c.state && window.siderarium.hud; }, null, { timeout: 120000 });
    // ---- spawn: 2 destroyers + 1 hauler in space next to the home station
    await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const co = s.st.companies[me]; co.credits = 5e6;
      const home = s.st.stations[co.homeStation]; window.__home = home.id;
      const g = s.newGroup(me, '모델 시험 편대'); window.__g = g.id; const at = { x: home.pos.x + 900, y: 0, z: home.pos.z + 500 };
      window.__ships = [s.spawnHull(me, 'testbed_destroyer', 'testbed_destroyer_std', 'testbed_dd_mixed', g.id, at).id, s.spawnHull(me, 'testbed_destroyer', 'testbed_destroyer_std', 'testbed_dd_mixed', g.id, at).id, s.spawnHull(me, 'testbed_hauler', 'testbed_hauler_std', 'testbed_hauler_std', g.id, at).id];
      for (const [i, id] of window.__ships.entries()) { const sh = s.st.ships[id]; sh.state = 'space'; sh.task = { k: 'none' }; sh.pos = { x: at.x + i * 70, y: 0, z: at.z + i * 40 }; }
      window.__at = at; })()`);
    const ids = await p.evaluate('window.__ships');
    await p.evaluate(`${V}.focusOn(window.__at, 260)`);
    let st = await waitModels(ids);
    ok(st.every(x => x === 'model'), 'spawn → strategic view draws the GLB models: ' + st.join(','));
    const hullOk = await p.evaluate(`window.__ships.map(id => ${S}.st.ships[id].hull).join(',')`);
    ok(hullOk === 'testbed_destroyer,testbed_destroyer,testbed_hauler', 'server ships carry the hull ids: ' + hullOk);
    await p.waitForTimeout(1500); await shot('g1-spawn');
    // ---- move & rotate
    const pos = () => p.evaluate(`JSON.stringify(window.__ships.map(id => { const v = ${V}.ships.get(id); const s = ${S}.st.ships[id]; return [v.pos.x, v.pos.z, v.heading, s.pos.x, s.pos.z, s.state, s.task.k]; }))`);
    const before = await pos();
    await p.evaluate(`${S}.command(window.siderarium.client.company, { c: 'setOp', group: window.__g, op: { k: 'move', to: { x: window.__at.x - 3000, y: 0, z: window.__at.z + 2500 } } })`);
    await p.waitForTimeout(10000);
    const after = await pos(); console.log('move before', before, '\nmove after', after);
    const moved = JSON.parse(after).map((a, i) => [Math.hypot(a[0] - JSON.parse(before)[i][0], a[1] - JSON.parse(before)[i][1]), Math.abs(a[2] - JSON.parse(before)[i][2])]);
    ok(moved.every(m => m[0] > 60) && moved.some(m => m[1] > 0.1), 'ships move and turn: ' + moved.map(m => `${m[0].toFixed(0)}u/${m[1].toFixed(2)}rad`).join(' '));
    await p.evaluate(`(() => { const v = ${V}.ships.get(window.__ships[0]); ${V}.focusOn({ x: v.raw.x, y: 0, z: v.raw.z }, 200); })()`);
    await p.waitForTimeout(1200); await shot('g2-move');
    st = await states(ids); ok(st.every(x => x === 'model'), 'still models while moving: ' + st.join(','));
    // ---- zoom: close / far (LOD level)
    const lodLevel = () => p.evaluate(`(() => { const v = ${V}; const m = v.ships.get(window.__ships[0]).model; let lv = -1, lod = null; m.front.traverse(o => { if (o.isLOD) { lv = o.getCurrentLevel(); lod = o; } }); const cp = new (v.rig.camera.position.constructor)(); v.rig.camera.getWorldPosition(cp); const lp = cp.clone(); lod.getWorldPosition(lp); console.log('LOD camera distance', cp.distanceTo(lp).toFixed(0), 'rig', v.rig.dist, 'vis', m.root.visible, 'levels', lod.levels.map(l => l.distance)); return lv; })()`);
    await p.evaluate(`(() => { const v = ${V}.ships.get(window.__ships[0]); ${V}.focusOn({ x: v.raw.x, y: 0, z: v.raw.z }, 70); })()`); await p.waitForTimeout(1500);
    const lvNear = await lodLevel(); await shot('g3-zoom-near');
    await p.evaluate(`(() => { const v = ${V}.ships.get(window.__ships[0]); ${V}.focusOn({ x: v.raw.x, y: 0, z: v.raw.z }, 3000); })()`); await p.waitForTimeout(1500);
    const lvFar = await lodLevel(); await shot('g3-zoom-far');
    ok(lvNear === 0 && lvFar === 1, `camera zoom: LOD level near ${lvNear}, far ${lvFar}`);
    // ---- fitting: dock the first destroyer at the home station, open the fitting UI, change weapons
    await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const sh = s.st.ships[window.__ships[0]]; const home = s.st.stations[window.__home];
      s.st.groups[window.__g].op = { k: 'idle' }; for (const id of window.__ships) s.st.ships[id].task = { k: 'none' };
      s.dockShip(sh, home);
      const sto = (home.storage[me] ??= {}); Object.assign(sto, { eq_autocannon: 4, eq_laser_red: 2, eq_medium_gun: 2, eq_pd_gun: 2 }); })()`);
    const r = await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const sh = s.st.ships[window.__ships[0]];
      return s.command(me, { c: 'fit', ship: sh.id, variant: sh.variant, hp: { ...sh.fitting.hp, main1: 'eq_autocannon', main2: 'eq_autocannon' }, bay: sh.fitting.bay, buy: true }); })()`);
    await p.waitForTimeout(2000);
    await p.evaluate(`${hud}.openFitting(window.__ships[0])`); await p.waitForTimeout(2500);
    await shot('g4-fitting');
    const fitHp = await p.evaluate(`JSON.stringify(${S}.st.ships[window.__ships[0]].fitting.hp)`);
    ok(/"main1":"eq_autocannon"/.test(fitHp), `fit command (${r ?? 'ok'}) → ${fitHp}`);
    if (await p.$('[data-fclose]')) await p.click('[data-fclose]');
    await p.waitForTimeout(800);
    const mounts = await p.evaluate(`JSON.stringify(${V}.ships.get(window.__ships[0]).model.turrets.map(t => t.mount.weapon))`);
    st = await states([ids[0]]);
    ok(/"autocannon"/.test(mounts) && st[0] === 'model', 'refit rebuilds the ship with the model + new turrets: ' + mounts + ' ' + st[0]);
    await p.evaluate(`(() => { const s = ${S}; const sh = s.st.ships[window.__ships[0]]; sh.task = { k: 'none' }; sh.state = 'space'; sh.pos = { ...s.st.ships[window.__ships[1]].pos }; sh.pos.x += 80; })()`);
    // ---- battle: send the group to a pirate lair
    await p.evaluate(`(() => { const s = ${S}; for (const l of Object.values(s.st.lairs)) if (l.id !== Object.keys(s.st.lairs)[0]) { l.alive = false; l.respawnAt = 1e9; }
      const l = Object.values(s.st.lairs).find(x => x.alive); for (const id of window.__ships) { const sh = s.st.ships[id]; sh.state = 'space'; sh.task = { k: 'none' }; sh.pos = { x: l.pos.x + 600 + Math.random() * 60, y: 0, z: l.pos.z + 300 }; } })()`);
    let eng = null;
    for (let i = 0; i < 60 && !eng; i++) { await p.waitForTimeout(1000); eng = await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const e = Object.values(s.st.engagements).find(e => !e.done && (e.sides[0].includes(me) || e.sides[1].includes(me))); return e ? e.id : null; })()`); }
    ok(!!eng, 'engagement started: ' + eng);
    if (eng) {
      await p.evaluate(`${hud}.toggleBattles()`); await p.waitForTimeout(800);
      await p.click(`[data-watch="${eng}"]`);
      await p.waitForFunction(() => window.__battle?.view?.views?.size > 0, null, { timeout: 60000 });
      const bstates = async () => p.evaluate(() => JSON.stringify([...window.__battle.view.views.values()].filter(v => v.model.model).map(v => [v.ship.loadout.mesh?.model, v.model.model.state])));
      for (let i = 0; i < 40; i++) { const s = JSON.parse(await bstates()); if (s.length && s.every(x => x[1] === 'model')) break; await p.waitForTimeout(500); }
      const bs = JSON.parse(await bstates());
      ok(bs.length === 3 && bs.every(x => x[1] === 'model'), 'battle view: 3 model ships, ' + JSON.stringify(bs));
      // fitting reached the battle sim (mounts) and the render-only mesh did too
      const bfit = await p.evaluate(() => JSON.stringify([...window.__battle.world.ships].filter(s => s.loadout.mesh?.model).map(s => s.loadout.mounts.map(m => m.weapon).join('+'))));
      ok(/autocannon\+autocannon/.test(bfit), 'battle ships fight with their fitted weapons: ' + bfit);
      const follow = await p.$('button:has-text("추적")'); if (follow) await follow.click();
      // camera onto our first model ship
      await p.evaluate(() => { const w = window.__battle; const s = w.world.ships.find(x => x.loadout.mesh?.model === 'model.testbed_destroyer'); w.view.rig.focus.set(s.pos.x, s.pos.y, s.pos.z); w.view.rig.dist = 120; });
      await p.waitForTimeout(6000); await shot('g5-battle-fire');
      const fire = await p.evaluate(() => { const w = window.__battle.world; const mine = w.ships.filter(s => s.loadout.mesh?.model); return JSON.stringify({ shots: mine.map(s => s.mounts.filter(m => m.cooldown > 0 || m.shotsFired > 0).length), hp: mine.map(s => +(s.hp / s.maxHp).toFixed(2)), time: +w.time.toFixed(1) }); });
      console.log('battle state', fire);
      // hit + destruction (visual check, client-side): finish the hauler and watch it break apart
      await p.waitForTimeout(6000); await shot('g6-battle-hit');
      const hit = await p.evaluate(() => window.__battle.world.ships.filter(s => s.loadout.mesh?.model).map(s => +(s.hp / s.maxHp).toFixed(2)).join(','));
      ok(hit.split(',').some(x => +x < 1), 'model ships take hits: hp ' + hit);
      await p.evaluate(() => { const w = window.__battle; const s = w.world.ships.find(x => x.loadout.mesh?.model === 'model.testbed_destroyer' && x.state === 'alive'); window.__victim = s.id; w.world.startDying(s, -1, false, 'test'); w.view.rig.focus.set(s.pos.x, s.pos.y, s.pos.z); w.view.rig.dist = 160; });
      for (let i = 0; i < 30; i++) { const d = await p.evaluate(() => window.__battle.world.ships.find(s => s.id === window.__victim).state); if (d !== 'alive') break; await p.waitForTimeout(500); }
      await p.waitForTimeout(2500); await shot('g7-battle-destroyed');
      const wreck = await p.evaluate(() => { const w = window.__battle; const v = w.view.views.get(window.__victim); let n = 0; for (const h of [v.model.front, v.model.rear]) h.traverse(o => { if (o.userData.proc === 'model') n++; }); return JSON.stringify({ state: v.ship.state, wrecks: w.view.wrecks?.length, modelHalves: n, visible: v.model.root.visible }); });
      ok(/"modelHalves":2/.test(wreck) && !/"state":"alive"/.test(wreck), 'destroyed model ship breaks into model wreck halves: ' + wreck);
      await p.evaluate(() => { const w = window.__battle; w.view.rig.dist = 1800; }); await p.waitForTimeout(2000); await shot('g8-battle-wide');
      await p.evaluate(() => window.__battleLink.close());
      await p.waitForTimeout(1500);
    }
    // ---- many ships: 24 model destroyers + 8 haulers in view; frame timing and draw calls vs procedural
    await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const home = s.st.stations[window.__home]; const g = s.newGroup(me, '대량 편대'); window.__many = [];
      for (let i = 0; i < 32; i++) { const h = i < 24 ? ['testbed_destroyer', 'testbed_destroyer_std', 'testbed_dd_mixed'] : ['testbed_hauler', 'testbed_hauler_std', 'testbed_hauler_std'];
        const sh = s.spawnHull(me, h[0], h[1], h[2], g.id, home.pos); sh.state = 'space'; sh.task = { k: 'none' }; sh.pos = { x: home.pos.x - 1500 + (i % 8) * 70, y: 0, z: home.pos.z + 1500 + Math.floor(i / 8) * 90 }; window.__many.push(sh.id); }
      ${V}.focusOn({ x: home.pos.x - 1250, y: 0, z: home.pos.z + 1640 }, 700); })()`);
    const many = await p.evaluate('window.__many');
    st = await waitModels(many);
    ok(st.every(x => x === 'model'), `32 ships drawn as models (${st.filter(x => x === 'model').length}/32)`);
    await p.waitForTimeout(1500); await shot('g9-many');
    const perf = await p.evaluate(`new Promise(res => { const v = ${V}; const t = []; let last = performance.now(); let n = 0; const f = () => { const now = performance.now(); t.push(now - last); last = now; if (++n < 90) requestAnimationFrame(f); else { t.sort((a, b) => a - b); const info = v.renderer.info; res(JSON.stringify({ median: +t[45].toFixed(1), p90: +t[81].toFixed(1), geos: info.memory.geometries, tex: info.memory.textures, models: window.__sidModels })); } }; requestAnimationFrame(f); })`);
    console.log('PERF models', perf);
    // memory: rebuild the 32 ships 10× (refit key change) and check geometry count stays flat
    const geo0 = await p.evaluate(`${V}.renderer.info.memory.geometries`);
    for (let k = 0; k < 10; k++) {
      await p.evaluate(`(() => { const s = ${S}; for (const id of window.__many) { const sh = s.st.ships[id]; if (sh.fitting.hp.pd1) { sh.fitting.hp.pd1 = sh.fitting.hp.pd1 === 'eq_pd_gun' ? 'eq_autocannon' : 'eq_pd_gun'; sh.fitting.preset = undefined; } } })()`);
      await p.waitForTimeout(1200);
    }
    const geo1 = await p.evaluate(`${V}.renderer.info.memory.geometries`);
    const heap = await p.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
    ok(geo1 <= geo0 + 8, `10 rebuilds of 32 ships: GPU geometries ${geo0} → ${geo1} (heap ${heap} MB), loader fetches ${await p.evaluate('window.__sidModels.fetches')}`);
    // ---- save + reconnect
    await p.evaluate(`window.siderarium.client.t.saveNow?.() ?? window.siderarium.client.t.server.saveNow()`);
    await p.waitForTimeout(800);
    await p.goto('http://localhost:8326/?sp=continue&name=모델PMC', { timeout: 180000 });
    await p.waitForFunction(() => { const c = window.siderarium?.client; return c?.company && c.state && window.siderarium.hud; }, null, { timeout: 120000 });
    const ids2 = await p.evaluate(`Object.values(${S}.st.ships).filter(s => s.hull?.startsWith('testbed_')).map(s => s.id)`);
    await p.evaluate(`(() => { const s = ${S}; const sh = s.st.ships[${JSON.stringify(many[0])}]; ${V}.focusOn(sh.pos, 700); })()`);
    st = await waitModels(ids2.filter(id => many.includes(id)));
    ok(ids2.length >= 32 && st.every(x => x === 'model'), `after reload: ${ids2.length} testbed ships, models ${st.filter(x => x === 'model').length}/${st.length}`);
    await p.waitForTimeout(1200); await shot('g10-reloaded');
    // ---- load failure in game: block GLB downloads → procedural fallback, ships still there
    await p.close();
    const p2 = await ctx.newPage(); const w2 = []; p2.on('console', m => w2.push(m.text())); p2.on('pageerror', e => errs.push(String(e)));
    await p2.route('**/*.glb*', r => r.fulfill({ status: 404, body: 'nf' }));
    await p2.goto('http://localhost:8326/?sp=continue&name=모델PMC', { timeout: 180000 });
    await p2.waitForFunction(() => { const c = window.siderarium?.client; return c?.company && c.state && window.siderarium.hud; }, null, { timeout: 120000 });
    await p2.evaluate(`(() => { const s = ${S}; const sh = s.st.ships[${JSON.stringify(many[0])}]; ${V}.focusOn(sh.pos, 700); })()`);
    await p2.waitForTimeout(5000);
    const fb = await p2.evaluate(`JSON.stringify(${JSON.stringify(many)}.map(id => { const v = ${V}.ships.get(id); return v ? [v.model.model?.state, v.model.root.visible, v.model.front.children.length > 0] : null; }))`);
    const fbs = JSON.parse(fb);
    ok(fbs.every(x => x && x[0] === 'fallback' && x[1] && x[2]), 'GLB blocked: all 32 ships visible with the procedural hull (' + fbs.filter(x => x?.[0] === 'fallback').length + ' fallback)');
    ok(w2.filter(x => x.includes('[model]')).length === 2, 'one warning per model file: ' + w2.filter(x => x.includes('[model]')).length);
    await p2.screenshot({ path: OUT + 'g11-fallback.png' });
    const perf2 = await p2.evaluate(`new Promise(res => { const v = ${V}; const t = []; let last = performance.now(); let n = 0; const f = () => { const now = performance.now(); t.push(now - last); last = now; if (++n < 90) requestAnimationFrame(f); else { t.sort((a, b) => a - b); const info = v.renderer.info; res(JSON.stringify({ median: +t[45].toFixed(1), p90: +t[81].toFixed(1), geos: info.memory.geometries })); } }; requestAnimationFrame(f); })`);
    console.log('PERF procedural (fallback)', perf2);
    ok(!errs.length, 'no page errors: ' + errs.slice(0, 5).join(' / '));
  } catch (e) { console.log('ERR', e); process.exitCode = 1; await shot('gERR').catch(() => {}); }
  await b.close(); srv.kill();
});
