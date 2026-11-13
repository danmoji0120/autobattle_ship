// Growth economy baseline (contentV ≥ 3). Every tuning number of the c4 economy lives here so that a
// balance pass (P9) edits one data file instead of hunting constants through the sim. Pure data —
// imported by valuation / hullops / upkeep / migrate / sim. contentV < 3 never reads it.
//
// Baseline "c4-b1" (P5 stage 1) — provisional and FROZEN until P9:
//  - small and civilian hulls stay cheap (NPC yards mass-produce them below their build cost);
//  - from destroyers up the NPC price climbs steeply: production cost (parts + labour + real yard
//    operating fee) × a class licence multiple, so a battleship is a multi-day goal, and building it
//    yourself (own yard, own industry) is the cheaper way;
//  - NPC yards keep one or two hulls of each warship in stock and replace them slowly, from regional
//    materials, for trusted companies only; the largest hulls are never sold by NPCs;
//  - ships move between players only through player listings (no NPC buy-back → no buy/sell loop).

export const ECON_BASELINE_ID = 'c4-b1';

/** value added per production step (covers energy, wear and the producer's profit) */
export const STEP_MARGIN = 1.1;
/** labour per second of recipe time (credits) */
export const LABOUR_PER_S = 0.35;
/** raw goods price relative to the pre-c4 hand-set base (applied by the c3→c4 migration) */
export const RAW_PRICE_V4 = 0.25;

/** yard operating fee per second of build time, by yard size. Charged for real when an own yard lays
 *  down a hull (growth worlds) and counted in the hull's production cost. */
export const YARD_FEE = [0, 0.8, 3, 7, 12];

/** NPC list price as a multiple of production cost, by hull size (fallback for classes not listed) */
export const SALE_BY_YARD = [0, 0.42, 0.85, 1.25, 2];
/** class licence multiples: warships from destroyers up carry military licence premiums; small
 *  combat hulls and civilian hulls stay subsidised so a new company can always field ships */
export const SALE_BY_CLASS: Record<string, number> = {
  corvette: 0.42, frigate: 0.42,
  destroyer: 1.9, light_cruiser: 2.1,
  cruiser: 2.6, battlecruiser: 2.7, battleship: 3, dreadnought: 4,
};
/** blueprint grade multiple on top (rarer designs cost more) */
export const GRADE_MUL: Record<string, number> = { common: 1, advanced: 1.12, faction: 1.25, rare: 1.45, unique: 2 };

/** mk1 hull NPC supply by yard size: stock kept, seconds to replace one, minimum reputation for
 *  military hulls (civilian hulls use the class reputation). Yard 4 hulls are never sold. */
export const MK1_STOCK = [0, 4, 2, 1];
export const MK1_RESTOCK = [0, 1800, 14400, 86400];
export const MK1_MIL_REP = [0, 0, 10, 30];
/** share of a hull's production cost a public yard takes from its market to build a replacement */
export const YARD_RESTOCK_SHARE: [string, number][] = [['alloy', 0.3], ['electronics', 0.06]];
export const YARD_RESTOCK_SHARE_WAR: [string, number][] = [['structure', 0.1], ['armor_plate', 0.06]];

/** starting credits of a new company in a growth world (one small hull on top of the starter fleet) */
export const START_CREDITS_GROWTH = 12000;
/** company-wide overhead on running costs (flat: splitting into accounts saves nothing) */
export const OVERHEAD = 0.1;

/** Value-chain pricing "B" (econChain.ts) — OPT-IN per world, not a default. Experimental values pending
 *  approval (docs/ECONOMY_B_PLAN.md §결정): equipment policy, direct-alloy output. A world records the
 *  policy and output it was priced with (st.econ), so changing these never reprices an existing world. */
export const ECON_CHAIN = {
  id: 'b1',
  /** raw goods: share of the hand-set base price (same as c4) */
  raw: 0.25,
  /** spread allowance carried on the inputs' value at every made step */
  S: 0.15,
  /** value-added rate (credits per line-second) for recipes without a solved target (equipment) */
  vaDefault: 2.5,
  /** target profit/h of one main-recipe line that buys every input at the market */
  targets: {
    metal: 6000, titanium: 6000, silicon: 5000, chemicals: 5000, rare_metal: 12000,
    alloy: 7000, composite: 12000,
    machinery: 8000, precision: 8000, structure: 8000, electronics: 11000, armor_plate: 10000,
    weapon_parts: 12000, engine: 14000, reactor: 18000, sensor: 12000,
  } as Record<string, number>,
  /** equipment policy of a newly enabled world: 'chain' value chain (as the B analysis), 'keep' c4 price,
   *  'margin' inputs × (1 + eqMargin) + labour */
  eqDefault: 'chain' as 'chain' | 'keep' | 'margin',
  eqMargin: 0.4,
  /** direct ore → alloy output in a chain world (c4: 14) */
  alloyDirect: 7,
};
