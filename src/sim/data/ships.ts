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
  /** renderer silhouette override (content hulls with their own mesh base) */
  mesh?: { base: string; scale: number };
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
    id: 'cruiser', name: '세이버급', enemyName: '레이저백급', type: '중순양함', role: 'line',
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
    id: 'destroyer', name: '아이기스급', enemyName: '바실리스크급', type: '구축함', role: 'escort',
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
    id: 'corvette', name: '스틸레토급', enemyName: '바이퍼급', type: '초계함', role: 'raider',
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

// Hull classes that PMCs design and build themselves (persistent world). Mount positions are in the
// hull's own scale; the 3D model reuses a base silhouette stretched to the hull's size.
Object.assign(SHIP_CLASSES, {
  frigate: {
    id: 'frigate', name: '랜서급', enemyName: '자칼급', type: '호위함', role: 'escort',
    length: 20, radius: 3.2, hp: 1700, armor: { front: 18, side: 14, rear: 9 },
    maxSpeed: 84, accel: 24, turnRate: 48, lateral: 0.42, cost: 60,
    desc: '초계함보다 단단하고 구축함보다 빠른 호위함. 방공과 경함정 사냥을 겸한다.',
    loadouts: [
      { id: 'patrol', name: '초계', desc: '기관포 2 + 어뢰 1 + 방공포 2.', mounts: [m('autocannon', [1.6, 1.4, 5], 0, 60), m('autocannon', [-1.6, 1.4, 5], 0, 60), m('torpedo', [0, 0.8, 8], 0, 25), m('pd_gun', [1.8, 2, -3], 90, 175), m('pd_gun', [-1.8, 2, -3], -90, 175)] },
      { id: 'aa', name: '방공 호위', desc: '방공포 4 + 기관포 2. 미사일 요격.', mounts: [m('autocannon', [0, 2.2, 6], 0, 120), m('autocannon', [0, 2.2, -5], 180, 120), m('pd_gun', [1.8, 2, 3], 90, 175), m('pd_gun', [-1.8, 2, 3], -90, 175), m('pd_gun', [1.8, 2, -3], 90, 175), m('pd_gun', [-1.8, 2, -3], -90, 175)] },
      { id: 'missile', name: '미사일 호위', desc: 'VLS 1기 + 기관포 + 방공포 2.', costDelta: 8, mounts: [m('missile_rack', [0, 1.8, 0], 0, 180), m('autocannon', [0, 2.2, 6], 0, 120), m('pd_gun', [1.8, 2, -4], 90, 175), m('pd_gun', [-1.8, 2, -4], -90, 175)] },
    ],
  },
  light_cruiser: {
    id: 'light_cruiser', name: '팔코급', enemyName: '하운드급', type: '경순양함', role: 'line',
    length: 32, radius: 4.8, hp: 3600, armor: { front: 32, side: 24, rear: 14 },
    maxSpeed: 54, accel: 13, turnRate: 22, lateral: 0.45, cost: 105,
    desc: '빠른 순양함. 구축함 전대를 이끌거나 측면을 돈다. 중순양함보다 얇다.',
    loadouts: [
      { id: 'gun', name: '포격', desc: '부포 3 + 방공포 3.', mounts: [m('medium_gun', [0, 3.2, 8], 0, 150), m('medium_gun', [0, 4.2, 3], 0, 150), m('medium_gun', [0, 3.2, -8], 180, 150), m('pd_gun', [3, 2.6, 10], 90, 175), m('pd_gun', [-3, 2.6, 10], -90, 175), m('pd_gun', [0, 4.4, -12], 180, 175)] },
      { id: 'missile', name: '미사일', desc: 'VLS 2 + 부포 1 + 방공포 2.', costDelta: 10, mounts: [m('medium_gun', [0, 3.2, 8], 0, 150), m('missile_rack', [2.8, 2.6, 0], 0, 180), m('missile_rack', [-2.8, 2.6, 0], 0, 180), m('pd_gun', [3, 2.6, 10], 90, 175), m('pd_gun', [-3, 2.6, 10], -90, 175)] },
      { id: 'laser', name: '레이저', desc: '펄스 레이저 3 + 방공포 2. 즉발 고정밀, 장갑 관통은 낮다.', costDelta: 15, mounts: [m('pulse_laser', [0, 3.2, 8], 0, 150), m('pulse_laser', [0, 4.2, 3], 0, 150), m('pulse_laser', [0, 3.2, -8], 180, 150), m('pd_gun', [3, 2.6, 10], 90, 175), m('pd_gun', [-3, 2.6, 10], -90, 175)] },
    ],
  },
  battlecruiser: {
    id: 'battlecruiser', name: '발키리급', enemyName: '레비아탄급', type: '순양전함', role: 'line',
    length: 54, radius: 7, hp: 9000, armor: { front: 54, side: 38, rear: 22 },
    maxSpeed: 42, accel: 9, turnRate: 12, lateral: 0.38, cost: 220,
    desc: '전함급 주포와 순양함의 속도. 대신 장갑이 얇아 정면 난타전은 피해야 한다.',
    loadouts: [
      { id: 'heavy', name: '주포', desc: '주포 2 + 부포 4 + 방공 4.', mounts: [m('heavy_cannon', [0, 4.6, 14], 0, 150), m('heavy_cannon', [0, 6.4, 6], 0, 150), m('medium_gun', [5.2, 3, 8], 90, 100), m('medium_gun', [-5.2, 3, 8], -90, 100), m('medium_gun', [5.2, 3, -6], 90, 100), m('medium_gun', [-5.2, 3, -6], -90, 100), m('pd_gun', [4.4, 3.6, 19], 90, 175), m('pd_gun', [-4.4, 3.6, 19], -90, 175), m('pd_gun', [4.6, 3.6, -20], 90, 175), m('pd_gun', [-4.6, 3.6, -20], -90, 175)] },
      { id: 'rail', name: '레일건', desc: '레일 캐논 2 + 부포 2 + 방공 4.', costDelta: 30, mounts: [m('rail_cannon', [0, 4.6, 14], 0, 70), m('rail_cannon', [0, 6.4, 6], 0, 70), m('medium_gun', [5.2, 3, 0], 90, 100), m('medium_gun', [-5.2, 3, 0], -90, 100), m('pd_gun', [4.4, 3.6, 19], 90, 175), m('pd_gun', [-4.4, 3.6, 19], -90, 175), m('pd_gun', [4.6, 3.6, -20], 90, 175), m('pd_gun', [-4.6, 3.6, -20], -90, 175)] },
      { id: 'lance', name: '입자 창', desc: '입자 창 2 + 부포 2 + 방공 4. 초장거리 일격.', costDelta: 45, mounts: [m('particle_lance', [0, 4.6, 14], 0, 60), m('particle_lance', [0, 6.4, 6], 0, 60), m('medium_gun', [5.2, 3, 0], 90, 100), m('medium_gun', [-5.2, 3, 0], -90, 100), m('pd_gun', [4.4, 3.6, 19], 90, 175), m('pd_gun', [-4.4, 3.6, 19], -90, 175), m('pd_gun', [4.6, 3.6, -20], 90, 175), m('pd_gun', [-4.6, 3.6, -20], -90, 175)] },
    ],
  },
  dreadnought: {
    id: 'dreadnought', name: '임페라토르급', enemyName: '아포칼립스급', type: '초대형 전함', role: 'line',
    length: 92, radius: 12, hp: 26000, armor: { front: 90, side: 66, rear: 40 },
    maxSpeed: 24, accel: 4, turnRate: 6, lateral: 0.3, cost: 600,
    desc: '움직이는 요새. 대형 조선소로도 부족해 전용 건조 독이 필요하다.',
    loadouts: [
      { id: 'std', name: '전열', desc: '주포 5 + 부포 6 + VLS 2 + 방공 8.', mounts: [
        m('heavy_cannon', [0, 7.5, 30], 0, 150), m('heavy_cannon', [0, 10.5, 16], 0, 150), m('heavy_cannon', [0, 12, 2], 0, 150), m('heavy_cannon', [0, 7.5, -26], 180, 150), m('heavy_cannon', [0, 10.5, -14], 180, 150),
        m('medium_gun', [9, 5, 20], 90, 100), m('medium_gun', [-9, 5, 20], -90, 100), m('medium_gun', [9, 5, 0], 90, 100), m('medium_gun', [-9, 5, 0], -90, 100), m('medium_gun', [9, 5, -18], 90, 100), m('medium_gun', [-9, 5, -18], -90, 100),
        m('missile_rack', [5, 6, 8], 0, 180), m('missile_rack', [-5, 6, 8], 0, 180),
        m('pd_gun', [7, 6, 36], 90, 175), m('pd_gun', [-7, 6, 36], -90, 175), m('pd_gun', [8, 6, 10], 90, 175), m('pd_gun', [-8, 6, 10], -90, 175), m('pd_gun', [8, 6, -10], 90, 175), m('pd_gun', [-8, 6, -10], -90, 175), m('pd_gun', [7.5, 6, -36], 90, 175), m('pd_gun', [-7.5, 6, -36], -90, 175)] },
      { id: 'lance', name: '입자 창 전열', desc: '입자 창 3 + 주포 2 + 부포 4 + 방공 8.', costDelta: 80, mounts: [
        m('particle_lance', [0, 7.5, 30], 0, 60), m('particle_lance', [0, 10.5, 16], 0, 60), m('particle_lance', [0, 12, 2], 0, 60), m('heavy_cannon', [0, 7.5, -26], 180, 150), m('heavy_cannon', [0, 10.5, -14], 180, 150),
        m('medium_gun', [9, 5, 20], 90, 100), m('medium_gun', [-9, 5, 20], -90, 100), m('medium_gun', [9, 5, -18], 90, 100), m('medium_gun', [-9, 5, -18], -90, 100),
        m('pd_gun', [7, 6, 36], 90, 175), m('pd_gun', [-7, 6, 36], -90, 175), m('pd_gun', [8, 6, 10], 90, 175), m('pd_gun', [-8, 6, 10], -90, 175), m('pd_gun', [8, 6, -10], 90, 175), m('pd_gun', [-8, 6, -10], -90, 175), m('pd_gun', [7.5, 6, -36], 90, 175), m('pd_gun', [-7.5, 6, -36], -90, 175)] },
    ],
  },
} as Record<string, ShipClassDef>);

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
