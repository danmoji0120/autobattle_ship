const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-storage-ui-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8341', SAVE_FILE: path.join(dir, 'world.json'), DATABASE_URL: '' } });
let browser; let log = ''; const errors = [];
(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); srv.stderr.on('data', d => log += d); srv.on('exit', () => reject(Error(log))); });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://localhost:8341/?sp=new&name=창고검증');
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, { timeout: 60000 });
  await page.evaluate(() => { const app = window.siderarium; app.client.setSpeed(0); app.hud.openStation('astra', 'store'); });
  await page.getByRole('button', { name: '+1 구획 임대', exact: true }).click();
  await page.waitForFunction(() => window.siderarium.client.state.companies[window.siderarium.client.company].leases?.astra === 1);
  if (!await page.getByText('첫 1시간 요금을 즉시 선납합니다', { exact: false }).count()) throw Error('prepayment explanation missing');
  await page.screenshot({ path: 'artifacts/storage-analytics/stage1-storage-1440.png' });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: 'artifacts/storage-analytics/stage1-storage-1024.png' });
  const result = await page.evaluate(() => {
    const app = window.siderarium, sim = app.client.t.server.sim, me = app.client.company;
    app.hud.closeModal();
    for (const [id, g] of Object.entries(sim.st.groups)) if (g.owner !== me) { for (const sid of g.shipIds) delete sim.st.ships[sid]; delete sim.st.groups[id]; }
    for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
    for (const sys of Object.values(sim.st.systems)) sys.security = 100;
    const co = sim.st.companies[me]; co.credits = 100000;
    const group = Object.values(sim.st.groups).find(g => g.owner === me && g.shipIds.some(id => sim.st.ships[id]?.classId === 'miner'));
    const err = sim.command(me, { c: 'setOp', group: group.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true, auto: true } });
    if (err) throw Error(err);
    const earned = co.stats.earned;
    for (let t = 0; t < 600; t += .25) sim.update(.25);
    if (co.stats.mined <= 0 || co.stats.earned <= earned) throw Error('mining → transportation → sale failed');
    return { mined: co.stats.mined, saleIncome: co.stats.earned - earned, leased: co.leases.astra };
  });
  if (errors.length) throw Error(errors.join('\n'));
  console.log('PASS storage UI 1440/1024 and real mining → unload → sale', JSON.stringify(result));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); srv.kill('SIGTERM'); });
