// Minimal GLB writer for generated models (no browser APIs): one mesh with one primitive per material,
// plus empty marker nodes (hp_*, engine_*, light_*). Positions/normals as float32, non-indexed.
import type * as THREE from 'three';

export interface GlbMaterial { name: string; color: [number, number, number]; metal: number; rough: number; emissive?: [number, number, number] }
export interface GlbMarker { name: string; pos: [number, number, number]; scale?: number }

export function writeGlb(name: string, parts: { mat: GlbMaterial; geo: THREE.BufferGeometry }[], markers: GlbMarker[]): Uint8Array {
  const chunks: Uint8Array[] = []; let off = 0;
  const bufferViews: any[] = [], accessors: any[] = [], primitives: any[] = [], materials: any[] = [];
  const push = (arr: Float32Array) => { const b = new Uint8Array(arr.buffer.slice(0)); chunks.push(b); bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length, target: 34962 }); off += b.length; return bufferViews.length - 1; };
  parts.forEach(({ mat, geo }, i) => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pos = g.getAttribute('position').array as Float32Array;
    const nor = g.getAttribute('normal').array as Float32Array;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], pos[k + c]); max[c] = Math.max(max[c], pos[k + c]); }
    const pv = push(new Float32Array(pos)), nv = push(new Float32Array(nor));
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: 'VEC3' });
    materials.push({ name: mat.name, pbrMetallicRoughness: { baseColorFactor: [...mat.color, 1], metallicFactor: mat.metal, roughnessFactor: mat.rough }, ...(mat.emissive ? { emissiveFactor: mat.emissive } : {}) });
    primitives.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: i, mode: 4 });
  });
  const nodes: any[] = [{ name, children: [] as number[] }, { name: `${name}_mesh`, mesh: 0 }];
  nodes[0].children.push(1);
  for (const m of markers) { nodes.push({ name: m.name, translation: m.pos, ...(m.scale ? { scale: [m.scale, m.scale, m.scale] } : {}) }); nodes[0].children.push(nodes.length - 1); }
  const json = {
    asset: { version: '2.0', generator: 'siderarium make-fixtures' },
    scene: 0, scenes: [{ nodes: [0] }], nodes, meshes: [{ name: `${name}_mesh`, primitives }], materials,
    buffers: [{ byteLength: off }], bufferViews, accessors,
  };
  const pad = (b: Uint8Array, fill: number) => { const n = (4 - (b.length % 4)) % 4; if (!n) return b; const o = new Uint8Array(b.length + n); o.set(b); o.fill(fill, b.length); return o; };
  const jb = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const bin = new Uint8Array(off); let p = 0; for (const c of chunks) { bin.set(c, p); p += c.length; }
  const bb = pad(bin, 0);
  const total = 12 + 8 + jb.length + 8 + bb.length;
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  dv.setUint32(20 + jb.length, bb.length, true); dv.setUint32(24 + jb.length, 0x004e4942, true); out.set(bb, 28 + jb.length);
  return out;
}
