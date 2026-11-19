/**
 * P16.7 isolated repair-ship rollout switch — separate from the carrier switch (carrierRelease.ts).
 *
 * Explicitly opt in on a local Node test server:
 *   NODE_ENV=development P16_DEV_REPAIR_RELEASE=1
 * and on the matching Vite client:
 *   VITE_P16_DEV_REPAIR_RELEASE=1 vite --mode p16-dev
 *
 * Off (every ordinary development, production build and hosted server): the combat repair hull stays a
 * preview hull, repair gear is neither sold, produced nor reverse-engineered, and no world stocks it.
 * Battle rules are not touched: repair rigs act in any battle a ship carrying one takes part in (presence-gated,
 * like the strike-craft pool), so recorded battles without repair gear replay unchanged.
 */
export const DEV_REPAIR_HULL_ID = 'destroyer_mender';

export interface RepairDevEnv { nodeEnv?: string; serverFlag?: string; viteMode?: string; viteFlag?: string }

/** Pure decision helper: no implicit release when a flag is unset or in production. */
export function repairDevReleaseEnabled(env: RepairDevEnv): boolean {
  return (env.nodeEnv === 'development' && env.serverFlag === '1') ||
    (env.viteMode === 'p16-dev' && env.viteFlag === '1');
}

export const DEV_REPAIR_RELEASE = repairDevReleaseEnabled({
  nodeEnv: typeof process === 'undefined' ? undefined : process.env.NODE_ENV,
  serverFlag: typeof process === 'undefined' ? undefined : process.env.P16_DEV_REPAIR_RELEASE,
  viteMode: import.meta.env?.MODE,
  viteFlag: import.meta.env?.VITE_P16_DEV_REPAIR_RELEASE,
});
