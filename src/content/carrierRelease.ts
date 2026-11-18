/**
 * P16.6 isolated carrier rollout switch.
 *
 * Explicitly opt in on a local Node test server:
 *   NODE_ENV=development P16_DEV_CARRIER_RELEASE=1
 * and on the matching Vite client:
 *   VITE_P16_DEV_CARRIER_RELEASE=1 vite --mode p16-dev
 *
 * Ordinary development, production builds and hosted production servers remain
 * on battle rules 2 with the preview carrier locked. This does not edit saves.
 * Production release requires a separate reviewed change.
 */
export const DEV_CARRIER_HULL_ID = 'carrier_dawn';

export interface CarrierDevEnv {
  nodeEnv?: string;
  serverFlag?: string;
  viteMode?: string;
  viteFlag?: string;
}

/** Pure decision helper: no implicit release when a flag is unset or in production. */
export function carrierDevReleaseEnabled(env: CarrierDevEnv): boolean {
  return (env.nodeEnv === 'development' && env.serverFlag === '1') ||
    (env.viteMode === 'p16-dev' && env.viteFlag === '1');
}

export const DEV_CARRIER_RELEASE = carrierDevReleaseEnabled({
  nodeEnv: typeof process === 'undefined' ? undefined : process.env.NODE_ENV,
  serverFlag: typeof process === 'undefined' ? undefined : process.env.P16_DEV_CARRIER_RELEASE,
  viteMode: import.meta.env?.MODE,
  viteFlag: import.meta.env?.VITE_P16_DEV_CARRIER_RELEASE,
});
