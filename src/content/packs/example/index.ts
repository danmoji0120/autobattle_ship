// Example content pack (P7 stage 5) — the smallest complete P5 addition, kept as a working reference
// for docs/CODEX_CONTENT_GUIDE.md §13. One research project unlocks one weapon that is made in an
// existing facility from existing goods. Growth-only (minContentV 3): legacy worlds never see it.
//
// Copy this folder to start a new pack: rename the ids, keep the shape, run `npm run content:check`.
import type { ContentPack, ArmContent, TechContent } from '../../schema';

const ARMS: ArmContent[] = [{
  id: 'eq_laser_twin', name: '쌍열 펄스 레이저', family: 'laser', tier: 2, role: 'anti-small', size: 'S',
  mass: 4, power: 8, mounts: ['turret'], tech: 'twin_emitters',
  desc: '적색 레이저 두 문을 한 포탑에 묶은 소형 방공·대소형함 무장. 적색보다 사거리와 관통이 조금 낫지만, 연사가 약간 느리고 전력을 더 쓴다. 대형함 장갑은 여전히 못 뚫는다.',
  combat: { kind: 'shell', damage: 16, pen: 16, range: 720, speed: 4000, reload: 0.7, salvo: 2, salvoGap: 0.05, spread: 0.004, turnSpeed: 140, caliber: 0.6, vsShield: 1.2, sound: 'auto' },
  vis: { color: '#ff8a3c', len: 32, wid: 0.55, beam: true },
  recipe: { fac: 'energy_fab', time: 480, in: { optics: 1, electronics: 2, weapon_parts: 1 } },
}];

const TECHS: TechContent[] = [{
  id: 'twin_emitters', name: '쌍열 방출기', area: 'energy', field: 'energy', time: 3000, credits: 8000,
  cost: { electronics: 8, crystal: 4 }, pre: ['optical_lasers'],
  desc: '레이저 공진기 두 개를 한 냉각계에 묶는다.', unlocks: '무장: 쌍열 펄스 레이저 (S, 포탑)',
}];

export const EXAMPLE_PACK: ContentPack = {
  id: 'example', name: '예제 팩 — 쌍열 펄스 레이저', minContentV: 3,
  arms: ARMS, techs: TECHS,
};
