// Production build, disposable file storage and synthetic accounts only. No external service is used.
const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { build } = require('esbuild');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const root = process.cwd(), out = path.join(root, 'artifacts/dev11'); fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siderarium-dev1-'));
const accountPassword = crypto.randomBytes(24).toString('base64url'), labPassword = crypto.randomBytes(24).toString('base64url');
function hash(password) { const salt = crypto.randomBytes(16), n = 32768, r = 8, p = 3; const key = crypto.scryptSync(password.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * n * r }); return `scrypt$${n}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`; }
const admin1 = crypto.randomUUID(), admin2 = crypto.randomUUID(), regular = crypto.randomUUID(), t = Date.now();
const records = Object.fromEntries([[admin1, 'lab_admin1'], [admin2, 'lab_admin2'], [regular, 'lab_player']].map(([id, loginId]) => [id, { id, loginId, pwHash: hash(accountPassword), recoveryHash: null, email: null, createdAt: t, lastLogin: null, pwChanged: t }]));
const asset = fs.readdirSync(path.join(root, 'dist/assets')).find(name => /^devCombatLab-[\w-]+\.js$/.test(name));
const workerAsset = fs.readdirSync(path.join(root, 'dist/assets')).find(name => /^combatLabWorker-[\w-]+\.js$/.test(name));
if (!asset || !workerAsset) throw Error('missing protected production assets');
const checks = [], errors = [];
function check(ok, label) { if (!ok) throw Error(label); checks.push(label); console.log('PASS', label); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() { return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); s.on('error', reject); }); }
async function server(configured) {
  const n = await port(), dir = fs.mkdtempSync(path.join(tmp, configured ? 'configured-' : 'missing-'));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: records, sessions: {} }));
  const env = { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production', PORT: String(n), STATIC_DIR: path.join(root, 'dist'), SAVE_FILE: path.join(dir, 'world.json'), WORLD_SEED: '9631', SAVE_INTERVAL_S: '600', ANALYTICS_ADMIN_ACCOUNTS: `${admin1},${admin2}`, ...(configured ? { DEV_COMBAT_LAB_PASSWORD_HASH: hash(labPassword) } : {}) };
  const p = spawn(process.execPath, [path.join(root, 'dist-server/server.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; p.stdout.on('data', d => { output += d; }); p.stderr.on('data', d => { output += d; });
  const url = `http://127.0.0.1:${n}`;
  for (let i = 0; i < 300; i++) { if (p.exitCode !== null) throw Error(`isolated server exited ${p.exitCode}: ${output}`); try { if ((await fetch(`${url}/health`)).ok) return { p, url, dir, output: () => output }; } catch {} await delay(100); }
  p.kill('SIGTERM'); throw Error(`isolated server did not start: ${output}`);
}
async function stop(s) { if (!s || s.p.exitCode !== null) return; s.p.kill('SIGTERM'); await new Promise(resolve => { s.p.once('exit', resolve); setTimeout(() => { s.p.kill('SIGKILL'); resolve(); }, 10000).unref(); }); }
async function login(context, url, id) { const r = await context.request.post(`${url}/api/auth/login`, { headers: { origin: url }, data: { loginId: id, password: accountPassword } }); check(r.status() === 200, `${id}: account login`); }

(async () => {
  let s, browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    s = await server(false);
    let c = await browser.newContext(); await login(c, s.url, 'lab_admin2');
    let response = await c.request.post(`${s.url}/api/dev-combat/login`, { headers: { origin: s.url }, data: { password: labPassword } });
    check(response.status() === 503, 'missing lab password hash rejects even an administrator');
    await c.close(); await stop(s); s = await server(true);
    const anon = await browser.newContext(), anonPage = await anon.newPage();
    await anonPage.goto(`${s.url}/?devskirmish=1`, { waitUntil: 'domcontentloaded' });
    await anonPage.locator('#devAuth').waitFor();
    check(await anonPage.locator('#devId').count() === 1 && await anonPage.locator('.dl').count() === 0, 'direct URL shows authentication to anonymous users');
    check((await anon.request.get(`${s.url}/assets/${asset}`)).status() === 403 && (await anon.request.get(`${s.url}/assets/${workerAsset}`)).status() === 403, 'unauthenticated UI and worker assets are denied');
    check((await anon.request.get(`${s.url}/api/dev-combat/session`)).status() === 401, 'forged client flags do not grant a server session');
    await anonPage.goto(`${s.url}/?skirmish=1`, { waitUntil: 'domcontentloaded' });
    await anonPage.locator('#setup').waitFor(); check(await anonPage.locator('#setup').count() === 1, 'existing public skirmish remains available');
    for (const size of [{width:2560,height:1440},{width:1440,height:900},{width:390,height:844}]) { await anonPage.setViewportSize(size); await anonPage.waitForTimeout(500); await anonPage.screenshot({path:path.join(out, `original-setup-${size.width}.png`),animations:'disabled'}); }
    check((await anonPage.locator('.budget').innerText()).includes('1,700') || (await anonPage.locator('.budget').innerText()).includes('1700'), 'original setup retains the 1700-point budget');
    await anon.close();

    const player = await browser.newContext(); await login(player, s.url, 'lab_player');
    response = await player.request.post(`${s.url}/api/dev-combat/login`, { headers: { origin: s.url }, data: { password: labPassword, admin: true, account: admin1 } });
    check(response.status() === 403, 'non-admin cannot authenticate even with the right password and forged admin data');
    await player.close();

    const limited = await browser.newContext(); await login(limited, s.url, 'lab_admin1');
    response = await limited.request.post(`${s.url}/api/dev-combat/login`, { headers: { origin: 'https://attacker.invalid' }, data: { password: labPassword } });
    check(response.status() === 403, 'cross-origin password request rejected');
    response = await limited.request.post(`${s.url}/api/dev-combat/login`, { data: { password: labPassword } });
    check(response.status() === 403, 'password request without Origin rejected');
    for (let i = 0; i < 5; i++) { response = await limited.request.post(`${s.url}/api/dev-combat/login`, { headers: { origin: s.url }, data: { password: crypto.randomBytes(12).toString('hex') } }); if (response.status() !== 401) throw Error(`wrong password ${i}: ${response.status()}`); }
    response = await limited.request.post(`${s.url}/api/dev-combat/login`, { headers: { origin: s.url }, data: { password: labPassword } });
    check(response.status() === 429, 'repeated incorrect passwords are rate limited'); await limited.close();

    // A new disposable server resets the per-IP failure window; all state is still local.
    await stop(s); s = await server(true);
    const admin = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true }); await login(admin, s.url, 'lab_admin2');
    const page = await admin.newPage(); page.on('pageerror', e => { errors.push(String(e)); console.error('BROWSER PAGE ERROR', e.stack || String(e)); });
    await page.goto(`${s.url}/?devskirmish=1`, { waitUntil: 'domcontentloaded' });
    await page.locator('#devPw').fill(labPassword); await page.locator('#devAuth button[type=submit]').click();
    await page.locator('.lab-setup').waitFor({ timeout: 30000 });
    const cookies = await admin.cookies(), labCookie = cookies.find(cookie => cookie.name === 'siderarium_devcombat');
    check(!!labCookie?.httpOnly && labCookie.sameSite === 'Strict', 'lab grant remains an HttpOnly Strict cookie');
    response = await admin.request.get(`${s.url}/assets/${asset}`);
    check(response.status() === 200 && /no-store/.test(response.headers()['cache-control'] || ''), 'authorized lab code is served with no-store');
    check((await admin.request.get(`${s.url}/assets/${workerAsset}`)).status() === 200, 'authorized worker is available');
    const jsFiles=fs.readdirSync(path.join(root,'dist/assets')).filter(n=>n.endsWith('.js'));
    check(jsFiles.filter(n=>/선택 지휘관 편집|복제 지휘관 배치|개발자 실험용 피팅/.test(fs.readFileSync(path.join(root,'dist/assets',n),'utf8'))).every(n=>n===asset), 'new setup and fitting code remain in the protected lab chunk');
    check(await page.locator('.lab-setup .sbody > .panel').count()===3 && await page.locator('[data-sfit]').count()===1, 'copied three-panel setup shows the default BLUE fleet');
    const hullCount=await page.locator('[data-cat]').count(); check(hullCount===30, 'all 30 usable hulls appear in the copied catalog');
    for (const size of [{width:2560,height:1440},{width:1440,height:900},{width:390,height:844}]) { await page.setViewportSize(size); await page.waitForTimeout(700); await page.screenshot({path:path.join(out,`lab-setup-${size.width}.png`),animations:'disabled'}); }
    check(await page.evaluate(()=>{const x=document.querySelector('.lab-setup');return x.scrollWidth<=x.clientWidth+1}), 'mobile setup has no horizontal page overflow');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('[data-lab-search]').fill('miner');
    check(await page.locator('[data-cat]').count()>0 && await page.locator('[data-cat]').count()<hullCount && await page.evaluate(()=>document.activeElement?.hasAttribute('data-lab-search')), 'catalog search filters and keeps focus');
    await page.locator('[data-lab-search]').fill('');
    await page.locator('[data-team="1"]').click();check((await page.locator('#treeScroll').innerText()).includes('스틸레토급'), 'RED has its independent default fleet');
    await page.locator('[data-team="0"]').click();
    await page.locator('[data-gadd=""]').click();
    await page.locator('[data-gname="1"]').fill('제1전단');await page.locator('[data-gname="1"]').dispatchEvent('change');
    await page.locator('[data-cnew]').click(); await page.locator('[data-cfield="name"]').fill('실험 제독');await page.locator('[data-cfield="name"]').dispatchEvent('change');
    await page.locator('[data-cfield="skill"]').fill('0.9');check(await page.evaluate(()=>document.activeElement?.dataset.cfield==='skill'),'commander editing retains input focus');await page.locator('[data-cfield="skill"]').dispatchEvent('change');
    await page.locator('[data-gorder="1"]').selectOption('hold');await page.locator('[data-gret="1"]').selectOption('0.5');
    await page.locator('[data-gadd="1"]').click();
    await page.locator('[data-cat="patrol_pathfinder"]').click();await page.locator('[data-cat="patrol_pathfinder"] [data-add="5"]').click();
    check((await page.locator('#treeScroll').innerText()).includes('제1전단') && await page.locator('[data-scount="1.0:0"]').inputValue()==='5', 'nested groups and quantity-five ships are edited in the tree');
    await page.locator('[data-sclone="1.0:0"]').click(); check(await page.locator('[data-scount="1.0:1"]').count()===1, 'ship and fitting row can be cloned');
    await page.locator('[data-smv="1.0:1"]').selectOption('@1');check(await page.locator('[data-scount="1:0"]').count()===1, 'ships can move to another group');
    await page.locator('[data-sdel="1:0"]').click();
    await page.locator('[data-gsel="1"]').click(); await page.locator('[data-cclone]').click();await page.locator('[data-gsel="1.0"]').click();await page.locator('[data-cpaste]').click();
    check((await page.locator('[data-gsel="1.0"]').innerText()).includes('실험 제독'), 'a commander can be copied to a different group');
    await page.locator('[data-sfit="0:0"]').click(); await page.locator('.lab-fitmodal .fbox').waitFor();
    check(await page.locator('.lab-fitmodal [data-fcanvas]').count()===1 && await page.locator('.lab-fitmodal .fgrid > .fcol').count()===3, 'copied fitting has the 3D preview and three original columns');
    check(await page.locator('.lab-fitmodal [data-fsel^="hp:"]').count()>0 && await page.locator('.lab-fitmodal [data-fsel^="bay:"]').count()>0, 'hardpoint and internal bay slots are available');
    for (const size of [{width:2560,height:1440},{width:1440,height:900},{width:390,height:844}]) { await page.setViewportSize(size); await page.waitForTimeout(700); await page.screenshot({path:path.join(out,`lab-fitting-${size.width}.png`),animations:'disabled'}); }
    check(await page.evaluate(()=>{const r=document.querySelector('.lab-fitmodal .fbox').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1}), 'mobile fitting window remains within the viewport');
    check(await page.evaluate(()=>{const cols=[...document.querySelectorAll('.lab-fitmodal .fcol')].map(e=>e.getBoundingClientRect()),grid=document.querySelector('.lab-fitmodal .fgrid');return cols.every((r,i)=>i===0||cols[i-1].bottom<=r.top+1)&&grid.scrollWidth<=grid.clientWidth+1;}),'mobile fitting columns do not overlap or overflow horizontally');
    await page.setViewportSize({width:1440,height:900});
    await page.locator('.lab-fitmodal [data-fsel^="hp:"]').first().click();
    check(await page.locator('.lab-fitmodal [data-fpick]').count()>1, 'compatible weapons appear as selectable equipment cards');
    await page.locator('[data-fq]').fill('포');check(await page.evaluate(()=>document.activeElement?.hasAttribute('data-fq')), 'equipment search retains input focus');await page.locator('[data-fq]').fill('');
    await page.locator('[data-ffilt="module"]').click();check(await page.locator('[data-fpick]').count()>1, 'equipment type filter works');
    await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().click();check(await page.locator('[data-fpick]').count()>1, 'bay selection shows compatible internal equipment');
    const before=await page.locator('.lab-fitmodal .fstat').innerText();
    await page.locator('[data-fpick="mod_engine"]').click();
    check((await page.locator('.lab-fitmodal .fstat').innerText())!==before, 'fitting preview compares actual before and after statistics');
    await page.locator('.lab-fitmodal [data-fclose]').last().click();await page.locator('[data-sfit="0:0"]').click();check((await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().innerText()).includes('비어 있음'),'cancel does not apply the draft');
    await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().click();await page.locator('[data-fpick="mod_engine"]').click();
    await page.locator('[data-fsavep]').click();check((await page.locator('.lab-fitmodal').innerText()).includes('실험 프리셋'), 'experiment preset can be stored independently');
    await page.locator('[data-fundo]').click();await page.locator('[data-fapply]').click();
    await page.locator('[data-sfit="0:0"]').click();check(!(await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().innerText()).includes('추진'), 'undo and apply retain the earlier fitting');
    await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().click();await page.locator('[data-fpick="mod_engine"]').click();await page.locator('[data-fcopy]').click();await page.locator('[data-fapply]').click();
    await page.locator('[data-sfit="1.0:0"]').click();await page.locator('[data-fpaste]').click();check(!(await page.locator('[data-fapply]').isDisabled()), 'compatible copied fitting can be applied to another ship');await page.locator('[data-fapply]').click();
    await page.locator('[data-lab-controls]').click();
    const save=page.waitForEvent('download');await page.locator('[data-export]').click();const setupFile=path.join(tmp,'setup.json');await(await save).saveAs(setupFile);const saved=JSON.parse(fs.readFileSync(setupFile,'utf8'));
    check(saved.schema==='siderarium-combat-lab-2' && saved.sides[0].root.children[1].commander.skill===.9 && saved.sides[0].root.children[1].children[0].ships[0].count===5 && saved.presets.length, 'JSON export preserves nested commanders, quantity, fittings and presets');
    await page.locator('[data-close-controls]').click();await page.locator('[data-copy-team="0"]').click();await page.locator('[data-team="1"]').click();await page.locator('[data-scount="0:0"]').fill('2');await page.locator('[data-scount="0:0"]').dispatchEvent('change');await page.locator('[data-team="0"]').click();check(await page.locator('[data-scount="0:0"]').inputValue()==='1','copied BLUE and RED fleets remain independent');await page.locator('[data-swap-team]').click();await page.locator('[data-team="0"]').click();check(await page.locator('[data-scount="0:0"]').inputValue()==='2','side swap exchanges the edited fleets');await page.locator('[data-lab-controls]').click();
    await page.locator('[data-default]').click(); await page.locator('[data-import]').setInputFiles(setupFile);await page.waitForFunction(()=>document.querySelector('#dlProgress')?.textContent?.includes('가져왔습니다'));
    check(true,'v2 settings import succeeds');
    await page.locator('[data-import]').setInputFiles(path.join(root,'artifacts/dev1/default-experiment.json'));await page.waitForFunction(()=>document.querySelector('.dl-notice')?.textContent?.includes('가져오기 실패'));
    check(true,'result JSON is rejected as a fleet settings file');
    const old=JSON.parse(fs.readFileSync(path.join(root,'artifacts/dev1/default-experiment.json'),'utf8')).config;const oldFile=path.join(tmp,'legacy.json');fs.writeFileSync(oldFile,JSON.stringify(old));
    await page.locator('[data-import]').setInputFiles(oldFile);await page.waitForFunction(()=>document.querySelector('#dlProgress')?.textContent?.includes('가져왔습니다'));
    check(true,'DEV-1 flat settings import migrates successfully');
    await page.locator('[data-condition="timeLimit"]').fill('10');await page.locator('[data-condition="timeLimit"]').dispatchEvent('change');await page.locator('[data-condition="speed"]').selectOption('4');
    await page.locator('[data-run="10"]').click();await page.waitForFunction(()=>document.querySelector('#dlProgress')?.textContent?.includes('20회 완료'),null,{timeout:180000});
    check((await page.locator('.dl-summary').innerText()).includes('20회 완료'),'worker executes paired experiments and displays results');
    await page.locator('[data-run="1000"]').click();await page.locator('[data-cancel]').click();check((await page.locator('#dlProgress').innerText()).includes('취소'),'long worker experiment cancels');
    await page.locator('[data-replay="0"]').click();await page.locator('#topbar').waitFor({timeout:30000});
    await page.locator('[data-sp="0"]').click();await page.waitForFunction(()=>document.querySelector('#clock')?.textContent?.includes('일시정지'));
    check(await page.locator('.dl-battle-back').count()===1,'recorded seed opens the real battle HUD with pause');await page.setViewportSize({width:720,height:540});await page.locator('[data-sp="4"]').click();await page.locator('[data-a="restart"]').waitFor({timeout:60000});await page.locator('[data-a="restart"]').click();await page.locator('[data-a="replay"]').waitFor({timeout:60000});await page.locator('[data-a="replay"]').click();await page.locator('#topbar').waitFor();check(true,'same-condition restart and replay use the real battle engine');await page.locator('.dl-battle-back').click();
    // Stop the lab renderer before opening an isolated local single-player world.
    await page.goto('about:blank');
    // Compare the unmodified in-game fitting screen in an isolated local single-player world.
    const fixtureFile=path.join(tmp,'fixture.mjs');await build({entryPoints:['tests/support/integration.ts'],bundle:true,platform:'node',format:'esm',outfile:fixtureFile,logLevel:'silent'});
    const {integrationFixture}=await import(pathToFileURL(fixtureFile).href),f=integrationFixture(981),ship=f.find('patrol_pathfinder');f.sim.dockShip(ship,f.factory);const snapshot=f.server.snapshotFile();
    const game=await browser.newContext({viewport:{width:1440,height:900}}),gamePage=await game.newPage();gamePage.on('pageerror',e=>errors.push('game: '+String(e)));
    await gamePage.addInitScript(({snapshot})=>{localStorage.setItem('siderarium.sp.v1',JSON.stringify(snapshot));localStorage.setItem('siderarium.sp.token','integration');},{snapshot});
    await gamePage.goto(`${s.url}/?sp=continue&name=통합산업`,{waitUntil:'domcontentloaded',timeout:60000});await gamePage.waitForFunction(p=>window.siderarium?.client?.company===p&&window.siderarium?.hud,f.p,{timeout:60000});
    await gamePage.evaluate(id=>{window.siderarium.client.setSpeed(0);window.siderarium.hud.openFitting(id);},ship.id);await gamePage.locator('.fitmodal .fbox').waitFor();
    for(const size of [{width:2560,height:1440},{width:1440,height:900},{width:390,height:844}]){await gamePage.setViewportSize(size);await gamePage.waitForTimeout(700);await gamePage.screenshot({path:path.join(out,`original-fitting-${size.width}.png`),animations:'disabled'});}
    check(await gamePage.locator('.fitmodal [data-fcanvas]').count()===1 && await gamePage.locator('.fitmodal .fgrid > .fcol').count()===3,'unmodified in-game fitting still opens with its original layout');await game.close();
    if(errors.length)console.error('BROWSER ERRORS',JSON.stringify(errors));check(errors.length===0,'browser emitted no runtime errors');
    const health=await(await fetch(`${s.url}/health`)).json();check(health.players===0,'lab did not create a persistent PMC session');
    await admin.request.post(`${s.url}/api/dev-combat/logout`,{headers:{origin:s.url},data:{}});await page.goto(`${s.url}/?devskirmish=1`,{waitUntil:'domcontentloaded'});await page.locator('#devAuth').waitFor();check((await admin.request.get(`${s.url}/api/dev-combat/session`)).status()===401&&(await admin.request.get(`${s.url}/assets/${asset}`)).status()===403,'logout revokes the grant and protected code access');
    await admin.close();await stop(s);
    const world=fs.readFileSync(path.join(s.dir,'world.json'),'utf8'),accounts=fs.readFileSync(path.join(s.dir,'accounts.json'),'utf8');check(!world.includes(labPassword)&&!accounts.includes(labPassword)&&!s.output().includes(labPassword)&&!world.includes(labCookie.value)&&!accounts.includes(labCookie.value),'credentials are absent from saves and logs');
    fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify({checks,errors,hullCount},null,2)+'\n');
  } finally { await browser?.close(); await stop(s); fs.rmSync(tmp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
