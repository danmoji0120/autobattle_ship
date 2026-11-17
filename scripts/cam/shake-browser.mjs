// Battle camera shake / cinematic stability check in a real browser (headless Chromium, the real renderer, the battle HUD).
//   node scripts/cam/shake-browser.mjs [baseUrl=http://localhost:5173] [--legacy] [--only id,id]
// Needs the vite dev server (the BB-EX trials are dev only). For every scenario the same battle is watched through segments
// (camera mode × shake setting chosen through the HUD's own controls); per segment it reports the on-screen shake
// (max / p95 px, share of frames shaking), the director's cut intervals and the largest per-frame camera jump.
// --legacy measures a build from before the rework (no setting, position shake): px is then an estimate
//   (shake² × gain world units projected at the look distance).
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const legacy = args.includes('--legacy');
const onlyI = args.indexOf('--only'); const only = onlyI >= 0 ? args[onlyI + 1].split(',') : null;
const base = args.find(a => a.startsWith('http')) ?? 'http://localhost:5173';
const SCEN = [
  { id: 'kestrel', label: '1 소규모 포격전', q: 'auto&scenario=kestrel', t0: 25 },
  { id: 'wolfpack', label: '1b 고속 습격(어뢰·미사일 소규모)', q: 'auto&scenario=wolfpack', t0: 25 },
  { id: 'mixed200', label: '2 대규모 함대전(200척) + 5 BB-EX', q: 'bbex=mixed200', t0: 30 },
  { id: 'missile', label: '3 미사일 대량 포화(130척)', q: 'bbex=missile', t0: 25 },
  { id: 'swarm', label: '3b 어뢰정 160척', q: 'bbex=swarm', t0: 25 },
  { id: 'bb50', label: '4 전함 50척 격침', q: 'bbex=bb50', t0: 45 },
  { id: 'game_over', label: '5 BB-EX 결전 프로토콜', q: 'bbex=game_over', t0: 20 },
];
const SEGS = legacy
  ? [{ mode: 'director', level: null, sec: 16 }, { mode: 'follow', level: null, sec: 8 }, { mode: 'tactical', level: null, sec: 6 }]
  : [{ mode: 'director', level: 'low', sec: 16 }, { mode: 'director', level: 'high', sec: 10 }, { mode: 'follow', level: 'low', sec: 8 },
     { mode: 'follow', level: 'high', sec: 6 }, { mode: 'tactical', level: 'high', sec: 6 }, { mode: 'director', level: 'off', sec: 10 }];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
for (const sc of SCEN.filter(s => !only || only.includes(s.id))) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`${base}/?${sc.q}&manual=1&seed=3`);
  await page.waitForFunction(() => window.session?.view && window.hud, null, { timeout: 90000 });
  await page.evaluate(t0 => { const s = window.session; s.fastForward(t0); }, sc.t0);
  for (const seg of SEGS) {
    if (seg.level && !legacy) await page.selectOption('#shakeSel', seg.level);
    const r = await page.evaluate(async ({ seg, legacy }) => {
      const s = window.session, v = s.view, rig = v.rig, w = s.world, THREE = rig.camera.position.constructor;
      if (seg.mode === 'follow') {
        const big = w.ships.filter(x => x.state === 'alive').sort((a, b) => (b.maxHp ?? 0) - (a.maxHp ?? 0))[0];
        document.querySelector('[data-cam=tactical]')?.click();
        rig.follow = () => v.followTarget(big.id); rig.setMode('follow');
        document.querySelectorAll('[data-cam]').forEach(b => b.classList.toggle('on', b.dataset.cam === 'follow'));
      } else document.querySelector(`[data-cam=${seg.mode}]`).click();
      const counts = {}; const orig = rig.addShake.bind(rig);
      rig.addShake = (a, kind = 'hit') => { counts[kind] = (counts[kind] ?? 0) + 1; return orig(a, kind); };
      const cut0 = rig.cuts?.length ?? 0; const dt = 1 / 30, frames = Math.round(seg.sec / dt);
      const px = []; let maxJump = 0, maxTurn = 0; const prev = rig.camera.position.clone(); const dir = rig.camera.getWorldDirection(rig.camera.position.clone()), pdir = dir.clone(); const focal = 900 / 2 / Math.tan(rig.camera.fov * Math.PI / 360);
      let shotsSeen = 0, lastShot = rig.shot;
      for (let i = 0; i < frames && !w.outcome; i++) {
        s.tick(dt);
        if (legacy) {
          const pre = rig.shake / Math.exp(-dt * 3.5), a = pre * pre * (rig.mode === 'tactical' ? 0.6 : 1.4);
          const look = rig.mode === 'director' ? rig.smoothedLook : rig.cur.focus; const d = Math.max(1, rig.camera.position.distanceTo(look));
          px.push(a * 1.2 * focal / d);
        } else px.push(rig.shakeOut.px);
        // camera jump per frame relative to the viewing distance, outside intentional cuts (a cut is a deliberate scene change)
        const cutNow = rig.shot !== lastShot && rig.shot; if (rig.shot !== lastShot) { if (rig.shot) shotsSeen++; lastShot = rig.shot; }
        if (i > 1 && !cutNow) maxJump = Math.max(maxJump, rig.camera.position.distanceTo(prev) / Math.max(1, rig.camera.position.distanceTo(rig.mode === 'director' ? rig.smoothedLook : rig.cur.focus)));
        rig.camera.getWorldDirection(dir);
        if (i > 1 && !cutNow) maxTurn = Math.max(maxTurn, dir.angleTo(pdir) * 180 / Math.PI);   // view direction change per frame, deg
        pdir.copy(dir); prev.copy(rig.camera.position);
      }
      rig.addShake = orig;
      const sorted = [...px].sort((a, b) => a - b), cuts = (rig.cuts ?? []).slice(cut0);
      const gaps = cuts.slice(1).map((t, i) => +(t - cuts[i]).toFixed(2));
      return { mode: rig.mode, level: rig.shakeLevel ?? 'legacy', sel: document.querySelector('#shakeSel')?.value ?? '-', t: +w.time.toFixed(1), alive: w.ships.filter(x => x.state === 'alive').length,
        maxPx: +sorted.at(-1).toFixed(2), p95Px: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), shakingPct: +(100 * px.filter(x => x > 0.05).length / px.length).toFixed(1),
        events: counts, cuts: legacy ? shotsSeen : cuts.length, minCutGap: gaps.length ? Math.min(...gaps) : null, maxRelJump: +maxJump.toFixed(3), maxTurnDeg: +maxTurn.toFixed(2) };
    }, { seg, legacy });
    console.log(`${sc.label.padEnd(28)} ${seg.mode.padEnd(8)} ${String(seg.level ?? 'legacy').padEnd(6)}`, JSON.stringify(r));
    results.push({ scenario: sc.id, ...seg, ...r });
  }
  if (errs.length) console.log('  errors:', errs.slice(0, 5).join(' | '));
  await ctx.close();
}
await browser.close();
const fs = await import('fs'); fs.mkdirSync('shots/cam', { recursive: true });
fs.writeFileSync(`shots/cam/shake-${legacy ? 'legacy' : 'new'}.json`, JSON.stringify(results, null, 1));
