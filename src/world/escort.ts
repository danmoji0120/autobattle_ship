// Escort missions: a warship group protects another group's ships instead of chasing their centre.
//
// The escort works out *what* it protects (the wards), where they are going, and holds a position
// that covers them: ahead/on the flanks while they travel, a picket ring while they work a deposit,
// between them and an attacker when they retreat. Threats are intercepted before they reach the
// wards, but never chased beyond a leash measured from the wards. Fighting itself is the existing
// engagement system (contact at ENGAGE_R starts a battle with everything within JOIN_R).
//
// The protected group cooperates: before leaving a safe place (docked / next to a station) it waits
// for a far-away escort, for a bounded time; while escorted it does not outrun its escort. It never
// waits for an escort that is gone or cannot reach it, and it is told when its escort is lost.
//
// This module holds the pure parts (constants, ward selection, slots, phases, wording); sim.ts drives
// the ships with its normal movement primitives.
import type { Op, V, WGroup, WShip } from './types';

/** what an escort protects inside the target group */
export type EscortFocus = 'auto' | 'work' | 'cargo' | 'all';
export const ESCORT_FOCUS_NAME: Record<EscortFocus, string> = { auto: '자동', work: '작업선(채굴선)', cargo: '수송선', all: '편대 전체' };

export type EscortPhase = 'lost' | 'blocked' | 'join' | 'far' | 'convoy' | 'guard' | 'standby' | 'intercept' | 'cover';

export const ESCORT = {
  /** convoy: how far ahead of the wards the escort leads, and the lateral spacing */
  lead: 450, flank: 240, rowBack: 160,
  /** picket ring around a worked deposit / stationary wards */
  ringPad: 300, ringMin: 450,
  /** escort counts as "with" the wards inside this distance */
  joined: 2200,
  /** beyond this (or another system) the escort is "too far" */
  far: 7000,
  /** threats: detection around the wards and around the escort; leash from the wards */
  detect: 3800, detectSkill: 1500, detectEscort: 1800, leash: 5600,
  /** the wards hold at a safe place for at most this long, and not at all if the escort's ETA exceeds etaMax */
  waitMax: 240, etaMax: 420,
  /** a safe place to wait: docked, or this close to a dockable station */
  safeR: 2600,
  /** wards travelling with an escort keep to this share of the escort's speed */
  pace: 0.92,
} as const;

/** default focus for a target operation: mining → the miners on the deposit, cargo work → the carriers, else everyone */
export function autoFocus(op: Op): Exclude<EscortFocus, 'auto'> {
  if (op.k === 'mine') return 'work';
  if (op.k === 'haul' || op.k === 'trade') return 'cargo';
  return 'all';
}

export function pickWards(op: Op, focus: EscortFocus, ships: WShip[], isMiner: (s: WShip) => boolean, isCarrier: (s: WShip) => boolean): WShip[] {
  const f = focus === 'auto' ? autoFocus(op) : focus;
  if (f === 'all') return ships;
  const miners = ships.filter(isMiner), carriers = ships.filter(s => !isMiner(s) && isCarrier(s));
  const pick = f === 'work' ? miners : carriers;
  // nothing of the requested kind in the group: protect what is there rather than nothing
  return pick.length ? pick : ships;
}

export const unit = (dx: number, dz: number): [number, number] | null => { const l = Math.hypot(dx, dz); return l > 1e-6 ? [dx / l, dz / l] : null; };

/** convoy slot: a screen ahead of the wards (first row), further rows on the flanks behind it */
export function convoySlot(i: number, n: number, center: V, heading: [number, number]): V {
  const [hx, hz] = heading, px = -hz, pz = hx;
  const perRow = n <= 2 ? n : 3;
  const row = Math.floor(i / perRow), col = (i % perRow) - (Math.min(perRow, n - row * perRow) - 1) / 2;
  const fwd = ESCORT.lead - row * ESCORT.rowBack * 2;
  return { x: center.x + hx * fwd + px * col * ESCORT.flank * (row ? 1.6 : 1), y: center.y + 30, z: center.z + hz * fwd + pz * col * ESCORT.flank * (row ? 1.6 : 1) };
}

/** picket ring: evenly spaced around the centre, the first picket facing `toward` when a direction is known */
export function ringSlot(i: number, n: number, center: V, r: number, toward: [number, number] | null, t: number): V {
  const base = toward ? Math.atan2(toward[1], toward[0]) : t * 0.02;
  const a = base + (i / Math.max(1, n)) * Math.PI * 2;
  return { x: center.x + Math.cos(a) * r, y: center.y + 40, z: center.z + Math.sin(a) * r };
}

/** a point between the wards and the attacker, so the attacker meets the escort first */
export function coverSlot(i: number, center: V, threat: V | null, r = 380): V {
  const d = threat ? unit(threat.x - center.x, threat.z - center.z) : null;
  const [dx, dz] = d ?? [1, 0];
  const side = ((i % 3) - 1) * 160;
  return { x: center.x + dx * r - dz * side, y: center.y + 30, z: center.z + dz * r + dx * side };
}

export function escortStatus(phase: EscortPhase, target: string, extra = ''): string {
  switch (phase) {
    case 'lost': return '호위 대상 소실';
    case 'blocked': return `호위 불가능 — 경로 차단 (${target})${extra}`;
    case 'join': return `${target} 호위 — 호위 대상에 합류 중${extra}`;
    case 'far': return `${target} 호위 — 호위 대상과 거리 초과, 합류 중${extra}`;
    case 'convoy': return `${target} 호위 — 호위 진형 유지${extra}`;
    case 'guard': return `${target} 호위 — 광구 경계 중${extra}`;
    case 'standby': return `${target} 호위 — 호위 대상 주변 경계${extra}`;
    case 'intercept': return `${target} 호위 — 적대 함선 요격 중${extra}`;
    case 'cover': return `${target} 호위 — 보호 대상 후퇴 엄호${extra}`;
  }
}

/** persisted on the escort group (survives save/restart; recomputed every tick anyway) */
export interface EscortState { phase: EscortPhase; since: number }
/** persisted on the protected group: rally hold and the escorts it last had (to report a loss once) */
export interface WardState { waitSince?: number; gaveUp?: boolean; escorts?: { id: string; name: string }[] }
export type { WGroup };
