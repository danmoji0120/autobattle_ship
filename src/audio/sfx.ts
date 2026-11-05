import type * as THREE from 'three';

// All sounds are synthesized into buffers at startup (no asset files).

const SR = 44100;

function makeBuffer(ctx: BaseAudioContext, dur: number, gen: (out: Float32Array, sr: number) => void, channels = 1): AudioBuffer {
  const len = Math.floor(dur * SR);
  const buf = ctx.createBuffer(channels, len, SR);
  for (let c = 0; c < channels; c++) gen(buf.getChannelData(c), SR);
  // normalize
  let peak = 0;
  for (let c = 0; c < channels; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let c = 0; c < channels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] /= peak; }
  return buf;
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

/** simple one-pole lowpass over a signal in place */
function lp(d: Float32Array, cutoffAt: (i: number) => number) {
  let y = 0;
  for (let i = 0; i < d.length; i++) { const a = cutoffAt(i); y += a * (d[i] - y); d[i] = y; }
}

function boom(d: Float32Array, sr: number, opt: { sub: number; decay: number; crack: number; body: number; rumble?: number }) {
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const env = Math.exp(-t / opt.decay);
    d[i] = rnd() * env * opt.body;
  }
  lp(d, i => 0.02 + 0.25 * Math.exp(-i / sr / 0.04));
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const f = opt.sub * (1 + 2.5 * Math.exp(-t / 0.05));
    d[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t / (opt.decay * 0.6)) * 0.9;
    d[i] += rnd() * Math.exp(-t / 0.012) * opt.crack;
    if (opt.rumble) d[i] += Math.sin(2 * Math.PI * (opt.sub * 0.5) * t + Math.sin(t * 13) * 2) * Math.exp(-t / (opt.decay * 1.6)) * opt.rumble * (0.5 + 0.5 * Math.sin(t * 7));
  }
}

export class Sfx {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private comp!: DynamicsCompressorNode;
  private bufs: Record<string, AudioBuffer[]> = {};
  private lastPlay: Record<string, number> = {};
  private voices: Record<string, number> = {};
  listener: THREE.Vector3 | null = null;
  private music: { gains: GainNode[]; filter: BiquadFilterNode; drum: GainNode; nextBeat: number; intensity: number; step: number } | null = null;
  volume = 0.8;
  muted = false;

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16; this.comp.ratio.value = 5; this.comp.attack.value = 0.003; this.comp.release.value = 0.25;
    this.master = c.createGain(); this.master.gain.value = this.volume;
    this.sfxBus = c.createGain(); this.sfxBus.gain.value = 0.9;
    this.musicBus = c.createGain(); this.musicBus.gain.value = 0.32;
    this.sfxBus.connect(this.comp); this.musicBus.connect(this.comp); this.comp.connect(this.master); this.master.connect(c.destination);
    this.generate();
  }

  private generate() {
    const c = this.ctx!;
    const add = (name: string, n: number, dur: number, g: (d: Float32Array, sr: number, k: number) => void) => {
      this.bufs[name] = [];
      for (let k = 0; k < n; k++) this.bufs[name].push(makeBuffer(c, dur, (d, sr) => g(d, sr, k)));
    };
    add('heavy', 3, 2.6, (d, sr, k) => boom(d, sr, { sub: 38 + k * 4, decay: 0.55, crack: 1.4, body: 1.4, rumble: 0.4 }));
    add('rail', 2, 1.6, (d, sr, k) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const f = 2400 * Math.exp(-t * 6) + 180 + k * 30;
        d[i] = Math.sin(2 * Math.PI * f * t + Math.sin(t * 300) * 0.5) * Math.exp(-t / 0.35) * 0.7 + rnd() * Math.exp(-t / 0.03) * 0.8 + Math.sin(2 * Math.PI * 50 * t) * Math.exp(-t / 0.4) * 0.6;
      }
    });
    add('medium', 3, 0.9, (d, sr, k) => boom(d, sr, { sub: 70 + k * 10, decay: 0.16, crack: 1.2, body: 1 }));
    add('auto', 3, 0.14, (d, sr, k) => boom(d, sr, { sub: 140 + k * 20, decay: 0.03, crack: 1.5, body: 0.6 }));
    add('pd', 2, 0.35, (d, sr, k) => {
      for (let i = 0; i < d.length; i++) { const t = i / sr; const g = (Math.floor(t * (55 + k * 5)) % 2) ? 1 : 0.2; d[i] = rnd() * g * Math.exp(-t / 0.14); }
      lp(d, () => 0.35);
    });
    add('missile', 2, 1.6, (d, sr) => {
      for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = rnd() * Math.min(1, t * 30) * Math.exp(-t / 0.5); }
      lp(d, i => 0.05 + 0.25 * Math.exp(-i / sr / 0.25));
      for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += rnd() * Math.exp(-t / 0.02) * 0.6; }
    });
    add('torpedo', 1, 2.2, (d, sr) => {
      for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * (90 + 40 * Math.sin(t * 9)) * t) * Math.exp(-t / 0.8) * 0.6 + rnd() * Math.exp(-t / 0.5) * 0.4; }
      lp(d, () => 0.08);
    });
    add('hit', 3, 0.6, (d, sr, k) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        d[i] = rnd() * Math.exp(-t / 0.05) + (Math.sin(2 * Math.PI * (1100 + k * 230) * t) + Math.sin(2 * Math.PI * (1730 + k * 170) * t) * 0.7 + Math.sin(2 * Math.PI * 2610 * t) * 0.4) * Math.exp(-t / 0.12) * 0.35 + Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t / 0.08) * 0.8;
      }
    });
    add('hitheavy', 2, 1.6, (d, sr, k) => {
      boom(d, sr, { sub: 55 + k * 8, decay: 0.35, crack: 1.6, body: 1.3 });
      for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] += (Math.sin(2 * Math.PI * 640 * t) + Math.sin(2 * Math.PI * 1013 * t) * 0.6) * Math.exp(-t / 0.25) * 0.35; }
    });
    add('torphit', 1, 3.2, (d, sr) => boom(d, sr, { sub: 30, decay: 0.9, crack: 1.8, body: 1.6, rumble: 0.8 }));
    add('hitsmall', 2, 0.15, (d, sr, k) => { for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = rnd() * Math.exp(-t / 0.02) + Math.sin(2 * Math.PI * (2200 + k * 400) * t) * Math.exp(-t / 0.04) * 0.4; } });
    add('ricochet', 3, 0.7, (d, sr, k) => {
      for (let i = 0; i < d.length; i++) { const t = i / sr; const f = (3600 - k * 400) * Math.exp(-t * 2.5) + 900; d[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.22) * 0.8 + rnd() * Math.exp(-t / 0.01); }
    });
    add('intercept', 2, 0.6, (d, sr, k) => boom(d, sr, { sub: 110 + k * 20, decay: 0.09, crack: 1, body: 0.9 }));
    add('explode', 3, 2.2, (d, sr, k) => boom(d, sr, { sub: 45 + k * 6, decay: 0.45, crack: 1.2, body: 1.6, rumble: 0.3 }));
    add('explode_big', 2, 5.5, (d, sr, k) => {
      boom(d, sr, { sub: 26 + k * 4, decay: 1.4, crack: 1.5, body: 1.8, rumble: 1 });
      // secondary crackles
      for (let n = 0; n < 9; n++) {
        const st = Math.floor((0.25 + Math.random() * 2.5) * sr);
        for (let i = 0; i < sr * 0.25 && st + i < d.length; i++) d[st + i] += rnd() * Math.exp(-i / sr / 0.05) * 0.5;
      }
    });
    add('radio', 2, 0.32, (d, sr, k) => {
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        const beep = t < 0.07 ? Math.sin(2 * Math.PI * (k ? 1500 : 1250) * t) * 0.5 : t > 0.1 && t < 0.15 ? Math.sin(2 * Math.PI * 1900 * t) * 0.35 : 0;
        d[i] = beep + rnd() * 0.25 * Math.exp(-t / 0.15);
      }
    });
    add('click', 1, 0.06, (d, sr) => { for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t / 0.012); } });
    add('confirm', 1, 0.25, (d, sr) => { for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (Math.sin(2 * Math.PI * (t < 0.08 ? 880 : 1320) * t)) * Math.exp(-((t % 0.08) / 0.05)) * 0.6; } });
    add('win', 1, 3.5, (d, sr) => { const ch = [261.6, 329.6, 392, 523.3]; for (let i = 0; i < d.length; i++) { const t = i / sr; let v = 0; ch.forEach((f, j) => { if (t > j * 0.15) v += Math.sin(2 * Math.PI * f * t) * Math.exp(-(t - j * 0.15) / 1.4); }); d[i] = v * 0.3; } });
    add('lose', 1, 3.5, (d, sr) => { const ch = [220, 207.7, 174.6, 146.8]; for (let i = 0; i < d.length; i++) { const t = i / sr; let v = 0; ch.forEach((f, j) => { if (t > j * 0.3) v += Math.sin(2 * Math.PI * f * t) * Math.exp(-(t - j * 0.3) / 1.6); }); d[i] = v * 0.3; } });
    add('drum', 2, 0.9, (d, sr, k) => boom(d, sr, { sub: k ? 55 : 42, decay: 0.18, crack: 0.4, body: 0.5 }));
  }

  play(name: string, pos: THREE.Vector3 | null, vol = 1, rate = 1) {
    const c = this.ctx;
    if (!c || this.muted || c.state !== 'running') return;
    const list = this.bufs[name];
    if (!list) return;
    const now = c.currentTime;
    const minGap = name === 'pd' || name === 'auto' || name === 'hitsmall' ? 0.05 : name === 'radio' ? 0.3 : 0.02;
    if (now - (this.lastPlay[name] ?? -1) < minGap) return;
    const maxV = name === 'explode_big' || name === 'heavy' ? 6 : 10;
    if ((this.voices[name] ?? 0) >= maxV) return;
    let g = vol;
    let pan = 0;
    let dist = 0;
    if (pos && this.listener) {
      dist = pos.distanceTo(this.listener);
      g *= 1 / (1 + Math.pow(dist / 650, 1.4));
      if (g < 0.015) return;
    }
    this.lastPlay[name] = now;
    const src = c.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = rate * (dist > 1500 ? 0.85 : 1);
    const gain = c.createGain();
    gain.gain.value = g;
    let node: AudioNode = src;
    if (dist > 900) {
      // distant sounds lose their highs
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(300, 6000 - dist * 1.6);
      node.connect(f); node = f;
    }
    if (pan) { const p = c.createStereoPanner(); p.pan.value = pan; node.connect(p); node = p; }
    node.connect(gain); gain.connect(this.sfxBus);
    this.voices[name] = (this.voices[name] ?? 0) + 1;
    src.onended = () => { this.voices[name]--; };
    src.start();
  }

  // ------------------------------------------------------------------ music
  startMusic() {
    const c = this.ctx;
    if (!c || this.music) return;
    const filter = c.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600; filter.Q.value = 2;
    filter.connect(this.musicBus);
    const gains: GainNode[] = [];
    // D minor pad: D2 A2 D3 F3 + detuned saws
    const notes = [73.42, 110, 146.8, 174.6, 220];
    for (const f of notes) {
      for (const det of [-6, 6]) {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
        const g = c.createGain(); g.gain.value = 0.045;
        o.connect(g); g.connect(filter); o.start();
        gains.push(g);
      }
    }
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 260;
    lfo.connect(lg); lg.connect(filter.frequency); lfo.start();
    const drum = c.createGain(); drum.gain.value = 0; drum.connect(this.musicBus);
    this.music = { gains, filter, drum, nextBeat: c.currentTime + 0.5, intensity: 0, step: 0 };
  }

  /** chord changes + drums driven by battle intensity (0..1) */
  updateMusic(intensity: number) {
    const c = this.ctx, m = this.music;
    if (!c || !m) return;
    m.intensity += (intensity - m.intensity) * 0.02;
    m.filter.frequency.setTargetAtTime(500 + m.intensity * 1800, c.currentTime, 0.5);
    m.drum.gain.setTargetAtTime(Math.max(0, m.intensity - 0.15) * 1.3, c.currentTime, 0.3);
    const bpm = 92;
    const beat = 60 / bpm / 2;
    while (m.nextBeat < c.currentTime + 0.2) {
      const step = m.step++ % 16;
      const pattern = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0];
      if (pattern[step] && m.intensity > 0.12) {
        const src = c.createBufferSource(); src.buffer = this.bufs.drum[step % 4 === 0 ? 0 : 1];
        const g = c.createGain(); g.gain.value = step % 4 === 0 ? 0.9 : 0.5;
        src.connect(g); g.connect(m.drum); src.start(m.nextBeat);
      }
      // chord progression every 16 steps: Dm - Bb - F - C
      if (step === 0) {
        const prog = [[73.42, 110, 146.8, 174.6, 220], [58.27, 116.5, 146.8, 174.6, 233.1], [87.31, 130.8, 174.6, 220, 261.6], [65.41, 130.8, 164.8, 196, 261.6]];
        const ch = prog[Math.floor(m.step / 16) % 4];
        this.swell(ch, m.nextBeat);
      }
      m.nextBeat += beat;
    }
  }

  private swell(freqs: number[], at: number) {
    const c = this.ctx!, m = this.music!;
    for (const f of freqs.slice(1)) {
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = f * 2;
      const g = c.createGain(); g.gain.value = 0;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.035, at + 1.2); g.gain.linearRampToValueAtTime(0, at + 5.2);
      o.connect(g); g.connect(m.filter); o.start(at); o.stop(at + 5.4);
    }
  }

  stopMusic() {
    if (!this.music || !this.ctx) return;
    this.music.gains.forEach(g => g.gain.setTargetAtTime(0, this.ctx!.currentTime, 0.5));
    this.music.drum.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
    const m = this.music;
    setTimeout(() => { m.gains.forEach(g => g.disconnect()); m.filter.disconnect(); m.drum.disconnect(); }, 2500);
    this.music = null;
  }

  setMuted(b: boolean) { this.muted = b; if (this.master) this.master.gain.value = b ? 0 : this.volume; }
}

export const sfx = new Sfx();
