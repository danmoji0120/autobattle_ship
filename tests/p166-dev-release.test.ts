import { describe, expect, it } from 'vitest';
import { carrierDevReleaseEnabled, DEV_CARRIER_RELEASE, DEV_CARRIER_HULL_ID } from '../src/content/carrierRelease';
import { BATTLE_RULES } from '../src/sim/world';
import { CONTENT, hullReleased, gearReleased } from '../src/content/registry';
import { CARRIER_HULL } from '../src/content/packs/growth/carrier';

describe('P16.6 carrier development-only rollout switch', () => {
  it('never enables in ordinary development or production without both explicit conditions', () => {
    expect(carrierDevReleaseEnabled({})).toBe(false);
    expect(carrierDevReleaseEnabled({ nodeEnv: 'production', serverFlag: '1' })).toBe(false);
    expect(carrierDevReleaseEnabled({ nodeEnv: 'test', serverFlag: '1' })).toBe(false);
    expect(carrierDevReleaseEnabled({ nodeEnv: 'development' })).toBe(false);
    expect(carrierDevReleaseEnabled({ viteMode: 'production', viteFlag: '1' })).toBe(false);
    expect(carrierDevReleaseEnabled({ viteMode: 'p16-dev' })).toBe(false);
  });
  it('enables only the opt-in local server or Vite p16-dev client', () => {
    expect(carrierDevReleaseEnabled({ nodeEnv: 'development', serverFlag: '1' })).toBe(true);
    expect(carrierDevReleaseEnabled({ viteMode: 'p16-dev', viteFlag: '1' })).toBe(true);
  });
  it('keeps preview content, rules 2 and market gates locked in the default CI environment', () => {
    expect(DEV_CARRIER_HULL_ID).toBe(CARRIER_HULL);
    expect(DEV_CARRIER_RELEASE).toBe(false);
    expect(BATTLE_RULES).toBe(2);
    expect(CONTENT.hulls[CARRIER_HULL].preview).toBe(true);
    expect(hullReleased(CARRIER_HULL)).toBe(false);
    expect(gearReleased('eq_wing_fighter')).toBe(false);
    expect(gearReleased('air_control')).toBe(false);
  });
});
