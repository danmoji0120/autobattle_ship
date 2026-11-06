// Browser smoke check in a disposable single-player world. Start `npm run dev` first.
// Captures strategic and fitting screens; the production/blueprint path is covered by p8-ships.test.ts.
const { chromium } = require('playwright');
const fs = require('fs');
const out = process.env.OUT || 'shots/p8';
const base = process.env.SID_PREVIEW_BASE_URL || 'http://127.0.0.1:5173';
fs.mkdirSync(out, { recursive: true });
(async () => {
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.url().includes('.glb') && !r.ok()) errors.push(`${r.status()} ${r.url()}`); });
  try {
    await page.goto(`${base}/?sp=new&name=P8시험`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium?.hud, null, { timeout: 120000 });
    const result = await page.evaluate(() => {
      const c = window.siderarium, sim = c.client.t.server.sim, me = c.client.company;
      const co = sim.st.companies[me]; co.credits = 20_000_000; co.rep = 1000;
      const purchases = [
        ['patrol_pathfinder', 'corvette', 'helios', 'pathfinder_patrol'],
        ['destroyer_lancet', 'destroyer', 'helios', 'lancet_salvo'],
        ['miner_quarry', 'miner', 'astra', 'quarry_mining'],
        ['hauler_meridian', 'hauler', 'exchange', 'meridian_cargo'],
        ['cruiser_vigil', 'light_cruiser', 'helios', 'vigil_mixed'],
      ];
      const bought = purchases.map(([hull, classId, station, preset]) => ({ hull, error: sim.command(me, { c: 'buyShip', station, classId, loadoutId: '', hull, preset }) }));
      const home = sim.st.stations[co.homeStation];
      const ids = purchases.map(([hull], i) => {
        const sh = Object.values(sim.st.ships).find(s => s.owner === me && s.hull === hull);
        if (!sh) return null;
        sim.st.groups[sh.groupId].op = { k: 'idle' }; sh.state = 'space'; sh.task = { k: 'none' };
        sh.pos = { x: home.pos.x + 900 + i * 85, y: 0, z: home.pos.z + 500 + (i % 2) * 100 };
        return sh.id;
      });
      window.__p8Ids = ids;
      window.__p8At = { x: home.pos.x + 1060, y: 0, z: home.pos.z + 550 };
      return bought;
    });
    if (result.some(x => x.error)) throw new Error(`buyShip: ${JSON.stringify(result)}`);
    await page.waitForFunction(() => window.__p8Ids.every(id => window.siderarium.view.ships.get(id)?.model.model?.state === 'model'), null, { timeout: 120000 });
    await page.waitForFunction(() => window.__p8Ids.every(id => {
      const p = window.siderarium.client.state.ships[id]?.pos;
      return p && Math.hypot(p.x - window.__p8At.x, p.z - window.__p8At.z) < 400;
    }), null, { timeout: 120000 });
    await page.evaluate(() => window.siderarium.view.focusOn(window.__p8At, 450));
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${out}/game-strategic.png` });
    console.log('PASS five purchased ships render as GLBs on the strategic map');
    const fit = await page.evaluate(() => {
      const c = window.siderarium, sim = c.client.t.server.sim, me = c.client.company;
      const ship = sim.st.ships[window.__p8Ids[0]], station = sim.st.stations.helios;
      sim.dockShip(ship, station);
      const hp = { ...ship.fitting.hp }; delete hp.pd1;
      const error = sim.command(me, { c: 'fit', ship: ship.id, variant: 'patrol_pathfinder_scout', hp, bay: {} });
      return { error, variant: ship.variant, model: sim.fittingSpec(ship)?.mesh?.model };
    });
    if (fit.error || fit.variant !== 'patrol_pathfinder_scout' || fit.model !== 'model.patrol_pathfinder') throw new Error(`fit: ${JSON.stringify(fit)}`);
    await page.waitForFunction(() => {
      const s = window.siderarium.client.state.ships[window.__p8Ids[0]];
      return s?.variant === 'patrol_pathfinder_scout' && s.task.k === 'docked';
    }, null, { timeout: 120000 });
    await page.evaluate(() => window.siderarium.hud.openFitting(window.__p8Ids[0]));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${out}/game-fitting.png` });
    console.log(`PASS fitting screen and scout refit: ${JSON.stringify(fit)}`);
    if (errors.length) throw new Error(errors.join('; '));
    console.log('PASS no page or GLB loading errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
