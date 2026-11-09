// Production build, disposable file storage and synthetic accounts only. No external service is used.
const { chromium } = require('playwright');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = process.cwd(), out = path.join(root, 'artifacts/dev1'); fs.mkdirSync(out, { recursive: true });
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
    const admin = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await login(admin, s.url, 'lab_admin2');
    const page = await admin.newPage(); page.on('pageerror', e => { errors.push(String(e)); console.error('BROWSER PAGE ERROR', e.stack || String(e)); });
    await page.goto(`${s.url}/?devskirmish=1`, { waitUntil: 'domcontentloaded' });
    await page.locator('#devPw').fill(labPassword); await page.locator('#devAuth button[type=submit]').click();
    await page.locator('.dl h1').waitFor({ timeout: 30000 });
    const cookies = await admin.cookies(); const labCookie = cookies.find(cookie => cookie.name === 'siderarium_devcombat');
    check(!!labCookie?.httpOnly && labCookie.sameSite === 'Strict', 'lab grant is an HttpOnly Strict cookie');
    response = await admin.request.get(`${s.url}/assets/${asset}`);
    check(response.status() === 200 && /no-store/.test(response.headers()['cache-control'] || ''), 'authorized lab code is served with no-store');
    check((await admin.request.get(`${s.url}/assets/${workerAsset}`)).status() === 200, 'authorized worker is available');
    check(await page.locator('[data-pick]').count() === 2 && (await page.locator('.dl').innerText()).includes('길잡이급') && (await page.locator('.dl').innerText()).includes('스틸레토급'), 'default fleets appear in the production UI');
    const hullCount = await page.locator('[data-hull="0"] option').count();
    check(hullCount >= 30 && !(await page.locator('[data-hull="0"]').innerText()).includes('modeltest'), 'searchable usable hull catalog excludes development fixtures');
    await page.screenshot({ path: path.join(out, 'setup-1440.png'), animations: 'disabled' });
    await page.locator('.dl-side.blue summary').click(); await page.locator('[data-research="0:combined_arms"]').check();
    check(await page.locator('.dl-side.blue details').evaluate(d => d.open), 'research settings remain open while changing bonuses');
    await page.locator('[data-research="0:combined_arms"]').uncheck();
    check(await page.locator('[data-slot="hp:main1"] option').count() > 10 && await page.locator('[data-slot="bay:bay1"] option').count() > 5, 'weapon and internal-equipment catalogs are selectable');
    const saveSetup = page.waitForEvent('download'); await page.locator('[data-export]').click(); const setupDownload = await saveSetup;
    const setupFile = path.join(tmp, 'setup.json'); await setupDownload.saveAs(setupFile); const savedSetup = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
    check(savedSetup.sides[0].ships[0].hull === 'patrol_pathfinder' && !!savedSetup.content.fingerprint, 'settings JSON contains the fleets and content identity');
    await page.locator('[data-swap]').click();
    check((await page.locator('.dl-side.blue').innerText()).includes('스틸레토급') && (await page.locator('.dl-side.red').innerText()).includes('길잡이급'), 'swapping exchanges different fleets');
    const swappedDownload = page.waitForEvent('download'); await page.locator('[data-export]').click(); const swappedFile = path.join(tmp, 'swapped.json'); await (await swappedDownload).saveAs(swappedFile);
    const swappedSetup = JSON.parse(fs.readFileSync(swappedFile, 'utf8'));
    check(swappedSetup.sides[0].name === 'BLUE' && swappedSetup.sides[1].name === 'RED', 'swapped fleets retain their new side labels');
    await page.locator('[data-swap]').click();
    await page.locator('[data-duplicate="0:blue-1"]').click(); await page.locator('[data-row="count"]').fill('2'); await page.locator('[data-row="count"]').dispatchEvent('change');
    check((await page.locator('.dl-side.blue').innerText()).includes('×2') && await page.locator('.dl-side.blue [data-pick]').count() === 2, 'fleet entries can be duplicated and given quantities');
    await page.locator('[data-copy="0"]').click();
    check(await page.locator('.dl-side.red [data-pick]').count() === 2, 'either side can be copied to the other');
    await page.locator('[data-swap]').click();
    check(await page.locator('.dl-side.blue [data-pick]').count() === 2, 'fleet sides can be swapped');
    await page.locator('[data-import]').setInputFiles(setupFile);
    await page.waitForFunction(() => document.querySelector('#dlProgress')?.textContent?.includes('가져왔습니다'));
    check(await page.locator('[data-pick]').count() === 2 && (await page.locator('.dl-side.red').innerText()).includes('스틸레토급'), 'settings JSON restores the original fleet');
    await page.locator('[data-pick="1:red-1"]').click();
    await page.locator('[data-slot="hp:hp01"]').scrollIntoViewIfNeeded(); await page.locator('[data-slot="hp:hp01"]').focus();
    const scrollBefore = await page.locator('.dl').evaluate(e => e.scrollTop);
    await page.locator('[data-slot="hp:hp01"]').selectOption('eq_autocannon');
    check(Math.abs(await page.locator('.dl').evaluate(e => e.scrollTop) - scrollBefore) < 5, 'fitting edits preserve the panel scroll position');
    check(await page.evaluate(() => document.activeElement?.dataset.slot === 'hp:hp01'), 'fitting edits retain keyboard focus');
    check(await page.locator('[data-watch]').isDisabled() && (await page.locator('.dl-errors').first().innerText()).length > 0, 'invalid hardpoint fitting blocks battle with a reason');
    await page.locator('[data-slot="hp:hp01"]').selectOption('eq_torpedo');
    check(!await page.locator('[data-watch]').isDisabled(), 'correcting the fitting enables battle');
    await page.locator('[data-condition="timeLimit"]').fill('10'); await page.locator('[data-condition="timeLimit"]').dispatchEvent('change');
    await page.locator('[data-condition="speed"]').selectOption('4');
    await page.locator('[data-watch]').click(); await page.locator('#topbar').waitFor({ timeout: 30000 });
    await page.waitForFunction(() => { const text = document.querySelector('#clock')?.firstChild?.textContent || ''; return /^\d+:(?:0[1-9]|[1-5]\d)/.test(text); }, null, { timeout: 45000 });
    check(true, 'real rendered battle advances the simulation');
    await page.locator('.node.enemyn').first().click(); check(await page.locator('.node.enemyn.sel').count() === 1, 'either side can be selected for inspection');
    await page.locator('[data-sp="0"]').click();
    await page.waitForFunction(() => document.querySelector('#clock')?.textContent?.includes('일시정지'), null, { timeout: 10000 });
    check((await page.locator('#clock').innerText()).includes('일시정지'), 'real battle HUD supports pausing');
    await page.screenshot({ path: path.join(out, 'battle-1440.png'), animations: 'disabled' });
    // SwiftShader is CPU-bound at 1440px; reduce only the rendering viewport for the two 10-second replays.
    await page.setViewportSize({ width: 720, height: 540 });
    await page.locator('[data-sp="4"]').click(); await page.locator('[data-a="restart"]').waitFor({ timeout: 60000 });
    await page.locator('[data-a="restart"]').click();
    await page.locator('[data-a="replay"]').waitFor({ timeout: 60000 }).catch(async e => { console.log('DIAGNOSTIC restarted battle clock:', await page.locator('#clock').innerText().catch(() => 'not visible')); throw e; });
    await page.locator('[data-a="replay"]').click(); await page.locator('#topbar').waitFor();
    check(await page.locator('.dl-battle-back').count() === 1, 'same-condition restart and replay use the real battle HUD');
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => { const b = document.querySelector('[data-sp="4"]').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }), 'mobile battle speed controls remain in the viewport');
    await delay(1500); // let the renderer complete a frame after resizing its buffers
    await page.screenshot({ path: path.join(out, 'battle-390.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('.dl-battle-back').click(); await page.locator('[data-run="10"]').click();
    await page.waitForFunction(() => document.querySelector('#dlProgress')?.textContent?.includes('20회 완료'), null, { timeout: 180000 });
    check((await page.locator('.dl-summary').innerText()).includes('20회 완료'), 'worker finishes paired-seed battles and displays the real report');
    const save = page.waitForEvent('download'); await page.locator('[data-export-result]').click(); const download = await save;
    const target = path.join(tmp, 'result.json'); await download.saveAs(target); const results = JSON.parse(fs.readFileSync(target, 'utf8'));
    check(results.battles.length === 20 && results.battles.filter(b => b.swapped).length === 10 && results.summary.total === 20, 'results JSON contains each seed and both placements');
    await page.locator('[data-run="1000"]').click(); await page.locator('[data-cancel]').click();
    check((await page.locator('#dlProgress').innerText()).includes('취소'), 'long worker experiments can be cancelled');
    await page.locator('[data-replay="0"]').click(); await page.locator('#topbar').waitFor();
    check(await page.locator('.dl-battle-back').count() === 1, 'a selected recorded seed can be reproduced');
    await page.locator('.dl-battle-back').click();
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(out, 'setup-390.png'), animations: 'disabled' });
    check(await page.evaluate(() => { const x = document.querySelector('.dl'); return x.scrollWidth <= x.clientWidth + 1; }), 'mobile experiment screen fits horizontally');
    check(await page.evaluate(() => { const r = document.querySelector('[data-add="0"]').getBoundingClientRect(); return r.width >= 65 && r.height <= 48; }), 'mobile add-ship button remains readable');
    if (errors.length) console.error('BROWSER ERRORS', JSON.stringify(errors));
    check(errors.length === 0, 'browser emitted no runtime errors');
    const health = await (await fetch(`${s.url}/health`)).json(); check(health.players === 0, 'lab did not create a game connection or PMC session');
    await page.locator('[data-logout]').click(); await page.locator('#devAuth').waitFor();
    check((await admin.request.get(`${s.url}/api/dev-combat/session`)).status() === 401 && (await admin.request.get(`${s.url}/assets/${asset}`)).status() === 403, 'logout revokes the grant and protected code access');
    await admin.close(); await stop(s);
    const snapshot = fs.readFileSync(path.join(s.dir, 'world.json'), 'utf8'), accountFile = fs.readFileSync(path.join(s.dir, 'accounts.json'), 'utf8');
    check(!snapshot.includes(labPassword) && !accountFile.includes(labPassword) && !s.output().includes(labPassword) && !snapshot.includes(labCookie.value) && !accountFile.includes(labCookie.value), 'lab password and access token are absent from saves and logs');
    fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify({ checks, errors, hullCount, workerBattles: results.summary.total }, null, 2) + '\n');
  } finally { await browser?.close(); await stop(s); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
