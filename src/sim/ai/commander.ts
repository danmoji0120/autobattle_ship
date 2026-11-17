// Hierarchical commander AI.
//  - Composite groups (with child groups) interpret their order and hand derived orders to children.
//  - Groups with ships (leaves) pick targets, ranges, formations and drive their ships.
// Commander traits change the *quality* of decisions: skill → reaction speed, target choice,
// coordination; aggression → range, retreat timing; discipline → sticking to player orders.

import { Vec3, UP, clamp, lerp } from '../math';
import type { World } from '../world';
import type { Group, Ship, Order, Team } from '../types';
import type { Role } from '../data/ships';
import { steerComputers } from './computer';

const tmp = new Vec3(), tmp2 = new Vec3(), tmp3 = new Vec3();

export function orderKey(o: Order): string {
  switch (o.type) {
    case 'attack': return `attack:${o.targetGroup}:${o.targetShip ?? ''}`;
    case 'flank': return `flank:${o.side}:${o.targetGroup ?? ''}:${o.waitFor ?? ''}`;
    case 'escort': return `escort:${o.guardGroup}`;
    case 'move': return `move:${Math.round(o.point.x)}:${Math.round(o.point.z)}`;
    case 'hold': return `hold:${o.point ? Math.round(o.point.x) + ':' + Math.round(o.point.z) : ''}`;
    default: return o.type;
  }
}

export function groupRoleOf(w: World, g: Group): Role {
  const v: Record<Role, number> = { line: 0, escort: 0, raider: 0, civilian: 0 };
  for (const s of w.subtreeShips(g, true)) v[s.role] += s.value;
  if (v.civilian > v.line + v.escort + v.raider) return 'civilian';
  if (v.line >= v.escort && v.line >= v.raider) return 'line';
  return v.raider >= v.escort ? 'raider' : 'escort';
}

function isAlive(w: World, g: Group): boolean { return w.subtreeShips(g).length > 0; }

/** unit vector from our fleet toward the enemy fleet (flattened). Flank sides are defined in this frame: +1 = fleet left. */
export function fleetAxis(w: World, team: Team, out = new Vec3()): Vec3 {
  // based on the heavy ships only so raiders swinging around don't rotate the frame
  let mine = w.ships.filter(s => s.team === team && s.state === 'alive' && s.role !== 'raider');
  let theirs = w.ships.filter(s => w.hostile(team, s.team) && s.state === 'alive' && s.role !== 'raider');
  if (!mine.length) mine = w.ships.filter(s => s.team === team && s.state === 'alive');
  if (!theirs.length) theirs = w.ships.filter(s => w.hostile(team, s.team) && s.state === 'alive');
  const face = w.sides[team].face;
  if (!mine.length || !theirs.length) return out.copy(face);
  const a = w.centroid(mine, tmp3), b = w.centroid(theirs, new Vec3());
  out.subVectors(b, a); out.y = 0;
  if (out.lengthSq() < 100) return out.copy(face);
  return out.normalize();
}

export function updateAI(w: World) {
  // parents think before children (groups are created depth-first, so sort by depth)
  const order = w.groups.slice().sort((a, b) => a.depth - b.depth);
  for (const g of order) {
    if (w.time < g.ai.nextThink) continue;
    const ships = w.subtreeShips(g);
    if (!ships.length) { g.ai.nextThink = Infinity; continue; }
    think(w, g, ships);
    const c = g.commander;
    const interval = lerp(3.4, 0.9, c.skill) * (c.specialty === 'tactics' ? 0.75 : 1) * (c.ofx?.think ? 1 - c.ofx.think : 1);
    g.ai.nextThink = w.time + interval + w.rng.range(0, 0.5);
  }
  if (w.tick % 3 === 0) for (const g of w.groups) if (g.shipIds.length) {
    steer(w, g);
    // P15.1: fitted combat computers refine their own ship's steering within the group's order
    if (w.rules >= 2) { const ships = w.directShips(g); if (ships.length) steerComputers(w, g, ships, g.childIds.length ? effectiveSelfOrder(w, g) : g.order); }
  }
}

// ------------------------------------------------------------------------- think

function think(w: World, g: Group, ships: Ship[]) {
  const c = g.commander;
  // --- retreat threshold / damage reports
  const frac = w.groupHpFrac(g);
  g.ai.hpHistory.push(frac);
  if (g.ai.hpHistory.length > 12) g.ai.hpHistory.shift();
  if (g.order.type !== 'retreat' && g.retreatAt > 0) {
    const thr = g.retreatAt + (0.5 - c.aggression) * 0.12;
    if (frac < thr) {
      g.order = { type: 'retreat' }; g.ai.lastOrderKey = 'retreat'; g.playerOverride = true;
      g.ai.lastRadio = -99;
      w.say(g, 'retreat_auto', {}, 2);
    }
  }
  if (frac < 0.5 && !(g as any)._warned) { (g as any)._warned = true; w.say(g, 'heavy_damage', {}, 1); }

  if (g.childIds.length) thinkComposite(w, g);
  if (g.shipIds.length) {
    const own = w.directShips(g);
    if (own.length) thinkLeaf(w, g, own, effectiveSelfOrder(w, g));
  }
}

/** a composite group's own ships (e.g. a flagship) follow the order given to its main line child */
function effectiveSelfOrder(w: World, g: Group): Order {
  if (!g.childIds.length) return g.order;
  return (g as any)._selfOrder ?? g.order;
}

// ---------------------------------------------------------------- target choice

export function chooseEnemyGroup(w: World, g: Group, ships: Ship[], role: Role, prev: number): Group | null {
  const c = g.commander;
  // every side hostile to us (allied and neutral sides are never targets)
  const enemyLeaves = w.hostileLeafGroups(g.team);
  if (!enemyLeaves.length) return null;
  const C = w.centroid(ships, new Vec3());
  let best: Group | null = null, bestScore = -Infinity;
  for (const e of enemyLeaves) {
    const es = w.directShips(e);
    if (!es.length) continue;
    const ec = w.centroid(es, tmp);
    const d = ec.distTo(C);
    const value = es.reduce((a, s) => a + s.value, 0);
    const hpFrac = es.reduce((a, s) => a + s.hp / s.maxHp, 0) / es.length;
    const eRole = e.role;
    let match = 1;
    if (role === 'raider') match = eRole === 'line' ? 1.6 : eRole === 'escort' ? 0.45 : eRole === 'civilian' ? 1.8 : 0.9;
    else if (role === 'escort') match = eRole === 'raider' ? 1.8 : 0.8;
    else match = eRole === 'line' ? 1.2 : eRole === 'raider' ? 0.7 : 1;
    // isolated targets are attractive to skilled commanders
    let support = 0;
    for (const o of enemyLeaves) if (o !== e) { const od = w.centroid(w.directShips(o), tmp2).distTo(ec); if (od < 700) support++; }
    const isolation = 1 + c.skill * 0.25 * Math.max(0, 2 - support);
    const quality = value * (1.4 - 0.6 * hpFrac) * lerp(1, match, 0.4 + 0.6 * c.skill) * isolation;
    const distW = Math.pow(d + 500, 1 + (1 - c.skill) * 1.2);
    let score = quality / distW;
    score *= 1 + (1 - c.skill) * w.rng.range(-0.6, 0.6);
    if (e.id === prev) score *= lerp(1.05, 1.5, c.skill);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function sideAway(w: World, g: Group, target: Group, from: Vec3): -1 | 1 {
  // prefer the flank we are already on; otherwise the flank away from other enemy groups
  const axis = fleetAxis(w, g.team, new Vec3());
  const left = tmp2.crossVectors(UP, axis).normalize();
  const tc = w.groupCenter(target, new Vec3());
  const lateral = (from.x - tc.x) * left.x + (from.z - tc.z) * left.z;
  if (Math.abs(lateral) > 200) return lateral > 0 ? 1 : -1;
  let bias = 0;
  for (const o of w.leafGroups(target.team)) if (o.id !== target.id) { const oc = w.groupCenter(o, tmp3); bias += (oc.x - tc.x) * left.x + (oc.z - tc.z) * left.z; }
  if (Math.abs(bias) < 50) return w.rng.chance(0.5) ? 1 : -1;
  return bias > 0 ? -1 : 1;
}

// ------------------------------------------------------------------- composite

function thinkComposite(w: World, g: Group) {
  const c = g.commander;
  // an independent child (another company's fleet under a shared side root) commands itself
  const kids = g.childIds.map(id => w.groupById.get(id)!).filter(k => !k.independent && isAlive(w, k));
  if (!kids.length) return;
  const myShips = w.subtreeShips(g);
  const C = w.centroid(myShips, new Vec3());
  const lineKids = kids.filter(k => k.role === 'line');
  const raiderKids = kids.filter(k => k.role === 'raider');
  const escortKids = kids.filter(k => k.role === 'escort');
  const o = g.order;
  const assign = new Map<number, Order>();
  // fleet cohesion: a capable commander keeps the battle line moving at the pace of its slowest ship
  let pace = Infinity;
  if (c.skill >= 0.6) for (const k of lineKids) for (const s of w.subtreeShips(k)) pace = Math.min(pace, s.maxSpeed * (s.crit.engine > 0 ? 0.5 : 1));
  (g as any)._pace = pace * 1.05;

  // pick the "anvil": strongest line child
  const strength = (k: Group) => w.subtreeShips(k).reduce((a, s) => a + s.value * s.hp / s.maxHp, 0);
  const anvil = lineKids.slice().sort((a, b) => strength(b) - strength(a))[0] ?? null;

  if (o.type === 'engage' || o.type === 'attack') {
    let T: Group | null = null;
    if (o.type === 'attack') T = w.groupById.get(o.targetGroup) ?? null;
    if (T && !isAlive(w, T)) T = null;
    if (!T) {
      const prev = g.ai.mainTarget;
      T = chooseEnemyGroup(w, g, myShips, anvil ? 'line' : kids[0].role, prev);
      if (T && prev >= 0 && T.id !== prev && c.skill > 0.5 && isAlive(w, w.groupById.get(prev)!)) w.say(g, 'target_switch', { t: T.name }, 0);
    }
    if (!T) return;
    g.ai.mainTarget = T.id;
    const coordinated = c.skill + (c.ofx?.coord ?? 0) >= 0.45;
    for (const k of kids) {
      if (k.role === 'line') assign.set(k.id, { type: 'attack', targetGroup: T.id });
      else if (k.role === 'raider') {
        if (!coordinated) { assign.set(k.id, { type: 'engage' }); continue; }
        // raiders hit enemy line groups; if the main target is light, hunt it directly
        let rt = T;
        if (T.role !== 'line') { const alt = chooseEnemyGroup(w, k, w.subtreeShips(k), 'raider', k.ai.mainTarget); if (alt) rt = alt; }
        const prevOrder = k.order;
        // flanking only makes sense against a heavy battle line; light targets are hunted directly
        if (rt.role !== 'line') { assign.set(k.id, { type: 'attack', targetGroup: rt.id }); continue; }
        const kc = w.groupCenter(k, new Vec3());
        const side: -1 | 1 = prevOrder.type === 'flank' && prevOrder.targetGroup === rt.id ? prevOrder.side : sideAway(w, g, rt, kc);
        const waitFor = c.skill + (c.ofx?.coord ?? 0) >= 0.7 && anvil && rt.role === 'line' ? anvil.id : undefined;
        assign.set(k.id, { type: 'flank', side, targetGroup: rt.id, waitFor });
      } else {
        const guard = anvil ?? lineKids[0];
        if (guard) assign.set(k.id, { type: 'escort', guardGroup: guard.id });
        else assign.set(k.id, { type: 'attack', targetGroup: T.id });
      }
    }
    (g as any)._selfOrder = anvil ? { type: 'escort', guardGroup: anvil.id } : { type: 'attack', targetGroup: T.id };

    // reserve commitment
    for (const k of kids) {
      if (k.order.type === 'reserve' && k.playerOverride && (k as any)._reserveByDoctrine !== false) {
        // reserves set in the setup screen get committed by the parent when the fight is on
        if (w.firstContact >= 0 && w.time - w.firstContact > lerp(55, 20, c.skill)) {
          k.playerOverride = false; (k as any)._reserveByDoctrine = false;
          w.say(g, 'assign_anvil', { g: k.name, t: T.name }, 1);
        }
      }
    }
  } else if (o.type === 'flank') {
    let T = o.targetGroup !== undefined ? w.groupById.get(o.targetGroup) ?? null : null;
    if (!T || !isAlive(w, T)) T = chooseEnemyGroup(w, g, myShips, 'line', g.ai.mainTarget);
    if (!T) return;
    g.ai.mainTarget = T.id;
    for (const k of kids) {
      if (k.role === 'escort' && anvil) { assign.set(k.id, { type: 'escort', guardGroup: anvil.id }); continue; }
      // under a player's explicit flank order everyone takes the named side; under delegated
      // orders a capable commander lets each wing swing around the side it's already on
      let side = o.side;
      if (!g.playerOverride && c.skill >= 0.6 && k.role === 'raider') {
        const prev = k.order;
        side = prev.type === 'flank' && prev.targetGroup === T.id ? prev.side : sideAway(w, g, T, w.groupCenter(k, new Vec3()));
      }
      assign.set(k.id, { type: 'flank', side, targetGroup: T.id, waitFor: o.waitFor });
    }
    (g as any)._selfOrder = { type: 'flank', side: o.side, targetGroup: T.id };
  } else {
    for (const k of kids) assign.set(k.id, o);
    (g as any)._selfOrder = o;
  }

  for (const k of kids) {
    if (k.playerOverride) continue;
    const no = assign.get(k.id);
    if (!no) continue;
    const key = orderKey(no);
    if (key === k.ai.lastOrderKey) { k.order = no; continue; }
    const first = k.ai.lastOrderKey === '' || w.time < 3;
    w.setOrder(k, no, false);
    if (!first || g.parentId === null) {
      if (no.type === 'attack' && k.role === 'line') w.say(g, 'assign_anvil', { g: k.name, t: w.groupById.get(no.targetGroup)!.name }, 0);
      else if (no.type === 'flank') w.say(g, 'assign_hammer', { g: k.name, t: no.targetGroup !== undefined ? w.groupById.get(no.targetGroup)!.name : '적' }, 0);
    }
  }
}

// ------------------------------------------------------------------------ leaf

function preferredRange(w: World, g: Group, ships: Ship[]): number {
  const c = g.commander;
  // stand off at the range of whichever weapon type carries most of the group's firepower
  const dpsByRange = new Map<number, number>();
  for (const s of ships) for (const m of s.mounts) {
    if (m.weapon.kind === 'pd' || m.weapon.kind === 'torpedo' || m.ammo <= 0) continue;
    const dps = m.weapon.damage * m.weapon.salvo / m.weapon.reload;
    dpsByRange.set(m.weapon.range, (dpsByRange.get(m.weapon.range) ?? 0) + dps);
  }
  let maxR = 700, bestDps = 0;
  for (const [r, d] of dpsByRange) if (d > bestDps) { bestDps = d; maxR = r; }
  let r = maxR * lerp(0.92, 0.5, c.aggression);
  // unskilled aggressive commanders overshoot and close way too much
  if (c.skill < 0.5 && c.aggression > 0.6) r *= 0.8;
  if (g.ai.kiting) r = maxR * 1.0;
  return r;
}

function enemyThreatNear(w: World, team: Team, p: Vec3, radius: number, roleFilter?: Role): { group: Group | null; count: number } {
  let best: Group | null = null, bd = Infinity, count = 0;
  for (const e of w.hostileLeafGroups(team)) {
    if (roleFilter && e.role !== roleFilter) continue;
    const es = w.directShips(e);
    const ec = w.centroid(es, tmp);
    const d = ec.distTo(p) * (e.role === 'raider' ? 0.7 : 1);
    if (d < radius) count += es.length;
    if (d < bd) { bd = d; best = e; }
  }
  return { group: best, count };
}

function thinkLeaf(w: World, g: Group, ships: Ship[], order: Order) {
  const c = g.commander;
  const ai = g.ai;
  const C = w.centroid(ships, new Vec3());
  const enemies = w.aliveEnemyShips(g.team);
  if (!enemies.length) return;
  let o = order;

  // confused rookie: misreads flank orders and goes for the nearest enemy instead
  if (ai.confused > w.time && o.type === 'flank') {
    if (!(g as any)._saidConfused) { (g as any)._saidConfused = true; w.say(g, 'confused', {}, 1); }
    o = { type: 'engage' };
  }

  let T: Group | null = null;
  switch (o.type) {
    case 'engage': T = chooseEnemyGroup(w, g, ships, g.role, ai.mainTarget); break;
    case 'attack': T = w.groupById.get(o.targetGroup) ?? null; if (T && !isAlive(w, T)) T = chooseEnemyGroup(w, g, ships, g.role, -1); break;
    case 'flank': {
      T = o.targetGroup !== undefined ? w.groupById.get(o.targetGroup) ?? null : null;
      if (!T || !isAlive(w, T)) T = chooseEnemyGroup(w, g, ships, 'line', ai.mainTarget);
      break;
    }
    case 'escort': {
      const guard = w.groupById.get(o.guardGroup);
      if (!guard || !isAlive(w, guard)) { o = { type: 'engage' }; T = chooseEnemyGroup(w, g, ships, g.role, ai.mainTarget); break; }
      const gc = w.groupCenter(guard, new Vec3());
      const threat = enemyThreatNear(w, g.team, gc, 900);
      ai.threatGroup = threat.group ? threat.group.id : -1;
      // escorts hunt raiders near the guarded group first
      const raider = enemyThreatNear(w, g.team, gc, 700, 'raider');
      T = raider.group && raider.count > 0 ? raider.group : threat.group;
      // missile/torpedo warnings
      let missiles = 0, torps = 0;
      for (const m of w.munitions) {
        if (m.dead || !w.hostile(g.team, m.team) || m.kind === 'shell') continue;
        if (m.pos.distTo(gc) < 900) { if (m.kind === 'torpedo') torps++; else missiles++; }
      }
      if (torps >= 2 && c.skill > 0.4) w.say(g, 'torpedo_alert', {}, 1);
      else if (missiles >= 8 && c.skill > 0.4) w.say(g, 'missile_alert', {}, 0);
      break;
    }
    default: {
      // move/hold/reserve/retreat: fight targets of opportunity
      const near = enemies.reduce((b, e) => (e.pos.distTo(C) < b.d ? { d: e.pos.distTo(C), s: e } : b), { d: Infinity, s: enemies[0] });
      T = w.groupById.get(near.s.groupId) ?? null;
    }
  }
  if (!T) return;
  if (o.type !== 'escort') ai.mainTarget = T.id;
  else ai.mainTarget = T.id;
  const tShips = w.subtreeShips(T);
  if (!tShips.length) return;
  const Tc = w.centroid(tShips, new Vec3());
  ai.preferredRange = preferredRange(w, g, ships);
  const distToT = C.distTo(Tc);

  // --- flank phase machine
  if (o.type === 'flank') {
    if (ai.phase === 'none') ai.phase = 'transit';
    const W = flankPoint(w, g, T, Tc, o.side, C);
    ai.waypoint = W;
    if (ai.phase === 'transit') {
      const reached = C.distTo(W) < (g.role === 'raider' ? 260 : 320);
      if (reached) {
        const anchor = o.waitFor !== undefined ? w.groupById.get(o.waitFor) : undefined;
        const anchorEngaged = anchor ? isEngaged(w, anchor, T) : true;
        if (!anchorEngaged && w.time - ai.committedAt < 60) {
          ai.phase = 'staging';
          w.say(g, 'flank_ready', {}, 1);
        } else {
          ai.phase = 'strike';
          w.say(g, 'hammer', {}, 2);
        }
      }
      // never circle forever: commit after a while even if the waypoint keeps moving
      if (ai.phase === 'transit' && w.time - ai.committedAt > 55) { ai.phase = 'strike'; w.say(g, 'hammer', {}, 2); }
      // opportunist (low discipline, high skill): break off early if the target is already exposed
      if (ai.phase === 'transit' && c.discipline < 0.5 && c.skill > 0.7 && distToT < 700 && exposedFlank(w, T, C)) {
        ai.phase = 'strike';
        w.say(g, 'hammer', {}, 2);
      }
    } else if (ai.phase === 'staging') {
      const anchor = o.waitFor !== undefined ? w.groupById.get(o.waitFor) : undefined;
      if (!anchor || !isAlive(w, anchor) || isEngaged(w, anchor, T) || w.time - ai.committedAt > 60) {
        ai.phase = 'strike';
        w.say(g, 'hammer', {}, 2);
        const parent = g.parentId !== null ? w.groupById.get(g.parentId) : null;
        if (parent && parent.commander.skill > 0.6) { parent.ai.lastRadio = -99; w.say(parent, 'signal_hammer', { g: g.name }, 1); }
      }
    }
  } else ai.phase = 'none';

  // --- range management: skilled line commanders kite when outgunned
  if (g.role === 'line' && (o.type === 'attack' || o.type === 'engage')) {
    const h = ai.hpHistory;
    const loss = h.length >= 4 ? h[h.length - 4] - h[h.length - 1] : 0;
    const myPow = ships.reduce((a, s) => a + s.value * s.hp / s.maxHp, 0);
    const near = enemies.filter(e => e.pos.distTo(C) < 1300).reduce((a, s) => a + s.value * s.hp / s.maxHp, 0);
    if (!ai.kiting && c.skill > 0.6 && loss > 0.12 && near > myPow * 1.3) { ai.kiting = true; w.say(g, 'kite', {}, 1); }
    else if (ai.kiting && (near < myPow * 0.9 || loss < 0.02)) ai.kiting = false;
    if (!ai.announcedEngage && distToT < ai.preferredRange * 1.25) {
      ai.announcedEngage = true;
      if (c.aggression > 0.85 && c.skill < 0.65) w.say(g, 'charge', {}, 1);
      else w.say(g, 'engage_start', {}, 1);
    }
  } else if (!ai.announcedEngage && distToT < 900) { ai.announcedEngage = true; w.say(g, 'engage_start', {}, 0); }

  // --- enemy flank detection (skilled commanders notice raiders swinging around)
  const fw = (g as any)._flankWarn as number | undefined;
  if (c.skill > 0.6 && g.role === 'line' && (fw === undefined || w.time - fw > 40)) {
    for (const e of w.hostileLeafGroups(g.team)) {
      if (e.role !== 'raider') continue;
      const ec = w.groupCenter(e, tmp);
      if (ec.distTo(C) < 1100 && e.order.type === 'flank') {
        (g as any)._flankWarn = w.time;
        w.say(g, 'enemy_flank', {}, 1);
        break;
      }
    }
  }

  // --- target allocation
  assignTargets(w, g, ships, tShips, enemies, C, o);
}

function exposedFlank(w: World, T: Group, from: Vec3): boolean {
  const ts = w.subtreeShips(T);
  if (!ts.length) return false;
  const tc = w.centroid(ts, tmp);
  const f = new Vec3();
  for (const s of ts) f.add(s.fwd);
  f.normalize();
  const toUs = tmp2.subVectors(from, tc).normalize();
  return f.dot(toUs) < 0.1;
}

function isEngaged(w: World, anchor: Group, T: Group): boolean {
  const as = w.subtreeShips(anchor);
  if (!as.length) return false;
  const ac = w.centroid(as, new Vec3());
  const tc = w.groupCenter(T, tmp);
  return ac.distTo(tc) < anchor.ai.preferredRange + 200 || w.groupHpFrac(T) < 0.8;
}

function flankPoint(w: World, g: Group, T: Group, Tc: Vec3, side: -1 | 1, from: Vec3): Vec3 {
  const c = g.commander;
  const approach = fleetAxis(w, g.team, tmp);
  const left = tmp2.crossVectors(UP, approach).normalize(); // +side = fleet left
  // skilled commanders swing wide to avoid the enemy guns; rookies cut it close
  const D = g.role === 'raider' ? lerp(700, 1450, c.skill) : lerp(450, 900, c.skill);
  const back = g.role === 'raider' ? lerp(-150, -350, c.skill) : lerp(-250, 150, c.skill); // along the fleet axis
  const p = new Vec3().copy(Tc).addScaled(left, side * D).addScaled(approach, back);
  p.y = Tc.y + (g.role === 'raider' ? 50 * side : 0);
  void from;
  return p;
}

function assignTargets(w: World, g: Group, ships: Ship[], tShips: Ship[], enemies: Ship[], C: Vec3, o: Order) {
  const c = g.commander;
  // finishing blows: skilled commanders switch to a crippled ship in reach
  let finish: Ship | null = null;
  if (c.skill > 0.55) {
    for (const e of enemies) {
      if (e.hp / e.maxHp < 0.22 && e.pos.distTo(C) < g.ai.preferredRange * 1.1 && e.value >= 80) {
        if (!finish || e.hp < finish.hp) finish = e;
      }
    }
  }
  if (o.type === 'attack' && o.targetShip !== undefined) {
    const ts = w.shipById.get(o.targetShip);
    if (ts && ts.state === 'alive') { for (const s of ships) s.ai.targetId = ts.id; return; }
  }
  if (finish && g.ai.shipTarget !== finish.id) {
    g.ai.shipTarget = finish.id;
    w.say(g, 'finish', { t: finish.name }, 0, finish.pos);
  }
  const score = (s: Ship, t: Ship) => {
    let eff = 0;
    for (const m of s.mounts) if (m.weapon.kind !== 'pd') eff += m.weapon.damage / m.weapon.reload * m.weapon.salvo * w.suitability(m.weapon, t);
    const d = s.pos.distTo(t.pos);
    return eff * (1.3 - 0.7 * t.hp / t.maxHp) * (1 + t.value / 400) / (d + 400);
  };
  if (c.skill >= 0.55) {
    // focus fire, with overkill split
    const pool = finish ? [finish, ...tShips.filter(t => t !== finish)] : tShips;
    const ranked = pool.map(t => ({ t, sc: ships.reduce((a, s) => a + score(s, t), 0) * (t === finish ? 3 : 1) })).sort((a, b) => b.sc - a.sc);
    const primary = ranked[0]?.t;
    const secondary = ranked[1]?.t ?? primary;
    const split = primary && primary.hp / primary.maxHp < 0.25 && ships.length >= 3;
    ships.forEach((s, i) => {
      if (s.role === 'raider') {
        // raiders split across targets to spread enemy PD
        s.ai.targetId = (i % 2 === 0 || !secondary ? primary : secondary)?.id ?? -1;
      } else s.ai.targetId = (split && i % 2 === 1 ? secondary : primary)?.id ?? -1;
    });
    g.ai.shipTarget = primary?.id ?? -1;
  } else {
    // each ship picks something on its own; may flip targets
    for (const s of ships) {
      const cur = w.shipById.get(s.ai.targetId);
      if (cur && cur.state === 'alive' && !w.rng.chance(0.25 * (1 - c.skill))) continue;
      let best: Ship | null = null, bd = Infinity;
      for (const t of tShips) {
        const d = t.pos.distTo(s.pos) * w.rng.range(0.7, 1.3);
        if (d < bd) { bd = d; best = t; }
      }
      s.ai.targetId = best?.id ?? -1;
    }
  }
}

// ------------------------------------------------------------------------ steer

function steer(w: World, g: Group) {
  const ships = w.directShips(g);
  if (!ships.length) return;
  const c = g.commander;
  const ai = g.ai;
  const o = g.childIds.length ? effectiveSelfOrder(w, g) : g.order;
  const C = w.centroid(ships, new Vec3());
  const T = ai.mainTarget >= 0 ? w.groupById.get(ai.mainTarget) : undefined;
  const tShips = T ? w.subtreeShips(T) : [];
  const Tc = tShips.length ? w.centroid(tShips, new Vec3()) : null;
  const minSpeed = Math.min(...ships.map(s => s.maxSpeed * (s.crit.engine > 0 ? 0.5 : 1)));
  const cohesive = c.skill >= 0.5;
  const home = w.sides[g.team].home, ownFace = w.sides[g.team].face;

  let anchor: Vec3 = C.clone();
  let face: Vec3 | null = null;
  let mode: 'formation' | 'runs' | 'escort' = 'formation';
  let speedCap = cohesive ? minSpeed * 1.03 : Infinity;
  // follow the parent's fleet pace while advancing under delegated orders
  if (!g.playerOverride && g.parentId !== null && !g.independent && g.role === 'line') {
    const pace = (w.groupById.get(g.parentId) as any)._pace as number | undefined;
    if (pace && isFinite(pace)) speedCap = Math.min(speedCap, pace);
  }

  switch (o.type) {
    case 'retreat': {
      for (const s of ships) {
        // run for this side's own edge (classic sides: straight back along z)
        const d = s.pos.x * home.x + s.pos.z * home.z, D = w.spawnZ + 1600;
        s.ai.moveTo.set((s.pos.x - home.x * d) * 1.02 + home.x * D, s.pos.y, (s.pos.z - home.z * d) * 1.02 + home.z * D);
        s.ai.faceTo = null; s.ai.speedCap = s.maxSpeed; s.ai.run = null;
      }
      return;
    }
    case 'move': anchor = new Vec3(o.point.x, o.point.y, o.point.z); break;
    case 'hold': case 'reserve': anchor = ai.holdPoint ? ai.holdPoint.clone() : C.clone(); if (Tc && Tc.distTo(C) < 2000) face = Tc; break;
    case 'escort': {
      const guard = w.groupById.get(o.guardGroup);
      const gs = guard ? w.subtreeShips(guard) : [];
      if (gs.length) {
        mode = 'escort';
        const gc = w.centroid(gs, new Vec3());
        const threat = ai.threatGroup >= 0 ? w.groupById.get(ai.threatGroup) : undefined;
        const tc = threat ? w.groupCenter(threat, new Vec3()) : (Tc ?? gc.clone().addScaled(ownFace, 1000));
        const dir = tmp.subVectors(tc, gc); dir.y = 0; dir.normalize();
        const gRad = Math.max(60, ...gs.map(s => s.pos.distTo(gc) + s.radius * 2));
        // skilled escorts stand closer, inside PD coverage of the guarded ships
        const standoff = gRad + lerp(260, 90, c.skill);
        anchor = gc.clone().addScaled(dir, standoff);
        face = Tc ?? tc;
        speedCap = Infinity;
        const right = tmp2.crossVectors(dir, UP).normalize();
        const spacing = lerp(160, 90, c.skill);
        ships.forEach((s, i) => {
          const lat = (i - (ships.length - 1) / 2) * spacing;
          s.ai.moveTo.copy(anchor).addScaled(right, lat).addScaled(UP, ((i % 2) * 2 - 1) * 18);
          s.ai.faceTo = face && face.distTo(s.pos) < 1500 ? face : null;
          s.ai.speedCap = s.maxSpeed;
          s.ai.run = null;
        });
        return;
      }
      break;
    }
    case 'flank': {
      if (ai.phase === 'transit' || ai.phase === 'staging') {
        anchor = ai.waypoint ? ai.waypoint.clone() : C.clone();
        face = ai.phase === 'staging' ? Tc : null;
        if (g.role === 'raider') {
          speedCap = minSpeed;
          // hammer & anvil: a coordinated hammer paces itself so it doesn't arrive alone
          const anv = o.waitFor !== undefined ? w.groupById.get(o.waitFor) : undefined;
          if (anv && Tc && ai.phase === 'transit') {
            const as = w.subtreeShips(anv);
            if (as.length) {
              const ad = w.centroid(as, tmp3).distTo(Tc);
              const myD = C.distTo(Tc);
              let nearest = Infinity;
              for (const e of w.ships) if (w.hostile(g.team, e.team) && e.state === 'alive') nearest = Math.min(nearest, e.pos.distTo(C));
              if (myD < ad + 150 && nearest > 1150) speedCap = Math.min(minSpeed, 45);
            }
          }
        }
        break;
      }
      // strike: fall through to attack behaviour
    }
    // eslint-disable-next-line no-fallthrough
    case 'attack':
    case 'engage': {
      if (!Tc) break;
      if (g.role === 'raider') { mode = 'runs'; break; }
      const away = tmp.subVectors(C, Tc); away.y *= 0.3;
      if (away.lengthSq() < 1) away.copy(home);
      away.normalize();
      anchor = Tc.clone().addScaled(away, ai.preferredRange);
      anchor.y = lerp(C.y, Tc.y, 0.3);
      face = Tc;
      break;
    }
  }

  if (mode === 'runs' && Tc) { steerRaiders(w, g, ships, Tc); return; }

  // formation slots: line abreast facing the target / travel direction
  const heading = tmp.subVectors(face ?? anchor, C); heading.y = 0;
  if (heading.lengthSq() < 4) heading.copy(ownFace);
  heading.normalize();
  const right = tmp2.crossVectors(heading, UP).normalize();
  const spacing = Math.max(...ships.map(s => s.radius)) * 9 + 30;
  const n = ships.length;
  // keep slot assignment stable: sort by lateral position
  const sorted = ships.slice().sort((a, b) => (a.pos.x - C.x) * right.x + (a.pos.z - C.z) * right.z - ((b.pos.x - C.x) * right.x + (b.pos.z - C.z) * right.z));
  sorted.forEach((s, i) => {
    const lat = (i - (n - 1) / 2) * spacing;
    const slot = new Vec3().copy(anchor).addScaled(right, lat).addScaled(heading, -(i % 2) * 22).addScaled(UP, ((i % 3) - 1) * 16);
    s.ai.moveTo.copy(slot);
    // each ship faces its own target when in reach
    const tgt = w.shipById.get(s.ai.targetId);
    let maxR = 0; for (const m of s.mounts) if (m.weapon.kind === 'shell') maxR = Math.max(maxR, m.weapon.range);
    if (tgt && tgt.state === 'alive' && tgt.pos.distTo(s.pos) < maxR * 1.4) s.ai.faceTo = tgt.pos;
    else s.ai.faceTo = face && face.distTo(s.pos) < 2200 ? face : null;
    const far = s.pos.distTo(slot) > 250;
    s.ai.speedCap = far ? speedCap : s.maxSpeed;
    s.ai.run = null;
  });
}

function steerRaiders(w: World, g: Group, ships: Ship[], Tc: Vec3) {
  const c = g.commander;
  for (let i = 0; i < ships.length; i++) {
    const s = ships[i];
    const t = w.shipById.get(s.ai.targetId);
    if (!t || t.state !== 'alive') continue;
    if (!s.ai.run) s.ai.run = { mode: 'approach', point: new Vec3(), timer: 0, side: i % 2 ? 1 : -1 };
    const run = s.ai.run;
    run.timer -= w.dt * 3;
    const d = s.pos.distTo(t.pos);
    const torp = s.mounts.find(m => m.weapon.kind === 'torpedo' && m.disabled <= 0);
    const torpReady = !!torp && (torp.cooldown <= 0.3 || torp.salvoLeft > 0);
    const launch = torp ? torp.weapon.range * lerp(0.85, 0.55, c.aggression) : 140;
    const tLeft = tmp2.crossVectors(UP, t.fwd).normalize();
    if (run.mode === 'approach') {
      // skilled raiders curve in toward the target's rear quarter instead of charging the bow guns
      const rearQ = tmp.copy(t.fwd).scale(-0.7).addScaled(tLeft, run.side * 0.72).normalize();
      if (c.skill >= 0.55 && d > launch + 200) {
        s.ai.moveTo.copy(t.pos).addScaled(rearQ, launch * 0.85);
        if (s.ai.moveTo.distTo(s.pos) > d * 1.6) s.ai.moveTo.copy(t.pos).addScaled(tLeft, run.side * launch * 0.6);
      } else {
        // attack run: point straight at the target so the forward tubes bear
        const lead = d / 175;
        s.ai.moveTo.copy(t.pos).addScaled(t.vel, lead * 0.8);
        if (!torp) s.ai.moveTo.addScaled(tLeft, run.side * (t.radius + 20));
      }
      const fired = torp ? !torpReady : false;
      const breakNow = torp ? (fired && d < launch + 60) || d < 120 : d < 110;
      if (breakNow || run.timer < -12) {
        run.mode = 'break'; run.timer = 6;
        const out = tmp3.copy(s.vel); out.y = 0; out.normalize();
        run.point.copy(t.pos).addScaled(out, 650 + w.rng.range(0, 250)).addScaled(tmp2.crossVectors(out, UP).normalize(), run.side * 300);
        run.point.y = t.pos.y + w.rng.range(-80, 80);
      }
      s.ai.faceTo = t.pos;
    } else {
      s.ai.moveTo.copy(run.point);
      s.ai.faceTo = null;
      if (s.pos.distTo(run.point) < 140 || run.timer <= 0) { run.mode = 'approach'; run.side = -run.side; run.timer = 0; }
    }
    s.ai.speedCap = s.maxSpeed;
  }
  void Tc;
}
