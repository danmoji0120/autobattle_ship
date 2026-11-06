// Model pipeline browser checks (P8). Needs `npm run build`. Run from the repo root:
//   node scripts/models/check-preview.cjs   — ?modelview previews + 404 fallback + MIME
//   node scripts/models/check-game.cjs      — spawn/move/zoom/fit/battle/destroy/many/reload/fallback in a real game
//   node scripts/models/check-perf.cjs      — frame time, draw calls, geometry/heap over rebuilds (models vs ?models=0)
// Screenshots go to $OUT (default shots/models). Uses the pre-installed Playwright Chromium (swiftshader).
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const OUT = (process.env.OUT ?? 'shots/models') + '/'; require('fs').mkdirSync(OUT, { recursive: true });
const srv = spawn('node', ['dist-server/server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '8325', SAVE_FILE: require('os').tmpdir() + '/sid-modelcheck-preview.json', DATABASE_URL: '' } });
let started = false;
srv.stdout.on('data', async d => { if (started || !String(d).includes('listening')) return; started = true;
  const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) process.exitCode = 1; };
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  try {
    for (const [hull, extra, name] of [['testbed_destroyer', '&still', 'pv-dd'], ['testbed_hauler', '&still', 'pv-hauler'], ['testbed_destroyer', '&still&models=0', 'pv-dd-off'], ['testbed_destroyer', '&still&team=1&solo', 'pv-dd-red']]) {
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
      await p.goto(`http://localhost:8325/?modelview=${hull}${extra}`);
      await p.waitForFunction(() => { const s = document.querySelector('[data-state]')?.dataset.state; return s && s !== 'loading'; }, null, { timeout: 60000 });
      await p.waitForTimeout(1500);
      const st = await p.evaluate(() => ({ state: document.querySelector('[data-state]').dataset.state, txt: document.querySelector('[data-state]').textContent, stats: window.__sidModels }));
      ok(extra.includes('models=0') ? st.state !== 'model' : st.state === 'model', `${name}: state ${st.state}`);
      console.log(st.txt.split('\n').slice(0, 5).join(' | '));
      await p.screenshot({ path: OUT + name + '.png' });
      ok(!errs.length, `${name}: no errors ${errs.join(' / ')}`);
      await p.close();
    }
    // 404 fallback: block the GLB
    const p = await ctx.newPage(); const warns = []; p.on('console', m => warns.push(m.text()));
    await p.route('**/*.glb*', r => r.fulfill({ status: 404, body: 'nf' }));
    await p.goto('http://localhost:8325/?modelview=testbed_destroyer&still');
    await p.waitForFunction(() => document.querySelector('[data-state]')?.dataset.state === 'fallback', null, { timeout: 60000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: OUT + 'pv-dd-404.png' });
    ok(warns.some(w => w.includes('불러오기 실패')), '404 → fallback + one warning: ' + warns.filter(w => w.includes('[model]')).join(' / '));
    const r = await (await fetch('http://localhost:8325/assets/content/models/fixtures/nope.glb')).status;
    ok(r === 404, 'missing asset is HTTP 404 (' + r + ')');
    const ct = (await fetch('http://localhost:8325/assets/content/models/fixtures/testbed_hauler.glb')).headers.get('content-type');
    ok(ct === 'model/gltf-binary', 'glb content-type ' + ct);
  } catch (e) { console.log('ERR', e); process.exitCode = 1; }
  await b.close(); srv.kill();
});
