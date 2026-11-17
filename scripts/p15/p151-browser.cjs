// P15.1.1 browser check on a real server (built client + `node dist-server/server.mjs`, standard world):
//  1. skirmish editor: every ship row has a computer select (basic + the six products, with tactic / band);
//     choosing one is kept in the saved fleet; the battle starts with rules 2 and the chosen computers act
//  2. strategic fitting: a security PMC at Helios opens the fitting screen of a docked warship; the computer bay
//     is listed; the compatible list shows the computers with tactic / aim distance (research locks marked);
//     picking one shows the change preview (bay row, cost, take-from list), apply fits it (credits charged);
//     clearing it previews the removal
//   node scripts/p15/p151-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/p151/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-p151-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '151', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'COMPUTERS_P151_MIGRATE']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 160 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { base, checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 700) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = page => {
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) report.console.push({ type: m.type(), text: m.text().slice(0, 300) }); });
  };
  try {
    // ---------------- 1. skirmish
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page);
    await page.goto(base + '/?skirmish', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[data-scpu]', { timeout: 30000 });
    const sel = await page.evaluate(() => [...document.querySelectorAll('select[data-scpu]')].map(s => ({ key: s.dataset.scpu, opts: [...s.options].map(o => ({ v: o.value, t: o.textContent })) })));
    check(sel.length > 0 && sel.every(s => s.opts.length === 7 && s.opts[0].v === '' && ['cpu_generic', 'cpu_swarm', 'cpu_picket', 'cpu_line', 'cpu_artillery', 'cpu_siege'].every(id => s.opts.some(o => o.v === id))), 'every ship row: basic + six computers', { rows: sel.length, first: sel[0]?.opts });
    check(sel[0].opts.every(o => o.v === '' || /·/.test(o.t)), 'options name the behaviour and band', sel[0].opts.map(o => o.t));
    // choose different computers on the first rows
    const pick = ['cpu_line', 'cpu_artillery', 'cpu_picket', 'cpu_swarm'];
    for (let i = 0; i < Math.min(pick.length, sel.length); i++) {
      await page.selectOption(`select[data-scpu="${sel[i].key}"]`, pick[i]);
      await page.waitForTimeout(150);
    }
    const chosen = await page.evaluate(() => [...document.querySelectorAll('select[data-scpu]')].map(s => ({ v: s.value, title: s.title })));
    check(chosen.slice(0, Math.min(4, chosen.length)).every((c, i) => c.v === pick[i] && c.title.length > 5), 'choices stay selected after re-render, title shows the tactic', chosen.slice(0, 4));
    await page.screenshot({ path: `${outDir}/skirmish-setup.png` });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('select[data-scpu]');
    const kept = await page.evaluate(() => [...document.querySelectorAll('select[data-scpu]')].map(s => s.value));
    check(kept.slice(0, Math.min(4, kept.length)).every((v, i) => v === pick[i]), 'choices kept in the saved fleet after reload', kept);
    await page.click('#go');
    await page.waitForFunction(() => window.session && window.session.world && window.session.world.time > 1, null, { timeout: 60000 });
    await page.waitForFunction(() => window.session.world.time > 30, null, { timeout: 120000 });
    const bat = await page.evaluate(() => {
      const w = window.session.world;
      return { rules: w.rules, time: Math.round(w.time), ours: w.ships.filter(s => s.team === 0).map(s => ({ cls: s.cls.id, cpu: s.cpu ? s.cpu.spec.id : null, arch: s.cpu ? s.cpu.arch : null, acting: s.cpu ? s.cpu.acting : null, state: s.state })) };
    });
    const withCpu = bat.ours.filter(s => s.cpu);
    check(bat.rules === 2 && withCpu.length === Math.min(4, sel.length) && withCpu.every(s => pick.includes(s.cpu)), 'battle runs with rules 2 and the chosen computers', bat);
    check(withCpu.some(s => s.acting && s.acting !== 'basic') || withCpu.every(s => s.state !== 'alive'), 'a fitted computer is steering its ship', withCpu);
    await page.screenshot({ path: `${outDir}/skirmish-battle.png` });
    await ctx.close();

    // ---------------- 2. strategic fitting
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page = await ctx.newPage(); watch(page);
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'p151_fit', password: 'p151-fit-pass-123', confirm: 'p151-fit-pass-123' }) }));
    report.console.splice(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    await page.fill('#pmcNew', '컴퓨터 검증 PMC'); await page.click('[data-bg="security"]'); await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state && window.siderarium.hud, null, { timeout: 60000 });
    await page.waitForTimeout(2000);
    const fleet = await page.evaluate(() => {
      const st = window.siderarium.client.state, me = window.siderarium.client.company;
      return { credits: Math.round(st.companies[me].credits), ships: Object.values(st.ships).filter(s => s.owner === me).map(s => ({ id: s.id, cls: s.classId, state: s.state, at: s.task && s.task.station, bay: s.fitting && s.fitting.bay })) };
    });
    const war = fleet.ships.find(s => s.state === 'docked' && s.cls !== 'hauler' && s.cls !== 'miner');
    check(!!war, 'security PMC has a docked warship', fleet);
    // the security start opens the military-contract guide: close it like a player would (Escape)
    for (let i = 0; i < 3 && await page.$('.mil-modal'); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    check(!(await page.$('.mil-modal')), 'first-business guide closed with Escape');
    await page.evaluate(id => window.siderarium.hud.openFitting(id), war.id);
    await page.waitForSelector('[data-fsel="bay:cpu1"]', { timeout: 15000 });
    const bayText = await page.innerText('[data-fsel="bay:cpu1"]');
    check(/전투 컴퓨터 베이/.test(bayText) && /비어 있음/.test(bayText), 'computer bay listed, empty (basic control)', bayText);
    await page.click('[data-fsel="bay:cpu1"]');
    await page.waitForTimeout(300);
    const items = await page.evaluate(() => [...document.querySelectorAll('[data-fpick]')].map(e => ({ id: e.dataset.fpick, no: e.classList.contains('no'), text: e.innerText.replace(/\s+/g, ' ') })));
    const cpus = items.filter(i => i.id.startsWith('cpu_') && !i.no);
    check(cpus.length === 6 && cpus.every(i => /교전 ≈\d+m|기본 제어로 동작/.test(i.text)), 'compatible list: six computers with tactic and aim distance for this ship', cpus.map(i => i.text.slice(0, 160)));
    check(items.filter(i => !i.no).every(i => i.id.startsWith('cpu_')), 'only computers are compatible with the computer bay', items.filter(i => !i.no && !i.id.startsWith('cpu_')).map(i => i.id));
    check(cpus.filter(i => i.id !== 'cpu_generic').every(i => /연구 필요/.test(i.text)) && !/연구 필요/.test(cpus.find(i => i.id === 'cpu_generic').text), 'research locks marked (generic needs none)', cpus.map(i => [i.id, /연구 필요/.test(i.text)]));
    await page.screenshot({ path: `${outDir}/fitting-list.png` });
    // pick the generic computer: preview
    await page.click('[data-fpick="cpu_generic"]');
    await page.waitForTimeout(400);
    const prev = await page.evaluate(() => ({
      bay: document.querySelector('[data-fsel="bay:cpu1"]').innerText.replace(/\s+/g, ' '), chg: document.querySelector('[data-fsel="bay:cpu1"]').classList.contains('chg'),
      foot: document.querySelector('.ffoot').innerText.replace(/\s+/g, ' '), apply: !document.querySelector('[data-fapply]').disabled, buy: document.querySelector('[data-fbuy]')?.checked ?? null,
    }));
    check(/범용 전투 컴퓨터/.test(prev.bay) && /전열/.test(prev.bay) && prev.chg, 'bay row previews the new computer and its behaviour', prev.bay);
    check(/범용 전투 컴퓨터/.test(prev.foot) && /cr/.test(prev.foot), 'footer previews the change and its cost', prev.foot);
    await page.screenshot({ path: `${outDir}/fitting-preview.png` });
    if (prev.buy === false) await page.click('[data-fbuy]');
    await page.waitForTimeout(200);
    await page.click('[data-fapply]');
    await page.waitForFunction(id => { const s = window.siderarium.client.state.ships[id]; return s.fitting && s.fitting.bay.cpu1 === 'cpu_generic'; }, war.id, { timeout: 20000 }).catch(() => null);
    const applied = await page.evaluate(id => { const st = window.siderarium.client.state, me = window.siderarium.client.company; return { bay: st.ships[id].fitting.bay, credits: Math.round(st.companies[me].credits) }; }, war.id);
    check(applied.bay.cpu1 === 'cpu_generic' && applied.credits < fleet.credits, 'apply fits the computer and charges the purchase', { ...applied, before: fleet.credits });
    await page.waitForTimeout(500);
    // clear it: removal preview
    await page.click('[data-fclr="bay:cpu1"]');
    await page.waitForTimeout(400);
    const rm = await page.evaluate(() => ({ bay: document.querySelector('[data-fsel="bay:cpu1"]').innerText.replace(/\s+/g, ' '), foot: document.querySelector('.ffoot').innerText.replace(/\s+/g, ' ') }));
    check(/비어 있음/.test(rm.bay) && /해제/.test(rm.foot) && /범용 전투 컴퓨터/.test(rm.foot), 'clearing the bay previews the removal to storage', rm);
    await page.screenshot({ path: `${outDir}/fitting-remove-preview.png` });
    await page.click('[data-freset]');
    await ctx.close();
  } catch (e) { check(false, 'browser run', { error: String(e && e.stack || e).slice(0, 800) }); }
  check(!report.errors.length, 'no page errors', { errors: report.errors.slice(0, 5) });
  const consoleErrors = report.console.filter(c => c.type === 'error');
  check(!consoleErrors.length, 'no console errors', { errors: consoleErrors.slice(0, 5), warnings: report.console.filter(c => c.type === 'warning').length });
  fs.writeFileSync(`${outDir}/browser-results.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${outDir}/server.log`, log);
  await browser.close();
  srv.kill('SIGTERM');
  console.log(`${report.checks.filter(c => c.ok).length}/${report.checks.length}`);
  process.exit(report.checks.every(c => c.ok) ? 0 : 1);
})();
