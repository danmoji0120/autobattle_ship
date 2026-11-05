// Snapshot interpolation keyed to *server world time*, not packet arrival time.
//
// The old client blended "previous → latest snapshot" by how long ago the latest one arrived and
// extrapolated up to 1.5× past it. Any late packet (network jitter, a busy server) made ships run
// ahead, and the next snapshot dragged them back to where the server really had them: rubber-banding.
//
// Now every packet carries the world time it was sampled at. Each ship keeps a short history of
// (time, position, velocity) samples and is drawn at `renderTime`, a clock that trails the newest
// sample by an adaptive delay (≈ one packet interval + jitter). renderTime only ever moves forward,
// so a ship can never be drawn going backwards along its path; between samples it follows a Hermite
// curve that uses the server velocities, which keeps warp acceleration and turns smooth.

export interface Sample { t: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; h: number; warp: number }

export class NetClock {
  /** world time currently being rendered */
  renderTime = 0;
  /** newest world time received and when (ms) */
  latestAt = 0;
  private latestRecv = 0;
  private started = false;
  /** world seconds per real second (1× in multiplayer, 0..8× in single player; less if the server lags) */
  rate = 1;
  private marks: { recv: number; at: number }[] = [];
  private gaps: number[] = [];
  private lastRecv = 0;
  /** stats for the diagnostics overlay */
  delayReal = 0.25;
  gapMean = 0.2;
  gapJitter = 0;
  corrections = 0;
  starved = 0;

  /** call for every timestamped packet */
  onPacket(at: number, nowMs: number, nominalRate: number) {
    if (this.lastRecv) { this.gaps.push((nowMs - this.lastRecv) / 1000); if (this.gaps.length > 40) this.gaps.shift(); }
    this.lastRecv = nowMs;
    if (at < this.latestAt) return; // out of order — ignore for clock purposes
    this.latestAt = at; this.latestRecv = nowMs;
    this.marks.push({ recv: nowMs, at }); while (this.marks.length > 2 && this.marks[this.marks.length - 1].recv - this.marks[0].recv > 4000) this.marks.shift();
    // measured world rate (handles pauses, speed changes and a server that falls behind real time)
    const a = this.marks[0], b = this.marks[this.marks.length - 1];
    if (b.recv - a.recv > 600 && nominalRate > 0) this.rate = Math.max(0, Math.min(nominalRate * 1.25, (b.at - a.at) / ((b.recv - a.recv) / 1000)));
    else this.rate = nominalRate;
    if (this.gaps.length >= 3) {
      const m = this.gaps.reduce((x, y) => x + y, 0) / this.gaps.length;
      const v = Math.sqrt(this.gaps.reduce((x, y) => x + (y - m) ** 2, 0) / this.gaps.length);
      this.gapMean = m; this.gapJitter = v;
      // enough buffer to ride out a typical late packet without running dry
      this.delayReal = Math.max(0.12, Math.min(1.6, m * 1.1 + v * 2.5 + 0.04));
    }
    if (!this.started) { this.started = true; this.renderTime = at - this.delayReal * this.rate; }
  }

  /** advance once per rendered frame; never moves backwards */
  frame(dtReal: number, nowMs: number) {
    if (!this.started) return;
    const est = this.latestAt + Math.min(2, (nowMs - this.latestRecv) / 1000) * this.rate;
    const target = est - this.delayReal * this.rate;
    let next = this.renderTime + dtReal * this.rate;
    const err = target - next;
    if (Math.abs(err) > Math.max(3, 6 * this.rate)) { if (err > 0) next = target; this.corrections++; }
    // gently speed up / slow down to converge without visible jumps (faster catch-up after a stall)
    else { const k = err > 0.3 * Math.max(this.rate, 0.2) ? 0.35 : 0.15; next += Math.max(-0.15, Math.min(k, err * 0.8)) * dtReal * Math.max(this.rate, 0.2); }
    // never render past the newest data: during a stall ships ease to a halt at their last known
    // position and resume from there, instead of guessing ahead and being yanked back
    if (next > this.latestAt) { next = Math.max(this.renderTime, this.latestAt); this.starved++; }
    if (next > this.renderTime) this.renderTime = next;
  }
}

export class MotionTrack {
  samples: Sample[] = [];
  push(s: Sample) {
    const n = this.samples.length;
    if (n && s.t <= this.samples[n - 1].t) {
      if (s.t === this.samples[n - 1].t) this.samples[n - 1] = s;
      return;
    }
    this.samples.push(s);
    if (this.samples.length > 24) this.samples.splice(0, this.samples.length - 24);
  }
  clear() { this.samples = []; }

  /** position at world time t; returns 1 if extrapolating past the newest sample */
  at(t: number, out: { x: number; y: number; z: number; h: number }): number {
    const S = this.samples;
    if (!S.length) return 0;
    if (t <= S[0].t) { out.x = S[0].x; out.y = S[0].y; out.z = S[0].z; out.h = S[0].h; return 0; }
    const last = S[S.length - 1];
    if (t >= last.t) {
      // no extrapolation: a guess that turns out wrong is exactly what reads as rubber-banding
      out.x = last.x; out.y = last.y; out.z = last.z; out.h = last.h;
      return t > last.t ? 1 : 0;
    }
    let i = S.length - 2;
    while (i > 0 && S[i].t > t) i--;
    const a = S[i], b = S[i + 1];
    const T = b.t - a.t, u = (t - a.t) / T;
    // a gate jump or docking teleport: no curve across it
    const jump = Math.abs(b.x - a.x) + Math.abs(b.z - a.z) > Math.max(5000, (Math.hypot(a.vx, a.vz) + Math.hypot(b.vx, b.vz)) * T * 2 + 400);
    if (jump) { const p = u < 0.5 ? a : b; out.x = p.x; out.y = p.y; out.z = p.z; out.h = p.h; return 0; }
    // velocities that disagree with the actual displacement (warp drop-out, collisions with arrival
    // logic) would make the curve overshoot and swing back — fall back to a straight blend
    const cx = b.x - a.x, cz = b.z - a.z, cl = Math.hypot(cx, cz);
    const tx = (a.vx + b.vx) * 0.5 * T - cx, tz = (a.vz + b.vz) * 0.5 * T - cz;
    if (Math.hypot(tx, tz) > cl * 0.25 + 4) {
      out.x = a.x + cx * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + cz * u;
      let dh = b.h - a.h; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
      out.h = a.h + dh * u;
      return 0;
    }
    // cubic Hermite with server velocities as tangents
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    out.x = h00 * a.x + h10 * T * a.vx + h01 * b.x + h11 * T * b.vx;
    out.y = h00 * a.y + h10 * T * a.vy + h01 * b.y + h11 * T * b.vy;
    out.z = h00 * a.z + h10 * T * a.vz + h01 * b.z + h11 * T * b.vz;
    let dh = b.h - a.h; while (dh > Math.PI) dh -= Math.PI * 2; while (dh < -Math.PI) dh += Math.PI * 2;
    out.h = a.h + dh * u;
    return 0;
  }
}
