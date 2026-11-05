// Regional faction competition inside the five systems.
//
// Each system carries an influence score per faction (Union government, pirates, the merchant guild),
// 0..100. Scores drift toward a target set by the system's real situation (base security, living pirate
// lairs and their tier, recent pirate activity, markets) and are pushed by events: successful raids,
// pirate losses, lair destruction, completed deliveries. Influence feeds back into the world:
//   - Union − pirates shifts effective security (±6) — what the AI and the security map use
//   - guild influence scales NPC market supply; a liberated system gets a reconstruction boom
//   - a destroyed lair only rebuilds once pirates regain a foothold (influence ≥ LAIR_FOOTHOLD)
//   - dominant pirates field stronger bands
// Everything is persisted on StarSystem (inf, recoverUntil), so a player's impact outlives restarts.

import type { StarSystem, WorldState } from './types';

export interface Influence { union: number; pirates: number; guild: number }
export const FACTION_NAME: Record<keyof Influence, string> = { union: '연합 관리청', pirates: '해적', guild: '상인 길드' };
export const LAIR_FOOTHOLD = 25;
export const RECOVERY_TIME = 3600;
const DRIFT = 1 / 900;           // fraction of the gap closed per second (≈15 min time constant)

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function influenceTarget(st: Pick<WorldState, 'lairs' | 'stations'>, sys: StarSystem, time: number): Influence {
  const inSys = (p: { x: number }) => Math.abs(p.x - sys.origin.x) < sys.radius + 20000;
  const lairs = Object.values(st.lairs).filter(l => l.alive && inSys(l.pos));
  const markets = Object.values(st.stations).filter(s => s.public && s.market && inSys(s.pos)).length;
  const recovering = (sys.recoverUntil ?? 0) > time;
  return {
    union: clamp(sys.security + (recovering ? 8 : 0)),
    pirates: clamp((100 - sys.security) * 0.45 + lairs.reduce((a, l) => a + 6 + (l.tier ?? 2) * 4, 0) + sys.heat * 0.2),
    guild: clamp(22 + markets * 12 + (recovering ? 12 : 0) - sys.heat * 0.25),
  };
}

export function ensureInfluence(st: Pick<WorldState, 'lairs' | 'stations'>, sys: StarSystem, time = 0): Influence {
  return (sys.inf ??= influenceTarget(st, sys, time));
}

/** once per second */
export function factionStep(st: WorldState, dt: number) {
  for (const sys of Object.values(st.systems)) {
    const inf = ensureInfluence(st, sys, st.time);
    const t = influenceTarget(st, sys, st.time);
    for (const k of ['union', 'pirates', 'guild'] as const) inf[k] = clamp(inf[k] + (t[k] - inf[k]) * Math.min(1, DRIFT * dt));
  }
}

export function bump(sys: StarSystem | undefined, d: Partial<Influence>) {
  if (!sys?.inf) return;
  for (const [k, v] of Object.entries(d) as [keyof Influence, number][]) sys.inf[k] = clamp(sys.inf[k] + v);
}

/** effective-security shift from the Union/pirate balance */
export const influenceSec = (sys: StarSystem) => sys.inf ? Math.max(-6, Math.min(6, (sys.inf.union - sys.inf.pirates) * 0.06)) : 0;

/** NPC market supply multiplier: merchant presence, plus the reconstruction boom after liberation */
export const supplyMul = (sys: StarSystem | undefined, time: number) =>
  !sys ? 1 : (sys.inf ? 0.7 + sys.inf.guild / 100 * 0.6 : 1) * ((sys.recoverUntil ?? 0) > time ? 1.35 : 1);

export const dominant = (sys: StarSystem): keyof Influence | null => {
  if (!sys.inf) return null;
  const e = (Object.entries(sys.inf) as [keyof Influence, number][]).sort((a, b) => b[1] - a[1]);
  return e[0][1] - e[1][1] >= 8 ? e[0][0] : null;
};
