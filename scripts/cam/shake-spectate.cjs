// Shake setting on the real spectate path and in replays (built client + server). Needs `npm run build`.
//   node scripts/cam/shake-spectate.cjs
// 1 sp campaign → own ships engage a pirate lair → battle list → 관전 (window.__battle, the BattleHUD of battleLink)
// 2 the HUD setting starts at the default 약하게, is changed to 강하게 there, shakes in the cinematic camera, and 끄기 stops it at once
// 3 a page reload keeps the setting; a local battle and its replay (main.ts) open with the same setting
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const PORT = '8327';
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT, SAVE_FILE: require('os').tmpdir() + '/sid-camshake.json', DATABASE_URL: '' } });
let started = false;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
srv.stdout.on('data', async d => { if (started || !String(d).includes('listening')) return; started = true;
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const S = 'window.siderarium.client.t.server.sim';
  try {
    await p.goto(`http://localhost:${PORT}/?sp=new&name=카메라PMC`);
    await p.waitForFunction(() => { const c = window.siderarium?.client; return c?.company && c.state && window.siderarium.hud; }, null, { timeout: 120000 });
    await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company;
      const ls = Object.values(s.st.lairs); for (const l of ls.slice(1)) { l.alive = false; l.respawnAt = 1e9; } const l = ls.find(x => x.alive);
      const mine = Object.values(s.st.ships).filter(x => x.owner === me);
      for (const sh of mine) { sh.state = 'space'; sh.task = { k: 'none' }; sh.pos = { x: l.pos.x + 600 + Math.random() * 80, y: 0, z: l.pos.z + 300 }; } return mine.length; })()`);
    let eng = null;
    for (let i = 0; i < 60 && !eng; i++) { await p.waitForTimeout(1000); eng = await p.evaluate(`(() => { const s = ${S}; const me = window.siderarium.client.company; const e = Object.values(s.st.engagements).find(e => !e.done && e.sides.some(x => x.includes(me))); return e ? e.id : null; })()`); }
    ok(!!eng, 'engagement started: ' + eng);
    await p.evaluate('window.siderarium.hud.toggleBattles()'); await p.waitForTimeout(800);
    await p.click(`[data-watch="${eng}"]`);
    await p.waitForFunction(() => window.__battle?.view?.views?.size > 0 && document.querySelector('#shakeSel'), null, { timeout: 60000 });
    ok(await p.$eval('#shakeSel', e => e.value) === 'low' && await p.evaluate(() => window.__battle.view.rig.shakeLevel) === 'low', 'spectate: default setting 약하게');
    await p.selectOption('#shakeSel', 'high'); await p.click('[data-cam=director]');
    ok(await p.evaluate(() => window.__battle.view.rig.shakeLevel === 'high' && localStorage.getItem('siderarium.battle.shake') === 'high'), 'spectate: 강하게 applied to the camera and stored');
    // watch in real time; inject one large explosion next to the camera if the battle produced none, to check 끄기 mid-shake
    const watch = await p.evaluate(async () => { const rig = window.__battle.view.rig; let max = 0; const end = performance.now() + 12000;
      while (performance.now() < end) { await new Promise(r => requestAnimationFrame(r)); max = Math.max(max, rig.shakeOut.px); }
      let injected = false; if (rig.shake < 0.2) { rig.addShake(3, 'blast'); injected = true; }
      await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
      return { natural: +max.toFixed(2), injected, before: +rig.shakeOut.px.toFixed(2), cuts: rig.cuts.length, mode: rig.mode }; });
    await p.selectOption('#shakeSel', 'off');
    const after = await p.evaluate(async () => { const rig = window.__battle.view.rig; await new Promise(r => requestAnimationFrame(r)); return { px: rig.shakeOut.px, shake: rig.shake }; });
    ok(watch.before > 0 && after.px === 0 && after.shake === 0, `spectate: 끄기 stops a running shake at once (${JSON.stringify(watch)} → ${JSON.stringify(after)})`);
    await p.screenshot({ path: 'shots/cam/spectate-director.png' });
    await p.evaluate(() => window.__battleLink.close());
    // reload: a local battle and its replay pick up the stored setting
    await p.goto(`http://localhost:${PORT}/?auto&scenario=kestrel&manual=1`);
    await p.waitForFunction(() => window.session?.view && document.querySelector('#shakeSel'), null, { timeout: 60000 });
    ok(await p.$eval('#shakeSel', e => e.value) === 'off' && await p.evaluate(() => window.session.view.rig.shakeLevel) === 'off', 'reload → local battle opens with the spectate setting (끄기)');
    await p.selectOption('#shakeSel', 'mid');
    await p.evaluate(() => { for (let i = 0; i < 300; i++) window.session.tick(1 / 30); });
    await p.evaluate(() => window.hud.opts.onReplay());   // the result screen's 다시 보기 path
    await p.waitForFunction(() => window.session?.view && document.querySelector('#shakeSel'), null, { timeout: 60000 });
    const rp = await p.evaluate(() => ({ sel: document.querySelector('#shakeSel').value, rig: window.session.view.rig.shakeLevel, mode: window.session.view.rig.mode, n: document.querySelectorAll('#shakeSel').length }));
    ok(rp.sel === 'mid' && rp.rig === 'mid' && rp.mode === 'director' && rp.n === 1, 'replay opens in the cinematic camera with the same setting: ' + JSON.stringify(rp));
  } catch (e) { ok(false, 'error: ' + e.message); }
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await b.close(); srv.kill(); process.exit();
});
srv.stderr.on('data', d => process.stderr.write(d));
