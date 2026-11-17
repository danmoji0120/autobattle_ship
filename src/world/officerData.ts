// B-1 officer development — static data shared by the server and the client.
//
// Thirteen specialist trees, effect keys with their caps and the domain where each one is applied,
// birth traits, named officers, and the growth curves. Nothing here touches world state: officers.ts
// owns the rules (experience, learning, posting, pay) and the game systems read the resolved effects.
//
// Every node's numeric description is generated from its effects (`fxText`), so the text the player
// reads and the value the simulation applies come from the same numbers.

export type Tree = 'gunnery' | 'airdef' | 'intercept' | 'maneuver' | 'defense' | 'command' | 'ew'
  | 'mining' | 'salvage' | 'logistics' | 'industry' | 'explore' | 'support';

export const TREES: { id: Tree; name: string; kind: 'combat' | 'industry'; desc: string; icon: string }[] = [
  { id: 'gunnery', name: '포술', kind: 'combat', icon: '◎', desc: '명중, 사격 통제, 화력 집중, 교전 거리' },
  { id: 'airdef', name: '방공', kind: 'combat', icon: '✦', desc: '근접방어(PD), 방공망, 미사일·어뢰 방어' },
  { id: 'intercept', name: '요격', kind: 'combat', icon: '➶', desc: '위협 탐지, 적 함대 추적, 차단 기동' },
  { id: 'maneuver', name: '기동', kind: 'combat', icon: '➤', desc: '함대 기동, 가속, 선회, 회피, 진형 유지' },
  { id: 'defense', name: '방어', kind: 'combat', icon: '⛨', desc: '피해 통제, 장갑 운용, 방어 진형, 생존' },
  { id: 'command', name: '작전', kind: 'combat', icon: '♜', desc: '전술 판단, 지휘 효율, 협동 교전, 전장 통제' },
  { id: 'ew', name: '전자전', kind: 'combat', icon: '≋', desc: '센서, 전자 교란, 표적 정보, 적 탐지 대응' },
  { id: 'mining', name: '채광', kind: 'industry', icon: '⛏', desc: '채광 효율, 광맥 분석, 채굴 함대 최적화' },
  { id: 'salvage', name: '인양', kind: 'industry', icon: '⚓', desc: '회수 효율, 잔해 분석, 가치 판별, 회수 운용' },
  { id: 'logistics', name: '물류', kind: 'industry', icon: '⇄', desc: '운송 효율, 경로 판단, 물류 함대 운영' },
  { id: 'industry', name: '산업', kind: 'industry', icon: '⚙', desc: '생산 관리, 자원 가공, 시설 운영(정거장 책임자)' },
  { id: 'explore', name: '탐사', kind: 'industry', icon: '✧', desc: '미탐사 지역 조사, 정보 수집, 탐사 효율' },
  { id: 'support', name: '군수·정비', kind: 'industry', icon: '✚', desc: '보급, 정비, 수리, 함대 가동률' },
];
export const TREE_IDS = TREES.map(t => t.id);
export const TREE_NAME = Object.fromEntries(TREES.map(t => [t.id, t.name])) as Record<Tree, string>;

/** where an effect is applied — and so the only work that makes it count */
export type Domain = 'battle' | 'fleet' | 'mine' | 'salvage' | 'logistics' | 'station' | 'construct' | 'explore' | 'support';
export const DOMAIN_NAME: Record<Domain, string> = {
  battle: '전투(지휘 편대 함선)', fleet: '함대 운용(지휘 편대)', mine: '채굴(지휘 편대)', salvage: '인양(지휘 편대)', logistics: '수송(지휘 편대의 화물선)',
  station: '정거장 책임자(배치 정거장)', construct: '건설(지휘 편대의 건설선)', explore: '탐사(지휘 편대)', support: '정비·보급(지휘 편대 함선)',
};

type Fx = { label: string; cap: number; unit: '%' | 'pt' | 'flag' | '%/s'; domain: Domain; bad?: boolean };
export const FX = {
  // ── tactical battle (resolved into the commander of the battle setup; replays carry it)
  acc: { label: '명중률(사격 분산 감소)', cap: 0.35, unit: '%', domain: 'battle' },
  longAcc: { label: '원거리 명중(사거리 55% 밖 표적)', cap: 0.3, unit: '%', domain: 'battle' },
  rof: { label: '주무장 재장전 시간 단축', cap: 0.25, unit: '%', domain: 'battle' },
  gunRange: { label: '포 사거리', cap: 0.15, unit: '%', domain: 'battle' },
  focus: { label: '화력 집중 — 모든 포탑이 지휘관 지정 표적 우선(우선도 ×2.5, 적합도 기준 완화)', cap: 1, unit: 'flag', domain: 'battle' },
  dmgCap: { label: '전열함(대형) 상대 피해', cap: 0.3, unit: '%', domain: 'battle' },
  dmgSmall: { label: '소형·호위함 상대 피해', cap: 0.3, unit: '%', domain: 'battle' },
  pen: { label: '관통력', cap: 0.2, unit: '%', domain: 'battle' },
  crit: { label: '치명타 확률', cap: 0.8, unit: '%', domain: 'battle' },
  agile: { label: '고속 소형 표적 추적 보정(민첩성 분산 감소)', cap: 0.4, unit: '%', domain: 'battle' },
  pd: { label: '근접방어(PD) 요격 확률', cap: 0.4, unit: '%', domain: 'battle' },
  pdRange: { label: 'PD 사거리', cap: 0.3, unit: '%', domain: 'battle' },
  torpPd: { label: '어뢰 요격 보정', cap: 0.35, unit: '%', domain: 'battle' },
  pdNet: { label: '방공망 — 600m 안 아군을 노리는 유도탄을 우선 요격, 그 탄에 PD 사거리 +15%', cap: 1, unit: 'flag', domain: 'battle' },
  decoy: { label: '기만체 — 편대 함선을 노린 유도탄이 250m 안에서 유도를 잃을 확률', cap: 0.3, unit: '%', domain: 'battle' },
  antiRaider: { label: 'PD의 소형함 사격 명중', cap: 0.6, unit: '%', domain: 'battle' },
  mJam: { label: '편대 함선을 노린 적 유도탄의 선회력 감소', cap: 0.35, unit: '%', domain: 'battle' },
  mGuide: { label: '아군 유도탄 선회력', cap: 0.4, unit: '%', domain: 'battle' },
  jam: { label: '전자 교란 — 편대 함선을 노린 적 포격 분산', cap: 0.3, unit: '%', domain: 'battle' },
  eccm: { label: '표적의 회피·교란 효과 무력화', cap: 0.6, unit: '%', domain: 'battle' },
  pursuit: { label: '추격 속도(퇴각 중이거나 선체 40% 이하 표적을 쫓을 때)', cap: 0.3, unit: '%', domain: 'battle' },
  rearDmg: { label: '후방 명중 피해', cap: 0.4, unit: '%', domain: 'battle' },
  speed: { label: '전투 최고 속도', cap: 0.2, unit: '%', domain: 'battle' },
  turn: { label: '선회율', cap: 0.3, unit: '%', domain: 'battle' },
  accel: { label: '가속', cap: 0.3, unit: '%', domain: 'battle' },
  evade: { label: '회피 — 편대 함선을 노린 적 포격 분산', cap: 0.15, unit: '%', domain: 'battle' },
  lastDitch: { label: '위기 회피(선체 35% 이하일 때 추가 회피)', cap: 0.12, unit: '%', domain: 'battle' },
  armor: { label: '장갑', cap: 0.2, unit: '%', domain: 'battle' },
  formArmor: { label: '방어 진형 — 350m 안 편대 함선이 2척 이상이면 장갑', cap: 0.15, unit: '%', domain: 'battle' },
  dc: { label: '손상(기관·화재·함교·무장) 지속 시간 단축', cap: 0.5, unit: '%', domain: 'battle' },
  fire: { label: '화재 피해 감소', cap: 0.6, unit: '%', domain: 'battle' },
  critRes: { label: '피격 시 치명 손상 확률 감소', cap: 0.4, unit: '%', domain: 'battle' },
  brace: { label: '선체 30% 이하일 때 받는 피해 감소', cap: 0.3, unit: '%', domain: 'battle' },
  hp: { label: '선체 내구', cap: 0.1, unit: '%', domain: 'battle' },
  regen: { label: '전투 중 응급 수리(4초간 피격 없을 때, 초당 최대 내구 대비)', cap: 0.004, unit: '%/s', domain: 'battle' },
  regenCap: { label: '응급 수리 총량 한도 추가(기본 10%)', cap: 0.15, unit: '%', domain: 'battle' },
  retreatSpd: { label: '퇴각 속도', cap: 0.3, unit: '%', domain: 'battle' },
  think: { label: '판단 주기 단축(전술 판단이 더 자주 갱신)', cap: 0.35, unit: '%', domain: 'battle' },
  skill: { label: '판단력(전술·전략 AI 판단)', cap: 0.12, unit: 'pt', domain: 'battle' },
  coord: { label: '협동 교전 판단(망치·모루 협공 조건 완화)', cap: 0.25, unit: 'pt', domain: 'battle' },
  aura: { label: '지휘 전파 — 하위 편대 함선이 이 장교 전투 효과의 일부를 받음(자기 값이 더 크면 자기 값)', cap: 0.6, unit: '%', domain: 'battle' },
  auraAir: { label: '방공 전파 — 하위 편대가 이 장교 방공 효과(PD·PD 사거리·어뢰 요격)의 50%를 받음', cap: 1, unit: 'flag', domain: 'battle' },
  mineGuard: { label: '채굴 작전 중 교전하면 편대 장갑', cap: 0.1, unit: '%', domain: 'battle' },
  // ── strategic fleet behaviour (world AI of the commanded group)
  detect: { label: '위협 탐지 거리(민간 작업 철수·호위 감지·작전 감지)', cap: 1.0, unit: '%', domain: 'fleet' },
  warnNet: { label: '조기 경보 공유 — 3,000m 안 자사 민간 편대가 이 장교의 탐지 거리를 사용', cap: 1, unit: 'flag', domain: 'fleet' },
  readThreat: { label: '위협 판독 — 호위 전력이 적의 90% 이상이면 철수하지 않고 작업 유지', cap: 1, unit: 'flag', domain: 'fleet' },
  chase: { label: '작전 추격 시간·추격 한계 거리', cap: 0.8, unit: '%', domain: 'fleet' },
  march: { label: '함대 행군 속도(이동·공격 행군)와 낙오 대기 단축', cap: 0.15, unit: '%', domain: 'fleet' },
  flee: { label: '위협 대피 속도', cap: 0.35, unit: '%', domain: 'fleet' },
  align: { label: '워프 정렬 시간 단축', cap: 0.45, unit: '%', domain: 'fleet' },
  stealth: { label: '저피탐 운항 — 해적 무리가 이 편대를 표적으로 고를 매력도 감소', cap: 0.6, unit: '%', domain: 'fleet' },
  // ── mining
  mine: { label: '채굴 속도', cap: 0.45, unit: '%', domain: 'mine' },
  mineWear: { label: '채굴 중 마모 증가', cap: 0.5, unit: '%', domain: 'mine', bad: true },
  assay: { label: '시험 채굴 성분 파악 속도(미확인 광구)', cap: 1.5, unit: '%', domain: 'mine' },
  transfer: { label: '수송선 화물 이적 속도', cap: 0.6, unit: '%', domain: 'mine' },
  smallField: { label: '소형 광구 숙련 — 대형 채굴선의 소형 광구 50% 감산 없음', cap: 1, unit: 'flag', domain: 'mine' },
  select: { label: '선택 채굴 — 혼합 광구에서 가장 비싼 성분 비중(총 채굴량 동일)', cap: 0.35, unit: '%', domain: 'mine' },
  mineAura: { label: '하위 채굴 편대에 이 장교 채굴 속도 보너스의 일부 전파', cap: 0.5, unit: '%', domain: 'mine' },
  // ── salvage
  salv: { label: '인양 속도', cap: 0.5, unit: '%', domain: 'salvage' },
  salvRange: { label: '현장 자동 인양 탐색 범위·작업 시간', cap: 0.5, unit: '%', domain: 'salvage' },
  salvValue: { label: '가치 판별 — 단위 가치가 높은 화물부터 회수', cap: 1, unit: 'flag', domain: 'salvage' },
  salvEquip: { label: '장비 회수 속도', cap: 1.0, unit: '%', domain: 'salvage' },
  salvHull: { label: '선체 해체 확장 — 수송선(초당 1.5)·전투함(초당 0.8)도 선체 해체', cap: 1, unit: 'flag', domain: 'salvage' },
  salvFrag: { label: '설계 조각 회수 속도', cap: 1.5, unit: '%', domain: 'salvage' },
  salvRisk: { label: '인양 중 적대 접근 감지 반경', cap: 0.5, unit: '%', domain: 'salvage' },
  salvHold: { label: '인양 적재 한도', cap: 0.3, unit: '%', domain: 'salvage' },
  // ── logistics
  haulSpd: { label: '수송 순항 속도(물류 작업·노선·판매 왕복 중인 화물선)', cap: 0.25, unit: '%', domain: 'logistics' },
  cargoRate: { label: '정거장 적재·하역 속도', cap: 0.6, unit: '%', domain: 'logistics' },
  safeRoute: { label: '경로 판단 — 목적지 성계에 진행 중인 교전이 있으면 출항 보류', cap: 1, unit: 'flag', domain: 'logistics' },
  // ── station director
  prod: { label: '생산 속도', cap: 0.35, unit: '%', domain: 'station' },
  saveIn: { label: '원료 절감(투입 원료 일부 환급, 누적 정수 단위)', cap: 0.15, unit: '%', domain: 'station' },
  research: { label: '연구 속도', cap: 0.3, unit: '%', domain: 'station' },
  build: { label: '함선 건조 속도', cap: 0.3, unit: '%', domain: 'station' },
  // ── construction / exploration / support
  construct: { label: '건설 속도', cap: 0.35, unit: '%', domain: 'construct' },
  survey: { label: '탐사력(숨은 지점 탐색)', cap: 0.7, unit: '%', domain: 'explore' },
  intel: { label: '정밀 탐사(광구 정보 조사) 속도', cap: 1.0, unit: '%', domain: 'explore' },
  deepScan: { label: '저치안(25 미만) 성계 탐사력 추가', cap: 0.4, unit: '%', domain: 'explore' },
  siteWork: { label: '유적 인양 작업 속도', cap: 0.9, unit: '%', domain: 'explore' },
  maint: { label: '정박 정비비 감소', cap: 0.3, unit: '%', domain: 'support' },
  supply: { label: '보급품 소모 감소', cap: 0.25, unit: '%', domain: 'support' },
  wear: { label: '마모 누적 감소', cap: 0.35, unit: '%', domain: 'support' },
  repair: { label: '선체 수리비 감소', cap: 0.25, unit: '%', domain: 'support' },
  readiness: { label: '예비역 재취역 시간 단축', cap: 0.5, unit: '%', domain: 'support' },
} satisfies Record<string, Fx>;
export type FxKey = keyof typeof FX;
export type FxMap = Partial<Record<FxKey, number>>;
export const FX_KEYS = Object.keys(FX) as FxKey[];

export function fxText(k: FxKey, v: number): string {
  const d = FX[k] as Fx;
  if (d.unit === 'flag') return d.label;
  if (d.unit === 'pt') return `${d.label} +${Math.round(v * 100)}`;
  if (d.unit === '%/s') return `${d.label} ${(v * 100).toFixed(2)}%`;
  return `${d.label} ${v >= 0 && !d.bad ? '+' : d.bad ? '+' : ''}${Math.round(v * 100)}%`;
}

// ------------------------------------------------------------------------------------- skill nodes

export interface SkillNode {
  id: string; tree: Tree; name: string;
  /** row: 1 basic · 2 intermediate · 3 advanced branch · 4 cross-field link · 5 final specialisation */
  tier: 1 | 2 | 3 | 4 | 5;
  col: number;
  max: number; cost: number;
  /** every listed node must be learned */
  req?: string[];
  /** at least one of these must be learned */
  reqAny?: string[];
  /** a node from another tree that must be learned (cross-field link) */
  cross?: string;
  /** mutually exclusive group: only one node of the group can be learned */
  ex?: string;
  /** named officer only (signature ability) */
  sig?: string;
  fx: FxMap;
  /** behaviour note shown above the generated effect lines */
  note?: string;
}

/** gates by tier: mastery level of the tree, officer level */
export const TIER_GATE: Record<number, { mastery: number; level: number; name: string }> = {
  1: { mastery: 0, level: 1, name: '기초' }, 2: { mastery: 1, level: 3, name: '중급 전문' }, 3: { mastery: 2, level: 8, name: '고급 분기' },
  4: { mastery: 3, level: 15, name: '분야 연계' }, 5: { mastery: 4, level: 25, name: '최종 전문화' },
};
/** an officer may hold this many final specialisations (tier 5) across all trees */
export const MAX_CAPSTONES = 2;

type N = Omit<SkillNode, 'tree'>;
const T = (tree: Tree, nodes: N[]): SkillNode[] => nodes.map(n => ({ ...n, tree }));

export const SKILLS: SkillNode[] = [
  ...T('gunnery', [
    { id: 'gn_aim', name: '조준 훈련', tier: 1, col: 1, max: 3, cost: 1, fx: { acc: 0.04 } },
    { id: 'gn_reload', name: '장전 훈련', tier: 1, col: 3, max: 2, cost: 1, fx: { rof: 0.04 } },
    { id: 'gn_range', name: '원거리 사격 통제', tier: 2, col: 0, max: 2, cost: 1, req: ['gn_aim'], fx: { gunRange: 0.04, longAcc: 0.05 } },
    { id: 'gn_focus', name: '화력 집중', tier: 2, col: 3, max: 1, cost: 1, req: ['gn_reload'], fx: { focus: 1 }, note: '편대가 표적을 하나씩 무너뜨립니다. 분산 사격보다 격침 속도가 빠르지만 다수 소형함 상대에는 불리할 수 있습니다.' },
    { id: 'gn_heavy', name: '중포 지휘', tier: 3, col: 1, max: 1, cost: 2, ex: 'gn3', reqAny: ['gn_range', 'gn_focus'], fx: { dmgCap: 0.15, pen: 0.1 }, note: '대형함을 상대하는 전열 포격 전문. "속사 지휘"와 함께 배울 수 없습니다.' },
    { id: 'gn_rapid', name: '속사 지휘', tier: 3, col: 3, max: 1, cost: 2, ex: 'gn3', reqAny: ['gn_range', 'gn_focus'], fx: { rof: 0.08, dmgSmall: 0.15 }, note: '소형·호위함을 쓸어내는 속사 전문. "중포 지휘"와 함께 배울 수 없습니다.' },
    { id: 'gn_link', name: '전자 사격 연동', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['gn_heavy', 'gn_rapid'], cross: 'ew_lock', fx: { crit: 0.4, longAcc: 0.08 }, note: '전자전 "표적 정보"와 연계한 급소 사격.' },
    { id: 'gn_cap1', name: '결전 포격', tier: 5, col: 1, max: 1, cost: 3, ex: 'gn5', reqAny: ['gn_heavy', 'gn_rapid'], fx: { acc: 0.08, dmgCap: 0.1, crit: 0.2 }, note: '최종 전문화. "탄막 지휘"와 함께 배울 수 없습니다.' },
    { id: 'gn_cap2', name: '탄막 지휘', tier: 5, col: 3, max: 1, cost: 3, ex: 'gn5', reqAny: ['gn_heavy', 'gn_rapid'], fx: { rof: 0.1, agile: 0.35, dmgSmall: 0.08 }, note: '최종 전문화. 고속 소형함을 탄막으로 붙잡습니다. "결전 포격"과 함께 배울 수 없습니다.' },
  ]),
  ...T('airdef', [
    { id: 'ad_pd', name: '근접방어 훈련', tier: 1, col: 1, max: 3, cost: 1, fx: { pd: 0.06 } },
    { id: 'ad_range', name: '방공 경계', tier: 1, col: 3, max: 2, cost: 1, fx: { pdRange: 0.06 } },
    { id: 'ad_torp', name: '대어뢰 요격', tier: 2, col: 0, max: 2, cost: 1, req: ['ad_pd'], fx: { torpPd: 0.1 } },
    { id: 'ad_net', name: '방공망 구성', tier: 2, col: 3, max: 1, cost: 1, req: ['ad_range'], fx: { pdNet: 1 }, note: '자기 함선보다 곁의 아군을 먼저 지킵니다.' },
    { id: 'ad_decoy', name: '기만체 운용', tier: 3, col: 1, max: 1, cost: 2, ex: 'ad3', reqAny: ['ad_torp', 'ad_net'], fx: { decoy: 0.15 }, note: '"요격 집중"과 함께 배울 수 없습니다.' },
    { id: 'ad_wall', name: '요격 집중', tier: 3, col: 3, max: 1, cost: 2, ex: 'ad3', reqAny: ['ad_torp', 'ad_net'], fx: { pd: 0.1, torpPd: 0.1 }, note: '"기만체 운용"과 함께 배울 수 없습니다.' },
    { id: 'ad_link', name: '함대 방공 지휘', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['ad_decoy', 'ad_wall'], cross: 'op_chain', fx: { auraAir: 1 }, note: '작전 "지휘 체계"와 연계해 하위 편대 전체를 방공망에 묶습니다.' },
    { id: 'ad_cap1', name: '철벽 방공', tier: 5, col: 1, max: 1, cost: 3, ex: 'ad5', reqAny: ['ad_decoy', 'ad_wall'], fx: { pd: 0.12, pdRange: 0.1, antiRaider: 0.5 }, note: '최종 전문화. "전자 기만망"과 함께 배울 수 없습니다.' },
    { id: 'ad_cap2', name: '전자 기만망', tier: 5, col: 3, max: 1, cost: 3, ex: 'ad5', reqAny: ['ad_decoy', 'ad_wall'], fx: { decoy: 0.12, mJam: 0.15 }, note: '최종 전문화. "철벽 방공"과 함께 배울 수 없습니다.' },
  ]),
  ...T('intercept', [
    { id: 'ic_watch', name: '위협 탐지', tier: 1, col: 1, max: 3, cost: 1, fx: { detect: 0.15 } },
    { id: 'ic_track', name: '적 함대 추적', tier: 1, col: 3, max: 2, cost: 1, fx: { chase: 0.25 } },
    { id: 'ic_alert', name: '조기 경보 공유', tier: 2, col: 0, max: 1, cost: 1, req: ['ic_watch'], fx: { warnNet: 1 }, note: '근처에서 일하는 자사 채굴·수송 편대가 함께 경보를 받습니다.' },
    { id: 'ic_cut', name: '차단 기동', tier: 2, col: 3, max: 2, cost: 1, req: ['ic_track'], fx: { pursuit: 0.08 } },
    { id: 'ic_hunt', name: '추격전', tier: 3, col: 1, max: 1, cost: 2, ex: 'ic3', reqAny: ['ic_alert', 'ic_cut'], fx: { pursuit: 0.12, rearDmg: 0.15, chase: 0.25 }, note: '달아나는 적을 끝까지 쫓아 뒤를 칩니다. "차단선"과 함께 배울 수 없습니다.' },
    { id: 'ic_screen', name: '차단선', tier: 3, col: 3, max: 1, cost: 2, ex: 'ic3', reqAny: ['ic_alert', 'ic_cut'], fx: { dmgSmall: 0.12, speed: 0.05, detect: 0.15 }, note: '경량함의 접근을 끊는 방어적 요격. "추격전"과 함께 배울 수 없습니다.' },
    { id: 'ic_link', name: '위협 판독', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['ic_hunt', 'ic_screen'], cross: 'ew_scan', fx: { readThreat: 1, detect: 0.2 }, note: '전자전 "센서 운용"과 연계해 적 규모를 정확히 읽습니다.' },
    { id: 'ic_cap1', name: '사냥꾼', tier: 5, col: 1, max: 1, cost: 3, ex: 'ic5', reqAny: ['ic_hunt', 'ic_screen'], fx: { pursuit: 0.1, march: 0.08, chase: 0.3 }, note: '최종 전문화. "경계 사령"과 함께 배울 수 없습니다.' },
    { id: 'ic_cap2', name: '경계 사령', tier: 5, col: 3, max: 1, cost: 3, ex: 'ic5', reqAny: ['ic_hunt', 'ic_screen'], fx: { detect: 0.4, warnNet: 1, flee: 0.1 }, note: '최종 전문화. "사냥꾼"과 함께 배울 수 없습니다.' },
  ]),
  ...T('maneuver', [
    { id: 'mv_speed', name: '추진 운용', tier: 1, col: 1, max: 3, cost: 1, fx: { speed: 0.03 } },
    { id: 'mv_turn', name: '선회 훈련', tier: 1, col: 3, max: 2, cost: 1, fx: { turn: 0.08, accel: 0.06 } },
    { id: 'mv_evade', name: '회피 기동', tier: 2, col: 0, max: 2, cost: 1, req: ['mv_turn'], fx: { evade: 0.04 } },
    { id: 'mv_form', name: '진형 유지', tier: 2, col: 3, max: 1, cost: 1, req: ['mv_speed'], fx: { march: 0.06 }, note: '행군 중 낙오 함선을 기다리는 시간도 줄어듭니다.' },
    { id: 'mv_flank', name: '측후방 강습', tier: 3, col: 1, max: 1, cost: 2, ex: 'mv3', reqAny: ['mv_evade', 'mv_form'], fx: { rearDmg: 0.25, speed: 0.04 }, note: '"회피 전문"과 함께 배울 수 없습니다.' },
    { id: 'mv_dodge', name: '회피 전문', tier: 3, col: 3, max: 1, cost: 2, ex: 'mv3', reqAny: ['mv_evade', 'mv_form'], fx: { evade: 0.05, flee: 0.15 }, note: '"측후방 강습"과 함께 배울 수 없습니다.' },
    { id: 'mv_warp', name: '긴급 워프', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['mv_flank', 'mv_dodge'], cross: 'lg_align', fx: { align: 0.3 }, note: '물류 "출항 준비"와 연계한 신속 정렬.' },
    { id: 'mv_cap1', name: '번개 기동', tier: 5, col: 1, max: 1, cost: 3, ex: 'mv5', reqAny: ['mv_flank', 'mv_dodge'], fx: { speed: 0.08, turn: 0.15, rearDmg: 0.1 }, note: '최종 전문화. "불굴의 회피"와 함께 배울 수 없습니다.' },
    { id: 'mv_cap2', name: '불굴의 회피', tier: 5, col: 3, max: 1, cost: 3, ex: 'mv5', reqAny: ['mv_flank', 'mv_dodge'], fx: { evade: 0.04, lastDitch: 0.1, retreatSpd: 0.15 }, note: '최종 전문화. "번개 기동"과 함께 배울 수 없습니다.' },
  ]),
  ...T('defense', [
    { id: 'df_armor', name: '장갑 운용', tier: 1, col: 1, max: 3, cost: 1, fx: { armor: 0.04 } },
    { id: 'df_dc', name: '피해 통제', tier: 1, col: 3, max: 2, cost: 1, fx: { dc: 0.15 } },
    { id: 'df_fire', name: '화재 진압', tier: 2, col: 3, max: 2, cost: 1, req: ['df_dc'], fx: { fire: 0.25 } },
    { id: 'df_bulk', name: '격벽 강화', tier: 2, col: 0, max: 2, cost: 1, req: ['df_armor'], fx: { critRes: 0.15 } },
    { id: 'df_line', name: '방어 진형', tier: 3, col: 1, max: 1, cost: 2, ex: 'df3', reqAny: ['df_fire', 'df_bulk'], fx: { formArmor: 0.1 }, note: '뭉쳐 싸울수록 단단해집니다. "최후 저항"과 함께 배울 수 없습니다.' },
    { id: 'df_brace', name: '최후 저항', tier: 3, col: 3, max: 1, cost: 2, ex: 'df3', reqAny: ['df_fire', 'df_bulk'], fx: { brace: 0.2 }, note: '"방어 진형"과 함께 배울 수 없습니다.' },
    { id: 'df_link', name: '응급 수리반', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['df_line', 'df_brace'], cross: 'sp_field', fx: { regen: 0.002 }, note: '군수·정비 "현장 정비"와 연계한 전투 중 수리.' },
    { id: 'df_cap1', name: '불침함', tier: 5, col: 1, max: 1, cost: 3, ex: 'df5', reqAny: ['df_line', 'df_brace'], fx: { armor: 0.08, critRes: 0.2, hp: 0.08 }, note: '최종 전문화. "생존 지휘"와 함께 배울 수 없습니다.' },
    { id: 'df_cap2', name: '생존 지휘', tier: 5, col: 3, max: 1, cost: 3, ex: 'df5', reqAny: ['df_line', 'df_brace'], fx: { brace: 0.1, retreatSpd: 0.2, dc: 0.3 }, note: '최종 전문화. "불침함"과 함께 배울 수 없습니다.' },
  ]),
  ...T('command', [
    { id: 'op_judge', name: '전술 판단', tier: 1, col: 1, max: 3, cost: 1, fx: { skill: 0.03 } },
    { id: 'op_tempo', name: '지휘 템포', tier: 1, col: 3, max: 2, cost: 1, fx: { think: 0.1 } },
    { id: 'op_chain', name: '지휘 체계', tier: 2, col: 0, max: 1, cost: 1, req: ['op_judge'], fx: { aura: 0.25 }, note: '하위 편대가 이 장교의 전투 효과를 나눠 받습니다(같은 효과는 큰 쪽만 적용, 중첩 없음).' },
    { id: 'op_coord', name: '협동 교전', tier: 2, col: 3, max: 2, cost: 1, req: ['op_tempo'], fx: { coord: 0.1 } },
    { id: 'op_aggr', name: '공세 교리', tier: 3, col: 1, max: 1, cost: 2, ex: 'op3', reqAny: ['op_chain', 'op_coord'], fx: { dmgCap: 0.06, dmgSmall: 0.06, think: 0.05 }, note: '"지구전 교리"와 함께 배울 수 없습니다.' },
    { id: 'op_hold', name: '지구전 교리', tier: 3, col: 3, max: 1, cost: 2, ex: 'op3', reqAny: ['op_chain', 'op_coord'], fx: { armor: 0.05, retreatSpd: 0.15, brace: 0.05 }, note: '"공세 교리"와 함께 배울 수 없습니다.' },
    { id: 'op_link', name: '전장 정보 통합', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['op_aggr', 'op_hold'], cross: 'ew_scan', fx: { aura: 0.15, think: 0.1 }, note: '전자전 "센서 운용"과 연계.' },
    { id: 'op_cap1', name: '전장 지배', tier: 5, col: 1, max: 1, cost: 3, ex: 'op5', reqAny: ['op_aggr', 'op_hold'], fx: { aura: 0.2, skill: 0.04 }, note: '최종 전문화. 대함대 총지휘관. "독자 전술가"와 함께 배울 수 없습니다.' },
    { id: 'op_cap2', name: '독자 전술가', tier: 5, col: 3, max: 1, cost: 3, ex: 'op5', reqAny: ['op_aggr', 'op_hold'], fx: { skill: 0.05, think: 0.15, acc: 0.05 }, note: '최종 전문화. 자기 편대를 가장 잘 싸우게 합니다. "전장 지배"와 함께 배울 수 없습니다.' },
  ]),
  ...T('ew', [
    { id: 'ew_scan', name: '센서 운용', tier: 1, col: 1, max: 3, cost: 1, fx: { detect: 0.08, longAcc: 0.03 } },
    { id: 'ew_lock', name: '표적 정보', tier: 1, col: 3, max: 2, cost: 1, fx: { eccm: 0.15 } },
    { id: 'ew_jam', name: '전자 교란', tier: 2, col: 0, max: 2, cost: 1, req: ['ew_scan'], fx: { jam: 0.08 } },
    { id: 'ew_guide', name: '유도 보정', tier: 2, col: 3, max: 2, cost: 1, req: ['ew_lock'], fx: { mGuide: 0.12 } },
    { id: 'ew_ghost', name: '저피탐 운항', tier: 3, col: 1, max: 1, cost: 2, ex: 'ew3', reqAny: ['ew_jam', 'ew_guide'], fx: { stealth: 0.3 }, note: '"미사일 교란"과 함께 배울 수 없습니다.' },
    { id: 'ew_spoof', name: '미사일 교란', tier: 3, col: 3, max: 1, cost: 2, ex: 'ew3', reqAny: ['ew_jam', 'ew_guide'], fx: { mJam: 0.15 }, note: '"저피탐 운항"과 함께 배울 수 없습니다.' },
    { id: 'ew_link', name: '통합 사격 정보', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['ew_ghost', 'ew_spoof'], cross: 'gn_aim', fx: { acc: 0.04, eccm: 0.2 }, note: '포술 "조준 훈련"과 연계.' },
    { id: 'ew_cap1', name: '전자전 지배', tier: 5, col: 1, max: 1, cost: 3, ex: 'ew5', reqAny: ['ew_ghost', 'ew_spoof'], fx: { jam: 0.12, mJam: 0.1 }, note: '최종 전문화. "유령 함대"와 함께 배울 수 없습니다.' },
    { id: 'ew_cap2', name: '유령 함대', tier: 5, col: 3, max: 1, cost: 3, ex: 'ew5', reqAny: ['ew_ghost', 'ew_spoof'], fx: { stealth: 0.3, evade: 0.04, flee: 0.1 }, note: '최종 전문화. "전자전 지배"와 함께 배울 수 없습니다.' },
  ]),
  ...T('mining', [
    { id: 'mn_rate', name: '채굴 숙련', tier: 1, col: 1, max: 3, cost: 1, fx: { mine: 0.06 } },
    { id: 'mn_assay', name: '광맥 분석', tier: 1, col: 3, max: 2, cost: 1, fx: { assay: 0.5 } },
    { id: 'mn_relay', name: '채굴 편대 운용', tier: 2, col: 0, max: 2, cost: 1, req: ['mn_rate'], fx: { transfer: 0.25 } },
    { id: 'mn_small', name: '소형 광구 숙련', tier: 2, col: 3, max: 1, cost: 1, req: ['mn_assay'], fx: { smallField: 1 } },
    { id: 'mn_select', name: '선택 채굴', tier: 3, col: 1, max: 1, cost: 2, ex: 'mn3', reqAny: ['mn_relay', 'mn_small'], fx: { select: 0.25 }, note: '같은 양을 캐면서 값진 성분을 더 많이 얻습니다. "대량 채굴"과 함께 배울 수 없습니다.' },
    { id: 'mn_bulk', name: '대량 채굴', tier: 3, col: 3, max: 1, cost: 2, ex: 'mn3', reqAny: ['mn_relay', 'mn_small'], fx: { mine: 0.15, mineWear: 0.25 }, note: '빠르지만 장비가 더 빨리 닳습니다. "선택 채굴"과 함께 배울 수 없습니다.' },
    { id: 'mn_link', name: '채굴 호위 연계', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['mn_select', 'mn_bulk'], cross: 'df_armor', fx: { mineGuard: 0.1, detect: 0.2 }, note: '방어 "장갑 운용"과 연계.' },
    { id: 'mn_cap1', name: '광맥 장인', tier: 5, col: 1, max: 1, cost: 3, ex: 'mn5', reqAny: ['mn_select', 'mn_bulk'], fx: { mine: 0.15, select: 0.1 }, note: '최종 전문화. "채굴 함대 사령"과 함께 배울 수 없습니다.' },
    { id: 'mn_cap2', name: '채굴 함대 사령', tier: 5, col: 3, max: 1, cost: 3, ex: 'mn5', reqAny: ['mn_select', 'mn_bulk'], fx: { mineAura: 0.5, mine: 0.06 }, note: '최종 전문화. 여러 채굴반을 거느린 총괄. "광맥 장인"과 함께 배울 수 없습니다.' },
  ]),
  ...T('salvage', [
    { id: 'sv_rate', name: '회수 숙련', tier: 1, col: 1, max: 3, cost: 1, fx: { salv: 0.08 } },
    { id: 'sv_scan', name: '잔해 분석', tier: 1, col: 3, max: 2, cost: 1, fx: { salvRange: 0.2 } },
    { id: 'sv_value', name: '가치 판별', tier: 2, col: 3, max: 1, cost: 1, req: ['sv_scan'], fx: { salvValue: 1 } },
    { id: 'sv_equip', name: '장비 회수', tier: 2, col: 0, max: 2, cost: 1, req: ['sv_rate'], fx: { salvEquip: 0.5 } },
    { id: 'sv_cut', name: '선체 해체 확장', tier: 3, col: 1, max: 1, cost: 2, ex: 'sv3', reqAny: ['sv_value', 'sv_equip'], fx: { salvHull: 1 }, note: '채굴선 없이도 선체 고철을 회수합니다. "설계 조각 수색"과 함께 배울 수 없습니다.' },
    { id: 'sv_frag', name: '설계 조각 수색', tier: 3, col: 3, max: 1, cost: 2, ex: 'sv3', reqAny: ['sv_value', 'sv_equip'], fx: { salvFrag: 1.0 }, note: '"선체 해체 확장"과 함께 배울 수 없습니다.' },
    { id: 'sv_link', name: '위험 현장 판단', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['sv_cut', 'sv_frag'], cross: 'ic_watch', fx: { salvRisk: 0.4, detect: 0.2 }, note: '요격 "위협 탐지"와 연계.' },
    { id: 'sv_cap1', name: '인양 장인', tier: 5, col: 1, max: 1, cost: 3, ex: 'sv5', reqAny: ['sv_cut', 'sv_frag'], fx: { salv: 0.2, salvEquip: 0.5 }, note: '최종 전문화. "고철왕"과 함께 배울 수 없습니다.' },
    { id: 'sv_cap2', name: '고철왕', tier: 5, col: 3, max: 1, cost: 3, ex: 'sv5', reqAny: ['sv_cut', 'sv_frag'], fx: { salvHold: 0.25, salv: 0.1, salvRange: 0.2 }, note: '최종 전문화. "인양 장인"과 함께 배울 수 없습니다.' },
  ]),
  ...T('logistics', [
    { id: 'lg_speed', name: '운송 효율', tier: 1, col: 1, max: 3, cost: 1, fx: { haulSpd: 0.04 } },
    { id: 'lg_cargo', name: '화물 취급', tier: 1, col: 3, max: 2, cost: 1, fx: { cargoRate: 0.2 } },
    { id: 'lg_route', name: '경로 판단', tier: 2, col: 0, max: 1, cost: 1, req: ['lg_speed'], fx: { safeRoute: 1 }, note: '전투가 끝날 때까지 기다렸다가 출항합니다.' },
    { id: 'lg_align', name: '출항 준비', tier: 2, col: 3, max: 2, cost: 1, req: ['lg_cargo'], fx: { align: 0.15 } },
    { id: 'lg_convoy', name: '호송 운용', tier: 3, col: 1, max: 1, cost: 2, ex: 'lg3', reqAny: ['lg_route', 'lg_align'], fx: { flee: 0.15, stealth: 0.15 }, note: '빠르기보다 무사히. "특송"과 함께 배울 수 없습니다.' },
    { id: 'lg_express', name: '특송', tier: 3, col: 3, max: 1, cost: 2, ex: 'lg3', reqAny: ['lg_route', 'lg_align'], fx: { haulSpd: 0.08, cargoRate: 0.2 }, note: '"호송 운용"과 함께 배울 수 없습니다.' },
    { id: 'lg_link', name: '물류 정비 연계', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['lg_convoy', 'lg_express'], cross: 'sp_maint', fx: { wear: 0.2 }, note: '군수·정비 "정비 관리"와 연계.' },
    { id: 'lg_cap1', name: '물류 사령', tier: 5, col: 1, max: 1, cost: 3, ex: 'lg5', reqAny: ['lg_convoy', 'lg_express'], fx: { haulSpd: 0.08, align: 0.2, cargoRate: 0.2 }, note: '최종 전문화. "무손실 수송"과 함께 배울 수 없습니다.' },
    { id: 'lg_cap2', name: '무손실 수송', tier: 5, col: 3, max: 1, cost: 3, ex: 'lg5', reqAny: ['lg_convoy', 'lg_express'], fx: { flee: 0.15, stealth: 0.25, detect: 0.3 }, note: '최종 전문화. "물류 사령"과 함께 배울 수 없습니다.' },
  ]),
  ...T('industry', [
    { id: 'in_prod', name: '생산 관리', tier: 1, col: 1, max: 3, cost: 1, fx: { prod: 0.05 } },
    { id: 'in_save', name: '원료 절감', tier: 1, col: 3, max: 2, cost: 1, fx: { saveIn: 0.03 } },
    { id: 'in_lab', name: '연구 지원', tier: 2, col: 0, max: 2, cost: 1, req: ['in_prod'], fx: { research: 0.08 } },
    { id: 'in_yard', name: '조선 감독', tier: 2, col: 3, max: 2, cost: 1, req: ['in_save'], fx: { build: 0.08 } },
    { id: 'in_mass', name: '대량 생산', tier: 3, col: 1, max: 1, cost: 2, ex: 'in3', reqAny: ['in_lab', 'in_yard'], fx: { prod: 0.12 }, note: '"정밀 가공"과 함께 배울 수 없습니다.' },
    { id: 'in_lean', name: '정밀 가공', tier: 3, col: 3, max: 1, cost: 2, ex: 'in3', reqAny: ['in_lab', 'in_yard'], fx: { saveIn: 0.05, prod: 0.03 }, note: '"대량 생산"과 함께 배울 수 없습니다.' },
    { id: 'in_link', name: '건설 지휘', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['in_mass', 'in_lean'], cross: 'lg_cargo', fx: { construct: 0.2 }, note: '물류 "화물 취급"과 연계. 건설선 편대를 지휘할 때 적용됩니다.' },
    { id: 'in_cap1', name: '공업 총감', tier: 5, col: 1, max: 1, cost: 3, ex: 'in5', reqAny: ['in_mass', 'in_lean'], fx: { prod: 0.08, build: 0.1, research: 0.1 }, note: '최종 전문화. "효율 장인"과 함께 배울 수 없습니다.' },
    { id: 'in_cap2', name: '효율 장인', tier: 5, col: 3, max: 1, cost: 3, ex: 'in5', reqAny: ['in_mass', 'in_lean'], fx: { saveIn: 0.05, prod: 0.05 }, note: '최종 전문화. "공업 총감"과 함께 배울 수 없습니다.' },
  ]),
  ...T('explore', [
    { id: 'ex_scan', name: '탐사 효율', tier: 1, col: 1, max: 3, cost: 1, fx: { survey: 0.12 } },
    { id: 'ex_intel', name: '정보 수집', tier: 1, col: 3, max: 2, cost: 1, fx: { intel: 0.3 } },
    { id: 'ex_site', name: '유적 조사', tier: 2, col: 0, max: 2, cost: 1, req: ['ex_scan'], fx: { siteWork: 0.2 } },
    { id: 'ex_deep', name: '심층 탐사', tier: 2, col: 3, max: 1, cost: 1, req: ['ex_intel'], fx: { deepScan: 0.25 } },
    { id: 'ex_range', name: '장거리 정찰', tier: 3, col: 1, max: 1, cost: 2, ex: 'ex3', reqAny: ['ex_site', 'ex_deep'], fx: { detect: 0.25, survey: 0.1 }, note: '"고고학자"와 함께 배울 수 없습니다.' },
    { id: 'ex_arch', name: '고고학자', tier: 3, col: 3, max: 1, cost: 2, ex: 'ex3', reqAny: ['ex_site', 'ex_deep'], fx: { siteWork: 0.25 }, note: '"장거리 정찰"과 함께 배울 수 없습니다.' },
    { id: 'ex_link', name: '탐사 인양 연계', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['ex_range', 'ex_arch'], cross: 'sv_rate', fx: { siteWork: 0.15, salv: 0.05 }, note: '인양 "회수 숙련"과 연계.' },
    { id: 'ex_cap1', name: '개척자', tier: 5, col: 1, max: 1, cost: 3, ex: 'ex5', reqAny: ['ex_range', 'ex_arch'], fx: { survey: 0.25, intel: 0.3, detect: 0.15 }, note: '최종 전문화. "유적 사냥꾼"과 함께 배울 수 없습니다.' },
    { id: 'ex_cap2', name: '유적 사냥꾼', tier: 5, col: 3, max: 1, cost: 3, ex: 'ex5', reqAny: ['ex_range', 'ex_arch'], fx: { siteWork: 0.3, deepScan: 0.15 }, note: '최종 전문화. "개척자"와 함께 배울 수 없습니다.' },
  ]),
  ...T('support', [
    { id: 'sp_maint', name: '정비 관리', tier: 1, col: 1, max: 3, cost: 1, fx: { maint: 0.06 } },
    { id: 'sp_supply', name: '보급 관리', tier: 1, col: 3, max: 2, cost: 1, fx: { supply: 0.08 } },
    { id: 'sp_wear', name: '예방 정비', tier: 2, col: 0, max: 2, cost: 1, req: ['sp_maint'], fx: { wear: 0.12 } },
    { id: 'sp_field', name: '현장 정비', tier: 2, col: 3, max: 1, cost: 1, req: ['sp_supply'], fx: { regen: 0.0015 } },
    { id: 'sp_repair', name: '수리 감독', tier: 3, col: 1, max: 1, cost: 2, ex: 'sp3', reqAny: ['sp_wear', 'sp_field'], fx: { repair: 0.12 }, note: '"가동률 관리"와 함께 배울 수 없습니다.' },
    { id: 'sp_ready', name: '가동률 관리', tier: 3, col: 3, max: 1, cost: 2, ex: 'sp3', reqAny: ['sp_wear', 'sp_field'], fx: { readiness: 0.4, maint: 0.04 }, note: '"수리 감독"과 함께 배울 수 없습니다.' },
    { id: 'sp_link', name: '전투 피해 통제', tier: 4, col: 2, max: 1, cost: 2, reqAny: ['sp_repair', 'sp_ready'], cross: 'df_dc', fx: { dc: 0.15, regenCap: 0.05 }, note: '방어 "피해 통제"와 연계.' },
    { id: 'sp_cap1', name: '정비창장', tier: 5, col: 1, max: 1, cost: 3, ex: 'sp5', reqAny: ['sp_repair', 'sp_ready'], fx: { maint: 0.12, wear: 0.15, repair: 0.08 }, note: '최종 전문화. "전장 정비"와 함께 배울 수 없습니다.' },
    { id: 'sp_cap2', name: '전장 정비', tier: 5, col: 3, max: 1, cost: 3, ex: 'sp5', reqAny: ['sp_repair', 'sp_ready'], fx: { regen: 0.002, regenCap: 0.1 }, note: '최종 전문화. "정비창장"과 함께 배울 수 없습니다.' },
  ]),
  // ── signature abilities of named officers (tier 3, one per officer, never shared)
  ...T('command', [{ id: 'sig_barros', name: '망치와 모루', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_barros', fx: { aura: 0.12, coord: 0.15 }, note: '고유 능력 — 엘레나 바로스.' }]),
  ...T('gunnery', [{ id: 'sig_wolf', name: '정밀 일제 사격', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_wolf', fx: { longAcc: 0.12, focus: 1 }, note: '고유 능력 — 하인츠 볼프.' }]),
  ...T('maneuver', [{ id: 'sig_kairen', name: '에이스의 직감', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_kairen', fx: { evade: 0.05, rearDmg: 0.15 }, note: '고유 능력 — 카이 렌.' }]),
  ...T('airdef', [{ id: 'sig_song', name: '호위 방벽', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_song', fx: { pdNet: 1, torpPd: 0.15 }, note: '고유 능력 — 미라 송.' }]),
  ...T('intercept', [{ id: 'sig_kostov', name: '돌격 본능', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_kostov', fx: { pursuit: 0.15, dmgSmall: 0.1 }, note: '고유 능력 — 이반 코스토프.' }]),
  ...T('ew', [{ id: 'sig_mizuki', name: '화력 통제 분배', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_mizuki', fx: { mGuide: 0.2, eccm: 0.15 }, note: '고유 능력 — 아야 미즈키.' }]),
  ...T('mining', [{ id: 'sig_haas', name: '광맥 감각', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_haas', fx: { mine: 0.08, assay: 0.6 }, note: '고유 능력 — 오렌 하스.' }]),
  ...T('logistics', [{ id: 'sig_lind', name: '항로 지도', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_lind', fx: { haulSpd: 0.06, align: 0.15 }, note: '고유 능력 — 세라 린드.' }]),
  ...T('support', [{ id: 'sig_dou', name: '정비창의 손', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_dou', fx: { maint: 0.1, wear: 0.1 }, note: '고유 능력 — 에밀 도우.' }]),
  ...T('industry', [{ id: 'sig_moro', name: '공정 설계자', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_moro', fx: { prod: 0.06, saveIn: 0.03 }, note: '고유 능력 — 베라 모로.' }]),
  ...T('explore', [{ id: 'sig_endo', name: '유적 직감', tier: 3, col: 4, max: 1, cost: 2, sig: 'n_endo', fx: { siteWork: 0.25, survey: 0.12 }, note: '고유 능력 — 하나 엔도.' }]),
];
export const SKILL: Record<string, SkillNode> = Object.fromEntries(SKILLS.map(s => [s.id, s]));

/** every effect line of a node at a rank, generated from its numbers */
export function nodeLines(n: SkillNode, rank = 1): string[] {
  return (Object.entries(n.fx) as [FxKey, number][]).map(([k, v]) => fxText(k, v * (FX[k].unit === 'flag' ? 1 : rank)));
}

// ------------------------------------------------------------------------------- traits & officers

/** birth traits: which fields grow faster (mastery gain multipliers) and one small passive */
export interface Trait { id: string; name: string; desc: string; grow: Partial<Record<Tree, number>>; fx: FxMap; named?: boolean }
export const TRAITS: Trait[] = [
  { id: 't_gunner', name: '포병 출신', desc: '전함 포술장 경력.', grow: { gunnery: 0.35, defense: 0.15 }, fx: { acc: 0.02 } },
  { id: 't_air', name: '방공 장교 출신', desc: '호위함 방공 지휘 경력.', grow: { airdef: 0.35, ew: 0.15 }, fx: { pd: 0.03 } },
  { id: 't_patrol', name: '변경 순찰대', desc: '해적의 수법을 잘 압니다.', grow: { intercept: 0.35, ew: 0.15 }, fx: { detect: 0.1 } },
  { id: 't_ace', name: '초계함 조종사', desc: '빠른 함선을 몸처럼 다룹니다.', grow: { maneuver: 0.35, intercept: 0.15 }, fx: { turn: 0.04 } },
  { id: 't_bulwark', name: '전열함 함장', desc: '포화 속에서도 함선을 지킵니다.', grow: { defense: 0.35, gunnery: 0.15 }, fx: { dc: 0.06 } },
  { id: 't_staff', name: '참모 장교', desc: '사령부 작전 참모 경력.', grow: { command: 0.35, airdef: 0.15 }, fx: { think: 0.04 } },
  { id: 't_signal', name: '통신·전자 장교', desc: '센서와 교란 장비 전문가.', grow: { ew: 0.35, intercept: 0.15 }, fx: { eccm: 0.06 } },
  { id: 't_miner', name: '광산 조합 출신', desc: '소행성 지대를 손바닥처럼 압니다.', grow: { mining: 0.35, salvage: 0.15 }, fx: { mine: 0.03 } },
  { id: 't_scrap', name: '고철 수집가', desc: '잔해에서 값진 것을 귀신같이 찾습니다.', grow: { salvage: 0.35, support: 0.15 }, fx: { salv: 0.04 } },
  { id: 't_freight', name: '화물선 선장', desc: '위험을 피하는 감각이 탁월합니다.', grow: { logistics: 0.35, maneuver: 0.15 }, fx: { haulSpd: 0.02 } },
  { id: 't_foreman', name: '공장 감독관', desc: '생산 라인을 쉬게 두지 않습니다.', grow: { industry: 0.35, logistics: 0.15 }, fx: { prod: 0.02 } },
  { id: 't_explorer', name: '탐험가', desc: '지도에 없는 곳을 찾아다녔습니다.', grow: { explore: 0.35, salvage: 0.15 }, fx: { survey: 0.06 } },
  { id: 't_mech', name: '정비창 출신', desc: '함선을 오래 쓰게 만듭니다.', grow: { support: 0.35, industry: 0.15 }, fx: { wear: 0.04 } },
  { id: 't_cadet', name: '사관학교 수석', desc: '무엇이든 고르게 빨리 배웁니다.', grow: Object.fromEntries(TREE_IDS.map(t => [t, 0.12])), fx: {} },
  // named officers: strong signature growth, one field they struggle with
  { id: 'n_barros', name: '망치와 모루의 대가', desc: '함대 사령관 출신. 산업 실무에는 서툽니다.', named: true, grow: { command: 0.45, gunnery: 0.15, industry: -0.25 }, fx: { think: 0.05 } },
  { id: 'n_wolf', name: '전함 포술장', desc: '적정 교전 거리를 지키는 노장. 빠른 기동에는 약합니다.', named: true, grow: { gunnery: 0.45, defense: 0.15, maneuver: -0.25 }, fx: { acc: 0.03 } },
  { id: 'n_kairen', name: '초계함대 에이스', desc: '빈틈을 귀신같이 찾지만 정비에는 관심이 없습니다.', named: true, grow: { maneuver: 0.45, intercept: 0.15, support: -0.25 }, fx: { speed: 0.03 } },
  { id: 'n_song', name: '방공 전문가', desc: '호위 대상과 위협 사이에 정확히 함선을 둡니다. 포격전은 약합니다.', named: true, grow: { airdef: 0.45, defense: 0.15, gunnery: -0.25 }, fx: { pd: 0.04 } },
  { id: 'n_kostov', name: '돌격광', desc: '후퇴를 싫어합니다. 전자전에는 무관심합니다.', named: true, grow: { intercept: 0.45, maneuver: 0.15, ew: -0.25 }, fx: { pursuit: 0.05 } },
  { id: 'n_mizuki', name: '화력 통제 장교', desc: '표적 분배가 정확합니다. 채굴 현장과는 인연이 없습니다.', named: true, grow: { ew: 0.45, gunnery: 0.15, mining: -0.25 }, fx: { mGuide: 0.05 } },
  { id: 'n_haas', name: '심부 광산 감독', desc: '광맥을 읽는 사람. 함대 지휘는 서툽니다.', named: true, grow: { mining: 0.45, salvage: 0.15, command: -0.25 }, fx: { mine: 0.04 } },
  { id: 'n_lind', name: '변경 항로 개척자', desc: '항로를 외우는 수송선장. 포격전은 싫어합니다.', named: true, grow: { logistics: 0.45, explore: 0.15, gunnery: -0.25 }, fx: { haulSpd: 0.03 } },
  { id: 'n_dou', name: '정비창 반장', desc: '함선을 살려내는 손. 추격전에는 관심이 없습니다.', named: true, grow: { support: 0.45, industry: 0.15, intercept: -0.25 }, fx: { maint: 0.04 } },
  { id: 'n_moro', name: '공정 설계자', desc: '공장 효율의 대가. 기동전 경험은 없습니다.', named: true, grow: { industry: 0.45, logistics: 0.15, maneuver: -0.25 }, fx: { prod: 0.03 } },
  { id: 'n_endo', name: '유적 탐사가', desc: '봉인된 기록고를 찾아다닌 학자. 정면 방어에는 약합니다.', named: true, grow: { explore: 0.45, salvage: 0.15, defense: -0.25 }, fx: { siteWork: 0.06 } },
  { id: 'n_bb', name: '인과율 간섭', desc: '계정 전용 지휘관. 인과율 간섭 능력은 BB-EX 전용 체계로 그대로 작동합니다.', named: true, grow: { command: 0.1, gunnery: 0.1, defense: 0.1 }, fx: {} },
];
export const TRAIT: Record<string, Trait> = Object.fromEntries(TRAITS.map(t => [t.id, t]));
export const GENERIC_TRAITS = TRAITS.filter(t => !t.named).map(t => t.id);
/** legacy combat specialty → the trait that matches it (migration of existing commanders) */
export const SPECIALTY_TRAIT: Record<string, string> = { gunnery: 't_gunner', maneuver: 't_ace', defense: 't_air', tactics: 't_staff' };

export interface NamedOfficer {
  id: string; trait: string; sig: string; name: string; rank: string; skill: number; aggression: number; discipline: number;
  specialty: 'tactics' | 'gunnery' | 'maneuver' | 'defense' | 'none'; voice: 'calm' | 'bold' | 'formal' | 'nervous' | 'cold' | 'savage';
  color: string; bio: string; level: number; mastery: Partial<Record<Tree, number>>; hire: number;
}
/** world named officers: one of each per world, they appear in recruitment pools now and then */
export const NAMED: NamedOfficer[] = [
  { id: 'n_barros', trait: 'n_barros', sig: 'sig_barros', name: '엘레나 바로스', rank: '제독', skill: 0.82, aggression: 0.5, discipline: 0.8, specialty: 'tactics', voice: 'calm', color: '#5fd4ff', level: 12, mastery: { command: 7000, gunnery: 2500 }, hire: 52000,
    bio: '냉정한 계산으로 이름난 함대 사령관. 망치와 모루 전술의 대가로, 하위 부대의 타이밍을 맞추는 데 능하다.' },
  { id: 'n_wolf', trait: 'n_wolf', sig: 'sig_wolf', name: '하인츠 볼프', rank: '대령', skill: 0.74, aggression: 0.35, discipline: 0.9, specialty: 'gunnery', voice: 'formal', color: '#9fb8ff', level: 10, mastery: { gunnery: 6500, defense: 2000 }, hire: 40000,
    bio: '전함 함장 출신의 노장. 적정 교전 거리를 지키며 집중 포격으로 하나씩 무너뜨린다.' },
  { id: 'n_kairen', trait: 'n_kairen', sig: 'sig_kairen', name: '카이 렌', rank: '중령', skill: 0.76, aggression: 0.9, discipline: 0.4, specialty: 'maneuver', voice: 'bold', color: '#ffb35f', level: 9, mastery: { maneuver: 6200, intercept: 2000 }, hire: 36000,
    bio: '초계함대의 에이스. 적의 빈틈을 귀신같이 찾아내지만, 명령보다 자신의 감을 믿는다.' },
  { id: 'n_song', trait: 'n_song', sig: 'sig_song', name: '미라 송', rank: '소령', skill: 0.7, aggression: 0.2, discipline: 0.88, specialty: 'defense', voice: 'calm', color: '#7dffb0', level: 8, mastery: { airdef: 6000, defense: 1500 }, hire: 30000,
    bio: '방공 전문가. 호위 대상과 위협 사이에 정확히 함선을 배치한다.' },
  { id: 'n_kostov', trait: 'n_kostov', sig: 'sig_kostov', name: '이반 코스토프', rank: '중령', skill: 0.55, aggression: 1.0, discipline: 0.25, specialty: 'maneuver', voice: 'savage', color: '#ff6f6f', level: 7, mastery: { intercept: 5000, maneuver: 1500 }, hire: 24000,
    bio: '무모하지만 결정적인 순간 무언가를 해내는 돌격광. 후퇴라는 단어를 싫어한다.' },
  { id: 'n_mizuki', trait: 'n_mizuki', sig: 'sig_mizuki', name: '아야 미즈키', rank: '소령', skill: 0.64, aggression: 0.5, discipline: 0.7, specialty: 'gunnery', voice: 'formal', color: '#d79fff', level: 8, mastery: { ew: 5500, gunnery: 1500 }, hire: 28000,
    bio: '미사일 화력 통제 장교 출신. 표적 분배가 정확하다.' },
  { id: 'n_haas', trait: 'n_haas', sig: 'sig_haas', name: '오렌 하스', rank: '소령', skill: 0.6, aggression: 0.3, discipline: 0.85, specialty: 'none', voice: 'calm', color: '#e0c27a', level: 10, mastery: { mining: 7000, salvage: 2000 }, hire: 30000,
    bio: '심부 광산 감독 출신. 광석 냄새만으로 광맥의 품위를 맞힌다는 소문이 있다.' },
  { id: 'n_lind', trait: 'n_lind', sig: 'sig_lind', name: '세라 린드', rank: '소령', skill: 0.62, aggression: 0.2, discipline: 0.8, specialty: 'none', voice: 'calm', color: '#8ff0e0', level: 9, mastery: { logistics: 6500, explore: 1500 }, hire: 28000,
    bio: '변경 항로를 개척한 수송선장. 성계 사이의 지름길을 머릿속에 지도로 그린다.' },
  { id: 'n_dou', trait: 'n_dou', sig: 'sig_dou', name: '에밀 도우', rank: '대위', skill: 0.55, aggression: 0.3, discipline: 0.9, specialty: 'none', voice: 'formal', color: '#b0d0ff', level: 8, mastery: { support: 6000, industry: 1500 }, hire: 24000,
    bio: '연합 정비창 반장 출신. 그가 손본 함선은 잘 고장나지 않는다.' },
  { id: 'n_moro', trait: 'n_moro', sig: 'sig_moro', name: '베라 모로', rank: '중령', skill: 0.6, aggression: 0.25, discipline: 0.85, specialty: 'none', voice: 'formal', color: '#ffc27f', level: 10, mastery: { industry: 7000, logistics: 1800 }, hire: 32000,
    bio: '대형 조선소의 공정 설계자. 같은 원료로 더 많이, 더 빨리 만든다.' },
  { id: 'n_endo', trait: 'n_endo', sig: 'sig_endo', name: '하나 엔도', rank: '대위', skill: 0.58, aggression: 0.35, discipline: 0.75, specialty: 'none', voice: 'nervous', color: '#c8b0ff', level: 8, mastery: { explore: 6000, salvage: 1500 }, hire: 24000,
    bio: '봉인된 연구 기록고를 찾아 변경을 떠돈 학자 출신 탐사가.' },
];
export const NAMED_BY_ID: Record<string, NamedOfficer> = Object.fromEntries(NAMED.map(n => [n.id, n]));

// --------------------------------------------------------------------------------- growth curves

export const MAX_LEVEL = 40;
/** experience to go from level L to L+1 (rises steeply: early levels in minutes, the top in hundreds of hours of work) */
export const xpToNext = (L: number) => L >= MAX_LEVEL ? Infinity : Math.round(60 * Math.pow(L, 1.7));
/** total experience to reach level L from level 1 */
export function xpForLevel(L: number): number { let n = 0; for (let k = 1; k < Math.min(L, MAX_LEVEL); k++) n += xpToNext(k); return n; }
/** skill points an officer of level L has been given in total: 1 at hire, +1 per level, +1 more at every tenth level */
export const spForLevel = (L: number) => 1 + (Math.min(L, MAX_LEVEL) - 1) + Math.floor(Math.min(L, MAX_LEVEL) / 10);
/** field mastery thresholds (mastery xp) for mastery levels 1..5 */
export const MASTERY = [0, 500, 2000, 6000, 15000, 35000];
export const MASTERY_NAME = ['미숙', '입문', '숙련', '전문', '대가', '전설'];
export const masteryLevel = (x: number) => { let m = 0; for (let k = 1; k < MASTERY.length; k++) if (x >= MASTERY[k]) m = k; return m; };
/** officer tiers by level for the roster */
export const RANK_BAND = (L: number) => L >= 30 ? '전설' : L >= 20 ? '베테랑' : L >= 10 ? '숙련' : '신입';

/** experience pace: per game hour an officer earns full experience up to SOFT, a quarter up to HARD, nothing beyond */
export const XP_SOFT_HOUR = 1500;
export const XP_HARD_HOUR = 4000;
/** focus (training direction) adds this to mastery gain in that field; changing it waits this long */
export const FOCUS_BONUS = 0.25;
export const FOCUS_COOLDOWN = 3600;

/** experience per credit of real output, by activity (research: per second of research time) */
export const XP_RATE = {
  mine: 0.012, salvage: 0.012, logistics: 0.004, industry: 0.02, research: 0.3, build: 0.004,
  /** construction: per ship-second of real building work on a module */
  construct: 0.2,
  /** survey: per ship-second of scanning in a system that still has something to find; per discovery; per credit from a site */
  survey: 0.12, discover: 60, site: 0.012,
  /** maintenance credits saved or spent under the officer, in-battle repair hp */
  support: 0.05,
} as const;

/** pay per game hour (credits): reserve, group command (+ per ship, capped), station director (+ by station size) */
export const PAY = { reserve: 30, command: 80, perShip: 15, shipCap: 300, perSubgroup: 20, director: 150, size: { S: 0, M: 60, L: 150, XL: 300 } as Record<string, number>, perLevel: 2, named: 1.3 };
