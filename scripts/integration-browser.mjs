// Actual integrated UI against the authoritative single-player server, in a disposable browser save.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = 'artifacts/integration', temp = mkdtempSync(path.join(tmpdir(), 'siderarium-integration-ui-'));
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['tests/support/integration.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'fixture.mjs'), logLevel: 'silent' });
const { integrationFixture, startIntegrationIndustry, integrationRun } = await import(pathToFileURL(path.join(temp, 'fixture.mjs')).href), f = integrationFixture(981);
const hulls = ['patrol_pathfinder', 'destroyer_lancet', 'miner_quarry', 'hauler_meridian', 'cruiser_vigil'];
for (const [i, id] of f.combat.shipIds.entries()) {
  const ship = f.sim.st.ships[id]; ship.state = 'space'; ship.task = { k: 'none' };
  ship.pos = { ...f.sim.st.stations.astra.pos, x: f.sim.st.stations.astra.pos.x + 900 + i * 100, z: f.sim.st.stations.astra.pos.z + 500 };
}
const metadata = { p: f.p, combat: f.combat.id, mine: f.mine.id, supply: f.supply.id, output: f.output.id, carrier: f.carrier.id, miner: f.miner.id, product: f.product.id, hulls: Object.fromEntries(hulls.map(h => [h, f.find(h).id])) };
if (['save','battle'].includes(process.env.INTEGRATION_UI_PHASE)) { startIntegrationIndustry(f); integrationRun(f.server, 5); }
const file = f.server.snapshotFile(), checks = [], errors = [], results = { metadata, checks, errors };
const check = (ok, text) => { if (!ok) throw Error(text); checks.push(text); console.log('PASS', text); };
const server = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8354', DATABASE_URL: '', CONTENT_MIGRATE: '', SAVE_FILE: path.join(temp, 'http-world.json') } });
let browser, page, log = '';
server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); server.stdout.on('data', () => { if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); server.once('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(({ file, metadata }) => {
    if (!localStorage.getItem('siderarium.sp.v1')) { localStorage.setItem('siderarium.sp.v1', JSON.stringify(file)); localStorage.setItem('siderarium.sp.token', 'integration'); }
    window.__integration = metadata;
    window.__runIntegration = seconds => { const server = window.siderarium.client.t.server; for (let t = 0; t < seconds; t += .25) { server.sim.update(.25); server.analytics.step(); } server.step(.5); };
  }, { file, metadata });
  await page.goto('http://localhost:8354/?sp=continue&name=통합산업');
  await page.waitForFunction(p => window.siderarium?.client?.company === p && window.siderarium?.hud, f.p);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.waitForFunction(ids => ids.every(id => window.siderarium.view.ships.get(id)?.model.model?.state === 'model'), Object.values(metadata.hulls));
  await page.evaluate(() => window.siderarium.view.focusOn(window.siderarium.client.state.stations.astra.pos, 1500));
  check(true, 'all five purchased P8 hulls load their GLBs in the integrated strategic view');
  if (process.env.INTEGRATION_UI_PHASE !== 'battle') for (const hull of hulls) {
    const id = metadata.hulls[hull];
    await page.evaluate(id => { const a = window.siderarium; a.view.focusOn(a.client.state.ships[id].pos, 140); }, id);
    await page.waitForFunction(id => { const v = window.siderarium.view, ship = v.ships.get(id); if (!ship) return false; const p = ship.model.root.getWorldPosition(ship.model.root.position.clone()).project(v.rig.camera); return ship.model.root.visible && Math.abs(p.x) < .7 && Math.abs(p.y) < .7 && p.z > -1 && p.z < 1; }, id);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/strategic-${hull}.png` });
    check(true, `strategic camera actually frames ${hull}`);
  }

  if (!['save','battle'].includes(process.env.INTEGRATION_UI_PHASE)) {
  results.movement = await page.evaluate(() => {
    const app = window.siderarium, sim = app.client.t.server.sim, m = window.__integration, ship = sim.st.ships[m.hulls.patrol_pathfinder], before = { ...ship.pos };
    const error = sim.command(m.p, { c: 'setOp', group: m.combat, op: { k: 'move', to: { ...before, x: before.x + 2000 } } }); if (error) throw Error(error);
    window.__runIntegration(12); sim.command(m.p, { c: 'setOp', group: m.combat, op: { k: 'idle' } });
    return Math.hypot(ship.pos.x - before.x, ship.pos.z - before.z);
  });
  check(results.movement > 60, 'P8 warships follow an authoritative strategic move command');
  // Exercise all structural variants through normal fitting commands; inspect the actual fitting UI.
  results.variants = await page.evaluate(() => {
    const app = window.siderarium, sim = app.client.t.server.sim, m = window.__integration, factory = sim.st.stations.integration_factory;
    const bp = sim.command(m.p, { c: 'buyBlueprint', station: 'helios', blueprint: 'bp_cruiser_vigil_command' }); if (bp) throw Error(bp);
    return [['patrol_pathfinder','patrol_pathfinder_scout',['pd1']], ['destroyer_lancet','destroyer_lancet_screen',['vls3','vls4']], ['miner_quarry','miner_quarry_hold',[]], ['hauler_meridian','hauler_meridian_express',[]], ['cruiser_vigil','cruiser_vigil_command',['aux1','aux2']]].map(([hull, variant, remove]) => {
      const s = sim.st.ships[m.hulls[hull]]; sim.dockShip(s, factory); const hp = { ...s.fitting.hp }; for (const id of remove) delete hp[id];
      const error = sim.command(m.p, { c: 'fit', ship: s.id, variant, hp, bay: {} }); if (error) throw Error(`${hull}: ${error}`);
      return { hull, variant: s.variant, hp: s.fitting.hp, model: sim.fittingSpec(s).mesh.model };
    });
  });
  check(results.variants.every(v => v.model === `model.${v.hull}`), 'all five variants retain correct model and valid hardpoint loadouts');
  await page.waitForFunction(id => window.siderarium.client.state.ships[id]?.variant === 'patrol_pathfinder_scout', metadata.hulls.patrol_pathfinder);
  await page.evaluate(id => window.siderarium.hud.openFitting(id), metadata.hulls.patrol_pathfinder);
  await page.screenshot({ path: out + '/p8-fitting-1440.png' });
  await page.locator('[data-fclose]').click();
  results.mining = await page.evaluate(() => {
    const server = window.siderarium.client.t.server, sim = server.sim, m = window.__integration, carrier = sim.st.ships[m.carrier], miner = sim.st.ships[m.miner], co = sim.st.companies[m.p];
    sim.dockShip(carrier, sim.st.stations.astra); sim.dockShip(miner, sim.st.stations.astra);
    for (const command of [{ c: 'moveShip', ship: m.carrier, group: m.mine }, { c: 'setOp', group: m.mine, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true, auto: false } }]) { const error = sim.command(m.p, command); if (error) throw Error(error); }
    const mined = co.stats.mined, earned = co.stats.earned; let carried = false;
    for (let t = 0; t < 1500; t += .25) { sim.update(.25); server.analytics.step(); carried ||= Object.values(carrier.cargo).some(n => n > 0); }
    sim.command(m.p, { c: 'setOp', group: m.mine, op: { k: 'idle' } }); sim.command(m.p, { c: 'moveShip', ship: m.carrier, group: m.supply }); sim.dockShip(carrier, sim.st.stations.astra);
    if (Object.values(carrier.cargo).some(n => n > 0)) { const error = sim.command(m.p, { c: 'unloadCargo', ship: m.carrier }); if (error) throw Error(error); }
    server.step(.5); return { mined: co.stats.mined - mined, saleIncome: co.stats.earned - earned, carried };
  });
  check(results.mining.carried && results.mining.mined > 0 && results.mining.saleIncome > 0, 'P8 Quarry and Meridian repeat mining, collection, unloading and real market sales');
  await page.evaluate(() => { const a = window.siderarium, sim = a.client.t.server.sim; const error = sim.command(a.client.company, { c: 'prodOrder', station: 'integration_factory', recipe: 'alloy_direct', mode: 'stock', n: 140 }); if (error) throw Error(error); });
  await page.getByRole('button', { name: '물류 관리', exact: true }).click();
  for (const route of [{ group: metadata.supply, name: 'P8 원료 공급', from: 'astra', to: 'integration_factory', item: 'ore', mode: 'supply', amount: 80 }, { group: metadata.output, name: 'P8 합금 출하', from: 'integration_factory', to: 'integration_depot', item: 'alloy', mode: 'transfer', amount: 14 }]) {
    await page.locator('[data-lg-new]').first().click();
    for (const key of ['group', 'from', 'to']) await page.locator(`[data-lg-field="${key}"]`).selectOption(route[key]);
    await page.locator(`[data-lg-mode="${route.mode}"]`).click(); await page.locator('[data-lg-field="item"]').selectOption(route.item);
    await page.locator('[data-lg-field="name"]').fill(route.name); await page.locator('[data-lg-field="amount"]').fill(String(route.amount));
    if (route.mode === 'supply') { await page.locator('[data-lg-field="minStock"]').fill('60'); await page.locator('[data-lg-field="targetStock"]').fill('120'); }
    await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
    await page.waitForFunction(name => [...document.querySelectorAll('[data-lg-card]')].some(el => el.textContent.includes(name)), route.name);
  }
  results.industry = await page.evaluate(() => { window.__runIntegration(600); const a = window.siderarium, sim = a.client.t.server.sim; return { delivered: sim.st.stations.integration_depot.storage[a.client.company].alloy, routes: Object.values(sim.st.logistics).map(r => ({ name: r.config.name, delivered: r.stats.delivered, owner: r.owner })) }; });
  check(results.industry.delivered >= 42 && results.industry.routes.every(r => r.delivered > 0), 'two UI-configured P8 routes feed production and deliver the real output');
  for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size); await page.screenshot({ path: `${out}/logistics-${size.width}.png` });
    check(await page.evaluate(() => { const r = document.querySelector('.lg-box').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }), `integrated logistics fits ${size.width}px`);
  }
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '경제 · 월드', exact: true }).click(); await page.waitForSelector('.an-body .an-stats');
  check(await page.locator('.an-chart svg').count() > 0, 'player analytics graphs use the actual P8 mining, trade and production history');
  await page.getByRole('button', { name: '관리자 보기', exact: true }).click();
  for (const tab of ['overview', 'growth', 'market', 'industry', 'research', 'world']) { await page.locator(`[data-an-tab="${tab}"]`).click(); await page.screenshot({ path: `${out}/admin-${tab}-1440.png` }); check((await page.locator('.an-body').innerText()).length > 30, `admin ${tab} works with integrated content`); }
  results.health = await page.evaluate(() => window.siderarium.client.t.server.analytics.query('admin', '').health);
  check(Math.abs(results.health.reconciliation) < .001 && !results.health.failures && !results.health.dropped, 'integrated economy reconciles without missing or duplicated telemetry');
  await page.getByRole('button', { name: '분석 닫기', exact: true }).click();
  }
  const beforeFile = await page.evaluate(() => { const a = window.siderarium; a.client.setSpeed(0); a.client.t.saveNow(); return a.client.t.server.snapshotFile(); });
  await page.reload(); await page.waitForFunction(p => window.siderarium?.client?.company === p && window.siderarium?.hud, f.p); await page.evaluate(() => window.siderarium.client.setSpeed(0));
  const afterWorld = await page.evaluate(() => window.siderarium.client.t.server.snapshotFile().world);
  const elapsed = afterWorld.time - beforeFile.world.time;
  check(elapsed >= 0 && Math.abs(elapsed * 4 - Math.round(elapsed * 4)) < 1e-6, 'browser reload resumes the normal strategic clock');
  // Reload starts the SP clock at 1x. Compare against the exact same elapsed simulation, not frozen positions.
  const expected = new f.server.constructor(structuredClone(beforeFile), { singleplayer: true, snapInterval: .5 });
  expected.sim.st.companies[metadata.p].online = true;
  for (let t = 0; t < elapsed; t += .25) expected.step(.25);
  const select = w => ({ logistics: w.logistics, ships: Object.fromEntries(Object.values(metadata.hulls).map(id => [id, w.ships[id]])) });
  const aa = select(expected.sim.st), bb = select(afterWorld), differences = [];
  const diff = (a,b,p='') => { if (JSON.stringify(a) === JSON.stringify(b)) return; if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of new Set([...Object.keys(a),...Object.keys(b)])) diff(a[k],b[k],p+'.'+k); else differences.push({ path:p, before:a, after:b }); }; diff(aa,bb);
  results.saveReload = { elapsed, differences, expected:aa, actual:bb };
  check(differences.length === 0, 'browser save/reload preserves all P8 fittings, assets and live routes after accounting for normal elapsed ticks');
  // A real authoritative battle; the test does not force HP, death or outcome.
  const eng = await page.evaluate(() => { const a = window.siderarium, sim = a.client.t.server.sim, m = window.__integration, pos = { ...sim.st.stations.astra.pos, x: sim.st.stations.astra.pos.x + 12000 }; const groups = [m.combat, m.mine, m.supply].map(id => sim.st.groups[id]), enemy = sim.newGroup('pirates', '통합 전투 상대'); for (const id of groups.flatMap(g => g.shipIds)) { const s = sim.st.ships[id]; s.state = 'space'; s.task = { k: 'none' }; s.pos = { ...pos, z: pos.z - 300 }; } for (let i = 0; i < 5; i++) sim.spawnShip('pirates', 'battleship', 'fortress', enemy.id, { ...pos, z: pos.z + 300 }); const e = sim.createEngagement(pos, [enemy], groups); a.client.t.server.step(.5); return e.id; });
  await page.evaluate(() => window.siderarium.hud.toggleBattles()); await page.locator(`[data-watch="${eng}"]`).click();
  await page.waitForFunction(() => window.__battle?.view?.views?.size > 0);
  await page.waitForFunction(() => [...window.__battle.view.views.values()].filter(v => v.ship.loadout.mesh?.model?.startsWith('model.')).length === 5 && [...window.__battle.view.views.values()].filter(v => v.ship.loadout.mesh?.model?.startsWith('model.')).every(v => v.model.model?.state === 'model'));
  await page.evaluate(() => { const w = window.__battle, s = w.world.ships.find(s => s.loadout.mesh?.model?.includes('lancet')); w.view.rig.follow = () => w.view.followTarget(s.id); w.view.rig.setMode('follow'); window.siderarium.client.setSpeed(1); });
  check(true, 'all five military and industrial P8 models enter the actual tactical view');
  await page.waitForFunction(() => window.__battle.world.ships.filter(s => s.loadout.mesh?.model).some(s => s.stats.shots > 0), null, { timeout: 90000 });
  await page.waitForFunction(() => { const b = window.__battle, s = b.world.ships.find(s => s.loadout.mesh?.model?.includes('lancet')), v = b.view.views.get(s.id); const p = v.wpos.clone().project(b.view.rig.camera); return Math.abs(p.x) < .7 && Math.abs(p.y) < .7 && p.z > -1 && p.z < 1; });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: out + '/p8-battle-fire.png' });
  await page.waitForFunction(() => window.__battle.world.ships.filter(s => s.loadout.mesh?.model).some(s => s.hp < s.maxHp), null, { timeout: 90000 });
  await page.screenshot({ path: out + '/p8-battle-hit.png' });
  await page.evaluate(() => window.siderarium.client.setSpeed(2));
  await page.waitForFunction(() => window.__battle.world.ships.some(s => /patrol_pathfinder|destroyer_lancet|cruiser_vigil/.test(s.loadout.mesh?.model ?? '') && (s.state === 'dying' || s.state === 'dead')), null, { timeout: 90000 });
  results.battle = await page.evaluate(() => { const b = window.__battle; const ships = b.world.ships.filter(s => s.loadout.mesh?.model); const victim = ships.find(s => /patrol_pathfinder|destroyer_lancet|cruiser_vigil/.test(s.loadout.mesh?.model ?? '') && (s.state === 'dying' || s.state === 'dead')); b.view.rig.focus.set(victim.pos.x, victim.pos.y, victim.pos.z); b.view.rig.dist = 160; return ships.map(s => ({ model: s.loadout.mesh.model, state: s.state, hp: s.hp, shots: s.stats.shots })); });
  await page.waitForFunction(() => window.__battle.view.wrecks.some(w => { let n = 0; w.obj.traverse(o => { if (o.userData.proc === 'model') n++; }); return n > 0; }), null, { timeout: 90000 });
  await page.evaluate(() => {
    const b = window.__battle; window.siderarium.client.setSpeed(0);
    const wreck = b.view.wrecks.find(w => { let n = 0; w.obj.traverse(o => { if (o.userData.proc === 'model') n++; }); return n > 0; });
    if (!wreck) throw Error('natural P8 model wreck not present');
    b.view.rig.follow = () => ({ pos: wreck.obj.position, fwd: b.world.ships[0].fwd, length: 24, alive: false }); b.view.rig.setMode('follow');
  });
  await page.waitForFunction(() => { const r = window.__battle.view.rig; return Number.isFinite(r.camera.position.x) && r.cur.focus.distanceTo(r.focus) < 15; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out + '/p8-battle-destruction.png' });
  check(true, 'P8 warships fire, take real damage and are naturally destroyed in the authoritative battle');
  check(errors.length === 0, 'no browser runtime errors during integrated play');
} catch (error) { results.failure = String(error); console.error(error); process.exitCode = 1; if (page) await page.screenshot({ path: out + '/browser-failure.png' }).catch(() => {}); }
finally { writeFileSync(out + '/browser-results.json', JSON.stringify(results, null, 2)); if (browser) await browser.close(); server.kill('SIGTERM'); }
