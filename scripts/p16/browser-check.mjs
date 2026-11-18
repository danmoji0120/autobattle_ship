// Development-only P16.4 browser smoke and render-cost probe (headless Chromium / SwiftShader).
// Does not access the running multiplayer service or bypass the authenticated combat lab.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = 'playtest-out/p16';
await fs.mkdir(out, { recursive: true });
const errors = [];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(30000);
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const requireOk = (v, label) => { if (!v) throw Error('P16 browser failure: ' + label); console.log('PASS ' + label); };
const metrics = [];
try {
  await page.goto('http://127.0.0.1:5173/?skirmish&manual=1');
  await page.waitForFunction(() => !!window.fleetcmd);
  await page.locator('[data-cat="carrier"]').click();
  await page.locator('[data-cat="carrier"] [data-add]').click();
  let removed = 0;
  while (await page.locator('#go').isDisabled()) {
    const ok = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.srow')].find(r => !r.textContent.includes('여명급'));
      const remove = row?.querySelector('[data-sdel]');
      if (!remove) return false;
      remove.click(); return true;
    });
    if (!ok || ++removed > 40) break;
  }
  requireOk(!(await page.locator('#go').isDisabled()), 'preview carrier can be added within skirmish budget');
  requireOk(await page.evaluate(() => [...document.querySelectorAll('.srow')].some(r => r.textContent.includes('여명급'))), 'carrier in skirmish fleet');
  const carrierCpu = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.srow')].find(r => r.textContent.includes('여명급'));
    return row?.querySelector('select[data-scpu]')?.getAttribute('data-scpu') ?? null;
  });
  if (carrierCpu) await page.locator('[data-scpu="' + carrierCpu + '"]').selectOption('cpu_carrier');
  await page.locator('#go').click();
  await page.waitForFunction(() => !!window.fleetcmd.session);
  const smoke = await page.evaluate(() => {
    const s = window.fleetcmd.session;
    s.fastForward(10);
    s.view.frame(1, 0.033, 0.033, true);
    const w = s.world, before = w.digest();
    s.view.frame(1, 0.033, 0.033, true);
    return { rules: w.rules, pool: !!w.craft, airborne: w.craft?.flying() ?? 0,
      drawn: s.view.craftMeshes.drawn, drawBatches: s.view.scene.children.filter(x => x.name.startsWith('craft-')).length,
      digestStable: before === w.digest(), carrier: w.ships.some(x => x.cls.id === 'carrier') };
  });
  requireOk(smoke.carrier && smoke.rules === 3 && smoke.pool, 'skirmish uses rules 3 for preview carrier only');
  requireOk(smoke.drawBatches === 3 && smoke.drawn === smoke.airborne, 'three instanced batches follow CraftPool');
  requireOk(smoke.digestStable, 'drawing twice does not change battle digest');
  await page.screenshot({ path: out + '/skirmish-carrier.png' });
  console.log('P16 skirmish:', JSON.stringify(smoke));

  for (const target of [200, 400, 800]) {
    const probe = await page.evaluate(({ target }) => {
      const root = (name, ships) => ({ name, root: { name: '시험', commanderId: null,
        order: 'engage', retreatAt: 0, ships, children: [] } });
      const carrierCount = Math.ceil(target / 30);
      const carriers = Array.from({ length: carrierCount }, () => ({ classId: 'carrier', loadoutId: 'air_group',
        cpu: { id: 'cpu_carrier', arch: 'carrier' } }));
      // Keep the aircraft in range at the start: the previous default 2.9-km separation measured
      // an empty sky, even though the carrier pool had nominal capacity 200/400/800.
      // Opposing capital ships carry working main guns, but no PD, for a sustained air-heavy scene.
      const opponents = Array.from({ length: 24 }, () => ({ classId: 'battleship', loadoutId: 'std',
        fit: { name: 'main-gun-only stress target',
          mounts: [{ weapon: 'heavy_cannon', pos: [0, 0, 20], facing: 0, arc: 180 }] } }));
      const setup = { seed: 7, scenarioId: 'kestrel', rules: 3, spawnZ: 650, fleets: [root('A', carriers), root('B', opponents)] };
      window.fleetcmd.startBattle(setup);
      const s = window.fleetcmd.session;
      for (let i = 0; i < 240 && !s.world.outcome; i++) {
        s.world.step();
        if (s.world.events.length) s.view.handleEvents(s.world.events);
      }
      // Warm GPU shaders and WebGL buffers outside the measured window.
      for (let k = 0; k < 5; k++) s.view.frame(1, 0.033, 0.033, true);
      const frame = [], matrix = [], flying = [];
      for (let k = 0; k < 30; k++) {
        for (let t = 0; t < 2 && !s.world.outcome; t++) {
          s.world.step();
          if (s.world.events.length) s.view.handleEvents(s.world.events);
        }
        const start = performance.now();
        s.view.frame(1, 0.066, 0.066, true);
        s.view.renderer.getContext().finish(); // include submission + SwiftShader completion
        frame.push(performance.now() - start);
        matrix.push(s.view.craftUpdateMs);
        flying.push(s.view.craftMeshes.drawn);
      }
      const aggregate = values => {
        const a = values.slice().sort((x, y) => x - y);
        return { mean: values.reduce((s, x) => s + x, 0) / values.length,
          p95: a[Math.floor((a.length - 1) * 0.95)], max: a[a.length - 1] };
      };
      const pool = s.world.craft;
      return { requested: target, capacity: pool?.n ?? 0,
        maxDrawn: Math.max(...flying), minDrawn: Math.min(...flying),
        launched: pool?.squads.reduce((sum, q) => sum + q.stats.launched, 0) ?? 0,
        lost: pool?.squads.reduce((sum, q) => sum + q.stats.lost, 0) ?? 0,
        damage: s.world.ships.filter(x => x.team === 0).reduce((sum, x) => sum + x.stats.dmgDealt, 0),
        renderFrameMs: aggregate(frame), instanceSyncMs: aggregate(matrix),
        digest: s.world.digest(), draws: s.view.renderer.info.render.calls, rules: s.world.rules };
    }, { target });
    metrics.push(probe);
    requireOk(probe.capacity >= target && probe.rules === 3, target + ' craft capacity in browser');
    requireOk(probe.maxDrawn >= target * 0.7 && probe.launched >= target * 0.7,
      target + ' actual airborne craft rendered (not just nominal capacity): ' + probe.maxDrawn);
    await page.screenshot({ path: out + '/craft-' + target + '.png' });
    console.log('P16 browser performance:', JSON.stringify(probe));
  }
  requireOk(errors.length === 0, 'no JS page errors: ' + errors.slice(0, 3).join(' | '));
  await fs.writeFile(out + '/metrics.json', JSON.stringify({ environment: 'headless Chromium SwiftShader (not user GPU)', smoke, metrics, errors }, null, 2));
} finally {
  await browser.close();
}
