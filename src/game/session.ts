import { World, type BattleSetup } from '../sim/world';
import { BattleView, type AudioSink } from '../render/battleView';
import { getScenario } from '../sim/data/scenarios';
import type { SimEvent } from '../sim/types';

/** Runs the fixed-step simulation and drives the renderer at display rate. */
export class BattleSession {
  readonly world: World;
  readonly view: BattleView;
  timeScale = 1;
  paused = false;
  private acc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  onEvents: ((ev: SimEvent[]) => void) | null = null;
  onFrame: ((realDt: number) => void) | null = null;
  slowmo = 1;

  constructor(canvas: HTMLCanvasElement, setup: BattleSetup, audio: AudioSink | null) {
    this.world = new World(setup);
    this.view = new BattleView(canvas, getScenario(setup.scenarioId).backdrop);
    this.view.audio = audio;
    this.view.attach(this.world);
  }

  start() {
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const realDt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.tick(realDt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** advance by realDt seconds of wall time (exposed for automated tests) */
  tick(realDt: number) {
    const w = this.world;
    const camScale = this.view.rig.timeScaleRequest;
    this.slowmo += (camScale - this.slowmo) * Math.min(1, realDt * (camScale < this.slowmo ? 12 : 2));
    const scale = this.paused || w.outcome ? 0 : this.timeScale * this.slowmo;
    this.acc += realDt * scale;
    let steps = 0;
    let simDt = 0;
    while (this.acc >= w.dt && steps < 12) {
      w.step();
      this.acc -= w.dt;
      steps++;
      simDt += w.dt;
      if (w.events.length) { this.view.handleEvents(w.events); this.onEvents?.(w.events); }
      if (w.outcome) { this.acc = 0; break; }
    }
    if (steps >= 12) this.acc = 0;
    this.view.frame(Math.min(1, this.acc / w.dt), realDt * scale, realDt);
    this.onFrame?.(realDt);
  }

  /** run the simulation forward quickly, updating effects without rendering (tests / skip) */
  fastForward(toTime: number) {
    const w = this.world;
    let n = 0;
    while (w.time < toTime && !w.outcome) {
      w.step();
      if (w.events.length) { this.view.handleEvents(w.events); this.onEvents?.(w.events); }
      if (++n % 3 === 0) this.view.frame(1, w.dt * 3, w.dt * 3, false);
    }
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  dispose() { this.stop(); this.view.dispose(); }
}
