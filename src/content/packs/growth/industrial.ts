// Industrial hardpoint gear (growth worlds): mining lasers, construction rigs and salvage rigs in four
// sizes. A ship mines, builds or salvages only with this gear fitted in an `industrial` bay; the hull's
// design adds an efficiency bonus (HullOps.bonus) but no capability of its own (world/hullops.ts).
// Sizes trade capability for power, mass and price — an S rig fits every industrial hull, XL only the
// largest. Prices come from the recipes (industry.ts equipPrice), like every other module.
import type { ModuleContent, Size, IndWork } from '../../schema';

const NAME: Record<IndWork, string> = { mine: '채굴 레이저', build: '건설 장비', salvage: '인양 장비', repair: '현장 수리 장비' };
const SIZE_NAME: Record<Size, string> = { S: '소형', M: '중형', L: '대형', XL: '초대형' };
const KEY: Record<IndWork, string> = { mine: 'mine', build: 'build', salvage: 'salv', repair: 'rep' };

/** P17.1: salvage precision — a bigger rig is faster AND a little more careful, but precision rises far slower than speed */
const P = (m: ModuleContent, prec: number): ModuleContent => ({ ...m, ind: { ...m.ind!, prec } });
const G = (work: IndWork, size: Size, rate: number, power: number, mass: number, time: number, inp: Record<string, number>, desc: string, tech?: string): ModuleContent => ({
  id: `ind_${KEY[work]}_${size.toLowerCase()}`, name: `${SIZE_NAME[size]} ${NAME[work]}`, desc,
  slot: 'industrial', size, mass, power, fx: {}, ind: { work, rate }, ...(tech ? { tech } : {}),
  recipe: { fac: 'machine_shop', time, in: inp },
});

export const IND_MODULES: ModuleContent[] = [
  // mining lasers — rate in ore units / s before the hull bonus (the old 곡괭이급 = S laser × 1.28)
  G('mine', 'S', 2.5, 4, 4, 300, { machinery: 4, precision: 1, crystal: 2 }, '기본 채굴 레이저. 초당 2.5 단위 채굴. 산업 하드포인트(S 이상)에 장착.'),
  G('mine', 'M', 5, 7, 8, 600, { machinery: 8, precision: 3, crystal: 4, electronics: 1 }, '중형 채굴 레이저. 초당 5 단위 채굴. 산업 하드포인트(M 이상)에 장착.'),
  G('mine', 'L', 10, 12, 14, 1200, { machinery: 16, precision: 6, crystal: 8, electronics: 4 }, '대형 굴착 레이저. 초당 10 단위 채굴. 심부 채굴 연구로 생산.', 'deep_core'),
  G('mine', 'XL', 20, 18, 22, 2400, { machinery: 30, precision: 14, crystal: 16, electronics: 10 }, '초대형 분쇄 레이저. 초당 20 단위 채굴. 초대형 산업 하드포인트 전용.', 'deep_core'),
  // construction rigs — work rate (1 = the old standard 석공급 constructor) before the hull bonus
  G('build', 'S', 0.4, 3, 5, 300, { machinery: 5, precision: 1, electronics: 1 }, '용접 드론 한 조. 건설 속도 0.4. 산업 하드포인트(S 이상)에 장착.'),
  G('build', 'M', 0.8, 6, 9, 600, { machinery: 10, precision: 3, electronics: 2 }, '조립 크레인과 드론 격납고. 건설 속도 0.8.'),
  G('build', 'L', 1.6, 10, 15, 1200, { machinery: 20, precision: 6, electronics: 6 }, '갠트리 크레인 세트. 건설 속도 1.6. 정거장 공학 연구로 생산.', 'station_engineering'),
  G('build', 'XL', 3.2, 16, 24, 2400, { machinery: 40, precision: 14, electronics: 14, composite: 10 }, '건설 드론 편대 격납고. 건설 속도 3.2. 초대형 산업 하드포인트 전용.', 'station_engineering'),
  // salvage rigs — multiplier on the salvage base rates (1 = the old 석공급 constructor) before the hull bonus
  P(G('salvage', 'S', 1, 3, 4, 300, { machinery: 4, precision: 1, composite: 2 }, '견인 빔과 절단 토치. 잔해의 화물·장비·선체·설계도 조각을 회수한다 (인양 효율 1.0).'), 0.35),
  P(G('salvage', 'M', 1.6, 6, 8, 600, { machinery: 8, precision: 2, electronics: 1, composite: 4 }, '회수 크레인과 절단 드론. 인양 효율 1.6.'), 0.45),
  P(G('salvage', 'L', 2.6, 10, 13, 1200, { machinery: 16, precision: 5, electronics: 3, composite: 8 }, '대형 인양 갠트리. 인양 효율 2.6. 전장 회수 연구로 생산.', 'salvage_ops'), 0.5),
  P(G('salvage', 'XL', 4.2, 15, 20, 2400, { machinery: 30, precision: 12, electronics: 8, composite: 16 }, '해체 독 수준의 인양 설비. 인양 효율 4.2. 초대형 산업 하드포인트 전용.', 'salvage_ops'), 0.55),
];

function specialized(gear: ModuleContent, suffix: string, name: string, spec: Partial<NonNullable<ModuleContent['ind']>>): ModuleContent {
  return { ...gear, id: `${gear.id}_${suffix}`, name: `${SIZE_NAME[gear.size]} ${name}`, ind: { ...gear.ind!, ...spec } };
}

export const IND_SPECIALIZED: ModuleContent[] = [
  specialized(G('salvage', 'S', 1.55, 5, 5, 420, { machinery: 6, composite: 2 }, '고철·화물을 빠르게 처리하되 장비의 온전한 회수율은 낮습니다.', 'salvage_ops'), 'cutter', '고속 절단기', { prec: 0.18 }),
  specialized(G('salvage', 'M', 2.4, 8, 10, 800, { machinery: 11, precision: 2, composite: 4 }, '넓은 전장에서 잔해를 빠르게 처리합니다. 장비를 온전히 회수하기는 어렵습니다.', 'salvage_ops'), 'cutter', '고속 절단기', { prec: 0.23 }),
  specialized(G('salvage', 'S', 0.72, 3, 5, 480, { machinery: 4, precision: 3, electronics: 2, composite: 2 }, '절단 속도를 낮추고 장비를 정밀하게 분리해 온전한 회수율을 높입니다.', 'salvage_ops'), 'precision', '정밀 회수기', { prec: 0.69 }),
  specialized(G('salvage', 'M', 1.15, 6, 9, 900, { machinery: 8, precision: 5, electronics: 4, composite: 4 }, '고가 장비를 천천히 분리해 온전한 회수율을 높입니다.', 'salvage_ops'), 'precision', '정밀 회수기', { prec: 0.78 }),
  specialized(G('mine', 'S', 3.5, 7, 5, 420, { machinery: 6, precision: 2, crystal: 4 }, '빠른 채굴에 전력과 추가 가동 정비비가 필요합니다.', 'mining_lasers'), 'output', '고출력 채광기', { miningUpkeep: 85 }),
  specialized(G('mine', 'M', 7, 11, 10, 800, { machinery: 12, precision: 4, crystal: 6, electronics: 2 }, '빠른 채굴에 전력과 추가 가동 정비비가 필요합니다.', 'mining_lasers'), 'output', '고출력 채광기', { miningUpkeep: 160 }),
  specialized(G('mine', 'S', 1.9, 2, 4, 360, { machinery: 3, precision: 2, crystal: 1 }, '처리량을 낮춰 전력과 가동 정비비를 절약합니다.', 'mining_lasers'), 'efficient', '효율형 채광기', { miningUpkeep: -35 }),
  specialized(G('mine', 'M', 3.8, 4, 8, 650, { machinery: 6, precision: 3, crystal: 2, electronics: 1 }, '처리량을 낮춰 전력과 가동 정비비를 절약합니다.', 'mining_lasers'), 'efficient', '효율형 채광기', { miningUpkeep: -65 }),
];

/** P16.7 field repair rigs — rate = hull share restored per hour on a size-S hull (an M hull takes twice as long,
 *  L four times, XL eight times; world/fieldRepair.ts). Repair only friendly ships out of battle, never wear.
 *  Released by its own switch (content/repairRelease.ts). */
export const IND_REPAIR_MODULES: ModuleContent[] = [
  G('repair', 'S', 1, 3, 5, 600, { machinery: 6, precision: 2, electronics: 1 }, '수리 드론 한 조와 용접 장비. 전투가 끝난 아군 함선의 선체를 현장에서 복구한다 (소형 선체 기준 시간당 100%, 대형일수록 느림). 마모는 정비소에서.', 'damage_control'),
  G('repair', 'M', 1.8, 6, 9, 1200, { machinery: 12, precision: 4, electronics: 3, composite: 2 }, '이동식 수리 갠트리와 수리 드론 격납고. 현장 수리 속도 1.8 (소형 선체 기준 시간당 180%).', 'damage_control'),
  G('repair', 'L', 3, 10, 15, 2400, { machinery: 24, precision: 8, electronics: 6, composite: 6 }, '부유식 수리 독 장비. 현장 수리 속도 3.0. 대형 산업 하드포인트 이상.', 'damage_control'),
];

/** the industrial gear id of a work and size */
export const indGear = (work: IndWork, size: Size) => `ind_${KEY[work]}_${size.toLowerCase()}`;
