// P16.1 prototype fixtures: a test carrier hull and test strike-craft weapons, registered into the battle
// tables only by the tests and the performance harness that import this module. The game (client, server,
// content packs) never imports it — the real carrier content, fitting rules and UI are P16.2+.
import { SHIP_CLASSES, type MountDef, type ShipClassDef } from '../../src/sim/data/ships';
import { WEAPONS, type WeaponDef, type CraftStats } from '../../src/sim/data/weapons';
import type { ShipSpec } from '../../src/sim/fleet';

export const P16_CARRIER = 'p16t_carrier';
export const P16_W = { fighters: 'p16t_fighters', bombers: 'p16t_bombers', interceptors: 'p16t_interceptors', airTorp: 'p16t_air_torp' } as const;

const craftWeapon = (id: string, name: string, cs: CraftStats): WeaponDef => ({
  id, name, kind: 'craft', damage: cs.gun?.damage ?? 0, pen: cs.gun?.pen ?? 0, range: cs.radius, speed: cs.speed,
  reload: cs.turnaround, salvo: 0, salvoGap: 0, spread: 0, turnSpeed: 360, caliber: 1, sound: 'auto', desc: 'P16.1 시제품 시험용 함재기 무장', craft: cs,
});

export const FIGHTERS: CraftStats = { role: 'fighter', n: 8, spares: 4, hp: 24, speed: 140, agility: 2.2, radius: 1800, sortie: 70, turnaround: 14, launch: 0.6, gun: { damage: 10, pen: 22, range: 260, reload: 0.35 } };
export const BOMBERS: CraftStats = { role: 'bomber', n: 6, spares: 3, hp: 36, speed: 110, agility: 1.4, radius: 1800, sortie: 80, turnaround: 20, launch: 0.8, gun: { damage: 6, pen: 12, range: 200, reload: 0.5 }, ordnance: P16_W.airTorp };
export const INTERCEPTORS: CraftStats = { role: 'interceptor', n: 8, spares: 4, hp: 20, speed: 165, agility: 2.6, radius: 1200, sortie: 60, turnaround: 12, launch: 0.5, gun: { damage: 8, pen: 12, range: 240, reload: 0.3 } };

const m = (weapon: string, pos: [number, number, number], facing: number, arc: number): MountDef => ({ weapon, pos, facing, arc });
const PD = [m('pd_gun', [5, 4, 26], 90, 175), m('pd_gun', [-5, 4, 26], -90, 175), m('pd_gun', [5, 4, 0], 90, 175), m('pd_gun', [-5, 4, 0], -90, 175), m('pd_gun', [5, 4, -26], 90, 175), m('pd_gun', [-5, 4, -26], -90, 175)];
/** hangar (H) mounts: the deck positions craft launch from */
const H = (weapon: string, k: number): MountDef => m(weapon, [k % 2 ? -4 : 4, 6, 20 - k * 9], k % 2 ? -90 : 90, 180);

const CARRIER: ShipClassDef = {
  id: P16_CARRIER, name: '시험 항모', enemyName: '시험 항모', type: '항모', role: 'line',
  length: 70, radius: 9, hp: 9000, armor: { front: 50, side: 40, rear: 26 },
  maxSpeed: 26, accel: 5, turnRate: 8, lateral: 0.3, cost: 280,
  structure: { bulk: 320, absorb: 0.45, critRes: 0.3, dc: 0.75 },
  desc: 'P16.1 시제품 시험용 선체 (게임 콘텐츠 아님)',
  loadouts: [
    // only craft and point defence: no gun to set its range by (principle 2)
    { id: 'mixed', name: '혼성 비행단', desc: '', mounts: [H(P16_W.fighters, 0), H(P16_W.fighters, 1), H(P16_W.bombers, 2), H(P16_W.bombers, 3), H(P16_W.interceptors, 4), ...PD] },
    { id: 'fighters', name: '전투기', desc: '', mounts: [H(P16_W.fighters, 0), H(P16_W.fighters, 1), ...PD] },
    { id: 'bombers', name: '뇌격기', desc: '', mounts: [H(P16_W.bombers, 0), H(P16_W.bombers, 1), ...PD] },
    { id: 'interceptors', name: '요격기', desc: '', mounts: [H(P16_W.interceptors, 0), H(P16_W.interceptors, 1), ...PD] },
  ],
};

let done = false;
/** register the fixtures (idempotent) */
export function registerP16Fixtures() {
  if (done) return;
  done = true;
  WEAPONS[P16_W.airTorp] = {
    id: P16_W.airTorp, name: '시험 항공 어뢰', kind: 'torpedo', damage: 520, pen: 80, range: 700, speed: 200, reload: 1, salvo: 1, salvoGap: 0,
    spread: 0.03, turnSpeed: 360, caliber: 1, guidedTurn: 0.9, munitionHp: 1, sound: 'torpedo', desc: 'P16.1 시험용',
  };
  WEAPONS[P16_W.fighters] = craftWeapon(P16_W.fighters, '시험 전투기 비행대', FIGHTERS);
  WEAPONS[P16_W.bombers] = craftWeapon(P16_W.bombers, '시험 뇌격기 비행대', BOMBERS);
  WEAPONS[P16_W.interceptors] = craftWeapon(P16_W.interceptors, '시험 요격기 비행대', INTERCEPTORS);
  SHIP_CLASSES[P16_CARRIER] = CARRIER;
}

/** a carrier whose hangars carry `craft` craft in total (perf harness): squadrons of 10, fighters / bombers / interceptors in turn */
export function carrierSpec(craft: number): ShipSpec {
  registerP16Fixtures();
  const mounts: MountDef[] = [];
  const kinds = [P16_W.fighters, P16_W.bombers, P16_W.interceptors];
  for (let k = 0, left = craft; left > 0; k++) {
    const n = Math.min(10, left); left -= n;
    const base = WEAPONS[kinds[k % 3]];
    const id = `${base.id}_${n}`;
    if (!WEAPONS[id]) WEAPONS[id] = { ...base, id, craft: { ...base.craft!, n } };
    mounts.push(H(id, k % 6));
  }
  return { classId: P16_CARRIER, loadoutId: 'mixed', fit: { name: `시험 항모 ${craft}`, mounts: [...mounts, ...PD] } };
}
