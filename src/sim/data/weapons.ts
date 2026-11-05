export type WeaponKind = 'shell' | 'missile' | 'torpedo' | 'pd';

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  damage: number;
  pen: number;          // armor penetration
  range: number;
  speed: number;        // projectile speed (u/s); pd is hitscan
  reload: number;       // seconds between salvos
  salvo: number;        // shots per salvo
  salvoGap: number;     // seconds between shots in a salvo
  spread: number;       // radians dispersion (1 sigma)
  turnSpeed: number;    // turret traverse deg/s
  caliber: number;      // visual size scale
  guidedTurn?: number;  // rad/s for guided munitions
  munitionHp?: number;  // hits needed for PD to kill
  pdChance?: number;    // PD hit chance per shot vs missiles
  magazine?: number;    // salvos available (undefined = unlimited)
  sound: string;
  desc: string;
}

export const WEAPONS: Record<string, WeaponDef> = {
  heavy_cannon: {
    id: 'heavy_cannon', name: '460mm 질량투사 주포', kind: 'shell',
    damage: 360, pen: 88, range: 1550, speed: 620, reload: 8.5, salvo: 3, salvoGap: 0.14,
    spread: 0.0085, turnSpeed: 22, caliber: 3.2, sound: 'heavy', desc: '전함의 상징. 느리지만 거함의 장갑을 찢는다.',
  },
  rail_cannon: {
    id: 'rail_cannon', name: '전자기 레일 캐논', kind: 'shell',
    damage: 300, pen: 120, range: 2000, speed: 1400, reload: 10, salvo: 2, salvoGap: 0.25,
    spread: 0.0045, turnSpeed: 14, caliber: 2.4, sound: 'rail', desc: '초고속 관통탄. 장거리 저격용, 회피가 거의 불가능.',
  },
  medium_gun: {
    id: 'medium_gun', name: '155mm 속사 부포', kind: 'shell',
    damage: 68, pen: 42, range: 950, speed: 820, reload: 2.4, salvo: 2, salvoGap: 0.16,
    spread: 0.014, turnSpeed: 55, caliber: 1.4, sound: 'medium', desc: '균형 잡힌 다목적 포. 순양함 이하에 유효.',
  },
  autocannon: {
    id: 'autocannon', name: '30mm 회전 기관포', kind: 'shell',
    damage: 12, pen: 15, range: 560, speed: 1100, reload: 0.11, salvo: 1, salvoGap: 0,
    spread: 0.028, turnSpeed: 220, caliber: 0.6, sound: 'auto', desc: '경함정 사냥용 탄막. 중장갑엔 튕겨나간다.',
  },
  missile_rack: {
    id: 'missile_rack', name: 'VLS 대함 미사일', kind: 'missile',
    damage: 125, pen: 58, range: 1650, speed: 270, reload: 15, salvo: 4, salvoGap: 0.25, magazine: 6,
    spread: 0.2, turnSpeed: 360, caliber: 1.0, guidedTurn: 1.7, munitionHp: 1, sound: 'missile',
    desc: '수직발사 유도탄. 일제 사격으로 방공망을 포화시킨다.',
  },
  torpedo: {
    id: 'torpedo', name: '중(重) 플라즈마 어뢰', kind: 'torpedo',
    damage: 1100, pen: 100, range: 820, speed: 175, reload: 21, salvo: 2, salvoGap: 0.45,
    spread: 0.05, turnSpeed: 360, caliber: 1.8, guidedTurn: 0.65, munitionHp: 2, sound: 'torpedo',
    desc: '근접해야만 쏠 수 있는 필살의 일격. 전함도 두세 발이면 치명상.',
  },
  pd_gun: {
    id: 'pd_gun', name: '근접 방어 기관포', kind: 'pd',
    damage: 4, pen: 8, range: 320, speed: 0, reload: 0.1, salvo: 1, salvoGap: 0,
    spread: 0, turnSpeed: 400, caliber: 0.4, pdChance: 0.05, sound: 'pd',
    desc: '미사일과 어뢰를 요격한다. 접근한 초계함도 긁는다.',
  },
  pulse_laser: {
    id: 'pulse_laser', name: '펄스 레이저', kind: 'shell',
    damage: 40, pen: 34, range: 900, speed: 3200, reload: 1.6, salvo: 3, salvoGap: 0.08,
    spread: 0.004, turnSpeed: 90, caliber: 1.0, sound: 'medium', desc: '거의 즉발하는 에너지 펄스. 빠른 표적에 강하고 중장갑엔 약하다.',
  },
  particle_lance: {
    id: 'particle_lance', name: '입자 창', kind: 'shell',
    damage: 520, pen: 110, range: 1800, speed: 2600, reload: 12, salvo: 1, salvoGap: 0,
    spread: 0.003, turnSpeed: 16, caliber: 2.8, sound: 'rail', desc: '고출력 입자빔. 먼 거리에서 대형함의 장갑을 꿰뚫는다.',
  },
};
