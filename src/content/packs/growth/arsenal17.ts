// P17.3 special arsenal: 25 weapons on 10 mechanisms (sim/mech17.ts) plus mass-production rows, and the
// research that unlocks them. Each special weapon does something physically different in the battle —
// a container that opens into 20 real child missiles, decoys, time-on-target salvos, charged shots, arcs,
// proximity-fused plasma, area flak, mines, held beams, two-stage missiles — and is drawn as such
// (render/mech17Fx.ts). docs/P17_3_ARSENAL.md.
//
// Budget (validateArsenal): the combat index counts what a salvo really delivers — a container's children,
// a beam's pulses — so a special weapon is measured against the same ceiling as the old ones. Each has a
// weakness that comes from the mechanism itself (a container shot down early releases nothing; a charge is
// lost with the target; a beam needs the turret to keep up; mines must be crossed; bursts hit friends' foes
// only within metres; flak needs rounds close together).
import type { ArmContent, TechContent } from '../../schema';

const W = (a: ArmContent) => a;
const MIS = { fac: 'ammo_plant' } as const, NRG = { fac: 'energy_fab' } as const, KIN = { fac: 'weapons_factory' } as const;

export const P17_ARMS: ArmContent[] = [
  // ── container missiles (split): the mother opens into real child munitions
  W({ id: 'eq_swarm_box', name: '군집 컨테이너 미사일', family: 'missile', tier: 3, role: 'general', size: 'M', mass: 14, power: 4, mounts: ['vls'], tech: 'container_missiles',
    desc: '장갑 컨테이너 모탄이 표적 520m 앞에서 열려 자탄 20발을 뿌린다. 자탄 하나하나가 따로 유도되고 방공포에 따로 격추된다. 개방 전에 모탄이 격추되면 자탄은 나오지 않는다. 대형함 장갑에는 자탄이 약하다.',
    combat: { kind: 'missile', damage: 120, pen: 50, range: 2000, speed: 260, reload: 26, salvo: 1, salvoGap: 0, spread: 0.1, turnSpeed: 360, caliber: 1.4, guidedTurn: 1.0, munitionHp: 3, magazine: 4, vsShield: 0.8, sound: 'missile',
      mech: { split: { n: 20, child: 'swarm_dart', at: 520, cone: 0.32, radius: 450 } } },
    vis: { color: '#ffb46a', len: 0, wid: 1.2 }, recipe: { ...MIS, time: 2400, in: { weapon_parts: 6, electronics: 8, munitions: 30, rare_metal: 2 } }, supply: { chemicals: 1.2 } }),
  W({ id: 'eq_swarm_lite', name: '경량 확산 미사일', family: 'missile', tier: 2, role: 'anti-small', size: 'M', mass: 10, power: 2, mounts: ['vls', 'turret'], tech: 'container_missiles',
    desc: '양산형 확산탄. 표적 380m 앞에서 자탄 8발로 갈라진다. 싸고 탄창이 넉넉하지만 자탄이 가볍다. 초계함·미사일 정찰함 사냥용.',
    combat: { kind: 'missile', damage: 60, pen: 40, range: 1500, speed: 320, reload: 15, salvo: 1, salvoGap: 0, spread: 0.12, turnSpeed: 360, caliber: 1, guidedTurn: 1.6, munitionHp: 1, magazine: 7, vsShield: 0.8, sound: 'missile',
      mech: { split: { n: 8, child: 'cluster_dart', at: 380, cone: 0.28, radius: 300 } } },
    vis: { color: '#ffc890', len: 0, wid: 0.8 }, recipe: { ...MIS, time: 1100, in: { weapon_parts: 3, electronics: 3, munitions: 14 } }, supply: { chemicals: 0.7 } }),
  W({ id: 'eq_swarm_heavy', name: '중(重) 관통 컨테이너', family: 'missile', tier: 4, role: 'anti-capital', size: 'M', mass: 16, power: 6, mounts: ['vls'], tech: 'container_missiles',
    desc: '관통 자탄 12발을 품은 대함 컨테이너. 자탄 탄두가 무거워 순양함 이상 장갑을 뚫지만, 모탄이 느리고 탄창이 2회뿐이다.',
    combat: { kind: 'missile', damage: 160, pen: 60, range: 1800, speed: 220, reload: 34, salvo: 1, salvoGap: 0, spread: 0.1, turnSpeed: 360, caliber: 1.6, guidedTurn: 0.8, munitionHp: 4, magazine: 2, vsShield: 0.85, sound: 'missile',
      mech: { split: { n: 12, child: 'swarm_lance', at: 600, cone: 0.22, radius: 260 } } },
    vis: { color: '#ff9a5a', len: 0, wid: 1.4 }, recipe: { ...MIS, time: 3000, in: { weapon_parts: 8, electronics: 8, munitions: 34, rare_metal: 6 } }, supply: { chemicals: 1.4 } }),
  // ── two-stage
  W({ id: 'eq_missile_2stage', name: '2단 돌입 미사일', family: 'missile', tier: 3, role: 'general', size: 'M', mass: 12, power: 4, mounts: ['vls'], tech: 'staged_missiles',
    desc: '느린 1단으로 순항하다가 표적 600m 앞에서 부스터를 떼고 2단으로 돌입한다. 순항 중에는 쉬운 표적이지만 돌입 단계는 방공포가 잘 못 쫓는다.',
    combat: { kind: 'missile', damage: 150, pen: 64, range: 2100, speed: 540, reload: 15, salvo: 3, salvoGap: 0.3, spread: 0.12, turnSpeed: 360, caliber: 1.1, guidedTurn: 1.4, munitionHp: 1, magazine: 6, vsShield: 0.8, sound: 'missile',
      mech: { stage: { at: 600, cruise: 0.42, turn: 1.6 } } },
    vis: { color: '#ffd870', len: 0, wid: 0.9 }, recipe: { ...MIS, time: 1500, in: { weapon_parts: 4, electronics: 4, munitions: 14 } }, supply: { chemicals: 0.9 } }),
  W({ id: 'eq_torp_2stage', name: '2단 돌입 어뢰', family: 'torpedo', tier: 4, role: 'anti-capital', size: 'L', mass: 22, power: 4, mounts: ['fixed', 'vls'], tech: 'staged_missiles',
    desc: '저속 순항 후 500m 앞에서 2단 고속 돌입하는 대함 어뢰. 고급 대함 어뢰보다 탄두가 작지만 더 멀리서 쏘고 막기 어렵다. 탄약 제한 3회.',
    combat: { kind: 'torpedo', damage: 1100, pen: 110, range: 1300, speed: 420, reload: 26, salvo: 2, salvoGap: 0.5, spread: 0.05, turnSpeed: 360, caliber: 2, guidedTurn: 0.8, munitionHp: 2, vsShield: 0.9, sound: 'torpedo', p15: { magazine: 3 },
      mech: { stage: { at: 500, cruise: 0.48, turn: 1.4 } } },
    recipe: { ...MIS, time: 2700, in: { weapon_parts: 6, munitions: 26, electronics: 5, rare_metal: 4 } }, supply: { chemicals: 1.2 } }),
  // ── decoys
  W({ id: 'eq_missile_decoy', name: '기만 유도탄', family: 'missile', tier: 3, role: 'general', size: 'M', mass: 12, power: 4, mounts: ['vls', 'turret'], tech: 'decoy_seekers',
    desc: '표적 700m 앞에서 똑같이 나는 기만체 3개를 뿌린다. 방공포는 진짜를 가릴 수 없어 사격을 나눠 쓴다. 기만체에는 탄두가 없다.',
    combat: { kind: 'missile', damage: 140, pen: 60, range: 1900, speed: 320, reload: 16, salvo: 3, salvoGap: 0.3, spread: 0.12, turnSpeed: 360, caliber: 1.1, guidedTurn: 1.8, munitionHp: 1, magazine: 5, vsShield: 0.8, sound: 'missile',
      mech: { decoy: { n: 3, at: 700, life: 4 } } },
    vis: { color: '#ffa860', len: 0, wid: 0.8 }, recipe: { ...MIS, time: 1500, in: { weapon_parts: 3, electronics: 5, munitions: 12 } }, supply: { chemicals: 0.8 } }),
  W({ id: 'eq_missile_ghost', name: '유령 군집 미사일', family: 'missile', tier: 2, role: 'general', size: 'M', mass: 10, power: 3, mounts: ['vls'], tech: 'decoy_seekers',
    desc: '탄두를 줄이고 기만체 6개를 실은 양산형. 혼자서는 약하지만 다른 미사일 일제사와 함께 방공망을 포화시킨다.',
    combat: { kind: 'missile', damage: 70, pen: 44, range: 1700, speed: 340, reload: 14, salvo: 2, salvoGap: 0.3, spread: 0.12, turnSpeed: 360, caliber: 0.9, guidedTurn: 1.8, munitionHp: 1, magazine: 6, vsShield: 0.8, sound: 'missile',
      mech: { decoy: { n: 6, at: 800, life: 4.5 } } },
    vis: { color: '#e0a8ff', len: 0, wid: 0.7 }, recipe: { ...MIS, time: 1000, in: { weapon_parts: 2, electronics: 4, munitions: 10 } }, supply: { chemicals: 0.6 } }),
  // ── time on target
  W({ id: 'eq_missile_tot', name: '동시 탄착 미사일', family: 'missile', tier: 3, role: 'general', size: 'M', mass: 13, power: 5, mounts: ['vls'], tech: 'tot_fire_control',
    desc: '6발이 서로 다른 방위로 부채꼴로 퍼졌다가 속도를 맞춰 한 순간에 탄착한다. 방공포가 한 발씩 상대할 시간이 없다.',
    combat: { kind: 'missile', damage: 110, pen: 58, range: 2000, speed: 360, reload: 22, salvo: 6, salvoGap: 0.35, spread: 0.1, turnSpeed: 360, caliber: 1, guidedTurn: 2.0, munitionHp: 1, magazine: 4, vsShield: 0.8, sound: 'missile',
      mech: { tot: { slack: 1.6, fan: 70 } } },
    vis: { color: '#ffe0a0', len: 0, wid: 0.8 }, recipe: { ...MIS, time: 1800, in: { weapon_parts: 4, electronics: 6, munitions: 16 } }, supply: { chemicals: 1 } }),
  W({ id: 'eq_cruise_tot', name: '동시 탄착 순항탄', family: 'missile', tier: 2, role: 'general', size: 'M', mass: 12, power: 3, mounts: ['vls'], tech: 'tot_fire_control',
    desc: '느린 순항탄 4발을 동시에 도착시키는 장거리 양산형. 사거리가 길지만 탄착까지 오래 걸린다.',
    combat: { kind: 'missile', damage: 130, pen: 58, range: 2600, speed: 240, reload: 22, salvo: 4, salvoGap: 0.4, spread: 0.15, turnSpeed: 360, caliber: 1.1, guidedTurn: 1.2, munitionHp: 1, magazine: 5, vsShield: 0.8, sound: 'missile',
      mech: { tot: { slack: 2.5, fan: 55 } } },
    vis: { color: '#ffd0a0', len: 0, wid: 0.8 }, recipe: { ...MIS, time: 1300, in: { weapon_parts: 3, electronics: 3, munitions: 14 } }, supply: { chemicals: 0.8 } }),
  // ── mines
  W({ id: 'eq_mine_layer', name: '근접 기뢰 투하기', family: 'missile', tier: 2, role: 'general', size: 'M', mass: 11, power: 2, mounts: ['vls', 'fixed'], tech: 'mine_laying',
    desc: '적 진로 앞에 기뢰 4발을 깔아 둔다. 2초 뒤 무장해 40초 동안 기다리다 45m 안에 들어온 적함 근처에서 터진다. 방공포로 치울 수 있다.',
    combat: { kind: 'missile', damage: 260, pen: 70, range: 900, speed: 340, reload: 18, salvo: 4, salvoGap: 0.4, spread: 0.1, turnSpeed: 360, caliber: 1, guidedTurn: 1, munitionHp: 1, magazine: 5, vsShield: 0.9, sound: 'missile',
      mech: { mine: { arm: 2, trigger: 45, radius: 70, life: 40 } } },
    vis: { color: '#ff5050', len: 0, wid: 1 }, recipe: { ...MIS, time: 900, in: { weapon_parts: 2, electronics: 2, munitions: 14 } }, supply: { chemicals: 0.6 } }),
  W({ id: 'eq_mine_heavy', name: '대형 함정 기뢰', family: 'missile', tier: 3, role: 'anti-capital', size: 'M', mass: 14, power: 3, mounts: ['vls', 'fixed'], tech: 'mine_laying',
    desc: '무거운 대함 기뢰 2발. 60m 안의 대형함 측면을 뚫는다. 장갑 탄체라 방공포로 치우기 어렵지만 탄창이 3회뿐이다.',
    combat: { kind: 'missile', damage: 700, pen: 100, range: 800, speed: 280, reload: 30, salvo: 2, salvoGap: 0.6, spread: 0.1, turnSpeed: 360, caliber: 1.5, guidedTurn: 1, munitionHp: 2, magazine: 3, vsShield: 0.9, sound: 'torpedo',
      mech: { mine: { arm: 3, trigger: 60, radius: 90, life: 60 } } },
    vis: { color: '#ff3030', len: 0, wid: 1.4 }, recipe: { ...MIS, time: 2000, in: { weapon_parts: 4, electronics: 3, munitions: 24, rare_metal: 3 } }, supply: { chemicals: 0.9 } }),
  // ── charged shots
  W({ id: 'eq_charge_lance', name: '축전 랜스', family: 'laser', tier: 4, role: 'anti-capital', size: 'L', mass: 26, power: 40, mounts: ['turret', 'fixed', 'spinal'], tech: 'charge_capacitors',
    desc: '표적을 잡은 채 2.2초 축전한 뒤 한 발에 쏟아붓는 대형 레이저. 축전 중에 표적을 놓치면 처음부터 다시 모은다. 축전 빛이 포구에 보인다.',
    combat: { kind: 'shell', damage: 520, pen: 100, range: 1700, speed: 6000, reload: 9, salvo: 1, salvoGap: 0, spread: 0.0018, turnSpeed: 20, caliber: 2.4, vsShield: 1.3, sound: 'rail',
      mech: { charge: { time: 2.2 } } },
    vis: { color: '#9ad8ff', len: 120, wid: 2.4, beam: true }, recipe: { ...NRG, time: 3000, in: { optics: 8, electronics: 10, weapon_parts: 6, crystal: 6, rare_metal: 4 } } }),
  W({ id: 'eq_charge_m', name: '축전 펄스포', family: 'laser', tier: 3, role: 'general', size: 'M', mass: 11, power: 20, mounts: ['turret', 'fixed'], tech: 'charge_capacitors',
    desc: '1.2초 축전 후 강한 펄스 한 발. 같은 크기 레이저보다 한 발이 무겁지만 소형함을 쫓기엔 느리다.',
    combat: { kind: 'shell', damage: 180, pen: 60, range: 1200, speed: 5000, reload: 4.5, salvo: 1, salvoGap: 0, spread: 0.0028, turnSpeed: 48, caliber: 1.4, vsShield: 1.25, sound: 'rail',
      mech: { charge: { time: 1.2 } } },
    vis: { color: '#b0e8ff', len: 70, wid: 1.4, beam: true }, recipe: { ...NRG, time: 1500, in: { optics: 3, electronics: 5, weapon_parts: 3, crystal: 2 } } }),
  // ── sustained beams
  W({ id: 'eq_beam_cutter', name: '지속 절단 빔', family: 'laser', tier: 3, role: 'general', size: 'M', mass: 10, power: 22, mounts: ['turret'], tech: 'beam_sustain',
    desc: '2.5초 동안 빔을 붙잡고 0.25초마다 태운다. 포탑이 표적을 따라가는 동안만 맞는다 — 느리게 움직이는 표적에 강하고 빠른 소형함에는 빗나간다.',
    combat: { kind: 'shell', damage: 28, pen: 46, range: 900, speed: 5000, reload: 6, salvo: 1, salvoGap: 0, spread: 0.004, turnSpeed: 50, caliber: 1.1, vsShield: 1.3, sound: 'medium',
      mech: { sustain: { time: 2.5, tick: 0.25 } } },
    vis: { color: '#ff70d0', len: 60, wid: 1.2, beam: true }, recipe: { ...NRG, time: 1400, in: { optics: 3, electronics: 4, weapon_parts: 2 } } }),
  W({ id: 'eq_beam_s', name: '소형 절단 빔', family: 'laser', tier: 2, role: 'anti-small', size: 'S', mass: 4, power: 7, mounts: ['turret'], tech: 'beam_sustain',
    desc: '소형 지속 빔. 1.5초 동안 빠른 포탑으로 소형함을 따라 태운다.',
    combat: { kind: 'shell', damage: 7, pen: 18, range: 600, speed: 5000, reload: 3, salvo: 1, salvoGap: 0, spread: 0.005, turnSpeed: 140, caliber: 0.6, vsShield: 1.2, sound: 'auto',
      mech: { sustain: { time: 1.5, tick: 0.25 } } },
    vis: { color: '#ff90e0', len: 40, wid: 0.6, beam: true }, recipe: { ...NRG, time: 500, in: { optics: 1, electronics: 2, weapon_parts: 1 } } }),
  W({ id: 'eq_beam_l', name: '대형 지속 빔', family: 'laser', tier: 5, role: 'anti-capital', size: 'L', mass: 30, power: 55, mounts: ['turret', 'spinal'], tech: 'beam_sustain',
    desc: '4초 동안 굵은 빔을 유지해 대형함 장갑을 녹인다. 포탑이 느려 소형함은 거의 못 맞히고, 반응로를 크게 쓴다.',
    combat: { kind: 'shell', damage: 46, pen: 95, range: 1500, speed: 6000, reload: 12, salvo: 1, salvoGap: 0, spread: 0.002, turnSpeed: 18, caliber: 2.6, vsShield: 1.35, sound: 'rail',
      mech: { sustain: { time: 4, tick: 0.25 } } },
    vis: { color: '#ff60c0', len: 120, wid: 2.6, beam: true }, recipe: { ...NRG, time: 3600, in: { optics: 12, electronics: 12, weapon_parts: 6, crystal: 8, rare_metal: 6 } } }),
  // ── chain arcs
  W({ id: 'eq_arc_projector', name: '연쇄 아크 투사기', family: 'particle', tier: 3, role: 'general', size: 'M', mass: 12, power: 24, mounts: ['turret'], tech: 'arc_projectors',
    desc: '맞은 함선에서 260m 안의 다른 적함으로 방전이 최대 3번 튄다(한 번 튈 때마다 60%). 밀집한 편대에 강하고 흩어진 적에는 한 발짜리다.',
    combat: { kind: 'shell', damage: 120, pen: 55, range: 800, speed: 3000, reload: 4, salvo: 1, salvoGap: 0, spread: 0.005, turnSpeed: 45, caliber: 1.3, vsShield: 1.5, sound: 'rail',
      mech: { chain: { n: 3, radius: 260, falloff: 0.6 } } },
    vis: { color: '#a0b8ff', len: 50, wid: 1.2, beam: true }, recipe: { ...NRG, time: 1800, in: { optics: 2, electronics: 8, weapon_parts: 3, crystal: 5 } } }),
  W({ id: 'eq_arc_s', name: '소형 아크 방출기', family: 'particle', tier: 2, role: 'anti-small', size: 'S', mass: 5, power: 9, mounts: ['turret'], tech: 'arc_projectors',
    desc: '근거리 아크. 180m 안의 적함 2척까지 튄다. 소형함 무리 상대용.',
    combat: { kind: 'shell', damage: 30, pen: 24, range: 520, speed: 3000, reload: 1.6, salvo: 1, salvoGap: 0, spread: 0.008, turnSpeed: 120, caliber: 0.6, vsShield: 1.4, sound: 'auto',
      mech: { chain: { n: 2, radius: 180, falloff: 0.5 } } },
    vis: { color: '#b8c8ff', len: 30, wid: 0.6, beam: true }, recipe: { ...NRG, time: 600, in: { optics: 1, electronics: 3, weapon_parts: 1, crystal: 1 } } }),
  // ── plasma bursts
  W({ id: 'eq_plasma_burst', name: '플라즈마 폭렬포', family: 'plasma', tier: 3, role: 'general', size: 'M', mass: 12, power: 20, mounts: ['turret', 'fixed'], tech: 'plasma_bursts',
    desc: '근접 신관 플라즈마탄. 선체 18m 안을 지나기만 해도 터져 반경 55m를 태운다. 빗나가도 사거리 끝에서 터진다. 탄속이 느리다.',
    combat: { kind: 'shell', damage: 150, pen: 66, range: 700, speed: 520, reload: 3.6, salvo: 1, salvoGap: 0, spread: 0.016, turnSpeed: 50, caliber: 1.6, vsShield: 0.55, sound: 'medium',
      mech: { burst: { radius: 55, fuse: 18 } } },
    vis: { color: '#70ffd8', len: 10, wid: 2.2 }, recipe: { ...NRG, time: 1500, in: { optics: 2, electronics: 4, weapon_parts: 3, chemicals: 14 } } }),
  W({ id: 'eq_plasma_burst_l', name: '대형 플라즈마 폭렬포', family: 'plasma', tier: 4, role: 'anti-capital', size: 'L', mass: 28, power: 34, mounts: ['turret', 'fixed'], tech: 'plasma_bursts',
    desc: '반경 90m의 플라즈마 구체. 대형함 근접전과 밀집 편대에 치명적이지만 사거리가 짧고 실드에 흩어진다.',
    combat: { kind: 'shell', damage: 380, pen: 98, range: 900, speed: 480, reload: 8, salvo: 1, salvoGap: 0, spread: 0.012, turnSpeed: 22, caliber: 2.8, vsShield: 0.5, sound: 'heavy',
      mech: { burst: { radius: 90, fuse: 28 } } },
    vis: { color: '#50ffc8', len: 14, wid: 3.2 }, recipe: { ...NRG, time: 3000, in: { optics: 4, electronics: 6, weapon_parts: 8, chemicals: 24, rare_metal: 4 } } }),
  // ── proximity flak (point defence)
  W({ id: 'eq_flak_prox', name: '근접 신관 탄막포', family: 'pd', tier: 3, role: 'pd', size: 'S', mass: 5, power: 4, tech: 'proximity_flak',
    desc: '조준한 탄체 옆에서 터지는 탄막. 반경 40m 안의 다른 미사일·자탄까지 함께 잡을 수 있다(각 35%). 군집 자탄과 밀집 일제사의 천적. 단발 요격률은 평범하다.',
    combat: { kind: 'pd', damage: 6, pen: 10, range: 380, speed: 0, reload: 0.5, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 300, caliber: 0.6, pdChance: 0.1, vsShield: 0.7, sound: 'pd',
      mech: { flak: { radius: 40, p: 0.35 } } },
    recipe: { ...MIS, time: 700, in: { weapon_parts: 1, munitions: 8, electronics: 2 } }, supply: { metal: 0.4, chemicals: 0.3 } }),
  W({ id: 'eq_flak_heavy', name: '중(重) 탄막 포대', family: 'pd', tier: 4, role: 'pd', size: 'S', mass: 7, power: 7, tech: 'proximity_flak',
    desc: '느리지만 반경 70m를 덮는 대형 탄막. 자탄 무리를 한 번에 걷어 내지만 단발 표적에는 낭비가 크다.',
    combat: { kind: 'pd', damage: 8, pen: 12, range: 520, speed: 0, reload: 0.9, salvo: 1, salvoGap: 0, spread: 0, turnSpeed: 160, caliber: 0.8, pdChance: 0.08, vsShield: 0.7, sound: 'pd',
      mech: { flak: { radius: 70, p: 0.4 } } },
    recipe: { ...MIS, time: 1000, in: { weapon_parts: 2, munitions: 12, electronics: 2 } }, supply: { metal: 0.6, chemicals: 0.4 } }),
  // ── mass-production rows (no special mechanism)
  W({ id: 'eq_autocannon_40', name: '양산 40mm 기관포', family: 'coil', tier: 1, role: 'anti-small', size: 'S', mass: 4, power: 2, mounts: ['turret'], tech: 'coilguns',
    desc: '조선소 표준 양산 기관포. 싸고 어디에나 붙는다. 코일건보다 사거리가 짧고 탄이 흩어진다.',
    combat: { kind: 'shell', damage: 16, pen: 18, range: 580, speed: 1100, reload: 0.4, salvo: 1, salvoGap: 0, spread: 0.024, turnSpeed: 180, caliber: 0.6, vsShield: 0.7, sound: 'auto' },
    vis: { color: '#ffd080', len: 14, wid: 0.45 }, recipe: { ...KIN, time: 240, in: { weapon_parts: 1, alloy: 6, munitions: 3 } }, supply: { metal: 0.3, chemicals: 0.1 } }),
  W({ id: 'eq_howitzer_l', name: '장포신 곡사 주포', family: 'cannon', tier: 2, role: 'general', size: 'L', mass: 24, power: 12, mounts: ['turret'], tech: 'sabot_rounds',
    desc: '사거리 1900m의 양산 장포신포. 탄이 느리고 흩어져 먼 거리에서는 대형함만 맞힌다. 반응로를 적게 쓴다.',
    combat: { kind: 'shell', damage: 300, pen: 80, range: 1900, speed: 520, reload: 10, salvo: 2, salvoGap: 0.2, spread: 0.011, turnSpeed: 16, caliber: 2.6, vsShield: 0.7, sound: 'heavy' },
    vis: { color: '#ffc070', len: 36, wid: 2 }, recipe: { ...KIN, time: 1500, in: { weapon_parts: 5, alloy: 30, munitions: 12 } }, supply: { metal: 0.8, chemicals: 0.4 } }),
  W({ id: 'eq_coil_l', name: '대구경 코일포', family: 'coil', tier: 4, role: 'anti-capital', size: 'L', mass: 26, power: 24, mounts: ['turret', 'fixed'], tech: 'rail_miniaturization',
    desc: '중형 레일건을 키운 대형 코일포. 관통이 높고 연사가 느리며 포탑 선회가 느리다.',
    combat: { kind: 'shell', damage: 340, pen: 105, range: 1600, speed: 1500, reload: 8, salvo: 1, salvoGap: 0, spread: 0.0045, turnSpeed: 20, caliber: 2.2, vsShield: 0.75, sound: 'rail' },
    vis: { color: '#a8e8ff', len: 100, wid: 1.6 }, recipe: { ...KIN, time: 2400, in: { weapon_parts: 8, electronics: 5, rare_metal: 6, precision: 3 } }, supply: { metal: 0.5 } }),
];

const T = (t: TechContent) => t;
export const P17_TECHS: TechContent[] = [
  T({ id: 'container_missiles', name: '컨테이너 자탄', area: 'missile', field: 'missile', time: 14400, credits: 36000, cost: { electronics: 22, munitions: 30, rare_metal: 6 }, pre: ['smart_missiles'], needLab: 'lab_ballistics', desc: '모탄이 표적 앞에서 열리며 독립 유도 자탄을 뿌린다.', unlocks: '무장: 군집 컨테이너 미사일 · 경량 확산 미사일 · 중(重) 관통 컨테이너' }),
  T({ id: 'staged_missiles', name: '2단 추진', area: 'missile', field: 'missile', time: 9000, credits: 22000, cost: { electronics: 12, munitions: 20 }, pre: ['fast_missiles'], desc: '순항 1단과 돌입 2단.', unlocks: '무장: 2단 돌입 미사일 · 2단 돌입 어뢰' }),
  T({ id: 'decoy_seekers', name: '기만체 사출', area: 'missile', field: 'missile', time: 9000, credits: 22000, cost: { electronics: 16, munitions: 12 }, pre: ['smart_missiles'], desc: '탄과 똑같이 나는 기만체.', unlocks: '무장: 기만 유도탄 · 유령 군집 미사일' }),
  T({ id: 'tot_fire_control', name: '동시 탄착 사격통제', area: 'missile', field: 'missile', time: 10800, credits: 26000, cost: { electronics: 20, precision: 4 }, pre: ['lr_missiles', 'targeting_ai'], desc: '일제사의 탄착 시각을 맞춘다.', unlocks: '무장: 동시 탄착 미사일 · 동시 탄착 순항탄' }),
  T({ id: 'mine_laying', name: '기뢰 부설', area: 'missile', field: 'missile', time: 6000, credits: 14000, cost: { munitions: 16, electronics: 6 }, pre: ['missile_fab'], desc: '근접 신관 우주 기뢰.', unlocks: '무장: 근접 기뢰 투하기 · 대형 함정 기뢰' }),
  T({ id: 'charge_capacitors', name: '축전 방출', area: 'energy', field: 'energy', time: 12600, credits: 30000, cost: { electronics: 20, crystal: 12, optics: 6 }, pre: ['uv_lasers'], needLab: 'lab_energy', desc: '축전지에 모은 에너지를 한 발에 방출.', unlocks: '무장: 축전 펄스포 (M) · 축전 랜스 (L)' }),
  T({ id: 'beam_sustain', name: '지속 빔', area: 'energy', field: 'energy', time: 10800, credits: 26000, cost: { electronics: 16, optics: 8, crystal: 6 }, pre: ['beam_focusing'], desc: '빔을 수 초간 유지하는 냉각 공진기.', unlocks: '무장: 소형·지속 절단 빔 · 대형 지속 빔' }),
  T({ id: 'arc_projectors', name: '아크 투사', area: 'energy', field: 'energy', time: 12600, credits: 30000, cost: { electronics: 24, crystal: 12 }, pre: ['particle_accel'], needLab: 'lab_energy', desc: '이온화 경로를 따라 튀는 방전.', unlocks: '무장: 소형 아크 방출기 · 연쇄 아크 투사기' }),
  T({ id: 'plasma_bursts', name: '플라즈마 폭렬 신관', area: 'energy', field: 'energy', time: 10800, credits: 28000, cost: { electronics: 16, chemicals: 30, optics: 2 }, pre: ['plasma_containment'], desc: '근접 신관으로 봉입을 푸는 플라즈마탄.', unlocks: '무장: 플라즈마 폭렬포 · 대형 플라즈마 폭렬포' }),
  T({ id: 'proximity_flak', name: '근접 탄막', area: 'kinetic', field: 'kinetic', time: 7200, credits: 16000, cost: { munitions: 16, electronics: 8 }, pre: ['flak_fuzes'], desc: '표적 옆에서 터져 주변 탄체까지 잡는 탄막.', unlocks: '무장: 근접 신관 탄막포 · 중(重) 탄막 포대' }),
];

/** public stations that stock some P17.3 weapons on NEW growth worlds (world/industrialGear.ts stockParts17).
 *  Mass-production rows and a few entry mechanisms are buyable; the elite mechanisms (full container swarm,
 *  heavy swarm, charge lance, large beam, heavy mines, ghost decoys) are research + own production only. */
export const P17_ARM_MARKETS: Record<string, string[]> = {
  astra: ['eq_autocannon_40', 'eq_flak_prox', 'eq_swarm_lite'],
  bastion: ['eq_howitzer_l', 'eq_flak_prox', 'eq_missile_2stage'],
  helios: ['eq_coil_l', 'eq_beam_s', 'eq_missile_decoy'],
  drakeout: ['eq_autocannon_40', 'eq_mine_layer'],
  cinderco: ['eq_plasma_burst', 'eq_arc_s'],
};
