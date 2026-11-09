import { describe, expect, it, vi } from 'vitest';
import { GameClient, type Transport } from '../src/client/net';
import { WorldSim, type Cmd } from '../src/world/sim';
import type { ClientMsg, WorldView } from '../src/server/protocol';
import { qty } from '../src/world/types';

describe('retry-safe trade client', () => {
  it.each(['sell', 'buyListing'] as const)('reuses an unacknowledged %s after browser and server restart', async kind => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    try {
      let sim = WorldSim.create(96323); const buyer = sim.addPlayer('인수 회사'), seller = sim.addPlayer('판매 회사');
      sim.st.companies[buyer].credits = 100_000; const station = sim.st.stations.astra;
      station.storage[seller].alloy = 50;
      expect(sim.command(seller, { c: 'list', station: station.id, item: 'alloy', qty: 50, price: 10 })).toBeNull();
      station.storage[buyer].ore = 50;
      const command: Cmd = kind === 'sell' ? { c: 'sell', station: station.id, res: 'ore', amount: 10 }
        : { c: 'buyListing', station: station.id, listing: station.listings![0].id, qty: 10 };
      const sent: Extract<ClientMsg, { t: 'cmd' }>[] = [];
      const transport = (): Transport => ({ kind: 'remote', onMessage: () => {}, close() {}, send(m) { if (m.t === 'cmd') sent.push(structuredClone(m)); } });
      const firstT = transport(), first = new GameClient(firstT); first.company = buyer; first.state = structuredClone(sim.st) as WorldView;
      const firstResult = first.cmd(command); expect(sim.command(buyer, sent[0].cmd)).toBeNull();
      const credits = sim.st.companies[buyer].credits, sellerCredits = sim.st.companies[seller].credits;
      const inventory = structuredClone(station.storage[buyer]), listingQty = station.listings![0].qty;
      vi.advanceTimersByTime(8000); expect(await firstResult).toMatch(/거래 응답 없음/);
      sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
      const retryT = transport(), reloaded = new GameClient(retryT); reloaded.company = buyer; reloaded.state = structuredClone(sim.st) as WorldView;
      const retry = reloaded.cmd(command); expect(sent[1].cmd).toEqual(sent[0].cmd);
      retryT.onMessage({ t: 'ack', id: sent[1].id, err: sim.command(buyer, sent[1].cmd) }); expect(await retry).toBeNull();
      expect(sim.st.companies[buyer].credits).toBe(credits); expect(sim.st.companies[seller].credits).toBe(sellerCredits);
      expect(sim.st.stations.astra.storage[buyer]).toEqual(inventory); expect(sim.st.stations.astra.listings![0].qty).toBe(listingQty);
      // A later deliberate action has a fresh identity and is processed once.
      reloaded.state = structuredClone(sim.st) as WorldView;
      const later = reloaded.cmd(command), last = sent[2].cmd;
      expect((last.c === 'sell' || last.c === 'buyListing') && last.request?.seq).toBe(2);
      retryT.onMessage({ t: 'ack', id: sent[2].id, err: sim.command(buyer, last) }); expect(await later).toBeNull();
      expect(qty(sim.st.stations.astra.storage[buyer], kind === 'sell' ? 'ore' : 'alloy')).toBe(kind === 'sell' ? 30 : 20);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it('coalesces double-clicked listings and safely retries a lost withdrawal acknowledgement', async () => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    try {
      let sim = WorldSim.create(96324); const p = sim.addPlayer('매물 회사'); sim.st.stations.astra.storage[p].ore = 30;
      const sent: Extract<ClientMsg, { t: 'cmd' }>[] = [];
      const transport = (): Transport => ({ kind: 'remote', onMessage: () => {}, close() {}, send(m) { if (m.t === 'cmd') sent.push(structuredClone(m)); } });
      const t = transport(), client = new GameClient(t); client.company = p; client.state = structuredClone(sim.st) as WorldView;
      const listing = { c: 'list', station: 'astra', item: 'ore', qty: 10, price: 10 } as const;
      const first = client.cmd(listing), duplicate = client.cmd(listing);
      expect(sent[1].cmd).toEqual(sent[0].cmd);
      t.onMessage({ t: 'ack', id: sent[0].id, err: sim.command(p, sent[0].cmd) });
      t.onMessage({ t: 'ack', id: sent[1].id, err: sim.command(p, sent[1].cmd) });
      expect(await first).toBeNull(); expect(await duplicate).toBeNull();
      expect(sim.st.stations.astra.listings).toHaveLength(1); expect(qty(sim.st.stations.astra.storage[p], 'ore')).toBe(20);
      client.state = structuredClone(sim.st) as WorldView;
      const withdraw = { c: 'delist', station: 'astra', listing: sim.st.stations.astra.listings![0].id } as const;
      const pending = client.cmd(withdraw); expect(sim.command(p, sent[2].cmd)).toBeNull();
      vi.advanceTimersByTime(8000); expect(await pending).toMatch(/거래 응답 없음/);
      sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
      const t2 = transport(), reload = new GameClient(t2); reload.company = p; reload.state = structuredClone(sim.st) as WorldView;
      const retry = reload.cmd(withdraw); expect(sent[3].cmd).toEqual(sent[2].cmd);
      t2.onMessage({ t: 'ack', id: sent[3].id, err: sim.command(p, sent[3].cmd) }); expect(await retry).toBeNull();
      expect(qty(sim.st.stations.astra.storage[p], 'ore')).toBe(30); expect(sim.st.stations.astra.listings).toHaveLength(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it.each(['buyShip', 'buyShipListing'] as const)('retries an unacknowledged %s without buying another ship', async kind => {
    vi.useFakeTimers();
    const data = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
    try {
      let sim = WorldSim.create(96325); const buyer = sim.addPlayer('인수 회사'), seller = sim.addPlayer('판매 회사');
      sim.st.companies[buyer].credits = 1_000_000; sim.st.companies[buyer].rep = 1000;
      sim.st.stations.helios.shipStock!.frigate_mk1 = { n: 4, t: 0 };
      const ship = Object.values(sim.st.ships).find(s => s.owner === seller && s.task.k === 'docked' && s.task.station === 'astra')!;
      expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 1000 })).toBeNull();
      const cmd: Cmd = kind === 'buyShip' ? { c: 'buyShip', station: 'helios', classId: 'frigate', loadoutId: 'aa' }
        : { c: 'buyShipListing', station: 'astra', listing: sim.st.stations.astra.shipListings![0].id };
      const sent: Extract<ClientMsg, { t: 'cmd' }>[] = [];
      const transport = (): Transport => ({ kind: 'remote', onMessage: () => {}, close() {}, send(m) { if (m.t === 'cmd') sent.push(structuredClone(m)); } });
      const firstT = transport(), first = new GameClient(firstT); first.company = buyer; first.state = structuredClone(sim.st) as WorldView;
      const pending = first.cmd(cmd); expect(sim.command(buyer, sent[0].cmd)).toBeNull();
      const credits = sim.st.companies[buyer].credits, count = Object.values(sim.st.ships).filter(s => s.owner === buyer).length;
      vi.advanceTimersByTime(8000); expect(await pending).toMatch(/거래 응답 없음/);
      sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
      const retryT = transport(), retry = new GameClient(retryT); retry.company = buyer; retry.state = structuredClone(sim.st) as WorldView;
      const result = retry.cmd(cmd); expect(sent[1].cmd).toEqual(sent[0].cmd);
      retryT.onMessage({ t: 'ack', id: sent[1].id, err: sim.command(buyer, sent[1].cmd) }); expect(await result).toBeNull();
      expect(sim.st.companies[buyer].credits).toBe(credits);
      expect(Object.values(sim.st.ships).filter(s => s.owner === buyer)).toHaveLength(count);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

});
