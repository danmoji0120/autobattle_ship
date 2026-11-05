export type Role = 'line' | 'escort' | 'raider' | 'civilian';

/** Ship-local coordinates: x = port(+)/starboard(-), y = up, z = forward. */
export interface MountDef {
  weapon: string;
  pos: [number, number, number];
  facing: number; // yaw offset in degrees (0 = forward, 90 = port, -90 = starboard, 180 = aft)
  arc: number;    // half-angle in degrees
}

export interface LoadoutDef {
  id: string;
  name: string;
  desc: string;
  mounts: MountDef[];
  speedMul?: number;
  armorMul?: number;
  hpMul?: number;
  costDelta?: number;
}

export interface ShipClassDef {
  id: string;
  name: string;          // class name (player faction)
  enemyName: string;     // class name used by the enemy faction
  type: string;          // 전함 / 순양함 ...
  role: Role;
  length: number;
  radius: number;
  hp: number;
  armor: { front: number; side: number; rear: number };
  maxSpeed: number;
  accel: number;
  turnRate: number;      // deg/s
  lateral: number;       // fraction of max speed available off-axis
  cost: number;
  desc: string;
  loadouts: LoadoutDef[];
}

const m = (weapon: string, pos: [number, number, number], facing: number, arc: number): MountDef => ({ weapon, pos, facing, arc });

export const SHIP_CLASSES: Record<string, ShipClassDef> = {
  battleship: {
    id: 'battleship', name: '아퀼라급', enemyName: '타이런트급', type: '전함', role: 'line',
    length: 64, radius: 8.5, hp: 13000, armor: { front: 72, side: 52, rear: 30 },
    maxSpeed: 32, accel: 6, turnRate: 9, lateral: 0.35, cost: 300,
    desc: '함대의 중심. 압도적인 주포와 두꺼운 전면 장갑. 측후방은 상대적으로 취약하다.',
    loadouts: [
      {
        id: 'std', name: '표준 전열', desc: '3기의 3연장 주포. 정면 화력전의 왕.',
        mounts: [
          m('heavy_cannon', [0, 5.2, 17], 0, 150), m('heavy_cannon', [0, 7.4, 7], 0, 150), m('heavy_cannon', [0, 5.2, -17], 180, 150),
          m('medium_gun', [6.2, 3.4, 11], 90, 100), m('medium_gun', [-6.2, 3.4, 11], -90, 100),
          m('medium_gun', [6.2, 3.4, -6], 90, 100), m('medium_gun', [-6.2, 3.4, -6], -90, 100),
          m('pd_gun', [5, 4.2, 23], 90, 175), m('pd_gun', [-5, 4.2, 23], -90, 175),
          m('pd_gun', [5.4, 4.2, -24], 90, 175), m('pd_gun', [-5.4, 4.2, -24], -90, 175),
        ],
      },
      {
        id: 'rail', name: '레일건 장거리', desc: '전방 레일 캐논 2기. 사거리 밖에서 먼저 때린다.', costDelta: 30,
        mounts: [
          m('rail_cannon', [0, 5.2, 17], 0, 70), m('rail_cannon', [0, 7.4, 7], 0, 70), m('heavy_cannon', [0, 5.2, -17], 180, 150),
          m('medium_gun', [6.2, 3.4, 11], 90, 100), m('medium_gun', [-6.2, 3.4, 11], -90, 100),
          m('pd_gun', [5, 4.2, 23], 90, 175), m('pd_gun', [-5, 4.2, 23], -90, 175),
          m('pd_gun', [5.4, 4.2, -24], 90, 175), m('pd_gun', [-5.4, 4.2, -24], -90, 175),
        ],
      },
      {
        id: 'fortress', name: '요새형', desc: '주포 2기, 방공포 8기, 증가 장갑. 느리지만 무너지지 않는다.', speedMul: 0.82, armorMul: 1.18, hpMul: 1.1, costDelta: 20,
        mounts: [
          m('heavy_cannon', [0, 5.2, 17], 0, 150), m('heavy_cannon', [0, 7.4, 7], 0, 150),
          m('medium_gun', [6.2, 3.4, 11], 90, 100), m('medium_gun', [-6.2, 3.4, 11], -90, 100),
          m('pd_gun', [5, 4.2, 23], 90, 175), m('pd_gun', [-5, 4.2, 23], -90, 175),
          m('pd_gun', [6.2, 3.4, -6], 90, 175), m('pd_gun', [-6.2, 3.4, -6], -90, 175),
          m('pd_gun', [5.4, 4.2, -24], 90, 175), m('pd_gun', [-5.4, 4.2, -24], -90, 175),
          m('pd_gun', [0, 5.2, -17], 180, 175), m('pd_gun', [0, 9, -2], 0, 180),
        ],
      },
    ],
  },
  cruiser: {
    id: 'cruiser', name: '세이버급', enemyName: '레이저백급', type: '순양함', role: 'line',
    length: 38, radius: 5.5, hp: 5000, armor: { front: 40, side: 30, rear: 18 },
    maxSpeed: 46, accel: 10, turnRate: 17, lateral: 0.4, cost: 140,
    desc: '다재다능한 주력함. 미사일 일제사격으로 적 방공망을 시험한다.',
    loadouts: [
      {
        id: 'multi', name: '다목적', desc: '부포 2기 + 미사일 발사기 2기.',
        mounts: [
          m('medium_gun', [0, 3.6, 9], 0, 150), m('medium_gun', [0, 3.6, -9], 180, 150),
          m('missile_rack', [3.4, 3, 1.5], 0, 180), m('missile_rack', [-3.4, 3, 1.5], 0, 180),
          m('pd_gun', [3.6, 3, 13], 90, 175), m('pd_gun', [-3.6, 3, 13], -90, 175),
        ],
      },
      {
        id: 'missile', name: '미사일 순양함', desc: '발사기 4기. 원거리 포화 공격 특화.', costDelta: 10,
        mounts: [
          m('medium_gun', [0, 3.6, 9], 0, 150),
          m('missile_rack', [3.4, 3, 3], 0, 180), m('missile_rack', [-3.4, 3, 3], 0, 180),
          m('missile_rack', [3.4, 3, -4], 0, 180), m('missile_rack', [-3.4, 3, -4], 0, 180),
          m('pd_gun', [3.6, 3, 13], 90, 175), m('pd_gun', [-3.6, 3, 13], -90, 175),
        ],
      },
      {
        id: 'gun', name: '포격 순양함', desc: '부포 4기. 근중거리 난타전에 강하다.',
        mounts: [
          m('medium_gun', [0, 3.6, 10], 0, 150), m('medium_gun', [0, 4.8, 4], 0, 150),
          m('medium_gun', [0, 3.6, -9], 180, 150), m('medium_gun', [0, 4.8, -3.5], 180, 150),
          m('pd_gun', [3.6, 3, 13], 90, 175), m('pd_gun', [-3.6, 3, 13], -90, 175), m('pd_gun', [0, 5, -14], 180, 175),
        ],
      },
    ],
  },
  destroyer: {
    id: 'destroyer', name: '아이기스급', enemyName: '바실리스크급', type: '호위구축함', role: 'escort',
    length: 24, radius: 3.8, hp: 2400, armor: { front: 24, side: 18, rear: 12 },
    maxSpeed: 64, accel: 16, turnRate: 32, lateral: 0.5, cost: 80,
    desc: '함대의 방패. 방공포로 미사일과 어뢰를 걷어낸다.',
    loadouts: [
      {
        id: 'aa', name: '방공', desc: '방공포 6기. 미사일·어뢰 요격 특화.',
        mounts: [
          m('medium_gun', [0, 3, 7], 0, 150),
          m('pd_gun', [2.4, 2.6, 5], 90, 175), m('pd_gun', [-2.4, 2.6, 5], -90, 175),
          m('pd_gun', [2.4, 2.6, -1], 90, 175), m('pd_gun', [-2.4, 2.6, -1], -90, 175),
          m('pd_gun', [2.4, 2.6, -7], 90, 175), m('pd_gun', [-2.4, 2.6, -7], -90, 175),
        ],
      },
      {
        id: 'strike', name: '대함', desc: '부포 2기 + 어뢰 1기. 공격적인 호위.',
        mounts: [
          m('medium_gun', [0, 3, 7], 0, 150), m('medium_gun', [0, 3, -7], 180, 150),
          m('torpedo', [0, 1.4, 10], 0, 25),
          m('pd_gun', [2.4, 2.6, 0], 90, 175), m('pd_gun', [-2.4, 2.6, 0], -90, 175),
        ],
      },
    ],
  },
  corvette: {
    id: 'corvette', name: '스틸레토급', enemyName: '바이퍼급', type: '고속 초계함', role: 'raider',
    length: 14, radius: 2.4, hp: 1000, armor: { front: 10, side: 8, rear: 6 },
    maxSpeed: 118, accel: 42, turnRate: 80, lateral: 0.2, cost: 45,
    desc: '빠르고 연약한 사냥꾼. 측후방을 파고들어 어뢰를 꽂는다.',
    loadouts: [
      {
        id: 'torp', name: '뇌격', desc: '어뢰 1기(2연사) + 기관포 2기.',
        mounts: [
          m('torpedo', [0, 0.4, 5], 0, 25),
          m('autocannon', [1.9, 0.9, 3], 0, 40), m('autocannon', [-1.9, 0.9, 3], 0, 40),
          m('pd_gun', [0, 1.6, -3], 180, 170),
        ],
      },
      {
        id: 'gun', name: '강습', desc: '기관포 4기. 적 경함정과 호위함 사냥.',
        mounts: [
          m('autocannon', [1.9, 0.9, 3], 0, 40), m('autocannon', [-1.9, 0.9, 3], 0, 40),
          m('autocannon', [1.4, 1.4, -1], 0, 60), m('autocannon', [-1.4, 1.4, -1], 0, 60),
          m('pd_gun', [0, 1.6, -3], 180, 170),
        ],
      },
    ],
  },
};

// Civilian / structural classes used by the persistent world (they can still end up in battles).
Object.assign(SHIP_CLASSES, {
  miner: {
    id: 'miner', name: '곡괭이급', enemyName: '곡괭이급', type: '채굴선', role: 'civilian',
    length: 30, radius: 6, hp: 2600, armor: { front: 30, side: 22, rear: 14 },
    maxSpeed: 34, accel: 8, turnRate: 14, lateral: 0.4, cost: 90,
    desc: '채굴 레이저와 대형 화물칸. 소행성에서 광석과 크리스탈을 캐낸다.',
    loadouts: [{ id: 'std', name: '표준 채굴', desc: '채굴 레이저 + 자위용 방공포 2기', mounts: [m('pd_gun', [3, 3, 6], 90, 175), m('pd_gun', [-3, 3, -6], -90, 175)] }],
  },
  hauler: {
    id: 'hauler', name: '짐꾼급', enemyName: '짐꾼급', type: '수송선', role: 'civilian',
    length: 40, radius: 6.5, hp: 3200, armor: { front: 26, side: 20, rear: 12 },
    maxSpeed: 40, accel: 8, turnRate: 12, lateral: 0.35, cost: 100,
    desc: '거대한 컨테이너 수송선. 채굴선에서 광석을 받아 정거장으로 나른다.',
    loadouts: [{ id: 'std', name: '표준 수송', desc: '방공포 2기', mounts: [m('pd_gun', [3.5, 4, 12], 90, 175), m('pd_gun', [-3.5, 4, -12], -90, 175)] }],
  },
  constructor: {
    id: 'constructor', name: '석공급', enemyName: '석공급', type: '공작선', role: 'civilian',
    length: 34, radius: 6, hp: 3000, armor: { front: 28, side: 22, rear: 14 },
    maxSpeed: 32, accel: 7, turnRate: 12, lateral: 0.4, cost: 160,
    desc: '조립 크레인과 드론 격납고를 갖춘 공작선. 정거장을 세우고 모듈을 건설한다.',
    loadouts: [{ id: 'std', name: '표준 공작', desc: '방공포 2기', mounts: [m('pd_gun', [3, 4, 8], 90, 175), m('pd_gun', [-3, 4, -8], -90, 175)] }],
  },
  platform: {
    id: 'platform', name: '방어 포대', enemyName: '요새 포대', type: '방어 플랫폼', role: 'line',
    length: 40, radius: 14, hp: 16000, armor: { front: 60, side: 60, rear: 60 },
    maxSpeed: 0.001, accel: 0, turnRate: 0, lateral: 1, cost: 250,
    desc: '정거장에 고정된 포대. 움직이지 못하지만 단단하다.',
    loadouts: [{ id: 'std', name: '포대', desc: '주포 2 + 부포 2 + 방공 4', mounts: [
      m('heavy_cannon', [0, 8, 6], 0, 180), m('heavy_cannon', [0, 8, -6], 180, 180),
      m('medium_gun', [8, 4, 0], 90, 180), m('medium_gun', [-8, 4, 0], -90, 180),
      m('pd_gun', [10, 6, 10], 90, 180), m('pd_gun', [-10, 6, 10], -90, 180), m('pd_gun', [10, 6, -10], 90, 180), m('pd_gun', [-10, 6, -10], -90, 180)] }],
  },
} as Record<string, ShipClassDef>);

export function getLoadout(classId: string, loadoutId: string): LoadoutDef {
  const c = SHIP_CLASSES[classId];
  return c.loadouts.find(l => l.id === loadoutId) ?? c.loadouts[0];
}

export function shipCost(classId: string, loadoutId: string): number {
  const c = SHIP_CLASSES[classId];
  return c.cost + (getLoadout(classId, loadoutId).costDelta ?? 0);
}

export const SHIP_NAMES: [string[], string[]] = [
  ['아퀼라', '발키리', '오리온', '헤르메스', '세라핌', '아르테미스', '레굴루스', '카시오페아', '스피카', '프로키온', '알타이르', '벨라트릭스',
    '미라', '데네브', '안타레스', '시리우스', '카펠라', '폴라리스', '베가', '리겔', '아크투루스', '포말하우트', '카노푸스', '엘타닌',
    '사우렌', '하이페리온', '이카루스', '라이라', '노바', '셀레네'],
  ['도미니언', '그림', '오블리비언', '네메시스', '레퀴엠', '말레볼런스', '타나토스', '모르간', '베헤모스', '칼리굴라', '아수라', '라그나',
    '디스페어', '벨리알', '크라켄', '스코지', '하빈저', '바르가스', '레기온', '팬텀', '바일', '서번트', '토르멘트', '루인', '아다마스',
    '베놈', '스팅어', '랜스', '파이크', '할버드'],
];
