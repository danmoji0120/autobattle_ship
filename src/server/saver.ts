// Autosave scheduling, failure tracking and the separately stored analytics history (used by node.ts).
//
// World saves keep their interval (SAVE_INTERVAL_S). The analytics history — bounded by ANALYTICS_MAX_BYTES,
// up to 8 MB by default — used to ride along in every world save; it is now written to its own record every
// ANALYTICS_SAVE_INTERVAL_S (default 300 s) and on shutdown. Until that record has been written once, world
// saves still include the analytics (an upgraded server never has a moment without a stored copy).
// A save never overlaps the previous one; a failure is logged, counted and retried at the next interval.

import type { AnalyticsStore } from './analytics';
import type { SaveFile } from './protocol';

export interface SaveTarget {
  save(text: string): Promise<void>;
  /** separate analytics record (absent: the storage keeps analytics inside the world save) */
  saveAnalytics?(text: string): Promise<void>;
  fenced?: boolean;
}
export interface SaveSource {
  saveText(opts?: { analytics?: boolean }): string;
  analyticsText(): string | null;
  sim: { time: number; st: { seed?: number } };
}

export interface SaveStats {
  ok: number; failures: number; consecutiveFailures: number; skippedBusy: number;
  lastOkAt: number | null; lastAttemptAt: number | null; lastError: string | null; lastErrorAt: number | null;
  lastBytes: number; maxBytes: number; lastSerializeMs: number; maxSerializeMs: number; lastWriteMs: number; maxWriteMs: number;
  analytics: { separate: boolean; stored: boolean; ok: number; failures: number; lastOkAt: number | null; lastBytes: number; lastSerializeMs: number; lastWriteMs: number; lastError: string | null };
  inFlight: boolean; fenced: boolean;
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

export class Saver {
  readonly stats: SaveStats;
  private inflight: Promise<void> | null = null;
  private lastAnalyticsAt = -Infinity;
  constructor(private target: SaveTarget, private game: SaveSource, private opts: { analyticsEveryS: number; now?: () => number; log?: (line: string) => void }) {
    const separate = !!target.saveAnalytics;
    this.stats = { ok: 0, failures: 0, consecutiveFailures: 0, skippedBusy: 0, lastOkAt: null, lastAttemptAt: null, lastError: null, lastErrorAt: null, lastBytes: 0, maxBytes: 0, lastSerializeMs: 0, maxSerializeMs: 0, lastWriteMs: 0, maxWriteMs: 0,
      analytics: { separate, stored: false, ok: 0, failures: 0, lastOkAt: null, lastBytes: 0, lastSerializeMs: 0, lastWriteMs: 0, lastError: null }, inFlight: false, fenced: false };
  }
  private now() { return (this.opts.now ?? Date.now)(); }
  private log(line: string) { (this.opts.log ?? (l => console.log(l)))(line); }

  /** the autosave is due (called from the game loop); returns immediately, the write runs in the background */
  due(): void {
    if (this.inflight) {
      this.stats.skippedBusy++;
      this.log(`[siderarium] 저장 건너뜀: 이전 저장이 아직 진행 중 (연속 실패 ${this.stats.consecutiveFailures})`);
      return;
    }
    this.inflight = this.run(false).finally(() => { this.inflight = null; this.stats.inFlight = false; });
  }
  /** final save on shutdown: waits for a running save, then writes the world and the analytics */
  async flush(timeoutMs = 60_000): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    const wait = (p: Promise<unknown>) => Promise.race([p, new Promise(r => setTimeout(r, Math.max(0, deadline - this.now())))]);
    if (this.inflight) await wait(this.inflight);
    if (this.inflight) { this.log('[siderarium] !!! 진행 중인 저장이 끝나지 않아 종료 저장을 생략합니다'); return false; }
    const before = this.stats.ok;
    await wait(this.run(true));
    return this.stats.ok > before;
  }

  private async run(final: boolean) {
    this.stats.inFlight = true;
    this.stats.lastAttemptAt = this.now();
    if (this.target.fenced) { this.stats.fenced = true; return; }
    const sep = this.stats.analytics.separate;
    const analyticsDue = sep && (final || !this.stats.analytics.stored || this.now() - this.lastAnalyticsAt >= this.opts.analyticsEveryS * 1000);
    let text: string, atext: string | null = null;
    const t0 = performance.now();
    try {
      // serialization happens now, on the game thread (it is the moment being saved)
      text = this.game.saveText({ analytics: !sep || !this.stats.analytics.stored });
      const t1 = performance.now();
      this.stats.lastSerializeMs = t1 - t0; this.stats.maxSerializeMs = Math.max(this.stats.maxSerializeMs, t1 - t0);
      if (analyticsDue) {
        const a = this.game.analyticsText();
        if (a !== null) atext = `{"v":1,"seed":${JSON.stringify(this.game.sim.st.seed ?? null)},"time":${JSON.stringify(this.game.sim.time)},"store":${a}}`;
        this.stats.analytics.lastSerializeMs = performance.now() - t1;
      }
    } catch (e) { this.fail(e); return; }
    const w0 = performance.now();
    try {
      await this.target.save(text);
      if (this.target.fenced) { this.stats.fenced = true; return; }
      const ms = performance.now() - w0;
      if (this.stats.consecutiveFailures) this.log(`[siderarium] 저장 복구: ${this.stats.consecutiveFailures}회 연속 실패 후 성공`);
      this.stats.ok++; this.stats.consecutiveFailures = 0; this.stats.lastOkAt = this.now();
      this.stats.lastBytes = text.length; this.stats.maxBytes = Math.max(this.stats.maxBytes, text.length);
      this.stats.lastWriteMs = ms; this.stats.maxWriteMs = Math.max(this.stats.maxWriteMs, ms);
    } catch (e) { this.fail(e); return; }
    if (atext !== null) {
      const a0 = performance.now();
      try {
        await this.target.saveAnalytics!(atext);
        const A = this.stats.analytics;
        A.ok++; A.stored = true; A.lastOkAt = this.now(); A.lastBytes = atext.length; A.lastWriteMs = performance.now() - a0; A.lastError = null;
        this.lastAnalyticsAt = this.now();
      } catch (e) {
        const A = this.stats.analytics;
        A.failures++; A.lastError = msg(e);
        this.log(`[siderarium] !!! 분석 기록 저장 실패 (${A.failures}회): ${A.lastError} — 월드 저장은 계속됩니다`);
      }
    }
  }
  private fail(e: unknown) {
    const s = this.stats;
    s.failures++; s.consecutiveFailures++; s.lastError = msg(e); s.lastErrorAt = this.now();
    this.log(`[siderarium] !!! 저장 실패 (${s.consecutiveFailures}회 연속): ${s.lastError}`);
  }
}

/** a separately stored analytics record as written by Saver */
export interface AnalyticsRecord { v: 1; seed: number | null; time: number; store: AnalyticsStore }

/**
 * Which analytics history to continue with: the separate record when it belongs to this world (same seed,
 * not from the future of the world — e.g. a world that was reset) and is newer than any copy inside the
 * world save (an older server writes it there). Returns where it came from for the startup log.
 */
export function pickAnalytics(saved: SaveFile | null, rec: AnalyticsRecord | null): { store?: AnalyticsStore; from: 'world' | 'separate' | 'none'; why?: string } {
  const inWorld = saved?.analytics;
  if (!rec || rec.v !== 1 || !rec.store) return inWorld ? { store: inWorld, from: 'world' } : { from: 'none' };
  const w = saved?.world;
  const reject = (why: string) => inWorld ? { store: inWorld, from: 'world' as const, why } : { from: 'none' as const, why };
  if (!w) return reject('월드 없음');
  if ((rec.seed ?? null) !== (w.seed ?? null)) return reject('다른 월드(시드)');
  if (!(rec.time <= w.time + 1) || !(rec.store.started <= w.time + 1)) return reject('월드보다 미래의 기록(초기화된 월드)');
  const end = (s: AnalyticsStore) => Math.max(s.current?.end ?? 0, s.lastSample ?? 0);
  if (inWorld && end(inWorld) > end(rec.store)) return { store: inWorld, from: 'world', why: '월드 저장의 분석 기록이 더 최신' };
  // written at the same moment as the world (shutdown, or both in one autosave): nothing went unobserved
  if (rec.time === w.time) { const { pausedAt: _p, ...store } = rec.store; void _p; return { store: store as AnalyticsStore, from: 'separate' }; }
  return { store: rec.store, from: 'separate' };
}
