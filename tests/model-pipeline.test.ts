// P8 pipeline: external ship models. The GLB inspector, the model checks of the content validator,
// the render-only model id travelling from content data to both renderers, the dev-hull gates, and
// legacy (c0) worlds staying untouched. Guide §26–§31.
import { describe, it, expect, vi } from 'vitest';
vi.setConfig({ testTimeout: 300_000 });
import { createHash } from 'node:crypto';
import { CONTENT, buildRegistry } from '../src/content/registry';
import { PACKS } from '../src/content/packs';
import { MODELTEST_PACK, MODELTEST_ASSETS, TESTBED_DD_HP } from '../src/content/packs/modeltest';
import { validateContent, type AssetFs } from '../src/content/validate';
import { nodeAssetFs } from '../src/content/assetFs';
import { inspectGlb, MODEL_STD } from '../src/content/modelSpec';
import { hullDrawLength } from '../src/content/validateModels';
import { writeGlb } from '../scripts/models/glb';
import { shipLoadout } from '../src/world/fitting';
import { yardHulls } from '../src/world/hullops';
import { WorldSim } from '../src/world/sim';
import { newWorld } from '../src/world/worldgen';
import { World } from '../src/sim/world';
import type { FleetSpec } from '../src/sim/fleet';
import type { ContentPack } from '../src/content/schema';
import * as THREE from 'three';

const fsReal = nodeAssetFs();
const errorsOf = (packs: ContentPack[], fs: AssetFs = fsReal) => validateContent(buildRegistry(packs), fs).filter(i => i.level === 'error').map(i => `${i.where}: ${i.msg}`);
const withoutTest = PACKS.filter(p => p !== MODELTEST_PACK);
/** the model test pack with a patched asset / hull list */
const patched = (o: Partial<ContentPack>) => [...withoutTest, { ...MODELTEST_PACK, ...o }];
/** an AssetFs that serves extra in-memory files on top of the real folder */
function overlay(extra: Record<string, Uint8Array>): AssetFs {
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  return {
    size: f => extra[f]?.length ?? fsReal.size(f),
    list: () => [...fsReal.list(), ...Object.keys(extra)],
    read: f => extra[f] ?? fsReal.read!(f),
    sha256: f => extra[f] ? sha(extra[f]) : fsReal.sha256!(f),
  };
}
/** a simple box-hull GLB of the given extents with hp_ markers (to provoke specific errors) */
function boxGlb(dx: number, dy: number, dz: number, markers: { name: string; pos: [number, number, number]; scale?: number }[] = []) {
  const g = new THREE.BoxGeometry(dx, dy, dz).toNonIndexed(); g.deleteAttribute('uv');
  return writeGlb('t', [{ mat: { name: 'sid_hull', color: [1, 1, 1], metal: 0, rough: 1 }, geo: g }], markers);
}

describe('model pipeline (P8)', () => {
  it('inspects the fixture GLBs: structure, size, markers', () => {
    const dd = inspectGlb(fsReal.read!('models/fixtures/testbed_destroyer.glb')!);
    expect(dd.ok).toBe(true);
    expect(dd.version).toBe('2.0');
    expect(dd.max[2] - dd.min[2]).toBeCloseTo(26.4, 1);
    expect(dd.hp.map(m => m.name).sort()).toEqual(TESTBED_DD_HP.map(h => `hp_${h.id}`).sort());
    expect(dd.engines.length).toBe(2);
    expect(dd.engines.every(e => e.pos[2] < 0)).toBe(true);
    expect(dd.triangles).toBeLessThan(MODEL_STD.tris.M);
    expect(dd.materials).toContain('sid_accent');
    const lod = inspectGlb(fsReal.read!('models/fixtures/testbed_destroyer_lod.glb')!);
    expect(lod.triangles).toBeLessThanOrEqual(dd.triangles * MODEL_STD.lodShare);
    const hl = inspectGlb(fsReal.read!('models/fixtures/testbed_hauler.glb')!);
    expect(hl.max[2] - hl.min[2]).toBeCloseTo(hullDrawLength(CONTENT.hulls.testbed_hauler), 1);
    expect(inspectGlb(new TextEncoder().encode('<!doctype html><html>not a model</html>')).ok).toBe(false);
  });

  it('the shipped content (with the fixtures) validates clean, hashes pinned', () => {
    expect(validateContent(CONTENT, fsReal).filter(i => i.level === 'error')).toEqual([]);
    for (const a of MODELTEST_ASSETS) expect(a.sha256).toBe(fsReal.sha256!(a.file));
  });

  it('reports missing files, changed files, broken files and bad axes', () => {
    const [dd, lod, hl] = MODELTEST_ASSETS;
    // missing file
    let e = errorsOf(patched({ assets: [{ ...dd, file: 'models/fixtures/nope.glb' }, lod, hl] }));
    expect(e.join('\n')).toMatch(/nope\.glb/);
    // file replaced but hash not updated
    e = errorsOf(patched({}), overlay({ 'models/fixtures/testbed_hauler.glb': boxGlb(8, 6, 50) }));
    expect(e.join('\n')).toMatch(/sha256 과 다름/);
    // not a GLB at all (e.g. an HTML error page saved under the name)
    const html = new TextEncoder().encode('<!doctype html><html><body>404</body></html>');
    e = errorsOf(patched({ assets: [dd, lod, { ...hl, file: 'models/fixtures/bad.glb', sha256: createHash('sha256').update(html).digest('hex') }] }), overlay({ 'models/fixtures/bad.glb': html }));
    expect(e.join('\n')).toMatch(/GLB 매직/);
    // exported lying on its side (longest axis x): bow must face +z
    const side = boxGlb(50, 6, 8);
    e = errorsOf(patched({ assets: [dd, lod, { ...hl, file: 'models/fixtures/side.glb', sha256: createHash('sha256').update(side).digest('hex') }] }), overlay({ 'models/fixtures/side.glb': side }));
    expect(e.join('\n')).toMatch(/가장 긴 축이 z 가 아님/);
    // wrong unit scale (exported in centimetres)
    const cm = boxGlb(800, 600, 5000);
    e = errorsOf(patched({ assets: [dd, lod, { ...hl, file: 'models/fixtures/cm.glb', sha256: createHash('sha256').update(cm).digest('hex') }] }), overlay({ 'models/fixtures/cm.glb': cm }));
    expect(e.join('\n')).toMatch(/모델 길이 5000\.0 가 목표 50\.0/);
    // sha256 missing
    e = errorsOf(patched({ assets: [dd, lod, { ...hl, sha256: undefined }] }));
    expect(e.join('\n')).toMatch(/sha256 필수/);
  });

  it('checks hp_ markers against the hardpoint data', () => {
    const [dd, lod, hl] = MODELTEST_ASSETS;
    const glb = boxGlb(10, 6, 50, [{ name: 'hp_pd1', pos: [5, 5.2, 12] }, { name: 'hp_pd2', pos: [5, 5.2, -12] }, { name: 'engine_1', pos: [0, 0, -25] }]);
    const e = errorsOf(patched({ assets: [dd, lod, { ...hl, file: 'models/fixtures/hp.glb', sha256: createHash('sha256').update(glb).digest('hex') }] }), overlay({ 'models/fixtures/hp.glb': glb }));
    expect(e.join('\n')).toMatch(/hp_pd2 마커 .* 하드포인트 데이터 \[-5,5\.2,-12\] 와 10\.00 떨어짐/);
    expect(e.join('\n')).not.toMatch(/hp_pd1/);
  });

  it('keeps test fixtures off real hulls and models off the legacy (core) hulls', () => {
    const [dd, lod, hl] = MODELTEST_ASSETS;
    // a fixture on a non-dev hull
    const h = MODELTEST_PACK.hulls!.map(x => x.id === 'testbed_hauler' ? { ...x, dev: false } : x);
    let e = errorsOf(patched({ hulls: h }));
    expect(e.join('\n')).toMatch(/fixture\(테스트\) 모델을 실제 선체에 연결할 수 없음/);
    // a model on a core (c0) hull — patch destroyer_mk1 in the core pack
    const core = PACKS[0];
    const core2 = { ...core, hulls: core.hulls!.map(x => x.id === 'destroyer_mk1' ? { ...x, mesh: { ...x.mesh, model: 'model.real_dd' } } : x) };
    const real = { ...dd, id: 'model.real_dd', for: 'destroyer_mk1', fixture: false, lod: undefined, file: 'models/real_dd.glb' };
    e = validateContent(buildRegistry([core2, ...PACKS.slice(1, -1), { ...MODELTEST_PACK, assets: [dd, lod, hl, real] }]), overlay({ 'models/real_dd.glb': fsReal.read!('models/fixtures/testbed_destroyer.glb')! })).filter(i => i.level === 'error').map(i => i.msg);
    expect(e.join('\n')).toMatch(/기본\(core\) 선체 destroyer_mk1 에는 모델을 연결하지 않는다/);
    // a dev hull that can be bought
    e = errorsOf(patched({ hulls: MODELTEST_PACK.hulls!.map(x => x.id === 'testbed_hauler' ? { ...x, sale: { stations: ['astra'], stock: 1, restock: 600 } } as any : x) }));
    expect(e.join('\n')).toMatch(/testbed_hauler/);
  });

  it('carries the model id to both renderers (render-only)', () => {
    const fit = { hp: { ...CONTENT.presets.testbed_dd_mixed.weapons }, bay: {} };
    const lo = shipLoadout({ classId: 'destroyer', loadoutId: '', variant: 'testbed_destroyer_std', fitting: fit });
    expect(lo.mesh).toEqual({ base: 'destroyer', scale: 1.1, model: 'model.testbed_destroyer' });
    expect(lo.mounts.map(m => m.pos)).toEqual(TESTBED_DD_HP.map(h => h.pos));
    // legacy mk1 hulls: no mesh override at all (bit-identical loadouts)
    const mk1 = shipLoadout({ classId: 'destroyer', loadoutId: 'std', variant: 'destroyer_mk1_std', fitting: { hp: {}, bay: {} } });
    expect(mk1.mesh).toBeUndefined();
    // the battle spec and the battle world's loadout carry it; combat numbers are the same without it
    const sim = new WorldSim(newWorld(3));
    const p = sim.addPlayer('모델');
    const g = sim.newGroup(p, '시험');
    const s = sim.spawnHull(p, 'testbed_destroyer', 'testbed_destroyer_std', 'testbed_dd_mixed', g.id, sim.st.stations.astra.pos);
    const spec = sim.fittingSpec(s)!;
    expect(spec.mesh?.model).toBe('model.testbed_destroyer');
    const fleet = (fitX: typeof spec | undefined, loadoutId = s.loadoutId): FleetSpec => ({ name: 'f', root: { name: 'g', order: 'engage', retreatAt: 0, ships: [{ classId: 'destroyer', loadoutId, ...(fitX ? { fit: fitX } : {}) }], children: [] } } as any);
    const run = (fitX: typeof spec) => { const w = new World({ seed: 5, scenarioId: 'kestrel', fleets: [fleet(fitX), fleet(undefined, 'std')] }); for (let i = 0; i < 1800; i++) w.step(); return w.ships.map(x => [x.hp.toFixed(3), x.state, x.pos.x.toFixed(3)]).join('|'); };
    const w1 = new World({ seed: 5, scenarioId: 'kestrel', fleets: [fleet(spec), fleet(undefined, 'std')] });
    expect(w1.ships[0].loadout.mesh?.model).toBe('model.testbed_destroyer');
    const { mesh: _m, ...noMesh } = spec;
    expect(run(spec)).toBe(run(noMesh));
  });

  it('dev hulls cannot be bought, built or listed', () => {
    const sim = new WorldSim(newWorld(4));
    const p = sim.addPlayer('개발');
    sim.st.companies[p].credits = 1e8;
    for (const st of Object.values(sim.st.stations)) expect(yardHulls(st).some(h => CONTENT.hulls[h].dev)).toBe(false);
    expect(sim.command(p, { c: 'buyShip', station: 'astra', classId: 'destroyer', loadoutId: '', hull: 'testbed_destroyer', variant: 'testbed_destroyer_std' } as any)).toMatch(/개발용 선체/);
    expect(sim.command(p, { c: 'buildShip', station: 'astra', classId: 'hauler', loadoutId: '', hull: 'testbed_hauler', variant: 'testbed_hauler_std' } as any)).toMatch(/개발용 선체|자사 정거장/);
    expect((sim as any).hullChoice({ classId: 'hauler', loadoutId: '', hull: 'testbed_hauler' })).toMatch(/개발용 선체/);
  });

  it('a legacy (c0) world never meets a model', () => {
    const c0 = new WorldSim(newWorld(7), { migrateContent: false });
    for (let i = 0; i < 120; i++) c0.update(1);
    expect(c0.st.contentV ?? 0).toBe(0);
    for (const s of Object.values(c0.st.ships)) {
      expect(shipLoadout(s).mesh?.model).toBeUndefined();
      expect(c0.fittingSpec(s)?.mesh?.model).toBeUndefined();
    }
  });
});
