// A-2.1 — company recovery under arrears (회생).
//
// The arrears stages (upkeep.ts) stay as they are: from stage 3 docked ships do not start new voyages and no new
// military work begins. What this module adds is a narrow way back for a company whose only income needs a ship to
// leave the dock:
//
//   회생 운항 (recovery sortie) — the player names at most RECOVERY_SHIPS civilian ships (cargo hold or mining gear).
//     Those ships may leave the dock for economic work only (mine, haul, salvage/recovery, dock/return). Everything is
//     the normal game: real ore, real cargo, real travel, the real market with its budget and prices, the same route
//     dangers and battles. Sale proceeds pay the arrears first (money.ts payFromSale). Running costs keep accruing,
//     stage-2 supply/maintenance delays stay, and every other ship stays held. A combat ship may be named only to
//     move to a yard that buys it (dock/return), never for any other order.
//     A ship laid up in reserve can be named too: its reactivation fee (2 h of its running cost) is added to the debt
//     instead of being paid up front, and it still waits the normal reactivation time.
//
//   긴급 매각 (emergency sale) — a docked ship of a standard build can be sold to a public yard that stocks that hull,
//     at half its list value scaled by condition, paid from the yard's real buying budget into the yard's real stock.
//     No new money or ships appear: the yard pays from its budget and resells the hull later.
//   긴급 교환 (trade-in) — a company with no ship able to mine (the one income that needs no money or stock to
//     start: a hauler with an empty warehouse and no credits has nothing to carry) can hand a non-mining ship to
//     such a yard and take the yard's cheapest civilian hull (mk1 miner or hauler, from real stock) at the yard's normal price; the difference is paid
//     out (to the debt first) or, if the old ship was worth less, added to the debt.
//
// Both are available only while the company is in arrears stage ≥ 3, so they never change the normal economy; a
// sale returns half the value at best, so arrears are never a cheaper way to sell a ship. When the debt is paid
// the recovery closes by itself: the named ships go back to normal and the old departure rules apply again.
import type { Company, Station, WorldState, WShip } from './types';
import { cargoKeys } from './types';
import { hullEcon, hullIdOf, hullSale, shipWorth, yardHulls } from './hullops';
import { CONTENT } from '../content/registry';
import { EQUIPMENT } from './industry';

export const RECOVERY_STAGE = 3;
/** ships that may fly recovery sorties at the same time */
export const RECOVERY_SHIPS = 2;
/** emergency sale price: share of list value (× condition) */
export const BUYBACK = 0.5;
/** a yard buys back until its stock of that hull reaches this multiple of its normal stock */
export const BUYBACK_STOCK = 2;
/** hulls a trade-in can give: the cheapest civilian earners */
export const SWAP_HULLS = ['miner_mk1', 'hauler_mk1'];
/** orders a recovery sortie may fly (economic work, or going home / to a yard) */
const ECON_OPS = new Set(['mine', 'haul', 'recover', 'salvzone', 'salvage', 'dock', 'return', 'idle']);
const FERRY_OPS = new Set(['dock', 'return', 'idle']);

export const debtOpen = (co: Company | undefined) => (co?.upkeep?.debt ?? 0) > 1;
/** the company is in the arrears stage where departures are held, so recovery tools are open */
export const inRecovery = (co: Company | undefined) => !!co && co.kind === 'player' && (co.upkeep?.stage ?? 0) >= RECOVERY_STAGE && debtOpen(co);

/** can this hull do paid work (a hold or mining gear, not a warship)? */
export function earner(s: WShip): boolean {
  if (s.classId === 'platform') return false;
  const e = hullEcon(hullIdOf(s), s.variant);
  return !e.military && (e.cargo > 0 || e.mine > 0);
}

/** can this hull mine (the one income that needs no money or stock to start)? */
export function miner(s: WShip): boolean {
  if (s.classId === 'platform') return false;
  const e = hullEcon(hullIdOf(s), s.variant);
  return !e.military && e.mine > 0;
}
/** a trade-in is open when no other ship of the company could mine */
export const tradeInOpen = (w: WorldState, co: string, except: string) => !Object.values(w.ships).some(x => x.owner === co && x.id !== except && miner(x) && !x.listed);

export const recoveryShips = (w: WorldState, co: string) => Object.values(w.ships).filter(s => s.owner === co && s.recovery);

/** called by departureHeld for a company at stage ≥ 3: null = this ship may depart */
export function recoveryHold(w: WorldState, s: WShip): string {
  const co = w.companies[s.owner];
  if (!s.recovery || !co?.upkeep?.recovery) return '운영비 체납 — 신규 출항 보류';
  const op = w.groups[s.groupId]?.op?.k ?? 'idle';
  if (!earner(s)) return FERRY_OPS.has(op) ? '' : '회생 이동 — 매입 조선소로 정박 이동만 가능';
  return ECON_OPS.has(op) ? '' : '회생 운항 — 채굴·운송·인양 작전만 가능';
}

/** why this ship cannot be named for a recovery sortie (null = it can) */
export function sortieProblem(w: WorldState, co: Company, s: WShip | undefined): string | null {
  if (!inRecovery(co)) return (co.upkeep?.stage ?? 0) < RECOVERY_STAGE ? '출항 제한이 없습니다 — 회생 운항은 체납 3단계(신규 출항 보류)부터 사용합니다' : '미납금이 없습니다';
  if (!s || s.owner !== co.id || s.classId === 'platform') return '자사 함선이 아님';
  if (s.recovery) return '이미 회생 운항 지정';
  if (s.listed) return '거래소 매물 — 매물을 먼저 내리세요';
  if (s.recover) return '자율 재구성 중인 함선';
  if (recoveryShips(w, co.id).length >= RECOVERY_SHIPS) return `회생 운항은 동시에 ${RECOVERY_SHIPS}척까지`;
  return null;
}

export function standardBuild(s: WShip): boolean {
  if ((s.fit ?? []).some(k => !(s.ind && EQUIPMENT[k]?.ind))) return false;   // industrial gear is checked with the bays below
  const hull = hullIdOf(s), variant = s.variant ?? `${hull}_std`;
  if (CONTENT.variants[variant] && CONTENT.variants[variant].blueprint !== 'common') return false;
  if (!s.fitting) return true;
  // industrial hardpoints: the hull's standard gear is part of its standard build (bought and traded-in ships come with it)
  const std = [...(s.ind ? CONTENT.hulls[hull]?.ops?.gear ?? [] : [])];
  for (const g of Object.values(s.fitting.bay ?? {})) { const i = std.indexOf(g); if (i < 0) return false; std.splice(i, 1); }
  const p = (s.fitting.preset ? CONTENT.presets[s.fitting.preset] : undefined) ?? Object.values(CONTENT.presets).find(x => x.variant === variant);
  const want = p?.weapons ?? {}, have = s.fitting.hp ?? {};
  const keys = new Set([...Object.keys(want), ...Object.keys(have)]);
  for (const k of keys) if (want[k] !== have[k]) return false;
  return true;
}

/** what a public yard pays for this ship in an emergency sale */
export function buybackValue(w: WorldState, s: WShip): number {
  const cond = (0.5 + 0.5 * Math.max(0, Math.min(1, s.hp))) * (1 - 0.5 * Math.max(0, Math.min(1, s.wear ?? 0)));
  return Math.round(BUYBACK * shipWorth(w, s) * cond / 10) * 10;
}

/** why this yard cannot buy this ship now (null = it can) */
export function buybackProblem(w: WorldState, co: Company, s: WShip | undefined): string | null {
  if (!inRecovery(co)) return '긴급 매각은 체납 3단계(신규 출항 보류)부터 사용할 수 있습니다';
  if (!s || s.owner !== co.id || s.classId === 'platform') return '자사 함선이 아님';
  if (s.state !== 'docked' || s.task.k !== 'docked') return '정박 중인 함선만 매각할 수 있습니다';
  const st = w.stations[s.task.station];
  const hull = hullIdOf(s), h = CONTENT.hulls[hull];
  if (!h || h.dev || h.exclusive) return '매각할 수 없는 선체';
  if (!st?.public || !yardHulls(st).includes(hull)) return '이 정거장의 공영 조선소는 이 선체를 매입하지 않습니다 — 이 선체를 판매하는 조선소로 이동해야 합니다';
  if (s.listed) return '거래소 매물 — 매물을 먼저 내리세요';
  if (s.reserve) return s.reserve.until ? '재취역 중인 함선' : '예비역 함선 — 매입 조선소는 예비역 함선도 그대로 매입하지 않습니다 (재취역 후 매각)';
  if (cargoKeys(s.cargo).length) return '화물을 먼저 하역하세요';
  if (!standardBuild(s)) return '표준 구성이 아닌 함선 — 추가 장비·모듈을 피팅에서 해제(창고 보관)하고 표준 구성으로 되돌린 뒤 매각하세요';
  const sale = hullSale(hull); if (!sale) return '이 선체는 공영 조선소가 매입하지 않습니다';
  if ((st.shipStock?.[hull]?.n ?? sale.stock) >= sale.stock * BUYBACK_STOCK) return `${st.name} 조선소의 ${h.name} 재고가 가득 차 매입하지 않습니다`;
  return null;
}

/** the yard's stock entry for a hull (created at its base stock the way buyHull does) */
export function yardStock(st: Station, hull: string) {
  const sale = hullSale(hull)!;
  return (st.shipStock ??= {})[hull] ??= { n: sale.stock, t: 0 };
}

/** recovery progress for the UI */
export function recoveryProgress(co: Company) {
  const u = co.upkeep; const r = u?.recovery;
  if (!u || !r) return null;
  const paid = Math.max(0, (u.total?.paid ?? 0) - r.paid0);
  return { since: r.since, debt0: r.debt0, paid, debt: u.debt };
}
