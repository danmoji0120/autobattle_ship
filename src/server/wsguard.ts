// Per-connection protection for the multiplayer WebSocket (used by node.ts, unit-tested on its own).
//
//  • message size: the ws `maxPayload` (the largest real client message is a few KB; see docs/P0_SERVER_STABILITY.md)
//  • request rate: token buckets per connection — all messages, game commands, analytics queries.
//    A message over the limit is dropped (a command gets an error ack so the client's promise settles);
//    a client that keeps flooding (drops far beyond any UI burst) is disconnected.
//  • slow readers: while a socket's send buffer is above `sendHigh` the periodic world updates are skipped
//    for it (protocol 2 then sends the accumulated change once it drains); a socket that stays congested
//    for `congestedMaxS` or whose buffer exceeds `sendLimit` is terminated (the client reconnects and
//    receives a fresh full state).
// Defaults are far above what the browser client does (pings every 2 s, commands on clicks) and can be
// changed with environment variables.

export interface GuardLimits {
  maxPayload: number;
  msgRate: number; msgBurst: number;
  cmdRate: number; cmdBurst: number;
  queryRate: number; queryBurst: number;
  /** dropped messages within `floodWindowS` that close the connection */
  floodDrops: number; floodWindowS: number;
  /** bytes waiting in the socket send buffer above which periodic updates are skipped */
  sendHigh: number;
  /** bytes waiting above which the connection is terminated */
  sendLimit: number;
  /** seconds a socket may stay congested before it is terminated */
  congestedMaxS: number;
  /** concurrent sockets per account (the oldest is closed when exceeded) */
  socketsPerAccount: number;
  /** WebSocket ping interval; a socket that did not answer the previous ping is terminated */
  heartbeatS: number;
}

export const DEFAULT_LIMITS: GuardLimits = {
  maxPayload: 64 * 1024,
  msgRate: 30, msgBurst: 120,
  cmdRate: 10, cmdBurst: 60,
  queryRate: 1, queryBurst: 6,
  floodDrops: 300, floodWindowS: 10,
  sendHigh: 512 * 1024, sendLimit: 8 * 1024 * 1024, congestedMaxS: 60,
  socketsPerAccount: 4,
  heartbeatS: 30,
};

const ENV: Record<keyof GuardLimits, string> = {
  maxPayload: 'WS_MAX_PAYLOAD', msgRate: 'WS_MSG_RATE', msgBurst: 'WS_MSG_BURST', cmdRate: 'WS_CMD_RATE', cmdBurst: 'WS_CMD_BURST',
  queryRate: 'WS_QUERY_RATE', queryBurst: 'WS_QUERY_BURST', floodDrops: 'WS_FLOOD_DROPS', floodWindowS: 'WS_FLOOD_WINDOW_S',
  sendHigh: 'WS_SEND_HIGH', sendLimit: 'WS_SEND_LIMIT', congestedMaxS: 'WS_CONGESTED_MAX_S', socketsPerAccount: 'WS_SOCKETS_PER_ACCOUNT', heartbeatS: 'WS_HEARTBEAT_S',
};

/** limits from the environment (invalid or non-positive values keep the default) */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): GuardLimits {
  const out = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(ENV) as (keyof GuardLimits)[]) {
    const raw = env[ENV[k]];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) out[k] = n;
    else console.warn(`[siderarium] ${ENV[k]}=${raw} 무시 (양수가 아님) — 기본값 ${out[k]} 사용`);
  }
  return out;
}

export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(private rate: number, private burst: number, now: number) { this.tokens = burst; this.at = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / 1000 * this.rate);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const CMD_KINDS = new Set(['cmd', 'border', 'createPmc', 'bjoin', 'view', 'speed', 'hello']);

export type Verdict = 'ok' | 'drop' | 'close';

/** what one connection may still send right now */
export class ConnGuard {
  private all: TokenBucket;
  private cmd: TokenBucket;
  private query: TokenBucket;
  private drops: number[] = [];
  dropped = 0;
  malformed = 0;
  congestedSince = 0;
  constructor(private lim: GuardLimits, now = Date.now()) {
    this.all = new TokenBucket(lim.msgRate, lim.msgBurst, now);
    this.cmd = new TokenBucket(lim.cmdRate, lim.cmdBurst, now);
    this.query = new TokenBucket(lim.queryRate, lim.queryBurst, now);
  }
  /** a parsed message of kind `t` arrived */
  admit(t: unknown, now = Date.now()): Verdict {
    let ok = this.all.take(now);
    if (ok && typeof t === 'string') {
      if (t === 'analytics') ok = this.query.take(now);
      else if (CMD_KINDS.has(t)) ok = this.cmd.take(now);
    }
    if (ok) return 'ok';
    return this.drop(now);
  }
  /** a message that could not be parsed or has no kind: counts towards flooding */
  bad(now = Date.now()): Verdict { this.malformed++; return this.drop(now); }
  private drop(now: number): Verdict {
    this.dropped++;
    const from = now - this.lim.floodWindowS * 1000;
    this.drops.push(now);
    while (this.drops.length && this.drops[0] < from) this.drops.shift();
    return this.drops.length >= this.lim.floodDrops ? 'close' : 'drop';
  }
  /** called with the socket's pending send bytes: is it congested, and must it be cut off? */
  sendState(buffered: number, now = Date.now()): 'ok' | 'congested' | 'terminate' {
    if (buffered >= this.lim.sendLimit) return 'terminate';
    if (buffered < this.lim.sendHigh) { this.congestedSince = 0; return 'ok'; }
    if (!this.congestedSince) this.congestedSince = now;
    return now - this.congestedSince > this.lim.congestedMaxS * 1000 ? 'terminate' : 'congested';
  }
}

/** a client message must be a JSON object with a string kind */
export function parseClientMsg(raw: string): { t: string } | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  return m && typeof m === 'object' && !Array.isArray(m) && typeof (m as { t?: unknown }).t === 'string' ? m as { t: string } : null;
}
