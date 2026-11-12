// BB-EX visual verification in a real browser (headless Chromium, the real 3D renderer).
//   node scripts/bbex-browser.mjs <query> <out-prefix> '<steps json>' [--size 1600x900] [--video dir]
// step: { t, shot?, cam?: {focus:[x,y,z]|'bbex', yaw, pitch, dist} | 'director' | 'follow', frames?, eval?, real? }
//   t      sim time to reach (fast-forwarded without rendering, then `frames` rendered frames)
//   real   seconds to run in real time before the shot (for video)
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const flag = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const size = (flag('--size') ?? '1600x900').split('x').map(Number);
const video = flag('--video');
const [query = 'bbex=mixed200', out = 'artifacts/bbex/shot', stepsJson = '[]'] = args;
const steps = JSON.parse(stepsJson);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, ...(video ? { recordVideo: { dir: video, size: { width: size[0], height: size[1] } } } : {}) });
const page = await ctx.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:5173/?${query}&manual=1`);
await page.waitForFunction(() => window.session, null, { timeout: 60000 });
await page.waitForTimeout(800);
for (const st of steps) {
  const t0 = Date.now();
  const info = await page.evaluate(async st => {
    const s = window.session, v = s.view, rig = v.rig, w = s.world;
    if (st.hud === false) for (const el of document.querySelectorAll('#app > *')) if (el.tagName !== 'CANVAS') el.style.display = 'none';
    if (st.t !== undefined && w.time < st.t - 0.6) s.fastForward(st.t - 0.5);
    while (st.t !== undefined && w.time < st.t && !w.outcome) s.tick(1 / 30);
    const ex = w.exShips[0];
    if (st.eval) (new Function('s', 'ex', st.eval))(s, ex);
    if (st.cam === 'director') rig.setMode('director');
    else if (st.cam === 'follow') { rig.setMode('follow'); rig.follow = () => v.followTarget(ex.id); }
    else if (st.cam) {
      rig.mode = 'tactical'; rig.minPitch = -1.4; rig.minDist = 20;
      const f = st.cam.focus === 'bbex' || !st.cam.focus ? [ex.pos.x, ex.pos.y, ex.pos.z] : st.cam.focus;
      rig.focus.set(f[0] + (st.cam.off?.[0] ?? 0), f[1] + (st.cam.off?.[1] ?? 0), f[2] + (st.cam.off?.[2] ?? 0)); rig.yaw = st.cam.yaw ?? rig.yaw; rig.pitch = st.cam.pitch ?? rig.pitch; rig.dist = st.cam.dist ?? rig.dist;
      rig.cur.focus.copy(rig.focus); rig.cur.yaw = rig.yaw; rig.cur.pitch = rig.pitch; rig.cur.dist = rig.dist;
    }
    if (st.real) { const end = performance.now() + st.real * 1000; let last = performance.now(); while (performance.now() < end) { await new Promise(r => requestAnimationFrame(r)); const now = performance.now(); s.tick(Math.min(0.1, (now - last) / 1000) * (st.rate ?? 1)); last = now; } }
    const n = st.frames ?? 2;
    const f0 = performance.now();
    for (let i = 0; i < n; i++) s.tick(st.dt ?? 1 / 60);
    const ms = (performance.now() - f0) / Math.max(1, n);
    return { t: +w.time.toFixed(2), alive: [w.ships.filter(x => x.team === 0 && x.state === 'alive').length, w.ships.filter(x => x.team === 1 && x.state === 'alive').length], frameMs: +ms.toFixed(1), stats: v.stats, ex: v.ex?.stats, phase: ex?.ex.phase, dcp: ex?.ex.dcp.state, form: ex?.ex.form, out: w.outcome?.reason };
  }, st);
  if (st.shot) await page.screenshot({ path: `${out}-${st.shot}.png` });
  console.log(`${(st.shot ?? '-').padEnd(18)} ${Date.now() - t0}ms`, JSON.stringify(info));
}
console.log(logs.slice(0, 30).join('\n') || 'no console errors');
await ctx.close();
await browser.close();
