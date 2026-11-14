// P11 shared combat rules for the persistent world: company relations and tactical command authority.
// The server (WorldSim.battleOrder) and the client (BattleLink.canCommand) both call these functions,
// so a button the UI shows is exactly an order the server accepts — and the server never trusts the UI.
import type { World } from '../sim/world';
import type { Group, Order, Relation } from '../sim/types';
import type { Engagement, WorldState } from './types';

type St = Pick<WorldState, 'companies' | 'groups' | 'stations'> & Partial<Pick<WorldState, 'stance'>>;

/** relation between two companies in the persistent world (P11). Pirates are hostile to everyone else;
 *  two player companies are hostile if either declared it (an attack order declares it), allied only if
 *  both agreed, neutral otherwise. Lawful NPC factions (union, guild) are neutral to players and each
 *  other. */
export function coRelation(st: St, a: string, b: string): Relation {
  if (a === b) return 1;
  const pa = st.companies[a]?.kind === 'pirate' || a === 'pirates', pb = st.companies[b]?.kind === 'pirate' || b === 'pirates';
  if (pa && pb) return 1;
  if (pa !== pb) return -1;
  const sa = st.stance?.[a], sb = st.stance?.[b];
  if (sa?.hostile?.includes(b) || sb?.hostile?.includes(a)) return -1;
  if (sa?.ally?.includes(b) && sb?.ally?.includes(a)) return 1;
  return 0;
}

/** the company that owns a tactical ref by itself. `null`: a structural group with no ships of its own
 *  (a side root such as 'root' or 'co:<id>'), whose authority comes from its subtree. */
export function refOwner(st: St, ref: string): string | null | undefined {
  if (ref === 'root' || ref.startsWith('side:')) return null;
  if (ref.startsWith('co:')) return null;
  if (ref.startsWith('station:')) return st.stations[ref.slice(8)]?.owner;
  if (ref.startsWith('lair:')) return 'pirates';
  return st.groups[ref.replace('#civ', '')]?.owner;
}

/** may `company` command this tactical group? Only if every ref in the group's subtree is owned by that
 *  company — so a common root never lets one company command another company's ships, and a coalition
 *  side root is commandable only when the whole coalition is that one company. */
export function canCommandGroup(st: St, w: Pick<World, 'groupById'>, g: Group, company: string | null | undefined): boolean {
  if (!company || !g.ref) return false;
  if (st.companies[company]?.kind !== 'player') return false;
  let owned = 0;
  const stack: Group[] = [g];
  for (let guard = 0; stack.length && guard < 4096; guard++) {
    const x = stack.pop()!;
    if (x.ref) {
      const o = refOwner(st, x.ref);
      if (o === undefined) return false;          // unknown ref: nobody commands it
      if (o !== null) { if (o !== company) return false; owned++; }
    } else if (x.shipIds.length) return false;
    for (const id of x.childIds) { const c = w.groupById.get(id); if (c) stack.push(c); }
  }
  return owned > 0;
}

/** what an order may point at: attacks and flanks only at hostile sides, escorts only of own/allied sides */
export function validateTacticalOrder(w: Pick<World, 'groupById' | 'relation'>, g: Group, order: Order | null): string | null {
  if (!order) return null;
  const tgt = order.type === 'attack' || order.type === 'flank' ? order.targetGroup : order.type === 'escort' ? order.guardGroup : undefined;
  if (tgt === undefined) return null;
  const t = w.groupById.get(tgt);
  if (!t) return '대상 부대 없음';
  const rel = w.relation(g.team, t.team);
  if (order.type === 'escort') return rel === 1 ? null : '아군·동맹 부대만 호위할 수 있음';
  return rel === -1 ? null : '적대 관계가 아닌 진영은 공격할 수 없음 (전략 화면에서 적대 선언 필요)';
}

/** the tactical side a company fights on in a P11 engagement (-1: not a participant) */
export function sideOfCompany(e: Pick<Engagement, 'sides'>, company: string | null | undefined): number {
  if (!company) return -1;
  return e.sides.findIndex(s => s.includes(company));
}
