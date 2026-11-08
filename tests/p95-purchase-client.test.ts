import { describe, expect, it, vi } from 'vitest';
import { GameClient, type Transport } from '../src/client/net';
import type { ClientMsg, WorldView } from '../src/server/protocol';
import { WorldSim } from '../src/world/sim';
import { qty } from '../src/world/types';

describe('construction-material market purchase retries', () => {
  it('reuses an unacknowledged purchase after a browser reload without a second debit or delivery', async () => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    try {
      const sim = WorldSim.create(955), p = sim.addPlayer('구매 재시도'); sim.st.companies[p].credits = 100000;
      const sent: Extract<ClientMsg, { t: 'cmd' }>[] = [];
      const transport = (): Transport => ({ kind: 'remote', onMessage: () => {}, close() {}, send(m) { if (m.t === 'cmd') sent.push(structuredClone(m)); } });
      const firstTransport = transport(), first = new GameClient(firstTransport);
      first.company = p; first.state = structuredClone(sim.st) as WorldView;
      const buy = { c: 'buy', station: 'astra', res: 'alloy', amount: 100 } as const;
      const pending = first.cmd(buy);
      expect(sent[0].cmd.c).toBe('buy'); expect(sim.command(p, sent[0].cmd)).toBeNull();
      const credits = sim.st.companies[p].credits, stock = sim.st.stations.astra.market!.alloy.stock;
      vi.advanceTimersByTime(8000);
      expect(await pending).toMatch(/구매 응답 없음/);
      const secondTransport = transport(), reloaded = new GameClient(secondTransport);
      reloaded.company = p; reloaded.state = structuredClone(sim.st) as WorldView;
      const retry = reloaded.cmd(buy);
      expect(sent[1].cmd).toEqual(sent[0].cmd);
      const error = sim.command(p, sent[1].cmd);
      secondTransport.onMessage({ t: 'ack', id: sent[1].id, err: error });
      expect(await retry).toBeNull();
      expect(sim.st.companies[p].credits).toBe(credits); expect(sim.st.stations.astra.market!.alloy.stock).toBe(stock);
      expect(qty(sim.st.stations.astra.storage[p], 'alloy')).toBe(100);
      // A deliberately initiated later purchase receives the next identity and is charged once.
      reloaded.state = structuredClone(sim.st) as WorldView;
      const later = reloaded.cmd(buy); const laterCmd = sent[2].cmd;
      expect(laterCmd.c === 'buy' && laterCmd.request?.seq).toBe(2);
      secondTransport.onMessage({ t: 'ack', id: sent[2].id, err: sim.command(p, laterCmd) });
      expect(await later).toBeNull(); expect(qty(sim.st.stations.astra.storage[p], 'alloy')).toBe(200);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
});
