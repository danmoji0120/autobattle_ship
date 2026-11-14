// P11: how one viewer sees a battle. The simulation has no "ally" or "enemy" — only sides and the
// relations between them. A player sees their own side, allies, neutrals and enemies; a spectator sees
// every side by name and colour with nobody's point of view forced on them. Two players in the same
// battle therefore see different labels and colours of the exact same simulation.
import type { World } from '../sim/world';

export type RelKind = 'own' | 'ally' | 'neutral' | 'enemy';
export const REL_COLOR: Record<RelKind, string> = { own: '#5fd4ff', ally: '#6fe0a8', neutral: '#e8c45a', enemy: '#ff5a48' };
export const REL_TEXT: Record<RelKind, string> = { own: '자사', ally: '동맹', neutral: '중립', enemy: '적대' };
/** spectator palette: sides 0 and 1 keep the classic cyan / red */
export const SIDE_PALETTE = ['#5fd4ff', '#ff5a48', '#e8c45a', '#c08cff', '#6fe0a8', '#ff9ad0', '#9fb4ff', '#ffb070'];

export class Perspective {
  constructor(private w: Pick<World, 'relation' | 'sides'>, readonly me: number | null, private names: string[] = []) {}
  get spectator() { return this.me === null; }
  kind(team: number): RelKind | null {
    if (this.me === null) return null;
    if (team === this.me) return 'own';
    const r = this.w.relation(this.me, team);
    return r === 1 ? 'ally' : r === 0 ? 'neutral' : 'enemy';
  }
  mine(team: number) { return this.me !== null && team === this.me; }
  /** own or allied */
  friend(team: number) { const k = this.kind(team); return k === 'own' || k === 'ally'; }
  foe(team: number) { return this.kind(team) === 'enemy'; }
  color(team: number) { const k = this.kind(team); return k ? REL_COLOR[k] : SIDE_PALETTE[team % SIDE_PALETTE.length]; }
  /** hull style for the renderer: 0 = our/allied design, 1 = the hostile design */
  hull(team: number): 0 | 1 { return this.me === null ? (team === 0 ? 0 : 1) : this.friend(team) ? 0 : 1; }
  name(team: number) { return this.names[team] ?? this.w.sides[team]?.name ?? `진영 ${team + 1}`; }
  label(team: number) { const k = this.kind(team); return k && k !== 'own' ? `${this.name(team)} (${REL_TEXT[k]})` : this.name(team); }
  /** sides in display order: own, allies, neutrals, enemies (spectator: by index) */
  order(): number[] {
    const ks = this.w.sides.map((_, k) => k);
    if (this.me === null) return ks;
    const rank = (k: number) => ({ own: 0, ally: 1, neutral: 2, enemy: 3 }[this.kind(k)!]);
    return ks.sort((a, b) => rank(a) - rank(b) || a - b);
  }
}
