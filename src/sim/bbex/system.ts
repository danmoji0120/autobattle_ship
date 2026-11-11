// BB-EX — exotic combat systems, simulated inside the deterministic battle engine.
//
//   FNL-EX      12 independent funnels (hunt / guard / dimension lock / wing)
//   DCP-Ω       dimension-cutting particle cannon with the FRACTAL MIRROR lattice
//   PARADOX     local space displacement (hits are relocated away, a barrier takes the rest)
//   BLACKOUT    fleet-wide jamming            GRAVITY WELL  local gravity collapse
//   PHANTOM SHIFT tactical spatial transfer   REGENESIS     self-reconstruction
//   causality interference (commander BB) and the BB CHANNEL: GAME OVER protocol
//
// The server decides everything here (targets, damage, the reflection lattice); spectators re-run
// the same code from the battle setup. The renderer only draws what the events and `Ship.ex` say,
// so the beams on screen are exactly the beams that cut.
//
// Nothing in this file runs — and no random number is drawn — in a battle without a BB-EX.
import { Vec3, UP, clamp, lerp, localToWorld, dirFromYawPitch, segSegDistSq } from '../math';
import type { World } from '../world';
import type { Ship, Munition, RadioMsg } from '../types';
import { WEAPONS, type WeaponDef } from '../data/weapons';
import { BBEX, BBEX_WEAPON } from './data';
import type { ExState, Funnel, DcpNode, Formation, ExWeaponStat } from './state';

/** per-battle options of a BB-EX (ShipSpec.ex). All optional; trials use them to isolate systems. */
export interface ExSpec {
  /** seconds into the battle at which the hull transfers in (default: just after the rift opens) */
  arrive?: number;
  /** where it emerges (default: its formation slot) */
  at?: { x: number; y: number; z: number };
  /** false = the DCP-Ω emitter is offline for the whole battle */
  dcp?: boolean;
  /** funnels available at the start (default 12) and whether REGENESIS rebuilds lost ones */
  funnels?: number; rebuild?: boolean;
  /** PARADOX barrier charge at arrival, 0..1 (0 = arrives overloaded) */
  paradox?: number;
  /** false = the decisive protocol never triggers; true = it triggers as soon as it can */
  over?: boolean;
}

const T1 = new Vec3(), T2 = new Vec3(), T3 = new Vec3(), T4 = new Vec3();
const FIELD = 3600 * 0.9;

// wing skeleton at full spread (port side; starboard mirrors x). Four funnels carry the great upper
// wing, two the lower one. Ship-local: x port, y up, z bow.
const WING: [number, number, number][] = [[46, 30, -8], [92, 62, -18], [136, 82, -34], [178, 80, -60], [70, -14, -20], [122, -42, -46]];
const ROOT: [number, number, number] = [7, 5, -9];

/** funnel wing slot in ship-local space (shared with the renderer so the wing membranes line up) */
export function wingLocal(i: number, spread: number, scale: number, time: number, out: Vec3): Vec3 {
  const side = i % 2 === 0 ? 1 : -1, k = i >> 1;
  const p = WING[k];
  const beat = Math.sin(time * 1.15 + k * 0.55) * (3 + k * 2.4) * spread;
  return out.set(
    side * (ROOT[0] + (p[0] * scale - ROOT[0]) * spread),
    ROOT[1] + (p[1] * scale - ROOT[1]) * spread + beat,
    ROOT[2] + (p[2] * scale - ROOT[2]) * spread,
  );
}

const stat = (ex: ExState, id: string): ExWeaponStat => (ex.stats.weapon[id] ??= { dmg: 0, hits: 0, kills: 0, shots: 0 });

function say(w: World, s: Ship, text: string, priority: 0 | 1 | 2 = 1) {
  const g = w.groupById.get(s.groupId)!;
  const c = g.commander;
  const who = c.causal ? 'BB' : `${s.name} 함장`;
  const msg: RadioMsg = { id: w.nextRadioId(), time: w.time, team: s.team, groupId: g.id, who, rank: '', color: '#c77dff', text, priority, pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, shipId: s.id };
  w.radioLog.push(msg); w.events.push({ t: 'radio', msg });
}

// ─────────────────────────────────────────────────────────────────────────── set-up

export function initEx(w: World, s: Ship, spec: ExSpec | undefined, causal: boolean) {
  const n = clamp(Math.floor(spec?.funnels ?? BBEX.funnels), 0, BBEX.funnels);
  const funnels: Funnel[] = [];
  for (let i = 0; i < BBEX.funnels; i++) {
    funnels.push({
      i, pos: new Vec3(), prevPos: new Vec3(), vel: new Vec3(), fwd: new Vec3(0, 0, 1), hp: BBEX.fHp, alive: i < n,
      rebuild: spec?.rebuild === false ? Infinity : BBEX.fRebuild, launchAt: Infinity, mode: 'dock', slot: new Vec3(), targetId: -1,
      cooldown: 0.4 + i * 0.07, orbit: i * 1.7, node: -1,
    });
  }
  const mount = spec?.dcp === false ? -1 : s.mounts.findIndex(m => m.weapon.special === 'dcp');
  const energy = BBEX.pEnergy * clamp(spec?.paradox ?? 1, 0, 1);
  const ex: ExState = {
    phase: 'inbound', arriveAt: Math.max(0.2, spec?.arrive ?? BBEX.riftTime + 0.3), arrivePos: new Vec3(),
    funnels, form: 'wing', spread: 0,
    paradox: { energy, max: BBEX.pEnergy, overload: energy <= 0 ? BBEX.pOverload : 0, load: 0, hits: 0, displaced: 0, absorbed: 0, overloads: 0 },
    dcp: { state: 'cool', t: BBEX.dcpCool - 4.5, mount, nodes: [], segs: [], locked: [], pulse: 0, shots: 0, over: false, replan: 0 },
    blackout: { next: 0, n: 0 }, well: { next: 0, pos: new Vec3(), until: 0, n: 0 }, shift: { next: 0, n: 0 },
    causal: { on: causal, vetoes: causal ? BBEX.cVetoes : 0, next: 0, used: 0, rewrites: 0 },
    over: { next: spec?.over === false ? Infinity : spec?.over === true ? 0 : 80, until: 0, n: 0 },
    orbit: s.id % 2 ? 1 : -1,
    stats: { weapon: {}, funnelsLost: 0, funnelsRebuilt: 0, intercepts: 0, regen: 0, arrivedAt: 0 },
  };
  s.ex = ex;
  s.state = 'inbound';
  (ex as ExState & { _at?: ExSpec['at']; _rift?: boolean })._at = spec?.at;
  w.exShips.push(s);
}

/** the spawn slot is only known after the fleet layout: remember where the hull will emerge */
export function placeEx(w: World) {
  for (const s of w.exShips) {
    const ex = s.ex!, at = (ex as ExState & { _at?: ExSpec['at'] })._at;
    if (at) { s.pos.set(at.x, at.y, at.z); s.prevPos.copy(s.pos); s.ai.moveTo.copy(s.pos); }
    ex.arrivePos.copy(s.pos);
    s.vel.set(0, 0, 0);
    for (const f of ex.funnels) { f.pos.copy(s.pos); f.prevPos.copy(s.pos); }
  }
}

export const exWeaponsFree = (s: Ship) => s.ex!.phase === 'combat';
const muzzle = (s: Ship, ex: ExState, out: Vec3) => {
  const m = ex.dcp.mount >= 0 ? s.mounts[ex.dcp.mount] : null;
  return m ? localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] + 6 }, s.pos, s.yaw, s.pitch, out) : out.copy(s.pos);
};
const overActive = (ex: ExState) => ex.over.until > 0;

// ─────────────────────────────────────────────────────────────────────────── steering (after the group AI)

export function exSteer(w: World) {
  for (const s of w.exShips) {
    const ex = s.ex!;
    if (s.state !== 'alive' || ex.phase === 'inbound') continue;
    const g = w.groupById.get(s.groupId)!;
    const o = g.order.type;
    if (o === 'retreat' || o === 'move' || o === 'hold' || o === 'reserve') continue;   // an explicit order stands
    // value-weighted centre of the enemy mass and the nearest hull
    let cx = 0, cy = 0, cz = 0, cw = 0, near: Ship | null = null, nd = Infinity;
    for (const e of w.ships) {
      if (e.team === s.team || e.state !== 'alive') continue;
      const d = e.pos.distTo(s.pos);
      if (d < nd) { nd = d; near = e; }
      if (d > 5200) continue;
      const k = e.value + 20;
      cx += e.pos.x * k; cy += e.pos.y * k; cz += e.pos.z * k; cw += k;
    }
    if (!near || cw <= 0) continue;
    const C = T1.set(cx / cw, cy / cw, cz / cw);
    // stand off where the lances and the edge reach but most guns do not, drifting along an orbit so
    // the hull never offers a still target
    let R = 820;
    if (nd < 420) R += 420 - nd;
    const rx = s.pos.x - C.x, rz = s.pos.z - C.z;
    const ang = Math.atan2(rx, rz) + ex.orbit * 0.32;
    const A = T2.set(C.x + Math.sin(ang) * R, clamp(C.y + 34, -180, 180), C.z + Math.cos(ang) * R);
    // the mass is far away (scattered or fleeing): close in on the nearest hull instead
    if (nd > 1900) A.copy(near.pos).addScaled(T3.subVectors(s.pos, near.pos).normalize(), 1100);
    const r = Math.hypot(A.x, A.z);
    if (r > FIELD) { A.x *= FIELD / r; A.z *= FIELD / r; }
    s.ai.moveTo.copy(A);
    s.ai.speedCap = s.maxSpeed;
    s.ai.run = null;
    const face = exFace(ex);
    const D = ex.dcp;
    // charging and cutting: the hull braces where the lattice was planned from
    if (D.state === 'charge' || D.state === 'fire') s.ai.moveTo.copy(exAnchor(ex));
    if ((D.state === 'charge' || D.state === 'fire') && D.nodes.length) face.copy(D.nodes[0].pos);
    else if (D.state === 'charge' || D.state === 'fire') face.copy(D.segs[0]?.b ?? C);
    else { const t = w.shipById.get(s.ai.targetId); face.copy(t && t.state === 'alive' ? t.pos : C); }
    s.ai.faceTo = face;
  }
}
const exFace = (ex: ExState): Vec3 => ((ex as ExState & { _face?: Vec3 })._face ??= new Vec3());
const exAnchor = (ex: ExState): Vec3 => ((ex as ExState & { _anchor?: Vec3 })._anchor ??= new Vec3());

// ─────────────────────────────────────────────────────────────────────────── per-tick update

export function updateEx(w: World) {
  const dt = w.dt;
  for (const s of w.exShips) {
    const ex = s.ex!;
    if (ex.phase === 'inbound') { arrive(w, s, ex); continue; }
    if (s.state !== 'alive') { if (ex.dcp.state === 'fire' || ex.dcp.state === 'charge') endDcp(w, s, ex, true); continue; }
    const over = overActive(ex);
    // ── descent → combat
    if (ex.phase === 'descent') {
      ex.spread = Math.min(1, ex.spread + dt / (BBEX.descentTime * 0.62));
      if (w.time - ex.stats.arrivedAt >= BBEX.descentTime) {
        ex.phase = 'combat'; setForm(w, s, ex, 'hunt');
        ex.blackout.next = w.time + 1.5; ex.well.next = w.time + 6; ex.shift.next = w.time + 6; if (ex.over.next !== 0) ex.over.next = w.time + 75;
      }
    } else {
      const want = ex.form === 'wing' ? 1 : 0;
      ex.spread += clamp(want - ex.spread, -dt / 1.2, dt / BBEX.goSpread);
    }
    // ── REGENESIS
    if (s.hp < s.maxHp) { const h = s.maxHp * BBEX.regen * (over ? 3 : ex.paradox.overload > 0 ? 0.5 : 1) * dt; s.hp = Math.min(s.maxHp, s.hp + h); ex.stats.regen += h; }
    if (s.crit.fire > 0) s.crit.fire -= dt * 2;
    if (s.crit.engine > 0) s.crit.engine -= dt;
    for (const m of s.mounts) { if (m.disabled > 0) m.disabled -= dt * 1.5; if (over) m.cooldown -= dt * (1 / BBEX.goReload - 1); }
    // ── PARADOX barrier
    const p = ex.paradox;
    p.load *= Math.exp(-dt / 0.9);
    if (p.overload > 0) {
      p.overload -= dt;
      if (p.overload <= 0) { p.overload = 0; p.energy = p.max * BBEX.pReboot; w.events.push({ t: 'exOverload', ship: s.id, on: false }); }
    } else if (p.energy < p.max) p.energy = Math.min(p.max, p.energy + BBEX.pRegen * (over ? 3 : 1) * dt);

    if (ex.phase === 'combat') {
      if (w.tick % 15 === 0) tactics(w, s, ex);
      updateDcp(w, s, ex);
      updateWell(w, s, ex);
    }
    updateFunnels(w, s, ex);
    if (w.tick % 15 === 7) funnelAttrition(w, s, ex);
  }
  // held hulls (dimension lock / gravity well) lose their way
  for (const e of w.ships) {
    if (e.holdUntil === undefined) continue;
    if (e.holdUntil <= w.time || e.state !== 'alive') { e.holdUntil = undefined; e.hold = undefined; continue; }
    e.vel.scale(Math.max(0, 1 - 4.2 * (e.hold ?? 0.8) * dt));
  }
}

function arrive(w: World, s: Ship, ex: ExState) {
  const flags = ex as ExState & { _rift?: boolean };
  const lead = Math.min(BBEX.riftTime, ex.arriveAt);
  if (!flags._rift && w.time >= ex.arriveAt - lead) {
    flags._rift = true;
    w.events.push({ t: 'exRift', ship: s.id, pos: ex.arrivePos.clone(), dur: ex.arriveAt - w.time });
  }
  if (w.time < ex.arriveAt) return;
  // the hull emerges, bow toward the enemy mass
  s.state = 'alive';
  s.pos.copy(ex.arrivePos); s.prevPos.copy(s.pos);
  let cx = 0, cz = 0, n = 0;
  for (const e of w.ships) if (e.team !== s.team && e.state === 'alive') { cx += e.pos.x; cz += e.pos.z; n++; }
  if (n) { s.yaw = Math.atan2(cx / n - s.pos.x, cz / n - s.pos.z); s.prevYaw = s.yaw; }
  s.pitch = 0; s.prevPitch = 0;
  dirFromYawPitch(s.yaw, 0, s.fwd);
  s.vel.copy(s.fwd).scale(14);
  s.ai.moveTo.copy(s.pos).addScaled(s.fwd, 120);
  ex.phase = 'descent'; ex.form = 'wing'; ex.spread = 0; ex.stats.arrivedAt = w.time;
  // funnels eject in mirrored pairs, wing root first
  for (const f of ex.funnels) { f.launchAt = w.time + 0.85 + (f.i >> 1) * BBEX.funnelStagger * 2 + (f.i % 2) * BBEX.funnelStagger * 0.5; f.pos.copy(s.pos); f.prevPos.copy(s.pos); f.mode = 'dock'; }
  // the group (and its superiors) stopped thinking while nobody was there
  for (const g of w.groups) if (g.team === s.team && g.ai.nextThink === Infinity) g.ai.nextThink = w.time + 0.2;
  w.events.push({ t: 'exDescent', ship: s.id, pos: s.pos.clone(), dur: BBEX.descentTime });
  w.intensity += 6;
  say(w, s, ex.causal.on ? 'BB-EX, 강림한다. 전 퍼널 사출.' : 'BB-EX, 공간전이 완료. 퍼널 전개.', 2);
  if (ex.paradox.overload > 0) w.events.push({ t: 'exOverload', ship: s.id, on: true });
}

function setForm(w: World, s: Ship, ex: ExState, form: Formation) {
  if (ex.form === form) return;
  ex.form = form;
  w.events.push({ t: 'exForm', ship: s.id, form });
}

// ─────────────────────────────────────────────────────────────────────────── tactics (every half second)

function tactics(w: World, s: Ship, ex: ExState) {
  const D = ex.dcp;
  let nearCount = 0, close = 0, far = Infinity, tx = 0, ty = 0, tz = 0;
  let nearest: Ship | null = null;
  for (const e of w.ships) {
    if (e.team === s.team || e.state !== 'alive') continue;
    const d = e.pos.distTo(s.pos);
    if (d < far) { far = d; nearest = e; }
    if (d < 2800) nearCount++;
    if (d < 540) { close++; tx += e.pos.x; ty += e.pos.y; tz += e.pos.z; }
  }
  let inbound = 0, torps = 0;
  for (const mu of w.munitions) {
    if (mu.dead || mu.team === s.team || mu.kind === 'shell') continue;
    const d2 = mu.pos.distSq(s.pos);
    if (d2 < 900 * 900) inbound++;
    if (mu.kind === 'torpedo' && d2 < 300 * 300) torps++;
  }
  (ex as ExState & { _inbound?: number })._inbound = inbound;

  // ── BLACKOUT
  if (w.time >= ex.blackout.next && nearCount > 0) blackout(w, s, ex);

  // ── PHANTOM SHIFT
  if (w.time >= ex.shift.next && D.state !== 'fire' && !overActive(ex)) {
    const pressed = close >= 4 || torps >= 2 || (ex.paradox.overload > 0 && close >= 1);
    if (pressed) {
      // away from what is pressing, half sideways so the next orbit continues
      const away = T1.set(s.pos.x - (close ? tx / close : s.pos.x - s.fwd.x), 0, s.pos.z - (close ? tz / close : s.pos.z - s.fwd.z));
      if (away.lengthSq() < 1) away.set(-s.fwd.x, 0, -s.fwd.z);
      away.normalize();
      const side = T2.crossVectors(away, UP).normalize();
      phantomShift(w, s, ex, T3.copy(s.pos).addScaled(away, BBEX.psRange * 0.86).addScaled(side, ex.orbit * BBEX.psRange * 0.5));
    } else if (nearest && far > 2050) {
      phantomShift(w, s, ex, T3.copy(nearest.pos).addScaled(T1.subVectors(s.pos, nearest.pos).normalize(), Math.max(1150, far - BBEX.psRange)));
    }
    void ty;
  }

  // ── BB CHANNEL: GAME OVER
  if (ex.causal.on && !overActive(ex) && D.mount >= 0 && (D.state === 'idle' || D.state === 'cool') && nearCount >= 6 && (w.time >= ex.over.next || (ex.over.next !== Infinity && ex.over.n === 0 && (s.hp < s.maxHp * 0.5 || ex.paradox.overload > 0)))) {
    startOver(w, s, ex);
  }

  // ── funnel roles
  if (ex.form !== 'wing' && D.state !== 'fire') {
    const live = ex.funnels.filter(f => f.alive && f.launchAt < 0);
    if (nearCount === 0) { setForm(w, s, ex, 'halo'); for (const f of live) if (f.node < 0) f.mode = 'halo'; }
    else {
      if (ex.form === 'halo') setForm(w, s, ex, 'hunt');
      const guards = clamp(BBEX.fGuardMin + Math.floor(inbound / 9) + (ex.paradox.overload > 0 ? 3 : 0), BBEX.fGuardMin, BBEX.fGuardMax);
      // the highest-numbered funnels stand guard; the rest hunt
      let g = 0;
      for (let k = live.length - 1; k >= 0; k--) { const f = live[k]; if (f.node >= 0) continue; if (g < guards) { f.mode = 'guard'; g++; } else f.mode = 'hunt'; }
      assignHunters(w, s, ex);
    }
  }
}

function assignHunters(w: World, s: Ship, ex: ExState) {
  const cands: Ship[] = [];
  for (const e of w.ships) if (e.team !== s.team && e.state === 'alive' && e.pos.distSq(s.pos) < 1700 * 1700) cands.push(e);
  if (!cands.length) {
    let best: Ship | null = null, bd = Infinity;
    for (const e of w.ships) if (e.team !== s.team && e.state === 'alive') { const d = e.pos.distSq(s.pos); if (d < bd) { bd = d; best = e; } }
    if (best) cands.push(best);
  }
  const load = new Map<number, number>();
  for (const f of ex.funnels) {
    if (!f.alive || f.mode !== 'hunt') continue;
    let best = -1, bs = -Infinity;
    for (const e of cands) {
      const n = load.get(e.id) ?? 0;
      if (n >= (e.value >= 250 ? 3 : 2) && cands.length > 1) continue;
      const d = e.pos.distTo(f.pos);
      let sc = (1.7 - e.hp / e.maxHp) * (1 + e.value / 320) / (1 + d / 900);
      if (e.id === f.targetId) sc *= 1.5;
      if (sc > bs) { bs = sc; best = e.id; }
    }
    f.targetId = best;
    if (best >= 0) load.set(best, (load.get(best) ?? 0) + 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────── funnels

function updateFunnels(w: World, s: Ship, ex: ExState) {
  const dt = w.dt, over = overActive(ex);
  let gi = 0, gn = 0;
  for (const f of ex.funnels) if (f.alive && f.mode === 'guard') gn++;
  for (const f of ex.funnels) {
    f.prevPos.copy(f.pos);
    if (!f.alive) {
      f.pos.copy(s.pos); f.prevPos.copy(s.pos);
      if (f.rebuild !== Infinity && ex.phase === 'combat') {
        f.rebuild -= dt * (over ? 2 : 1);
        if (f.rebuild <= 0) {
          f.alive = true; f.hp = BBEX.fHp; f.rebuild = BBEX.fRebuild; f.launchAt = w.time; f.mode = 'dock'; f.node = -1; f.targetId = -1; f.vel.set(0, 0, 0);
          ex.stats.funnelsRebuilt++;
          w.events.push({ t: 'exFunnel', ship: s.id, i: f.i, e: 'rebuilt', pos: s.pos.clone() });
        }
      }
      continue;
    }
    if (f.launchAt >= 0) {
      if (w.time < f.launchAt) { f.pos.copy(s.pos); f.prevPos.copy(s.pos); continue; }
      // ejection: thrown up and out from the dorsal bays
      f.launchAt = -1;
      const side = f.i % 2 === 0 ? 1 : -1;
      localToWorld({ x: side * 3, y: 3, z: -6 - (f.i >> 1) * 1.5 }, s.pos, s.yaw, s.pitch, f.pos);
      f.prevPos.copy(f.pos);
      localToWorld({ x: side * 150, y: 120 + (f.i >> 1) * 14, z: -60 }, T1.set(0, 0, 0), s.yaw, s.pitch, f.vel).add(s.vel);
      f.mode = ex.form === 'wing' ? 'wing' : ex.form === 'halo' ? 'halo' : 'guard';
      w.events.push({ t: 'exFunnel', ship: s.id, i: f.i, e: 'launch', pos: f.pos.clone() });
    }
    if (ex.form === 'wing' && f.node < 0) f.mode = 'wing';
    else if (f.mode === 'wing' && ex.form !== 'wing') f.mode = 'guard';

    // ── where it wants to be
    let anchored = true, hold = false;
    switch (f.mode) {
      case 'wing': localToWorld(wingLocal(f.i, ex.spread, over ? 1.32 : 1, w.time, T1), s.pos, s.yaw, s.pitch, f.slot); break;
      case 'halo': { const a = f.i / BBEX.funnels * Math.PI * 2 + w.time * 0.5; localToWorld(T1.set(Math.cos(a) * 32, Math.sin(a) * 32 + 2, -15), s.pos, s.yaw, s.pitch, f.slot); break; }
      case 'guard': {
        const a = gi++ / Math.max(1, gn) * Math.PI * 2 + w.time * 0.85;
        localToWorld(T1.set(Math.cos(a) * 66, Math.sin(a * 2 + w.time) * 17, Math.sin(a) * 66), s.pos, s.yaw, s.pitch, f.slot);
        break;
      }
      case 'hunt': {
        anchored = false;
        const t = w.shipById.get(f.targetId);
        if (!t || t.state !== 'alive') { f.slot.copy(s.pos).addScaled(s.fwd, 90); break; }
        f.orbit += dt * (0.85 + (f.i % 4) * 0.14) * (f.i % 2 ? 1 : -1);
        const R = t.radius * 2 + 105 + (f.i % 3) * 26;
        f.slot.set(t.pos.x + Math.cos(f.orbit) * R, t.pos.y + Math.sin(f.orbit * 1.7) * R * 0.42, t.pos.z + Math.sin(f.orbit) * R);
        break;
      }
      case 'lock': {
        anchored = false;
        const n = ex.dcp.nodes[f.node];
        if (!n) { f.mode = 'guard'; f.node = -1; break; }
        hold = ex.dcp.state === 'fire';
        if (!hold) f.slot.copy(n.pos);
        break;
      }
    }
    // ── fly there: accelerate toward an arrival speed, so paths curve instead of snapping
    if (hold) { f.vel.set(0, 0, 0); }
    else {
      const d = T1.subVectors(f.slot, f.pos);
      const dist = d.length();
      const vmax = f.mode === 'lock' || dist > 420 ? BBEX.fBoost : BBEX.fSpeed;
      const want = Math.min(vmax, dist * 3.2);
      if (dist > 1e-6) d.scale(want / dist);
      if (anchored) d.add(s.vel);
      const dv = d.sub(f.vel);
      const dl = dv.length(), max = BBEX.fAccel * (f.mode === 'lock' ? 2 : 1) * dt;
      if (dl > max) dv.scale(max / dl);
      f.vel.add(dv);
      f.pos.addScaled(f.vel, dt);
    }
    // ── act
    f.cooldown -= dt;
    let aim: Vec3 | null = null;
    if (ex.phase === 'combat') {
      if (f.mode === 'hunt') {
        const t = w.shipById.get(f.targetId);
        if (t && t.state === 'alive') { aim = t.pos; if (f.cooldown <= 0 && t.pos.distTo(f.pos) <= BBEX.fRange + t.halfLen) funnelShot(w, s, ex, f, t); }
      } else if (f.mode === 'guard' || f.mode === 'wing' || f.mode === 'halo') {
        if (f.cooldown <= 0) aim = funnelGuard(w, s, ex, f);
      }
    }
    // nose toward what it fights, else along its flight
    const want = aim ? T2.subVectors(aim, f.pos) : f.mode === 'wing' || f.mode === 'halo' ? T2.copy(s.fwd) : f.mode === 'lock' && ex.dcp.nodes[f.node] ? T2.copy(ex.dcp.nodes[f.node].n) : T2.copy(f.vel);
    if (want.lengthSq() > 1e-4) { want.normalize(); f.fwd.lerp(want, Math.min(1, dt * 7)).normalize(); }
  }
}

function funnelWeapon(ex: ExState): WeaponDef { return WEAPONS[BBEX_WEAPON.funnel]; }

function funnelShot(w: World, s: Ship, ex: ExState, f: Funnel, t: Ship) {
  const over = overActive(ex);
  f.cooldown = BBEX.fReload * w.rng.range(0.9, 1.15) * (ex.causal.on ? 1 : 1.25) * (over ? 0.5 : 1);
  const hit = w.rng.chance(t.role === 'raider' ? 0.68 : 0.94);
  const to = new Vec3().copy(t.pos).addScaled(t.fwd, w.rng.range(-0.7, 0.7) * t.halfLen);
  to.x += w.rng.range(-0.4, 0.4) * t.radius; to.y += w.rng.range(-0.3, 0.5) * t.radius;
  if (!hit) { to.x += w.rng.range(-18, 18); to.y += w.rng.range(-18, 18); to.z += w.rng.range(-18, 18); }
  const dir = new Vec3().subVectors(to, f.pos).normalize();
  stat(ex, BBEX_WEAPON.funnel).shots++;
  w.events.push({ t: 'exBeam', ship: s.id, i: f.i, from: f.pos.clone(), to: hit ? to.clone() : to.clone().addScaled(dir, 140), target: t.id, hit });
  w.intensity += 0.25;
  if (hit) w.applyHit(t, funnelWeapon(ex), s.id, to, dir, 'shell');
}

/** a guarding funnel swats the nearest inbound munition, or stings a small craft that came close */
function funnelGuard(w: World, s: Ship, ex: ExState, f: Funnel): Vec3 | null {
  let best: Munition | null = null, bd = BBEX.fInterceptRange * BBEX.fInterceptRange;
  for (const mu of w.munitions) {
    if (mu.dead || mu.team === s.team || mu.kind === 'shell') continue;
    if (mu.ghost !== undefined && mu.age < mu.ghost) continue;
    const d = mu.pos.distSq(f.pos) - (mu.targetId === s.id ? 6000 : 0) - (mu.kind === 'torpedo' ? 20000 : 0) - ((mu.id * 7 + f.i * 13) % 11) * 900;
    if (d < bd) { bd = d; best = mu; }
  }
  if (best) {
    f.cooldown = 0.2;
    const hit = w.rng.chance(BBEX.fInterceptChance * (best.kind === 'torpedo' ? 0.75 : 1));
    w.events.push({ t: 'exSwat', ship: s.id, i: f.i, from: f.pos.clone(), to: best.pos.clone() });
    if (hit) {
      best.hp--;
      if (best.hp <= 0 && !best.dead) {
        best.dead = true; s.stats.intercepts++; ex.stats.intercepts++;
        w.events.push({ t: 'intercept', pos: best.pos.clone(), kind: best.kind, by: s.id });
      }
    }
    return best.pos;
  }
  let near: Ship | null = null, nd: number = BBEX.fRange;
  for (const e of w.ships) {
    if (e.team === s.team || e.state !== 'alive') continue;
    const d = e.pos.distTo(f.pos) - e.halfLen;
    if (d < nd) { nd = d; near = e; }
  }
  if (near) { funnelShot(w, s, ex, f, near); return near.pos; }
  f.cooldown = 0.25;
  return null;
}

/** enemy point defence treats funnels as small craft: hulls with free PD guns in reach wear them down */
function funnelAttrition(w: World, s: Ship, ex: ExState) {
  if (ex.phase !== 'combat') return;
  // magazine explosions catch funnels too
  for (const ev of w.events) {
    if (ev.t !== 'destroyed' || !ev.magazine) continue;
    for (const f of ex.funnels) if (f.alive && f.launchAt < 0 && f.pos.distTo(ev.pos) < 230) damageFunnel(w, s, ex, f, 260);
  }
  for (const f of ex.funnels) {
    if (!f.alive || f.launchAt >= 0) continue;
    let ships = 0;
    for (const e of w.ships) {
      if (e.team === s.team || e.state !== 'alive') continue;
      const reach = 320 + e.halfLen;
      if (Math.abs(e.pos.x - f.pos.x) > reach || Math.abs(e.pos.z - f.pos.z) > reach || e.pos.distSq(f.pos) > reach * reach) continue;
      let pd = 0;
      for (const m of e.mounts) if (m.weapon.kind === 'pd' && m.disabled <= 0 && !m.targetIsMunition) pd++;
      if (!pd) continue;
      // half a second of fire from `pd` guns: 5 rounds each, most of them dodged
      const jam = e.jamUntil !== undefined && e.jamUntil > w.time ? 0.5 : 1;
      const dmg = pd * 5 * 0.2 * (1 - BBEX.fEvade) * 4 * jam * w.rng.range(0.3, 1.7);
      const from = e.pos.clone(); from.y += e.radius;
      w.events.push({ t: 'pd', ship: e.id, mount: 0, from, to: f.pos.clone(), hit: dmg > 4 });
      damageFunnel(w, s, ex, f, dmg);
      if (!f.alive || ++ships >= 3) break;
    }
  }
}

function damageFunnel(w: World, s: Ship, ex: ExState, f: Funnel, dmg: number) {
  if (!f.alive || overActive(ex) || f.mode === 'lock') return;   // a facet carrier sits inside its own fold
  f.hp -= dmg;
  if (f.hp > 0) return;
  f.alive = false; f.mode = 'dock'; f.targetId = -1; f.node = -1;
  ex.stats.funnelsLost++;
  w.events.push({ t: 'exFunnel', ship: s.id, i: f.i, e: 'lost', pos: f.pos.clone() });
}

// ─────────────────────────────────────────────────────────────────────────── BLACKOUT / GRAVITY WELL / PHANTOM SHIFT

function blackout(w: World, s: Ship, ex: ExState) {
  ex.blackout.next = w.time + BBEX.boEvery; ex.blackout.n++;
  let jammed = 0;
  const r2 = BBEX.boRadius * BBEX.boRadius;
  for (const e of w.ships) {
    if (e.team === s.team || e.state !== 'alive' || e.pos.distSq(s.pos) > r2) continue;
    e.jamUntil = w.time + BBEX.boTime; jammed++;
    for (const m of e.mounts) m.retarget += 0.35 + w.rng.range(0, 0.5);
  }
  for (const mu of w.munitions) {
    if (mu.dead || mu.team === s.team || mu.kind === 'shell' || mu.pos.distSq(s.pos) > r2) continue;
    if (w.rng.chance(BBEX.boMissileLoss)) { mu.targetId = -1; mu.life = Math.min(mu.life, 0.4 + w.rng.range(0, 1.2)); mu.ricochet = true; }
  }
  w.events.push({ t: 'exBlackout', ship: s.id, pos: s.pos.clone(), radius: BBEX.boRadius, jammed });
}

function updateWell(w: World, s: Ship, ex: ExState) {
  const W = ex.well, dt = w.dt;
  if (W.until > w.time) {
    const r2 = BBEX.gwRadius * BBEX.gwRadius;
    for (const e of w.ships) {
      if (e.team === s.team || e.state !== 'alive') continue;
      const d2 = e.pos.distSq(W.pos);
      if (d2 > r2 || d2 < 400) continue;
      const d = Math.sqrt(d2), k = 1 - d / BBEX.gwRadius;
      // lighter hulls fall faster
      const pull = BBEX.gwPull * (0.35 + 0.65 * k) * clamp(26 / e.halfLen, 0.5, 2.4) * dt;
      e.pos.x += (W.pos.x - e.pos.x) / d * pull; e.pos.y += (W.pos.y - e.pos.y) / d * pull; e.pos.z += (W.pos.z - e.pos.z) / d * pull;
      e.vel.scale(Math.max(0, 1 - BBEX.gwDrag * dt));
    }
    // guided munitions crossing the well are bent off course
    for (const mu of w.munitions) {
      if (mu.dead || mu.team === s.team || mu.kind === 'shell') continue;
      const d2 = mu.pos.distSq(W.pos);
      if (d2 > r2 || d2 < 100) continue;
      const d = Math.sqrt(d2);
      mu.vel.x += (W.pos.x - mu.pos.x) / d * 260 * dt; mu.vel.y += (W.pos.y - mu.pos.y) / d * 260 * dt; mu.vel.z += (W.pos.z - mu.pos.z) / d * 260 * dt;
    }
    return;
  }
  // open a well shortly before the next cut, on the densest mass in reach
  const D = ex.dcp;
  const soon = D.mount < 0 || (D.state === 'cool' && D.t > BBEX.dcpCool - 3.4) || D.state === 'idle';
  if (w.time < W.next || !soon || overActive(ex)) return;
  const cand: Ship[] = [];
  const r2 = BBEX.gwRange * BBEX.gwRange;
  for (const e of w.ships) if (e.team !== s.team && e.state === 'alive' && e.pos.distSq(s.pos) < r2 && e.pos.distSq(s.pos) > 500 * 500) cand.push(e);
  if (cand.length < 4) { W.next = w.time + 3; return; }
  let best: Ship | null = null, bs = 0;
  const rr = BBEX.gwRadius * BBEX.gwRadius;
  const step = Math.max(1, Math.floor(cand.length / 48));
  for (let i = 0; i < cand.length; i += step) {
    const c = cand[i];
    let sc = 0;
    for (const e of cand) if (e.pos.distSq(c.pos) < rr) sc += 40 + e.value;
    if (sc > bs) { bs = sc; best = c; }
  }
  if (!best || bs < 400) { W.next = w.time + 3; return; }
  // centre of what was caught
  let x = 0, y = 0, z = 0, n = 0;
  for (const e of cand) if (e.pos.distSq(best.pos) < rr) { x += e.pos.x; y += e.pos.y; z += e.pos.z; n++; }
  W.pos.set(x / n, y / n, z / n);
  W.until = w.time + BBEX.gwTime; W.next = w.time + BBEX.gwEvery; W.n++;
  w.events.push({ t: 'exWell', ship: s.id, pos: W.pos.clone(), radius: BBEX.gwRadius, dur: BBEX.gwTime });
}

function phantomShift(w: World, s: Ship, ex: ExState, to: Vec3, emergency = false) {
  const r = Math.hypot(to.x, to.z);
  if (r > FIELD) { to.x *= FIELD / r; to.z *= FIELD / r; }
  to.y = clamp(to.y, -160, 160);
  const from = s.pos.clone();
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  s.pos.copy(to); s.prevPos.copy(to);
  s.ai.moveTo.copy(to);
  // the formation funnels transfer with the hull; hunters and mirror carriers stay where they work
  for (const f of ex.funnels) {
    if (!f.alive || f.launchAt >= 0) { f.pos.copy(to); f.prevPos.copy(to); continue; }
    if (f.mode === 'hunt' || f.mode === 'lock') continue;
    f.pos.x += dx; f.pos.y += dy; f.pos.z += dz; f.prevPos.copy(f.pos);
  }
  // whatever was homing on the old position has nothing to home on
  for (const mu of w.munitions) if (!mu.dead && mu.targetId === s.id && mu.kind !== 'shell') { mu.targetId = -1; mu.ricochet = true; }
  for (const e of w.ships) if (e.team !== s.team && e.state === 'alive') for (const m of e.mounts) if (m.targetId === s.id && !m.targetIsMunition) m.retarget = Math.max(m.retarget, 0.5);
  ex.shift.next = w.time + (emergency ? 6 : BBEX.psCool); ex.shift.n++;
  w.events.push({ t: 'exShift', ship: s.id, from, to: to.clone() });
}

// ─────────────────────────────────────────────────────────────────────────── DCP-Ω and the FRACTAL MIRROR

interface Cand { e: Ship; x: number; y: number; z: number; r: number; hit: number; v: number }
let scanFar = 0;

/** value of everything a beam from A along d (unit) of length L and generation `gen` would cut */
function scan(C: Cand[], ax: number, ay: number, az: number, dx: number, dy: number, dz: number, L: number, gen: number, mark: boolean): number {
  let sc = 0; scanFar = 0;
  const br = BBEX.dcpWidth[Math.min(gen, BBEX.dcpWidth.length - 1)];
  for (let i = 0; i < C.length; i++) {
    const c = C[i];
    const rx = c.x - ax, ry = c.y - ay, rz = c.z - az;
    const t = rx * dx + ry * dy + rz * dz;
    if (t < 0 || t > L) continue;
    const px = rx - dx * t, py = ry - dy * t, pz = rz - dz * t;
    const reach = br + c.r;
    if (px * px + py * py + pz * pz > reach * reach) continue;
    sc += c.hit ? c.v * 0.18 : c.v;
    if (t > scanFar) scanFar = t;
    if (mark) c.hit++;
  }
  return sc;
}

/** the most rewarding direction out of A that is a visible bend from `inc` and apart from `taken` */
function bestDir(C: Cand[], aim: Cand[], A: Vec3, inc: Vec3 | null, taken: Vec3[], L: number, gen: number, out: Vec3): number {
  let bs = 0, bfar = 0;
  for (let i = 0; i < aim.length; i++) {
    const c = aim[i];
    let dx = c.x - A.x, dy = c.y - A.y, dz = c.z - A.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 70 || dist > L) continue;
    dx /= dist; dy /= dist; dz /= dist;
    if (inc) { const dot = dx * inc.x + dy * inc.y + dz * inc.z; if (dot > 0.955 || dot < -0.93) continue; }
    let ok = true;
    for (let k = 0; k < taken.length; k++) if (dx * taken[k].x + dy * taken[k].y + dz * taken[k].z > 0.93) { ok = false; break; }
    if (!ok) continue;
    const sc = scan(C, A.x, A.y, A.z, dx, dy, dz, L, gen, false) * (c.hit ? 0.7 : 1);
    if (sc > bs) { bs = sc; bfar = scanFar; out.set(dx, dy, dz); }
  }
  scanFar = bfar;
  return bs;
}

/** plan the lattice: which facets, where, and what each beam is aimed at. `lead` = seconds until the cut. */
function planDcp(w: World, s: Ship, ex: ExState, over: boolean, lead: number): boolean {
  const D = ex.dcp;
  // the hull comes to rest about 1.2 s of travel ahead; the first beam is planned from there
  const anchor = exAnchor(ex);
  if (D.state !== 'fire') anchor.copy(s.pos).addScaled(s.vel, Math.min(1.25, lead * 0.5));
  const origin = new Vec3().copy(anchor);
  const C: Cand[] = [];
  const range2 = (BBEX.dcpRange + 500) ** 2;
  for (const e of w.ships) {
    if (e.team === s.team || e.state !== 'alive' || e.pos.distSq(origin) > range2) continue;
    // whatever the lattice touches is held by the dimension lock at once, so hulls barely drift
    const k = Math.min(0.5, lead * 0.14);
    C.push({ e, x: e.pos.x + e.vel.x * k, y: e.pos.y + e.vel.y * k, z: e.pos.z + e.vel.z * k, r: e.radius + e.halfLen * 0.3, hit: 0, v: 30 + e.value * (0.6 + 0.4 * e.hp / e.maxHp) });
  }
  D.nodes = []; D.locked = [];
  if (!C.length) return false;
  const aim = C.length > 80 ? C.slice().sort((a, b) => b.v - a.v || a.e.id - b.e.id).slice(0, 80) : C;
  const strong = ex.causal.on;
  const maxDepth = over ? BBEX.goDepth : strong ? BBEX.dcpDepth : BBEX.dcpDepth - 1;
  const maxSeg = over ? BBEX.goMaxSeg : strong ? BBEX.dcpMaxSeg : 12;
  const carriers = ex.funnels.filter(f => f.alive && f.launchAt < 0);
  const maxNodes = over ? 44 : Math.max(0, carriers.length - BBEX.fGuardMin);
  const d = new Vec3();
  // first beam: from the emitter through the richest line of hulls
  if (bestDir(C, aim, origin, null, [], BBEX.dcpRange, 0, d) <= 0) return false;
  const rootFar = scanFar;
  const end = (A: Vec3, dir: Vec3, L: number) => new Vec3().copy(A).addScaled(dir, L);
  const nodes: DcpNode[] = [];
  let segs = 1;
  if (maxNodes === 0 || maxDepth === 0) {
    // no facet available: one straight cut
    const L = Math.min(rootFar + 520, BBEX.dcpRange);
    scan(C, origin.x, origin.y, origin.z, d.x, d.y, d.z, L, 0, true);
    nodes.push({ pos: end(origin, d, L), n: new Vec3(), parent: -1, depth: 0, funnel: -1, out: 0, ends: [] });
  } else {
    const L = Math.min(rootFar + 150, BBEX.dcpRange);
    scan(C, origin.x, origin.y, origin.z, d.x, d.y, d.z, L, 0, true);
    nodes.push({ pos: end(origin, d, L), n: new Vec3(), parent: -1, depth: 0, funnel: -1, out: 0, ends: [] });
    const inc = new Vec3();
    for (let qi = 0; qi < nodes.length; qi++) {
      const n = nodes[qi];
      inc.subVectors(n.pos, n.parent < 0 ? origin : nodes[n.parent].pos).normalize();
      // a pure reflection first, then the fractal split
      const want = n.depth === 0 ? 1 : n.depth === 1 ? (over ? BBEX.goSplit : BBEX.dcpSplit) : over ? 3 : 2;
      const taken: Vec3[] = [];
      for (let j = 0; j < want && segs < maxSeg; j++) {
        const o = new Vec3();
        if (bestDir(C, aim, n.pos, inc, taken, BBEX.dcpSeg, n.depth + 1, o) <= 0) break;
        const far = scanFar;
        taken.push(o); segs++; n.out++;
        if (n.depth + 1 < maxDepth && nodes.length < maxNodes) {
          const L2 = Math.min(far + 150, BBEX.dcpSeg);
          scan(C, n.pos.x, n.pos.y, n.pos.z, o.x, o.y, o.z, L2, n.depth + 1, true);
          nodes.push({ pos: end(n.pos, o, L2), n: new Vec3(), parent: qi, depth: n.depth + 1, funnel: -1, out: 0, ends: [] });
        } else {
          const L2 = Math.min(far + 560, BBEX.dcpSeg);
          scan(C, n.pos.x, n.pos.y, n.pos.z, o.x, o.y, o.z, L2, n.depth + 1, true);
          n.ends.push(end(n.pos, o, L2));
        }
      }
    }
  }
  // facet carriers: each facet takes the nearest free funnel (GAME OVER projects facets from the wing instead)
  for (const f of ex.funnels) if (f.node >= 0) { f.node = -1; if (f.mode === 'lock') f.mode = 'guard'; }
  if (!over) {
    const free = carriers.slice();
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.out === 0 && n.parent >= 0) continue;      // a beam simply ends here
      if (n.out === 0) continue;
      let bi = -1, bd = Infinity;
      for (let k = 0; k < free.length; k++) { const dd = free[k].pos.distSq(n.pos); if (dd < bd) { bd = dd; bi = k; } }
      if (bi < 0) break;
      const f = free.splice(bi, 1)[0];
      n.funnel = f.i; f.node = i; f.mode = 'lock'; f.targetId = -1;
    }
  } else {
    let k = 0;
    const wing = carriers.length ? carriers : ex.funnels;
    for (const n of nodes) if (n.out > 0) n.funnel = wing[k++ % wing.length].i;
  }
  D.nodes = nodes;
  for (const c of C) if (c.hit) { D.locked.push(c.e.id); c.e.holdUntil = Math.max(c.e.holdUntil ?? 0, w.time + lead + (over ? 1 : BBEX.dcpFire)); c.e.hold = 0.9; }
  return true;
}

/** build the actual beam segments from where the facets really are, and announce the cut */
function fireDcp(w: World, s: Ship, ex: ExState, seq: number) {
  const D = ex.dcp, over = D.over;
  const origin = muzzle(s, ex, new Vec3());
  const nodes = D.nodes;
  const planned = nodes.map(n => n.pos.clone());
  const ok: boolean[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    let live = n.parent < 0 || ok[n.parent];
    if (live && n.out > 0 && !over) {
      const f = n.funnel >= 0 ? ex.funnels[n.funnel] : null;
      if (f && f.alive && f.node === i) { n.pos.copy(f.pos); f.slot.copy(f.pos); f.vel.set(0, 0, 0); } else live = false;
    }
    ok.push(live);
  }
  const W = BBEX.dcpWidth;
  const wid = (g: number) => W[Math.min(g, W.length - 1)] * (over ? 1.15 : 1);
  D.segs = [];
  const stub = (a: Vec3, toward: Vec3, extra: number, gen: number, from: number) => {
    const dir = new Vec3().subVectors(toward, a); const L = dir.length() + extra; dir.normalize();
    D.segs.push({ a: a.clone(), b: new Vec3().copy(a).addScaled(dir, Math.min(L, BBEX.dcpSeg + 500)), gen, w: wid(gen), from, to: -1 });
  };
  const start = (i: number) => (i < 0 ? origin : nodes[i].pos);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parent >= 0 && !ok[n.parent]) continue;
    const a = start(n.parent), gen = n.depth;
    // a facet that is gone (or a planned free end): the beam runs on past where it would have been
    if (!ok[i] || n.out === 0) { stub(a, ok[i] ? n.pos : planned[i], n.out === 0 && ok[i] ? 0 : 480, gen, n.parent); continue; }
    D.segs.push({ a: a.clone(), b: n.pos.clone(), gen, w: wid(gen), from: n.parent, to: i });
    for (const e of n.ends) stub(n.pos, T1.copy(n.pos).add(T2.subVectors(e, planned[i])), 0, gen + 1, i);
  }
  // facet normals: bisector between the incoming beam and the mean of what leaves
  const outSum = nodes.map(() => new Vec3());
  for (const g of D.segs) if (g.from >= 0) outSum[g.from].add(T1.subVectors(g.b, g.a).normalize());
  const evNodes: { pos: Vec3; n: Vec3; split: number; funnel: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!ok[i] || n.out === 0) continue;
    const inc = T1.subVectors(n.pos, start(n.parent)).normalize();
    n.n.copy(outSum[i]).normalize().sub(inc);
    if (n.n.lengthSq() < 1e-6) n.n.copy(inc).scale(-1);
    n.n.normalize();
    evNodes.push({ pos: n.pos.clone(), n: n.n.clone(), split: n.out, funnel: n.funnel });
  }
  const dur = over ? Math.min(BBEX.goReplan * w.dt + 0.25, BBEX.goFire - D.t + 0.25) : BBEX.dcpFire;
  w.events.push({ t: 'exDcpFire', ship: s.id, dur, segs: D.segs.map(g => ({ a: g.a.clone(), b: g.b.clone(), gen: g.gen, w: g.w })), nodes: evNodes, over, seq });
  w.intensity += over ? 14 : 9;
  if (D.mount >= 0) { const m = s.mounts[D.mount]; m.lastFire = w.time; if (D.segs.length) m.aim.subVectors(D.segs[0].b, D.segs[0].a).normalize(); }
  stat(ex, BBEX_WEAPON.dcp).shots++;
}

function pulseDcp(w: World, s: Ship, ex: ExState) {
  const D = ex.dcp;
  const base = BBEX.dcpDamage * (D.over ? BBEX.goDamage : 1);
  const a = T3, b = T4, c1 = new Vec3();
  for (const g of D.segs) {
    const dmg = base * BBEX.dcpFalloff[Math.min(g.gen, BBEX.dcpFalloff.length - 1)];
    const dir = new Vec3().subVectors(g.b, g.a).normalize();
    const minX = Math.min(g.a.x, g.b.x) - 60, maxX = Math.max(g.a.x, g.b.x) + 60, minZ = Math.min(g.a.z, g.b.z) - 60, maxZ = Math.max(g.a.z, g.b.z) + 60;
    for (const e of w.ships) {
      if (e.team === s.team || e.state !== 'alive') continue;
      if (e.pos.x < minX || e.pos.x > maxX || e.pos.z < minZ || e.pos.z > maxZ) continue;
      a.copy(e.pos).addScaled(e.fwd, e.halfLen * 0.92); b.copy(e.pos).addScaled(e.fwd, -e.halfLen * 0.92);
      const rr = g.w * 0.9 + e.radius;
      if (segSegDistSq(g.a, g.b, a, b, c1) > rr * rr) continue;
      w.exDamage(e, dmg * w.rng.range(0.9, 1.1), s.id, c1.clone(), dir, BBEX_WEAPON.dcp);
    }
  }
}

function startDcp(w: World, s: Ship, ex: ExState, over: boolean): boolean {
  const D = ex.dcp;
  const lead = over ? BBEX.goSpread + BBEX.goCharge : BBEX.dcpLock + BBEX.dcpCharge;
  if (!planDcp(w, s, ex, over, lead)) return false;
  D.state = 'charge'; D.t = 0; D.over = over; D.pulse = 0;
  w.events.push({ t: 'exDcpCharge', ship: s.id, dur: lead, nodes: D.nodes.filter(n => n.out > 0).map(n => ({ pos: n.pos.clone(), n: n.n.clone(), funnel: n.funnel })), locked: D.locked.slice(), over });
  if (!over) { setForm(w, s, ex, 'lock'); say(w, s, D.shots === 0 ? 'DCP-Ω 충전. 공간 반사면 전개 — 프랙탈 미러.' : 'DCP-Ω 재충전. 반사면 재배치.', 1); }
  return true;
}

function endDcp(w: World, s: Ship, ex: ExState, aborted = false) {
  const D = ex.dcp;
  for (const f of ex.funnels) { if (f.node >= 0) { f.node = -1; if (f.alive && f.mode === 'lock') f.mode = 'guard'; } }
  w.events.push({ t: 'exDcpEnd', ship: s.id });
  D.state = 'cool'; D.t = 0; D.segs = []; D.nodes = []; D.locked = [];
  if (!aborted) D.shots++;
  if (D.over) {
    D.over = false;
    ex.over.until = 0; ex.over.next = w.time + BBEX.goCool;
    w.events.push({ t: 'exGameOver', ship: s.id, on: false, dur: 0 });
  }
  if (s.state === 'alive') setForm(w, s, ex, 'hunt');
}

function startOver(w: World, s: Ship, ex: ExState) {
  const total = BBEX.goSpread + BBEX.goCharge + BBEX.goFire;
  ex.over.until = w.time + total + 0.5; ex.over.n++;
  ex.form = 'wing';
  w.events.push({ t: 'exForm', ship: s.id, form: 'wing' });
  w.events.push({ t: 'exGameOver', ship: s.id, on: true, dur: total });
  ex.paradox.overload = 0; ex.paradox.energy = ex.paradox.max;
  say(w, s, 'BB CHANNEL — GAME OVER.', 2);
  if (!startDcp(w, s, ex, true)) { ex.over.until = 0; ex.over.next = w.time + 12; w.events.push({ t: 'exGameOver', ship: s.id, on: false, dur: 0 }); setForm(w, s, ex, 'hunt'); }
}

function updateDcp(w: World, s: Ship, ex: ExState) {
  const D = ex.dcp, dt = w.dt;
  if (D.mount < 0) return;
  D.t += dt;
  switch (D.state) {
    case 'cool': if (D.t >= BBEX.dcpCool * (ex.causal.on ? 0.85 : 1)) { D.state = 'idle'; D.t = 0; } break;
    case 'idle': {
      if (w.tick % 10 !== 0 || overActive(ex) || s.mounts[D.mount].disabled > 0) break;
      startDcp(w, s, ex, false);
      break;
    }
    case 'charge': {
      const dur = D.over ? BBEX.goSpread + BBEX.goCharge : BBEX.dcpLock + BBEX.dcpCharge;
      // the emitter follows the first beam
      const m = s.mounts[D.mount];
      if (D.nodes.length) m.aim.subVectors(D.nodes[0].pos, s.pos).normalize();
      if (D.t < dur) break;
      D.state = 'fire'; D.t = 0; D.pulse = 0;
      if (D.over) { planDcp(w, s, ex, true, 0.3); D.replan = BBEX.goReplan; }
      fireDcp(w, s, ex, 0);
      if (!D.over) say(w, s, '차원절단, 개방.', 1);
      pulseDcp(w, s, ex);
      break;
    }
    case 'fire': {
      D.pulse++;
      if (D.over && --D.replan <= 0 && D.t < BBEX.goFire - 0.5) {
        // GAME OVER: the lattice re-forms on what is still alive, again and again
        D.replan = BBEX.goReplan;
        if (planDcp(w, s, ex, true, 0.3)) fireDcp(w, s, ex, Math.floor(D.t / (BBEX.goReplan * dt)));
      }
      if (D.pulse % BBEX.dcpPulse === 0) pulseDcp(w, s, ex);
      if (D.t >= (D.over ? BBEX.goFire : BBEX.dcpFire)) endDcp(w, s, ex);
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────── hooks called by the engine

/** PARADOX: an incoming hit is displaced (it never happened here) or soaked by the barrier.
 *  Returns true when nothing is left for the hull. */
export function exIncoming(w: World, t: Ship, wd: WeaponDef, attackerId: number, pos: Vec3, dir: Vec3): boolean {
  const ex = t.ex!, p = ex.paradox;
  p.hits++; p.load += 1;
  const heavy = wd.damage >= 250;
  const full = ex.phase !== 'combat' || overActive(ex);
  const prob = full ? 1 : p.overload > 0 ? BBEX.pOverloadDisplace : lerp(BBEX.pDisplace, BBEX.pDisplaceSat, clamp(p.load / BBEX.pLoadSat, 0, 1)) + (ex.causal.on ? 0.035 : 0);
  if (full || w.rng.chance(prob)) {
    p.displaced++;
    t.lastAttacker = attackerId;
    w.events.push({ t: 'exParadox', ship: t.id, pos: pos.clone(), dir: dir.clone(), mode: 'displace', dmg: wd.damage, heavy });
    return true;
  }
  if (p.overload > 0 || p.energy <= 0) return false;
  const want = wd.damage * (wd.vsShield ?? 1);
  if (p.energy >= want) {
    p.energy -= want; p.absorbed += wd.damage;
    t.lastAttacker = attackerId;
    w.events.push({ t: 'exParadox', ship: t.id, pos: pos.clone(), dir: dir.clone(), mode: 'absorb', dmg: wd.damage, heavy });
    return true;
  }
  // the barrier collapses: this hit and the next few seconds reach the hull
  p.energy = 0; p.overload = BBEX.pOverload; p.overloads++;
  w.events.push({ t: 'exOverload', ship: t.id, on: true });
  say(w, t, 'PARADOX 과부하. 결계 재구성 중.', 2);
  return false;
}

/** a shell crossing the PARADOX field off the hull: the field may relocate it anyway (true = gone).
 *  A round the field lets through simply flies on — it was never going to touch the hull. */
export function exGraze(w: World, t: Ship, mu: Munition, pos: Vec3): boolean {
  const ex = t.ex!, p = ex.paradox;
  const full = ex.phase !== 'combat' || overActive(ex);
  const prob = full ? 1 : p.overload > 0 ? BBEX.pOverloadDisplace : lerp(BBEX.pDisplace, BBEX.pDisplaceSat, clamp(p.load / BBEX.pLoadSat, 0, 1)) + (ex.causal.on ? 0.035 : 0);
  if (!full && !w.rng.chance(prob)) return false;
  p.hits++; p.load += 1; p.displaced++;
  const dir = T1.copy(mu.vel).normalize();
  w.events.push({ t: 'exParadox', ship: t.id, pos: pos.clone(), dir: dir.clone(), mode: 'displace', dmg: mu.weapon.damage, heavy: mu.weapon.damage >= 250 });
  return true;
}

/** causality interference: the result "BB-EX is destroyed" is rejected before it becomes final */
export function exVeto(w: World, t: Ship): boolean {
  const ex = t.ex!, c = ex.causal;
  if (!c.on || c.vetoes <= 0 || w.time < c.next) return false;
  c.vetoes--; c.used++; c.next = w.time + BBEX.cVetoCool;
  t.hp = t.maxHp * 0.38;
  ex.paradox.overload = 0; ex.paradox.energy = ex.paradox.max;
  t.crit.fire = 0; t.crit.engine = 0; t.crit.bridge = 0;
  w.events.push({ t: 'exOverload', ship: t.id, on: false });
  w.events.push({ t: 'exCausal', ship: t.id, what: 'veto', pos: t.pos.clone() });
  say(w, t, '그 결과는 기각한다.', 2);
  // and it is somewhere else
  const away = new Vec3(-t.fwd.x, 0, -t.fwd.z);
  let cx = 0, cz = 0, n = 0;
  for (const e of w.ships) if (e.team !== t.team && e.state === 'alive' && e.pos.distSq(t.pos) < 1500 * 1500) { cx += e.pos.x; cz += e.pos.z; n++; }
  if (n) away.set(t.pos.x - cx / n, 0, t.pos.z - cz / n);
  if (away.lengthSq() < 1) away.set(0, 0, t.team === 0 ? -1 : 1);
  away.normalize();
  if (ex.phase === 'combat' && ex.dcp.state !== 'fire') phantomShift(w, t, ex, new Vec3().copy(t.pos).addScaled(away, BBEX.psRange), true);
  return true;
}

/** causality interference on BB-EX's own fire: a shot that would have glanced off is made to bite */
export function exRewrite(w: World, a: Ship, pos: Vec3): boolean {
  const c = a.ex!.causal;
  if (!c.on || !w.rng.chance(BBEX.cRewrite)) return false;
  c.rewrites++;
  if (c.rewrites % 6 === 1) w.events.push({ t: 'exCausal', ship: a.id, what: 'rewrite', pos: pos.clone() });
  return true;
}

export function exNoteHit(a: Ship, weapon: string, dmg: number) { const st = stat(a.ex!, weapon); st.dmg += dmg; st.hits++; }
export function exNoteKill(a: Ship, weapon: string | undefined) { if (weapon) stat(a.ex!, weapon).kills++; }
export function exNoteShot(a: Ship, weapon: string) { stat(a.ex!, weapon).shots++; }

/** LILAC STINGER: photon bolts bend toward their target */
export function exSeek(w: World, mu: Munition) {
  const t = w.shipById.get(mu.targetId);
  if (!t || t.state !== 'alive') return;
  const sp = mu.vel.length();
  if (sp < 1) return;
  const tt = t.pos.distTo(mu.pos) / sp;
  const aim = T1.set(t.pos.x + t.vel.x * tt - mu.pos.x, t.pos.y + t.vel.y * tt - mu.pos.y, t.pos.z + t.vel.z * tt - mu.pos.z);
  const al = aim.length();
  if (al < 1e-6) return;
  aim.scale(1 / al);
  const dir = T2.copy(mu.vel).scale(1 / sp);
  // only bolts already roughly on course are corrected (no U-turns)
  const dot = dir.dot(aim);
  if (dot < 0.5) return;
  const max = mu.weapon.seek! * w.dt;
  const ang = Math.acos(clamp(dot, -1, 1));
  const k = ang <= max ? 1 : max / ang;
  dir.lerp(aim, k).normalize();
  mu.vel.copy(dir).scale(sp);
}

/** SERAPH-EX: one skip through space, re-emerging inside the outer point-defence envelope */
export function exPhase(w: World, mu: Munition, t: Ship) {
  const d = T1.subVectors(t.pos, mu.pos);
  const dist = d.length();
  if (dist < 520) { mu.phased = true; return; }
  d.scale(1 / dist);
  const from = mu.pos.clone();
  const jump = Math.min(dist - 300, 1050);
  mu.pos.addScaled(d, jump);
  // a little scatter so a salvo does not re-emerge as one point
  mu.pos.x += w.rng.range(-26, 26); mu.pos.y += w.rng.range(-26, 26); mu.pos.z += w.rng.range(-26, 26);
  mu.prevPos.copy(mu.pos);
  mu.vel.copy(d).scale(mu.weapon.speed);
  mu.phased = true; mu.ghost = mu.age + 0.3;
  w.events.push({ t: 'exPhase', from, to: mu.pos.clone() });
}

/** summary for trials and the result screen */
export function exReport(s: Ship) {
  const ex = s.ex!;
  return {
    hp: Math.max(0, s.hp) / s.maxHp, state: s.state,
    weapons: ex.stats.weapon, funnels: { alive: ex.funnels.filter(f => f.alive).length, lost: ex.stats.funnelsLost, rebuilt: ex.stats.funnelsRebuilt, intercepts: ex.stats.intercepts },
    paradox: { hits: ex.paradox.hits, displaced: ex.paradox.displaced, absorbed: Math.round(ex.paradox.absorbed), overloads: ex.paradox.overloads },
    dcpShots: ex.dcp.shots, blackouts: ex.blackout.n, wells: ex.well.n, shifts: ex.shift.n, gameOvers: ex.over.n,
    vetoes: ex.causal.used, rewrites: ex.causal.rewrites, regen: Math.round(ex.stats.regen),
  };
}
