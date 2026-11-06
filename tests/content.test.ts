import { describe, it, expect } from 'vitest';
import { CONTENT, buildRegistry, presetMounts, legacyOf, variantLayout } from '../src/content/registry';
import { validateContent, weaponFits, type AssetFs } from '../src/content/validate';
import { PACKS } from '../src/content/packs';
import { nodeAssetFs } from '../src/content/assetFs';
import type { ContentPack } from '../src/content/schema';
import { SHIP_CLASSES, getLoadout } from '../src/sim/data/ships';
import { WorldSim } from '../src/world/sim';
import { census, compareCensus, migrateContent, CONTENT_VERSION } from '../src/world/migrate';
import type { WorldState } from '../src/world/types';

const errors = (packs: ContentPack[], fs?: AssetFs) => validateContent(buildRegistry(packs), fs).filter(i => i.level === 'error');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const core = () => clone(PACKS[0]);
const run = (sim: WorldSim, seconds: number, dt = 0.5) => { for (let t = 0; t < seconds; t += dt) sim.update(dt); };

describe('content registry (P1)', () => {
  it('the shipped packs and public/assets/content validate without errors or warnings', () => {
    expect(validateContent(CONTENT, nodeAssetFs())).toEqual([]);
  });

  it('every old class/loadout maps to a hull, variant and preset that rebuild exactly the same ship', () => {
    let n = 0;
    for (const c of Object.values(SHIP_CLASSES)) for (const l of c.loadouts) {
      const m = legacyOf(c.id, l.id)!;
      expect(CONTENT.hulls[m.hull].classId).toBe(c.id);
      const key = (x: { weapon: string; pos: number[]; facing: number; arc: number }) => `${x.weapon}|${x.pos}|${x.facing}|${x.arc}`;
      expect(presetMounts(m.preset).map(key).sort()).toEqual(getLoadout(c.id, l.id).mounts.map(key).sort());
      n++;
    }
    expect(n).toBe(25);
    // unknown loadout ids fall back like getLoadout()
    expect(legacyOf('cruiser', 'nope')!.preset).toBe(`cruiser_${getLoadout('cruiser', 'nope').id}`);
    // structural changes live in variants, not in presets
    expect(CONTENT.variants[legacyOf('battleship', 'fortress')!.variant].mods).toEqual({ hpMul: 1.1, armorMul: 1.18, speedMul: 0.82 });
    expect(legacyOf('battleship', 'std')!.variant).toBe('battleship_mk1_std');
  });

  it('hardpoint compatibility rules', () => {
    const hp = (size: any, type: any) => ({ id: 'hp', pos: [0, 0, 0] as [number, number, number], facing: 0, arc: 90, size, type, mount: 'turret' as const });
    expect(weaponFits('heavy_cannon', hp('M', 'ballistic'))).toMatch(/크기/);
    expect(weaponFits('heavy_cannon', hp('L', 'ballistic'))).toBeNull();
    expect(weaponFits('pulse_laser', hp('M', 'ballistic'))).toMatch(/에너지/);
    expect(weaponFits('pulse_laser', hp('M', 'universal'))).toBeNull();
    expect(weaponFits('pd_gun', hp('S', 'missile'))).toBeNull();      // PD fits any hardpoint of its size
    expect(weaponFits('autocannon', hp('S', 'pd'))).toMatch(/방공/);  // a PD hardpoint takes only PD
  });

  it('variant layouts add and remove hardpoints without touching the hull', () => {
    const p = core();
    p.variants!.push({ id: 'cruiser_mk1_spine', hull: 'cruiser_mk1', name: '척추포형', desc: 't', blueprint: 'advanced',
      hardpoints: { remove: ['hp01'], add: [{ id: 'sp1', pos: [0, 2, 12], facing: 0, arc: 8, size: 'L', type: 'energy', mount: 'spinal' }] } });
    const reg = buildRegistry([p]);
    const lay = variantLayout('cruiser_mk1_spine', reg)!;
    expect(lay.hardpoints.some(h => h.id === 'hp01')).toBe(false);
    expect(lay.hardpoints.some(h => h.id === 'sp1')).toBe(true);
    expect(reg.hulls.cruiser_mk1.hardpoints.some(h => h.id === 'hp01')).toBe(true);
    expect(validateContent(reg).filter(i => i.level === 'error')).toEqual([]);
  });

  it('the validator rejects broken content', () => {
    const cases: [string, (p: ContentPack) => void, RegExp][] = [
      ['duplicate hull', p => p.hulls!.push(clone(p.hulls![0])), /중복 id/],
      ['unknown class', p => { p.hulls![0].classId = 'nope'; }, /SHIP_CLASSES/],
      ['hardpoint off the hull', p => { p.hulls![0].hardpoints[0].pos = [0, 0, 900]; }, /선체 범위/],
      ['duplicate hardpoint id', p => { p.hulls![1].hardpoints[1].id = p.hulls![1].hardpoints[0].id; }, /하드포인트 id 중복/],
      ['bad arc', p => { p.hulls![2].hardpoints[0].arc = 0; }, /arc/],
      ['weapon too big for hardpoint', p => { const pr = p.presets!.find(x => x.id === 'corvette_gun')!; pr.weapons.hp02 = 'eq_heavy_cannon'; }, /크기/],
      ['preset on a missing hardpoint', p => { p.presets![0].weapons.zz9 = 'eq_pd_gun'; }, /없는 하드포인트/],
      ['variant of a missing hull', p => { p.variants![0].hull = 'ghost'; }, /hull "ghost" 없음/],
      ['legacy fidelity broken', p => { const pr = p.presets!.find(x => x.id === 'destroyer_aa')!; pr.weapons.hp01 = 'eq_autocannon'; }, /기존 로드아웃과 다름/],
      ['structure drift', p => { p.variants!.find(v => v.id === 'battleship_mk1_fortress')!.mods!.armorMul = 1.3; }, /구조 보정/],
      ['legacy mapping missing', p => { p.legacy!.pop(); }, /매핑되지 않음/],
      ['out-of-range mods', p => { p.variants![0].mods = { speedMul: 3 }; }, /0\.5~1\.5/],
    ];
    for (const [name, mut, re] of cases) {
      const p = core(); mut(p);
      const e = errors([p]);
      expect(e.some(i => re.test(i.msg)), `${name}: ${JSON.stringify(e.slice(0, 3))}`).toBe(true);
    }
  });

  it('asset registration: directory, extension, target, size, missing and unregistered files', () => {
    const files: Record<string, number> = { 'models/destroyer_mk1.glb': 900_000, 'icons/eq_laser.svg': 3_000, 'icons/stray.png': 100, 'portraits/huge.webp': 900_000 };
    const fs: AssetFs = { size: f => files[f] ?? null, list: () => Object.keys(files) };
    const p = core();
    p.assets = [
      { id: 'model.destroyer_mk1', kind: 'ship-model', file: 'models/destroyer_mk1.glb', for: 'destroyer_mk1', license: 'CC0' },
      { id: 'icon.eq_laser', kind: 'equipment-icon', file: 'icons/eq_laser.svg', for: 'eq_laser', license: 'CC0' },
      { id: 'portrait.huge', kind: 'portrait', file: 'portraits/huge.webp', for: 'pool:veteran', license: 'CC0' },
    ];
    p.hulls!.find(h => h.id === 'destroyer_mk1')!.mesh.model = 'model.destroyer_mk1';
    const e = errors([p], fs).map(i => i.where + ': ' + i.msg);
    expect(e.some(m => m.includes('icons/stray.png') && /등록되지 않은/.test(m))).toBe(true);
    expect(e.some(m => m.startsWith('asset portrait.huge') && /크기/.test(m))).toBe(true);
    expect(e.filter(m => m.startsWith('asset icon.') || m.startsWith('hull '))).toEqual([]);
    // P8: a model on a core (mk1) hull is refused (legacy worlds keep their look), and models pin a sha256
    const me = e.filter(m => m.startsWith('asset model.'));
    expect(me.length).toBeGreaterThan(0);
    expect(me.every(m => /기본\(core\) 선체 destroyer_mk1|sha256 필수/.test(m))).toBe(true);
    // wrong directory / extension / target / missing file
    const q = core();
    q.assets = [{ id: 'model.bad', kind: 'ship-model', file: 'icons/bad.png', for: 'not_a_hull', license: 'CC0' }];
    const e2 = errors([q], { size: () => null, list: () => [] }).map(i => i.msg).join(' | ');
    expect(e2).toMatch(/models\/ 아래/); expect(e2).toMatch(/확장자/); expect(e2).toMatch(/존재하는 hull/); expect(e2).toMatch(/파일 없음/);
  });
});

describe('content save migration (P1)', () => {
  /** a lived-in world (player fleet, refits, NPC traffic) turned back into a pre-content save */
  function oldSave(): { st: WorldState; p: string } {
    const sim = WorldSim.create(11);
    const p = sim.addPlayer('이관 테스트');
    sim.st.companies[p].credits = 20_000_000; sim.st.companies[p].rep = 1000;
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'battleship', loadoutId: 'fortress' })).toBeNull();
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'cruiser', loadoutId: 'missile' })).toBeNull();
    run(sim, 120);
    const st: WorldState = JSON.parse(sim.serialize());
    delete st.contentV; delete st.grants; delete st.conversions;
    for (const s of Object.values(st.ships)) { delete s.hull; delete s.variant; delete s.fitting; }
    for (const x of Object.values(st.stations)) for (const b of x.builds ?? []) { delete b.hull; delete b.variant; }
    return { st, p };
  }

  it('fills hull + variant on every ship, conserves every asset, is idempotent and round-trips', () => {
    const { st, p } = oldSave();
    const before = census(st);
    expect(before.equipment.eq_heavy_cannon).toBeGreaterThan(0); // mounted weapons are counted as assets
    const sim = new WorldSim(st);
    const rep = sim.contentReport!;
    expect(rep.from).toBe(0); expect(rep.to).toBe(CONTENT_VERSION);
    expect(rep.unmapped).toEqual([]);
    // the only grants are the v3 blueprint ledger (rights, not items); no equipment or ship is granted
    expect(rep.granted.filter(g => g.v < 3)).toEqual([]);
    for (const g of rep.granted) expect(g.item).toMatch(/^blueprint:/);
    expect(rep.ships).toBe(Object.keys(sim.st.ships).length);
    for (const s of Object.values(sim.st.ships)) {
      expect(sim.st.ships[s.id].hull).toBe(legacyOf(s.classId, s.loadoutId)!.hull);
      expect(s.variant).toBe(legacyOf(s.classId, s.loadoutId)!.variant);
    }
    const bs = Object.values(sim.st.ships).find(s => s.owner === p && s.classId === 'battleship')!;
    expect(bs.variant).toBe('battleship_mk1_fortress');
    expect(compareCensus(before, census(sim.st))).toEqual([]);
    // idempotent
    const again = migrateContent(sim.st);
    expect(again.ships + again.builds).toBe(0);
    // serialize → load is identical
    const s1 = sim.serialize();
    expect(new WorldSim(JSON.parse(s1)).serialize()).toBe(s1);
  });

  it('census catches duplicated or lost equipment unless the migration recorded it as granted', () => {
    const { st, p } = oldSave();
    const before = census(st);
    const own = Object.values(st.stations).find(x => x.storage[p])!;
    const dup = clone(st); Object.values(dup.stations).find(x => x.id === own.id)!.storage[p].eq_pd_gun = 7;
    expect(compareCensus(before, census(dup)).join()).toMatch(/eq_pd_gun/);
    const lost = clone(st); Object.values(lost.ships).find(s => s.owner === p && s.classId === 'cruiser')!.loadoutId = 'gun';
    expect(compareCensus(before, census(lost)).join()).toMatch(/missile_rack/);
    // the same extra item, recorded as a grant, is accepted
    const granted = clone(st); Object.values(granted.stations).find(x => x.id === own.id)!.storage[p].eq_pd_gun = 7;
    granted.grants = [{ v: 1, at: 0, company: p, ref: own.id, item: 'eq_pd_gun', n: 7, why: 'test' }];
    expect(compareCensus(before, census(granted)).filter(x => /equipment/.test(x))).toEqual([]);
  });

  it('dry-run mode leaves an old save untouched; new ships stay unmarked until the migration is applied', () => {
    const { st, p } = oldSave();
    const sim = new WorldSim(st, { migrateContent: false });
    expect(sim.contentReport).toBeNull();
    expect(sim.st.contentV ?? 0).toBe(0);
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'destroyer', loadoutId: 'aa' })).toBeNull();
    expect(Object.values(sim.st.ships).every(s => s.hull === undefined)).toBe(true);
  });

  it('rollback and roll forward: ships created by the previous code version are repaired on load', () => {
    const { st, p } = oldSave();
    const migrated: WorldState = JSON.parse(new WorldSim(st).serialize());
    // the previous code (no content model) keeps unknown fields and adds a ship without them
    const prev = new WorldSim(clone(migrated), { migrateContent: false });
    expect(prev.command(p, { c: 'buyShip', station: 'astra', classId: 'destroyer', loadoutId: 'strike' })).toBeNull();
    const back: WorldState = JSON.parse(prev.serialize());
    const fresh = Object.values(back.ships).find(s => s.owner === p && s.classId === 'destroyer')!;
    delete fresh.hull; delete fresh.variant; delete fresh.fitting;
    const sim = new WorldSim(back, { migrateContent: false });
    expect(sim.st.ships[fresh.id].hull).toBe('destroyer_mk1');
    expect(sim.st.ships[fresh.id].variant).toBe('destroyer_mk1_std');
  });

  it('refits and new builds keep hull/variant in step with the loadout', () => {
    const sim = WorldSim.create(12);
    const p = sim.addPlayer('개조');
    sim.st.companies[p].credits = 20_000_000; sim.st.companies[p].rep = 1000;
    expect(sim.command(p, { c: 'buyShip', station: 'helios', classId: 'battleship', loadoutId: 'std' })).toBeNull();
    const s = Object.values(sim.st.ships).find(x => x.owner === p && x.classId === 'battleship')!;
    expect(s.variant).toBe('battleship_mk1_std');
    sim.st.ships[s.id].task = { k: 'docked', station: 'helios' } as any;
    const r = sim.command(p, { c: 'refit', ship: s.id, loadoutId: 'fortress' });
    expect(r).toBeNull();
    expect(sim.st.ships[s.id].variant).toBe('battleship_mk1_fortress');
  });
});

describe('Codex content guide (docs/CODEX_CONTENT_GUIDE.md §3)', () => {
  it('the example pack in the guide validates, and is usable by the fitting rules', async () => {
    const md = (await import('node:fs')).readFileSync('docs/CODEX_CONTENT_GUIDE.md', 'utf8');
    const code = md.slice(md.indexOf('export const FRONTIER_PACK'), md.indexOf('};', md.indexOf('export const FRONTIER_PACK')) + 2)
      .replace('export const FRONTIER_PACK: ContentPack =', 'return');
    const pack = new Function(code)() as ContentPack;
    const reg = buildRegistry([...PACKS, pack]);
    expect(validateContent(reg)).toEqual([]);
    const { checkFitting } = await import('../src/world/fitting');
    const p = reg.presets.cruiser_picket_aa;
    expect(checkFitting(p.variant, { hp: p.weapons, bay: {} }, reg).errors).toEqual([]);
    expect(presetMounts(p.id, reg).filter(m => m.weapon === 'pd_gun').length).toBe(5);
  });
});
