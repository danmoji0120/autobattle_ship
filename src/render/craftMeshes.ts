// P16.4: read-only, batched visuals for the P16 craft pool. Nothing here changes battle RNG or state.
import * as THREE from 'three';
import type { CraftPool } from '../sim/craft';

const ROLES = ['fighter', 'bomber', 'interceptor'] as const;
type Role = (typeof ROLES)[number];
const FORWARD = new THREE.Vector3(0, 0, 1);
const POS = new THREE.Vector3(), DIR = new THREE.Vector3();
const ROT = new THREE.Quaternion(), SCALE = new THREE.Vector3(1, 1, 1), MATRIX = new THREE.Matrix4();
const PALETTE: Record<Role, [THREE.Color, THREE.Color]> = {
  fighter: [new THREE.Color(0x8bd8ff), new THREE.Color(0xff8769)],
  bomber: [new THREE.Color(0xffe0a0), new THREE.Color(0xff6852)],
  interceptor: [new THREE.Color(0x95ffd1), new THREE.Color(0xfd91dc)],
};

/** Flat arrow-wing silhouettes, forward along +Z. Different spans make the three roles identifiable. */
function geometry(role: Role): THREE.BufferGeometry {
  const span = role === 'bomber' ? 11 : role === 'interceptor' ? 4.5 : 7;
  const nose = role === 'interceptor' ? 14 : role === 'bomber' ? 7 : 10;
  const tail = role === 'bomber' ? -5 : -6;
  const wingZ = role === 'bomber' ? 1 : -1;
  const vertices = [
    0, 1.3, nose, -span, 0, wingZ, 0, 0, tail,
    0, 1.3, nose, 0, 0, tail, span, 0, wingZ,
    0, 1.3, nose, span, 0, wingZ, -span, 0, wingZ,
    0, -0.9, nose, 0, 0, tail, -span, 0, wingZ,
    0, -0.9, nose, span, 0, wingZ, 0, 0, tail,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.computeVertexNormals();
  return g;
}

/** All flying craft are drawn with only three instanced meshes, including after reinforcements. */
export class CraftMeshes {
  private meshes = new Map<Role, THREE.InstancedMesh>();
  private capacity = 0;
  drawn = 0;
  constructor(private scene: THREE.Scene) {}

  private allocate(cap: number) {
    this.dispose();
    this.capacity = cap;
    for (const role of ROLES) {
      const mesh = new THREE.InstancedMesh(geometry(role), new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide, toneMapped: false,
      }), cap);
      mesh.name = 'craft-' + role;
      mesh.count = 0;
      mesh.frustumCulled = false; // Per-instance positions span the entire battlefield.
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(mesh);
      this.meshes.set(role, mesh);
    }
  }

  /** Updates GPU instance matrices only; never steps or mutates the simulation. */
  sync(pool: CraftPool | null, friendly: (team: number) => boolean) {
    if (!pool) {
      this.drawn = 0;
      for (const mesh of this.meshes.values()) mesh.count = 0;
      return;
    }
    if (pool.n > this.capacity) {
      let cap = Math.max(64, this.capacity);
      while (cap < pool.n) cap *= 2;
      this.allocate(cap);
    }
    const counts: Record<Role, number> = { fighter: 0, bomber: 0, interceptor: 0 };
    for (let i = 0; i < pool.n; i++) {
      if (pool.st[i] !== 2) continue; // OUT: skip hangar, prep, lost and departed craft.
      const squad = pool.squads[pool.sq[i]];
      if (!squad) continue;
      const role = squad.cs.role;
      const mesh = this.meshes.get(role);
      if (!mesh) continue;
      const slot = counts[role]++;
      POS.set(pool.px[i], pool.py[i], pool.pz[i]);
      DIR.set(pool.vx[i], pool.vy[i], pool.vz[i]);
      if (DIR.lengthSq() < 1e-8) DIR.copy(FORWARD);
      else DIR.normalize();
      ROT.setFromUnitVectors(FORWARD, DIR);
      const size = role === 'bomber' ? 1.15 : 1;
      SCALE.setScalar(size);
      MATRIX.compose(POS, ROT, SCALE);
      mesh.setMatrixAt(slot, MATRIX);
      mesh.setColorAt(slot, PALETTE[role][friendly(squad.team) ? 0 : 1]);
    }
    this.drawn = counts.fighter + counts.bomber + counts.interceptor;
    for (const role of ROLES) {
      const mesh = this.meshes.get(role)!;
      mesh.count = counts[role];
      if (counts[role]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.clear();
    this.capacity = 0;
    this.drawn = 0;
  }
}
