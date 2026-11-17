import { Vec3, UP, clamp, lerp, wrapAngle, dirFromYawPitch, yawOf, pitchOf, localToWorld, worldDirToLocal, segSegDistSq, angleBetween, rotateToward } from './math';
import { Rng, hashString } from './rng';
import { SHIP_CLASSES, getLoadout, shipCost, SHIP_NAMES, type LoadoutDef } from './data/ships';
import { WEAPONS, type WeaponDef } from './data/weapons';
import { getCommander, ACTING_CAPTAIN, type CommanderDef } from './data/commanders';
import type { FleetSpec, GroupSpec, ShipFx, ShipSpec } from './fleet';
import type { Group, Ship, Munition, Mount, Order, SimEvent, RadioMsg, Highlight, Outcome, OrderRecord, Team, Relation, BattleEvent, SideSpec, SideStatus, SideResult } from './types';
import { line } from './ai/lines';
import { updateAI, orderKey, groupRoleOf } from './ai/commander';
import { initCpu, CPU_ARCHS, cpuLaunchFactor, cpuOwnGuns, cpuPdCover } from './ai/computer';
import { BBEX, BBEX_CLASS } from './bbex/data';
import { initEx, placeEx, updateEx, exSteer, exWeaponsFree, exIncoming, exGraze, exVeto, exRewrite, exNoteHit, exNoteKill, exNoteShot, exSeek, exPhase } from './bbex/system';

export interface BattleSetup {
  seed: number;
  scenarioId: string;
  /** one fleet per side at the start (ordinary battles: two). Reinforcements join later through
   *  'join' battle events in the order log (P11). */
  fleets: FleetSpec[];
  /** P11: per starting side display name / key (default '진영 k') */
  sides?: SideSpec[];
  /** P11: initial relations between the starting sides (-1 hostile, 0 neutral, 1 allied; symmetric).
   *  Absent = every pair hostile (the two-sided battle). */
  rel?: Relation[][];
  /** half-distance between the two fleets at start (default SPAWN_Z) */
  spawnZ?: number;
  /** Optional local experiment limit; ordinary and persistent battles retain TIME_LIMIT. */
  timeLimit?: number;
  /** persistent-world encounters: free-for-all retreat edge relative to spawn */
  backdrop?: string;
  /** 'ranks': very large fleets form up in several ranks instead of one endless line abreast
   *  (opt-in, so recorded battles keep their exact layout) */
  layout?: 'ranks';
  /** battle rules version. Absent/0 = the rules every battle recorded so far was fought under (replays and
   *  battles restored after a restart re-run their setup, so they keep them); new battles stamp
   *  BATTLE_RULES. 1 = P15.0 capital-ship rules: hull structure (World.applyHit), unguided plasma
   *  torpedoes and limited guided torpedoes (WeaponDef.p15), threat-aware secondary batteries and
   *  point-defence allocation (World.chooseMountTarget). 2 = P15.1 combat computers (ShipSpec.cpu →
   *  Ship.cpu, ai/computer.ts): per-ship engagement behaviour; without a computer nothing changes. */
  rules?: number;
}

/** the rules new battles are fought under (BattleSetup.rules) */
export const BATTLE_RULES = 2;

export const DT = 1 / 30;
export const FIELD_RADIUS = 3600;
export const SPAWN_Z = 1450;
export const TIME_LIMIT = 540;
/** P11: after a reinforcement the battle runs at least this long … */
export const JOIN_GRACE = 180;
/** … but never beyond this multiple of its time limit (and joins close a minute before) */
export const HARD_LIMIT_MUL = 2;

/** one side of a battle (P11). Ordinary battles: side 0 at -z, side 1 at +z. */
export interface SideInfo {
  key: string; name: string;
  /** unit direction (flat) from the battle centre toward this side's own edge: where it retreats to */
  home: Vec3;
  /** -home, exact: the direction it faces when it arrives */
  face: Vec3;
  /** top-level groups of this side (one per fleet that joined it) */
  roots: number[];
  joinedAt: number;
  /** set once the side has left the battle (it no longer counts for the outcome) */
  out: SideStatus | null;
  outAt: number;
}

const tmpA = new Vec3(), tmpB = new Vec3(), tmpC = new Vec3(), tmpD = new Vec3();

export class World {
  readonly dt = DT;
  tick = 0;
  time = 0;
  rng: Rng;
  lineRng: Rng;
  ships: Ship[] = [];
  groups: Group[] = [];
  shipById = new Map<number, Ship>();
  groupById = new Map<number, Group>();
  munitions: Munition[] = [];
  munitionById = new Map<number, Munition>();
  events: SimEvent[] = [];
  radioLog: RadioMsg[] = [];
  highlights: Highlight[] = [];
  outcome: Outcome | null = null;
  orderLog: OrderRecord[] = [];
  pending: OrderRecord[] = [];
  /** root group of each side (its first fleet) */
  roots: number[] = [];
  initialValue: number[] = [];
  routed: number[] = [];
  sides: SideInfo[] = [];
  /** relation matrix (symmetric); see hostile() */
  private rel: Relation[][] = [];
  /** something an ordinary two-sided battle never has: more than two sides, a relation other than
   *  hostile, a reinforcement, a withdrawal. Until then every rule runs exactly as before P11. */
  dynamic = false;
  /** world time of the last reinforcement (time limit extension) */
  lastJoin = -1;
  firstContact = -1;
  intensity = 0;
  /** BB-EX hulls in this battle (empty in every ordinary battle: none of the exotic code runs) */
  exShips: Ship[] = [];
  private nextId = 1;
  private radioId = 1;
  nextRadioId() { return this.radioId++; }
  readonly setup: BattleSetup;
  readonly spawnZ: number;
  /** BattleSetup.rules (0 = pre-P15 rules) */
  readonly rules: number;
  /** P15: point-defence mounts following each munition (kept current as mounts retarget) */
  private pdLoad = new Map<number, number>();

  constructor(setup: BattleSetup) {
    this.setup = setup;
    this.rules = setup.rules ?? 0;
    this.spawnZ = setup.spawnZ ?? SPAWN_Z;
    this.rng = new Rng(setup.seed);
    this.lineRng = new Rng(setup.seed ^ 0x5bd1e995);
    const n = setup.fleets.length;
    for (let k = 0; k < n; k++) this.addSide(setup.sides?.[k], this.startHome(k, n));
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) if (a !== b) this.rel[a][b] = setup.rel?.[a]?.[b] ?? -1;
    this.dynamic = n !== 2 || this.rel[0][1] !== -1 || this.rel[1][0] !== -1;
    for (let k = 0; k < n; k++) this.spawnTeam(k, setup.fleets[k], n === 2 ? undefined : { origin: this.sides[k].home.clone().scale(this.spawnZ), fwd: this.sides[k].face });
    if (this.exShips.length) placeEx(this);
    for (const g of this.groups) g.role = groupRoleOf(this, g);
    this.resolveInitialOrders(this.groups);
    for (const g of this.groups) {
      const ships = this.subtreeShips(g, true);
      g.initialHp = ships.reduce((a, s) => a + s.maxHp, 0);
      g.initialValue = ships.reduce((a, s) => a + s.value, 0);
    }
    for (const s of this.ships) this.initialValue[s.team] += s.value;
  }

  // ---------------------------------------------------------------- sides (P11)
  /** where a starting side stands: two sides face each other along z (exactly as before P11), more
   *  sides are spread evenly around the centre */
  private startHome(k: number, n: number): Vec3 {
    if (n === 2) return new Vec3(0, 0, k === 0 ? -1 : 1);
    const a = 2 * Math.PI * k / n;
    return new Vec3(Math.sin(a), 0, -Math.cos(a));
  }

  private addSide(spec: SideSpec | undefined, home: Vec3): number {
    const k = this.sides.length;
    this.sides.push({ key: spec?.key ?? `side${k}`, name: spec?.name ?? `진영 ${k + 1}`, home, face: new Vec3(-home.x || 0, 0, -home.z || 0), roots: [], joinedAt: this.time, out: null, outAt: -1 });
    this.roots.push(-1); this.initialValue.push(0); this.routed.push(-1);
    for (const row of this.rel) row.push(-1);
    this.rel.push(Array.from({ length: k + 1 }, (_, j) => (j === k ? 1 : (spec?.rel?.[j] ?? -1)) as Relation));
    for (let j = 0; j < k; j++) this.rel[j][k] = this.rel[k][j];
    return k;
  }

  /** will these two sides fight each other? (allied and neutral sides never do) */
  hostile(a: number, b: number): boolean { return a !== b && this.rel[a][b] < 0; }
  relation(a: number, b: number): Relation { return a === b ? 1 : this.rel[a][b]; }

  private setRelation(a: number, b: number, v: Relation) {
    if (a === b || !this.sides[a] || !this.sides[b] || this.rel[a][b] === v) return;
    this.rel[a][b] = this.rel[b][a] = v;
    this.events.push({ t: 'rel', a, b, v });
    // weapons let go of ships that are no longer enemies; commanders re-think soon
    for (const s of this.ships) if ((s.team === a || s.team === b) && s.state === 'alive') {
      for (const m of s.mounts) if (m.targetId >= 0) { const t = m.targetIsMunition ? this.munitionById.get(m.targetId) : this.shipById.get(m.targetId); if (t && !this.hostile(s.team, t.team)) { m.targetId = -1; m.retarget = 0; } }
      const t = this.shipById.get(s.ai.targetId); if (t && !this.hostile(s.team, t.team)) s.ai.targetId = -1;
    }
    for (const g of this.groups) if (g.team === a || g.team === b) {
      if (g.ai.mainTarget >= 0) { const t = this.groupById.get(g.ai.mainTarget); if (t && !this.hostile(g.team, t.team)) g.ai.mainTarget = -1; }
      if (g.order.type === 'attack' && !this.hostile(g.team, this.groupById.get(g.order.targetGroup)?.team ?? g.team)) { g.order = { type: 'engage' }; g.ai.lastOrderKey = 'engage'; }
      g.ai.nextThink = Math.min(g.ai.nextThink, this.time + 0.3);
    }
  }

  /** the time limit in force: a reinforcement extends it, up to a hard cap */
  timeLimit(): number {
    const base = this.setup.timeLimit ?? TIME_LIMIT;
    if (this.lastJoin < 0) return base;
    return Math.min(base * HARD_LIMIT_MUL, Math.max(base, this.lastJoin + JOIN_GRACE));
  }
  /** can a reinforcement still join? (not after the end, not in the last minute before the hard cap) */
  joinOpen(): boolean { return !this.outcome && this.time < (this.setup.timeLimit ?? TIME_LIMIT) * HARD_LIMIT_MUL - 60; }

  /** schedule a battle event at an explicit tick (server-stamped, like an order) */
  scheduleEvent(tick: number, ev: BattleEvent): OrderRecord {
    const rec: OrderRecord = { tick, groupId: -1, order: null, ev: JSON.parse(JSON.stringify(ev)) };
    this.scheduleOrder(rec);
    return rec;
  }

  private applyEvent(ev: BattleEvent) {
    if (this.outcome) return;
    this.dynamic = true;
    if (ev.k === 'rel') { this.setRelation(ev.a, ev.b, ev.v); return; }
    if (ev.k === 'withdraw') {
      const side = this.sides[ev.side]; if (!side || side.out) return;
      for (const g of this.groups) if (g.team === ev.side) { g.order = { type: 'retreat' }; g.ai.lastOrderKey = 'retreat'; g.playerOverride = true; }
      const root = this.groupById.get(this.roots[ev.side]); if (root) { root.ai.lastRadio = -99; this.say(root, 'retreat_auto', {}, 2); }
      return;
    }
    this.join(ev);
  }

  /** a fleet arrives in the running battle (P11): it is built exactly like a starting fleet, placed at
   *  its entry point facing the fight, and joins an existing side or forms a new one. Nothing that is
   *  already in the battle is touched. */
  private join(ev: Extract<BattleEvent, { k: 'join' }>) {
    const ex = ev.entry;
    let k: number;
    const at = new Vec3(ex.x, 0, ex.z);
    const fwd = ex.fx !== undefined && ex.fz !== undefined && Math.hypot(ex.fx, ex.fz) > 1e-6 ? new Vec3(ex.fx, 0, ex.fz).normalize() : at.lengthSq() > 1 ? at.clone().scale(-1).normalize() : new Vec3(0, 0, 1);
    if (typeof ev.side === 'number') {
      k = ev.side;
      if (!this.sides[k]) return;
      if (this.sides[k].out) { this.sides[k].out = null; this.sides[k].outAt = -1; this.routed[k] = -1; }
    } else {
      k = this.addSide(ev.side, new Vec3(-fwd.x, 0, -fwd.z));
      this.sides[k].face = new Vec3(fwd.x || 0, 0, fwd.z || 0);
    }
    const g0 = this.groups.length, s0 = this.ships.length, x0 = this.exShips.length;
    this.spawnTeam(k, ev.fleet, { origin: at, fwd });
    const groups = this.groups.slice(g0), ships = this.ships.slice(s0);
    if (this.exShips.length > x0) placeEx(this, this.exShips.slice(x0));
    for (const g of groups) g.role = groupRoleOf(this, g);
    this.resolveInitialOrders(groups);
    for (const g of groups) {
      const ss = this.subtreeShips(g, true);
      g.initialHp = ss.reduce((a, s) => a + s.maxHp, 0);
      g.initialValue = ss.reduce((a, s) => a + s.value, 0);
    }
    for (const s of ships) this.initialValue[k] += s.value;
    this.lastJoin = this.time;
    this.events.push({ t: 'join', side: k, groups: groups.map(g => g.id), ships: ships.map(s => s.id) });
    const root = groups[0];
    if (root) { root.ai.lastRadio = -99; this.say(root, 'engage_start', {}, 2); }
  }

  // ---------------------------------------------------------------- spawning
  private spawnTeam(team: Team, fleet: FleetSpec, frame?: { origin: Vec3; fwd: Vec3 }) {
    const nameRng = new Rng(hashString(fleet.name) ^ (this.setup.seed * 7919));
    const names = [...SHIP_NAMES[team % 2]];
    const takeName = () => (names.length ? names.splice(nameRng.int(names.length), 1)[0] : `함선-${this.nextId}`);
    const build = (spec: GroupSpec, parent: Group | null, depth: number): Group => {
      const cmd = spec.commander ?? getCommander(spec.commanderId);
      const commander: CommanderDef = cmd ?? { ...ACTING_CAPTAIN, team: (team % 2) as 0 | 1 };
      const g: Group = {
        id: this.nextId++, team, name: spec.name, parentId: parent ? parent.id : null, childIds: [], shipIds: [],
        commander, hasCommander: !!cmd, order: { type: 'engage' }, playerOverride: false, retreatAt: spec.retreatAt ?? 0,
        initialHp: 0, initialValue: 0, depth, escortHint: spec.escortTarget ?? null, role: 'line',
        stats: { kills: 0, killValue: 0, lost: 0, dmgDealt: 0 }, ref: spec.ref, ...(spec.independent ? { independent: true } : {}),
        ai: {
          nextThink: 0.5 + this.rng.range(0, 1.2), mainTarget: -1, shipTarget: -1, phase: 'none', waypoint: null, goal: new Vec3(), face: null,
          preferredRange: 900, lastRadio: -99, threatGroup: -1, lastOrderKey: '', committedAt: 0, kiting: false, confused: 0, reactDelay: 0,
          hpHistory: [], announcedEngage: false, routed: false, orderIssuedAt: 0, holdPoint: null,
        },
      };
      (g as any)._initial = spec.order;
      this.groups.push(g); this.groupById.set(g.id, g);
      if (parent) parent.childIds.push(g.id);
      for (const ss of spec.ships) {
        const s = this.createShip(team, ss.classId, ss.loadoutId, ss.name || takeName(), g, ss.fx, ss.fit, ss.ex);
        // P15.1: a fitted combat computer drives the ship's own behaviour only under rules 2
        if (this.rules >= 2 && ss.cpu && ss.cpu.arch !== 'basic' && CPU_ARCHS.includes(ss.cpu.arch)) s.cpu = initCpu(ss.cpu, s.id);
        if (ss.ref !== undefined) s.ref = ss.ref;
        if (ss.hp !== undefined) s.hp = Math.max(1, s.maxHp * Math.min(1, ss.hp));
        g.shipIds.push(s.id);
      }
      for (const c of spec.children) build(c, g, depth + 1);
      return g;
    };
    const g0 = this.groups.length;
    const root = build(fleet.root, null, 0);
    if (this.roots[team] < 0) this.roots[team] = root.id;
    this.sides[team].roots.push(root.id);
    this.layoutTeam(team, this.groups.slice(g0).filter(g => g.shipIds.length > 0), frame);
  }

  private createShip(team: Team, classId: string, loadoutId: string, name: string, g: Group, fx: ShipFx = {}, fit?: ShipSpec['fit'], exSpec?: ShipSpec['ex']): Ship {
    const cls = SHIP_CLASSES[classId];
    const base = getLoadout(classId, loadoutId);
    // a fitted ship fights with exactly what is mounted on it (renderer turrets follow the same mounts)
    const lo: LoadoutDef = fit ? { id: base.id, name: fit.name, desc: '', mounts: fit.mounts, hpMul: fit.hpMul, armorMul: fit.armorMul, speedMul: fit.speedMul, costDelta: base.costDelta, ...(fit.mesh ? { mesh: fit.mesh } : {}) } : base;
    const cmd = g.commander;
    const spec = cmd.specialty;
    // B-1 officer effects (only present when the battle setup carries them: the world resolved and capped them)
    const ox = cmd.ofx;
    const o = (k: string) => ox?.[k] ?? 0;
    const speedMul = (lo.speedMul ?? 1) * (spec === 'maneuver' ? 1.08 : 1) * (fx.speedMul ?? 1) * (ox ? 1 + o('speed') : 1);
    const armorMul = (lo.armorMul ?? 1) * (fx.armorMul ?? 1) * (ox ? 1 + o('armor') : 1);
    const hp = cls.hp * (lo.hpMul ?? 1) * (fx.hpMul ?? 1) * (ox ? 1 + o('hp') : 1);
    // range / reload changes are baked into per-mount weapon copies (deterministic, replay-safe)
    const wmod = (id: string) => {
      const w = WEAPONS[id]; const fm = w.family ? fx.fam?.[w.family] : undefined;
      let r = (w.kind === 'pd' ? 1 : fx.rangeMul ?? 1) * (fm?.range ?? 1), rl = (fx.reloadMul ?? 1) * (fm?.reload ?? 1);
      const mg = fx.magMul ?? 1, dm = fm?.dmg ?? 1;
      if (ox) { if (w.kind === 'pd') r *= 1 + o('pdRange'); else { rl *= 1 - o('rof'); if (w.kind === 'shell') r *= 1 + o('gunRange'); } }
      if (r === 1 && rl === 1 && dm === 1 && (mg === 1 || w.magazine === undefined)) return w;
      const out = { ...w, range: w.range * r, reload: w.reload * rl, magazine: w.magazine !== undefined ? Math.round(w.magazine * mg) : undefined };
      if (dm !== 1) out.damage = w.damage * dm;
      return out;
    };
    const s: Ship = {
      id: this.nextId++, team, name, cls, loadout: lo, role: cls.role, groupId: g.id,
      pos: new Vec3(), prevPos: new Vec3(), vel: new Vec3(), yaw: team === 0 ? 0 : Math.PI, pitch: 0, prevYaw: 0, prevPitch: 0, fwd: new Vec3(0, 0, 1),
      hp, maxHp: hp,
      armor: { front: cls.armor.front * armorMul, side: cls.armor.side * armorMul, rear: cls.armor.rear * armorMul },
      maxSpeed: cls.maxSpeed * speedMul, accel: cls.accel * speedMul * (ox ? 1 + o('accel') : 1), turnRate: cls.turnRate * (spec === 'maneuver' ? 1.15 : 1) * (ox ? 1 + o('turn') : 1) * Math.PI / 180,
      lateral: cls.lateral, radius: cls.radius, halfLen: cls.length / 2,
      mounts: [], state: 'alive', dyingTimer: 0, deathTime: 0,
      crit: { engine: 0, fire: 0, bridge: 0 },
      ai: { moveTo: new Vec3(), faceTo: null, speedCap: cls.maxSpeed, targetId: -1, run: null, jink: this.rng.range(0, 10), lastRetarget: 0 },
      stats: { dmgDealt: 0, dmgTaken: 0, kills: 0, killValue: 0, shots: 0, hits: 0, ricochets: 0, intercepts: 0, torpHits: 0, rearHits: 0 },
      gunnery: (0.75 + 0.4 * cmd.skill + (spec === 'gunnery' ? 0.22 : 0)) * (fx.accMul ?? 1) * (ox ? 1 + o('acc') : 1),
      pdBonus: (1 + (spec === 'defense' ? 0.3 : 0) + cmd.skill * 0.15) * (fx.pdMul ?? 1) * (ox ? 1 + o('pd') : 1),
      evasion: fx.evasion ?? 0,
      value: shipCost(classId, loadoutId), recentDamage: 0, lastAttacker: -1, throttle: 0, killedBy: -1,
    };
    if (ox) s.ofx = ox;
    if (fx.shield) { s.maxShield = s.shield = hp * fx.shield; s.shieldRegen = fx.shieldRegen ?? 0.02; s.shieldHitAt = -99; }
    lo.mounts.forEach((md, i) => {
      const f = md.facing * Math.PI / 180;
      const mount: Mount = {
        index: i, def: md, weapon: wmod(md.weapon), facingLocal: new Vec3(Math.sin(f), 0, Math.cos(f)),
        aim: new Vec3(), cooldown: this.rng.range(0, WEAPONS[md.weapon].reload), salvoLeft: 0, salvoTimer: 0,
        targetId: -1, targetIsMunition: false, retarget: this.rng.range(0, 0.4), disabled: 0, lastFire: -99, ammo: this.magazineOf(wmod(md.weapon), fx),
      };
      s.mounts.push(mount);
    });
    this.ships.push(s); this.shipById.set(s.id, s);
    if (cls.id === BBEX_CLASS) initEx(this, s, exSpec, !!cmd.causal);
    return s;
  }

  /** salvos a mount carries: the weapon's magazine; under P15 rules also a guided torpedo's (WeaponDef.p15) */
  private magazineOf(w: WeaponDef, fx: ShipFx): number {
    if (w.magazine !== undefined) return w.magazine;
    if (this.rules >= 1 && w.p15?.magazine !== undefined) return Math.max(1, Math.round(w.p15.magazine * (fx.magMul ?? 1)));
    return Infinity;
  }
  /** P15: an unguided weapon in this battle (it leaves on a lead solution like a shell) */
  unguided(w: WeaponDef): boolean { return this.rules >= 1 && !!w.p15?.unguided; }

  /** formation of a fleet's leaf groups. Without a frame: the classic layout (side 0 at -z facing +z,
   *  side 1 mirrored at +z). With a frame (more than two sides, reinforcements): the side-0 layout
   *  around the origin, turned to face `fwd`. */
  private layoutTeam(team: Team, leaves: Group[], frame?: { origin: Vec3; fwd: Vec3 }) {
    const zSign = team === 0 || frame ? -1 : 1;
    const baseZ = frame ? 0 : this.spawnZ * zSign;
    const roleOf = (g: Group) => groupRoleOf(this, g);
    const lines = leaves.filter(g => roleOf(g) === 'line');
    const escorts = leaves.filter(g => roleOf(g) === 'escort');
    const raiders = leaves.filter(g => roleOf(g) === 'raider');
    const civilians = leaves.filter(g => roleOf(g) === 'civilian');
    const spacingOf = (g: Group) => Math.max(...g.shipIds.map(id => this.shipById.get(id)!.radius)) * 9 + 30;
    const widthOf = (g: Group) => spacingOf(g) * g.shipIds.length;
    let totalW = lines.reduce((a, g) => a + widthOf(g) + 80, 0);
    let x = -totalW / 2;
    const place = (g: Group, cx: number, cz: number) => {
      const sp = spacingOf(g);
      g.shipIds.forEach((id, i) => {
        const s = this.shipById.get(id)!;
        const lat = (i - (g.shipIds.length - 1) / 2) * sp;
        s.pos.set(cx + lat, ((i % 3) - 1) * 14 + this.rng.range(-4, 4), cz + (i % 2) * 18 * zSign);
        s.prevPos.copy(s.pos);
        s.ai.moveTo.copy(s.pos);
        s.yaw = team === 0 || frame ? 0 : Math.PI; s.prevYaw = s.yaw;
        dirFromYawPitch(s.yaw, 0, s.fwd);
        s.vel.copy(s.fwd).scale(s.maxSpeed * 0.3);
      });
      g.ai.holdPoint = new Vec3(cx, 0, cz);
      g.ai.goal.set(cx, 0, cz);
    };
    if (this.setup.layout === 'ranks') {
      // decisive-fleet formation: battle line in ranks of ≤ RANK_W, heaviest in front; escorts form
      // their own ranks ahead of the line
      const RANK_W = 3000;
      const ranks = (gs: Group[], z0: number, dz: number) => {
        const rows: Group[][] = [[]]; let rw = 0;
        for (const g of gs) { const w = widthOf(g) + 80; if (rw + w > RANK_W && rows[rows.length - 1].length) { rows.push([]); rw = 0; } rows[rows.length - 1].push(g); rw += w; }
        rows.forEach((row, ri) => {
          const tw = row.reduce((a, g) => a + widthOf(g) + 80, 0); let rx = -tw / 2;
          for (const g of row) { const w = widthOf(g); place(g, rx + w / 2, z0 + ri * dz); rx += w + 80; }
        });
        return rows;
      };
      const rows = ranks(lines, baseZ, zSign * 210);
      totalW = rows.length ? Math.min(RANK_W, Math.max(...rows.map(r => r.reduce((a, g) => a + widthOf(g) + 80, 0)))) : 0;
      ranks(escorts, baseZ - zSign * 150, -zSign * 110);
    } else {
    for (const g of lines) { const w = widthOf(g); place(g, x + w / 2, baseZ); x += w + 80; }
    if (lines.length === 0) totalW = 0;
    escorts.forEach((g, i) => {
      const off = escorts.length > 1 ? (i - (escorts.length - 1) / 2) * (totalW / Math.max(1, escorts.length)) : 0;
      place(g, off, baseZ - zSign * 130);
    });
    }
    let wingL = -totalW / 2 - 260, wingR = totalW / 2 + 260;
    raiders.forEach((g, i) => {
      const w = widthOf(g);
      if (i % 2 === 0) { place(g, wingR + w / 2, baseZ + zSign * 60); wingR += w + 120; }
      else { place(g, wingL - w / 2, baseZ + zSign * 60); wingL -= w + 120; }
    });
    civilians.forEach((g, i) => place(g, (i - (civilians.length - 1) / 2) * 260, baseZ + zSign * 320));
    if (frame) {
      // canonical +z forward, +x → right of the new facing
      const f = frame.fwd, O = frame.origin, rx = f.z, rz = -f.x;
      const tx = (v: Vec3) => { const x = v.x, z = v.z; v.x = O.x + rx * x + f.x * z; v.z = O.z + rz * x + f.z * z; };
      const yaw = Math.atan2(f.x, f.z);
      for (const g of leaves) {
        for (const id of g.shipIds) {
          const s = this.shipById.get(id)!;
          tx(s.pos); s.prevPos.copy(s.pos); s.ai.moveTo.copy(s.pos);
          s.yaw = yaw; s.prevYaw = yaw; dirFromYawPitch(yaw, 0, s.fwd); s.vel.copy(s.fwd).scale(s.maxSpeed * 0.3);
        }
        if (g.ai.holdPoint) { tx(g.ai.holdPoint); tx(g.ai.goal); }
      }
      return;
    }
    // team 1 mirrors x so its "left" matches its own facing
    if (team === 1) for (const g of leaves) for (const id of g.shipIds) { const s = this.shipById.get(id)!; s.pos.x *= -1; s.prevPos.copy(s.pos); s.ai.moveTo.copy(s.pos); }
    if (team === 1) for (const g of leaves) if (g.ai.holdPoint) { g.ai.holdPoint.x *= -1; g.ai.goal.x *= -1; }
  }

  private resolveInitialOrders(groups: Group[]) {
    for (const g of groups) {
      const init = (g as any)._initial as string;
      const isRoot = g.parentId === null;
      let order: Order | null = null;
      switch (init) {
        case 'auto': order = isRoot ? { type: 'engage' } : null; break;
        case 'engage': order = { type: 'engage' }; break;
        case 'flank_left': order = { type: 'flank', side: 1 }; break;   // +x local is port/left
        case 'flank_right': order = { type: 'flank', side: -1 }; break;
        case 'escort': {
          const guard = this.findEscortCandidate(g);
          order = guard ? { type: 'escort', guardGroup: guard.id } : { type: 'engage' };
          break;
        }
        case 'hold': order = { type: 'hold' }; break;
        case 'reserve': order = { type: 'reserve' }; break;
        case 'retreat': order = { type: 'retreat' }; break;
        default: order = null;
      }
      if (order) { g.order = order; g.playerOverride = !isRoot; }
      else { g.order = { type: 'engage' }; g.playerOverride = false; }
      g.ai.lastOrderKey = orderKey(g.order);
      delete (g as any)._initial;
    }
  }

  findEscortCandidate(g: Group): Group | null {
    let best: Group | null = null, bestV = 0;
    for (const o of this.groups) {
      if (o.team !== g.team || o.id === g.id || o.shipIds.length === 0) continue;
      if (this.isAncestor(g, o)) continue;
      if (this.topOf(o) !== this.topOf(g)) continue;   // never another fleet's (company's) group
      const ships = this.subtreeShips(o);
      const v = ships.reduce((a, s) => a + (s.role === 'line' ? s.value : 0), 0);
      // prefer siblings
      const bonus = o.parentId === g.parentId ? 1.3 : 1;
      if (v * bonus > bestV) { bestV = v * bonus; best = o; }
    }
    return best;
  }

  /** the top-level group a group belongs to (its fleet root, or an independent fleet under a shared root) */
  topOf(g: Group): number {
    let x = g;
    while (x.parentId !== null && !x.independent) x = this.groupById.get(x.parentId)!;
    return x.id;
  }

  isAncestor(a: Group, b: Group): boolean {
    let p = b.parentId;
    while (p !== null) { if (p === a.id) return true; p = this.groupById.get(p)!.parentId; }
    return false;
  }

  // ---------------------------------------------------------------- queries
  subtreeShips(g: Group, includeAll = false, out: Ship[] = []): Ship[] {
    for (const id of g.shipIds) {
      const s = this.shipById.get(id)!;
      if (includeAll || s.state === 'alive') out.push(s);
    }
    for (const c of g.childIds) this.subtreeShips(this.groupById.get(c)!, includeAll, out);
    return out;
  }

  directShips(g: Group): Ship[] {
    const out: Ship[] = [];
    for (const id of g.shipIds) { const s = this.shipById.get(id)!; if (s.state === 'alive') out.push(s); }
    return out;
  }

  centroid(ships: Ship[], out = new Vec3()): Vec3 {
    out.set(0, 0, 0);
    if (!ships.length) return out;
    for (const s of ships) out.add(s.pos);
    return out.scale(1 / ships.length);
  }

  groupCenter(g: Group, out = new Vec3()): Vec3 { return this.centroid(this.subtreeShips(g), out); }

  aliveEnemyShips(team: Team): Ship[] { return this.ships.filter(s => this.hostile(team, s.team) && s.state === 'alive'); }

  /** leaf groups (with live ships) of every side hostile to `team`, in creation order */
  hostileLeafGroups(team: Team): Group[] {
    return this.groups.filter(g => this.hostile(team, g.team) && g.shipIds.some(id => this.shipById.get(id)!.state === 'alive'));
  }

  leafGroups(team: Team): Group[] {
    return this.groups.filter(g => g.team === team && g.shipIds.some(id => this.shipById.get(id)!.state === 'alive'));
  }

  groupHpFrac(g: Group): number {
    if (g.initialHp <= 0) return 0;
    return this.subtreeShips(g).reduce((a, s) => a + s.hp, 0) / g.initialHp;
  }

  teamValueFrac(team: Team): number {
    let v = 0;
    for (const s of this.ships) if (s.team === team && (s.state === 'alive' || s.state === 'inbound')) v += s.value * (0.35 + 0.65 * s.hp / s.maxHp);
    return v / Math.max(1, this.initialValue[team]);
  }

  // ---------------------------------------------------------------- orders
  issueOrder(groupId: number, order: Order | null, opts: { retreatAt?: number; release?: boolean } = {}) {
    this.pending.push({ tick: this.tick, groupId, order: order ? JSON.parse(JSON.stringify(order)) : null, retreatAt: opts.retreatAt, release: opts.release });
  }

  private applyPending() {
    if (!this.pending.length) return;
    for (const rec of this.pending) {
      if (rec.tick === undefined || rec.tick < this.tick || !(rec as any)._stamped) rec.tick = this.tick;
      this.orderLog.push(rec);
      this.applyOrderRecord(rec);
    }
    this.pending.length = 0;
  }

  /** replay helper: schedule records to apply at their recorded ticks */
  private scheduled: OrderRecord[] = [];
  scheduleReplay(records: OrderRecord[]) { this.scheduled = records.slice().sort((a, b) => a.tick - b.tick); }

  /** lockstep: schedule one order at an explicit tick (server-stamped) */
  scheduleOrder(rec: OrderRecord) {
    this.scheduled.push(rec);
    this.scheduled.sort((a, b) => a.tick - b.tick);
  }

  private applyOrderRecord(rec: OrderRecord) {
    if (rec.ev) { this.applyEvent(rec.ev); return; }
    const g = this.groupById.get(rec.groupId);
    if (!g) return;
    if (rec.retreatAt !== undefined) g.retreatAt = rec.retreatAt;
    if (rec.release) {
      g.playerOverride = false;
      g.ai.nextThink = this.time + 0.3;
      if (g.parentId !== null) this.groupById.get(g.parentId)!.ai.nextThink = this.time + 0.2;
      this.say(g, 'ack_release', {}, 1);
      return;
    }
    if (!rec.order) return;
    const o = rec.order;
    if (o.type === 'hold' && !o.point) {
      const c = this.groupCenter(g);
      o.point = { x: c.x, y: c.y, z: c.z };
    }
    const disliked = (o.type === 'retreat' && g.commander.aggression > 0.8) || (o.type === 'hold' && g.commander.aggression > 0.85) || (o.type === 'escort' && g.commander.aggression > 0.85);
    this.setOrder(g, o, true);
    g.ai.orderIssuedAt = this.time;
    const targetName = this.orderTargetName(o);
    if (disliked && g.commander.discipline < 0.5) this.say(g, 'reluctant', {}, 1);
    else this.say(g, 'ack_' + o.type, { t: targetName }, 1);
  }

  orderTargetName(o: Order): string {
    if (o.type === 'attack') {
      if (o.targetShip !== undefined) { const s = this.shipById.get(o.targetShip); if (s) return s.name; }
      return this.groupById.get(o.targetGroup)?.name ?? '표적';
    }
    if (o.type === 'flank' && o.targetGroup !== undefined) return this.groupById.get(o.targetGroup)?.name ?? '적';
    if (o.type === 'flank') return '적';
    if (o.type === 'escort') return this.groupById.get(o.guardGroup)?.name ?? '아군';
    return '';
  }

  setOrder(g: Group, o: Order, byPlayer: boolean) {
    g.order = o;
    if (byPlayer) g.playerOverride = true;
    const key = orderKey(o);
    if (key !== g.ai.lastOrderKey) {
      g.ai.lastOrderKey = key;
      g.ai.phase = 'none';
      g.ai.waypoint = null;
      g.ai.kiting = false;
      g.ai.committedAt = this.time;
      if (o.type === 'hold' && o.point) g.ai.holdPoint = new Vec3(o.point.x, o.point.y, o.point.z);
      if (o.type === 'reserve') g.ai.holdPoint = this.groupCenter(g);
      const sk = g.commander.skill;
      const delay = byPlayer ? lerp(1.6, 0.25, sk) : lerp(2.2, 0.4, sk);
      g.ai.nextThink = Math.min(g.ai.nextThink, this.time + delay);
      if (o.type === 'flank' && sk < 0.42 && this.rng.chance(0.45 - sk * 0.5)) {
        g.ai.confused = this.time + 14;
      }
    }
  }

  // ---------------------------------------------------------------- radio
  say(g: Group, key: string, params: Record<string, string | number> = {}, priority: 0 | 1 | 2 = 0, pos?: Vec3 | null, shipId?: number) {
    const gap = priority === 2 ? 0 : priority === 1 ? 1.2 : 5;
    if (this.time - g.ai.lastRadio < gap) return;
    g.ai.lastRadio = this.time;
    const c = g.commander;
    const text = line(key, c.voice, this.lineRng, params);
    const p = pos ?? this.groupCenter(g);
    const msg: RadioMsg = {
      id: this.radioId++, time: this.time, team: g.team, groupId: g.id,
      who: c.rank ? `${c.rank} ${c.name}` : `${g.name} ${c.name}`, rank: c.rank, color: c.color,
      text, priority, pos: { x: p.x, y: p.y, z: p.z }, shipId,
    };
    this.radioLog.push(msg);
    this.events.push({ t: 'radio', msg });
  }

  // ---------------------------------------------------------------- step
  step() {
    if (this.outcome) return;
    this.events.length = 0;
    while (this.scheduled.length && this.scheduled[0].tick <= this.tick) {
      const rec = this.scheduled.shift()!;
      (rec as any)._stamped = true;
      this.pending.push(rec);
    }
    this.applyPending();
    for (const s of this.ships) { s.prevPos.copy(s.pos); s.prevYaw = s.yaw; s.prevPitch = s.pitch; }
    for (const m of this.munitions) m.prevPos.copy(m.pos);

    updateAI(this);
    if (this.exShips.length) exSteer(this);
    // move everything first, then fire, so neither team sees fresher positions than the other
    for (const s of this.ships) {
      if (s.state === 'alive') this.moveShip(s);
      else if (s.state === 'dying') this.updateDying(s);
    }
    if (this.exShips.length) updateEx(this);
    if (this.rules >= 1) {
      // P15: which rounds point defence is following (rebuilt each tick; mounts adjust it as they retarget)
      this.pdLoad.clear();
      if (this.munitions.length) for (const s of this.ships) if (s.state === 'alive') for (const m of s.mounts) if (m.targetIsMunition && m.targetId >= 0) this.pdLoad.set(m.targetId, (this.pdLoad.get(m.targetId) ?? 0) + 1);
    }
    for (const s of this.ships) if (s.state === 'alive') { this.updateWeapons(s); this.updateStatus(s); }
    this.updateMunitions();
    this.intensity *= Math.exp(-this.dt / 3);
    this.tick++;
    this.time = this.tick * this.dt;
    if (this.tick % 15 === 0) this.checkOutcome();
  }

  // ---------------------------------------------------------------- movement
  private moveShip(s: Ship) {
    const dt = this.dt;
    const ai = s.ai;
    let engineMul = s.crit.engine > 0 ? 0.5 : 1;
    if (s.ofx) engineMul *= this.officerSpeed(s);
    const maxSpeed = s.maxSpeed * engineMul;
    const accel = s.accel * engineMul;
    const desired = tmpA.subVectors(ai.moveTo, s.pos);
    const dist = desired.length();
    let spd = Math.min(ai.speedCap * engineMul, maxSpeed, dist * (s.role === 'raider' ? 1.2 : 0.4));
    if (dist < 6) spd = 0;
    if (dist > 1e-6) desired.scale(spd / dist); else desired.set(0, 0, 0);

    // separation
    const sep = tmpB.set(0, 0, 0);
    for (const o of this.ships) {
      if (o === s || o.state !== 'alive') continue;
      const minD = (s.radius + o.radius) * 2.6 + 14 + (o.team === s.team ? 0 : 10);
      const dx = s.pos.x - o.pos.x, dy = s.pos.y - o.pos.y, dz = s.pos.z - o.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minD * minD && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (1 - d / minD) * (o.radius > s.radius ? 1.6 : 0.8);
        sep.x += dx / d * push; sep.y += dy / d * push; sep.z += dz / d * push;
      }
    }
    desired.addScaled(sep, maxSpeed * 0.8);

    // jinking for raiders under threat
    if (s.role === 'raider' && spd > 20) {
      ai.jink += dt;
      const side = tmpC.crossVectors(desired, UP).normalize();
      desired.addScaled(side, Math.sin(ai.jink * 1.7) * 18).addScaled(UP, Math.cos(ai.jink * 1.3) * 10);
    }
    // field bounds
    const r = Math.hypot(s.pos.x, s.pos.z);
    const g = this.groupById.get(s.groupId)!;
    if (r > FIELD_RADIUS && g.order.type !== 'retreat') desired.addScaled(tmpC.set(-s.pos.x / r, 0, -s.pos.z / r), (r - FIELD_RADIUS) * 0.5);
    // keep battle roughly near the plane
    if (Math.abs(s.pos.y) > 260) desired.y -= (s.pos.y - Math.sign(s.pos.y) * 260) * 0.4;

    // facing
    let faceDir: Vec3;
    const dlen = desired.length();
    // P15.1: a ship whose computer is steering keeps the facing the computer chose, whatever its role
    if ((s.role === 'raider' && !(s.cpu && s.cpu.acting !== 'basic')) || !ai.faceTo) {
      faceDir = dlen > 2 ? tmpC.copy(desired) : (ai.faceTo ? tmpC.subVectors(ai.faceTo, s.pos) : tmpC.copy(s.fwd));
    } else {
      faceDir = tmpC.subVectors(ai.faceTo, s.pos);
      // when travelling far, face the travel direction
      if (dist > 700 && dlen > maxSpeed * 0.6) faceDir.copy(desired);
    }
    const tYaw = yawOf(faceDir);
    const tPitch = clamp(pitchOf(faceDir), -0.4, 0.4);
    const turn = s.turnRate * dt * (s.crit.bridge > 0 ? 0.6 : 1);
    const dy = wrapAngle(tYaw - s.yaw);
    s.yaw = wrapAngle(s.yaw + clamp(dy, -turn, turn));
    const dp = tPitch - s.pitch;
    s.pitch += clamp(dp, -turn * 0.6, turn * 0.6);
    dirFromYawPitch(s.yaw, s.pitch, s.fwd);

    // speed limited by facing (main drive is aft)
    if (dlen > 1e-6) {
      const cosA = clamp(s.fwd.dot(desired) / dlen, -1, 1);
      const allowed = maxSpeed * lerp(s.lateral, 1, Math.max(0, cosA));
      desired.clampLength(allowed);
    }
    // accelerate toward desired velocity
    const dv = tmpD.subVectors(desired, s.vel);
    const dvl = dv.length();
    const maxDv = accel * dt;
    if (dvl > maxDv) dv.scale(maxDv / dvl);
    s.vel.add(dv);
    s.pos.addScaled(s.vel, dt);
    s.throttle = lerp(s.throttle, clamp(s.vel.length() / s.maxSpeed, 0, 1), 0.1);
  }

  private updateStatus(s: Ship) {
    const dt = this.dt;
    s.recentDamage *= Math.exp(-dt / 1.6);
    // B-1 emergency repair: after 4 s without a hull hit, up to a total share of the hull per battle
    if (s.ofx?.regen && s.hp < s.maxHp && this.time - (s.ofHit ?? -99) > 4) {
      const room = s.maxHp * (0.1 + (s.ofx.regenCap ?? 0)) - (s.ofHeal ?? 0);
      if (room > 0) { const h = Math.min(room, s.maxHp - s.hp, s.maxHp * s.ofx.regen * dt); s.hp += h; s.ofHeal = (s.ofHeal ?? 0) + h; }
    }
    // shields recover once the ship has not been hit for 4 s
    if (s.maxShield && s.shield! < s.maxShield && this.time - (s.shieldHitAt ?? -99) > 4) s.shield = Math.min(s.maxShield, s.shield! + s.maxShield * (s.shieldRegen ?? 0) * dt);
    if (s.crit.engine > 0) s.crit.engine -= dt;
    if (s.crit.bridge > 0) s.crit.bridge -= dt;
    if (s.crit.fire > 0) {
      s.crit.fire -= dt;
      const dmg = s.maxHp * 0.006 * dt * (s.ofx?.fire ? 1 - s.ofx.fire : 1);
      s.hp -= dmg; s.stats.dmgTaken += dmg;
      if (s.hp <= 0) this.startDying(s, s.lastAttacker, false, 'fire');
    }
  }

  // ---------------------------------------------------------------- weapons
  private updateWeapons(s: Ship) {
    const dt = this.dt;
    if (s.ex && !exWeaponsFree(s)) return;
    for (const m of s.mounts) {
      if (m.weapon.special) continue;   // driven by its own system (DCP-Ω)
      if (m.disabled > 0) { m.disabled -= dt; continue; }
      m.cooldown -= dt;
      m.retarget -= dt;
      // re-acquire immediately when the current target is gone (critical for point defense)
      if (m.targetId >= 0 && (m.targetIsMunition ? !this.munitionById.get(m.targetId) || this.munitionById.get(m.targetId)!.dead : this.shipById.get(m.targetId)?.state !== 'alive')) m.retarget = 0;
      if (m.retarget <= 0) { this.chooseMountTarget(s, m); m.retarget = (m.weapon.kind === 'pd' ? 0.15 : 0.3) + this.rng.range(0, 0.25); }
      // validate target
      let tPos: Vec3 | null = null;
      let tVel: Vec3 | null = null;
      if (m.targetId >= 0) {
        if (m.targetIsMunition) {
          const mu = this.munitionById.get(m.targetId);
          if (mu && !mu.dead) { tPos = mu.pos; tVel = mu.vel; } else m.targetId = -1;
        } else {
          const t = this.shipById.get(m.targetId);
          if (t && t.state === 'alive') { tPos = t.pos; tVel = t.vel; } else m.targetId = -1;
        }
      }
      const muzzle = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, s.pos, s.yaw, s.pitch, tmpA);
      const desiredDir = tmpB;
      if (tPos) {
        if (m.weapon.kind === 'shell' || this.unguided(m.weapon)) {
          // lead prediction
          let tt = muzzle.distTo(tPos) / m.weapon.speed;
          for (let k = 0; k < 2; k++) {
            desiredDir.set(tPos.x + tVel!.x * tt - muzzle.x, tPos.y + tVel!.y * tt - muzzle.y, tPos.z + tVel!.z * tt - muzzle.z);
            tt = desiredDir.length() / m.weapon.speed;
          }
        } else desiredDir.subVectors(tPos, muzzle);
        const dist = desiredDir.length();
        desiredDir.normalize();
        // arc check
        const local = worldDirToLocal(desiredDir, s.yaw, s.pitch, tmpC);
        const inArc = angleBetween(local, m.facingLocal) <= m.def.arc * Math.PI / 180;
        const inRange = dist <= m.weapon.range * (m.weapon.kind === 'torpedo' ? this.torpRangeFactor(s) : 1);
        if (!inArc || dist > m.weapon.range * 1.05) { m.targetId = -1; m.retarget = Math.min(m.retarget, 0.1); }
        // traverse
        if (m.aim.lengthSq() < 0.5) m.aim.copy(localToWorld(m.facingLocal, new Vec3(), s.yaw, s.pitch, tmpD));
        rotateToward(m.aim, desiredDir, m.weapon.turnSpeed * Math.PI / 180 * dt);
        if (!inArc || !inRange) continue;
        const err = angleBetween(m.aim, desiredDir);
        const tol = m.weapon.kind === 'shell' ? 0.03 : m.weapon.kind === 'pd' ? 0.15 : 3.2;
        if (err > tol) continue;
        if (m.weapon.kind === 'pd') {
          if (m.cooldown <= 0) { m.cooldown = m.weapon.reload; this.firePD(s, m, muzzle); }
          continue;
        }
        if (m.salvoLeft <= 0 && m.cooldown <= 0 && m.ammo > 0) {
          m.salvoLeft = m.weapon.salvo; m.salvoTimer = 0; m.cooldown = m.weapon.reload * this.rng.range(0.95, 1.08);
          m.ammo--;
          if (m.ammo <= 0 && s.mounts.every(o => o.weapon.kind !== 'missile' || o.ammo <= 0)) {
            const g = this.groupById.get(s.groupId)!;
            if (!(g as any)._outOfMissiles) { (g as any)._outOfMissiles = true; g.ai.lastRadio = -99; this.say(g, 'winchester', { s: s.name }, 1, s.pos); }
          }
        }
        if (m.salvoLeft > 0) {
          m.salvoTimer -= dt;
          if (m.salvoTimer <= 0) {
            m.salvoTimer = m.weapon.salvoGap;
            m.salvoLeft--;
            this.fireMunition(s, m, muzzle, desiredDir);
          }
        }
      } else {
        // drift back to rest position
        const rd = dirFromYawPitch(s.yaw + Math.atan2(m.facingLocal.x, m.facingLocal.z), s.pitch, tmpD);
        if (m.aim.lengthSq() < 0.5) m.aim.copy(rd);
        rotateToward(m.aim, rd, m.weapon.turnSpeed * Math.PI / 180 * dt * 0.5);
        m.salvoLeft = 0;
      }
    }
  }

  private torpRangeFactor(s: Ship): number {
    // P15.1: a siege computer launches from its own firing solution
    if (s.cpu) { const f = cpuLaunchFactor(s); if (f !== undefined) return f; }
    const g = this.groupById.get(s.groupId)!;
    // aggressive commanders close in before launching, which is deadlier but riskier
    return lerp(0.85, 0.55, g.commander.aggression);
  }

  private chooseMountTarget(s: Ship, m: Mount) {
    const w = m.weapon;
    const muzzle = localToWorld({ x: m.def.pos[0], y: m.def.pos[1], z: m.def.pos[2] }, s.pos, s.yaw, s.pitch, tmpA);
    const arc = m.def.arc * Math.PI / 180;
    const inArc = (p: Vec3) => {
      tmpB.subVectors(p, muzzle).normalize();
      const local = worldDirToLocal(tmpB, s.yaw, s.pitch, tmpC);
      return angleBetween(local, m.facingLocal) <= arc;
    };
    if (w.kind === 'pd') {
      let best = -1, bestScore = -Infinity;
      for (const mu of this.munitions) {
        if (mu.dead || !this.hostile(s.team, mu.team) || mu.kind === 'shell') continue;
        if (mu.ghost !== undefined && mu.age < mu.ghost) continue;   // mid-skip (SERAPH-EX): nothing to shoot at
        const d = muzzle.distTo(mu.pos);
        if (d > w.range) continue;
        if (!inArc(mu.pos)) continue;
        let score = -d;
        if (mu.kind === 'torpedo') score += 200;
        if (this.rules >= 1) score += this.pdThreat(s, mu, m);
        else if (mu.targetId === s.id) score += 120;
        else if (s.ofx?.pdNet) { const at = this.shipById.get(mu.targetId); if (at && at.team === s.team && at.pos.distTo(s.pos) < 600) score += 160; }
        // a 16-emitter array spreads over the salvo instead of all tracking the nearest round
        if (s.ex) score -= ((mu.id * 31 + m.index * 17) % 13) * 22;
        if (score > bestScore) { bestScore = score; best = mu.id; }
      }
      if (best >= 0) { this.pdAssign(m, best); m.targetId = best; m.targetIsMunition = true; return; }
      this.pdAssign(m, -1);
      m.targetIsMunition = false;
      m.targetId = -1;
      let bd = w.range;
      for (const t of this.ships) {
        if (!this.hostile(s.team, t.team) || t.state !== 'alive' || t.role !== 'raider') continue;
        const d = muzzle.distTo(t.pos);
        if (d < bd && inArc(t.pos)) { bd = d; m.targetId = t.id; }
      }
      return;
    }
    m.targetIsMunition = false;
    if (m.ammo <= 0) { m.targetId = -1; return; }
    const range = w.range * (w.kind === 'torpedo' ? this.torpRangeFactor(s) : 1);
    // P15: a capital ship's secondary battery chooses for itself (threats first) instead of following the
    // commander's target with every gun; main guns and other ships keep the commander's target
    let own = this.rules >= 1 && s.role === 'line' && w.kind === 'shell' && w.damage < 250;
    // P15.1: the computer decides whether guns cover threats (picket) or all follow the target (swarm)
    if (s.cpu && w.kind !== 'torpedo') own = cpuOwnGuns(s, own);
    // prefer commander-assigned target
    const pri = own ? undefined : this.shipById.get(s.ai.targetId);
    if (pri && pri.state === 'alive' && this.hostile(s.team, pri.team) && muzzle.distTo(pri.pos) <= range && inArc(pri.pos) && this.suitability(w, pri) > (w.kind === 'torpedo' ? 0 : s.ofx?.focus ? 0.05 : 0.2)) {
      m.targetId = pri.id; return;
    }
    let best = -1, bestScore = 0;
    for (const t of this.ships) {
      if (!this.hostile(s.team, t.team) || t.state !== 'alive') continue;
      const d = muzzle.distTo(t.pos);
      if (d > range) continue;
      // Torpedoes strongly prefer large targets, but can engage escorts and raiders when needed.
      // don't waste missile salvos on distant agile craft
      if (w.kind === 'missile' && t.role === 'raider' && d > 650) continue;
      if (!inArc(t.pos)) continue;
      const suit = this.suitability(w, t);
      const hitP = clamp((t.radius + 3) / (d * Math.max(w.spread, 0.004) * 3 + 1), 0.05, 1);
      let score = suit * hitP * (1.2 - 0.5 * t.hp / t.maxHp) * (t.id === s.ai.targetId ? (s.ofx?.focus ? 2.5 : 1.5) : 1) * (1 + t.value / 600);
      if (own) score *= this.gunThreat(s, m, t, d);
      if (score > bestScore) { bestScore = score; best = t.id; }
    }
    m.targetId = best;
  }

  /** P15 secondary battery: a ship that can torpedo this one soon is shot first; small craft already under
   *  fire from enough of this ship's guns are left to them (the rest spread over other targets) */
  private gunThreat(s: Ship, m: Mount, t: Ship, d: number): number {
    let k = 1;
    if (t.role !== 'line') {
      for (const tm of t.mounts) if (tm.weapon.kind === 'torpedo' && tm.ammo > 0 && tm.disabled <= 0 && d < tm.weapon.range * 1.5) { k *= 3; break; }
      let n = 0;
      for (const o of s.mounts) if (o !== m && o.targetId === t.id && !o.targetIsMunition && o.weapon.kind !== 'pd') n++;
      // enough guns for its size: a raider ~2, an escort ~3
      const enough = t.role === 'raider' ? 2 : 3;
      if (n >= enough) k /= 1 + (n - enough + 1) * 0.8;
    }
    return k;
  }

  /** P15 point defence: how much a round matters to this mount — guided rounds after this ship or a
   *  friend close by, unguided rounds only if they will actually pass close to one — and how many
   *  emitters already follow it (enough for its armour are left to it; the rest look elsewhere). */
  private pdThreat(s: Ship, mu: Munition, m: Mount): number {
    let score = Math.min(150, mu.weapon.damage / 8);
    if (mu.straight) {
      // closest approach of the straight run to this ship, or to the friend it was fired at (within 600 m)
      const at = this.shipById.get(mu.targetId);
      const cover = s.cpu ? cpuPdCover(s) : null;
      const friend = at && at !== s && at.team === s.team && at.state === 'alive' && at.pos.distTo(s.pos) < (cover?.radius ?? 600) ? at : undefined;
      score += this.onCourse(mu, s) ? 160 : friend && this.onCourse(mu, friend) ? (cover ? cover.bonus : 120) : -400;
    } else if (mu.targetId === s.id) score += 120;
    else {
      const at = this.shipById.get(mu.targetId), cover = s.cpu ? cpuPdCover(s) : null;
      if (at && at.team === s.team && at.pos.distTo(s.pos) < (cover?.radius ?? 600)) score += Math.max(s.ofx?.pdNet ? 160 : 60, cover?.bonus ?? 0);
    }
    const load = (this.pdLoad.get(mu.id) ?? 0) - (m.targetIsMunition && m.targetId === mu.id ? 1 : 0);
    const need = mu.hp + 1;
    if (load >= need) score -= 140 * (load - need + 1);
    return score;
  }
  /** does a straight-running round pass within the hull of ship f (closest approach of the two tracks)? */
  private onCourse(mu: Munition, f: Ship): boolean {
    const px = mu.pos.x - f.pos.x, py = mu.pos.y - f.pos.y, pz = mu.pos.z - f.pos.z;
    const vx = mu.vel.x - f.vel.x, vy = mu.vel.y - f.vel.y, vz = mu.vel.z - f.vel.z;
    const vv = vx * vx + vy * vy + vz * vz;
    const tc = clamp(-(px * vx + py * vy + pz * vz) / Math.max(vv, 1e-6), 0, mu.life);
    const mx = px + vx * tc, my = py + vy * tc, mz = pz + vz * tc;
    return mx * mx + my * my + mz * mz < (f.radius + f.halfLen + 6) ** 2;
  }
  private pdAssign(m: Mount, id: number) {
    if (this.rules < 1) return;
    if (m.targetIsMunition && m.targetId >= 0) { const n = (this.pdLoad.get(m.targetId) ?? 1) - 1; if (n > 0) this.pdLoad.set(m.targetId, n); else this.pdLoad.delete(m.targetId); }
    if (id >= 0) this.pdLoad.set(id, (this.pdLoad.get(id) ?? 0) + 1);
  }

  /** expected damage multiplier of a weapon vs a target's side armor */
  suitability(w: WeaponDef, t: Ship): number {
    const ratio = w.pen / t.armor.side;
    let s = ratio >= 1 ? 1 : ratio < 0.55 ? 0.08 : Math.pow(ratio, 1.6);
    // P5 weapons declare what they are for (the built-in ones keep the rules below)
    if (w.role === 'anti-small') { if (t.role === 'raider' || t.role === 'escort') s *= 1.4; else s *= 0.7; }
    else if (w.role === 'anti-capital') { if (t.role === 'raider' && w.kind !== 'torpedo') return s * 0.1; if (t.role === 'line') s *= 1.3; }
    if (t.shield && t.maxShield && t.shield > t.maxShield * 0.25) s *= w.vsShield ?? 1;
    // heavy/guided weapons are wasted on small agile craft
    if (t.role === 'raider') {
      if (w.kind === 'missile') s *= 0.15;
      else if (w.kind === 'torpedo') s *= 0.15;
      else if (w.damage >= 250) s *= 0.25;
    } else if (t.role === 'escort' && w.kind === 'torpedo') s *= 0.6;
    return s;
  }

  private fireMunition(s: Ship, m: Mount, muzzle: Vec3, solution: Vec3) {
    const w = m.weapon;
    m.lastFire = this.time;
    s.stats.shots++;
    // fire control: once the turret is on target, the shot follows the computed firing solution
    const dir = solution.clone().normalize();
    m.aim.copy(dir);
    let vel: Vec3;
    const kind = w.kind as 'shell' | 'missile' | 'torpedo';
    if (kind === 'shell') {
      // small, fast targets are much harder to track
      const tgt = this.shipById.get(m.targetId);
      let agility = tgt ? 1 + clamp(tgt.vel.length() / tgt.radius / 25, 0, 2.2) : 1;
      if (s.ofx?.agile) agility = 1 + (agility - 1) * (1 - s.ofx.agile);
      // ECM / evasive drives on the target widen the dispersion (B-1: officer ECCM cuts through them)
      const eccm = s.ofx?.eccm ? 1 - s.ofx.eccm : 1;
      let spread = w.spread / s.gunnery * (s.crit.bridge > 0 ? 1.6 : 1) * agility / (1 - Math.min(0.5, (tgt?.evasion ?? 0) * eccm));
      if (tgt?.ofx) { const ev = (tgt.ofx.jam ?? 0) + (tgt.ofx.evade ?? 0) + (tgt.hp < tgt.maxHp * 0.35 ? tgt.ofx.lastDitch ?? 0 : 0); if (ev) spread *= 1 + ev * eccm; }
      if (s.ofx?.longAcc && tgt && tgt.pos.distTo(s.pos) > w.range * 0.55) spread /= 1 + s.ofx.longAcc;
      if (s.jamUntil !== undefined && s.jamUntil > this.time) spread *= 1.9;   // BLACKOUT
      const side = new Vec3().crossVectors(dir, UP).normalize();
      const up = new Vec3().crossVectors(side, dir).normalize();
      dir.addScaled(side, this.rng.gauss() * spread).addScaled(up, this.rng.gauss() * spread).normalize();
      vel = dir.clone().scale(w.speed);
    } else if (kind === 'missile') {
      const out = new Vec3().subVectors(muzzle, s.pos).normalize();
      vel = new Vec3().copy(UP).scale(70).addScaled(out, 30).addScaled(s.vel, 1).addScaled(dir, 20);
    } else if (this.unguided(w)) {
      // P15: a plasma torpedo leaves on the fire-control lead solution (with launch dispersion) and runs straight
      const side = new Vec3().crossVectors(dir, UP).normalize();
      const up = new Vec3().crossVectors(side, dir).normalize();
      const sp = w.spread / s.gunnery * (s.crit.bridge > 0 ? 1.6 : 1);
      dir.addScaled(side, this.rng.gauss() * sp).addScaled(up, this.rng.gauss() * sp * 0.3).normalize();
      vel = dir.clone().scale(w.speed * 0.7);
    } else {
      vel = s.fwd.clone().scale(w.speed * 0.7).addScaled(s.vel, 0.5);
    }
    const mu: Munition = {
      id: this.nextId++, kind, team: s.team, ownerId: s.id, weapon: w,
      pos: muzzle.clone(), prevPos: muzzle.clone(), vel, life: kind === 'shell' ? w.range * 1.2 / w.speed : w.range / w.speed * 1.7,
      targetId: m.targetId, hp: w.munitionHp ?? 1, age: 0, dead: false,
    };
    if (s.ofx?.mGuide && kind !== 'shell') mu.gm = 1 + s.ofx.mGuide;
    if (kind !== 'shell' && this.unguided(w)) mu.straight = true;
    this.munitions.push(mu); this.munitionById.set(mu.id, mu);
    this.events.push({ t: 'fire', ship: s.id, mount: m.index, kind, weapon: w.id, pos: muzzle.clone(), dir: dir.clone() });
    if (s.ex) exNoteShot(s, w.id);
    this.intensity += kind === 'shell' ? Math.min(4, w.damage / 400) : 0.2;
    if (this.firstContact < 0) this.firstContact = this.time;
  }

  private firePD(s: Ship, m: Mount, muzzle: Vec3) {
    const w = m.weapon;
    m.lastFire = this.time;
    if (m.targetIsMunition) {
      const mu = this.munitionById.get(m.targetId)!;
      let chance = (w.pdChance ?? 0.08) * s.pdBonus * (mu.kind === 'torpedo' ? 0.6 * (s.ofx?.torpPd ? 1 + s.ofx.torpPd : 1) : 1);
      if (s.jamUntil !== undefined && s.jamUntil > this.time) chance *= 0.55;   // BLACKOUT
      // P15: an unguided round runs a predictable straight line — fire control leads it far better
      if (mu.straight) chance *= 1.6;
      const hit = this.rng.chance(chance);
      const to = mu.pos.clone();
      if (!hit) to.add(new Vec3(this.rng.range(-8, 8), this.rng.range(-8, 8), this.rng.range(-8, 8)));
      this.events.push({ t: 'pd', ship: s.id, mount: m.index, from: muzzle.clone(), to, hit });
      if (hit) {
        mu.hp--;
        if (mu.hp <= 0 && !mu.dead) {
          mu.dead = true;
          s.stats.intercepts++;
          this.events.push({ t: 'intercept', pos: mu.pos.clone(), kind: mu.kind, by: s.id });
          const g = this.groupById.get(s.groupId)!;
          if (s.stats.intercepts % 25 === 0) this.say(g, 'escort_save', { n: this.teamIntercepts(s.team) }, 0, s.pos);
        }
      }
    } else {
      const t = this.shipById.get(m.targetId);
      if (!t) return;
      const hit = this.rng.chance(0.2 * (s.ofx?.antiRaider ? 1 + s.ofx.antiRaider : 1));
      const to = t.pos.clone().add(new Vec3(this.rng.range(-t.radius, t.radius), this.rng.range(-2, 2), this.rng.range(-t.halfLen, t.halfLen) * 0.5));
      if (!hit) to.add(new Vec3(this.rng.range(-10, 10), this.rng.range(-10, 10), this.rng.range(-10, 10)));
      this.events.push({ t: 'pd', ship: s.id, mount: m.index, from: muzzle.clone(), to, hit });
      if (hit) {
        const dir = new Vec3().subVectors(to, muzzle).normalize();
        this.applyHit(t, w, s.id, to, dir, 'shell');
      }
    }
  }

  /** B-1: officer speed effects — pursuit of a fleeing or crippled target, and a faster withdrawal */
  private officerSpeed(s: Ship): number {
    const ox = s.ofx!; let m = 1;
    const g = this.groupById.get(s.groupId)!;
    if (ox.retreatSpd && g.order.type === 'retreat') m *= 1 + ox.retreatSpd;
    else if (ox.pursuit) {
      const t = this.shipById.get(s.ai.targetId);
      if (t && t.state === 'alive') { const tg = this.groupById.get(t.groupId); if (t.hp < t.maxHp * 0.4 || tg?.order.type === 'retreat' || tg?.ai.routed) m *= 1 + ox.pursuit; }
    }
    return m;
  }
  /** B-1: own-group ships within 350 m (defensive formation) */
  private formation(t: Ship): number {
    const g = this.groupById.get(t.groupId); if (!g) return 0;
    let n = 0;
    for (const id of g.shipIds) { if (id === t.id) continue; const o = this.shipById.get(id); if (o && o.state === 'alive' && o.pos.distTo(t.pos) < 350) n++; }
    return n;
  }

  teamIntercepts(team: Team): number { let n = 0; for (const s of this.ships) if (s.team === team) n += s.stats.intercepts; return n; }

  // ---------------------------------------------------------------- munitions
  private updateMunitions() {
    const dt = this.dt;
    const segEnd = new Vec3();
    for (const mu of this.munitions) {
      if (mu.dead) continue;
      mu.age += dt;
      mu.life -= dt;
      if (mu.kind !== 'shell') this.guide(mu);
      else if (mu.weapon.seek) exSeek(this, mu);
      mu.pos.addScaled(mu.vel, dt);
      // collision against enemy ships
      const speed = mu.vel.length();
      for (const t of this.ships) {
        // shells and missiles only strike ships of sides hostile to the shooter (allied and neutral
        // hulls are passed through, as friendly ones always were)
        if (!this.hostile(mu.team, t.team) || (t.state !== 'alive' && t.state !== 'dying')) continue;
        if (mu.through && mu.through.includes(t.id)) continue;
        const reach = t.halfLen + t.radius + speed * dt + 4;
        if (Math.abs(t.pos.x - mu.pos.x) > reach || Math.abs(t.pos.z - mu.pos.z) > reach || Math.abs(t.pos.y - mu.pos.y) > reach) continue;
        // capsule along ship forward axis
        tmpA.copy(t.pos).addScaled(t.fwd, t.halfLen * 0.92);
        tmpB.copy(t.pos).addScaled(t.fwd, -t.halfLen * 0.92);
        const extra = mu.kind === 'shell' ? 0 : 2.5;
        const d2 = segSegDistSq(mu.prevPos, mu.pos, tmpA, tmpB, segEnd);
        const rr = t.radius + extra;
        // PARADOX field (BB-EX): a shell passing close off the hull may still be relocated
        if (d2 > rr * rr && t.ex && mu.kind === 'shell' && t.state === 'alive' && d2 <= BBEX.pField * BBEX.pField) {
          if (exGraze(this, t, mu, segEnd)) { mu.dead = true; break; }
          (mu.through ??= []).push(t.id); continue;
        }
        if (d2 <= rr * rr) {
          // agile raiders can out-turn anti-ship missiles at the last moment
          if (mu.kind === 'missile' && t.role === 'raider' && !mu.ricochet) {
            mu.ricochet = true;
            if (this.rng.chance(0.6)) { mu.targetId = -1; mu.life = Math.min(mu.life, 1.5); continue; }
          }
          mu.dead = true;
          const dir = mu.vel.clone().normalize();
          if (t.state === 'alive') this.applyHit(t, mu.weapon, mu.ownerId, segEnd.clone(), dir, mu.kind);
          else this.events.push({ t: 'hit', target: t.id, attacker: mu.ownerId, pos: segEnd.clone(), dir, dmg: 0, result: 'pen', weapon: mu.weapon.id, facing: 'side' });
          // ABYSS-LANCE: the lance leaves the far side of the hull and keeps going
          if (mu.weapon.pierce && (mu.through?.length ?? 0) < mu.weapon.pierce) {
            (mu.through ??= []).push(t.id); mu.dead = false;
            this.events.push({ t: 'exPierce', pos: segEnd.clone().addScaled(dir, t.radius * 2), dir: dir.clone(), target: t.id });
          }
          break;
        }
      }
      if (!mu.dead && mu.life <= 0) {
        mu.dead = true;
        if (mu.kind !== 'shell') this.events.push({ t: 'munitionExpire', pos: mu.pos.clone(), kind: mu.kind });
      }
    }
    if (this.tick % 10 === 0) {
      this.munitions = this.munitions.filter(m => { if (m.dead) this.munitionById.delete(m.id); return !m.dead; });
    }
  }

  private guide(mu: Munition) {
    const dt = this.dt;
    const w = mu.weapon;
    if (mu.straight) { const sp = mu.vel.length(); mu.vel.scale(Math.min(w.speed, sp + w.speed * 1.2 * dt) / Math.max(sp, 1e-6)); return; }
    let t = this.shipById.get(mu.targetId);
    if (mu.lost) { const sp = mu.vel.length(); mu.vel.scale(Math.min(w.speed, sp + w.speed * 1.2 * dt) / Math.max(sp, 1e-6)); return; }
    // B-1 decoys: once, inside 250 m, a guided round aimed at the officer's ship may lose its lock for good
    if (t?.ofx?.decoy && !mu.decoyed && t.pos.distTo(mu.pos) < 250) { mu.decoyed = true; if (this.rng.chance(t.ofx.decoy)) { mu.lost = true; mu.targetId = -1; mu.life = Math.min(mu.life, 1.5); return; } }
    if (!t || t.state !== 'alive') {
      // retarget to nearest enemy
      let bd = 900, best: Ship | undefined;
      for (const s of this.ships) {
        if (!this.hostile(mu.team, s.team) || s.state !== 'alive') continue;
        const d = s.pos.distTo(mu.pos);
        if (d < bd) { bd = d; best = s; }
      }
      t = best;
      mu.targetId = t ? t.id : -1;
    }
    const boost = mu.kind === 'missile' ? 0.55 : 0.2;
    const speed = mu.vel.length();
    const dir = mu.vel.clone().scale(1 / Math.max(speed, 1e-6));
    if (t && w.phase && !mu.phased && mu.age > boost + 0.55) { exPhase(this, mu, t); if (mu.ghost !== undefined) return; }
    if (t && mu.age > boost) {
      const tt = t.pos.distTo(mu.pos) / Math.max(speed, 50);
      const aim = new Vec3(t.pos.x + t.vel.x * tt - mu.pos.x, t.pos.y + t.vel.y * tt - mu.pos.y, t.pos.z + t.vel.z * tt - mu.pos.z).normalize();
      let turn = (w.guidedTurn ?? 1) * dt * (mu.age < boost + 0.6 ? 2.2 : 1) * (mu.gm ?? 1) * (t.ofx?.mJam ? 1 - t.ofx.mJam : 1);
      if (this.exShips.length) { const o = this.shipById.get(mu.ownerId); if (o && o.jamUntil !== undefined && o.jamUntil > this.time) turn *= 0.4; }   // BLACKOUT
      rotateToward(dir, aim, turn);
    }
    const ns = Math.min(w.speed, speed + w.speed * 1.2 * dt);
    mu.vel.copy(dir).scale(mu.age < boost ? speed * (1 - 0.6 * dt) + 5 * dt : ns);
  }

  // ---------------------------------------------------------------- damage
  applyHit(t: Ship, w: WeaponDef, attackerId: number, pos: Vec3, dir: Vec3, kind: string) {
    const fromDir = tmpD.copy(dir).scale(-1);
    const c = fromDir.dot(t.fwd);
    const facing: 'front' | 'side' | 'rear' = c > 0.72 ? 'front' : c < -0.6 ? 'rear' : 'side';
    // PARADOX (BB-EX): the hit is displaced out of this space, or the barrier takes it
    if (t.ex && exIncoming(this, t, w, attackerId, pos, dir)) { const a0 = this.shipById.get(attackerId); if (a0) a0.stats.hits++; this.events.push({ t: 'hit', target: t.id, attacker: attackerId, pos: pos.clone(), dir: dir.clone(), dmg: 0, result: 'paradox', weapon: w.id, facing }); return; }
    // P5 shields (growth fittings only — c0 ships have none and skip this): the shield takes the hit
    // first, scaled by the weapon's effect on shields; what it cannot hold goes on to the armour
    let through = 1;
    if (t.shield && t.shield > 0) {
      const vs = w.vsShield ?? 1;
      const want = w.damage * vs;
      const took = Math.min(t.shield, want);
      t.shield -= took; t.shieldHitAt = this.time;
      through = want > 0 ? 1 - took / want : 0;
      if (through <= 0.001) {
        t.lastAttacker = attackerId;
        const a0 = this.shipById.get(attackerId); if (a0) { a0.stats.hits++; }
        this.events.push({ t: 'hit', target: t.id, attacker: attackerId, pos: pos.clone(), dir: dir.clone(), dmg: 0, result: 'shield', weapon: w.id, facing });
        return;
      }
    }
    const ax = this.shipById.get(attackerId)?.ofx;
    let armor = t.armor[facing];
    if (t.ofx?.formArmor && this.formation(t) >= 2) armor *= 1 + t.ofx.formArmor;
    const ratio = w.pen * (ax?.pen ? 1 + ax.pen : 1) / armor;
    let mul: number; let result: 'pen' | 'ricochet' | 'blocked';
    if (ratio >= 1) { mul = 1; result = 'pen'; }
    else if (ratio < 0.55 && this.rng.chance(0.75)) { mul = 0.06; result = 'ricochet'; }
    else { mul = Math.pow(ratio, 1.6); result = mul > 0.35 ? 'pen' : 'blocked'; }
    // causality interference (commander BB): a glancing result of BB-EX's own fire is overruled
    if (mul < 1 && this.exShips.length) { const ax = this.shipById.get(attackerId); if (ax?.ex && exRewrite(this, ax, pos)) { mul = 1; result = 'pen'; } }
    let dmg = w.damage * mul * this.rng.range(0.85, 1.15) * through;
    if (ax) { const big = t.role === 'line'; dmg *= 1 + (big ? ax.dmgCap ?? 0 : ax.dmgSmall ?? 0) + (facing === 'rear' ? ax.rearDmg ?? 0 : 0); }
    if (t.ofx) { if (t.ofx.brace && t.hp < t.maxHp * 0.3) dmg *= 1 - t.ofx.brace; t.ofHit = this.time; }
    // P15: a large hull's subdivision limits what one hit can wreck (the stern is less protected)
    const struct = this.rules >= 1 ? t.cls.structure : undefined;
    if (struct && dmg > struct.bulk) dmg = struct.bulk + (dmg - struct.bulk) * (1 - struct.absorb * (facing === 'rear' ? 0.5 : 1));
    t.hp -= dmg;
    t.stats.dmgTaken += dmg;
    t.recentDamage += dmg;
    t.lastAttacker = attackerId;
    const a = this.shipById.get(attackerId);
    if (this.exShips.length) t.lastWeapon = w.id;
    if (a) {
      a.stats.dmgDealt += dmg; a.stats.hits++;
      if (a.ex) exNoteHit(a, w.id, dmg);
      if (result === 'ricochet') a.stats.ricochets++;
      if (facing === 'rear') a.stats.rearHits++;
      if (kind === 'torpedo') a.stats.torpHits++;
      this.groupById.get(a.groupId)!.stats.dmgDealt += dmg;
    }
    this.events.push({ t: 'hit', target: t.id, attacker: attackerId, pos: pos.clone(), dir: dir.clone(), dmg, result, weapon: w.id, facing });
    this.intensity += dmg / 300;
    // critical hits
    if (result === 'pen' && t.state === 'alive') {
      let p = clamp(w.damage / 900, 0.01, 0.4) * (facing === 'rear' ? 1.8 : 1) * (ax?.crit ? 1 + ax.crit : 1) * (t.ofx?.critRes ? 1 - t.ofx.critRes : 1);
      if (struct) p *= 1 - struct.critRes * (facing === 'rear' ? 0.5 : 1);
      if (this.rng.chance(p)) this.applyCrit(t);
    }
    if (t.hp <= 0 && t.state === 'alive') this.startDying(t, attackerId, facing === 'rear', kind);
  }

  private applyCrit(t: Ship) {
    const r = this.rng.next();
    let crit: 'engine' | 'weapon' | 'fire' | 'bridge';
    const dc = (t.ofx?.dc ? 1 - t.ofx.dc : 1) * (this.rules >= 1 ? t.cls.structure?.dc ?? 1 : 1);
    if (r < 0.3) { crit = 'engine'; t.crit.engine = 14 * dc; }
    else if (r < 0.62) {
      crit = 'weapon';
      const live = t.mounts.filter(m => m.disabled <= 0);
      if (live.length) this.rng.pick(live).disabled = 16 * dc;
    } else if (r < 0.9) { crit = 'fire'; t.crit.fire = 12 * dc; }
    else { crit = 'bridge'; t.crit.bridge = 10 * dc; }
    this.events.push({ t: 'crit', ship: t.id, crit, pos: t.pos.clone() });
    if (t.role !== 'raider' && (t.team === 0 || this.dynamic)) {
      const g = this.groupById.get(t.groupId)!;
      if (this.time - g.ai.lastRadio > 7 && (crit !== 'fire' || t.value >= 250)) {
        g.ai.lastRadio = this.time;
        const msg: RadioMsg = {
          id: this.radioId++, time: this.time, team: t.team, groupId: g.id, who: `${t.name} 함장`, rank: '', color: g.commander.color,
          text: line('crit_' + crit, 'formal', this.lineRng, { s: t.name }).replace(`${t.name}: `, ''), priority: 0, pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z }, shipId: t.id,
        };
        this.radioLog.push(msg); this.events.push({ t: 'radio', msg });
      }
    }
  }

  /** damage that ignores armour (DCP-Ω dimension cut): shields soak double, the rest is cut out of the hull */
  exDamage(t: Ship, dmg: number, attackerId: number, pos: Vec3, dir: Vec3, weapon: string) {
    if (t.shield && t.shield > 0) {
      const took = Math.min(t.shield, dmg * 2);
      t.shield -= took; t.shieldHitAt = this.time; dmg -= took / 2;
      if (dmg <= 0.5) { this.events.push({ t: 'hit', target: t.id, attacker: attackerId, pos: pos.clone(), dir: dir.clone(), dmg: 0, result: 'shield', weapon, facing: 'side' }); return; }
    }
    t.hp -= dmg; t.stats.dmgTaken += dmg; t.recentDamage += dmg; t.lastAttacker = attackerId; t.lastWeapon = weapon;
    const a = this.shipById.get(attackerId);
    if (a) { a.stats.dmgDealt += dmg; a.stats.hits++; this.groupById.get(a.groupId)!.stats.dmgDealt += dmg; if (a.ex) exNoteHit(a, weapon, dmg); }
    this.events.push({ t: 'hit', target: t.id, attacker: attackerId, pos: pos.clone(), dir: dir.clone(), dmg, result: 'cut', weapon, facing: 'side' });
    this.intensity += Math.min(6, dmg / 600);
    if (t.hp <= 0 && t.state === 'alive') this.startDying(t, attackerId, false, 'cut');
  }

  private startDying(t: Ship, killerId: number, rear: boolean, kind: string) {
    // causality interference: BB may reject the destruction of BB-EX before it becomes final
    if (t.ex && exVeto(this, t)) return;
    t.state = 'dying';
    t.killedBy = killerId;
    t.dyingTimer = t.role === 'raider' ? 0.5 : t.cls.id === 'destroyer' ? 1.4 : t.cls.id === 'cruiser' ? 2.2 : 3.4;
    t.deathTime = this.time;
    this.events.push({ t: 'dying', ship: t.id });
    const killer = this.shipById.get(killerId);
    const vg = this.groupById.get(t.groupId)!;
    vg.stats.lost++;
    if (killer) {
      killer.stats.kills++; killer.stats.killValue += t.value;
      if (killer.ex) exNoteKill(killer, t.lastWeapon);
      const kg = this.groupById.get(killer.groupId)!;
      kg.stats.kills++; kg.stats.killValue += t.value;
      let p = kg.parentId; while (p !== null) { const pg = this.groupById.get(p)!; pg.stats.kills++; pg.stats.killValue += t.value; p = pg.parentId; }
      const big = t.value >= 140;
      const label = `${t.cls.type} ${t.name}`;
      this.say(kg, big ? 'kill_big' : 'kill', { t: label }, big ? 2 : 0, t.pos);
      this.scoreHighlight(t, killer, rear, kind);
    }
    if (t.role !== 'raider' || vg.shipIds.filter(id => this.shipById.get(id)!.state === 'alive').length === 0) {
      // a different line so it doesn't collide with kill message from the same group
      vg.ai.lastRadio = -99;
      this.say(vg, 'lost', { s: t.name }, t.value >= 140 ? 2 : 1, t.pos);
    }
    for (const m of t.mounts) { m.targetId = -1; m.salvoLeft = 0; }
  }

  private updateDying(s: Ship) {
    const dt = this.dt;
    s.dyingTimer -= dt;
    s.vel.scale(1 - 0.15 * dt);
    s.pos.addScaled(s.vel, dt);
    s.yaw += 0.08 * dt * (s.id % 2 ? 1 : -1);
    s.pitch += 0.03 * dt;
    dirFromYawPitch(s.yaw, s.pitch, s.fwd);
    if (this.rng.chance(dt * (s.role === 'line' ? 4 : 2.5))) {
      const p = localToWorld({ x: this.rng.range(-s.radius, s.radius), y: this.rng.range(0, s.radius * 0.6), z: this.rng.range(-s.halfLen, s.halfLen) }, s.pos, s.yaw, s.pitch, new Vec3());
      this.events.push({ t: 'secondary', ship: s.id, pos: p });
    }
    if (s.dyingTimer <= 0) {
      s.state = 'dead';
      const magazine = s.cls.id === 'battleship' ? this.rng.chance(0.4) : s.cls.id === 'cruiser' ? this.rng.chance(0.15) : false;
      this.events.push({ t: 'destroyed', ship: s.id, killer: s.killedBy, pos: s.pos.clone(), magazine });
      this.intensity += 4;
      if (magazine) this.magazineBlast(s);
    }
  }

  private magazineBlast(s: Ship) {
    const radius = s.cls.id === 'battleship' ? 230 : 140;
    const dmgMax = s.cls.id === 'battleship' ? 900 : 450;
    const caught: Ship[] = [];
    for (const o of this.ships) {
      if (o === s || o.state !== 'alive') continue;
      const d = o.pos.distTo(s.pos);
      if (d > radius + o.radius) continue;
      const dmg = dmgMax * (1 - d / (radius + o.radius)) + 50;
      const dir = new Vec3().subVectors(o.pos, s.pos).normalize();
      o.hp -= dmg; o.stats.dmgTaken += dmg; o.recentDamage += dmg;
      this.events.push({ t: 'hit', target: o.id, attacker: s.id, pos: o.pos.clone().addScaled(dir, -o.radius), dir, dmg, result: 'pen', weapon: 'blast', facing: 'side' });
      caught.push(o);
      if (o.hp <= 0) this.startDying(o, s.killedBy >= 0 ? s.killedBy : s.id, false, 'blast');
    }
    const killer = this.shipById.get(s.killedBy);
    const by = !this.dynamic ? (s.team === 0 ? 1 : 0) : killer && killer.team !== s.team ? killer.team : this.sides.findIndex((_, k) => this.hostile(k, s.team));
    const g = this.groupById.get(this.roots[by]);
    if (g) { g.ai.lastRadio = -99; this.say(g, 'magazine', { t: s.name }, 2, s.pos); }
    const killed = caught.filter(c => c.state !== 'alive').length;
    this.addHighlight({
      time: this.time, score: 6 + caught.length * 2 + killed * 4, title: '탄약고 유폭',
      text: `${s.cls.type} ${s.name}의 탄약고가 유폭${caught.length ? `, 주변 함선 ${caught.length}척 휘말림` : ''}${killed ? ` (${killed}척 연쇄 격침)` : ''}`,
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z }, shipId: s.id, team: Math.max(0, by),
    });
  }

  private scoreHighlight(t: Ship, killer: Ship, rear: boolean, kind: string) {
    let score = t.value / 50;
    const tags: string[] = [];
    if (killer.value * 2.5 <= t.value) { score *= 2.2; tags.push('거함 사냥'); }
    if (t.recentDamage > t.maxHp * 0.55) { score *= 1.6; tags.push('일격'); }
    if (kind === 'torpedo') { score *= 1.3; tags.push('뇌격'); }
    if (rear) { score *= 1.3; tags.push('배후 일격'); }
    const kg = this.groupById.get(killer.groupId)!;
    const title = tags[0] ?? (t.value >= 250 ? '거함 격침' : '격침');
    const text = `${kg.name}의 ${killer.cls.type} ${killer.name} → ${this.dynamic ? this.sides[t.team].name : t.team === 0 ? '아군' : '적'} ${t.cls.type} ${t.name} 격침${tags.length > 1 ? ` (${tags.slice(1).join(', ')})` : ''}`;
    this.addHighlight({ time: this.time, score, title, text, pos: { x: t.pos.x, y: t.pos.y, z: t.pos.z }, shipId: t.id, team: killer.team });
  }

  private addHighlight(h: Highlight) {
    this.highlights.push(h);
    this.events.push({ t: 'highlight', h });
  }

  // ---------------------------------------------------------------- outcome
  private checkOutcome() {
    if (!this.dynamic) return this.checkOutcomeLegacy();
    return this.checkOutcomeSides();
  }

  /** per-side summary for the outcome */
  private sideResults(status: (k: number) => SideStatus): SideResult[] {
    return this.sides.map((_, k) => {
      let alive = 0, lost = 0, escaped = 0;
      for (const s of this.ships) if (s.team === k) { if (s.state === 'alive' || s.state === 'inbound') alive++; else if (s.state === 'escaped') escaped++; else lost++; }
      return { side: k, status: this.sides[k].out ?? status(k), alive, lost, escaped, value: Math.round(this.teamValueFrac(k) * 100) / 100 };
    });
  }

  /** a side leaves the battle (it no longer counts for the outcome; its ships that are still here go) */
  private sideOut(k: number, status: SideStatus) {
    const side = this.sides[k];
    if (side.out) return;
    side.out = status; side.outAt = this.time;
    for (const s of this.ships) if (s.team === k && s.state === 'alive') { s.state = 'escaped'; this.events.push({ t: 'escaped', ship: s.id }); }
    this.events.push({ t: 'sideOut', side: k, status });
  }

  /** N sides (P11): sides leave when they are destroyed, withdrawn or routed; the battle goes on while
   *  two sides hostile to each other remain, and ends when no hostile pair is left. A time limit ends it
   *  as a stalemate — it never picks a winner by remaining strength. */
  private checkOutcomeSides() {
    const n = this.sides.length;
    const alive = new Array<number>(n).fill(0), escaped = new Array<number>(n).fill(0), dead = new Array<number>(n).fill(0);
    for (const s of this.ships) {
      if (s.state === 'alive') {
        const g = this.groupById.get(s.groupId)!;
        const h = this.sides[s.team].home;
        if (g.order.type === 'retreat' && (s.pos.x * h.x + s.pos.z * h.z > this.spawnZ + 900 || Math.hypot(s.pos.x, s.pos.z) > FIELD_RADIUS + 400)) {
          s.state = 'escaped';
          this.events.push({ t: 'escaped', ship: s.id });
        }
      }
      if (s.state === 'alive' || s.state === 'dying' || s.state === 'inbound') alive[s.team]++;
      else if (s.state === 'escaped') escaped[s.team]++;
      else dead[s.team]++;
    }
    for (let k = 0; k < n; k++) if (!this.sides[k].out && alive[k] === 0) this.sideOut(k, this.routed[k] >= 0 ? 'routed' : escaped[k] > 0 ? 'withdrawn' : 'destroyed');
    const active = (k: number) => !this.sides[k].out;
    // rout: a side reduced to a fraction of its strength while a hostile side is still strong breaks off
    for (let k = 0; k < n; k++) {
      if (!active(k)) continue;
      if (this.routed[k] < 0) {
        const f = this.teamValueFrac(k);
        if (f < 0.18 && this.time > 30) {
          const strong = this.sides.findIndex((_, j) => active(j) && this.hostile(k, j) && this.teamValueFrac(j) > 0.3);
          if (strong >= 0) {
            this.routed[k] = this.time;
            for (const g of this.groups) if (g.team === k) { g.order = { type: 'retreat' }; g.ai.lastOrderKey = 'retreat'; g.ai.routed = true; g.playerOverride = true; }
            const root = this.groupById.get(this.roots[k]);
            if (root) { root.ai.lastRadio = -99; this.say(root, 'rout_self', {}, 2); }
            const oroot = this.groupById.get(this.roots[strong]);
            if (oroot) { oroot.ai.lastRadio = -99; this.say(oroot, 'rout_enemy', {}, 2); }
          }
        }
      } else if (this.time - this.routed[k] > 35) this.sideOut(k, 'routed');
    }
    const live = this.sides.map((_, k) => k).filter(active);
    let fighting = false;
    for (const a of live) for (const b of live) if (a < b && this.hostile(a, b)) fighting = true;
    const timeUp = this.time >= this.timeLimit();
    if (fighting && !timeUp) return;
    // who is left: a single side wins; several (allied, neutral, or at the time limit) survive together
    const beat = (k: number) => this.sides.some((s, j) => s.out && s.out !== 'withdrawn' && this.hostile(k, j));
    // a winner must have beaten someone: a side left alone only because every opponent withdrew survives
    const winner = !timeUp && live.length === 1 && beat(live[0]) ? live[0] : -1;
    const reason = timeUp && fighting ? '교전 시간 종료' : live.length === 0 ? '전 진영 이탈' : winner >= 0 ? `${this.sides[winner].name} 승리` : `${live.map(k => this.sides[k].name).join(' · ')} 생존`;
    this.outcome = { winner, reason, time: this.time, sides: this.sideResults(k => !timeUp && beat(k) ? 'victor' : 'survived') };
    if (winner >= 0) { const r = this.groupById.get(this.roots[winner]); if (r) this.say(r, 'victory', {}, 2); }
    this.events.push({ t: 'end', outcome: this.outcome });
    void dead;
  }

  private checkOutcomeLegacy() {
    const alive = [0, 0], escaped = [0, 0];
    for (const s of this.ships) {
      if (s.state === 'alive' || s.state === 'dying' || s.state === 'inbound') alive[s.team]++;
      else if (s.state === 'escaped') escaped[s.team]++;
      if (s.state === 'alive') {
        const g = this.groupById.get(s.groupId)!;
        const homeZ = s.team === 0 ? -1 : 1;
        if (g.order.type === 'retreat' && (s.pos.z * homeZ > this.spawnZ + 900 || Math.hypot(s.pos.x, s.pos.z) > FIELD_RADIUS + 400)) {
          s.state = 'escaped';
          this.events.push({ t: 'escaped', ship: s.id });
          alive[s.team]--; escaped[s.team]++;
        }
      }
    }
    const end = (winner: Team | -1, reason: string) => {
      // a side with nobody left here was destroyed only if none of its ships got away (an escaped ship is not a loss)
      const gone = (k: number): SideStatus => escaped[k] > 0 ? 'withdrawn' : 'destroyed';
      this.outcome = { winner, reason, time: this.time, sides: this.sideResults(k => winner === -1 ? (alive[k] ? 'survived' : gone(k)) : k === winner ? 'victor' : this.routed[k] >= 0 ? 'routed' : gone(k)) };
      if (winner >= 0) this.say(this.groupById.get(this.roots[winner as Team])!, 'victory', {}, 2);
      this.events.push({ t: 'end', outcome: this.outcome });
    };
    if (alive[0] === 0 && alive[1] === 0) return end(-1, '양측 전멸');
    // (the reason text stays as recorded in the combat baseline: '전멸' even when some of that side escaped —
    //  the side status below is the exact one; see docs/P13_1_SALVAGE.md §5)
    if (alive[0] === 0) return end(1, this.routed[0] >= 0 ? '아군 함대 퇴각' : '아군 함대 전멸');
    if (alive[1] === 0) return end(0, this.routed[1] >= 0 ? '적 함대 퇴각' : '적 함대 전멸');
    for (const team of [0, 1] as Team[]) {
      const other = (1 - team) as Team;
      if (this.routed[team] < 0) {
        const f = this.teamValueFrac(team), fo = this.teamValueFrac(other);
        if (f < 0.18 && fo > 0.3 && this.time > 30) {
          this.routed[team] = this.time;
          for (const g of this.groups) if (g.team === team) { g.order = { type: 'retreat' }; g.ai.lastOrderKey = 'retreat'; g.ai.routed = true; g.playerOverride = true; }
          const root = this.groupById.get(this.roots[team])!;
          root.ai.lastRadio = -99; this.say(root, 'rout_self', {}, 2);
          const oroot = this.groupById.get(this.roots[other])!;
          oroot.ai.lastRadio = -99; this.say(oroot, 'rout_enemy', {}, 2);
        }
      } else if (this.time - this.routed[team] > 35) {
        return end(other, team === 0 ? '아군 함대 퇴각' : '적 함대 퇴각');
      }
    }
    if (this.time >= (this.setup.timeLimit ?? TIME_LIMIT)) {
      const f0 = this.teamValueFrac(0), f1 = this.teamValueFrac(1);
      return end(Math.abs(f0 - f1) < 0.05 ? -1 : f0 > f1 ? 0 : 1, '교전 시간 종료');
    }
  }

  // ---------------------------------------------------------------- misc
  /** deterministic state digest for replay verification */
  digest(): string {
    let h = 2166136261;
    const mix = (v: number) => { h ^= Math.round(v * 100) | 0; h = Math.imul(h, 16777619); };
    for (const s of this.ships) {
      mix(s.pos.x); mix(s.pos.y); mix(s.pos.z); mix(s.hp); mix(s.yaw);
      if (s.ex) { mix(s.ex.paradox.energy); for (const f of s.ex.funnels) { mix(f.pos.x); mix(f.pos.y); mix(f.pos.z); mix(f.hp); } }
    }
    mix(this.munitions.length);
    return (h >>> 0).toString(16);
  }

  runUntilEnd(maxTime = TIME_LIMIT + 5) {
    while (!this.outcome && this.time < maxTime) this.step();
    return this.outcome;
  }
}
