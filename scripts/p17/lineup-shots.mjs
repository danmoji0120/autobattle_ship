// P17.3 visual check: hull lineup screenshots (needs `npx vite --port 5191` running). docs/P17_3_ARSENAL.md
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.env.BASE ?? 'http://localhost:5191/';
const out = process.argv[2] ?? 'docs/p17_3_shots';
const shots = (process.env.SHOTS ?? 'all').split(',');
const list = [
  ['lineup_all', '?lineup=p17&view=three'],
  ['lineup_top', '?lineup=p17&view=top&nolabel'],
  ['lineup_small', '?lineup=p17&cls=corvette,frigate,destroyer&view=three'],
  ['lineup_medium', '?lineup=p17&cls=light_cruiser,cruiser&view=three'],
  ['lineup_large', '?lineup=p17&cls=battlecruiser,battleship&view=three'],
  ['lineup_xl', '?lineup=p17&cls=dreadnought,carrier&view=three'],
  ['lineup_hostile', '?lineup=p17&cls=battlecruiser,battleship&view=three&team=1'],
  // close-ups by size class (S / M / L / XL) and turret / engine placement (side and top views)
  ['close_S', '?lineup=p17&ids=p17_cv_hornet,p17_ff_lantern,p17_cv_relic&view=three&dist=0.85'],
  ['close_M', '?lineup=p17&ids=p17_dd_hammerhead,p17_cl_longbow&view=three&dist=0.85'],
  ['close_L', '?lineup=p17&ids=p17_ca_swarm,p17_bc_falchion&view=three&dist=0.85'],
  ['close_XL', '?lineup=p17&ids=p17_bb_bastion,p17_dn_citadel&view=three&dist=0.85'],
  ['placement_side', '?lineup=p17&ids=p17_ca_hydra,p17_bb_solaris&view=side&dist=0.9'],
  ['placement_top', '?lineup=p17&ids=p17_dd_spindle,p17_bc_corsair,p17_dn_leviathan&view=top&dist=0.9'],
];
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
pg.on('pageerror', e => console.log('pageerror', e.message));
for (const [name, q] of list) {
  if (shots[0] !== 'all' && !shots.includes(name)) continue;
  await pg.goto(base + q);
  await pg.waitForFunction(() => window.__lineup?.n > 0, null, { timeout: 60000 });
  await pg.waitForTimeout(1500);
  await pg.screenshot({ path: `${out}/${name}.png` });
  console.log(name, await pg.evaluate(() => window.__lineup.n));
}
await b.close();
