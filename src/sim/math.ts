// Minimal deterministic vector math for the simulation (no three.js dependency).

export class Vec3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
  copy(v: Vec3): this { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone(): Vec3 { return new Vec3(this.x, this.y, this.z); }
  add(v: Vec3): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v: Vec3): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaled(v: Vec3, s: number): this { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  scale(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }
  subVectors(a: Vec3, b: Vec3): this { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length(): number { return Math.sqrt(this.lengthSq()); }
  normalize(): this { const l = this.length(); if (l > 1e-9) this.scale(1 / l); return this; }
  setLength(len: number): this { return this.normalize().scale(len); }
  dot(v: Vec3): number { return this.x * v.x + this.y * v.y + this.z * v.z; }
  crossVectors(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z; return this;
  }
  distTo(v: Vec3): number { return Math.sqrt(this.distSq(v)); }
  distSq(v: Vec3): number { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  lerp(v: Vec3, t: number): this { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  clampLength(max: number): this { const l = this.length(); if (l > max) this.scale(max / l); return this; }
}

export const UP = new Vec3(0, 1, 0);
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => t * t * (3 - 2 * t);

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** forward unit vector from yaw/pitch. yaw=0 → +Z. */
export function dirFromYawPitch(yaw: number, pitch: number, out = new Vec3()): Vec3 {
  const cp = Math.cos(pitch);
  return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
}

export function yawOf(d: Vec3): number { return Math.atan2(d.x, d.z); }
export function pitchOf(d: Vec3): number { return Math.atan2(d.y, Math.hypot(d.x, d.z)); }

/** Transform a ship-local point (x right, y up, z forward) into world given yaw/pitch. */
export function localToWorld(local: { x: number; y: number; z: number }, pos: Vec3, yaw: number, pitch: number, out = new Vec3()): Vec3 {
  // rotate about X by -pitch (nose up), then about Y by yaw
  const cp = Math.cos(-pitch), sp = Math.sin(-pitch);
  const y1 = local.y * cp - local.z * sp;
  const z1 = local.y * sp + local.z * cp;
  const x1 = local.x;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x2 = x1 * cy + z1 * sy;
  const z2 = -x1 * sy + z1 * cy;
  return out.set(pos.x + x2, pos.y + y1, pos.z + z2);
}

/** Rotate world direction into ship local frame (inverse of localToWorld rotation). */
export function worldDirToLocal(d: Vec3, yaw: number, pitch: number, out = new Vec3()): Vec3 {
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const x1 = d.x * cy + d.z * sy;
  const z1 = -d.x * sy + d.z * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y2 = d.y * cp - z1 * sp;
  const z2 = d.y * sp + z1 * cp;
  return out.set(x1, y2, z2);
}

/** Squared distance between segments p1-q1 and p2-q2; also writes closest point on segment 1 into c1. */
export function segSegDistSq(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3, c1?: Vec3): number {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx = p1.x + d1x * s, cy = p1.y + d1y * s, cz = p1.z + d1z * s;
  const kx = p2.x + d2x * t, ky = p2.y + d2y * t, kz = p2.z + d2z * t;
  if (c1) c1.set(cx, cy, cz);
  const dx = cx - kx, dy = cy - ky, dz = cz - kz;
  return dx * dx + dy * dy + dz * dz;
}

export function angleBetween(a: Vec3, b: Vec3): number {
  const la = a.length(), lb = b.length();
  if (la < 1e-9 || lb < 1e-9) return 0;
  return Math.acos(clamp(a.dot(b) / (la * lb), -1, 1));
}

/** Rotate unit vector `from` toward `to` by at most maxAngle radians (result written to from). */
export function rotateToward(from: Vec3, to: Vec3, maxAngle: number): Vec3 {
  const ang = angleBetween(from, to);
  if (ang <= maxAngle || ang < 1e-6) return from.copy(to).normalize();
  const t = maxAngle / ang;
  // slerp
  const sinA = Math.sin(ang);
  const w1 = Math.sin((1 - t) * ang) / sinA, w2 = Math.sin(t * ang) / sinA;
  const tn = to.clone().normalize();
  from.set(from.x * w1 + tn.x * w2, from.y * w1 + tn.y * w2, from.z * w1 + tn.z * w2);
  return from.normalize();
}
