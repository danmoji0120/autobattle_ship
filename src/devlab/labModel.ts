// Serializable local experiment data. No company, world, inventory, or server objects enter here.
import { CONTENT, variantsOfHull, presetsOfHull } from '../content/registry';
import { SHIP_CLASSES } from '../sim/data/ships';
import { WEAPONS } from '../sim/data/weapons';
import { ACTING_CAPTAIN, type CommanderDef, type Specialty } from '../sim/data/commanders';
import type { FleetSpec, GroupSpec, InitialOrder, ShipFx, ShipSpec } from '../sim/fleet';
import { World, type BattleSetup } from '../sim/world';
import { EQUIPMENT, TECHS, fitFx, growthFx } from '../world/industry';
import { bayModules, checkFitting, loadoutLabel, shipLoadout, type ShipFitting } from '../world/fitting';
import { CONTENT_VERSION } from '../world/migrate';

export interface LabShip { id: string; hull: string; variant: string; fitting: ShipFitting; count: number }
/** The shape mirrors GroupSpec while retaining lab-only quantities and fittings. */
export interface LabGroup { name: string; commander: CommanderDef | null; order: InitialOrder; retreatAt: number; ships: LabShip[]; children: LabGroup[] }
export interface LabSide { name: string; root: LabGroup; research: string[] }
export interface LabPreset { id: string; name: string; hull: string; variant: string; hp: Record<string, string>; bay: Record<string, string> }
export interface LabConfig { schema: 'siderarium-combat-lab-2'; content: { version: number; fingerprint: string; packs: string[] }; seed: number; distance: number; timeLimit: number; speed: number; sides: [LabSide, LabSide]; presets: LabPreset[] }
export interface SideResult { survivors: number; destroyed: number; kills: number; escaped: number; dealt: number; taken: number; hull: number; maxHull: number; shots: number; hits: number; intercepts: number }
export interface BattleResult { seed: number; swapped: boolean; winner: 0 | 1 | -1; reason: string; time: number; digest: string; sides: [SideResult, SideResult] }
export interface Experiment { schema: 'siderarium-combat-results-1'; config: LabConfig; battles: BattleResult[]; summary: Summary }
export interface Summary { total: number; wins: [number, number]; draws: number; winRate: [number, number]; meanTime: number; meanSides: [SideResult, SideResult] }

const ORDERS: InitialOrder[] = ['auto', 'engage', 'flank_left', 'flank_right', 'escort', 'hold', 'reserve', 'retreat'];
const SPECIALTIES: Specialty[] = ['none', 'tactics', 'gunnery', 'maneuver', 'defense'];
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/** A reproducibility identifier covering the actual content and combat tables used by the lab. */
export function contentIdentity(): LabConfig['content'] {
  // account-exclusive content (BB-EX) is not part of the ordinary content tables: leaving it out keeps
  // every stored experiment of ordinary ships valid when that content changes
  const X = CONTENT.exclusive, xw = (id: string) => X.has(`eq_${id}`) || id === 'fnl_ex';
  const keep = <T,>(o: Record<string, T>, drop: (k: string, v: T) => boolean) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !drop(k, v)));
  const data = JSON.stringify([keep(CONTENT.hulls, k => X.has(k)), keep(CONTENT.variants, (_k, v) => X.has(v.hull)), keep(CONTENT.presets, (_k, v) => X.has(v.hull)), keep(CONTENT.equipment, k => X.has(k)), SHIP_CLASSES, keep(EQUIPMENT, k => X.has(k)), keep(WEAPONS, k => xw(k)), TECHS]);
  let h = 2166136261; for (let i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 16777619); }
  return { version: CONTENT_VERSION, fingerprint: `fnv1a32-${(h >>> 0).toString(16).padStart(8, '0')}`, packs: CONTENT.packs.map(p => p.id) };
}

export const availableHulls = () => Object.values(CONTENT.hulls).filter(h => !h.dev && !!SHIP_CLASSES[h.classId]);
export function defaultShip(hull: string, id: string, variant?: string): LabShip {
  const h = CONTENT.hulls[hull];
  if (!h || h.dev) throw new Error('사용할 수 없는 선체입니다');
  const v = variantsOfHull(hull).find(x => x.id === variant) ?? variantsOfHull(hull).find(x => x.id === `${hull}_std`) ?? variantsOfHull(hull)[0];
  if (!v) throw new Error('선체의 파생형이 없습니다');
  const presets = presetsOfHull(hull).filter(p => p.variant === v.id);
  const p = presets[0];
  return { id, hull, variant: v.id, fitting: { hp: { ...(p?.weapons ?? {}) }, bay: {} }, count: 1 };
}

/** Construct v2 through the same migration as a saved DEV-1 setup. */
export function defaultConfig(): LabConfig {
  const commander = { skill: .4, aggression: .5, discipline: .75, specialty: 'none' as const };
  const legacyShip = (hull: string, id: string) => ({ ...defaultShip(hull, id), group: CONTENT.hulls[hull].name, order: 'engage' as const });
  return migrateConfig({ schema: 'siderarium-combat-lab-1', content: contentIdentity(), seed: 1, distance: 2900, timeLimit: 540, speed: 1,
    sides: [{ name: 'BLUE', ships: [legacyShip('patrol_pathfinder', 'blue-1')], commander: { ...commander }, research: [] },
      { name: 'RED', ships: [legacyShip('corvette_mk1', 'red-1')], commander: { ...commander }, research: [] }] });
}

/** Strict validation is also used after JSON import, before constructing any engine objects. */
function legacyProblems(input: unknown): string[] {
  const errors: string[] = [];
  if (!record(input) || input.schema !== 'siderarium-combat-lab-1') return ['실험 설정 형식이 올바르지 않습니다'];
  if (!record(input.content) || input.content.fingerprint !== contentIdentity().fingerprint || input.content.version !== CONTENT_VERSION) errors.push('콘텐츠 식별자가 현재 빌드와 다릅니다');
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0x7fffffff) errors.push('시드는 0~2,147,483,647 정수여야 합니다');
  if (!finite(input.distance, 400, 6000)) errors.push('초기 기준 거리는 400~6,000이어야 합니다');
  if (!finite(input.timeLimit, 10, 3600)) errors.push('제한 시간은 10~3,600초여야 합니다');
  if (![.5, 1, 2, 4].includes(input.speed)) errors.push('배속이 올바르지 않습니다');
  if (!Array.isArray(input.sides) || input.sides.length !== 2) return [...errors, '두 진영이 필요합니다'];
  let count = 0;
  input.sides.forEach((side: unknown, team: number) => {
    const name = team ? 'RED' : 'BLUE';
    if (!record(side) || typeof side.name !== 'string' || side.name.length > 40 || !Array.isArray(side.ships) || !side.ships.length || side.ships.length > 200) { errors.push(`${name}: 편성이 필요합니다`); return; }
    if (!record(side.commander) || !finite(side.commander.skill, 0, 1) || !finite(side.commander.aggression, 0, 1) || !finite(side.commander.discipline, 0, 1) || !SPECIALTIES.includes(side.commander.specialty)) errors.push(`${name}: 지휘관 능력이 올바르지 않습니다`);
    if (!Array.isArray(side.research) || side.research.length > Object.keys(TECHS).length || new Set(side.research).size !== side.research.length || side.research.some((t: unknown) => typeof t !== 'string' || !Object.hasOwn(TECHS, t))) errors.push(`${name}: 알 수 없는 연구가 있습니다`);
    const ids = new Set<string>();
    for (const ship of side.ships) {
      if (!record(ship) || typeof ship.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(ship.id) || ids.has(ship.id) || typeof ship.group !== 'string' || !ship.group.trim() || ship.group.length > 40 || !Number.isInteger(ship.count) || ship.count < 1 || ship.count > 200 || !ORDERS.includes(ship.order)) { errors.push(`${name}: 편대 정보가 올바르지 않습니다`); continue; }
      ids.add(ship.id); count += ship.count;
      const hull = typeof ship.hull === 'string' ? CONTENT.hulls[ship.hull] : undefined;
      if (!hull || hull.dev || !SHIP_CLASSES[hull.classId] || typeof ship.variant !== 'string' || CONTENT.variants[ship.variant]?.hull !== ship.hull) { errors.push(`${name}: 알 수 없거나 사용할 수 없는 선체·파생형`); continue; }
      if (!record(ship.fitting) || !record(ship.fitting.hp) || !record(ship.fitting.bay) || [...Object.entries(ship.fitting.hp), ...Object.entries(ship.fitting.bay)].some(([k, v]) => k.length > 60 || typeof v !== 'string' || v.length > 80)) { errors.push(`${name}: 피팅 형식 오류`); continue; }
      for (const problem of checkFitting(ship.variant, ship.fitting as ShipFitting).errors) errors.push(`${name} ${ship.group}: ${problem}`);
    }
  });
  if (count > 200) errors.push('브라우저 안정성을 위해 전투당 함선은 최대 200척입니다');
  return errors;
}

/** Old flat rows become separate root children, retaining their original insertion order,
 * names, orders, commander, ship refs and counts. This is needed for deterministic replays. */
export function migrateConfig(input: unknown): LabConfig {
  if (record(input) && input.schema === 'siderarium-combat-lab-2') {
    const errors = configProblems(input); if (errors.length) throw new Error(errors.join(' · '));
    return structuredClone(input) as LabConfig;
  }
  const errors = legacyProblems(input); if (errors.length) throw new Error(errors.join(' · '));
  const old = input as any;
  const sides = old.sides.map((side: any) => {
    const commander: CommanderDef = { ...ACTING_CAPTAIN, ...side.commander, id: 'lab-legacy', name: '실험 지휘관' };
    const children: LabGroup[] = side.ships.map((row: any) => ({ name: row.group, commander: { ...commander }, order: row.order,
      retreatAt: 0, ships: [{ id: row.id, hull: row.hull, variant: row.variant, fitting: structuredClone(row.fitting), count: row.count }], children: [] }));
    return { name: side.name, research: [...side.research], root: { name: side.name, commander: { ...commander }, order: 'engage', retreatAt: 0, ships: [], children } };
  }) as [LabSide, LabSide];
  return { schema: 'siderarium-combat-lab-2', content: structuredClone(old.content), seed: old.seed, distance: old.distance,
    timeLimit: old.timeLimit, speed: old.speed, sides, presets: [] };
}

/** Validate imported settings before walking trees or constructing engine objects. */
export function configProblems(input: unknown): string[] {
  if (record(input) && input.schema === 'siderarium-combat-lab-1') return legacyProblems(input);
  const errors: string[] = [];
  if (!record(input) || input.schema !== 'siderarium-combat-lab-2') return ['실험 설정 형식이 올바르지 않습니다'];
  if (!record(input.content) || input.content.fingerprint !== contentIdentity().fingerprint || input.content.version !== CONTENT_VERSION) errors.push('콘텐츠 식별자가 현재 빌드와 다릅니다');
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0x7fffffff) errors.push('시드는 0~2,147,483,647 정수여야 합니다');
  if (!finite(input.distance, 400, 6000)) errors.push('초기 기준 거리는 400~6,000이어야 합니다');
  if (!finite(input.timeLimit, 10, 3600)) errors.push('제한 시간은 10~3,600초여야 합니다');
  if (![.5, 1, 2, 4].includes(input.speed)) errors.push('배속이 올바르지 않습니다');
  if (!Array.isArray(input.sides) || input.sides.length !== 2) return [...errors, '두 진영이 필요합니다'];
  let total = 0;
  for (let team = 0; team < 2; team++) {
    const side = input.sides[team], label = team ? 'RED' : 'BLUE';
    if (!record(side) || typeof side.name !== 'string' || side.name.length > 40) { errors.push(`${label}: 편성이 필요합니다`); continue; }
    if (!Array.isArray(side.research) || side.research.length > Object.keys(TECHS).length || new Set(side.research).size !== side.research.length || side.research.some((t: unknown) => typeof t !== 'string' || !Object.hasOwn(TECHS, t))) errors.push(`${label}: 알 수 없는 연구가 있습니다`);
    const ids = new Set<string>(), seen = new Set<object>(); let groups = 0, count = 0;
    const visit = (group: unknown, depth: number) => {
      if (!record(group) || seen.has(group) || depth > 20 || ++groups > 400 || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 40 || !Array.isArray(group.ships) || !Array.isArray(group.children) || group.ships.length > 200 || group.children.length > 200 || !ORDERS.includes(group.order) || !finite(group.retreatAt, 0, 1)) { errors.push(`${label}: 부대 정보가 올바르지 않습니다`); return; }
      seen.add(group);
      const cmd = group.commander;
      if (cmd !== null && (!record(cmd) || typeof cmd.id !== 'string' || cmd.id.length > 100 || typeof cmd.name !== 'string' || cmd.name.length > 40 || typeof cmd.rank !== 'string' || cmd.rank.length > 40 || typeof cmd.bio !== 'string' || cmd.bio.length > 500 || typeof cmd.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(cmd.color) || !['calm','bold','formal','nervous','cold','savage'].includes(cmd.voice) || !finite(cmd.skill,0,1) || !finite(cmd.aggression,0,1) || !finite(cmd.discipline,0,1) || !SPECIALTIES.includes(cmd.specialty))) errors.push(`${label}: 지휘관 능력이 올바르지 않습니다`);
      for (const ship of group.ships) {
        if (!record(ship) || typeof ship.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/.test(ship.id) || ids.has(ship.id) || !Number.isInteger(ship.count) || ship.count < 1 || ship.count > 200) { errors.push(`${label}: 편대 정보가 올바르지 않습니다`); continue; }
        ids.add(ship.id); count += ship.count; total += ship.count;
        const hull = typeof ship.hull === 'string' ? CONTENT.hulls[ship.hull] : undefined;
        if (!hull || hull.dev || !SHIP_CLASSES[hull.classId] || typeof ship.variant !== 'string' || CONTENT.variants[ship.variant]?.hull !== ship.hull) { errors.push(`${label}: 알 수 없거나 사용할 수 없는 선체·파생형`); continue; }
        if (!record(ship.fitting) || !record(ship.fitting.hp) || !record(ship.fitting.bay) || [...Object.entries(ship.fitting.hp), ...Object.entries(ship.fitting.bay)].some(([k,v]) => k.length > 60 || typeof v !== 'string' || v.length > 80)) { errors.push(`${label}: 피팅 형식 오류`); continue; }
        for (const problem of checkFitting(ship.variant, ship.fitting as ShipFitting).errors) errors.push(`${label} ${group.name}: ${problem}`);
      }
      for (const child of group.children) visit(child, depth + 1);
    };
    visit(side.root, 0); if (!count) errors.push(`${label}: 편성이 필요합니다`);
  }
  if (total > 200) errors.push('브라우저 안정성을 위해 전투당 함선은 최대 200척입니다');
  if (!Array.isArray(input.presets) || input.presets.length > 200 || input.presets.some((p: unknown) => !record(p) || typeof p.id !== 'string' || p.id.length > 60 || typeof p.name !== 'string' || p.name.length > 40 || typeof p.hull !== 'string' || typeof p.variant !== 'string' || CONTENT.variants[p.variant]?.hull !== p.hull || !record(p.hp) || !record(p.bay) || [...Object.entries(p.hp), ...Object.entries(p.bay)].some(([k,v]) => k.length > 60 || typeof v !== 'string' || v.length > 80) || checkFitting(p.variant, { hp: p.hp, bay: p.bay } as ShipFitting).errors.length > 0)) errors.push('프리셋 형식이 올바르지 않습니다');
  return errors;
}

export function allLabGroups(root: LabGroup): LabGroup[] {
  const out: LabGroup[] = []; const walk = (g: LabGroup) => { out.push(g); g.children.forEach(walk); }; walk(root); return out;
}
export function labShipCount(side: LabSide): number { return allLabGroups(side.root).reduce((n, g) => n + g.ships.reduce((a,s) => a + s.count, 0), 0); }

function shipFx(ship: LabShip, tech: string[]): ShipFx {
  const mods = bayModules(ship.variant, ship.fitting), fx = fitFx(mods, tech), g = growthFx(mods, tech);
  const out: ReturnType<typeof fitFx> & ShipFx = { ...fx };
  for (const k of ['hpMul', 'armorMul', 'speedMul', 'accMul', 'pdMul'] as const) if (g[k] !== undefined) out[k] *= g[k]!;
  if (g.evasion) out.evasion += g.evasion;
  if (g.shield) { out.shield = g.shield; out.shieldRegen = g.shieldRegen; }
  if (g.fam) out.fam = g.fam;
  return out;
}

export function battleSetup(config: LabConfig, seed = config.seed, swapped = false): BattleSetup {
  const errors = configProblems(config); if (errors.length) throw new Error(errors.join('\n'));
  const sides = swapped ? [config.sides[1], config.sides[0]] : config.sides;
  const fleets = sides.map((side, team): FleetSpec => {
    const toGroup = (group: LabGroup): GroupSpec => ({
      name: group.name,
      commander: group.commander ? { ...group.commander, id: group.commander.id === 'lab-legacy' ? `lab-${team}` : group.commander.id, team: team as 0 | 1 } : null,
      order: group.order, retreatAt: group.retreatAt,
      ships: group.ships.flatMap(row => {
        const hull = CONTENT.hulls[row.hull], label = loadoutLabel(hull.classId, row.variant, row.fitting);
        const fitted = shipLoadout({ classId: hull.classId, loadoutId: label, variant: row.variant, fitting: row.fitting });
        const ship: ShipSpec = { classId: hull.classId, loadoutId: label, fx: shipFx(row, side.research), fit: fitted };
        return Array.from({ length: row.count }, (_, i) => ({ ...ship, ref: `${row.id}:${i}` }));
      }),
      children: group.children.map(toGroup),
    });
    return { name: side.name, root: toGroup(side.root) };
  }) as [FleetSpec, FleetSpec];
  return { seed, scenarioId: 'kestrel', fleets, spawnZ: config.distance / 2, timeLimit: config.timeLimit };
}

const zero = (): SideResult => ({ survivors: 0, destroyed: 0, kills: 0, escaped: 0, dealt: 0, taken: 0, hull: 0, maxHull: 0, shots: 0, hits: 0, intercepts: 0 });
export function resultOf(world: World, seed: number, swapped: boolean): BattleResult {
  if (!world.outcome) throw new Error('완료되지 않은 전투입니다');
  const sides: [SideResult, SideResult] = [zero(), zero()];
  for (const ship of world.ships) {
    const side = sides[swapped ? 1 - ship.team : ship.team];
    if (ship.state === 'alive' || ship.state === 'escaped') side.survivors++;
    if (ship.state === 'dead' || ship.state === 'dying') side.destroyed++;
    side.kills += ship.stats.kills;
    if (ship.state === 'escaped') side.escaped++;
    side.dealt += ship.stats.dmgDealt; side.taken += ship.stats.dmgTaken;
    side.hull += Math.max(0, ship.hp); side.maxHull += ship.maxHp;
    side.shots += ship.stats.shots; side.hits += ship.stats.hits; side.intercepts += ship.stats.intercepts;
  }
  const winner = world.outcome.winner < 0 ? -1 : swapped ? 1 - world.outcome.winner : world.outcome.winner;
  return { seed, swapped, winner: winner as 0 | 1 | -1, reason: world.outcome.reason, time: world.outcome.time, digest: world.digest(), sides };
}

export function runBattle(config: LabConfig, seed: number, swapped: boolean): BattleResult {
  const world = new World(battleSetup(config, seed, swapped));
  while (!world.outcome) world.step();
  return resultOf(world, seed, swapped);
}

export function summarize(battles: BattleResult[]): Summary {
  const total = battles.length, wins: [number, number] = [0, 0], sums: [SideResult, SideResult] = [zero(), zero()];
  let draws = 0, duration = 0;
  for (const battle of battles) {
    if (battle.winner === -1) draws++; else wins[battle.winner]++;
    duration += battle.time;
    for (const team of [0, 1] as const) for (const key of Object.keys(sums[team]) as (keyof SideResult)[]) sums[team][key] += battle.sides[team][key];
  }
  const meanSides = sums.map(s => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, total ? v / total : 0])) as unknown as SideResult) as [SideResult, SideResult];
  return { total, wins, draws, winRate: [total ? wins[0] / total : 0, total ? wins[1] / total : 0], meanTime: total ? duration / total : 0, meanSides };
}
