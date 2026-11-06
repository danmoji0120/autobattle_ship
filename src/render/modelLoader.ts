// External ship models (P8 pipeline). Loads a registered GLB once, normalises it to the hull's drawn
// length (model standard: src/content/modelSpec.ts), bakes it into a reusable template — geometry per
// material, already split into the front/rear halves the wreck effect needs — and hands every ship of
// that model the same geometries. A missing or broken file resolves to null: callers keep the
// procedural hull (ships never disappear and the game never throws because of a model).
//
// Render only. Nothing here is read by the combat engine.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONTENT, assetUrl } from '../content/registry';
import { MODEL_STD } from '../content/modelSpec';
import type { AssetDef } from '../content/schema';

/** team materials a model can ask for by name (sid_*) — the procedural hull's own materials */
export type TeamSlot = 'hull' | 'dark' | 'trim' | 'accent' | 'light';
export interface ModelPart { geo: THREE.BufferGeometry; slot?: TeamSlot; mat?: THREE.Material }
export interface ModelLevel { front: ModelPart[]; rear: ModelPart[]; triangles: number }
export interface ModelTemplate {
  id: string;
  length: number;
  hi: ModelLevel;
  lo?: ModelLevel;
  /** nozzle exit centres (game units, ship frame) and radii */
  engines: { x: number; y: number; z: number; r: number }[];
  lights: THREE.Vector3[];
  /** distance from which the LOD level is drawn (0 = no LOD) */
  lodDistance: number;
}

const SLOT: Record<string, TeamSlot> = { sid_hull: 'hull', sid_dark: 'dark', sid_trim: 'trim', sid_accent: 'accent', sid_light: 'light' };

/** load statistics (also exposed as window.__sidModels for tests and the perf check) */
export const modelStats = { requests: 0, fetches: 0, loaded: 0, failed: 0, ms: 0, templates: 0 };
const pending = new Map<string, Promise<ModelTemplate | null>>();
const ready = new Map<string, ModelTemplate | null>();
const warned = new Set<string>();

/** `?models=0` (or localStorage sid.models = "0") draws every ship procedurally — a kill switch and
 *  the visual fallback check */
export function modelsEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('models') === '0') return false;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('sid.models') === '0') return false;
  } catch { /* storage blocked: models on */ }
  return typeof document !== 'undefined';
}

export const modelUrl = (a: AssetDef) => `${assetUrl(a)}?v=${(a.sha256 ?? '').slice(0, 12) || 'dev'}`;

/** the template if it is already loaded (null = failed / unavailable, undefined = not loaded yet) */
export function modelReady(id: string, length: number): ModelTemplate | null | undefined {
  return ready.get(`${id}@${length}`);
}

/** load (once) and normalise a model to `length` game units */
export function loadModel(id: string, length: number): Promise<ModelTemplate | null> {
  modelStats.requests++;
  const key = `${id}@${length}`;
  let p = pending.get(key);
  if (p) return p;
  p = build(id, length).then(t => { ready.set(key, t); if (t) modelStats.templates++; return t; });
  pending.set(key, p);
  return p;
}

const files = new Map<string, Promise<THREE.Group | null>>();
function fetchScene(a: AssetDef): Promise<THREE.Group | null> {
  let p = files.get(a.id);
  if (p) return p;
  modelStats.fetches++;
  const t0 = performance.now();
  p = new GLTFLoader().loadAsync(modelUrl(a)).then(g => { modelStats.loaded++; modelStats.ms += performance.now() - t0; return g.scene as THREE.Group; }, e => {
    modelStats.failed++;
    if (!warned.has(a.id)) { warned.add(a.id); console.warn(`[model] ${a.id} (${a.file}) 불러오기 실패 — 절차적 선체로 표시`, e?.message ?? e); }
    return null;
  });
  files.set(a.id, p);
  return p;
}

async function build(id: string, length: number): Promise<ModelTemplate | null> {
  const a = CONTENT.assets[id];
  if (!a || !modelsEnabled()) return null;
  try {
    const scene = await fetchScene(a);
    if (!scene) return null;
    const norm = normaliser(scene, length, !!a.recenter);
    if (!norm) { warnOnce(id, '메시 없음'); return null; }
    const hi = bake(scene, norm.m);
    const engines: ModelTemplate['engines'] = [], lights: THREE.Vector3[] = [];
    scene.traverse(o => {
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(norm.m);
      if (/^engine_/.test(o.name)) { const s = new THREE.Vector3().setFromMatrixScale(o.matrixWorld); engines.push({ x: p.x, y: p.y, z: p.z, r: Math.max(0.15, (s.x + s.y + s.z) / 3 * norm.k) }); }
      else if (/^light_/.test(o.name)) lights.push(p);
    });
    let lo: ModelLevel | undefined;
    const la = a.lod ? CONTENT.assets[a.lod] : undefined;
    if (la) {
      const ls = await fetchScene(la);
      const ln = ls && normaliser(ls, length, !!a.recenter);
      if (ls && ln) lo = bake(ls, ln.m);
    }
    return { id, length, hi, lo, engines, lights, lodDistance: lo ? length * MODEL_STD.lodDistance : 0 };
  } catch (e) {
    warnOnce(id, (e as Error).message);
    return null;
  }
}
function warnOnce(id: string, msg: string) { modelStats.failed++; if (!warned.has(id)) { warned.add(id); console.warn(`[model] ${id}: ${msg} — 절차적 선체로 표시`); } }

/** uniform scale about the origin to the target length (+ optional recentring) */
function normaliser(scene: THREE.Object3D, length: number, recenter: boolean): { m: THREE.Matrix4; k: number } | null {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return null;
  const dz = box.max.z - box.min.z;
  if (!(dz > 0)) return null;
  const k = length / dz;
  const m = new THREE.Matrix4();
  if (recenter) { const c = box.getCenter(new THREE.Vector3()); m.makeTranslation(-c.x, -c.y, -c.z); }
  m.premultiply(new THREE.Matrix4().makeScale(k, k, k));
  return { m, k };
}

/** world-space geometry grouped by material, split by triangle centroid into front (z ≥ 0) / rear */
function bake(scene: THREE.Object3D, norm: THREE.Matrix4): ModelLevel {
  const groups = new Map<THREE.Material | TeamSlot, { slot?: TeamSlot; mat?: THREE.Material; f: THREE.BufferGeometry[]; r: THREE.BufferGeometry[] }>();
  const authored = new Map<string, THREE.Material>();
  let triangles = 0;
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as any).isSkinnedMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const src = mesh.geometry;
    const m = new THREE.Matrix4().multiplyMatrices(norm, mesh.matrixWorld);
    const ranges = src.groups.length ? src.groups : [{ start: 0, count: src.index ? src.index.count : src.getAttribute('position').count, materialIndex: 0 }];
    for (const g of ranges) {
      const mat = mats[g.materialIndex ?? 0] ?? mats[0];
      const slot = SLOT[mat?.name ?? ''];
      const key: THREE.Material | TeamSlot = slot ?? authored.get(mat.uuid) ?? (authored.set(mat.uuid, mat), mat);
      let bucket = groups.get(key);
      if (!bucket) groups.set(key, bucket = { slot, mat: slot ? undefined : mat, f: [], r: [] });
      const [f, r, n] = triangles3(src, g.start, g.count, m, !!slot);
      triangles += n;
      if (f) bucket.f.push(f);
      if (r) bucket.r.push(r);
    }
  });
  const out: ModelLevel = { front: [], rear: [], triangles };
  for (const b of groups.values()) {
    for (const [arr, dst] of [[b.f, out.front], [b.r, out.rear]] as const) {
      if (!arr.length) continue;
      const geo = arr.length === 1 ? arr[0] : mergeGeometries(arr);
      if (!geo) continue;
      geo.computeBoundingSphere();
      dst.push({ geo, slot: b.slot, mat: b.mat });
    }
  }
  return out;
}

/** non-indexed copy of a draw range, transformed; team-material parts get box-projected UVs in game
 *  units (the panel textures repeat every 40 units, like the procedural hulls) */
function triangles3(src: THREE.BufferGeometry, start: number, count: number, m: THREE.Matrix4, teamUv: boolean): [THREE.BufferGeometry | null, THREE.BufferGeometry | null, number] {
  const pos = src.getAttribute('position'), nor = src.getAttribute('normal'), uv = src.getAttribute('uv'), idx = src.index;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const tri = Math.floor(count / 3);
  const F: number[][] = [[], [], []], R: number[][] = [[], [], []];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let t = 0; t < tri; t++) {
    const vi = [0, 1, 2].map(k => { const i = start + t * 3 + k; return idx ? idx.getX(i) : i; });
    for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, vi[k]).applyMatrix4(m);
    fn.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0])).normalize();
    for (let k = 0; k < 3; k++) { if (nor) n[k].fromBufferAttribute(nor, vi[k]).applyMatrix3(nm).normalize(); else n[k].copy(fn); }
    const dst = (p[0].z + p[1].z + p[2].z) / 3 >= 0 ? F : R;
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let k = 0; k < 3; k++) {
      dst[0].push(p[k].x, p[k].y, p[k].z);
      dst[1].push(n[k].x, n[k].y, n[k].z);
      if (teamUv || uv) {
        if (!teamUv && uv) dst[2].push(uv.getX(vi[k]), uv.getY(vi[k]));
        else if (ay >= ax && ay >= az) dst[2].push(p[k].x, p[k].z);
        else if (ax >= az) dst[2].push(p[k].z, p[k].y);
        else dst[2].push(p[k].x, p[k].y);
      }
    }
  }
  const mk = (a: number[][]) => {
    if (!a[0].length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(a[0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(a[1], 3));
    if (a[2].length) g.setAttribute('uv', new THREE.Float32BufferAttribute(a[2], 2));
    return g;
  };
  return [mk(F), mk(R), tri];
}

/** drop every cached model (tests) */
export function resetModelCache() { pending.clear(); ready.clear(); files.clear(); warned.clear(); Object.assign(modelStats, { requests: 0, fetches: 0, loaded: 0, failed: 0, ms: 0, templates: 0 }); }

if (typeof window !== 'undefined') (window as any).__sidModels = modelStats;
