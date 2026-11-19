// P17.3 visual check: combat screenshots of the new mechanisms (needs `npx vite --port 5191` running).
//   node scripts/p17/combat-shots.mjs [outDir]     SHOTS=container,arc,charge,normal
// The page builds a battle through window.fleetcmd, a hook after every World.step pauses the session when the
// wanted moment happens (container launch → split → intercept → hit, …), the camera is moved there and a frame
// is taken. Rendering only — the battle itself is the ordinary deterministic sim. docs/P17_3_ARSENAL.md
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.env.BASE ?? 'http://localhost:5191/';
const out = process.argv[2] ?? 'docs/p17_3_shots';
const want = (process.env.SHOTS ?? 'container,arc,charge,normal').split(',');

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pg = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
pg.on('pageerror', e => console.log('pageerror', e.message));

/** start a battle: `a` / `b` are [classId, loadoutId, weapon|null, pd|null][]; stages are page-side predicates */
async function battle(a, bb, seed, stages) {
  await pg.goto(base + '?manual');
  await pg.waitForFunction(() => window.fleetcmd, null, { timeout: 60000 });
  await pg.evaluate(async ({ a, bb, seed, stages }) => {
    const { getLoadout } = await import('/src/sim/data/ships.ts');
    const { WEAPONS } = await import('/src/sim/data/weapons.ts');
    await import('/src/content/registry.ts');
    const { shipLoadout } = await import('/src/world/fitting.ts');
    const { CONTENT } = await import('/src/content/registry.ts');
    const ship = (row) => {
      // P17.3.1: { p17: hullId } — a P17 hull with its preset fitting (its own mesh, spinal mounts included)
      if (row.p17) {
        const h = CONTENT.hulls[row.p17], pr = Object.values(CONTENT.presets).find(p => p.hull === row.p17);
        const loadoutId = getLoadout(h.classId, 'std') ? 'std' : undefined;
        const lo = shipLoadout({ classId: h.classId, loadoutId, variant: pr.variant, fitting: { hp: pr.weapons, bay: {} } });
        return { classId: h.classId, loadoutId, fit: { name: 'p17', mounts: lo.mounts, mesh: lo.mesh } };
      }
      const [c, l, w, pd] = row;
      const lo = getLoadout(c, l);
      const mounts = lo.mounts.map(m => ({ ...m, weapon: WEAPONS[m.weapon].kind === 'pd' ? (pd ?? m.weapon) : (w ?? m.weapon) }));
      return { classId: c, loadoutId: l, fit: { name: 'p17', mounts } };
    };
    const G = (ships, order) => ({ name: 'g', commanderId: 'wolf', order, retreatAt: 0, ships: ships.map(ship), children: [] });
    window.fleetcmd.startBattle({ seed, scenarioId: 'p173shots', rules: 2, fleets: [{ name: 'A', root: G(a, 'engage') }, { name: 'B', root: G(bb, 'engage') }] });
    const s = window.fleetcmd.session, w = s.world;
    s.view.rig.setMode('tactical');
    // stage predicates arrive as source text: (w, e, st) => focus point | null
    const preds = stages.map(src => (0, eval)(src));
    const st = { i: 0, mark: {} };
    window.__shot = null;
    const step = w.step.bind(w);
    w.step = () => {
      step();
      if (window.__shot || st.i >= preds.length) return;
      const f = preds[st.i](w, w.events, st.mark);
      if (f) { s.paused = true; window.__shot = { i: st.i, f, t: w.time }; st.i++; }
    };
    window.__resume = () => { window.__shot = null; s.paused = false; };
    s.start();
  }, { a, bb, seed, stages: stages.map(x => x.pred) });
  for (const stg of stages) {
    await pg.waitForFunction(() => window.__shot, null, { timeout: 240000 });
    const sh = await pg.evaluate(({ dist, pitch, yaw }) => {
      const r = window.fleetcmd.session.view.rig, f = window.__shot.f;
      r.focus.set(f.x, f.y ?? 0, f.z); r.dist = dist; if (pitch != null) r.pitch = pitch; if (yaw != null) r.yaw = yaw;
      // snap (the rig eases over real time, and paused effects fade while it eases)
      r.cur.focus.copy(r.focus); r.cur.dist = r.dist; r.cur.pitch = r.pitch; r.cur.yaw = r.yaw;
      return window.__shot;
    }, { dist: stg.dist, pitch: stg.pitch, yaw: stg.yaw });
    await pg.waitForTimeout(stg.settle ?? 500);   // a couple of frames at the new camera; the pause keeps the moment
    await pg.screenshot({ path: `${out}/${stg.name}.png` });
    console.log(stg.name, 't=' + sh.t.toFixed(2), JSON.stringify(sh.f));
    await pg.evaluate(() => window.__resume());
  }
}

const P = String.raw;
if (want.includes('container')) {
  // a destroyer of container launchers against a frigate screen with point defence
  await battle([['destroyer', 'aa', 'swarm_box', null], ['destroyer', 'aa', 'swarm_box', null]],
    [['frigate', 'aa', null, null], ['frigate', 'aa', null, null], ['frigate', 'aa', null, null], ['cruiser', 'aa', null, null]], 11, [
      { name: 'container_1_launch', dist: 170, pitch: 0.55, pred: P`(w, ev, m) => { for (const e of ev) if (e.t === 'fire' && e.weapon === 'swarm_box' && m.t0 == null) m.t0 = w.time;
          if (m.t0 == null || w.time < m.t0 + 1.6) return null; const x = w.munitions.find(u => u.weapon.id === 'swarm_box'); return x ? { x: x.pos.x, y: x.pos.y, z: x.pos.z } : null; }` },
      { name: 'container_2_split', dist: 200, pitch: 0.5, pred: P`(w, ev, m) => { for (const e of ev) if (e.t === 'split' && !m.s) m.s = { t: w.time, p: e.pos };
          if (!m.s || w.time < m.s.t + 0.35) return null; return m.s.p; }` },
      { name: 'container_3_intercept', dist: 240, pitch: 0.5, pred: P`(w, ev) => { for (const e of ev) if (e.t === 'intercept' || (e.t === 'flak')) {
          if (w.munitions.some(u => u.sub !== undefined && Math.hypot(u.pos.x - e.pos.x, u.pos.z - e.pos.z) < 500)) return e.pos; } return null; }` },
      { name: 'container_4_hit', dist: 200, pitch: 0.5, pred: P`(w, ev) => { const h = ev.filter(e => e.t === 'hit' && e.weapon === 'swarm_dart'); return h.length >= 2 ? h[0].pos : null; }` },
    ]);
}
if (want.includes('arc')) {
  // chain arc into a corvette swarm (arc jumps between close hulls)
  await battle([['cruiser', 'aa', 'arc_projector', null]],
    [['corvette', 'gun', null, null], ['corvette', 'gun', null, null], ['corvette', 'gun', null, null], ['corvette', 'gun', null, null], ['corvette', 'gun', null, null]], 5, [
      { name: 'special_arc_chain', dist: 380, pitch: 0.6, pred: P`(w, ev) => { const c = ev.filter(e => e.t === 'chain'); return c.length >= 2 ? c[0].to : null; }` },
    ]);
}
if (want.includes('charge')) {
  // charge lance: the glow while it charges, then the shot
  await battle([['battleship', 'std', 'charge_lance', null]], [['battleship', 'std', null, null]], 3, [
    { name: 'special_charge_glow', dist: 170, pitch: 0.45, pred: P`(w, ev, m) => { for (const e of ev) if (e.t === 'charge' && !m.c) m.c = { t: w.time, s: e.ship, d: e.dur };
        if (!m.c || w.time < m.c.t + m.c.d * 0.7) return null; const s = w.ships.find(x => x.id === m.c.s); return s ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : null; }` },
    { name: 'special_charge_hit', dist: 260, pitch: 0.45, pred: P`(w, ev) => { const h = ev.find(e => e.t === 'hit' && e.weapon === 'charge_lance'); return h ? h.pos : null; }` },
  ]);
}
if (want.includes('normal')) {
  // ordinary combat distance: mixed P17 arsenal fleets, default tactical camera distance
  await battle([['cruiser', 'aa', 'swarm_box', null], ['destroyer', 'aa', 'plasma_burst', 'flak_prox'], ['destroyer', 'strike', 'beam_cutter', null], ['frigate', 'aa', 'arc_s', null]],
    [['cruiser', 'aa', 'missile_2stage', 'flak_prox'], ['destroyer', 'aa', 'coil_l', null], ['destroyer', 'aa', 'mine_layer', null], ['frigate', 'aa', 'autocannon_40', null]], 8, [
      { name: 'normal_distance', dist: 2000, pitch: 0.95, pred: P`(w, ev, m) => { m.n = (m.n ?? 0) + ev.filter(e => e.t === 'hit' || e.t === 'split' || e.t === 'beam').length;
          if (w.time < 25 || m.n < 30) return null; let x = 0, z = 0, k = 0; for (const s of w.ships) if (s.state === 'alive') { x += s.pos.x; z += s.pos.z; k++; } return { x: x / k, y: 0, z: z / k }; }` },
    ]);
}
if (want.includes('thrust')) {
  // P17.3.1 exhaust: a ship under way (eased throttle) and a crippled drive (engine crit or < 30 % hull)
  await battle([['cruiser', 'aa', null, null], ['destroyer', 'aa', null, null]], [['battleship', 'std', null, null], ['cruiser', 'aa', null, null]], 4, [
    { name: 'thrust_underway', dist: 70, pitch: 0.35, yaw: 2.6, pred: P`(w) => { if (w.time < 6) return null; const s = w.ships.find(x => x.team === 0 && x.state === 'alive'); return s ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : null; }` },
    { name: 'thrust_crippled', dist: 80, pitch: 0.35, yaw: 2.6, pred: P`(w) => { const s = w.ships.find(x => x.state === 'alive' && (x.crit.engine > 0 || x.hp < x.maxHp * 0.3)); return s ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : null; }` },
  ]);
}
if (want.includes('spinal')) {
  // P17.3.1 spinal muzzles: the monitor's rail and the Leviathan-II's charge lance leave from the barrel's end
  await battle([{ p17: 'p17_bc_monitor' }, { p17: 'p17_dn_leviathan' }], [['battleship', 'std', null, null], ['cruiser', 'aa', null, null]], 6, [
    { name: 'spinal_charge', dist: 150, pitch: 0.35, yaw: 2.2, pred: P`(w, ev, m) => { for (const e of ev) if (e.t === 'charge' && !m.c) m.c = { t: w.time, s: e.ship, d: e.dur };
        if (!m.c || w.time < m.c.t + m.c.d * 0.8) return null; const s = w.ships.find(x => x.id === m.c.s); return s ? { x: s.pos.x, y: s.pos.y, z: s.pos.z } : null; }` },
    { name: 'spinal_fire', dist: 130, pitch: 0.4, yaw: 2.2, settle: 120, pred: P`(w, ev) => { const f = ev.find(e => e.t === 'fire' && w.shipById.get(e.ship)?.team === 0 && w.shipById.get(e.ship)?.mounts[e.mount]?.def.arc <= 6);
        if (!f) return null; const s = w.shipById.get(f.ship); return { x: s.pos.x, y: s.pos.y, z: s.pos.z }; }` },
  ]);
}
if (want.includes('mech')) {
  // P17.3.1 held beam, decoys, mines (arming → armed danger radius)
  await battle([['destroyer', 'strike', 'beam_cutter', null], ['destroyer', 'aa', 'mine_layer', null], ['cruiser', 'aa', 'missile_decoy', null]],
    [['cruiser', 'aa', null, null], ['destroyer', 'aa', null, null]], 9, [
    { name: 'mech_decoy', dist: 220, pitch: 0.5, settle: 200, pred: P`(w, ev) => { const d = ev.find(e => e.t === 'decoy'); return d ? d.pos : null; }` },
    { name: 'mech_beam_held', dist: 260, pitch: 0.5, settle: 150, pred: P`(w, ev) => { const b = ev.filter(e => e.t === 'beam'); return b.length ? b[0].to : null; }` },
    { name: 'mech_mine_armed', dist: 260, pitch: 0.7, settle: 1800, pred: P`(w) => { const m = w.munitions.find(x => !x.dead && x.mine === 1 && x.age >= (x.armAt ?? 0)); return m ? { x: m.pos.x, y: m.pos.y, z: m.pos.z } : null; }` },
  ]);
}
await b.close();
