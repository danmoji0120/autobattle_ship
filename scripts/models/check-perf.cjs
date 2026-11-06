// Model pipeline browser checks (P8). Needs `npm run build`. Run from the repo root:
//   node scripts/models/check-preview.cjs   — ?modelview previews + 404 fallback + MIME
//   node scripts/models/check-game.cjs      — spawn/move/zoom/fit/battle/destroy/many/reload/fallback in a real game
//   node scripts/models/check-perf.cjs      — frame time, draw calls, geometry/heap over rebuilds (models vs ?models=0)
// Screenshots go to $OUT (default shots/models). Uses the pre-installed Playwright Chromium (swiftshader).
// P8-pre performance: N model ships vs the same ships drawn procedurally (?models=0)
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const srv = spawn('node', ['dist-server/server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '8328', SAVE_FILE: require('os').tmpdir() + '/sid-modelcheck-perf.json', DATABASE_URL: '' } });
let started = false;
srv.stdout.on('data', async d => { if (started || !String(d).includes('listening')) return; started = true;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const S = 'window.siderarium.client.t.server.sim', V = 'window.siderarium.view';
  const boot = async (p, q) => { await p.goto('http://localhost:8328/' + q, { timeout: 180000 }); await p.waitForFunction(() => { const c = window.siderarium?.client; return c?.company && c.state && window.siderarium.hud; }, null, { timeout: 180000 }); };
  const measure = p => p.evaluate(`new Promise(res => { const v = ${V}; const info = v.renderer.info; info.autoReset = false; const t = [], calls = [], tris = []; let last = performance.now(), n = 0;
    const f = () => { const now = performance.now(); if (n > 0) { t.push(now - last); calls.push(info.render.calls); tris.push(info.render.triangles); } info.reset(); last = now;
      if (++n < 61) requestAnimationFrame(f); else { const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }; info.autoReset = true;
        res({ frameMs: +med(t).toFixed(1), calls: med(calls), tris: med(tris), geos: info.memory.geometries, tex: info.memory.textures, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1, loader: { ...(window.__sidModels ?? {}) } }); } };
    requestAnimationFrame(f); })`);
  const out = {};
  try {
    const p = await ctx.newPage();
    await boot(p, '?sp=new&name=perf');
    const N = Number(process.env.N ?? 48);
    await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const home = s.st.stations[s.st.companies[me].homeStation]; const g = s.newGroup(me, 'perf'); window.__c = { x: home.pos.x - 1250, y: 0, z: home.pos.z + 1700 };
      for (let i = 0; i < ${N}; i++) { const h = i % 4 === 3 ? ['testbed_hauler', 'testbed_hauler_std', 'testbed_hauler_std'] : ['testbed_destroyer', 'testbed_destroyer_std', 'testbed_dd_mixed'];
        const sh = s.spawnHull(me, h[0], h[1], h[2], g.id, home.pos); sh.state = 'space'; sh.task = { k: 'none' }; sh.pos = { x: window.__c.x - 280 + (i % 8) * 80, y: 0, z: window.__c.z - 250 + Math.floor(i / 8) * 90 }; }
      s.st.groups[g.id].op = { k: 'idle' }; window.siderarium.client.setSpeed?.(0); })()`);
    await p.evaluate(`window.siderarium.client.t.saveNow?.() ?? window.siderarium.client.t.server.saveNow()`);
    await p.close();
    const centre = pg => pg.evaluate(`(() => { const s = ${S}; const l = Object.values(s.st.ships).filter(x => x.hull?.startsWith('testbed')); window.__c = { x: l.reduce((a, x) => a + x.pos.x, 0) / l.length, y: 0, z: l.reduce((a, x) => a + x.pos.z, 0) / l.length }; window.siderarium.client.setSpeed?.(0); })()`);
    for (const [mode, q0] of [['models', ''], ['procedural', '&models=0'], ['models#2', ''], ['procedural#2', '&models=0']]) {
      const q = await ctx.newPage();
      await boot(q, '?sp=continue&name=perf' + q0); await centre(q);
      const r = {};
      for (const [k, dist] of [['near', 700], ['mid', 2500], ['far', 9000]]) { await q.evaluate(`${V}.focusOn(window.__c, ${dist})`); await q.waitForTimeout(k === 'near' ? 8000 : 3000); r[k] = await measure(q); }
      await q.evaluate(`${V}.focusOn({ x: window.__c.x + 40000, y: 0, z: window.__c.z + 40000 }, 700)`); await q.waitForTimeout(3000); r.offscreen = await measure(q);
      if (mode === 'models' || mode === 'procedural') {
        await q.evaluate(`${V}.focusOn(window.__c, 700)`); await q.waitForTimeout(2000);
        const heap = () => q.evaluate(() => { window.gc?.(); return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : -1; });
        const g0 = await q.evaluate(`${V}.renderer.info.memory.geometries`), h0 = await heap();
        for (let k = 0; k < 20; k++) { await q.evaluate(`(() => { const s = ${S}; for (const sh of Object.values(s.st.ships)) if (sh.hull?.startsWith('testbed') && sh.fitting?.hp.pd1) { sh.fitting.hp.pd1 = sh.fitting.hp.pd1 === 'eq_pd_gun' ? 'eq_autocannon' : 'eq_pd_gun'; sh.fitting.preset = undefined; } })()`); await q.waitForTimeout(900); }
        await q.waitForTimeout(1500);
        r.rebuild20 = { geos: [g0, await q.evaluate(`${V}.renderer.info.memory.geometries`)], heapMB: [h0, await heap()], fetches: await q.evaluate('window.__sidModels.fetches') };
      }
      out[mode] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.loader ? { frameMs: v.frameMs, calls: v.calls, tris: v.tris, geos: v.geos, heapMB: v.heapMB } : v]));
      out[mode].loader = r.near.loader;
      await q.close();
    }
  } catch (e) { console.log('ERR', e); process.exitCode = 1; }
  console.log(JSON.stringify(out, null, 1));
  await b.close(); srv.kill();
});
