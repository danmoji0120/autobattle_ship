import { describe, expect, it } from 'vitest';
import { WorldSim } from '../src/world/sim';
import { qty, type Station } from '../src/world/types';
import type { RouteConfig } from '../src/world/logistics';
import { econOf } from '../src/world/hullops';
import { publicCap } from '../src/world/storage';
import { GameServer, type Conn } from '../src/server/core';
import type { ServerMsg } from '../src/server/protocol';
import type { WorldView } from '../src/server/protocol';
import { newIndUi, storeHtml } from '../src/client/strategic/industryUi';
import { exchangeHtml } from '../src/client/strategic/growthUi';

function fixture() {
  const sim = WorldSim.create(9632); (sim as any).npcSlow = () => {};
  for (const l of Object.values(sim.st.lairs)) { l.alive = false; l.respawnAt = 1e10; }
  for (const sys of Object.values(sim.st.systems)) sys.security = 100;
  const seller = sim.addPlayer('판매 회사'), buyer = sim.addPlayer('구매 회사');
  sim.st.companies[seller].credits = 1_000_000; sim.st.companies[buyer].credits = 1_000_000;
  const market = sim.st.stations.astra;
  return { sim, seller, buyer, market };
}

function until(sim: WorldSim, done: () => boolean, seconds = 1200) {
  for (let t = 0; t < seconds && !done(); t += .25) sim.update(.25);
  expect(done()).toBe(true);
}

describe('P9.6.3.2 trade and physical cargo handoff', () => {
  it('rejects inherited or non-numeric warehouse properties instead of creating fake exchange listings', () => {
    const { sim, seller, buyer, market } = fixture();
    const sellerCredit = sim.st.companies[seller].credits, buyerCredit = sim.st.companies[buyer].credits;
    const before = JSON.stringify(market.storage[seller]);
    for (const item of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      expect(sim.command(seller, { c: 'list', station: market.id, item, qty: 1, price: 100 })).not.toBeNull();
    }
    expect(market.listings ?? []).toEqual([]); expect(JSON.stringify(market.storage[seller])).toBe(before);
    expect(sim.st.companies[seller].credits).toBe(sellerCredit); expect(sim.st.companies[buyer].credits).toBe(buyerCredit);
  });

  it('idempotently sells a confirmed request even across reload, without selling a second lot', () => {
    const { sim, seller, market } = fixture(); market.storage[seller].ore = 100;
    const sell = { c: 'sell', station: market.id, res: 'ore', amount: 10, request: { seq: 1, id: 'p9632-sale-0001' } } as const;
    const before = sim.st.companies[seller].credits;
    expect(sim.command(seller, sell)).toBeNull();
    const credits = sim.st.companies[seller].credits, marketStock = market.market!.ore.stock;
    expect(credits).toBeGreaterThan(before); expect(qty(market.storage[seller], 'ore')).toBe(90);
    expect(sim.command(seller, sell)).toBeNull();
    expect(sim.st.companies[seller].credits).toBe(credits); expect(market.market!.ore.stock).toBe(marketStock); expect(qty(market.storage[seller], 'ore')).toBe(90);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(restored.command(seller, sell)).toBeNull();
    expect(restored.st.companies[seller].credits).toBe(credits); expect(qty(restored.st.stations.astra.storage[seller], 'ore')).toBe(90);
  });

  it('records only successful sale requests, isolates companies and rejects conflicts and stale sequences', () => {
    const { sim, seller, buyer, market } = fixture();
    const request = { seq: 1, id: 'p9632-sell-id01' };
    const cmd = { c: 'sell', station: market.id, res: 'ore', amount: 10, request } as const;
    expect(sim.command(seller, cmd)).toMatch(/창고/); expect(sim.st.companies[seller].lastTrade).toBeUndefined();
    market.storage[seller].ore = 30; market.storage[buyer].ore = 20;
    expect(sim.command(seller, cmd)).toBeNull(); expect(sim.command(buyer, cmd)).toBeNull();
    const credit = sim.st.companies[seller].credits;
    expect(sim.command(seller, { ...cmd, amount: 11 })).toMatch(/지난 거래/);
    expect(sim.command(seller, { ...cmd, request: { ...request, id: 'p9632-other-id' } })).toMatch(/지난 거래/);
    expect(sim.command(seller, { ...cmd, request: { seq: 3, id: 'p9632-next-id3' } })).toMatch(/대기 중/);
    expect(sim.st.companies[seller].credits).toBe(credit); expect(qty(market.storage[seller], 'ore')).toBe(20);
    expect(sim.command(seller, { ...cmd, request: { seq: 2, id: 'p9632-next-id2' } })).toBeNull();
    expect(sim.command(seller, cmd)).toMatch(/지난 거래/); expect(qty(market.storage[seller], 'ore')).toBe(10);
  });

  it('preserves the unsold portion and retries an idempotent partial sale at the actual station budget', () => {
    const { sim, seller, market } = fixture(); market.storage[seller].ore = 100;
    const price = sim.price(market, 'ore', 'sell'), tax = 1 - (market.tax ?? 0);
    market.funds = price * tax * 5 + 1e-7;
    const before = sim.st.companies[seller].credits, stock = market.market!.ore.stock, funds = market.funds;
    const cmd = { c: 'sell', station: market.id, res: 'ore', amount: 10, request: { seq: 1, id: 'p9632-partial01' } } as const;
    expect(sim.command(seller, cmd)).toBeNull();
    expect(qty(market.storage[seller], 'ore')).toBe(95); expect(market.market!.ore.stock).toBe(stock + 5);
    const earned = sim.st.companies[seller].credits - before;
    expect(earned).toBeCloseTo(funds - market.funds!, 7);
    expect(sim.command(seller, cmd)).toBeNull(); expect(qty(market.storage[seller], 'ore')).toBe(95); expect(sim.st.companies[seller].credits - before).toBeCloseTo(earned, 8);
  });

  it('idempotently purchases a partial player listing without charging or delivering twice', () => {
    const { sim, seller, buyer, market } = fixture(); market.storage[seller].alloy = 100;
    expect(sim.command(seller, { c: 'list', station: market.id, item: 'alloy', qty: 100, price: 10 })).toBeNull();
    const listing = market.listings![0];
    const buy = { c: 'buyListing', station: market.id, listing: listing.id, qty: 10, request: { seq: 1, id: 'p9632-trade-0001' } } as const;
    expect(sim.command(buyer, buy)).toBeNull();
    const credits = sim.st.companies[buyer].credits, sellerCredits = sim.st.companies[seller].credits;
    expect(sim.command(buyer, buy)).toBeNull();
    expect(sim.st.companies[buyer].credits).toBe(credits); expect(sim.st.companies[seller].credits).toBe(sellerCredits);
    expect(qty(market.storage[buyer], 'alloy')).toBe(10); expect(listing.qty).toBe(90);
  });

  it('does not buy another NPC ship when the same successful request is retried', () => {
    const { sim, buyer } = fixture(); sim.st.companies[buyer].rep = 1000;
    const helios = sim.st.stations.helios;
    helios.shipStock!.frigate_mk1 = { n: 4, t: 0 };
    const cmd = { c: 'buyShip', station: 'helios', classId: 'frigate', loadoutId: 'aa', request: { seq: 1, id: 'ship-buy-00001' } } as const;
    expect(sim.command(buyer, cmd)).toBeNull();
    const credits = sim.st.companies[buyer].credits, stock = helios.shipStock!.frigate_mk1.n;
    const ships = Object.values(sim.st.ships).filter(s => s.owner === buyer).length;
    expect(sim.command(buyer, cmd)).toBeNull();
    expect(sim.st.companies[buyer].credits).toBe(credits); expect(helios.shipStock!.frigate_mk1.n).toBe(stock);
    expect(Object.values(sim.st.ships).filter(s => s.owner === buyer)).toHaveLength(ships);
  });

  it('replays a ship handoff acknowledgement and rejects an orphan sale before charging', () => {
    let { sim, seller, buyer, market } = fixture();
    const ship = Object.values(sim.st.ships).find(s => s.owner === seller && s.task.k === 'docked' && s.task.station === market.id)!;
    expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 1000 })).toBeNull();
    const listing = market.shipListings![0];
    const cmd = { c: 'buyShipListing', station: market.id, listing: listing.id, request: { seq: 1, id: 'ship-sale-00001' } } as const;
    expect(sim.command(buyer, cmd)).toBeNull(); const credits = sim.st.companies[buyer].credits;
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(sim.command(buyer, cmd)).toBeNull(); expect(sim.st.companies[buyer].credits).toBe(credits);
    expect(sim.st.ships[ship.id].owner).toBe(buyer);
    const other = Object.values(sim.st.ships).find(s => s.owner === seller && s.task.k === 'docked' && s.task.station === market.id)!;
    expect(sim.command(seller, { c: 'listShip', ship: other.id, price: 1000 })).toBeNull();
    const bad = sim.st.stations.astra.shipListings![0]; bad.seller = 'missing-company'; other.owner = 'missing-company';
    expect(sim.command(buyer, { c: 'buyShipListing', station: market.id, listing: bad.id })).toMatch(/판매 회사/);
    expect(sim.st.companies[buyer].credits).toBe(credits); expect(other.owner).toBe('missing-company');
    expect(sim.st.stations.astra.shipListings).toContain(bad);
  });

  it('does not transfer a seller’s fractional cargo with a newly listed or legacy listed ship', () => {
    const { sim, seller, buyer, market } = fixture();
    const ship = Object.values(sim.st.ships).find(s => s.owner === seller && s.task.k === 'docked' && s.task.station === market.id)!;
    ship.cargo.ore = .25;
    expect(exchangeHtml(sim.st as unknown as WorldView, market, seller, [])).toContain('0.25');
    expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 1000 })).toMatch(/화물/);
    expect(ship.owner).toBe(seller); expect(qty(ship.cargo, 'ore')).toBe(.25); expect(market.shipListings ?? []).toHaveLength(0);
    expect(sim.command(seller, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    expect(qty(market.storage[seller], 'ore')).toBe(.25); expect(qty(ship.cargo, 'ore')).toBe(0);
    expect(storeHtml(sim.st as unknown as WorldView, market, seller, newIndUi())).toContain('0.25');
    expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 1000 })).toBeNull();
    ship.cargo.ore = .25; // A pre-existing listing created before this validation was introduced.
    const listing = market.shipListings![0], credits = sim.st.companies[buyer].credits;
    expect(sim.command(buyer, { c: 'buyShipListing', station: market.id, listing: listing.id })).toMatch(/화물/);
    expect(sim.st.companies[buyer].credits).toBe(credits); expect(ship.owner).toBe(seller);
    expect(qty(ship.cargo, 'ore')).toBe(.25); expect(market.shipListings).toHaveLength(1);
    expect(sim.command(seller, { c: 'delistShip', station: market.id, listing: listing.id })).toBeNull();
    expect(sim.command(seller, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    expect(qty(market.storage[seller], 'ore')).toBe(.5);
  });

  it('rejects a corrupt ship-listing price without paying a buyer or taking the seller’s ship', () => {
    const { sim, seller, buyer, market } = fixture();
    const ship = Object.values(sim.st.ships).find(s => s.owner === seller && s.task.k === 'docked' && s.task.station === market.id)!;
    expect(sim.command(seller, { c: 'listShip', ship: ship.id, price: 1000 })).toBeNull();
    const listing = market.shipListings![0], buyerCredit = sim.st.companies[buyer].credits, sellerCredit = sim.st.companies[seller].credits;
    listing.price = -1000;
    expect(sim.command(buyer, { c: 'buyShipListing', station: market.id, listing: listing.id })).toMatch(/유효하지 않은 매물/);
    expect(sim.st.companies[buyer].credits).toBe(buyerCredit); expect(sim.st.companies[seller].credits).toBe(sellerCredit);
    expect(ship.owner).toBe(seller); expect(market.shipListings).toHaveLength(1);
  });

  it('registers and withdraws the same escrow request only once, including after save and restore', () => {
    const f = fixture(); let sim = f.sim; const { seller } = f, station = f.market;
    station.storage[seller].ore = 30;
    const list = { c: 'list', station: station.id, item: 'ore', qty: 10, price: 10, request: { seq: 1, id: 'p9632-list-0001' } } as const;
    expect(sim.command(seller, list)).toBeNull();
    expect(sim.command(seller, list)).toBeNull();
    expect(qty(station.storage[seller], 'ore')).toBe(20); expect(station.listings).toHaveLength(1);
    const id = station.listings![0].id;
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(sim.command(seller, list)).toBeNull(); expect(sim.st.stations.astra.listings).toHaveLength(1);
    const delist = { c: 'delist', station: 'astra', listing: id, request: { seq: 2, id: 'p9632-delist01' } } as const;
    expect(sim.command(seller, delist)).toBeNull(); expect(sim.command(seller, delist)).toBeNull();
    expect(qty(sim.st.stations.astra.storage[seller], 'ore')).toBe(30); expect(sim.st.stations.astra.listings).toHaveLength(0);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(sim.command(seller, delist)).toBeNull(); expect(qty(sim.st.stations.astra.storage[seller], 'ore')).toBe(30);
  });

  it('rejects invalid legacy listings before money or goods move', () => {
    const { sim, buyer, market } = fixture(), co = sim.st.companies[buyer], before = co.credits;
    market.listings = [{ id: 'corrupt', seller: 'missing-company', item: 'ore', qty: 10, price: 50, t: 0 }];
    expect(sim.command(buyer, { c: 'buyListing', station: market.id, listing: 'corrupt', qty: 1 })).toMatch(/판매 회사/);
    expect(co.credits).toBe(before); expect(qty(market.storage[buyer], 'ore')).toBe(0); expect(market.listings[0].qty).toBe(10);
    market.listings[0].seller = sim.addPlayer('별도 판매사'); market.listings[0].item = '__proto__';
    expect(sim.command(buyer, { c: 'buyListing', station: market.id, listing: 'corrupt', qty: 1 })).toMatch(/유효하지 않은 매물/);
    expect(co.credits).toBe(before); expect(market.listings[0].qty).toBe(10);
  });

  it('keeps an invalid legacy escrow record unchanged instead of silently destroying it on withdrawal', () => {
    const { sim, seller, market } = fixture();
    market.listings = [{ id: 'legacy-bad', seller, item: '__proto__', qty: 5, price: 10, t: 0 }];
    const before = JSON.stringify(market.storage[seller]);
    expect(sim.command(seller, { c: 'delist', station: market.id, listing: 'legacy-bad' })).toMatch(/유효하지 않은 매물/);
    expect(market.listings).toHaveLength(1); expect(JSON.stringify(market.storage[seller])).toBe(before);
  });

  it('preserves credits, market stock and goods for a failed purchase and makes normal trades exactly once', () => {
    const { sim, buyer, market } = fixture(), co = sim.st.companies[buyer];
    const initial = { credits: co.credits, stock: market.market!.alloy.stock, funds: market.funds };
    const price = sim.price(market, 'alloy', 'buy');
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 20 })).toBeNull();
    expect(co.credits).toBeCloseTo(initial.credits - 20 * price, 8); expect(market.market!.alloy.stock).toBe(initial.stock - 20);
    expect(qty(market.storage[buyer], 'alloy')).toBe(20);
    co.credits = 0; const stock = market.market!.alloy.stock, held = qty(market.storage[buyer], 'alloy');
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 1 })).toMatch(/자금 부족/);
    expect(co.credits).toBe(0); expect(market.market!.alloy.stock).toBe(stock); expect(qty(market.storage[buyer], 'alloy')).toBe(held);
    market.market!.alloy.stock = 0; co.credits = 100_000;
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 1 })).toMatch(/재고 없음/);
    expect(co.credits).toBe(100_000); expect(qty(market.storage[buyer], 'alloy')).toBe(held);
    market.funds = 0; const before = co.credits;
    expect(sim.command(buyer, { c: 'sell', station: market.id, res: 'alloy', amount: 20 })).toMatch(/예산/);
    expect(co.credits).toBe(before); expect(qty(market.storage[buyer], 'alloy')).toBe(held);
  });

  it('does not charge for a full warehouse or hold, and only delivers to an owned ship at the market', () => {
    const { sim, seller, buyer, market } = fixture(), co = sim.st.companies[buyer];
    market.storage[buyer].ore = publicCap(co, market);
    const initial = { credits: co.credits, stock: market.market!.alloy.stock, funds: market.funds };
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 1 })).toMatch(/용량|공간/);
    expect({ credits: co.credits, stock: market.market!.alloy.stock, funds: market.funds }).toEqual(initial);
    const g = sim.newGroup(buyer, '구매 수송'), ship = sim.spawnShip(buyer, 'hauler', 'std', g.id, market.pos);
    expect((sim as any).dockShip(ship, market)).toBe(true);
    ship.cargo.ore = econOf(ship).cargo - 2;
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 3, ship: ship.id })).toMatch(/화물칸 부족/);
    expect(sim.command(seller, { c: 'buy', station: market.id, res: 'alloy', amount: 1, ship: ship.id })).toMatch(/자사 함선/);
    expect(sim.command(buyer, { c: 'buy', station: 'nova', res: 'alloy', amount: 1, ship: ship.id })).toMatch(/자사 함선/);
    expect({ credits: co.credits, stock: market.market!.alloy.stock, funds: market.funds }).toEqual(initial);
    const price = sim.price(market, 'alloy', 'buy');
    expect(sim.command(buyer, { c: 'buy', station: market.id, res: 'alloy', amount: 2, ship: ship.id })).toBeNull();
    expect(qty(ship.cargo, 'alloy')).toBe(2); expect(qty(market.storage[buyer], 'alloy')).toBe(0);
    expect(co.credits).toBeCloseTo(initial.credits - 2 * price, 8); expect(market.market!.alloy.stock).toBe(initial.stock - 2);
  });

  it('acknowledges authoritative trades and sends each company only its own inventory and receipts', () => {
    const f = fixture(); f.market.storage[f.seller].ore = 20;
    const file = { v: 1 as const, world: JSON.parse(f.sim.serialize()), auth: { seller: f.seller, buyer: f.buyer } };
    let server = new GameServer(file, { singleplayer: false, snapInterval: .1 });
    const sentSeller: ServerMsg[] = [], sentBuyer: ServerMsg[] = [];
    const connect = (id: string, messages: ServerMsg[]) => {
      const conn: Conn = { id, lastEvent: 0, battles: new Set(), send: msg => messages.push(JSON.parse(JSON.stringify(msg))) };
      server.connect(conn); server.handle(id, { t: 'hello', name: id, token: id });
    };
    connect('seller', sentSeller); connect('buyer', sentBuyer);
    const cmd = { c: 'sell', station: 'astra', res: 'ore', amount: 10, request: { seq: 1, id: 'server-sale-0001' } } as const;
    server.handle('seller', { t: 'cmd', id: 1, cmd }); server.step(.1);
    expect(sentSeller.find(m => m.t === 'ack' && m.id === 1)).toMatchObject({ err: null });
    const own = sentSeller.filter(m => m.t === 'snap').at(-1) as Extract<ServerMsg, { t: 'snap' }>;
    const other = sentBuyer.filter(m => m.t === 'snap').at(-1) as Extract<ServerMsg, { t: 'snap' }>;
    expect(qty(own.state.stations.astra.storage[f.seller], 'ore')).toBe(10);
    expect(own.state.companies[f.seller].lastTrade?.seq).toBe(1);
    expect(other.state.stations.astra.storage[f.seller]).toBeUndefined();
    expect(other.state.companies[f.seller].lastTrade).toBeUndefined();
    const credits = server.sim.st.companies[f.seller].credits;
    server = new GameServer(server.snapshotFile(), { singleplayer: false, snapInterval: .1 }); connect('seller', sentSeller);
    server.handle('seller', { t: 'cmd', id: 2, cmd }); server.step(.1);
    expect(sentSeller.find(m => m.t === 'ack' && m.id === 2)).toMatchObject({ err: null });
    expect(server.sim.st.companies[f.seller].credits).toBe(credits);
    expect(qty(server.sim.st.stations.astra.storage[f.seller], 'ore')).toBe(10);
  });

  it('partially unloads only available warehouse room and never takes another company’s cargo', () => {
    const { sim, seller, buyer, market } = fixture(); market.storage[buyer].ore = 2995;
    const group = sim.newGroup(buyer, '부분 하역'), ship = sim.spawnShip(buyer, 'hauler', 'std', group.id, market.pos);
    expect((sim as any).dockShip(ship, market)).toBe(true); ship.cargo.alloy = 20;
    expect(sim.command(seller, { c: 'unloadCargo', ship: ship.id })).toMatch(/자사/);
    expect(sim.command(buyer, { c: 'unloadCargo', ship: ship.id })).toBeNull();
    expect(qty(market.storage[buyer], 'alloy')).toBe(5); expect(qty(ship.cargo, 'alloy')).toBe(15);
    expect(sim.command(buyer, { c: 'unloadCargo', ship: ship.id })).toMatch(/빈 공간/);
    expect(qty(market.storage[buyer], 'alloy') + qty(ship.cargo, 'alloy')).toBe(20);
    const restored = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false });
    expect(qty(restored.st.stations.astra.storage[buyer], 'alloy')).toBe(5); expect(qty(restored.st.ships[ship.id].cargo, 'alloy')).toBe(15);
  });

  it('never loads past a ship’s remaining capacity when it already contains fractional cargo', () => {
    const { sim, buyer, market } = fixture();
    const group = sim.newGroup(buyer, '기존 운송'), ship = sim.spawnShip(buyer, 'hauler', 'std', group.id, market.pos);
    expect((sim as any).dockShip(ship, market)).toBe(true);
    const cap = econOf(ship).cargo; ship.cargo.ore = .25; market.storage[buyer].ore = cap * 2;
    const before = qty(market.storage[buyer], 'ore') + qty(ship.cargo, 'ore');
    expect(sim.command(buyer, { c: 'setOp', group: group.id, op: { k: 'haul', from: market.id, to: 'nova', res: 'ore' } })).toBeNull();
    until(sim, () => qty(ship.cargo, 'ore') > .25, 20);
    expect(qty(ship.cargo, 'ore')).toBeLessThanOrEqual(cap);
    expect(qty(market.storage[buyer], 'ore') + qty(ship.cargo, 'ore')).toBeCloseTo(before, 8);
  });

  it('transports owned blueprint fragments without inventing or losing records', () => {
    const { sim, buyer, market } = fixture(), destination = sim.st.stations.nova;
    market.storage[buyer]['bpf:bp_patrol_pathfinder'] = 2;
    const group = sim.newGroup(buyer, '설계도 운송'), ship = sim.spawnShip(buyer, 'hauler', 'std', group.id, market.pos);
    const cfg: RouteConfig = { name: '조각 운송', from: market.id, to: destination.id, item: 'bpf:bp_patrol_pathfinder', mode: 'transfer', amount: 2, repeat: false };
    expect(sim.command(buyer, { c: 'putRoute', group: group.id, config: cfg })).toBeNull();
    const route = Object.values(sim.st.logistics!).find(r => r.group === group.id)!;
    until(sim, () => route.state === 'complete');
    expect(qty(market.storage[buyer], cfg.item)).toBe(0); expect(qty(ship.cargo, cfg.item)).toBe(0);
    expect(qty(destination.storage[buyer], cfg.item)).toBe(2); expect(route.stats.delivered).toBe(2);
  }, 60_000);

  it('physically collects the buyer-owned goods from a private exchange without general docking access', () => {
    const f = fixture(), { seller, buyer } = f; let sim = f.sim;
    const home = sim.st.stations.astra;
    const station: Station = { ...structuredClone(home), id: 'private_exchange', name: '사설 거래소', owner: seller, public: false, size: 'S', market: null,
      pos: { ...home.pos, x: home.pos.x + 1200 }, services: { repair: false, shipyard: [], recruit: false, contracts: false, refit: false },
      storage: { [seller]: { ore: 50 }, [buyer]: {} }, modules: [{ kind: 'core', slot: 0, built: true, progress: 1 }, { kind: 'trade_hub', slot: 1, built: true, progress: 1 }] };
    sim.st.stations[station.id] = station;
    const outsider = sim.addPlayer('권한 없는 회사'), og = sim.newGroup(outsider, '무단 인수'), os = sim.spawnShip(outsider, 'hauler', 'std', og.id, station.pos);
    const denied: RouteConfig = { name: '무단', from: station.id, to: home.id, item: 'ore', mode: 'transfer', amount: 1, repeat: false };
    expect(sim.command(outsider, { c: 'putRoute', group: og.id, config: denied })).toMatch(/정거장/); expect(qty(os.cargo, 'ore')).toBe(0);
    expect(sim.command(seller, { c: 'list', station: station.id, item: 'ore', qty: 50, price: 10 })).toBeNull();
    expect(sim.command(buyer, { c: 'buyListing', station: station.id, listing: station.listings![0].id, qty: 10 })).toBeNull();
    expect(qty(station.storage[buyer], 'ore')).toBe(10); expect(sim.canDock(station, buyer)).toBe(false);
    const group = sim.newGroup(buyer, '인수 화물선'), ship = sim.spawnShip(buyer, 'hauler', 'std', group.id, station.pos);
    const cfg: RouteConfig = { name: '구매품 인수', from: station.id, to: home.id, item: 'ore', mode: 'transfer', amount: 10, repeat: true };
    expect(sim.command(buyer, { c: 'setOp', group: group.id, op: { k: 'dock', station: station.id } })).toMatch(/정박 불가/);
    expect(sim.command(buyer, { c: 'putRoute', group: group.id, config: { ...cfg, from: home.id, to: station.id } })).toMatch(/정거장/);
    expect(sim.command(buyer, { c: 'putRoute', group: group.id, config: cfg })).toBeNull();
    const id = Object.values(sim.st.logistics!).find(r => r.group === group.id)!.id;
    until(sim, () => sim.st.ships[ship.id].cargoWork?.key === `route:${id}:load`);
    const work = structuredClone(sim.st.ships[ship.id].cargoWork);
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); (sim as any).npcSlow = () => {};
    expect(sim.st.ships[ship.id].cargoWork).toEqual(work);
    until(sim, () => !!sim.st.logistics![id].manifests[ship.id]);
    expect(sim.st.ships[ship.id].state).toBe('space');
    expect(qty(sim.st.stations[station.id].storage[buyer], 'ore')).toBe(0); expect(qty(sim.st.ships[ship.id].cargo, 'ore')).toBe(10);
    expect(sim.command(buyer, { c: 'routeControl', routes: [id], action: 'pause' })).toBeNull();
    expect(sim.command(buyer, { c: 'routeControl', routes: [id], action: 'resume' })).toBeNull();
    sim = new WorldSim(JSON.parse(sim.serialize()), { migrateContent: false }); (sim as any).npcSlow = () => {};
    until(sim, () => sim.st.logistics![id].stats.delivered === 10);
    expect(qty(sim.st.stations.astra.storage[buyer], 'ore')).toBe(10); expect(qty(sim.st.ships[ship.id].cargo, 'ore')).toBe(0);
    expect(sim.st.logistics![id].stats.loaded).toBe(10); expect(sim.st.logistics![id].stats.delivered).toBe(10);
    // A drained source can be paused and resumed before the next purchase supplies more goods.
    expect(sim.command(buyer, { c: 'routeControl', routes: [id], action: 'pause' })).toBeNull();
    expect(sim.command(buyer, { c: 'routeControl', routes: [id], action: 'resume' })).toBeNull();
    const listing = sim.st.stations[station.id].listings![0];
    expect(sim.command(buyer, { c: 'buyListing', station: station.id, listing: listing.id, qty: 5 })).toBeNull();
    until(sim, () => sim.st.logistics![id].stats.delivered === 15);
    expect(qty(sim.st.stations.astra.storage[buyer], 'ore')).toBe(15); expect(qty(sim.st.ships[ship.id].cargo, 'ore')).toBe(0);
    expect(sim.canDock(sim.st.stations[station.id], buyer)).toBe(false);
  }, 60_000);
});
