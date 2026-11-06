// Capture the real game model preview (including fitted weapons) at two angles for all P8 ships.
// Start `npm run dev` first, then: OUT=docs/p8-previews node scripts/models/check-p8-preview.cjs
// Requires the same Playwright/Chromium installation used by the existing model preview scripts.
const { chromium } = require('playwright');
const fs = require('fs');
const out = process.env.OUT || 'shots/p8';
const base = process.env.SID_PREVIEW_BASE_URL || 'http://127.0.0.1:5173';
const hulls = [
  ['patrol_pathfinder', 14.7], ['destroyer_lancet', 26.4], ['miner_quarry', 39],
  ['hauler_meridian', 68], ['cruiser_vigil', 35.2],
];
fs.mkdirSync(out, { recursive: true });
(async () => {
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const [id, length] of hulls) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      page.on('requestfailed', r => errors.push(`${r.url()}: ${r.failure()?.errorText}`));
      page.on('response', r => { if (r.url().includes('.glb') && !r.ok()) errors.push(`${r.status()} ${r.url()}`); });
      await page.goto(`${base}/?modelview=${id}&solo&still&nohp`);
      await page.waitForFunction(() => document.querySelector('[data-state]')?.dataset.state === 'model', null, { timeout: 60000 });
      await page.evaluate(L => { const c = window.__preview.camera; c.position.set(L * 0.9, L * 0.62, L * 0.95); c.lookAt(0, 0, 0); c.updateProjectionMatrix(); }, length);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${id}.png` });
      await page.keyboard.press('h');
      await page.evaluate(L => { const c = window.__preview.camera; c.position.set(0, L * 1.9, 0.001); c.lookAt(0, 0, 0); c.updateProjectionMatrix(); }, length);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${id}-hardpoints.png` });
      const info = (await page.locator('[data-state]').innerText()).replace(/\n/g, ' | ');
      if (errors.length) throw new Error(`${id}: ${errors.join('; ')}`);
      console.log(`PASS ${id}: ${info}`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
