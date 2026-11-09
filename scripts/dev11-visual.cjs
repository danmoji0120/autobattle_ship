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
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    s=await server(true); const ctx=await browser.newContext({viewport:{width:1440,height:900}});await login(ctx,s.url,'lab_admin2');
    const auth=await ctx.request.post(`${s.url}/api/dev-combat/login`,{headers:{origin:s.url},data:{password:labPassword}});check(auth.status()===200,'isolated lab session for additional visual checks');
    const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));await page.goto(`${s.url}/?devskirmish=1`,{waitUntil:'domcontentloaded'});await page.locator('.lab-setup').waitFor({timeout:30000});
    await page.locator('[data-gadd=""]').click();await page.locator('[data-gname="1"]').fill('제1전단');await page.locator('[data-gname="1"]').dispatchEvent('change');await page.locator('[data-gadd="1"]').click();
    await page.locator('[data-cat="patrol_pathfinder"]').click();await page.locator('[data-cat="patrol_pathfinder"] [data-add="5"]').click();
    const options=await page.locator('[data-gmove="1"] option').evaluateAll(es=>es.map(e=>e.value));
    check(options.includes('@')&&!options.includes('@1')&&!options.includes('@1.0'),'moving a group cannot target itself or its descendants');
    await page.screenshot({path:path.join(out,'lab-hierarchy-1440.png'),animations:'disabled'});
    await page.locator('[data-sfit="0:0"]').click();await page.locator('.lab-fitmodal').waitFor();
    const canvas=page.locator('.lab-fitmodal [data-fcanvas]'),rect=await canvas.boundingBox();
    // Freeze auto-rotation, then locate the visible green PD marker in the rendered pixels.
    await page.mouse.click(rect.x+20,rect.y+20);const imageData=(await canvas.screenshot()).toString('base64');
    const marker=await page.evaluate(async raw=>{const img=new Image();img.src=`data:image/png;base64,${raw}`;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,c.width,c.height).data;let sx=0,sy=0,n=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4,r=data[i],g=data[i+1],b=data[i+2];if(g>110&&r>35&&b>45&&g>r*1.35&&g>b*1.12){sx+=x;sy+=y;n++;}}return {x:sx/n/c.width,y:sy/n/c.height,n};},imageData);
    check(marker.n>20,'a hardpoint marker is visible in the rendered preview');
    await page.mouse.click(rect.x+marker.x*rect.width,rect.y+marker.y*rect.height);
    check((await page.locator('[data-fsel="hp:pd1"]').getAttribute('class')).split(' ').includes('on'),'clicking the 3D marker selects its actual hardpoint');
    await page.mouse.move(rect.x+20,rect.y+20);await page.mouse.down();const beforeDrag=await canvas.screenshot();await page.mouse.move(rect.x+170,rect.y+70,{steps:8});await page.mouse.up();await page.waitForTimeout(300);const afterDrag=await canvas.screenshot();check(!beforeDrag.equals(afterDrag),'dragging the preview rotates the rendered ship');
    await page.locator('.lab-fitmodal [data-fsel^="hp:"]').first().click();await page.locator('[data-ffilt="all"]').click();await page.locator('[data-fpick="mod_engine"]').click();
    check((await page.locator('.lab-fitmodal .fchg').innerText()).trim().length>0 && await page.locator('.lab-fitmodal .fchg .warn').count()>0,'incompatible equipment is rejected with a visible reason');
    const variants=await page.locator('[data-fvar] option').evaluateAll(es=>es.map(e=>e.value)),before=await page.locator('[data-fvar]').inputValue();
    if(variants.length<2)throw Error('fixture hull must have a variant');await page.locator('[data-fvar]').selectOption(variants.find(x=>x!==before));check(await page.locator('[data-fvar]').inputValue()!==before,'variant change updates the fitting layout');await page.locator('[data-fundo]').click();
    await page.locator('.lab-fitmodal [data-fsel^="bay:"]').first().click();await page.locator('[data-fpick="mod_engine"]').click();await page.locator('[data-fsavep]').click();check(await page.locator('[data-fdelp]').count()===1,'experimental preset is available');await page.locator('[data-fdelp]').click();check(await page.locator('[data-fdelp]').count()===0,'experimental preset can be deleted');
    await page.setViewportSize({width:390,height:844});await page.locator('.lab-fitmodal .fmid').scrollIntoViewIfNeeded();await page.waitForTimeout(300);await page.screenshot({path:path.join(out,'lab-fitting-slots-390.png'),animations:'disabled'});
    await page.locator('[data-fq]').scrollIntoViewIfNeeded();await page.locator('[data-fq]').fill('추진');check(await page.evaluate(()=>document.activeElement?.hasAttribute('data-fq')),'mobile equipment search stays focused');
    check(await page.evaluate(()=>{const r=document.querySelector('[data-fq]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}),'mobile equipment search is visible inside the viewport');
    await page.screenshot({path:path.join(out,'lab-fitting-catalog-390.png'),animations:'disabled'});
    check(errors.length===0,'additional visual flow emitted no runtime errors');
    fs.writeFileSync(path.join(out,'browser-extra-results.json'),JSON.stringify({checks,errors},null,2)+'\n');await ctx.close();
  } finally { await browser?.close();await stop(s);fs.rmSync(tmp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
