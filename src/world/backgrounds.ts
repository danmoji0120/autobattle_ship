// A-3.1 — company founding backgrounds (창업 배경).
//
// A new PMC in the P10 standard world chooses one of six origins. The origin is a starting condition only: where the
// company is registered, which ships and commander it starts with, its starting funds and its first standing with the
// factions. Nothing is locked by it afterwards — every activity, market, hull and blueprint follows the normal rules
// (trust, credit, research, money), and the starting standing moves like any other.
//
// The server alone resolves a background (sim.createPlayer): the client sends an id, never ships, money or standing.
// Worlds without the P10 factions/stations keep the original start (astra, two miners, destroyer, two corvettes).
//
// Numbers (docs/A3_1_BACKGROUNDS.md): fleets are small hulls (S berth, buyable at public yards, standard fits), so the
// asset value of every start stays well below the original start's (≈150k, most of it the destroyer) and an emergency
// sale under arrears (A-2.1, 50 % of list) can never be worth more than the start of a working company. Funds cover
// about 5–40 hours of docked running cost depending on how much the fleet needs a trading capital.
import type { Company, Station, WorldState } from './types';
import { hullEcon, hullSale, hullUpkeep } from './hullops';
import { CONTENT } from '../content/registry';
import { EQUIPMENT, itemPrice } from './industry';
import { priceOf } from './market';
import { OVERHEAD } from './econConfig';
import { FACTIONS } from './territory';
import { bandOf } from './reputation';
import { sysAt } from './geom';
import { PAY } from './officerData';

export type BackgroundId = 'hauler' | 'miner' | 'salvager' | 'security' | 'veteran' | 'raider';
export interface BackgroundShip { hull: string; variant: string; preset?: string; group: number; n: number; role: string;
  /** industrial hardpoint worlds: gear fitted at founding (absent = the hull's standard gear) */
  gear?: string[] }
export interface BackgroundGroup { name: string; commander?: { tier: number; minSkill: number } }
export interface Background {
  id: BackgroundId;
  name: string;
  desc: string;
  faction: string;
  station: string;
  groups: BackgroundGroup[];
  ships: BackgroundShip[];
  credits: number;
  activities: string[];
  difficulty: '낮음' | '보통' | '높음' | '매우 높음';
  /** what the player should know before choosing (shown on the card) */
  notes: string[];
  /** first hint after founding */
  hint: string;
  /** industrial hardpoint worlds (indV): the fleet and the texts that differ, because work comes from fitted gear */
  ind?: { ships: BackgroundShip[]; desc?: string; notes?: string[] };
}

/** trust with the origin faction: the first friendly band (협력, P14) — below every faction blueprint that has no
 *  research requirement, far below the record-gated bands (40+) */
export const ORIGIN_TRUST = 10;
/** factions bitterly opposed to the origin (relation ≤ this) start slightly wary of the company */
export const RIVAL_REL = -50;
export const RIVAL_TRUST = -5;

const S = (hull: string, preset: string | undefined, group: number, n: number, role: string, variant = `${hull}_std`): BackgroundShip => ({ hull, variant, preset, group, n, role });
/** a ship with the given industrial gear (indV worlds) */
const SG = (hull: string, preset: string | undefined, group: number, n: number, role: string, gear: string[]): BackgroundShip => ({ ...S(hull, preset, group, n, role), gear });

export const BACKGROUNDS: Background[] = [
  {
    id: 'hauler', name: '독립 운송업자', faction: 'guild', station: 'astra',
    desc: '상인 길드의 자유항에 등록한 소규모 운송 회사. 전투함 없이 화물선 두 척과 넉넉한 거래 자금으로 시작한다.',
    groups: [{ name: '제1 수송반' }],
    ships: [S('hauler_mk1', 'hauler_std', 0, 2, '수송')],
    credits: 30000,
    activities: ['시장 간 교역(싸게 사서 비싸게 팔기)', '납품·운송 계약', '다른 회사·세력 물자 운송'],
    difficulty: '보통',
    notes: ['전투함이 없다 — 위험 항로는 피하거나 호위를 고용·구입해야 한다', '운영비가 낮아 오래 버틴다', '화물을 사려면 자금이 필요하다 — 자금을 모두 쓰면 수입원이 없다'],
    hint: '아스트라 자유항에 정박 중. 시장 가격을 비교해 첫 교역 화물을 정해 보자.',
  },
  {
    id: 'miner', name: '변경 채굴업자', faction: 'miners', station: 'p9_anvil_port',
    desc: '광업동맹 수도 앤빌의 광부조합 소속으로 시작하는 채굴 회사. 채굴선 세 척과 광석 운반선 한 척.',
    groups: [{ name: '제1 채굴반' }],
    ships: [S('miner_mk1', 'miner_std', 0, 3, '채굴'), S('hauler_mk1', 'hauler_std', 0, 1, '광석 운반')],
    credits: 12000,
    activities: ['앤빌 광구 채굴(광석·티타늄 광석)', '광부조합·세레스 제련단지에 광석 판매', '채굴 장비 확장'],
    difficulty: '낮음',
    notes: ['같은 성계에 광구 3곳과 광석을 사는 시장이 있다', '앤빌 광부조합은 거래 예산이 작다 — 많이 캐면 세레스 등 다른 시장으로 운반', '전투함이 없다'],
    hint: '앤빌 광부조합에 정박 중. 채굴반을 앤빌 광구로 보내 첫 수익을 올려 보자.',
    ind: { ships: [SG('miner_mk1', 'miner_std', 0, 3, '채굴 (소형 채굴 레이저)', ['ind_mine_s']), SG('hauler_mk1', 'hauler_std', 0, 1, '광석 운반', [])] },
  },
  {
    id: 'salvager', name: '우주 인양업자', faction: 'ceres', station: 'p9_ceres_works',
    desc: '세레스 공업연맹 제련단지에 둥지를 튼 인양 회사. 장비까지 뜯어낼 수 있는 공작선과 선체를 해체하는 채굴선, 화물을 싣는 수송선.',
    groups: [{ name: '인양반' }],
    ships: [S('constructor_s', 'constructor_s_std', 0, 1, '인양(장비·선체·설계 조각)'), S('miner_mk1', 'miner_std', 0, 1, '선체 해체·채굴'), S('hauler_mk1', 'hauler_std', 0, 1, '화물 회수')],
    credits: 12000,
    activities: ['유기선·전장 잔해 인양(화물·장비·선체 고철)', '정거장 인양 계약(대상에서 회수해 납품)', '고철을 세레스 제련단지 등에 판매', '대상이 없을 때는 채굴'],
    difficulty: '보통',
    notes: ['유기선은 지역마다 정해진 수만큼 불규칙하게 나타나고 모든 회사가 함께 쓴다 — 무료 자원은 지급되지 않는다', '전장 잔해는 실제 전투 뒤에 생긴다', '보호 화물(합법 회사 소유)을 가져가면 범죄가 된다', '전투함이 없다'],
    hint: '세레스 제련단지에 정박 중. 첫 사업 안내에서 가까운 유기선이나 인양 계약을 선택하세요. 회수한 고철·부품의 자동 판매는 첫 사업 안내에서 설정할 수 있습니다.',
    ind: {
      desc: '세레스 공업연맹 제련단지에 둥지를 튼 인양 회사. 소형 인양 장비를 단 갈고리급 인양선 두 척(인양 효율 ×1.3 — 화물·장비·선체·설계 조각 회수)과, 회수품을 다른 시장으로 나르고 투하 화물을 줍는 수송선 한 척.',
      ships: [SG('salvager_s', 'salvager_s_std', 0, 2, '잔해 인양 (소형 인양 장비 · 효율 ×1.3)', ['ind_salv_s']), SG('hauler_mk1', 'hauler_std', 0, 1, '회수품 운송 · 투하 화물 회수', [])],
    },
  },
  {
    id: 'security', name: '민간 경비업체', faction: 'union', station: 'helios',
    desc: '연합 관리청의 헬리오스 조선소에 등록한 경비 회사. 초계함 두 척과 호위함 한 척, 기본 지휘관.',
    groups: [{ name: '경비대', commander: { tier: 1, minSkill: 0.5 } }],
    ships: [S('frigate_mk1', 'frigate_patrol', 0, 1, '호위함'), S('corvette_mk1', 'corvette_gun', 0, 2, '초계')],
    credits: 15000,
    activities: ['해적 토벌·현상금', '호위·순찰 계약', '다른 회사 화물선 호위'],
    difficulty: '보통',
    notes: ['민간선이 없다 — 채굴·운송을 하려면 민간선을 사야 한다', '전투로 손상되면 수리비가 든다'],
    hint: '헬리오스 조선소에 정박 중. 계약 게시판에서 토벌·호위 계약을 찾아보자.',
  },
  {
    id: 'veteran', name: '퇴역 군사조직', faction: 'iron', station: 'p10_bulwark_yard',
    desc: '철갑 사령부 출신 퇴역 장병들이 불워크 군항에서 세운 회사. 호위함 두 척과 초계함 두 척, 경험 많은 지휘관.',
    groups: [{ name: '퇴역 전대', commander: { tier: 2, minSkill: 0.6 } }],
    ships: [S('frigate_mk1', 'frigate_patrol', 0, 2, '호위함'), S('corvette_mk1', 'corvette_torp', 0, 1, '어뢰 초계'), S('corvette_mk1', 'corvette_gun', 0, 1, '초계')],
    credits: 10000,
    activities: ['해적 소굴 토벌', '철갑 사령부 계약', '분쟁 지역 작전'],
    difficulty: '높음',
    notes: ['운영비가 가장 높다 — 자금은 정박만으로 약 5시간분', '민간선이 없다 — 수입은 전투 계약·현상금에서 나온다', '불워크 군항에는 조선소가 없다'],
    hint: '불워크 군항에 정박 중. 운영비가 높으니 서둘러 토벌·계약으로 수입을 만들자.',
  },
  {
    id: 'raider', name: '무법지 약탈자', faction: 'pirates', station: 'rustport',
    desc: '해적 연합 무법 공역의 녹슨 정박지에서 시작하는 독립 회사. 초계함 두 척과 전리품 수송선 한 척. 해적 연합에 소속되지는 않는다.',
    groups: [{ name: '습격대', commander: { tier: 1, minSkill: 0.5 } }, { name: '전리품 수송반' }],
    ships: [S('corvette_mk1', 'corvette_gun', 0, 2, '습격'), S('hauler_mk1', 'hauler_std', 1, 1, '전리품 운반')],
    credits: 6000,
    activities: ['약탈(화물 요구·강탈)', '잔해 인양', '암시장 거래'],
    difficulty: '매우 높음',
    notes: ['해적 NPC는 출신과 무관하게 이 회사도 공격한다', '연합·철갑·광업동맹의 신뢰가 조금 낮게 시작한다(정박은 가능)', '합법 회사 화물 약탈은 범죄 — 수배·단속 대상', '자금이 가장 적다'],
    hint: '녹슨 정박지에 정박 중. 무법 공역은 위험하다 — 습격대와 수송반을 함께 움직이자.',
    ind: { ships: [S('corvette_mk1', 'corvette_gun', 0, 2, '습격'), SG('hauler_mk1', 'hauler_std', 1, 1, '전리품 회수·운반 (소형 인양 장비)', ['ind_salv_s'])] },
  },
];
export const BACKGROUND: Record<string, Background> = Object.fromEntries(BACKGROUNDS.map(b => [b.id, b]));

/** the starting fleet of a background in this world (industrial hardpoint worlds may differ) */
export const backgroundShips = (w: Pick<WorldState, 'indV'>, b: Background): BackgroundShip[] => w.indV && b.ind ? b.ind.ships : b.ships;

/** the background system needs the six P10 factions and every start station */
export function backgroundsOn(w: Pick<WorldState, 'factions' | 'stations'>): boolean {
  if (!w.factions) return false;
  return BACKGROUNDS.every(b => w.factions![b.faction] && w.stations[b.station]?.public);
}
/** the background a client asked for, if this world offers it (anything else: undefined) */
export function backgroundOf(w: Pick<WorldState, 'factions' | 'stations'>, id: unknown): Background | undefined {
  if (typeof id !== 'string' || !Object.hasOwn(BACKGROUND, id) || !backgroundsOn(w)) return undefined;
  return BACKGROUND[id];
}

/** starting standing: origin faction at ORIGIN_TRUST, its bitter rivals at RIVAL_TRUST, everyone else neutral */
export function backgroundStanding(w: Pick<WorldState, 'factions'>, b: Background): Record<string, number> {
  const out: Record<string, number> = { [b.faction]: ORIGIN_TRUST };
  const rel = w.factions?.[b.faction]?.rel ?? {};
  for (const [f, r] of Object.entries(rel)) if (f !== b.faction && w.factions?.[f] && r <= RIVAL_REL) out[f] = RIVAL_TRUST;
  return out;
}

/** the market the company will buy its consumables at (upkeep.ts homeMarket for a company based at `st`) */
function supplyMarket(w: WorldState, st: Station): Station | undefined {
  if (st.public && st.market) return st;
  return Object.values(w.stations).filter(s => s.public && s.market).sort((a, b) => Math.hypot(a.pos.x - st.pos.x, a.pos.z - st.pos.z) - Math.hypot(b.pos.x - st.pos.x, b.pos.z - st.pos.z))[0];
}
/** running cost per hour of the starting fleet, docked at home (the same terms as upkeep.ts forecast) */
export function backgroundUpkeep(w: WorldState, b: Background): number {
  const st = w.stations[b.station];
  let credits = 0; const supplies: Record<string, number> = {};
  for (const s of backgroundShips(w, b)) {
    const u = hullUpkeep(s.hull, s.variant);
    credits += u.credits * s.n;
    for (const [k, q] of Object.entries(u.supplies ?? {})) supplies[k] = (supplies[k] ?? 0) + q * s.n;
    const weapons = s.preset ? CONTENT.presets[s.preset]?.weapons ?? {} : {};
    for (const id of Object.values(weapons)) for (const [k, q] of Object.entries(EQUIPMENT[id]?.supply ?? {})) supplies[k] = (supplies[k] ?? 0) + q * s.n;
  }
  const m = st && supplyMarket(w, st);
  let suppliesCr = 0;
  for (const [k, q] of Object.entries(supplies)) suppliesCr += q * (m?.market?.[k] ? priceOf(m.market[k], 'buy', true) : itemPrice(k) * 2);
  return credits * (1 + OVERHEAD) + suppliesCr + backgroundSalary(w, b);
}
/** B-1: salary of the starting commanders (a new commander is level 1; the same terms as officers.ts payroll) */
function backgroundSalary(w: WorldState, b: Background): number {
  if (w.officerV !== 1) return 0;
  let pay = 0;
  b.groups.forEach((g, i) => {
    if (!g.commander) return;
    const ships = backgroundShips(w, b).filter(s => s.group === i).reduce((n, s) => n + s.n, 0);
    pay += Math.round(PAY.command + Math.min(PAY.shipCap, ships * PAY.perShip));
  });
  return pay;
}

/** list value of the starting fleet (public-yard list price of each hull; fitted gear is equipment, not hull value) */
export const backgroundValue = (b: Background, w?: Pick<WorldState, 'indV'>) => (w ? backgroundShips(w, b) : b.ships).reduce((n, s) => n + (hullSale(s.hull)?.price ?? 0) * s.n, 0);

/** what the company-creation screen shows for one background (everything here is what the server grants) */
export interface BackgroundTerm {
  id: string; name: string; desc: string;
  faction: string; factionName: string; factionColor: string;
  system: string; station: string;
  ships: { name: string; role: string; n: number; military: boolean }[];
  commander?: string;
  credits: number;
  standing: { faction: string; name: string; value: number; band: string }[];
  upkeep: number; value: number; hours: number;
  activities: string[]; difficulty: string; notes: string[];
}
export function backgroundTerms(w: WorldState): BackgroundTerm[] {
  if (!backgroundsOn(w)) return [];
  return BACKGROUNDS.map(b => {
    const st = w.stations[b.station];
    const sys = sysAt(w.systems, st.pos);
    const upkeep = Math.round(backgroundUpkeep(w, b));
    const cm = b.groups.find(g => g.commander)?.commander;
    const standing = Object.entries(backgroundStanding(w, b)).map(([f, v]) => ({ faction: f, name: FACTIONS[f]?.name ?? f, value: v, band: bandOf(v).name }));
    return {
      id: b.id, name: b.name, desc: (w.indV && b.ind?.desc) || b.desc,
      faction: b.faction, factionName: FACTIONS[b.faction]?.name ?? b.faction, factionColor: FACTIONS[b.faction]?.color ?? '#888',
      system: sys?.name ?? '', station: st.name,
      ships: backgroundShips(w, b).map(s => ({ name: CONTENT.hulls[s.hull]?.name ?? s.hull, role: s.role, n: s.n, military: hullEcon(s.hull, s.variant).military })),
      ...(cm ? { commander: cm.tier >= 2 ? '숙련 지휘관 1명' : '기본 지휘관 1명' } : {}),
      credits: b.credits, standing, upkeep, value: backgroundValue(b, w), hours: upkeep > 0 ? Math.floor(b.credits / upkeep * 10) / 10 : 0,
      activities: b.activities, difficulty: b.difficulty, notes: (w.indV && b.ind?.notes) || b.notes,
    };
  });
}

/** stored on the company: the origin it was founded with (display / history only — grants nothing later) */
export const originOf = (co: Company | undefined) => co?.background ? BACKGROUND[co.background] : undefined;
