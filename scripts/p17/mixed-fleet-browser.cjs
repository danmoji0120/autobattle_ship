// Build first. Run with Playwright installed, or set PLAYWRIGHT_MODULE and CHROMIUM_PATH.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');

const port = process.env.PORT || '8349';
const temp = mkdtempSync(join(tmpdir(), 'siderarium-mixed-fleet-'));
const out = process.env.SCREENSHOT_DIR || 'artifacts/p174-followup';
const server = spawn(process.execPath, ['dist-server/server.mjs'], {
  env: { ...process.env, PORT: port, SAVE_FILE: join(temp, 'world.json'), DATABASE_URL: '' },
});
let browser;
let log = '';
server.stderr.on('data', data => { log += data; });
server.stdout.on('data', data => { log += data; });

async function main() {
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (attempt === 99 || server.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(String(err)));
  await page.goto(`${url}/?sp=new&name=혼합함대검증`);
  await page.waitForFunction(() => window.siderarium?.client?.t?.server?.sim && window.siderarium?.hud);
  const fixture = await page.evaluate(() => {
    const c = window.siderarium.client, sim = c.t.server.sim, me = c.company;
    const co = sim.st.companies[me], origin = sim.st.stations[co.homeStation];
    co.credits = 250000;
    for (const hull of ['miner_mk1', 'hauler_mk1']) {
      const error = sim.command(me, { c: 'buyBlueprint', station: origin.id, blueprint: `bp_${hull}` });
      if (error) throw new Error(error);
    }
    const group = sim.newGroup(me, '브라우저 검증 편대');
    const items = ['alloy', 'armor_plate', 'structure', 'engine', 'reactor', 'machinery', 'electronics', 'crystal', 'precision', 'eq_pd_gun', 'ind_mine_s'];
    const modules = ['core', 'power', 'power', 'warehouse', 'warehouse', 'yard_s', 'yard_s'];
    sim.st.stations.verify_yard = {
      ...structuredClone(origin), id: 'verify_yard', name: '브라우저 검증 조선소', owner: me, public: false,
      pos: { ...origin.pos, x: origin.pos.x + 3500 }, market: null, shipStock: undefined, size: undefined, funds: undefined,
      services: { repair: true }, storage: { [me]: Object.fromEntries(items.map(item => [item, 100])) },
      modules: modules.map((kind, slot) => ({ kind, slot, built: true, progress: 1 })), builds: [], orders: [], jobs: [],
    };
    sim.storeProduction(origin, me, 'ore', 30, 'mining');
    sim.command(me, { c: 'sell', station: origin.id, res: 'ore', amount: 30 });
    sim.storeProduction(origin, me, 'ore', 30);
    const beforeSale = co.credits;
    const error = sim.command(me, { c: 'sell', station: origin.id, res: 'ore', amount: 30 });
    if (error) throw new Error(error);
    return { group: group.id, yard: 'verify_yard', unallocatedSale: Math.round(co.credits - beforeSale) };
  });
  await page.waitForFunction(id => window.siderarium.client.state?.stations[id], fixture.yard);
  await page.locator('#opsBtn').click();
  await page.locator('nav.ops-tabs [data-id="fleet"]').click();
  await page.locator('[data-a="form"][data-id="fleet"]').click();
  await page.locator('[data-fl="station"]').selectOption(fixture.yard);
  await page.locator('[data-fl="group"]').selectOption(fixture.group);
  await page.locator('[data-fl="0:hull"]').selectOption('miner_mk1');
  await page.locator('[data-fl="0:fit"]').selectOption('p:miner_std');
  await page.locator('[data-a="fl-add"]').click();
  await page.locator('[data-fl="1:hull"]').selectOption('hauler_mk1');
  await page.locator('[data-fl="1:fit"]').selectOption('p:hauler_std');
  await page.locator('[name="g-budget"]').fill('50000');
  const quote = page.locator('.ops-fleet-est');
  assert.equal(await quote.locator('tbody tr').count(), 2);
  assert.match(await quote.innerText(), /착공비 합계.*cr/);
  assert.doesNotMatch(await quote.innerText(), /건조할 수 없는/);
  mkdirSync(out, { recursive: true });
  await quote.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'fleet-quote.png') });
  console.log('PASS mixed fleet quote');
  await page.locator('[data-a="goal"]').click();
  await page.waitForFunction(({ group, yard }) => {
    const c = window.siderarium.client, w = c.state;
    const target = Object.values(w.works ?? {}).find(x => x.goal?.k === 'fleet' && x.goal.station === yard);
    return target?.goal.group === group && target.goal.lines?.length === 2
      && w.stations[yard].builds?.length === 2
      && w.stations[yard].builds.every(b => Object.values(w.works).some(x => x.parent === target.id && x.ref.build === b.id));
  }, fixture, { timeout: 12000 }).catch(async error => {
    const state = await page.evaluate(({ yard }) => {
      const c = window.siderarium.client, w = c.t.server.sim.st;
      return { goals: Object.values(w.works ?? {}).filter(x => x.owner === c.company), builds: w.stations[yard].builds,
        message: [...document.querySelectorAll('.ops-box .warn, .ops-box .good')].map(el => el.textContent).slice(0, 15) };
    }, fixture);
    console.error(JSON.stringify(state, null, 2));
    throw error;
  });
  console.log('PASS goal linked to two construction queue entries');
  await page.screenshot({ path: join(out, 'fleet-queue.png') });
  const built = await page.evaluate(({ group }) => {
    const c = window.siderarium.client, sim = c.t.server.sim;
    const hasShips = () => sim.shipsOf(sim.st.groups[group]).length === 2;
    for (let t = 0; t < 4000 && !hasShips(); t++) sim.update(1);
    return sim.shipsOf(sim.st.groups[group]).map(s => [s.hull, s.fitting.hp]);
  }, fixture);
  assert.deepEqual(built.map(x => x[0]).sort(), ['hauler_mk1', 'miner_mk1']);
  for (const [, hp] of built) assert.equal(Object.values(hp).filter(id => id === 'eq_pd_gun').length, 2);
  await page.waitForFunction(id => window.siderarium.client.state?.groups[id]?.shipIds.length === 2, fixture.group);
  await page.screenshot({ path: join(out, 'fleet-assignment.png') });
  console.log('PASS both finished hulls with their presets assigned to the selected fleet');

  await page.locator('nav.ops-tabs [data-id="hq"]').click();
  await page.locator('nav.ops-subtabs [data-id="finance"]').click();
  const pnl = page.locator('.ops-pnl');
  assert.match(await pnl.locator('tr[data-act="mining"]').innerText(), /채광/);
  assert.match(await page.locator('[data-act="unallocated"] span').first().innerText(),
    new RegExp(`미배분 판매 매출\\s*${fixture.unallocatedSale} cr`));
  await pnl.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'finance.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await pnl.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => {
    const panel = document.querySelector('.ops-body'), financial = document.querySelector('.ops-pnl').parentElement;
    return document.documentElement.scrollWidth <= window.innerWidth + 1
      && panel.scrollWidth <= panel.clientWidth + 1 && financial.scrollWidth <= financial.clientWidth + 1;
  }));
  await page.screenshot({ path: join(out, 'finance-phone.png') });
  assert.deepEqual(errors, []);
  console.log('PASS attributed and unallocated cash shown at desktop and mobile widths');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  server.kill();
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  rmSync(temp, { recursive: true, force: true });
});
