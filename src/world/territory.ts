// P10 territory: territorial factions, region types and the rules they impose.
//
// Factions here are territorial powers, not trading companies. Their economy (factionEcon.ts) only
// draws goods that physically exist in the stock of the public markets inside their territory, and
// turns them into fleet strength or infrastructure. No credits or goods are created by this module.
// Every rule is opt-in: worlds without `factions` (legacy, p9) behave exactly as before.
import type { Gate, StarSystem, WorldState, Station, Cargo } from './types';

export type RegionKind = 'capital' | 'industrial' | 'resource' | 'border' | 'neutral' | 'uncharted' | 'lawless';
export type FactionKind = 'government' | 'commerce' | 'industrial' | 'mining' | 'military' | 'pirate';

export interface FactionDef { id: string; name: string; short: string; color: string; kind: FactionKind; capital: string; desc: string; hostile?: boolean }
export const FACTIONS: Readonly<Record<string, FactionDef>> = {
  union: { id: 'union', name: '연합 관리청', short: '연합', color: '#6fb4ff', kind: 'government', capital: 'helios', desc: '수도권을 다스리는 행정 정부. 치안이 높고 세금과 규제가 엄격하다.' },
  guild: { id: 'guild', name: '상인 길드', short: '길드', color: '#ffd36b', kind: 'commerce', capital: 'astra', desc: '교역로와 중립 시장을 운영하는 상업 세력. 통과와 거래에 관대하다.' },
  ceres: { id: 'ceres', name: '세레스 공업연맹', short: '세레스', color: '#ff9f5a', kind: 'industrial', capital: 'ceres', desc: '제련·구조재 공장을 거느린 산업 세력. 광석과 금속을 대량으로 소비한다.' },
  miners: { id: 'miners', name: '변경 광업동맹', short: '광업동맹', color: '#7fd48b', kind: 'mining', capital: 'anvil', desc: '북방 광구를 운영하는 채광 조합 연합. 기계와 소모품이 늘 부족하다.' },
  iron: { id: 'iron', name: '철갑 사령부', short: '철갑', color: '#d86b6b', kind: 'military', capital: 'bulwark', desc: '동부 요새권의 군사 정권. 함선 부품과 장갑을 소비하며 해적과 국경을 맞댄다.' },
  pirates: { id: 'pirates', name: '해적 연합', short: '해적', color: '#b07cff', kind: 'pirate', capital: 'blackgate', hostile: true, desc: '무법 공역을 근거지로 삼는 약탈 세력.' },
};

/** What each region type actually changes. `found` and `risk` are read by rules; `patrol` is descriptive only
 *  (the security effect comes from each system's own `security`, set per region by worldgen-p10). */
export interface RegionRule {
  name: string;
  /** station founding: 'forbidden' | licence fee as a share of the foundation price | free */
  found: 'forbidden' | number;
  /** descriptive patrol level 0..3 (not read by any rule; system security carries the effect) */
  patrol: number;
  /** extra transport risk added to route risk (logistics/procurement) */
  risk: number;
  desc: string;
}
export const REGION_RULES: Readonly<Record<RegionKind, RegionRule>> = {
  capital: { name: '수도', found: 'forbidden', patrol: 3, risk: 0, desc: '정거장 설립 금지 · 강한 순찰 · 높은 세금 · 고급품 수요' },
  industrial: { name: '산업 지대', found: .25, patrol: 2, risk: 0, desc: '설립 허가료 25% · 원자재·중간재 수요' },
  resource: { name: '자원 지대', found: .1, patrol: 1, risk: 5, desc: '설립 허가료 10% · 기계·소모품 수요 · 광구 집중' },
  border: { name: '국경', found: .1, patrol: 1, risk: 15, desc: '분쟁 시 관문 봉쇄 위험 · 수송 위험 증가' },
  neutral: { name: '중립 시장', found: 0, patrol: 1, risk: 5, desc: '허가료 없음 · 여러 세력의 수요가 모이는 경쟁 시장' },
  uncharted: { name: '미개척', found: 0, patrol: 0, risk: 20, desc: '공개 성도 없음 · 탐사 정보는 회사별 · 신규 거점 기회' },
  lawless: { name: '무법 지대', found: 0, patrol: 0, risk: 30, desc: '풍부한 광구 · 해적 위협 · 높은 수송 위험' },
};

export interface FactionState {
  id: string;
  /** abstract fleet strength (ship-equivalents) built from consumed goods; lost in conflicts */
  strength: number;
  /** infrastructure level built from consumed construction goods */
  infra: number;
  /** goods drawn from markets but not yet turned into strength/infra (persisted, never discarded) */
  stock: Cargo;
  /** program progress counters (units converted) for observation */
  made: { ships: number; infra: number; upkeep: number };
  /** relations with other factions −100..100 */
  rel: Record<string, number>;
  /** systems claimed through limited expansion (ids) */
  claimed?: string[];
}

export interface Conflict {
  id: string;
  a: string; b: string;
  /** gate ids (both directions) closed while the conflict runs */
  gates: string[];
  since: number;
  /** strength each side has lost so far */
  lost: Record<string, number>;
  ended?: number;
}

export const factionsOn = (w: Pick<WorldState, 'factions'>) => !!w.factions;
export const factionOf = (w: WorldState, sys: StarSystem | undefined) => sys?.faction && w.factions?.[sys.faction] ? sys.faction : undefined;
export const regionOf = (sys: StarSystem | undefined): RegionKind | undefined => sys?.region;

/** Expanded (multi-region) layouts share routing rules: origins are storage, not distance. */
export const expandedLayout = (w: Pick<WorldState, 'worldLayout'>) => w.worldLayout === 'p9' || w.worldLayout === 'p10';

/** A gate is open unless an active conflict closes it. Legacy/p9 worlds: always open. */
export function gateOpen(w: Pick<WorldState, 'conflicts'>, gate: Pick<Gate, 'id'>): boolean {
  if (!w.conflicts) return true;
  for (const c of Object.values(w.conflicts)) if (!c.ended && c.gates.includes(gate.id)) return false;
  return true;
}

export const standingOf = (w: WorldState, company: string, faction: string) => w.companies[company]?.standing?.[faction] ?? 0;
export function bumpStanding(w: WorldState, company: string, faction: string, d: number) {
  const c = w.companies[company]; if (!c || c.kind !== 'player' || !w.factions?.[faction]) return;
  const s = (c.standing ??= {});
  s[faction] = Math.max(-100, Math.min(100, (s[faction] ?? 0) + d));
}

/** Docking at a faction market: hostile standing refuses service. */
export const DOCK_REFUSE = -25;
export function dockRefused(w: WorldState, st: Station, company: string): boolean {
  if (!st.faction || !w.factions || w.companies[company]?.kind !== 'player') return false;
  return standingOf(w, company, st.faction) < DOCK_REFUSE;
}

/** Founding in faction territory: forbidden in capitals, a licence fee elsewhere (credits leave the economy, logged). */
export function foundingRule(w: WorldState, sys: StarSystem | undefined, company: string): { ok: false; why: string } | { ok: true; feeShare: number; faction?: string } {
  if (!w.factions || !sys?.region) return { ok: true, feeShare: 0 };
  const rule = REGION_RULES[sys.region];
  const f = factionOf(w, sys);
  if (rule.found === 'forbidden') return { ok: false, why: `${FACTIONS[f ?? '']?.name ?? '세력'} 수도에는 정거장을 설립할 수 없습니다` };
  if (f && FACTIONS[f]?.hostile) return { ok: true, feeShare: 0 };
  if (f && standingOf(w, company, f) < DOCK_REFUSE) return { ok: false, why: `${FACTIONS[f].name}과의 관계가 나빠 설립 허가가 거부되었습니다` };
  return { ok: true, feeShare: f ? rule.found : 0, faction: f };
}

/** Extra route risk from territory (added to the security-based risk). */
export function territoryRisk(w: WorldState, sys: StarSystem | undefined): number {
  if (!w.factions || !sys?.region) return 0;
  let r = REGION_RULES[sys.region].risk;
  if (w.conflicts) for (const c of Object.values(w.conflicts)) if (!c.ended && (sys.faction === c.a || sys.faction === c.b) && sys.region === 'border') r += 20;
  return r;
}

/** Faction-controlled stations in the territory (their markets carry the faction's demand). */
export function factionStations(w: WorldState, faction: string): Station[] {
  return Object.values(w.stations).filter(s => s.public && s.market && s.faction === faction);
}

/** Systems held by a faction. */
export const territory = (w: WorldState, faction: string) => Object.values(w.systems).filter(s => s.faction === faction);
