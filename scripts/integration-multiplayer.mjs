// Real isolated HTTP/cookie/WebSocket/browser server, file restart, offline automation and privacy.
import { spawn } from 'node:child_process'; import WebSocket from 'ws';
import { createRequire } from 'node:module'; import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { chromium } = require('playwright');
const dir = mkdtempSync(path.join(tmpdir(), 'siderarium-integration-mp-')), save = path.join(dir, 'world.json'), port = 8355, base = `http://localhost:${port}`;
const out = 'artifacts/integration', checks = [], sockets = []; let server, browser;
const delay = ms => new Promise(r => setTimeout(r, ms));
function check(ok, message) { if (!ok) throw Error(message); checks.push(message); console.log('PASS', message); }
async function until(fn, message, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); } throw Error(message); }
async function start() {
  const child = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: String(port), SAVE_FILE: save, DATABASE_URL: '', SAVE_INTERVAL_S: '.2', WORLD_SEED: '615' } }); let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  await until(() => log.includes('listening on'), 'server start failed', 20000); server = child;
}
async function stop() { for (const ws of sockets.splice(0)) ws.close(); if (server) { const child = server; server = null; await new Promise(r => { child.once('exit', r); child.kill('SIGTERM'); }); } }
class Pilot {
  cookie = ''; seq = 1; messages = [];
  constructor(name) { this.name = name; }
  async post(route, body) { const response = await fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', cookie: this.cookie }, body: JSON.stringify(body) }); const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]; return { status: response.status, body: await response.json() }; }
  async connect() {
    this.messages = []; this.ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { origin: base, cookie: this.cookie } }); sockets.push(this.ws);
    this.ws.on('message', raw => { const message = JSON.parse(String(raw)); this.messages.push(message); if (message.t === 'needPmc') this.ws.send(JSON.stringify({ t: 'createPmc', name: this.name })); });
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); }); this.ws.send(JSON.stringify({ t: 'hello', name: 'untrusted' }));
    this.id = (await this.wait(m => m.t === 'welcome')).company;
  }
  wait(test) { return until(() => this.messages.find(test), 'socket response missing', 10000); }
  async cmd(command) { const id = this.seq++; this.ws.send(JSON.stringify({ t: 'cmd', id, cmd: command })); return this.wait(m => m.t === 'ack' && m.id === id); }
  async page() {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); const [name, ...rest] = this.cookie.split('='); await context.addCookies([{ name, value: rest.join('='), domain: 'localhost', path: '/', httpOnly: true }]);
    const page = await context.newPage(); page.on('pageerror', e => { throw e; }); await page.goto(base); await page.locator('#mpJoin').waitFor(); await until(() => page.locator('#mpJoin').isEnabled(), 'multiplayer button not ready'); await page.locator('#mpJoin').click();
    await page.waitForFunction(id => window.siderarium?.client?.company === id && window.siderarium?.hud, this.id);
    return page;
  }
}
try {
  await start(); const a = new Pilot('노바 물류'), b = new Pilot('카이퍼 운송');
  check((await a.post('/api/auth/signup', { loginId: 'p2_alpha', password: 'p2-alpha-password-123', confirm: 'p2-alpha-password-123' })).status === 200, 'first real account signs in');
  check((await b.post('/api/auth/signup', { loginId: 'p2_beta', password: 'p2-beta-password-123', confirm: 'p2-beta-password-123' })).status === 200, 'second real account signs in');
  await a.connect(); await b.connect(); await stop();
  const coreFile = path.join(dir, 'core.mjs'); await build({ entryPoints: ['src/server/core.ts'], bundle: true, platform: 'node', format: 'esm', outfile: coreFile, logLevel: 'silent' });
  const { GameServer } = await import(pathToFileURL(coreFile).href), seeded = new GameServer(JSON.parse(readFileSync(save, 'utf8')), { singleplayer: false, snapInterval: 1 });
  const sim = seeded.sim, astra = sim.st.stations.astra, fixtures = {};
  for (const [i, pilot] of [a, b].entries()) {
    const depot = { ...structuredClone(astra), id: `mp_depot_${i}`, name: `${pilot.name} 창고`, public: false, owner: pilot.id, pos: { ...astra.pos, x: astra.pos.x + 6000, z: astra.pos.z + (i ? -6000 : 6000) }, market: null, funds: undefined, fundsMax: undefined, shipStock: undefined, storage: { [pilot.id]: { ore: i ? 0 : 20000 } }, modules: ['core', 'logistics', 'trade_hub', 'dock'].map((kind, slot) => ({ kind, slot, progress: 1, built: true })), listings: [] };
    sim.st.stations[depot.id] = depot; const group = sim.newGroup(pilot.id, `${pilot.name} 편대`), ship = sim.spawnHull(pilot.id, 'hauler_meridian', 'hauler_meridian_std', 'meridian_cargo', group.id, astra.pos); sim.dockShip(ship, astra);
    const error = sim.command(pilot.id, { c: 'buy', station: astra.id, res: 'ore', amount: i ? 200 : 100 }); if (error) throw Error(error);
    fixtures[pilot.id] = { group: group.id, ship: ship.id, depot: depot.id, bought: i ? 200 : 100 };
  }
  const configure = pilot => { const f = fixtures[pilot.id], error = sim.command(pilot.id, { c: 'putRoute', group: f.group, config: { name: `${pilot.name} 반복 노선`, from: astra.id, to: f.depot, item: 'ore', amount: 20, mode: 'transfer', repeat: true } }); if (error) throw Error(error); f.route = Object.values(sim.st.logistics).find(r => r.owner === pilot.id).id; };
  configure(a);
  for (let i = 0; i < 1200 && sim.st.logistics[fixtures[a.id].route].cursors[fixtures[a.id].ship]?.code !== 'storage'; i++) sim.update(.25);
  check(sim.st.logistics[fixtures[a.id].route].cursors[fixtures[a.id].ship]?.code === 'storage', 'loaded shipment waits safely at a genuinely full warehouse');
  configure(b); sim.tick(0); writeFileSync(save, JSON.stringify(seeded.snapshotFile()));
  const assets = (file, p) => { const w = file.world; return Object.values(w.stations).reduce((n, st) => n + (st.storage[p]?.ore || 0) + (st.listings ?? []).filter(l => l.seller === p && l.item === 'ore').reduce((v, l) => v + l.qty, 0), 0) + Object.values(w.ships).filter(s => s.owner === p).reduce((n, s) => n + (s.cargo.ore || 0), 0); };
  const expected = { [a.id]: assets(seeded.snapshotFile(), a.id), [b.id]: assets(seeded.snapshotFile(), b.id) };
  await start(); await a.connect(); await b.connect();
  const ar = fixtures[a.id], br = fixtures[b.id];
  check((await b.cmd({ c: 'routeControl', routes: [br.route, ar.route], action: 'cancel' })).err?.includes('자사'), 'mixed-company batch is rejected atomically');
  check((await b.cmd({ c: 'putRoute', route: ar.route, group: ar.group, config: sim.st.logistics[ar.route].config })).err?.includes('자사'), 'another company cannot edit a route');
  check((await b.cmd({ c: 'unloadCargo', ship: ar.ship })).err?.includes('자사'), 'another company cannot unload its cargo');
  const snap = await b.wait(m => m.t === 'snap'); check(!snap.state.logistics?.[ar.route] && !!snap.state.logistics?.[br.route] && !snap.state.stations[ar.depot].storage[a.id], 'ordinary multiplayer snapshots isolate routes and inventory');
  b.ws.close(); await delay(500);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await a.page(); await page.getByRole('button', { name: '물류 관리', exact: true }).click();
  await page.waitForSelector('[data-lg-card]'); check(await page.locator('[data-lg-card]').count() === 1, 'real remote browser sees only its own logistics');
  await page.waitForFunction(id => window.siderarium.view.ships.get(id)?.model.model?.state === 'model', ar.ship);
  check(true, 'owned P8 Meridian renders its GLB in the actual remote browser');
  const beforeRestart = JSON.parse(readFileSync(save, 'utf8'));
  check(assets(beforeRestart, a.id) === expected[a.id] && beforeRestart.world.logistics[ar.route].stats.loaded === 20, 'pre-restart shipment has no duplicate loading or missing stock');
  await stop(); await start();
  await page.waitForFunction(({ id, route }) => window.siderarium?.client?.state?.logistics?.[route]?.owner === id && document.querySelector('#netBanner')?.classList.contains('hidden'), { id: a.id, route: ar.route }, { timeout: 30000 });
  await until(() => { const file = JSON.parse(readFileSync(save, 'utf8')); return file.world.time > beforeRestart.world.time + 1; }, 'world did not resume after restart');
  const restored = JSON.parse(readFileSync(save, 'utf8'));
  check(restored.world.logistics[ar.route].stats.loaded === 20 && restored.world.ships[ar.ship].cargo.ore === 20 && assets(restored, a.id) === expected[a.id], 'real server restart restores manifest, cargo and route without duplicates');
  check(restored.world.ships[ar.ship].hull === 'hauler_meridian' && restored.world.ships[br.ship].hull === 'hauler_meridian' && Object.keys(restored.world.ships[ar.ship].fitting.hp).length === 4, 'P8 identities and hardpoint fittings persist for both companies');
  const offlineBefore = restored.world.logistics[br.route].stats.delivered;
  await until(() => { const file = JSON.parse(readFileSync(save, 'utf8')); return file.world.companies[b.id].online === false && file.world.logistics[br.route].stats.delivered > offlineBefore; }, 'offline route did not advance', 60000);
  check(true, 'permitted transport continues while its company is offline');
  await page.locator('[data-lg-help]').first().click(); await page.waitForSelector('[data-logistics-station]');
  await page.locator('[data-tab="market"]').click(); await page.locator('[data-lit]').selectOption('ore'); await page.locator('[data-lq]').fill('100'); await page.locator('[data-lp]').fill('100'); await page.locator('[data-list]').click();
  await until(() => JSON.parse(readFileSync(save, 'utf8')).world.logistics[ar.route].stats.delivered > 0, 'warehouse space did not resume delivery', 30000);
  const recovered = JSON.parse(readFileSync(save, 'utf8')); check(assets(recovered, a.id) === expected[a.id] && recovered.world.stations[ar.depot].listings[0].qty === 100, 'real UI escrow frees space and automatic delivery resumes without selling or losing goods');
  await page.locator('[data-logistics-station]').click(); await page.waitForSelector('[data-lg-card]');
  await page.screenshot({ animations: 'disabled', path: out + '/multiplayer-recovery-390.png' });
  const otherPage = await b.page(); await otherPage.getByRole('button', { name: '물류 관리', exact: true }).click(); await otherPage.waitForSelector('[data-lg-card]');
  check(await otherPage.locator('[data-lg-card]').count() === 1 && !(await otherPage.locator('.lg-box').innerText()).includes('노바 물류 반복 노선'), 'two actual browsers keep separate company route controls');
  await stop(); const final = JSON.parse(readFileSync(save, 'utf8'));
  check(assets(final, a.id) === expected[a.id] && assets(final, b.id) === expected[b.id], 'both companies conserve goods through simultaneous operation, restart and recovery');
  mkdirSync(out, { recursive: true }); writeFileSync(out + '/multiplayer-results.json', JSON.stringify({ checks, passed: checks.length, restarts: 2, assets: expected }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (browser) await browser.close(); await stop(); }
