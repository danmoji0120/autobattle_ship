// P16.6 — a real browser (the shipped client in dist/, headless Chromium) signs in with an existing account cookie,
// enters the shared world and opens a live world battle (BattleLink, the same path as the HUD's "전투 관전" button).
// It samples the browser's battle tick against the server's engagement tick, and checks that the browser's
// re-simulated state is the same as a lockstep re-simulation of the server's stream at the same tick.
import { createRequire } from 'node:module';
import { World } from '../../../src/sim/world';
import type { Pilot, Server } from './harness';

const require = createRequire(import.meta.url);

export async function browserSpectate(srv: Server, viewer: Pilot, ref: Pilot, eng: string, shotPath?: string) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
  const errors: string[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const [name, value] = viewer.cookie.split('=');
    await ctx.addCookies([{ name, value, url: srv.base }]);
    const page = await ctx.newPage(); page.setDefaultTimeout(60000);
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(srv.base + '/');
    await page.waitForFunction(() => { const b = document.getElementById('mpJoin') as HTMLButtonElement | null; return b && !b.disabled && /접속/.test(b.textContent ?? ''); });
    await page.click('#mpJoin');
    await page.waitForFunction(() => !!(window as any).siderarium?.hud);
    await page.evaluate((e: string) => (window as any).siderarium.hud.opts.onOpenBattle(e), eng);
    await page.waitForFunction(() => { const s = (window as any).__battle; return s && s.world && s.world.tick > 0; });
    // pacing: browser tick vs the server's engagement tick (snapshot of a party, sampled at the same moment)
    const lag: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 750));
      const server = ref.snap().engagements?.[eng]?.tick as number | undefined;
      const local = await page.evaluate(() => (window as any).__battle.world.tick as number);
      if (server !== undefined) lag.push(server - local);
    }
    // determinism: read tick + digest in one synchronous call, re-simulate the server's stream to that tick
    const b = await page.evaluate(() => { const s = (window as any).__battle; return { tick: s.world.tick as number, digest: s.world.digest() as string, rules: s.world.rules as number, craft: !!s.world.craft }; });
    const bi = ref.binits.get(eng)!;
    const w = new World(structuredClone(bi.setup)); w.scheduleReplay(structuredClone(bi.orders));
    while (w.tick < b.tick && !w.outcome) w.step();
    if (shotPath) await page.screenshot({ path: shotPath });
    return { lag, browser: b, serverDigestAtTick: w.digest(), same: w.digest() === b.digest, errors };
  } finally { await browser.close(); }
}
