// Exploration (growth, contentV ≥ 4): derelicts, wreck fields and lost archives scattered through
// the non-core systems. A site is hidden until a company surveys its system (ships flying a sweep);
// then any group of that company can salvage it — work proportional to the site's tier, done on the
// spot, far from repair docks. Salvage yields rare goods, blueprint fragments and, from deep sites,
// whole blueprints that are never sold (BlueprintSource kind 'explore'). Danger is the point: tier 3
// sites lie in lawless space where pirates roam. Deterministic: positions come from hashId, loot from
// the world RNG.
import { CONTENT } from '../content/registry';
import type { BlueprintSource } from '../content/schema';
import type { Site, StarSystem, WorldState, Company } from './types';
import { hashId } from './geom';
import { fragId, grantBlueprint, holds } from './blueprints';

/** sites kept per system and their respawn delay once salvaged (s) */
export const SITES_PER_SYS = 2;
export const RESPAWN_S = 4 * 3600;
/** survey ship-seconds to find a hidden site, by tier */
export const SCAN_NEED = [0, 240, 600, 1200];
/** salvage ship-seconds (miners/constructors count double), by tier */
export const WORK_NEED = [0, 900, 2400, 5400];
const NAMES: [string, string][] = [['유기 화물선', '난파 수송선단'], ['전쟁 잔해 지대', '버려진 채광 기지'], ['고대 함대 묘지', '봉인된 연구 기록고']];

export function siteTier(sys: StarSystem): number { return sys.security >= 50 ? 1 : sys.security >= 25 ? 2 : 3; }
const eligible = (sys: StarSystem) => sys.kind !== 'core' && sys.security < 90;

function makeSite(sys: StarSystem, n: number, born: number): Site {
  const h = hashId(`${sys.id}:site:${n}`);
  const a = (h % 3600) / 3600 * Math.PI * 2;
  const r = sys.radius * (0.4 + ((h >>> 12) % 1000) / 1000 * 0.45);
  const tier = siteTier(sys);
  return {
    id: `site_${sys.id}_${n}`, system: sys.id, tier, born,
    pos: { x: sys.origin.x + Math.cos(a) * r, y: 0, z: sys.origin.z + Math.sin(a) * r },
    name: `${sys.name} ${NAMES[tier - 1][(h >>> 4) % 2]}`,
    scan: {}, seen: [], work: 0, need: WORK_NEED[tier],
  };
}

/** give every eligible system its sites (idempotent; c4 migration and new worlds) */
export function seedSites(w: WorldState) {
  const S = (w.sites ??= {});
  for (const sys of Object.values(w.systems)) {
    if (!eligible(sys)) continue;
    const have = Object.values(S).filter(s => s.system === sys.id).length;
    for (let n = have; n < SITES_PER_SYS; n++) { const s = makeSite(sys, n, 0); S[s.id] = s; }
  }
}

export const siteActive = (s: Site | undefined, t: number) => !!s && s.born <= t;
export const knows = (s: Site, co: string) => s.seen.includes(co);
export const sitesIn = (w: WorldState, sys: string, t: number) => Object.values(w.sites ?? {}).filter(s => s.system === sys && siteActive(s, t));

/** a survey sweep: `power` ship-seconds of scanning in a system. Returns sites found this step. */
export function surveyStep(w: WorldState, co: string, sys: string, power: number): Site[] {
  const found: Site[] = [];
  for (const s of sitesIn(w, sys, w.time)) {
    if (knows(s, co)) continue;
    s.scan[co] = (s.scan[co] ?? 0) + power;
    if (s.scan[co] >= SCAN_NEED[s.tier]) { s.seen.push(co); delete s.scan[co]; found.push(s); }
  }
  return found;
}

/** survey left to do in a system for this company (0 = nothing hidden) */
export function surveyLeft(w: WorldState, co: string, sys: string): number {
  const hid = sitesIn(w, sys, w.time).filter(s => !knows(s, co));
  return hid.length ? Math.min(...hid.map(s => SCAN_NEED[s.tier] - (s.scan[co] ?? 0))) : 0;
}

export interface Haul { cargo: Record<string, number>; blueprints: string[] }
/** what a finished salvage yields (goods + fragments into the salvagers' holds, whole blueprints granted) */
export function salvageLoot(w: WorldState, co: Company, site: Site, rng: () => number): Haul {
  const T = site.tier;
  const cargo: Record<string, number> = {};
  const add = (k: string, n: number) => { if (n > 0) cargo[k] = (cargo[k] ?? 0) + n; };
  // salvaged goods: worth far more per tonne than ore, and the deeper the better
  add('alloy', Math.round(60 * T + rng() * 60 * T));
  add('rare_metal', Math.round((T - 1) * 25 + rng() * 20 * T));
  add('electronics', Math.round(T * 8 + rng() * 10));
  if (T >= 2) add('precision', Math.round(T * 3 + rng() * 4));
  if (T >= 3) add('sensor', Math.round(1 + rng() * 2));
  // blueprint fragments: of anything restorable from salvage (deeper → more rolls)
  const frag = Object.values(CONTENT.blueprints).filter(b => b.sources.some(s => s.kind === 'salvage') && !holds(co, b.id));
  for (let i = 0; i < T * 2 && frag.length; i++) if (rng() < 0.45) add(fragId(frag[Math.floor(rng() * frag.length)].id), 1);
  // archives: whole blueprints that are found, never bought
  const blueprints: string[] = [];
  for (const b of Object.values(CONTENT.blueprints)) {
    if (holds(co, b.id)) continue;
    const s = b.sources.find(x => x.kind === 'explore') as Extract<BlueprintSource, { kind: 'explore' }> | undefined;
    if (s && T >= s.tier && rng() < s.chance * (1 + (T - s.tier) * 0.5) && grantBlueprint(w, co, b.id, 'explore', w.time)) blueprints.push(b.id);
  }
  return { cargo, blueprints };
}

/** salvaged sites vanish and a new one appears in the same system after a while */
export function retireSite(w: WorldState, site: Site) {
  const sys = w.systems[site.system];
  delete w.sites![site.id];
  if (!sys) return;
  let n = 0; while (w.sites![`site_${sys.id}_${n}`]) n++;
  const ns = makeSite(sys, n + Math.floor(w.time / RESPAWN_S) * 7, w.time + RESPAWN_S);
  ns.id = `site_${sys.id}_${n}`;
  w.sites![ns.id] = ns;
}
