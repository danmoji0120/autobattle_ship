// P17.3: geometric probes on a procedural hull (tests/p17-hulls.test.ts)
import * as THREE from 'three';
import { hullParts } from '../../src/render/shipMesh';

export interface Probe { surfaceBelow(x: number, y: number, z: number): number | null; clearAbove(x: number, y: number, z: number, h: number): boolean; clearBehind(x: number, y: number, z: number, d: number): boolean; box: THREE.Box3; verts: number }
export function probeHull(base: string, L: number): Probe | null {
  const p = hullParts(base, L);
  if (!p) return null;
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const meshes = [...p.hull, ...p.dark, ...p.trim, ...p.accent].map(g => { const m = new THREE.Mesh(g, mat); m.updateMatrixWorld(true); return m; });
  const box = new THREE.Box3(); for (const m of meshes) box.expandByObject(m);
  const rc = new THREE.Raycaster();
  const cast = (o: THREE.Vector3, d: THREE.Vector3, far: number) => { rc.set(o, d); rc.far = far; return rc.intersectObjects(meshes, false); };
  return {
    box, verts: meshes.reduce((n, m) => n + m.geometry.getAttribute('position').count, 0),
    surfaceBelow(x, y, z) { const h = cast(new THREE.Vector3(x, y - 0.2, z), new THREE.Vector3(0, -1, 0), 40); return h.length ? h[0].point.y : null; },
    clearAbove(x, y, z, h) { return cast(new THREE.Vector3(x, y - 0.15, z), new THREE.Vector3(0, 1, 0), h).length === 0; },
    clearBehind(x, y, z, d) { return cast(new THREE.Vector3(x, y, z - 0.05), new THREE.Vector3(0, 0, -1), d).length === 0; },
  };
}
