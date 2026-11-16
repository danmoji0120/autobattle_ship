// B-1 officer development — the rules.
//
// An officer (a WCommander with `of`) grows in two ways at once:
//  - officer level from experience: every level gives skill points (SP) the player invests in nodes;
//  - field mastery from the work the officer actually did: mastery opens the higher tiers of that field.
// Experience comes only from real results (ore mined, cargo delivered, damage dealt to a hostile company…),
// each source has its own rate, a game-hour budget stops idle farming from scaling, and every one-off
// award (a delivery, a battle) carries a key that is recorded so it can never be paid twice.
//
// Effects are resolved here and read by the systems that own them (battle setup, mining, salvage, logistics,
// station production, exploration, upkeep). Each effect has one domain: it only applies to the work of the
// group the officer commands, or to the station they direct. An officer is either a group commander or a
// station director, never both, so no effect can be counted twice.
//
// Gate: WorldState.officerV (new standard worlds; saves only by the explicit migration in migrateOfficers).
import type { WorldState, WCommander, WGroup, WShip, Station } from './types';
import {
  SKILL, SKILLS, TRAIT, GENERIC_TRAITS, SPECIALTY_TRAIT, NAMED, NAMED_BY_ID, FX, FX_KEYS, TREE_IDS, TREE_NAME, TIER_GATE, MAX_CAPSTONES,
  MAX_LEVEL, xpToNext, spForLevel, masteryLevel, MASTERY, MASTERY_NAME, XP_SOFT_HOUR, XP_HARD_HOUR, FOCUS_BONUS, FOCUS_COOLDOWN, PAY,
  type Tree, type FxKey, type FxMap, type SkillNode, type NamedOfficer,
} from './officerData';
import { hashId } from './geom';

export interface OfficerLog { t: number; k: 'level' | 'mastery' | 'learn' | 'feat' | 'post' | 'hire' | 'migrate' | 'focus' | 'battle'; text: string }
export interface OfficerState {
  v: 1;
  trait: string;
  /** extra experience share (0..0.3): ordinary officers learn faster, named officers start ahead */
  talent: number;
  mastery: Partial<Record<Tree, number>>;
  skills: Record<string, number>;
  /** unspent skill points; spGiven = every point the officer has received (spForLevel(level)) */
  sp: number; spGiven: number;
  focus?: Tree; focusAt?: number;
  /** station director posting (never at the same time as a group command) */
  post?: { k: 'station'; id: string; since: number };
  named?: string;
  /** judgement from levels counts from this level on (a migrated officer keeps the skill its legacy levels gave) */
  lvBase: number;
  migrated?: { at: number; level: number; xp: number; battles: number };
  /** experience budget of the current game hour */
  hr?: { h: number; n: number };
  /** keys of one-off awards already paid (bounded) */
  seen?: string[];
  /** repeated fights against the same company: count and last time */
  foes?: Record<string, { n: number; t: number }>;
  /** lifetime experience by source */
  earned: Record<string, number>;
  log: OfficerLog[];
  feats: string[];
  rev: number;
  hiredAt?: number;
}

export const officersOn = (w: Pick<WorldState, 'officerV'>) => w.officerV === 1;
export type Officer = WCommander & { of: OfficerState };
export const isOfficer = (c: WCommander | null | undefined): c is Officer => !!c?.of;

const EMPTY: FxMap = Object.freeze({}) as FxMap;
const LOG_MAX = 60, SEEN_MAX = 80;

// ------------------------------------------------------------------------------------- creation

function pickTrait(c: WCommander): string {
  const h = hashId(c.id + ':trait');
  const spec = SPECIALTY_TRAIT[c.specialty];
  if (spec && h % 3 !== 0) return spec;
  return GENERIC_TRAITS[(h >>> 4) % GENERIC_TRAITS.length];
}

/** legacy history → starting combat mastery (a migrated or granted officer is not a blank slate) */
function seedMastery(c: WCommander, of: OfficerState) {
  const L = Math.max(1, Math.min(MAX_LEVEL, c.level | 0));
  const legacyXp = 50 * L * (L - 1) + Math.max(0, c.xp || 0);
  const total = Math.min(14999, legacyXp * 4 + (c.battles || 0) * 30);
  if (total <= 0) return;
  const main: Tree = c.specialty === 'gunnery' ? 'gunnery' : c.specialty === 'maneuver' ? 'maneuver' : c.specialty === 'defense' ? 'airdef' : 'command';
  const add = (t: Tree, v: number) => { of.mastery[t] = Math.min(14999, (of.mastery[t] ?? 0) + Math.round(v)); };
  add(main, total * 0.6); add(main === 'command' ? 'gunnery' : 'command', total * 0.25); add('defense', total * 0.15);
}

/** give an officer its development state (idempotent: an officer that has one is left alone) */
export function initOfficer(w: WorldState, c: WCommander, o: { named?: NamedOfficer; legacy?: boolean } = {}): OfficerState {
  if (c.of) return c.of;
  const L = Math.max(1, Math.min(MAX_LEVEL, Math.floor(c.level || 1)));
  // the level is kept exactly; experience inside the level keeps its share of the way to the next one
  const legacyNext = L * 100;
  const frac = Math.max(0, Math.min(0.999, (c.xp || 0) / legacyNext));
  c.level = L;
  c.xp = o.legacy ? Math.round(frac * xpToNext(L)) : Math.max(0, Math.min(xpToNext(L) - 1, Math.round(c.xp || 0)));
  const named = o.named ?? (c.id === 'bb' ? NAMED_BB : undefined);
  const of: OfficerState = {
    v: 1, trait: named?.trait ?? pickTrait(c), talent: named ? 0 : 0.05 + ((hashId(c.id + ':talent') >>> 3) % 26) / 100,
    mastery: { ...(named?.mastery ?? {}) }, skills: {}, sp: spForLevel(L), spGiven: spForLevel(L),
    lvBase: L, earned: {}, log: [], feats: [], rev: 1, ...(named ? { named: named.id } : {}),
  };
  if (!named || c.id === 'bb') seedMastery(c, of);
  c.of = of;
  if (o.legacy) { of.migrated = { at: w.time, level: L, xp: c.xp, battles: c.battles || 0 }; note(of, w.time, 'migrate', `장교 육성 체계 전환 — Lv.${L}, 스킬 포인트 ${of.sp}`); }
  checkFeats(c as Officer, w.time);
  return of;
}
/** BB: the account's unique commander takes part in development like everyone else (its causal ability is untouched) */
const NAMED_BB: NamedOfficer = { id: 'n_bb', trait: 'n_bb', sig: '', name: 'BB', rank: '', skill: 0, aggression: 0, discipline: 0, specialty: 'none', voice: 'calm', color: '', bio: '', level: 9, mastery: {}, hire: 0 };

/** officers who should have development state: the player's and those waiting in recruitment pools */
export function wantsOfficer(w: WorldState, c: WCommander): boolean {
  if (c.owner === null) return !!c.stationId;
  return w.companies[c.owner]?.kind === 'player';
}

/** new commanders (hired, generated, granted) get their state — run on load and on the slow tick */
export function ensureOfficers(w: WorldState) {
  if (!officersOn(w)) return;
  for (const c of Object.values(w.commanders)) if (!c.of && wantsOfficer(w, c)) initOfficer(w, c);
}

/** B-1 migration of an existing save: idempotent, non-destructive (names, ranks, levels, battles, owners and
 *  postings stay; experience inside the level is converted to the new curve; SP and starting mastery are granted once) */
export function migrateOfficers(w: WorldState): { converted: number; already: number; skipped: number } {
  const r = { converted: 0, already: 0, skipped: 0 };
  w.officerV = 1;
  for (const c of Object.values(w.commanders)) {
    if (c.of) { r.already++; continue; }
    if (!wantsOfficer(w, c)) { r.skipped++; continue; }
    initOfficer(w, c, { legacy: true }); r.converted++;
  }
  return r;
}

// ---------------------------------------------------------------------------------------- effects

const cache = new WeakMap<OfficerState, { rev: number; fx: FxMap }>();
/** every effect the officer has (skills × rank + trait), each clamped to its cap */
export function officerFx(c: WCommander | null | undefined): FxMap {
  const of = c?.of; if (!of) return EMPTY;
  const hit = cache.get(of); if (hit && hit.rev === of.rev) return hit.fx;
  const fx: FxMap = {};
  const add = (k: FxKey, v: number) => { fx[k] = (fx[k] ?? 0) + v; };
  for (const [id, rank] of Object.entries(of.skills)) {
    const n = SKILL[id]; if (!n || rank <= 0) continue;
    for (const [k, v] of Object.entries(n.fx) as [FxKey, number][]) add(k, FX[k].unit === 'flag' ? v : v * rank);
  }
  for (const [k, v] of Object.entries(TRAIT[of.trait]?.fx ?? {}) as [FxKey, number][]) add(k, v);
  for (const k of Object.keys(fx) as FxKey[]) fx[k] = Math.min(FX[k].cap, Math.max(0, fx[k]!));
  cache.set(of, { rev: of.rev, fx });
  return fx;
}

/** the officer commanding this group right now (development worlds; injured officers do not command) */
export function groupOfficer(w: WorldState, g: WGroup | null | undefined): Officer | null {
  if (!g || w.officerV !== 1 || !g.commanderId) return null;
  const c = w.commanders[g.commanderId];
  return isOfficer(c) && c.injuredUntil <= w.time && c.owner === g.owner ? c : null;
}
export const groupFx = (w: WorldState, g: WGroup | null | undefined): FxMap => officerFx(groupOfficer(w, g));
export const shipFx = (w: WorldState, s: WShip): FxMap => w.officerV === 1 ? groupFx(w, w.groups[s.groupId]) : EMPTY;

/** effective judgement (skill) of an officer: base + learned judgement + levels gained under this system */
export function effSkill(c: WCommander): number {
  if (!c.of) return c.skill;
  return Math.min(0.97, c.skill + (officerFx(c).skill ?? 0) + 0.004 * Math.max(0, c.level - c.of.lvBase));
}

const BATTLE_KEYS = FX_KEYS.filter(k => FX[k].domain === 'battle');
const AURA_SKIP = new Set<FxKey>(['aura', 'auraAir', 'skill', 'think', 'coord', 'mineGuard']);
const AIR_KEYS: FxKey[] = ['pd', 'pdRange', 'torpPd'];
/** battle effects of a group: its own officer's, and what commanding officers above it pass down (aura).
 *  A passed-down value never adds to the group's own: the larger of the two applies. */
export function battleFx(w: WorldState, g: WGroup | null | undefined): Record<string, number> | undefined {
  if (!g || w.officerV !== 1) return undefined;
  const own = groupFx(w, g);
  const out: Record<string, number> = {};
  for (const k of BATTLE_KEYS) { const v = own[k]; if (v) out[k] = v; }
  if (own.mineGuard && g.op.k === 'mine') out.armor = Math.min(FX.armor.cap, (out.armor ?? 0) + own.mineGuard);
  delete out.mineGuard;
  let p = g.parentId ? w.groups[g.parentId] : undefined; let guard = 0;
  while (p && guard++ < 12) {
    const a = groupFx(w, p);
    if (a.aura) for (const k of BATTLE_KEYS) { if (AURA_SKIP.has(k) || FX[k].unit === 'flag') continue; const v = (a[k] ?? 0) * a.aura; if (v > (out[k] ?? 0)) out[k] = v; }
    if (a.auraAir) for (const k of AIR_KEYS) { const v = (a[k] ?? 0) * 0.5; if (v > (out[k] ?? 0)) out[k] = v; }
    p = p.parentId ? w.groups[p.parentId] : undefined;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1e5) / 1e5;
  return Object.keys(out).length ? out : undefined;
}

/** mining speed bonus of a group: its own officer's, or a share of a commanding mining chief's (larger applies) */
export function mineBonus(w: WorldState, g: WGroup): number {
  let v = groupFx(w, g).mine ?? 0;
  let p = g.parentId ? w.groups[g.parentId] : undefined; let guard = 0;
  while (p && guard++ < 12) { const a = groupFx(w, p); if (a.mineAura) v = Math.max(v, (a.mine ?? 0) * a.mineAura); p = p.parentId ? w.groups[p.parentId] : undefined; }
  return Math.min(FX.mine.cap, v);
}

const dirCache = new WeakMap<WorldState, { t: number; m: Map<string, Officer> }>();
/** the officer directing a station (posted there, same owner, not injured) */
export function stationDirector(w: WorldState, stationId: string): Officer | null {
  if (w.officerV !== 1) return null;
  let d = dirCache.get(w);
  if (!d || d.t !== w.time) {
    d = { t: w.time, m: new Map() };
    for (const c of Object.values(w.commanders)) if (isOfficer(c) && c.of.post?.k === 'station' && c.owner && w.stations[c.of.post.id]?.owner === c.owner && c.injuredUntil <= w.time) d.m.set(c.of.post.id, c);
    dirCache.set(w, d);
  }
  return d.m.get(stationId) ?? null;
}
export const stationFx = (w: WorldState, stationId: string): FxMap => officerFx(stationDirector(w, stationId));

// ------------------------------------------------------------------------------------- experience

export type XpSource = 'combat' | 'mine' | 'salvage' | 'logistics' | 'industry' | 'research' | 'build' | 'construct' | 'survey' | 'discover' | 'site' | 'support';
export interface XpResult { gain: number; notes: string[] }

function note(of: OfficerState, t: number, k: OfficerLog['k'], text: string) {
  of.log.push({ t, k, text });
  if (of.log.length > LOG_MAX) of.log.splice(0, of.log.length - LOG_MAX);
}

const FEATS: { id: string; name: string; test: (c: Officer) => boolean }[] = [
  { id: 'lv10', name: '숙련 장교 (Lv.10)', test: c => c.level >= 10 },
  { id: 'lv20', name: '베테랑 (Lv.20)', test: c => c.level >= 20 },
  { id: 'lv30', name: '전설의 장교 (Lv.30)', test: c => c.level >= 30 },
  { id: 'lv40', name: '최고 계급 (Lv.40)', test: c => c.level >= 40 },
  { id: 'm3', name: '첫 전문 분야 (숙련도 전문)', test: c => Object.values(c.of.mastery).some(v => masteryLevel(v ?? 0) >= 3) },
  { id: 'm5', name: '분야의 전설 (숙련도 전설)', test: c => Object.values(c.of.mastery).some(v => masteryLevel(v ?? 0) >= 5) },
  { id: 'cap1', name: '최종 전문화 달성', test: c => Object.keys(c.of.skills).some(id => SKILL[id]?.tier === 5) },
  { id: 'cap2', name: '이중 전문화', test: c => Object.keys(c.of.skills).filter(id => SKILL[id]?.tier === 5).length >= 2 },
  { id: 'b25', name: '역전의 지휘관 (교전 25회)', test: c => (c.battles || 0) >= 25 },
  { id: 'b100', name: '백전노장 (교전 100회)', test: c => (c.battles || 0) >= 100 },
  { id: 'multi', name: '다재다능 (세 분야 숙련)', test: c => Object.values(c.of.mastery).filter(v => masteryLevel(v ?? 0) >= 2).length >= 3 },
];
export const FEAT_NAME = Object.fromEntries(FEATS.map(f => [f.id, f.name]));
function checkFeats(c: Officer, t: number, notes?: string[]) {
  for (const f of FEATS) if (!c.of.feats.includes(f.id) && f.test(c)) { c.of.feats.push(f.id); note(c.of, t, 'feat', `업적: ${f.name}`); notes?.push(`업적 달성 — ${f.name}`); }
}

/** pay experience for real work. `split` is how the work divides between fields (weights; they are normalised).
 *  `key` makes a one-off award (a delivery, a battle) payable once. Returns what was actually given. */
export function grantXp(w: WorldState, c: WCommander | null | undefined, src: XpSource, amount: number, split: Partial<Record<Tree, number>>, key?: string): XpResult {
  const res: XpResult = { gain: 0, notes: [] };
  if (!isOfficer(c) || w.officerV !== 1 || !(amount > 0) || !Number.isFinite(amount)) return res;
  const of = c.of;
  if (key) { const seen = (of.seen ??= []); if (seen.includes(key)) return res; seen.push(key); if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX); }
  // game-hour budget: full pay up to SOFT, a quarter up to HARD, nothing beyond (no idle farming, tick-rate independent)
  const h = Math.floor(w.time / 3600);
  if (!of.hr || of.hr.h !== h) of.hr = { h, n: 0 };
  let want = amount * (1 + of.talent), gain = 0, n = of.hr.n;
  if (n < XP_SOFT_HOUR) { const a = Math.min(want, XP_SOFT_HOUR - n); gain += a; n += a; want -= a; }
  if (want > 0 && n < XP_HARD_HOUR) { const a = Math.min(want / 4, XP_HARD_HOUR - n); gain += a; n += a; }
  of.hr.n = n;
  if (gain <= 0) return res;
  res.gain = gain;
  of.earned[src] = (of.earned[src] ?? 0) + gain;
  // officer level
  if (c.level < MAX_LEVEL) {
    c.xp += gain;
    while (c.level < MAX_LEVEL && c.xp >= xpToNext(c.level)) {
      c.xp -= xpToNext(c.level); c.level++;
      const sp = spForLevel(c.level) - of.spGiven;
      if (sp > 0) { of.sp += sp; of.spGiven += sp; }
      note(of, w.time, 'level', `Lv.${c.level} 달성 — 스킬 포인트 +${sp}`);
      res.notes.push(`Lv.${c.level} 달성 (스킬 포인트 +${sp})`);
    }
    if (c.level >= MAX_LEVEL) c.xp = 0;
  }
  // field mastery (trait, focus; a named officer's weak field grows slower)
  const tot = Object.values(split).reduce((x, v) => x + (v ?? 0), 0);
  const tr = TRAIT[of.trait];
  if (tot > 0) for (const [t, wgt] of Object.entries(split) as [Tree, number][]) {
    if (!wgt) continue;
    const before = masteryLevel(of.mastery[t] ?? 0);
    const mul = Math.max(0.2, 1 + (tr?.grow[t] ?? 0) + (of.focus === t ? FOCUS_BONUS : 0));
    of.mastery[t] = Math.round(((of.mastery[t] ?? 0) + gain * wgt / tot * mul) * 100) / 100;
    const after = masteryLevel(of.mastery[t]!);
    if (after > before) { note(of, w.time, 'mastery', `${TREE_NAME[t]} 숙련도 ${MASTERY_NAME[after]} 달성`); res.notes.push(`${TREE_NAME[t]} 숙련도 → ${MASTERY_NAME[after]}`); }
  }
  checkFeats(c, w.time, res.notes);
  return res;
}

/** experience per hour of real work an officer can still earn at full rate (UI / checks) */
export const xpRoom = (w: WorldState, c: Officer) => { const h = Math.floor(w.time / 3600); return Math.max(0, XP_SOFT_HOUR - (c.of.hr?.h === h ? c.of.hr.n : 0)); };

export interface BattleShare { dmg: number; taken: number; intercepts: number; killValue: number; rear: number; ships: number; role: string; op: string }
/** combat experience of one group's officer after a settled engagement. Only fights against a hostile company count;
 *  the same opponent again within two hours gives less each time (no farming a friendly sparring partner). */
export function combatXp(w: WorldState, c: Officer, b: BattleShare, foes: string[], key: string): XpResult {
  const fought = b.dmg > 0 || b.taken > 0 || b.intercepts > 0;
  if (!fought || !foes.length) return { gain: 0, notes: [] };
  if (c.of.seen?.includes(key)) return { gain: 0, notes: [] };
  const amount = 15 + Math.min(400, b.killValue / 8) + Math.min(200, b.dmg / 300) + Math.min(100, b.intercepts * 2) + Math.min(80, b.taken / 600);
  const foesRec = (c.of.foes ??= {});
  let rep = 0;
  for (const f of foes) { const r = foesRec[f]; if (r && w.time - r.t < 7200) rep = Math.max(rep, r.n); }
  for (const f of foes) { const r = foesRec[f]; foesRec[f] = { n: r && w.time - r.t < 7200 ? r.n + 1 : 1, t: w.time }; }
  for (const k of Object.keys(foesRec)) if (w.time - foesRec[k].t > 7200) delete foesRec[k];
  const mul = 1 / (1 + rep);
  const opMil = ['patrol', 'intercept', 'blockade', 'defend', 'escort', 'amove', 'harass', 'recon', 'attack', 'plunder'].includes(b.op);
  const split: Partial<Record<Tree, number>> = {
    gunnery: b.dmg / 300 + 1, airdef: b.intercepts * 2, defense: b.taken / 600 + 1, command: 4 + b.killValue / 40,
    maneuver: b.rear * 4 + (b.role === 'raider' ? 4 : 1), intercept: opMil ? 4 : 1, ew: 2,
  };
  const r = grantXp(w, c, 'combat', amount * mul, split, key);
  if (r.gain > 0) note(c.of, w.time, 'battle', `교전 경험 +${Math.round(r.gain)}${rep ? ` (같은 상대 반복 ×${mul.toFixed(2)})` : ''}`);
  return r;
}

// ------------------------------------------------------------------------------------- learning

/** why a node cannot be learned now (null = it can) */
export function learnBlock(c: WCommander, n: SkillNode | undefined): string | null {
  if (!isOfficer(c)) return '장교 육성 정보 없음';
  if (!n) return '알 수 없는 스킬';
  const of = c.of;
  const rank = of.skills[n.id] ?? 0;
  if (n.sig && of.named !== n.sig) return '다른 장교의 고유 능력';
  if (rank >= n.max) return '이미 최대 단계';
  const gate = TIER_GATE[n.tier];
  if (c.level < gate.level) return `장교 Lv.${gate.level} 필요`;
  if (masteryLevel(of.mastery[n.tree] ?? 0) < gate.mastery) return `${TREE_NAME[n.tree]} 숙련도 ${MASTERY_NAME[gate.mastery]}(${MASTERY[gate.mastery].toLocaleString()}) 필요`;
  for (const r of n.req ?? []) if (!of.skills[r]) return `선행: ${SKILL[r]?.name ?? r}`;
  if (n.reqAny?.length && !n.reqAny.some(r => of.skills[r])) return `선행: ${n.reqAny.map(r => SKILL[r]?.name ?? r).join(' 또는 ')}`;
  if (n.cross && !of.skills[n.cross]) return `연계 선행: ${TREE_NAME[SKILL[n.cross]?.tree] ?? ''} "${SKILL[n.cross]?.name ?? n.cross}"`;
  if (n.ex) { const o = SKILLS.find(x => x.ex === n.ex && x.id !== n.id && of.skills[x.id]); if (o) return `"${o.name}"과(와) 함께 배울 수 없음`; }
  if (n.tier === 5 && rank === 0 && Object.keys(of.skills).filter(id => SKILL[id]?.tier === 5).length >= MAX_CAPSTONES) return `최종 전문화는 ${MAX_CAPSTONES}개까지`;
  if (of.sp < n.cost) return `스킬 포인트 ${n.cost} 필요 (보유 ${of.sp})`;
  return null;
}

export function learn(w: WorldState, c: WCommander, nodeId: unknown): string | null {
  const n = typeof nodeId === 'string' && Object.hasOwn(SKILL, nodeId) ? SKILL[nodeId] : undefined;
  const why = learnBlock(c, n); if (why) return why;
  const of = (c as Officer).of;
  of.sp -= n!.cost;
  of.skills[n!.id] = (of.skills[n!.id] ?? 0) + 1;
  of.rev++;
  note(of, w.time, 'learn', `${TREE_NAME[n!.tree]} "${n!.name}"${n!.max > 1 ? ` ${of.skills[n!.id]}단계` : ''} 습득`);
  checkFeats(c as Officer, w.time);
  return null;
}

export function setFocus(w: WorldState, c: WCommander, tree: unknown): string | null {
  if (!isOfficer(c)) return '장교 육성 정보 없음';
  const t = tree === null || tree === '' ? undefined : (TREE_IDS as unknown[]).includes(tree) ? tree as Tree : null;
  if (t === null) return '알 수 없는 분야';
  if (c.of.focus === t) return null;
  if (c.of.focusAt !== undefined && w.time - c.of.focusAt < FOCUS_COOLDOWN) return `훈련 방향은 ${Math.ceil((FOCUS_COOLDOWN - (w.time - c.of.focusAt)) / 60)}분 뒤에 바꿀 수 있음`;
  c.of.focus = t; c.of.focusAt = w.time;
  note(c.of, w.time, 'focus', t ? `훈련 방향: ${TREE_NAME[t]}` : '훈련 방향 해제');
  return null;
}

/** station director posting. Posting releases any group command; a station has one director. */
export function setPost(w: WorldState, company: string, c: WCommander, stationId: unknown): string | null {
  if (!isOfficer(c) || c.owner !== company) return '장교 없음';
  if (stationId === null || stationId === '') {
    if (c.of.post) { note(c.of, w.time, 'post', `${w.stations[c.of.post.id]?.name ?? ''} 책임자 해임`); delete c.of.post; }
    return null;
  }
  const st = typeof stationId === 'string' ? w.stations[stationId] : undefined;
  if (!st || st.owner !== company || st.public) return '자사 정거장에만 책임자를 둘 수 있음';
  const other = Object.values(w.commanders).find(o => o.id !== c.id && o.of?.post?.id === st.id && o.owner === company);
  if (other) return `${other.name}이(가) 이미 책임자`;
  for (const g of Object.values(w.groups)) if (g.commanderId === c.id) g.commanderId = null;
  c.of.post = { k: 'station', id: st.id, since: w.time };
  note(c.of, w.time, 'post', `${st.name} 정거장 책임자 부임`);
  return null;
}
/** a group command ends a station posting (one posting at a time) */
export function onAssigned(w: WorldState, c: WCommander) {
  if (isOfficer(c) && c.of.post) { note(c.of, w.time, 'post', `${w.stations[c.of.post.id]?.name ?? ''} 책임자 → 함대 지휘로 이동`); delete c.of.post; }
}

// ------------------------------------------------------------------------------------- pay & roster

export interface PayLine { id: string; name: string; post: string; perHour: number }
/** officer salaries of a company (per game hour). Pay follows the posting and its size, plus a small
 *  allowance per level — never a penalty; unpaid salary becomes ordinary upkeep debt. */
export function payroll(w: WorldState, company: string): { perHour: number; lines: PayLine[] } {
  const out = { perHour: 0, lines: [] as PayLine[] };
  if (w.officerV !== 1) return out;
  const cmdOf = new Map<string, WGroup>();
  for (const g of Object.values(w.groups)) if (g.owner === company && g.commanderId) cmdOf.set(g.commanderId, g);
  for (const c of Object.values(w.commanders)) {
    if (c.owner !== company || !isOfficer(c)) continue;
    const g = cmdOf.get(c.id);
    let base: number, post: string;
    if (g) {
      const ships = g.shipIds.length;
      base = PAY.command + Math.min(PAY.shipCap, ships * PAY.perShip) + g.childIds.length * PAY.perSubgroup;
      post = `${g.name} 지휘 (${ships}척${g.childIds.length ? `, 하위 ${g.childIds.length}` : ''})`;
    } else if (c.of.post && w.stations[c.of.post.id]) {
      const st = w.stations[c.of.post.id];
      base = PAY.director + (PAY.size[st.size ?? 'S'] ?? 0);
      post = `${st.name} 책임자`;
    } else { base = PAY.reserve; post = '대기'; }
    const perHour = Math.round((base + PAY.perLevel * (c.level - 1)) * (c.of.named ? PAY.named : 1));
    out.perHour += perHour; out.lines.push({ id: c.id, name: c.name, post, perHour });
  }
  return out;
}

/** a named officer not yet produced in this world, chosen by `roll` (0..1) */
export function nextNamed(w: WorldState, roll: number): NamedOfficer | null {
  const left = NAMED.filter(n => !w.officerNamed?.[n.id]);
  if (!left.length) return null;
  return left[Math.min(left.length - 1, Math.floor(roll * left.length))];
}
export function makeNamed(w: WorldState, n: NamedOfficer, id: string, stationId: string): WCommander {
  const c: WCommander = {
    id, owner: null, stationId, name: n.name, rank: n.rank, skill: n.skill, aggression: n.aggression, discipline: n.discipline, specialty: n.specialty,
    voice: n.voice, color: n.color, bio: n.bio, hireCost: n.hire, xp: 0, level: n.level, injuredUntil: 0, battles: 0,
  };
  (w.officerNamed ??= {})[n.id] = id;
  initOfficer(w, c, { named: n });
  return c;
}
/** hiring: the record starts; a hire is never refused for pay reasons later */
export function onHired(w: WorldState, c: WCommander) {
  if (!isOfficer(c)) return;
  c.of.hiredAt = w.time;
  note(c.of, w.time, 'hire', '입사');
}

/** progress of the current level 0..1 */
export const levelProgress = (c: WCommander) => c.level >= MAX_LEVEL ? 1 : Math.max(0, Math.min(1, c.xp / xpToNext(c.level)));
export { masteryLevel };
export type { Station };
