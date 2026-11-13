// Browser check of value-chain ("B") pricing on PC and mobile: a single-player world is played, saved,
// migrated with the dev-save rehearsal tool (scripts/econ/migrate-save.ts) and continued in the browser.
// Hull prices and repair quotes must not move (option A); market prices, refit cost and the
// "valuation change (not cash)" note must reflect the new rule; no panel may show NaN/undefined.
//   npm run build && node scripts/econ-b-browser.cjs        (screenshots → artifacts/econ-b)
const { chromium, devices } = require('playwright');
const { spawn, execFileSync } = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const out = 'artifacts/econ-b'; fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-econb-'));
const srv = spawn('node', ['dist-server/server.mjs'], { env: { ...process.env, PORT: '8351', SAVE_FILE: path.join(temp, 'world.json'), DATABASE_URL: '' } });
let browser, log = ''; const errors = [];
const assert = (ok, label) => { if (!ok) throw Error('FAIL ' + label); console.log('PASS', label); };
const SP_KEY = 'siderarium.sp.v1';
const bad = t => /NaN|undefined|Infinity/.test(t);

async function boot(page, q) {
  await page.goto('http://localhost:8351/?' + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.siderarium?.client?.state && window.siderarium?.hud, undefined, { timeout: 180000 });
  await page.evaluate(() => window.siderarium.client.setSpeed(0));
}
async function modalText(page, station, tab) {
  await page.evaluate(([s, t]) => window.siderarium.hud.openStation(s, t), [station, tab]);
  await page.waitForSelector('.smodal');
  await page.waitForTimeout(300);
  return page.locator('.smodal').innerText();
}
const numbersOf = t => (t.match(/[\d,]+(\.\d+)?\s*cr/g) ?? []).join(' ');

(async () => {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(log)), 20000); srv.stdout.on('data', d => { log += d; if (log.includes('listening on')) { clearTimeout(timer); resolve(); } }); });
  browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); page.on('pageerror', e => errors.push(String(e)));

  // ── 1. a legacy (c4) single-player world with some activity ──
  await boot(page, 'sp=new&name=가치사슬');
  const info = await page.evaluate(() => {
    const c = window.siderarium.client, sim = c.t.server.sim, me = c.company, co = sim.st.companies[me];
    co.credits = 2_000_000;
    const ship = Object.values(sim.st.ships).find(s => s.owner === me && s.task.k === 'docked' && s.fitting && Object.keys(s.fitting.hp).length);
    if (ship) ship.hp = Math.round(ship.maxHp * 0.6);                   // a damaged, docked warship → repair quote
    const yard = Object.values(sim.st.stations).find(s => s.public && s.services.shipyard.length).id;
    return { me, home: co.homeStation, ship: ship?.id, dockAt: ship ? ship.task.station : co.homeStation, yard, econ: !!sim.st.econ };
  });
  assert(!info.econ, 'the new single-player world has no value-chain pricing (opt-in)');
  assert(!!info.ship, 'a docked armed ship exists for the repair/refit check');
  await page.evaluate(async () => { const c = window.siderarium.client; await c.cmd({ c: 'buy', station: 'astra', res: 'electronics', amount: 20 }); });
  const pre = { market: await modalText(page, 'astra', 'market'), yard: await modalText(page, info.yard, 'yard'), dock: await modalText(page, info.dockAt, 'dock') };
  await page.evaluate(() => window.siderarium.hud.closeModal());
  await page.evaluate(() => window.siderarium.client.t.saveNow());
  const save = await page.evaluate(k => localStorage.getItem(k), SP_KEY);
  const token = await page.evaluate(() => localStorage.getItem('siderarium.sp.token'));   // the save belongs to this browser's token
  fs.writeFileSync(path.join(temp, 'sp.json'), save);

  // ── 2. migrate that save copy with the rehearsal tool (backup, census, round trip, rollback checks) ──
  const rep = execFileSync('npx', ['vite-node', 'scripts/econ/migrate-save.ts', '--', 'rehearse', path.join(temp, 'sp.json'), path.join(temp, 'reh')], { encoding: 'utf8' });
  assert(/all \d+ checks passed/.test(rep), 'dev-save rehearsal passes on the browser save (' + (rep.match(/all \d+ checks passed/) ?? [''])[0] + ')');
  const migrated = fs.readFileSync(path.join(temp, 'reh', 'migrated.json'), 'utf8');

  for (const [label, opts] of [['1440', { viewport: { width: 1440, height: 900 } }], ['mobile', devices['iPhone 13']]]) {
    const c2 = await browser.newContext(opts); const p = await c2.newPage(); p.on('pageerror', e => errors.push(`${label}: ${e}`));
    await p.goto('http://localhost:8351/', { waitUntil: 'domcontentloaded', timeout: 120000 }); await p.evaluate(([k, v, t]) => { localStorage.setItem(k, v); localStorage.setItem('siderarium.sp.token', t); }, [SP_KEY, migrated, token]);
    await boot(p, 'sp=continue&name=가치사슬');
    const st = await p.evaluate(() => { const c = window.siderarium.client, w = c.state; return { econ: w.econ, log: 'econLog' in w, company: c.company, credits: w.companies[c.company]?.credits}; });
    assert(st.company === info.me, `${label}: the continued game is the same company (${st.company}, ${Math.round(st.credits)} cr)`);
    assert(st.econ?.how === 'migrated' && st.econ.alloyDirect === 7, `${label}: continued world carries the value-chain rule (alloy_direct ${st.econ?.alloyDirect})`);
    assert(!st.log, `${label}: the migration log (old prices) is not sent to clients`);
    const market = await modalText(p, 'astra', 'market'); fs.writeFileSync(`${out}/market-pre.txt`, pre.market); fs.writeFileSync(`${out}/market-${label}.txt`, market); await p.screenshot({ animations: 'disabled', path: `${out}/market-${label}.png` });
    const rows = t => t.split('\n').filter(l => l.includes('\t')).map(l => l.split('\t').slice(2, 5).join(' ')).join('|');
    assert(!bad(market) && rows(market).length > 50 && rows(market) !== rows(pre.market), `${label}: market prices changed and render cleanly`);
    const yard = await modalText(p, info.yard, 'yard'); await p.screenshot({ animations: 'disabled', path: `${out}/yard-${label}.png` });
    assert(!bad(yard), `${label}: shipyard renders cleanly`);
    fs.writeFileSync(`${out}/yard-pre.txt`, pre.yard); fs.writeFileSync(`${out}/yard-${label}.txt`, yard);
    const hullPrices = t => t.split('\n').filter(l => /cr/.test(l) && !/보관|재고|부품/.test(l)).map(l => l.replace(/\s+/g, ' ')).join('|');
    assert(hullPrices(yard).length > 0 && hullPrices(yard) === hullPrices(pre.yard), `${label}: NPC hull prices unchanged (option A)`);
    const dock = await modalText(p, info.dockAt, 'dock'); await p.screenshot({ animations: 'disabled', path: `${out}/dock-repair-${label}.png` });
    const quote = t => (t.match(/수리[^\n]*?[\d,]+\s*cr/g) ?? []).join('|');
    assert(!bad(dock) && quote(dock) !== '' && quote(dock) === quote(pre.dock), `${label}: repair quote unchanged (${quote(dock).slice(0, 60)})`);
    await p.evaluate(() => window.siderarium.hud.closeModal());
    // refit: the fitting screen prices missing equipment at the service price
    await p.evaluate(id => window.siderarium.hud.openFitting(id), info.ship);
    await p.waitForSelector('.fitmodal', { timeout: 60000 }); await p.waitForTimeout(500);
    const fit = await p.evaluate(() => document.querySelector('.fitmodal').innerText); await p.screenshot({ animations: 'disabled', path: `${out}/fitting-${label}.png` });
    assert(!bad(fit), `${label}: fitting screen renders cleanly`);
    assert(/cr/.test(fit), `${label}: fitting screen shows prices`);
    await p.evaluate(() => document.querySelector('.fitmodal')?.click());
    // company HQ: finance shows the valuation change separately from cash; a recurring trade goal with its estimate
    const tradeErr = await p.evaluate(() => window.siderarium.client.cmd({ c: 'workCreate', goal: { k: 'trade', item: 'machinery', from: 'astra', to: 'cinderco', amount: 50, maxBuy: 1e5, minSell: 0, minProfit: 0, cycles: 1 }, budget: 300000 }));
    assert(tradeErr === null, `${label}: recurring trade goal accepted`);
    await p.evaluate(() => { const s = window.siderarium.client.t.server; for (let i = 0; i < 8; i++) s.step(.25); });
    await p.locator('#opsBtn').click(); await p.waitForSelector('.ops-box');
    await p.locator('[data-a="tab"][data-id="finance"]').first().click(); await p.waitForTimeout(300);
    const fin = await p.locator('.ops-box').innerText(); await p.screenshot({ animations: 'disabled', path: `${out}/finance-${label}.png` });
    fs.writeFileSync(`${out}/finance-${label}.txt`, fin);
    assert(/재고 평가 변화/.test(fin) && /평가 변화 \(현금 아님\)/.test(fin) && !bad(fin), `${label}: finance tab shows the valuation change as non-cash`);
    await p.locator('[data-a="tab"][data-id="works"]').first().click(); await p.waitForTimeout(300);
    const works = await p.locator('.ops-box').innerText(); fs.writeFileSync(`${out}/works-${label}.txt`, works); await p.screenshot({ animations: 'disabled', path: `${out}/works-${label}.png` });
    assert(!bad(works) && /반복 무역/.test(works), `${label}: works tab lists the recurring trade cleanly`);
    await p.locator('[data-a="tab"][data-id="industry"]').first().click(); await p.waitForTimeout(300);
    const ind = await p.locator('.ops-box').innerText(); await p.screenshot({ animations: 'disabled', path: `${out}/industry-${label}.png` });
    assert(!bad(ind), `${label}: industry tab renders cleanly`);
    if (label === 'mobile') {
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `mobile: no horizontal page overflow (${overflow}px)`);
    }
    await c2.close();
  }
  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  console.log('screenshots →', out);
})().catch(e => { console.error(e.message ?? e); process.exitCode = 1; }).finally(async () => { await browser?.close(); srv.kill(); });
