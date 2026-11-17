// A-1: the integrated standard world. Every system developed so far runs together in one universe:
//   P10 layout (40 systems, six factions, territory, exploration fog) · faction economy v2 · P11 multi-side combat & PvP
//   · P12 fleet operations · P12.5 automatic logistics · P13.1 salvage · P13.2 piracy · P13.3 black markets
//   · P13.4 law enforcement · P14.0 company credit and faction trust · A-3.2b natural derelicts and salvage
//   contracts · B-1 officer growth · B-2 military contracts · B-3 sovereignty and territory war · industrial
//   hardpoints (mining / construction / salvage as fitted gear) — on top of the construction, production, market,
//   shipyard and research systems every growth world has.
// Value-chain pricing (econ 'chain') stays out: it is an unapproved pricing variant, not one of the systems above.
// A world's rules are fixed when it is created; an existing save is never converted by choosing a preset.
import type { WorldSim } from './sim';

export type WorldCreateOpts = NonNullable<Parameters<typeof WorldSim.create>[1]>;
export type WorldPreset = 'standard' | 'legacy';

export const STANDARD_WORLD: Readonly<WorldCreateOpts> = Object.freeze({
  layout: 'p10', factionEcon: 'v2', combat: 'p11', ops: 'p12', logistics: 'p125', salvage: 'p131', piracy: 'p132',
  blackMarket: 'p133', law: 'p134', rep: 'p14', derelicts: 'a32b', officers: 'b1', military: 'b2', territory: 'b3', industrial: 'ind1',
} as const);

/** the per-system switches of the legacy preset (one opt-in flag per system, P9 layout) */
export interface LegacyWorldFlags {
  econNew?: boolean; combatNew?: boolean; opsNew?: boolean; logisticsNew?: boolean; salvageNew?: boolean; piracyNew?: boolean;
  blackMarketNew?: boolean; lawNew?: boolean; repNew?: boolean;
}

/** the creation options for a brand-new world — the single source for a first start and for an operator reset */
export function newWorldOptions(o: LegacyWorldFlags & { worldPreset?: WorldPreset }): WorldCreateOpts {
  if (o.worldPreset === 'standard') return { ...STANDARD_WORLD };
  return {
    ...(o.econNew ? { econ: 'chain' as const } : {}), ...(o.combatNew ? { combat: 'p11' as const } : {}), ...(o.opsNew ? { ops: 'p12' as const } : {}),
    ...(o.logisticsNew ? { logistics: 'p125' as const } : {}), ...(o.salvageNew ? { salvage: 'p131' as const } : {}), ...(o.piracyNew ? { piracy: 'p132' as const } : {}),
    ...(o.blackMarketNew ? { blackMarket: 'p133' as const } : {}), ...(o.lawNew ? { law: 'p134' as const } : {}), ...(o.repNew ? { rep: 'p14' as const } : {}),
  };
}

/** what a world actually runs, read from its state (for logs, status and checks) */
export function worldRules(w: { factions?: unknown; factionEcon?: unknown; combatV?: number; opsV?: number; logisticsV?: number; salvageV?: number; piracyV?: number; blackMarketV?: number; lawV?: number; repV?: number; derelictV?: number; officerV?: number; milV?: number; sovV?: number; indV?: number; econ?: unknown; systems: Record<string, unknown> }) {
  return {
    layout: w.factions ? 'p10' : 'p9', systems: Object.keys(w.systems).length, factions: w.factions ? Object.keys(w.factions as object).length : 0,
    factionEcon: !!w.factionEcon, combat: w.combatV === 2, ops: !!w.opsV, logistics: !!w.logisticsV, salvage: !!w.salvageV, piracy: !!w.piracyV,
    blackMarket: !!w.blackMarketV, law: !!w.lawV, rep: !!w.repV, derelicts: !!w.derelictV, officers: !!w.officerV, military: !!w.milV, territory: !!w.sovV, industrial: !!w.indV, econChain: !!w.econ,
  };
}
