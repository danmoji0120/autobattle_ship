import { WEAPONS, isCraft, type WeaponDef } from '../sim/data/weapons';
import { effectiveCraft, wingControl } from '../sim/craft';
import type { AirFx } from '../sim/fleet';

/** P16.4 fitting-screen air-wing figures (what the battle's craft pool will get: sim/craft.ts addShip) */
export interface WingInfo { squads: number; control: number; craft: number; spares: number; rMin: number; rMax: number }

const ROLE_KO = { fighter: '전투기', bomber: '뇌격기', interceptor: '요격기' } as const;

export function wingInfo(mounts: { weapon: string }[], air?: AirFx): WingInfo | null {
  let squads = 0, craft = 0, spares = 0, rMin = Infinity, rMax = 0;
  for (const m of mounts) {
    const w = WEAPONS[m.weapon];
    if (!w || !isCraft(w) || !w.craft) continue;
    const cs = effectiveCraft(w.craft, air);
    squads++; craft += cs.n; spares += cs.spares; rMin = Math.min(rMin, cs.radius); rMax = Math.max(rMax, cs.radius);
  }
  return squads ? { squads, control: wingControl(air), craft, spares, rMin, rMax } : null;
}

/** H-slot line: "전투기 8기 · 예비 4 · 반경 1500" (with the fitted aviation modules) */
export function craftSlotText(w: WeaponDef, air?: AirFx): string {
  if (!w.craft) return '';
  const c = effectiveCraft(w.craft, air);
  return `${ROLE_KO[c.role]} ${c.n}기 · 예비 ${c.spares} · 반경 ${c.radius}`;
}

/** stat-table rows for a carrier, replacing the gun firepower / range row */
export function wingRows(now: WingInfo | null, nxt: WingInfo, gunDps: string, cmp: (a: number, b: number) => string): string {
  const held = Math.max(0, nxt.squads - nxt.control);
  const r = nxt.rMin === nxt.rMax ? `${nxt.rMin}` : `${nxt.rMin}–${nxt.rMax}`;
  return `<tr><td>비행대</td><td>${nxt.squads} · 관제 ${nxt.control}${cmp(now?.control ?? 0, nxt.control)}${held ? ` <span class="dn" title="관제 한도를 넘는 비행대는 직위 엄호(CAP)로 대기">${held} CAP 대기</span>` : ''}</td><td>함재기</td><td>${nxt.craft}기 · 예비 ${nxt.spares}${cmp(now?.craft ?? 0, nxt.craft)}</td></tr>
            <tr><td>작전 반경</td><td>${r}</td><td>함포 화력</td><td>${gunDps}</td></tr>`;
}
