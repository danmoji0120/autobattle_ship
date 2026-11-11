import { describe, expect, it } from 'vitest';
import { ConnGuard, DEFAULT_LIMITS, limitsFromEnv, parseClientMsg } from '../src/server/wsguard';

describe('WebSocket guard', () => {
  it('lets a normal client through: pings every 2 s, bursts of clicks, a reconnect queue flush', () => {
    const g = new ConnGuard(DEFAULT_LIMITS, 0);
    let t = 0, dropped = 0;
    // a reconnect flushes 50 queued commands at once
    for (let i = 0; i < 50; i++) if (g.admit('cmd', t) !== 'ok') dropped++;
    // then 10 minutes of play: ping every 2 s, a click burst of 8 commands every 5 s, view changes
    for (t = 0; t < 600_000; t += 100) {
      if (t % 2000 === 0 && g.admit('ping', t) !== 'ok') dropped++;
      if (t % 5000 < 800 && g.admit('cmd', t) !== 'ok') dropped++;
      if (t % 30_000 === 0 && g.admit('view', t) !== 'ok') dropped++;
      if (t % 60_000 === 0 && g.admit('analytics', t) !== 'ok') dropped++;
    }
    expect(dropped).toBe(0);
  });

  it('drops a flood, then closes the connection', () => {
    const g = new ConnGuard(DEFAULT_LIMITS, 0);
    const v = Array.from({ length: 2000 }, (_, i) => g.admit('cmd', i / 10));
    expect(v.slice(0, 60).every(x => x === 'ok')).toBe(true);
    expect(v.includes('drop')).toBe(true);
    expect(v.at(-1)).toBe('close');
    // analytics queries have their own small budget
    const q = new ConnGuard(DEFAULT_LIMITS, 0);
    expect(Array.from({ length: 10 }, () => q.admit('analytics', 0)).filter(x => x === 'ok')).toHaveLength(DEFAULT_LIMITS.queryBurst);
  });

  it('slow readers: congested above the high mark, terminated when it lasts or the buffer is huge', () => {
    const g = new ConnGuard(DEFAULT_LIMITS, 0);
    expect(g.sendState(1000, 0)).toBe('ok');
    expect(g.sendState(DEFAULT_LIMITS.sendHigh, 1000)).toBe('congested');
    expect(g.sendState(DEFAULT_LIMITS.sendHigh, 1000 + DEFAULT_LIMITS.congestedMaxS * 1000 - 1)).toBe('congested');
    expect(g.sendState(10, 5000)).toBe('ok'); // drained: the clock restarts
    expect(g.sendState(DEFAULT_LIMITS.sendHigh, 6000)).toBe('congested');
    expect(g.sendState(DEFAULT_LIMITS.sendHigh, 6000 + DEFAULT_LIMITS.congestedMaxS * 1000 + 1)).toBe('terminate');
    expect(new ConnGuard(DEFAULT_LIMITS, 0).sendState(DEFAULT_LIMITS.sendLimit, 0)).toBe('terminate');
  });

  it('accepts only JSON objects with a kind', () => {
    expect(parseClientMsg('{"t":"ping","at":1}')).toEqual({ t: 'ping', at: 1 });
    for (const bad of ['', '{"t":', 'null', '[1]', '"x"', '{"t":1}', '{}']) expect(parseClientMsg(bad)).toBeNull();
  });

  it('limits from the environment; invalid values keep the defaults', () => {
    const l = limitsFromEnv({ WS_MAX_PAYLOAD: '131072', WS_CMD_RATE: '0', WS_MSG_BURST: 'abc' });
    expect(l.maxPayload).toBe(131072);
    expect(l.cmdRate).toBe(DEFAULT_LIMITS.cmdRate);
    expect(l.msgBurst).toBe(DEFAULT_LIMITS.msgBurst);
  });
});
