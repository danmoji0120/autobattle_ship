// B-1 officer UI browser check on a real server (built client + `node dist-server/server.mjs`, standard world with B-1).
//  1. desktop 1440: found a company, the top bar shows the 장교 button; the panel lists the officers
//  2. profile (level, XP, SP, posting, salary, mastery, effects), filter + search + sort
//  3. skill tree: SVG nodes and lines, node detail, learning a node spends a point on the server
//  4. compare two officers, log tab
//  5. phone 390: list → detail → back without horizontal scroll; no page errors
//   node scripts/b1/b1-browser.cjs <outDir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const outDir = process.argv[2] ?? 'artifacts/b1/browser';
(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-b1-browser-'));
  const env = { ...process.env, PORT: String(port), STATIC_DIR: path.resolve('dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '41', SAVE_INTERVAL_S: '5' };
  for (const k of ['DATABASE_URL', 'WORLD_RESET', 'WORLD_PRESET', 'OFFICERS_B1_MIGRATE']) delete env[k];
  let log = '';
  const srv = spawn('node', [path.resolve('dist-server/server.mjs')], { cwd: dir, env });
  srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 160 && !log.includes('listening on'); i++) await new Promise(r => setTimeout(r, 250));
  const base = `http://127.0.0.1:${port}`;
  const report = { checks: [], errors: [], console: [] };
  const check = (ok, label, extra) => { report.checks.push({ ok: !!ok, label, ...(extra ? { extra } : {}) }); console.log(ok ? 'PASS' : 'FAIL', label, extra ? JSON.stringify(extra).slice(0, 500) : ''); };
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const watch = (page, vp) => {
    page.on('pageerror', e => report.errors.push(`${vp}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') report.console.push({ vp, text: m.text().slice(0, 300) }); });
  };
  const found = async (page, id, pw, bg) => {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async ([id, pw]) => fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw, confirm: pw }) }), [id, pw]);
    report.console.splice(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mpJoin:not([disabled])', { timeout: 30000 }); await page.click('#mpJoin');
    await page.waitForSelector('#pmcCreate [data-bg]', { timeout: 30000 });
    await page.fill('#pmcNew', `B1 ${bg}`); await page.click(`[data-bg="${bg}"]`); await page.click('#pmcGo');
    await page.waitForFunction(() => window.siderarium?.client?.company && window.siderarium.client.state, null, { timeout: 60000 });
    await page.waitForTimeout(2500);
  };
  const officers = page => page.evaluate(() => {
    const st = window.siderarium.client.state, me = window.siderarium.client.company;
    return { v: st.officerV, list: Object.values(st.commanders).filter(c => c.owner === me).map(c => ({ id: c.id, name: c.name, level: c.level, sp: c.of?.sp, skills: c.of?.skills, post: c.of?.post })) };
  });
  const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  try {
    // ---- desktop
    let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    let page = await ctx.newPage(); watch(page, 1440);
    await found(page, 'b1_desk', 'b1-desk-pass-123', 'security');
    // hire a second officer from the recruit pool (the server command the station panel's 영입 button sends)
    const hired = await page.evaluate(async () => {
      const cl = window.siderarium.client, st = cl.state, co = st.companies[cl.company];
      const pool = Object.values(st.commanders).filter(c => !c.owner && c.stationId && c.hireCost <= co.credits).sort((a, b) => a.hireCost - b.hireCost);
      if (!pool.length) return { ok: false, why: 'no recruit' };
      const r = await cl.cmd({ c: 'hire', commander: pool[0].id });
      return { ok: r === null, err: r, id: pool[0].id, cost: pool[0].hireCost };
    });
    await page.waitForTimeout(2000);
    check(hired.ok, 'hire a recruit (second officer)', hired);
    const o0 = await officers(page);
    check(o0.v === 1 && o0.list.length >= 1 && o0.list.every(o => o.skills), 'standard world runs B-1: the company has officers with growth state', o0);
    check(await page.isVisible('#officerBtn'), 'top bar shows the 장교 button', { text: await page.innerText('#officerBtn').catch(() => '') });
    await page.click('#officerBtn'); await page.waitForSelector('.of-modal .of-row', { timeout: 10000 });
    const rows = await page.$$eval('.of-row', r => r.map(x => x.innerText.replace(/\s+/g, ' ')));
    check(rows.length === o0.list.length, 'roster lists every officer', rows);
    await page.screenshot({ path: `${outDir}/list-1440.png` });
    await page.click('.of-rowmain'); await page.waitForTimeout(400);
    const prof = await page.innerText('.of-modal');
    check(/Lv/.test(prof) && /스킬 포인트|SP/.test(prof) && /급여/.test(prof) && /숙련/.test(prof) && /보직/.test(prof), 'profile: level, SP, salary, mastery, posting', { prof: prof.slice(0, 900) });
    await page.screenshot({ path: `${outDir}/profile-1440.png` });
    // search that matches nothing then clears
    if (await page.$('.of-search')) {
      await page.fill('.of-search', 'zzzz-없음'); await page.waitForTimeout(300);
      const n0 = await page.$$eval('.of-row', r => r.length);
      await page.fill('.of-search', ''); await page.waitForTimeout(300);
      const n1 = await page.$$eval('.of-row', r => r.length);
      check(n0 === 0 && n1 === rows.length, 'search narrows and restores the roster', { n0, n1 });
    }
    // tree
    await page.click('[data-a="tab"][data-id="tree"]'); await page.waitForSelector('.of-tree', { timeout: 5000 });
    const tree = await page.evaluate(() => ({ nodes: document.querySelectorAll('.of-node').length, lines: document.querySelectorAll('.of-tree line, .of-tree path').length, chips: document.querySelectorAll('.of-chip').length }));
    check(tree.nodes >= 8 && tree.lines > 0 && tree.chips === 13, 'tree: 13 tree chips, ≥8 nodes with lines', tree);
    const target = await page.evaluate(() => document.querySelector('.of-node.open')?.getAttribute('data-id'));
    check(!!target, 'an open (learnable) node exists for a level-1 officer', { target });
    if (target) {
      await page.click(`.of-node[data-id="${target}"]`); await page.waitForTimeout(300);
      await page.screenshot({ path: `${outDir}/tree-node-1440.png` });
      const before = (await officers(page)).list;
      await page.click(`[data-a="learn"][data-id="${target}"]`); await page.waitForTimeout(2500);
      const after = (await officers(page)).list;
      const who = after.find(o => o.skills && o.skills[target]);
      const prev = who && before.find(o => o.id === who.id);
      check(who && prev && who.sp === prev.sp - 1, 'learning on the page reaches the server: rank set, SP spent', { target, who, prevSp: prev?.sp });
      const st = await page.evaluate(id => document.querySelector(`.of-node[data-id="${id}"]`)?.getAttribute('class'), target);
      check(/have|max/.test(st ?? ''), 'node shows as learned after the server update', { st });
    }
    // locked node explains why
    const locked = await page.evaluate(() => document.querySelector('.of-node.lock')?.getAttribute('data-id'));
    if (locked) { await page.click(`.of-node[data-id="${locked}"]`); await page.waitForTimeout(300); const why = await page.innerText('.of-nodeinfo').catch(() => ''); check(/\S/.test(why) && !(await page.$(`[data-a="learn"][data-id="${locked}"]`)), 'a locked node shows its reason and no learn button', { why: why.slice(0, 300) }); }
    await page.screenshot({ path: `${outDir}/tree-1440.png` });
    // compare
    const cks = await page.$$('.of-cmpck');
    if (cks.length >= 2) {
      await cks[0].click(); await page.waitForTimeout(200); await (await page.$$('.of-cmpck'))[1].click(); await page.waitForTimeout(200);
      await page.click('[data-a="cmpgo"]'); await page.waitForTimeout(300);
      const th = await page.$$eval('.of-cmp thead th', t => t.length);
      check(th === 3, 'compare table shows the two picked officers', { th });
      await page.screenshot({ path: `${outDir}/compare-1440.png` });
    } else check(false, 'compare needs two officers', { n: cks.length });
    await page.click('[data-a="tab"][data-id="log"]'); await page.waitForTimeout(300);
    check(/\S/.test(await page.innerText('.of-modal')), 'log tab renders');
    await page.screenshot({ path: `${outDir}/log-1440.png` });
    check(await noHScroll(page), 'desktop: no horizontal page scroll');
    await ctx.close();
    // ---- phone
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    page = await ctx.newPage(); watch(page, 390);
    await found(page, 'b1_phone', 'b1-phone-pass-123', 'veteran');
    await page.screenshot({ path: `${outDir}/hud-390.png` });
    const top = await page.evaluate(() => [...document.querySelectorAll('#topbar button, #goals')].map(e => { const r = e.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { id: e.id || e.innerText.slice(0, 8), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), covered: !!hit && !e.contains(hit) ? (hit.closest('[id]')?.id ?? hit.className) : '' }; }));
    console.log('TOPBAR390', JSON.stringify(top));
    await page.click('#officerBtn'); await page.waitForSelector('.of-modal .of-row', { timeout: 10000 });
    check(await noHScroll(page), 'phone: roster without horizontal scroll');
    await page.screenshot({ path: `${outDir}/list-390.png` });
    await page.click('.of-rowmain'); await page.waitForTimeout(400);
    const vis = await page.evaluate(() => { const l = document.querySelector('.of-list'), b = document.querySelector('.of-back'); const v = e => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; return { list: v(l), back: v(b) }; });
    check(!vis.list && vis.back, 'phone: picking an officer shows the detail with a back button', vis);
    await page.screenshot({ path: `${outDir}/profile-390.png` });
    await page.click('[data-a="tab"][data-id="tree"]'); await page.waitForTimeout(400);
    check(await noHScroll(page), 'phone: tree without page-level horizontal scroll');
    await page.screenshot({ path: `${outDir}/tree-390.png` });
    await page.click('.of-back'); await page.waitForTimeout(300);
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.of-list')).display !== 'none'), 'phone: back returns to the roster');
    await ctx.close();
    check(report.errors.length === 0, 'no page errors', report.errors);
    check(report.console.length === 0, 'no console errors', report.console);
  } catch (e) { check(false, 'script error', String(e && e.stack || e)); }
  finally {
    await browser.close(); srv.kill('SIGTERM');
    fs.writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 1));
    const fail = report.checks.filter(c => !c.ok).length;
    console.log(`\n${report.checks.length - fail}/${report.checks.length} passed`);
    process.exit(fail ? 1 : 0);
  }
})();
