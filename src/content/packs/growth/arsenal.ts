// P5 arsenal (growth, contentV ≥ 3): weapon families and tiers, shields, the 13-area research
// additions, the ammunition / energy-weapon factories and specialised labs.
//
// Design rules (docs/CODEX_CONTENT_GUIDE.md §7):
//  - a higher tier is not strictly better: it reaches further and hits harder per shot, but draws more
//    power, needs a bigger hardpoint, traverses slower and fires slower — small fast craft slip it;
//  - anti-small weapons (red laser, fast coil, fast missile) traverse fast and fire often with low
//    penetration; anti-capital weapons (X-ray/gamma, heavy rail, torpedoes) are slow and penetrate;
//  - energy weapons hit shields hard and need no ammunition but draw heavy power; kinetic weapons and
//    plasma are poor against shields; missiles and torpedoes can be shot down and burn ammunition;
//  - every weapon is made from the existing goods + at most two new intermediates (munitions, optics).
import type { VariantDef, PresetDef } from '../../schema';
import type { ArmContent, ModuleContent, ItemContent, TechContent, FacilityContent, RecipeContent } from '../../schema';

export const P5_ITEMS: ItemContent[] = [
  { id: 'munitions', name: '탄약·추진제', cat: 'part', tier: 3, price: 70, color: '#e0b060', desc: '포탄 장약, 코일건 탄체, 미사일 추진제. 탄약·미사일 공장에서 만든다.' },
  { id: 'optics', name: '집속 광학체', cat: 'part', tier: 3, price: 520, color: '#a0f0ff', desc: '레이저·입자 무장의 집속 렌즈와 공진기. 에너지 무장 공장에서 만든다.' },
];

const W = (a: ArmContent) => a;
export const P5_ARMS: ArmContent[] = [
  // ── laser: red → blue → UV → X-ray → gamma (energy, near-instant, strong vs shields, no ammo, heavy power)
  W({ id: 'eq_laser_red', name: '적색 펄스 레이저', family: 'laser', tier: 1, role: 'anti-small', size: 'S', mass: 3, power: 5, mounts: ['turret', 'fixed'], tech: 'optical_lasers',
    desc: '저출력 소형 레이저. 빠르게 선회해 초계함·미사일 같은 작은 표적을 쫓는다. 장갑함에는 거의 통하지 않는다.',
    combat: { kind: 'shell', damage: 14, pen: 14, range: 650, speed: 4000, reload: 0.6, salvo: 2, salvoGap: 0.06, spread: 0.004, turnSpeed: 160, caliber: 0.6, vsShield: 1.2, sound: 'auto' },
    vis: { color: '#ff5040', len: 30, wid: 0.5, beam: true }, recipe: { fac: 'energy_fab', time: 360, in: { optics: 1, electronics: 1, weapon_parts: 1 } } }),
  W({ id: 'eq_laser_blue', name: '청색 레이저', family: 'laser', tier: 2, role: 'general', size: 'M', mass: 7, power: 12, mounts: ['turret', 'fixed'], tech: 'blue_lasers',
    desc: '범용 중형 레이저. 즉발에 가까운 정밀 사격, 중간 관통력.',
    combat: { kind: 'shell', damage: 46, pen: 30, range: 950, speed: 4000, reload: 1.4, salvo: 3, salvoGap: 0.08, spread: 0.0035, turnSpeed: 95, caliber: 1, vsShield: 1.25, sound: 'medium' },
    vis: { color: '#4f8cff', len: 45, wid: 0.8, beam: true }, recipe: { fac: 'energy_fab', time: 720, in: { optics: 2, electronics: 3, weapon_parts: 2 } } }),
  W({ id: 'eq_laser_uv', name: '자외선 레이저', family: 'laser', tier: 3, role: 'general', size: 'M', mass: 9, power: 18, mounts: ['turret', 'fixed'], tech: 'uv_lasers',
    desc: '단파장 고출력 레이저. 구축함·순양함 장갑을 뚫기 시작한다. 전력 소모가 크다.',
    combat: { kind: 'shell', damage: 70, pen: 44, range: 1150, speed: 4400, reload: 1.9, salvo: 3, salvoGap: 0.08, spread: 0.003, turnSpeed: 70, caliber: 1.2, vsShield: 1.3, sound: 'medium' },
    vis: { color: '#c070ff', len: 55, wid: 1, beam: true }, recipe: { fac: 'energy_fab', time: 1200, in: { optics: 4, electronics: 4, weapon_parts: 3, crystal: 2 } } }),
  W({ id: 'eq_laser_xray', name: 'X선 레이저 포', family: 'laser', tier: 4, role: 'anti-capital', size: 'L', mass: 22, power: 34, mounts: ['turret', 'fixed', 'spinal'], tech: 'xray_lasers',
    desc: '대형함용 X선 레이저. 장거리에서 순양함 이상을 녹인다. 선회가 느려 소형함을 놓친다.',
    combat: { kind: 'shell', damage: 260, pen: 82, range: 1500, speed: 5000, reload: 6, salvo: 2, salvoGap: 0.1, spread: 0.0025, turnSpeed: 26, caliber: 2, vsShield: 1.3, sound: 'rail' },
    vis: { color: '#e8f4ff', len: 90, wid: 1.6, beam: true }, recipe: { fac: 'energy_fab', time: 2400, in: { optics: 8, electronics: 8, weapon_parts: 6, rare_metal: 4, crystal: 4 } } }),
  W({ id: 'eq_laser_gamma', name: '감마선 척추포', family: 'laser', tier: 5, role: 'anti-capital', size: 'L', mass: 30, power: 60, mounts: ['fixed', 'spinal'], tech: 'gamma_lasers',
    desc: '함체 전장을 관통하는 척추 장착 감마선포. 전함의 장갑도 꿰뚫지만 함수를 돌려야 조준하고, 반응로를 거의 다 쓴다.',
    combat: { kind: 'shell', damage: 640, pen: 120, range: 1750, speed: 6000, reload: 13, salvo: 1, salvoGap: 0, spread: 0.002, turnSpeed: 10, caliber: 3, vsShield: 1.4, sound: 'rail' },
    vis: { color: '#a0ffb0', len: 160, wid: 2.6, beam: true }, recipe: { fac: 'energy_fab', time: 4200, in: { optics: 16, electronics: 14, weapon_parts: 8, rare_metal: 10, crystal: 10 } } }),
  // ── coil: coil → fast coil → medium rail (kinetic, cheap power, ammunition, poor vs shields)
  W({ id: 'eq_coil_s', name: '코일건', family: 'coil', tier: 1, role: 'general', size: 'S', mass: 5, power: 3, mounts: ['turret', 'fixed'], tech: 'coilguns',
    desc: '전자기 가속 소구경포. 싸고 튼튼하며 전력을 적게 쓴다. 실드에는 약하다.',
    combat: { kind: 'shell', damage: 22, pen: 24, range: 700, speed: 1300, reload: 0.9, salvo: 2, salvoGap: 0.1, spread: 0.016, turnSpeed: 140, caliber: 0.7, vsShield: 0.7, sound: 'auto' },
    vis: { color: '#ffd080', len: 16, wid: 0.5 }, recipe: { fac: 'weapons_factory', time: 300, in: { weapon_parts: 1, alloy: 8, munitions: 4 } }, supply: { metal: 0.3, chemicals: 0.1 } }),
  W({ id: 'eq_coil_fast', name: '속사 코일건', family: 'coil', tier: 2, role: 'anti-small', size: 'M', mass: 9, power: 6, mounts: ['turret'], tech: 'fast_coils',
    desc: '연사형 코일건. 탄막으로 고속 소형함과 미사일을 잡는다. 대형함 장갑엔 튕긴다. 탄약 소모가 크다.',
    combat: { kind: 'shell', damage: 18, pen: 26, range: 780, speed: 1700, reload: 0.18, salvo: 1, salvoGap: 0, spread: 0.02, turnSpeed: 200, caliber: 0.6, vsShield: 0.6, sound: 'auto' },
    vis: { color: '#ffc060', len: 14, wid: 0.45 }, recipe: { fac: 'weapons_factory', time: 600, in: { weapon_parts: 2, alloy: 10, munitions: 8, precision: 1 } }, supply: { metal: 0.8, chemicals: 0.3 } }),
  W({ id: 'eq_rail_m', name: '중형 레일건', family: 'coil', tier: 3, role: 'anti-capital', size: 'M', mass: 16, power: 18, mounts: ['turret', 'fixed'], tech: 'rail_miniaturization',
    desc: '구축함에 얹는 레일건. 관통력이 높아 대형함 측면을 뚫는다. 연사가 느리다.',
    combat: { kind: 'shell', damage: 190, pen: 92, range: 1500, speed: 1800, reload: 6, salvo: 1, salvoGap: 0, spread: 0.004, turnSpeed: 30, caliber: 1.6, vsShield: 0.75, sound: 'rail' },
    vis: { color: '#9fe8ff', len: 90, wid: 1.1 }, recipe: { fac: 'weapons_factory', time: 1500, in: { weapon_parts: 5, electronics: 4, rare_metal: 3, precision: 2 } }, supply: { metal: 0.3 } }),
  // ── missile: fast / long-range / advanced guided (interceptable, ammunition, magazine-limited)
  W({ id: 'eq_missile_fast', name: '고속 미사일', family: 'missile', tier: 2, role: 'anti-small', size: 'M', mass: 10, power: 2, mounts: ['vls', 'turret'], tech: 'fast_missiles',
    desc: '경량 고기동 미사일. 소형함을 쫓아 잡는다. 탄두가 작아 대형함엔 약하다.',
    combat: { kind: 'missile', damage: 80, pen: 46, range: 1300, speed: 480, reload: 10, salvo: 4, salvoGap: 0.2, spread: 0.15, turnSpeed: 360, caliber: 0.8, guidedTurn: 2.6, munitionHp: 1, magazine: 8, vsShield: 0.8, sound: 'missile' },
    vis: { color: '#ffb070', len: 0, wid: 0.6 }, recipe: { fac: 'ammo_plant', time: 900, in: { weapon_parts: 2, electronics: 2, munitions: 10 } }, supply: { chemicals: 0.6 } }),
  W({ id: 'eq_missile_lr', name: '장거리 순항 미사일', family: 'missile', tier: 2, role: 'general', size: 'M', mass: 12, power: 2, mounts: ['vls'], tech: 'lr_missiles',
    desc: '포 사거리 밖에서 먼저 쏘는 순항 미사일. 느려서 방공포에 걸리기 쉽다.',
    combat: { kind: 'missile', damage: 140, pen: 60, range: 2400, speed: 220, reload: 20, salvo: 3, salvoGap: 0.3, spread: 0.2, turnSpeed: 360, caliber: 1.1, guidedTurn: 1.2, munitionHp: 1, magazine: 5, vsShield: 0.8, sound: 'missile' },
    vis: { color: '#ffd0a0', len: 0, wid: 0.8 }, recipe: { fac: 'ammo_plant', time: 1200, in: { weapon_parts: 3, electronics: 3, munitions: 14 } }, supply: { chemicals: 0.8 } }),
  W({ id: 'eq_missile_smart', name: '고급 유도 미사일', family: 'missile', tier: 3, role: 'general', size: 'M', mass: 12, power: 6, mounts: ['vls', 'turret'], tech: 'smart_missiles',
    desc: '기만체와 장갑 탄체로 방공망을 견디는 유도탄. 비싸고 탄창이 적다.',
    combat: { kind: 'missile', damage: 150, pen: 66, range: 1900, speed: 330, reload: 16, salvo: 4, salvoGap: 0.25, spread: 0.12, turnSpeed: 360, caliber: 1.1, guidedTurn: 2.2, munitionHp: 3, magazine: 6, vsShield: 0.85, sound: 'missile' },
    vis: { color: '#ff9050', len: 0, wid: 0.8 }, recipe: { fac: 'ammo_plant', time: 1800, in: { weapon_parts: 4, electronics: 6, munitions: 14, rare_metal: 2 } }, supply: { chemicals: 0.8 } }),
  // ── torpedo: standard → (heavy plasma: existing) → advanced anti-ship
  W({ id: 'eq_torp_std', name: '표준 어뢰', family: 'torpedo', tier: 1, role: 'anti-capital', size: 'M', mass: 9, power: 1, mounts: ['fixed', 'turret', 'vls'], tech: 'torpedo_casting',
    desc: '보급형 대함 어뢰. 중어뢰보다 약하지만 싸고 빨리 만든다.',
    combat: { kind: 'torpedo', damage: 650, pen: 80, range: 760, speed: 190, reload: 18, salvo: 2, salvoGap: 0.4, spread: 0.05, turnSpeed: 360, caliber: 1.5, guidedTurn: 0.7, munitionHp: 2, vsShield: 0.9, sound: 'torpedo' },
    recipe: { fac: 'ammo_plant', time: 600, in: { weapon_parts: 2, munitions: 12, electronics: 1 } }, supply: { chemicals: 0.5 } }),
  W({ id: 'eq_torp_asm', name: '고급 대함 어뢰', family: 'torpedo', tier: 3, role: 'anti-capital', size: 'L', mass: 20, power: 4, mounts: ['fixed', 'vls'], tech: 'asm_torpedoes',
    desc: '장갑 탄체 대함 어뢰. 요격에 강하고 한 발이 순양함을 반파한다. 근접해야 쏠 수 있다.',
    combat: { kind: 'torpedo', damage: 1600, pen: 125, range: 1100, speed: 210, reload: 28, salvo: 2, salvoGap: 0.5, spread: 0.05, turnSpeed: 360, caliber: 2.1, guidedTurn: 0.9, munitionHp: 4, vsShield: 0.9, sound: 'torpedo' },
    recipe: { fac: 'ammo_plant', time: 2400, in: { weapon_parts: 6, munitions: 24, electronics: 4, rare_metal: 4 } }, supply: { chemicals: 1.2 } }),
  // ── plasma: short range, slow bolts, enormous armour damage, poor vs shields
  W({ id: 'eq_plasma_s', name: '플라즈마 포', family: 'plasma', tier: 2, role: 'general', size: 'M', mass: 10, power: 16, mounts: ['turret', 'fixed'], tech: 'plasma_containment',
    desc: '자기 봉입 플라즈마탄. 근거리에서 장갑을 태운다. 탄속이 느리고 실드에 흩어진다.',
    combat: { kind: 'shell', damage: 160, pen: 70, range: 620, speed: 700, reload: 2.8, salvo: 1, salvoGap: 0, spread: 0.012, turnSpeed: 60, caliber: 1.4, vsShield: 0.55, sound: 'medium' },
    vis: { color: '#60ffd0', len: 12, wid: 1.6 }, recipe: { fac: 'energy_fab', time: 1200, in: { optics: 2, electronics: 3, weapon_parts: 3, chemicals: 10 } } }),
  W({ id: 'eq_plasma_l', name: '중(重) 플라즈마 포', family: 'plasma', tier: 3, role: 'anti-capital', size: 'L', mass: 26, power: 30, mounts: ['turret', 'fixed'], tech: 'plasma_heavy',
    desc: '전함 근접전용 대형 플라즈마포. 맞으면 치명적이지만 사거리가 짧다.',
    combat: { kind: 'shell', damage: 420, pen: 105, range: 820, speed: 620, reload: 7.5, salvo: 2, salvoGap: 0.25, spread: 0.01, turnSpeed: 24, caliber: 2.6, vsShield: 0.5, sound: 'heavy' },
    vis: { color: '#40ffc0', len: 18, wid: 2.6 }, recipe: { fac: 'energy_fab', time: 2700, in: { optics: 4, electronics: 6, weapon_parts: 8, chemicals: 20, rare_metal: 4 } } }),
  // ── particle: long, precise, very strong vs shields, very expensive power
  W({ id: 'eq_particle_m', name: '입자 가속포', family: 'particle', tier: 2, role: 'general', size: 'M', mass: 12, power: 22, mounts: ['turret', 'fixed'], tech: 'particle_accel',
    desc: '중형 입자빔. 실드를 찢고 장갑도 상당히 뚫는다. 반응로 부담이 매우 크다.',
    combat: { kind: 'shell', damage: 190, pen: 80, range: 1350, speed: 2600, reload: 5, salvo: 1, salvoGap: 0, spread: 0.003, turnSpeed: 40, caliber: 1.6, vsShield: 1.6, sound: 'rail' },
    vis: { color: '#ffe060', len: 70, wid: 1.3, beam: true }, recipe: { fac: 'energy_fab', time: 1800, in: { optics: 4, electronics: 8, weapon_parts: 4, crystal: 6, rare_metal: 3 } } }),
  // ── point defence: laser PD (no ammo, power) and flak (ammo, cheap power)
  W({ id: 'eq_pd_laser', name: '방공 레이저', family: 'pd', tier: 2, role: 'pd', size: 'S', mass: 2, power: 8, tech: 'pd_lasers',
    desc: '즉발 방공 레이저. 미사일 요격률이 높고 탄약이 필요 없다. 전력을 많이 쓴다.',
    combat: { kind: 'pd', damage: 3, pen: 6, range: 420, speed: 0, reload: 0.12, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 500, caliber: 0.4, pdChance: 0.09, vsShield: 1, sound: 'pd' },
    recipe: { fac: 'energy_fab', time: 480, in: { optics: 1, electronics: 2, weapon_parts: 1 } } }),
  W({ id: 'eq_pd_flak', name: '근접 신관 대공포', family: 'pd', tier: 2, role: 'pd', size: 'S', mass: 4, power: 3, tech: 'flak_fuzes',
    desc: '근접 신관 파편탄으로 미사일 무리를 쓸어낸다. 탄약을 쓴다.',
    combat: { kind: 'pd', damage: 6, pen: 10, range: 360, speed: 0, reload: 0.25, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 360, caliber: 0.5, pdChance: 0.14, vsShield: 0.7, sound: 'pd' },
    recipe: { fac: 'ammo_plant', time: 420, in: { weapon_parts: 1, munitions: 6, electronics: 1 } }, supply: { metal: 0.3, chemicals: 0.2 } }),
];

export const P5_MODULES: ModuleContent[] = [
  { id: 'mod_shield', name: '편향 실드 발생기', slot: 'armor', size: 'M', mass: 10, power: 14, tech: 'deflector_shields',
    desc: '선체 내구의 15%에 해당하는 실드. 피격이 멎으면 초당 2%씩 회복. 장갑 베이를 차지한다.',
    fx: { shield: 0.15, shieldRegen: 0.02 }, recipe: { fac: 'reactor_plant', time: 1200, in: { electronics: 6, crystal: 4, optics: 1, machinery: 4 } } },
  { id: 'mod_shield2', name: '위상 실드 발생기', slot: 'armor', size: 'M', mass: 12, power: 26, tech: 'phased_shields',
    desc: '선체 내구의 28%에 해당하는 실드, 초당 2.5% 회복. 전력 소모가 크다.',
    fx: { shield: 0.28, shieldRegen: 0.025 }, recipe: { fac: 'reactor_plant', time: 2100, in: { electronics: 10, crystal: 8, optics: 3, rare_metal: 4 } } },
  { id: 'mod_fusion_core', name: '소형 융합 코어', slot: 'reactor', size: 'M', mass: 14, power: -36, tech: 'compact_fusion',
    desc: '전력 공급 +36. 에너지 무장과 실드를 함께 운용하게 해 준다.',
    fx: {}, recipe: { fac: 'reactor_plant', time: 1500, in: { reactor: 1, composite: 6, electronics: 4 } } },
];

export const P5_FACILITIES: FacilityContent[] = [
  { kind: 'ammo_plant', name: '탄약·미사일 공장', cat: '부품', desc: '탄약·추진제와 미사일·어뢰·대공포를 만든다.', credits: 160000, mats: { alloy: 2000, machinery: 130, chemicals: 160 }, minStation: 'M', legacyBuild: { credits: 14000, mats: { alloy: 300, machinery: 16, chemicals: 40 } }, work: 200, power: -20, lines: 1, requires: 'core', tech: 'missile_fab', unlocks: '탄약·추진제 · 미사일 · 어뢰 · 근접 신관 대공포' },
  { kind: 'energy_fab', name: '에너지 무장 공장', cat: '부품', desc: '집속 광학체와 레이저·플라즈마·입자 무장을 만든다.', credits: 240000, mats: { alloy: 2600, electronics: 120, precision: 45, crystal: 60 }, minStation: 'M', legacyBuild: { credits: 22000, mats: { alloy: 320, electronics: 20, precision: 8, crystal: 10 } }, work: 280, power: -34, lines: 1, requires: 'core', tech: 'optical_lasers', unlocks: '집속 광학체 · 레이저 · 플라즈마 · 입자 무장 · 방공 레이저' },
  { kind: 'lab_power', name: '동력·실드 연구소', cat: '연구', desc: '반응로와 실드 기술의 전문 연구소. 고급 동력·방어 연구에 필요하다.', credits: 170000, mats: { alloy: 2000, electronics: 100, crystal: 40 }, minStation: 'M', legacyBuild: { credits: 22000, mats: { alloy: 340, electronics: 16, crystal: 8 } }, work: 300, power: -26, lines: 1, requires: 'core', tech: 'lab_specialization', unlocks: '연구: 동력 · 방어 (고급)', lab: ['power', 'defense'] },
  { kind: 'lab_ballistics', name: '탄도·유도 연구소', cat: '연구', desc: '실탄·유도 무장의 전문 연구소. 고급 레일건·미사일·어뢰 연구에 필요하다.', credits: 150000, mats: { alloy: 2000, weapon_parts: 40, electronics: 80 }, minStation: 'M', legacyBuild: { credits: 22000, mats: { alloy: 360, weapon_parts: 8, electronics: 10 } }, work: 300, power: -24, lines: 1, requires: 'core', tech: 'lab_specialization', unlocks: '연구: 실탄 · 유도 무장 (고급)', lab: ['kinetic', 'missile'] },
  { kind: 'lab_energy', name: '고에너지 물리 연구소', cat: '연구', desc: '레이저·입자·플라즈마의 전문 연구소. 고급 에너지 무장 연구에 필요하다.', credits: 200000, mats: { alloy: 2200, electronics: 120, crystal: 80, precision: 30 }, minStation: 'M', legacyBuild: { credits: 28000, mats: { alloy: 360, electronics: 20, crystal: 16, precision: 6 } }, work: 340, power: -32, lines: 1, requires: 'core', tech: 'lab_specialization', unlocks: '연구: 에너지 무장 (고급)', lab: ['energy'] },
  { kind: 'lab_logistics', name: '군수·물류 연구소', cat: '연구', desc: '보급·물류와 정거장 운영 연구.', credits: 85000, mats: { alloy: 1400, machinery: 70, electronics: 30 }, minStation: 'M', legacyBuild: { credits: 14000, mats: { alloy: 260, machinery: 14, electronics: 6 } }, work: 220, power: -14, lines: 1, requires: 'core', tech: 'lab_specialization', unlocks: '연구: 물류 · 정거장', lab: ['logistics', 'station'] },
];

export const P5_RECIPES: RecipeContent[] = [
  { id: 'munitions', name: '탄약·추진제 생산', fac: 'ammo_plant', time: 120, in: { chemicals: 8, metal: 6 }, out: { munitions: 6 } },
  { id: 'munitions_auto', name: '자동화 탄약 라인', fac: 'ammo_plant', time: 120, in: { chemicals: 8, metal: 6 }, out: { munitions: 8 }, tech: 'munitions_automation' },
  { id: 'optics', name: '집속 광학체 연마', fac: 'energy_fab', time: 240, in: { crystal: 3, precision: 1, silicon: 4 }, out: { optics: 2 } },
  { id: 'optics_lathe', name: '정밀 광학 선반', fac: 'energy_fab', time: 240, in: { crystal: 3, precision: 1, silicon: 4 }, out: { optics: 3 }, tech: 'optics_lathes' },
];

const T = (t: TechContent) => t;
export const P5_TECHS: TechContent[] = [
  // energy (lab_weapons / lab_energy)
  T({ id: 'optical_lasers', name: '광학 레이저', area: 'energy', field: 'energy', time: 2400, credits: 6000, cost: { electronics: 6, crystal: 4 }, desc: '레이저 공진기와 집속 렌즈.', unlocks: '시설: 에너지 무장 공장 · 레시피: 집속 광학체 · 무장: 적색 펄스 레이저' }),
  T({ id: 'blue_lasers', name: '청색 레이저', area: 'energy', field: 'energy', time: 4800, credits: 12000, cost: { electronics: 10, crystal: 8 }, pre: ['optical_lasers'], desc: '단파장 다이오드 배열.', unlocks: '무장: 청색 레이저 (M)' }),
  T({ id: 'uv_lasers', name: '자외선 레이저', area: 'energy', field: 'energy', time: 9000, credits: 24000, cost: { electronics: 16, crystal: 14, optics: 4 }, pre: ['blue_lasers'], needLab: 'lab_energy', desc: '자외선 엑시머 레이저.', unlocks: '무장: 자외선 레이저 (M)' }),
  T({ id: 'xray_lasers', name: 'X선 레이저', area: 'energy', field: 'energy', time: 18000, credits: 50000, cost: { electronics: 30, rare_metal: 12, optics: 10 }, pre: ['uv_lasers'], needLab: 'lab_energy', desc: '자유전자 X선 레이저.', unlocks: '무장: X선 레이저 포 (L)' }),
  T({ id: 'gamma_lasers', name: '감마선 레이저', area: 'energy', field: 'energy', time: 32400, credits: 90000, cost: { electronics: 50, rare_metal: 24, optics: 20, crystal: 20 }, pre: ['xray_lasers', 'compact_fusion'], needLab: 'lab_energy', desc: '핵이성질체 감마선 방출.', unlocks: '무장: 감마선 척추포 (L, 척추·고정)' }),
  T({ id: 'beam_focusing', name: '빔 집속', area: 'energy', field: 'energy', time: 7200, credits: 16000, cost: { optics: 6, electronics: 8 }, pre: ['blue_lasers'], desc: '적응 광학으로 빔 확산을 줄인다.', unlocks: '레이저 사거리 +8%, 피해 +5%', cfx: { family: 'laser', rangeMul: 1.08, dmgMul: 1.05 } }),
  T({ id: 'plasma_containment', name: '플라즈마 봉입', area: 'energy', field: 'energy', time: 7200, credits: 18000, cost: { electronics: 12, chemicals: 20, optics: 2 }, pre: ['optical_lasers'], desc: '자기장 토로이드 탄.', unlocks: '무장: 플라즈마 포 (M)' }),
  T({ id: 'plasma_heavy', name: '중(重) 플라즈마', area: 'energy', field: 'energy', time: 16200, credits: 40000, cost: { electronics: 24, chemicals: 40, rare_metal: 8 }, pre: ['plasma_containment'], needLab: 'lab_energy', desc: '대구경 플라즈마 가속.', unlocks: '무장: 중(重) 플라즈마 포 (L)' }),
  T({ id: 'particle_accel', name: '입자 가속', area: 'energy', field: 'energy', time: 10800, credits: 30000, cost: { electronics: 20, crystal: 16, rare_metal: 6 }, pre: ['blue_lasers'], needLab: 'lab_energy', desc: '소형 선형 가속기.', unlocks: '무장: 입자 가속포 (M)' }),
  // kinetic (lab_weapons / lab_ballistics)
  T({ id: 'coilguns', name: '코일건', area: 'kinetic', field: 'kinetic', time: 1800, credits: 4000, cost: { machinery: 6, electronics: 2 }, desc: '전자기 코일 가속.', unlocks: '무장: 코일건 (S)' }),
  T({ id: 'fast_coils', name: '속사 코일', area: 'kinetic', field: 'kinetic', time: 4800, credits: 10000, cost: { machinery: 10, electronics: 6, precision: 2 }, pre: ['coilguns'], desc: '초전도 급탄 코일.', unlocks: '무장: 속사 코일건 (M)' }),
  T({ id: 'rail_miniaturization', name: '레일건 소형화', area: 'kinetic', field: 'kinetic', time: 12600, credits: 30000, cost: { electronics: 16, rare_metal: 10, precision: 8 }, pre: ['fast_coils'], needLab: 'lab_ballistics', desc: '구축함용 레일.', unlocks: '무장: 중형 레일건 (M)' }),
  T({ id: 'sabot_rounds', name: '날개안정 철갑탄', area: 'kinetic', field: 'kinetic', time: 7200, credits: 14000, cost: { munitions: 20, precision: 4 }, pre: ['coilguns'], desc: '고밀도 관통자.', unlocks: '코일·레일·함포 피해 +8%', cfx: { family: ['coil', 'cannon'], dmgMul: 1.08 } }),
  // missile (lab_weapons / lab_ballistics)
  T({ id: 'missile_fab', name: '미사일 생산 공정', area: 'missile', field: 'missile', time: 2400, credits: 6000, cost: { chemicals: 16, machinery: 6 }, desc: '추진제 혼합과 탄체 조립 라인.', unlocks: '시설: 탄약·미사일 공장 · 레시피: 탄약·추진제' }),
  T({ id: 'torpedo_casting', name: '어뢰 주조', area: 'missile', field: 'missile', time: 3600, credits: 8000, cost: { munitions: 10, electronics: 4 }, pre: ['missile_fab'], desc: '보급형 어뢰 탄체.', unlocks: '무장: 표준 어뢰 (M)' }),
  T({ id: 'fast_missiles', name: '고속 미사일', area: 'missile', field: 'missile', time: 5400, credits: 12000, cost: { munitions: 16, electronics: 8 }, pre: ['missile_fab'], desc: '고추력 소형 미사일.', unlocks: '무장: 고속 미사일 (M)' }),
  T({ id: 'lr_missiles', name: '순항 미사일', area: 'missile', field: 'missile', time: 5400, credits: 12000, cost: { munitions: 16, electronics: 8, sensor: 1 }, pre: ['missile_fab'], desc: '장거리 관성 유도.', unlocks: '무장: 장거리 순항 미사일 (M, VLS)' }),
  T({ id: 'smart_missiles', name: '고급 유도', area: 'missile', field: 'missile', time: 12600, credits: 30000, cost: { electronics: 20, rare_metal: 6, munitions: 20 }, pre: ['fast_missiles', 'lr_missiles'], needLab: 'lab_ballistics', desc: '기만체·장갑 탄체.', unlocks: '무장: 고급 유도 미사일 (M)' }),
  T({ id: 'asm_torpedoes', name: '고급 대함 어뢰', area: 'missile', field: 'missile', time: 16200, credits: 42000, cost: { munitions: 40, rare_metal: 10, electronics: 12 }, pre: ['torpedo_casting', 'smart_missiles'], needLab: 'lab_ballistics', desc: '장갑 탄체 중어뢰.', unlocks: '무장: 고급 대함 어뢰 (L)' }),
  T({ id: 'warheads', name: '성형 탄두', area: 'missile', field: 'missile', time: 7200, credits: 14000, cost: { munitions: 20, chemicals: 20 }, pre: ['missile_fab'], desc: '성형작약 탄두.', unlocks: '미사일·어뢰 피해 +8%', cfx: { family: ['missile', 'torpedo'], dmgMul: 1.08 } }),
  // power
  T({ id: 'compact_fusion', name: '소형 융합로', area: 'power', field: 'power', time: 7200, credits: 18000, cost: { reactor: 1, electronics: 10, composite: 10 }, pre: ['fusion_reactors'], desc: '함내 탑재형 융합 코어.', unlocks: '장비: 소형 융합 코어 (전력 +36)' }),
  T({ id: 'phased_shields', name: '위상 실드', area: 'power', field: 'power', time: 14400, credits: 36000, cost: { electronics: 20, crystal: 16, optics: 4 }, pre: ['deflector_shields', 'compact_fusion'], needLab: 'lab_power', desc: '위상 동조 실드 발생.', unlocks: '장비: 위상 실드 발생기 · 실드 회복 +25%', cfx: { shieldRegenMul: 1.25 } }),
  // defense
  T({ id: 'deflector_shields', name: '편향 실드', area: 'defense', field: 'defense', time: 7200, credits: 18000, cost: { electronics: 12, crystal: 10 }, pre: ['fire_control'], desc: '전자기 편향장.', unlocks: '장비: 편향 실드 발생기' }),
  T({ id: 'shield_harmonics', name: '실드 조화', area: 'defense', field: 'defense', time: 9000, credits: 22000, cost: { electronics: 14, crystal: 10 }, pre: ['deflector_shields'], needLab: 'lab_power', desc: '다층 실드 위상 정렬.', unlocks: '실드 용량 +15%', cfx: { shieldMul: 1.15 } }),
  // electronics
  T({ id: 'pd_lasers', name: '방공 레이저', area: 'electronics', field: 'electronics', time: 5400, credits: 12000, cost: { electronics: 10, optics: 2 }, pre: ['pd_network', 'optical_lasers'], desc: '레이저 근접 방공.', unlocks: '무장: 방공 레이저 (S)' }),
  T({ id: 'targeting_ai', name: '표적 예측 AI', area: 'electronics', field: 'electronics', time: 10800, credits: 26000, cost: { electronics: 24, crystal: 6 }, pre: ['fire_control', 'quantum_computing'], desc: '기동 예측 사격.', unlocks: '전 함선 명중 +5%', cfx: { accMul: 1.05 } }),
  // kinetic PD
  T({ id: 'flak_fuzes', name: '근접 신관', area: 'kinetic', field: 'kinetic', time: 4800, credits: 9000, cost: { munitions: 10, electronics: 4 }, pre: ['missile_fab'], desc: '레이더 근접 신관 파편탄.', unlocks: '무장: 근접 신관 대공포 (S)' }),
  // industry
  T({ id: 'munitions_automation', name: '탄약 자동화', area: 'industry', field: 'industry', time: 5400, credits: 10000, cost: { machinery: 16, electronics: 6 }, pre: ['missile_fab', 'process_control'], desc: '탄약 라인 자동화.', unlocks: '레시피: 자동화 탄약 라인 (탄약 +33%)' }),
  T({ id: 'optics_lathes', name: '정밀 광학 선반', area: 'industry', field: 'industry', time: 7200, credits: 14000, cost: { precision: 8, machinery: 10 }, pre: ['optical_lasers', 'process_control'], desc: '초정밀 연마 선반.', unlocks: '레시피: 정밀 광학 선반 (광학체 +50%)' }),
  // resource
  T({ id: 'crystal_seeding', name: '결정 채굴법', area: 'resource', field: 'resources', time: 5400, credits: 10000, cost: { machinery: 10, electronics: 4 }, pre: ['mining_lasers'], desc: '결정맥 추적 굴착.', unlocks: '채굴 속도 +10%', fx: { mineMul: 1.1 } }),
  // logistics
  T({ id: 'ammo_logistics', name: '탄약 보급 체계', area: 'logistics', field: 'logistics', time: 5400, credits: 12000, cost: { machinery: 8, electronics: 6 }, pre: ['logistics_ai'], desc: '탄약·추진제 소요 관리.', unlocks: '함대 보급품 소모 -20%', fx: { supplyMul: 0.8 } }),
  T({ id: 'fleet_train', name: '함대 지원단', area: 'logistics', field: 'logistics', time: 10800, credits: 24000, cost: { machinery: 16, electronics: 10, structure: 20 }, pre: ['ammo_logistics'], needLab: 'lab_logistics', desc: '보급선단 운용 교리.', unlocks: '함선 유지비 -10%', fx: { upkeepMul: 0.9 } }),
  // station
  T({ id: 'lab_specialization', name: '전문 연구소', area: 'station', field: 'station', time: 3600, credits: 8000, cost: { electronics: 8, machinery: 6 }, pre: ['research_methods'], desc: '분야별 전문 연구 시설 표준.', unlocks: '시설: 동력·실드 / 탄도·유도 / 고에너지 물리 / 군수·물류 연구소' }),
  // hull
  T({ id: 'hull_lattice', name: '격자 골조', area: 'hull', field: 'shipeng', time: 9000, credits: 20000, cost: { structure: 30, composite: 10 }, pre: ['modular_assembly'], desc: '하중 분산 격자 골조.', unlocks: '전 함선 내구 +5%', cfx: { hpMul: 1.05 } }),
  // propulsion
  T({ id: 'ion_drives', name: '이온 기동 추진', area: 'propulsion', field: 'propulsion', time: 7200, credits: 16000, cost: { precision: 6, electronics: 6 }, pre: ['vector_thrust'], desc: '보조 이온 추진기.', unlocks: '전투 속도 +4%', cfx: { speedMul: 1.04 } }),
  // tactics
  T({ id: 'evasive_doctrine', name: '회피 기동 교리', area: 'tactics', field: 'tactics', time: 7200, credits: 14000, cost: { electronics: 6 }, pre: ['fleet_doctrine'], desc: '불규칙 기동 표준.', unlocks: '전 함선 회피 +4%', cfx: { evasion: 0.04 } }),
];

/** research area of the built-in techs (their `field` stays for the lab rules of old saves) */
export const CORE_TECH_AREA: Record<string, string> = {
  process_control: 'industry', refining_2: 'industry', composites: 'industry', lean_production: 'industry',
  microelectronics: 'electronics', quantum_computing: 'station', fire_control: 'electronics', long_sensors: 'electronics', ecm: 'electronics', pd_network: 'electronics',
  research_methods: 'station', station_engineering: 'station', fusion_reactors: 'power', logistics_ai: 'logistics',
  modular_assembly: 'hull', automated_yards: 'hull', frigate_design: 'hull', medium_hulls: 'hull', light_cruiser_design: 'hull', capital_hulls: 'hull', battlecruiser_design: 'hull', battleship_design: 'hull', dreadnought_program: 'hull', reactor_tuning: 'power',
  mining_lasers: 'resource', rare_processing: 'resource', deep_core: 'resource', cargo_compression: 'logistics',
  ship_propulsion: 'propulsion', vector_thrust: 'propulsion', warp_tuning: 'propulsion',
  guided_missiles: 'missile', energy_weapons: 'energy', heavy_ordnance: 'kinetic', railguns: 'kinetic', particle_lance: 'energy',
  reactive_armor: 'defense', damage_control: 'defense',
  fleet_doctrine: 'tactics', combined_arms: 'tactics', salvage_ops: 'tactics',
};
/** family / tier of the built-in weapons (P5 tiers include them) */
export const CORE_WEAPON_META: Record<string, { family: string; tier: number; role: string; vsShield: number }> = {
  autocannon: { family: 'cannon', tier: 1, role: 'anti-small', vsShield: 0.6 },
  medium_gun: { family: 'cannon', tier: 2, role: 'general', vsShield: 0.7 },
  heavy_cannon: { family: 'cannon', tier: 3, role: 'anti-capital', vsShield: 0.7 },
  rail_cannon: { family: 'coil', tier: 4, role: 'anti-capital', vsShield: 0.75 },
  missile_rack: { family: 'missile', tier: 1, role: 'general', vsShield: 0.8 },
  torpedo: { family: 'torpedo', tier: 2, role: 'anti-capital', vsShield: 0.9 },
  pd_gun: { family: 'pd', tier: 1, role: 'pd', vsShield: 0.6 },
  pulse_laser: { family: 'laser', tier: 2, role: 'general', vsShield: 1.25 },
  particle_lance: { family: 'particle', tier: 3, role: 'anti-capital', vsShield: 1.6 },
};

/** energy-capable structures for the small and medium hulls: before P5 only light cruisers and up had
 *  energy hardpoints, so the small lasers had nowhere to go on the ships they are meant for. Each
 *  replaces two kinetic turrets with energy turrets at the same spots (same size and arc) and adds
 *  power conduits (electronics); building or refitting to one needs the laser research. */
const swap = (ids: string[], hp: { id: string; pos: [number, number, number]; facing: number; arc: number; size: 'S' | 'M' }[]) =>
  ({ remove: ids, add: hp.map(h => ({ ...h, type: 'energy' as const, mount: 'turret' as const })) });
export const P5_VARIANTS: VariantDef[] = [
  { id: 'corvette_mk1_laser', hull: 'corvette_mk1', name: '광학 포탑형', desc: '전방 실탄 포탑 2기를 에너지 포탑으로 바꾼 구조. 레이저를 단다. 전력 배선 추가.', blueprint: 'common',
    hardpoints: swap(['hp02', 'hp03'], [{ id: 'e1', pos: [1.9, 0.9, 3], facing: 0, arc: 40, size: 'S' }, { id: 'e2', pos: [-1.9, 0.9, 3], facing: 0, arc: 40, size: 'S' }]),
    parts: { electronics: 2 }, needs: { tech: ['optical_lasers'] } },
  { id: 'frigate_mk1_laser', hull: 'frigate_mk1', name: '광학 포탑형', desc: '함수 실탄 포탑 2기를 에너지 포탑으로 바꾼 구조. 전력 배선 추가.', blueprint: 'common',
    hardpoints: swap(['hp01', 'hp02'], [{ id: 'e1', pos: [1.6, 1.4, 5], facing: 0, arc: 60, size: 'S' }, { id: 'e2', pos: [-1.6, 1.4, 5], facing: 0, arc: 60, size: 'S' }]),
    parts: { electronics: 3 }, needs: { tech: ['optical_lasers'] } },
  { id: 'destroyer_mk1_laser', hull: 'destroyer_mk1', name: '광학 포탑형', desc: '전·후방 중형 포탑을 에너지 포탑으로 바꾼 구조. 청색 레이저·플라즈마를 단다. 전력 배선 추가.', blueprint: 'common',
    hardpoints: swap(['hp01', 'hp08'], [{ id: 'e1', pos: [0, 3, 7], facing: 0, arc: 150, size: 'M' }, { id: 'e2', pos: [0, 3, -7], facing: 180, arc: 150, size: 'M' }]),
    parts: { electronics: 6 }, needs: { tech: ['optical_lasers'] } },
];

export const P5_PRESETS: PresetDef[] = [
  { id: 'cv_laser', hull: 'corvette_mk1', variant: 'corvette_mk1_laser', name: '광학 강습', desc: '적색 레이저 2 + 기관포 2 + 방공 1.', weapons: { e1: 'eq_laser_red', e2: 'eq_laser_red', hp05: 'eq_autocannon', hp06: 'eq_autocannon', hp04: 'eq_pd_gun' } },
  { id: 'ff_laser', hull: 'frigate_mk1', variant: 'frigate_mk1_laser', name: '광학 호위', desc: '적색 레이저 2 + 방공 4.', weapons: { e1: 'eq_laser_red', e2: 'eq_laser_red', hp04: 'eq_pd_gun', hp05: 'eq_pd_gun', hp08: 'eq_pd_gun', hp09: 'eq_pd_gun' } },
  { id: 'dd_laser', hull: 'destroyer_mk1', variant: 'destroyer_mk1_laser', name: '광학 포열', desc: '청색 레이저 2 + 방공 4.', weapons: { e1: 'eq_laser_blue', e2: 'eq_laser_blue', hp02: 'eq_pd_gun', hp03: 'eq_pd_gun', hp04: 'eq_pd_gun', hp05: 'eq_pd_gun' } },
];
