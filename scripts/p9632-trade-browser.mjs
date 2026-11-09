// Isolated single-player browser check; never connects to a production server or database.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = 'artifacts/p9632', temp = mkdtempSync(path.join(tmpdir(), 'siderarium-p9632-browser-'));
mkdirSync(out, { recursive: true });
await build({ stdin: { contents: "export { integrationFixture } from './tests/support/integration'; export { econOf } from './src/world/hullops'; export { techFx } from './src/world/industry';", resolveDir: process.cwd(), sourcefile: 'p9632-fixture.ts', loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(temp, 'fixture.mjs'), logLevel: 'silent' });
const { integrationFixture, econOf, techFx } = await import(pathToFileURL(path.join(temp, 'fixture.mjs')).href);
const f = integrationFixture(9632), seller = f.sim.addPlayer('격리 판매 회사'), home = f.sim.st.stations.astra;
const fractionalGroup = f.sim.newGroup(f.p, '소량 화물 검증'), fractionalShip = f.sim.spawnShip(f.p, 'hauler', 'std', fractionalGroup.id, home.pos);
f.sim.dockShip(fractionalShip, home); fractionalShip.cargo.ore = .25;
const st = { ...structuredClone(home), id: 'p9632_private_exchange', name: '격리 사설 거래소', owner: seller, public: false, size: 'S', market: null,
  pos: { ...home.pos, x: home.pos.x + 1200 }, services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false },
  storage: { [seller]: { ore: 10 }, [f.p]: {} }, modules: [{ kind: 'core', slot: 0, built: true, progress: 1 }, { kind: 'trade_hub', slot: 1, built: true, progress: 1 }] };
f.sim.st.stations[st.id] = st;
const err = f.sim.command(seller, { c: 'list', station: st.id, item: 'ore', qty: 10, price: 10 });
if (err) throw Error(err);
const listing = st.listings[0].id, file = f.server.snapshotFile();
const meta = { buyer: f.p, seller, station: st.id, listing, group: f.supply.id, ship: f.carrier.id,
  fractionalShip: fractionalShip.id, capacity: econOf(f.carrier).cargo * techFx(f.sim.st.companies[f.p].tech).cargoMul };
const checks = [], errors = [], results = { meta, checks, errors };
const check = (ok, description) => { if (!ok) throw Error(description); checks.push(description); console.log('PASS', description); };
const server = spawn('node', ['dist-server/server.mjs'], { env: { PATH: process.env.PATH, HOME: temp, NODE_ENV: 'production', PORT: '8355', DATABASE_URL: '', CONTENT_MIGRATE: '', SAVE_FILE: path.join(temp, 'disposable-world.json') } });
let browser, page, log = '';
server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d);
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); server.stdout.on('data', () => { if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); server.once('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(({ file, meta }) => {
    if (!localStorage.getItem('siderarium.sp.v1')) { localStorage.setItem('siderarium.sp.v1', JSON.stringify(file)); localStorage.setItem('siderarium.sp.token', 'integration'); }
    window.__p9632 = meta;
  }, { file, meta });
  await page.goto('http://localhost:8355/?sp=continue&name=격리검증', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(id => window.siderarium?.client?.company === id && window.siderarium?.hud, f.p);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  await page.evaluate(() => window.siderarium.hud.openStation('astra', 'ships'));
  check((await page.locator('.smodal').innerText()).includes('0.25'), 'ship exchange visibly identifies fractional cargo before a listing');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/fractional-ship-1440.png` });
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-listship="${meta.fractionalShip}"]`).click();
  await page.waitForFunction(() => document.body.textContent.includes('화물을 먼저 하역하세요'));
  check(await page.evaluate(() => { const a = window.siderarium, m = window.__p9632; return !a.client.t.server.sim.st.ships[m.fractionalShip].listed; }), 'server rejects a ship listing with fractional cargo');
  const unloadError = await page.evaluate(() => window.siderarium.client.cmd({ c: 'unloadCargo', ship: window.__p9632.fractionalShip }));
  check(unloadError === null, 'the owner can unload the fractional cargo');
  await page.waitForFunction(() => window.siderarium.client.state.stations.astra.storage[window.__p9632.buyer].ore === 600.25);
  await page.evaluate(() => window.siderarium.hud.openStation('astra', 'store'));
  check((await page.locator('.smodal').innerText()).includes('600.25'), 'warehouse UI shows the authoritative fractional inventory');
  check((await page.locator('.smodal .stor').innerText()).includes('600.25'), 'warehouse capacity summary matches its fractional inventory');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/fractional-warehouse-1440.png` });
  const before = await page.evaluate(() => { const a = window.siderarium, m = window.__p9632, sim = a.client.t.server.sim; return { buyer: sim.st.companies[m.buyer].credits, seller: sim.st.companies[m.seller].credits, home: sim.st.stations.astra.storage[m.buyer].ore }; });
  await page.evaluate(id => window.siderarium.hud.openStation(id, 'market'), st.id);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${out}/market-1440.png` });
  await page.locator(`[data-buyl="${listing}:1"]`).evaluate(button => { button.click(); button.click(); });
  await page.waitForFunction(() => { const a = window.siderarium, m = window.__p9632; return a.client.state.stations[m.station].storage[m.buyer]?.ore === 1; });
  const bought = await page.evaluate(() => { const a = window.siderarium, m = window.__p9632, sim = a.client.t.server.sim; return { buyer: sim.st.companies[m.buyer].credits, seller: sim.st.companies[m.seller].credits, held: sim.st.stations[m.station].storage[m.buyer].ore, listing: sim.st.stations[m.station].listings[0].qty, dock: sim.canDock(sim.st.stations[m.station], m.buyer) }; });
  check(bought.buyer === before.buyer - 10 && bought.seller > before.seller && bought.held === 1 && bought.listing === 9 && !bought.dock, 'double-click buys one item at the private exchange without granting docking');
  await page.evaluate(() => window.siderarium.hud.openLogistics());
  await page.locator('[data-lg-new]').first().click();
  await page.locator('[data-lg-field="group"]').selectOption(meta.group);
  await page.locator('[data-lg-field="from"]').selectOption(st.id);
  await page.locator('[data-lg-field="to"]').selectOption('astra');
  await page.locator('[data-lg-field="item"]').selectOption('ore');
  await page.locator('[data-lg-field="name"]').fill('거래품 회수 검증');
  await page.locator('[data-lg-field="amount"]').fill('1');
  await page.locator('[data-lg-field="repeat"]').uncheck();
  check(await page.getByText('사설 정거장의 자사 재고만 외부에서 인수합니다.', { exact: false }).count() > 0, 'route editor explains owner-only external pickup');
  await page.screenshot({ path: `${out}/pickup-route-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/pickup-route-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '노선 활성화', exact: true }).click();
  await page.waitForFunction(() => Object.values(window.siderarium.client.state.logistics ?? {}).some(r => r.config.name === '거래품 회수 검증'));
  const result = await page.evaluate(() => {
    const a = window.siderarium, m = window.__p9632, server = a.client.t.server, sim = server.sim;
    let route = Object.values(sim.st.logistics).find(r => r.config.name === '거래품 회수 검증');
    for (let i = 0; i < 16000 && route.state !== 'complete'; i++) sim.update(.25);
    server.step(.5); route = sim.st.logistics[route.id];
    return { id: route.id, state: route.state, loaded: route.stats.loaded, delivered: route.stats.delivered,
      source: sim.st.stations[m.station].storage[m.buyer].ore ?? 0, destination: sim.st.stations.astra.storage[m.buyer].ore, cargo: sim.st.ships[m.ship].cargo.ore ?? 0 };
  });
  check(result.state === 'complete' && result.loaded === 1 && result.delivered === 1 && result.source === 0 && result.destination === before.home + 1 && result.cargo === 0, 'UI-configured route physically delivers exactly one purchased item');
  await page.waitForFunction(id => window.siderarium.client.state.logistics?.[id]?.state === 'complete', result.id);
  await page.locator(`[data-lg-fleet="${result.id}"] summary`).click();
  const cargoText = await page.locator(`[data-lg-fleet="${result.id}"]`).innerText();
  check(cargoText.includes(new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(meta.capacity)), 'route shows the server research-adjusted cargo capacity');
  await page.locator(`[data-lg-edit="${result.id}"]`).click();
  check(await page.locator('[data-lg-field="from"]').inputValue() === st.id, 'an existing route retains its now-empty private pickup station in the editor');
  await page.evaluate(() => window.siderarium.client.t.saveNow());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(id => window.siderarium?.client?.company === id && window.siderarium?.hud, f.p);
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
  const restored = await page.evaluate(id => { const a = window.siderarium, m = window.__p9632, sim = a.client.t.server.sim, route = sim.st.logistics[id]; return { delivered: route.stats.delivered, home: sim.st.stations.astra.storage[m.buyer].ore, source: sim.st.stations[m.station].storage[m.buyer].ore ?? 0, credits: sim.st.companies[m.buyer].credits }; }, result.id);
  check(restored.delivered === 1 && restored.home === before.home + 1 && restored.source === 0 && restored.credits === bought.buyer, 'browser save and restart preserve the trade, route, cargo and credits');
  check(errors.length === 0, 'no browser runtime errors');
  results.before = before; results.bought = bought; results.route = result; results.restored = restored;
} catch (error) {
  results.failure = String(error); console.error(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: `${out}/browser-failure.png` }).catch(() => {});
} finally {
  writeFileSync(`${out}/browser-results.json`, JSON.stringify(results, null, 2));
  if (browser) await browser.close(); server.kill('SIGTERM');
}
