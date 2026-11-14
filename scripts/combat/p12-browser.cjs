// P12 browser check: loads a single-player P12 save (p12-sp-save.ts) into the real client, selects the fleet
// on area defence, checks the operation status panel, presses the one-click 복귀 button for real and watches
// the commander pick a station and dock; then a two-step order (관문 봉쇄 + gate) and the 390px layout.
// Needs `npm run dev` on 5173.   node scripts/combat/p12-browser.cjs <save.json> [outDir]
const { chromium } = require('playwright');
const fs = require('fs');
const [savePath, outDir = 'artifacts/p12'] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(savePath, 'utf8'));
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const report = { checks: [], errors: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra) : ''); };
  async function open(viewport) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('dialog', d => d.dismiss());
    await page.addInitScript(([save, token]) => { localStorage.setItem('siderarium.sp.v1', save); localStorage.setItem('siderarium.sp.token', token); }, [JSON.stringify(data.save), data.token]);
    await page.goto('http://127.0.0.1:5173/?sp=continue&name=P12', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.siderarium?.hud && window.siderarium.client.state, null, { timeout: 60000 });
    return page;
  }
  const panel = page => page.evaluate(gid => {
    const st = window.siderarium.client.state, g = st.groups[gid];
    return { text: document.querySelector('.fleetops')?.innerText ?? '', status: document.querySelector('.ordcol .status')?.innerText ?? '', op: g?.op?.k, opx: g?.opx ? { phase: g.opx.phase, station: g.opx.station, done: g.opx.done } : null,
      docked: g ? g.shipIds.every(id => st.ships[id]?.state === 'docked') : false, buttons: [...document.querySelectorAll('.fleetops [data-op]')].map(b => b.innerText.replace(/\s+/g, ' ').trim()) };
  }, data.group);
  try {
    const page = await open({ width: 1440, height: 900 });
    const me = await page.evaluate(() => window.siderarium.client.company);
    check(me === data.me, 'single-player client resumes as 알파 PMC (P12 world)', { me, opsV: await page.evaluate(() => window.siderarium.client.state.opsV) });
    await page.evaluate(id => window.siderarium.hud.select({ kind: 'group', id }), data.group);
    await page.waitForSelector('.fleetops [data-op="return"]', { timeout: 20000 });
    let p = await panel(page);
    check(p.op === 'defend' && /지역 방어/.test(p.text) && /위치 유지|경계/.test(p.text + p.status), 'group panel shows the operation, its phase and status', p);
    check(['복귀', '집결', '지역 방어', '공격 이동', '차단 요격', '관문 봉쇄', '항로 습격', '증원', '정찰'].every(n => p.buttons.some(b => b.startsWith(n))), 'all P12 order buttons are in the existing group panel', { buttons: p.buttons });
    await page.screenshot({ path: `${outDir}/ops-defend-1440.png` });
    // one click: return
    await page.click('.fleetops [data-op="return"]');
    await page.waitForFunction(gid => window.siderarium.client.state.groups[gid]?.opx?.station, data.group, { timeout: 20000 });
    p = await panel(page);
    check(p.op === 'return' && !!p.opx.station && /귀환지/.test(p.text), 'one click on 복귀: order accepted without a station; the commander\'s chosen station is shown', p);
    await page.screenshot({ path: `${outDir}/ops-return-1440.png` });
    await page.evaluate(() => window.siderarium.client.setSpeed && window.siderarium.client.setSpeed(8));
    await page.waitForFunction(gid => window.siderarium.client.state.groups[gid]?.op?.k === 'idle', data.group, { timeout: 180000 });
    await page.waitForFunction(() => /완료/.test(document.querySelector('.fleetops')?.innerText ?? ''), null, { timeout: 10000 }).catch(() => {});
    p = await panel(page);
    check(p.op === 'idle' && p.docked && /완료/.test(p.text), 'return completes: every ship docked, order idle, panel shows 완료', p);
    await page.screenshot({ path: `${outDir}/ops-returned-1440.png` });
    // two steps: blockade button + a gate
    await page.click('.fleetops [data-op="blockade"]');
    const hint = await page.evaluate(() => document.getElementById('modeHint')?.innerText ?? '');
    check(/점프게이트/.test(hint), 'two-step order: 관문 봉쇄 asks for a gate', { hint });
    const gate = await page.evaluate(() => { const st = window.siderarium.client.state; return st.systems.astra.gates[0].id; });
    await page.evaluate(gid => window.siderarium.hud.applyMode({ kind: 'gate', id: gid, pos: { x: 0, y: 0, z: 0 } }, 0, 0), gate);
    await page.waitForFunction(gid => window.siderarium.client.state.groups[gid]?.op?.k === 'blockade', data.group, { timeout: 20000 });
    check(true, 'clicking a gate issues the blockade order', { gate });
    // mobile
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    const mob = await page.evaluate(() => {
      const r = document.querySelector('.fleetops [data-op="return"]')?.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, ret: r ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), right: Math.round(r.right) } : null };
    });
    check(!mob.overflow && mob.ret && mob.ret.w > 0 && mob.ret.right <= 390, '390px: no horizontal page scroll, 복귀 button on screen', mob);
    await page.screenshot({ path: `${outDir}/ops-390.png` });
    await page.waitForTimeout(2000);
    await page.close();
  } catch (e) { report.errors.push(String(e && e.stack || e)); }
  finally {
    fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
    await browser.close();
  }
  const failed = report.checks.filter(c => !c.ok).length;
  console.log(JSON.stringify({ passed: report.checks.length - failed, failed, errors: report.errors }, null, 2));
  if (failed || report.errors.length) process.exitCode = 1;
})();
