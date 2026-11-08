import { emit, moneySupply, observeWorld, type Observation } from '../world/observe';
import type { WorldSim } from '../world/sim';
import { sysIndexAt } from '../world/geom';
import { cargoSum } from '../world/types';
import { priceOf } from '../world/market';
import { publicCap, storeUsed } from '../world/storage';
import { storageCap, buildNeeds } from '../world/production';
import { effSec } from '../world/security';
import { WEAPONS } from '../sim/data/weapons';
import { TECHS, itemPrice } from '../world/industry';

export interface Metric extends Observation { count: number; value: number }
export interface CompanySample { id: string; name: string; credits: number; assets: number; liabilities: number; rep: number; ships: number; classes: Record<string, number>; stations: number; research: number; age: number; played: number }
export interface MarketSample { id: string; name: string; system: string; funds: number; goods: Record<string, { price: number; buy: number; stock: number; target: number }> }
export interface Frame { time: number; supply: number; companyCredits: number; budgets: number; companies: CompanySample[]; markets: MarketSample[]; systems: { id: string; name: string; security: number; heat: number; influence: Record<string, number>; raids: number }[]; warehouses: { company: string; station: string; used: number; cap: number; mode: 'capacity' | 'construction' | 'unlimited'; pending: number }[]; waits: { company: string; group: string; since: number; reason: string }[] }
export interface Bucket { start: number; end: number; resolution: number; rows: Metric[]; frame?: Frame }
export interface AnalyticsStore {
  version: 1; started: number; openingSupply: number; created: number; destroyed: number;
  fine: Bucket[]; hourly: Bucket[]; daily: Bucket[]; current: Bucket;
  projects: Record<string, { company: string; tech: string; start: number }>;
  journeys: Record<string, { company: string; group?: string; station?: string; start: number }>;
  waits: Record<string, { company: string; group: string; since: number; reason: string }>;
  onlineSeconds?: Record<string, number>;
  pausedAt?: number; gaps?: { start: number; end: number; supplyDelta: number }[]; unobservedSupply?: number;
  dropped: number; failures: number; truncatedBefore?: number; lastSample: number;
}
export interface AlertConfig { assetPerHour: number; repPerHour: number; saturationRatio: number; saturationSeconds: number; tradeShare: number; tradeMinimum: number; waitSeconds: number; researchFraction: number; combatWinRate: number; combatSamples: number; weaponDamageRatio: number; weaponSamples: number }
export const DEFAULT_ALERTS: AlertConfig = { assetPerHour: 1000000, repPerHour: 100, saturationRatio: 4, saturationSeconds: 1800, tradeShare: .8, tradeMinimum: 1000, waitSeconds: 600, researchFraction: .25, combatWinRate: .9, combatSamples: 10, weaponDamageRatio: 2, weaponSamples: 30 };
export interface AnalyticsOptions { enabled?: boolean; snapshotSeconds?: number; maxBytes?: number; maxRows?: number; fineBuckets?: number; hourlyBuckets?: number; dailyBuckets?: number; alerts?: Partial<AlertConfig> }
export interface AnalyticsQuery { hours?: number; company?: string; system?: string; ship?: string; station?: string }
export interface CashSummary { capital: number; income: number; expenses: number; net: number }
export function cashSummary(rows: Metric[]): CashSummary {
  let capital = 0, income = 0, expenses = 0;
  for (const r of rows) { if (r.kind === 'income') { if (r.reason === 'company_creation') capital += r.amount; else income += r.amount; } else if (r.kind === 'expense') expenses += r.amount; }
  return { capital, income, expenses, net: income - expenses };
}
export interface AnalyticsResult { cash: CashSummary; scope: 'admin' | 'player'; started: number; now: number; from: number; interval: number; points: Bucket[]; current: Frame; totals: Metric[]; alerts: { kind: string; text: string; company?: string; system?: string }[]; health: { dropped: number; failures: number; bytes: number; maxBytes: number; reconciliation: number; truncatedBefore?: number; queryOmitted: number; gaps: { start: number; end: number; supplyDelta: number }[] }; thresholds?: AlertConfig }
// Length-prefixed fields are unambiguous even for user supplied IDs, without allocating a JSON array.
const fieldKey = (v: string | number | undefined) => v === undefined ? ';' : `${String(v).length}:${v}`;
const key = (e: Observation) => fieldKey(e.kind) + fieldKey(e.company) + fieldKey(e.group) + fieldKey(e.ship) + fieldKey(e.station) + fieldKey(e.system) + fieldKey(e.item) + fieldKey(e.reason) + fieldKey(e.from) + fieldKey(e.to) + fieldKey(e.ref) + fieldKey(e.method) + fieldKey(e.baseline);
const clamp = (n: number | undefined, def: number, lo: number, hi: number) => Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n!))) : def;

export class Analytics {
  readonly data: AnalyticsStore;
  readonly interval: number; readonly maxBytes: number; readonly maxRows: number;
  readonly alerts: AlertConfig;
  private index = new Map<string, Metric>();
  private scalarRows = new WeakMap<Observation, { bucket: Bucket; row: Metric }>();
  private stationSystems = new Map<string, string>();
  private systemsByIndex = new Map<number, string>();
  private limits: [number, number, number];
  private bytes = 0;
  cpuMs = 0;
  private lastCleanup = -1;
  constructor(private sim: WorldSim, saved?: AnalyticsStore, options: AnalyticsOptions = {}) {
    this.interval = clamp(options.snapshotSeconds, 600, 300, 900);
    this.maxBytes = clamp(options.maxBytes, 8 * 1024 * 1024, 256 * 1024, 32 * 1024 * 1024);
    this.maxRows = clamp(options.maxRows, 2048, 64, 8192);
    this.limits = [clamp(options.fineBuckets, 144, 1, 288), clamp(options.hourlyBuckets, 720, 1, 1440), clamp(options.dailyBuckets, 365, 1, 730)];
    this.alerts = { ...DEFAULT_ALERTS };
    for (const k of Object.keys(DEFAULT_ALERTS) as (keyof AlertConfig)[]) if (Number.isFinite(options.alerts?.[k]) && options.alerts![k]! > 0) this.alerts[k] = options.alerts![k]!;
    for (const system of Object.values(sim.st.systems)) this.systemsByIndex.set(system.idx, system.id);
    for (const st of Object.values(sim.st.stations)) this.stationSystems.set(st.id, sim.sysOf(st.pos)?.id ?? '');
    const now = sim.time;
    this.data = saved?.version === 1 ? saved : { version: 1, started: now, openingSupply: moneySupply(sim.st), created: 0, destroyed: 0, fine: [], hourly: [], daily: [], current: { start: now, end: now, resolution: this.interval, rows: [] }, projects: {}, journeys: {}, waits: {}, dropped: 0, failures: 0, lastSample: now };
    if (this.data.pausedAt !== undefined) {
      const start = this.data.pausedAt;
      const delta = moneySupply(sim.st) - this.data.openingSupply - this.data.created + this.data.destroyed - (this.data.unobservedSupply ?? 0);
      if (now > start || Math.abs(delta) > 1e-9) {
        (this.data.gaps ??= []).push({ start, end: now, supplyDelta: delta });
        this.data.gaps = this.data.gaps.slice(-32);
        this.data.unobservedSupply = (this.data.unobservedSupply ?? 0) + delta;
        this.data.current.end = start; this.data.fine.push(this.data.current);
        this.data.current = { start: now, end: now, resolution: this.interval, rows: [] }; this.data.lastSample = now;
      }
      delete this.data.pausedAt;
    }
    for (const row of this.data.current.rows) this.index.set(key(row), row);
    observeWorld(sim.st, (e, time) => {
      try { this.ingest(e, time); } catch { this.data.failures++; }
    }, ms => { this.cpuMs += ms; }, (identity, amount, time) => {
      try {
        if (!Number.isFinite(amount)) { this.data.failures++; return; }
        const budget = (identity.kind === 'currency.create' || identity.kind === 'currency.destroy') && (identity.to ?? identity.from ?? '').startsWith('st:');
        if (identity.kind !== 'market.net_supply' && identity.kind !== 'market.net_consumption' && !budget) { this.ingest({ ...identity, amount }, time); return; }
        this.roll(time);
        const cached = this.scalarRows.get(identity);
        if (cached?.bucket === this.data.current) { cached.row.amount += amount; cached.row.count++; if (identity.kind === 'currency.create') this.data.created += amount; else if (identity.kind === 'currency.destroy') this.data.destroyed += amount; }
        else {
          this.ingest({ ...identity, amount }, time);
          const system = identity.station ? this.stationSystems.get(identity.station) : identity.system;
          const row = this.index.get(key({ ...identity, system }));
          if (row) this.scalarRows.set(identity, { bucket: this.data.current, row });
        }
      } catch { this.data.failures++; }
    });
    if (!this.data.current.frame) this.data.current.frame = this.sample();
    this.enforceLimit();
  }
  private add(bucket: Bucket, event: Observation, index?: Map<string, Metric>) {
    if (!Number.isFinite(event.amount) || !Number.isFinite(event.value ?? 0)) { this.data.failures++; return; }
    const k = key(event), row = index ? index.get(k) : bucket.rows.find(r => key(r) === k);
    if (row) { row.amount += event.amount; row.count++; row.value += event.value ?? 0; return; }
    if (bucket.rows.length >= this.maxRows) { this.data.dropped++; return; }
    const next: Metric = { ...event, count: 1, value: event.value ?? 0 };
    bucket.rows.push(next); index?.set(k, next);
  }
  private ingest(e: Observation, time: number) {
    this.roll(time);
    const w = this.sim.st;
    if (!e.company && e.kind.startsWith('currency.')) { const account = e.to?.startsWith('co:') ? e.to : e.from?.startsWith('co:') ? e.from : undefined; if (account) e = { ...e, company: account.slice(3) }; }
    if (!e.station && !e.system) { const position = e.ship ? w.ships[e.ship]?.pos : e.company ? w.stations[w.companies[e.company]?.homeStation]?.pos : undefined; if (position) { const idx = sysIndexAt(position); let id = this.systemsByIndex.get(idx); if (!id || w.systems[id]?.idx !== idx) { id = this.sim.sysOf(position)?.id; if (id) this.systemsByIndex.set(idx, id); } e = { ...e, system: id }; } }
    if (!e.system && e.station) { let system = this.stationSystems.get(e.station); if (system === undefined) { system = this.sim.sysOf(w.stations[e.station]?.pos ?? { x: 0, y: 0, z: 0 })?.id ?? ''; this.stationSystems.set(e.station, system); } e = { ...e, system }; }
    if (e.kind === 'currency.create') this.data.created += e.amount;
    if (e.kind === 'currency.destroy') this.data.destroyed += e.amount;
    this.add(this.data.current, e, this.index);
    if (e.kind.startsWith('currency.')) {
      for (const [account, kind] of [[e.from, 'expense'], [e.to, 'income']] as const) if (account?.startsWith('co:')) {
        this.add(this.data.current, { ...e, kind, company: account.slice(3), from: undefined, to: undefined }, this.index);
      }
    }
    const ref = `${e.company}:${e.ref ?? e.ship ?? e.group ?? ''}`;
    if (e.kind === 'research' && e.reason === 'start') this.boundedPut(this.data.projects, ref, { company: e.company!, tech: e.item!, start: time });
    if (e.kind === 'research' && e.reason === 'complete') {
      const p = this.data.projects[ref];
      if (p) this.add(this.data.current, { ...e, kind: 'research.duration', amount: time - p.start, value: 1, reason: 'observed' }, this.index);
      else this.add(this.data.current, { ...e, kind: 'research.duration.unknown', amount: 1 }, this.index);
      delete this.data.projects[ref];
    }
    if (e.kind === 'research' && e.reason === 'cancel') delete this.data.projects[ref];
    if (e.kind === 'logistics' && e.reason === 'depart' && !this.data.journeys[ref]) this.boundedPut(this.data.journeys, ref, { company: e.company!, group: e.group, station: e.station, start: time });
    if (e.kind === 'logistics' && e.reason === 'unload') {
      const trip = this.data.journeys[ref];
      if (trip) { this.add(this.data.current, { ...e, kind: 'logistics.duration', reason: trip.station ? `${trip.station} → ${e.station}` : `광구 → ${e.station}`, amount: time - trip.start, value: 1 }, this.index); delete this.data.journeys[ref]; }
    }
    if (e.kind === 'logistics' && e.reason?.startsWith('blocked:')) { if (!this.data.waits[ref]) this.boundedPut(this.data.waits, ref, { company: e.company!, group: e.group!, since: time, reason: e.reason.slice(8) }); else this.data.waits[ref].reason = e.reason.slice(8); }
    if (e.kind === 'logistics' && e.reason === 'resumed') delete this.data.waits[ref];
  }
  private boundedPut<T>(map: Record<string, T>, id: string, value: T) {
    if (!Object.hasOwn(map, id) && Object.keys(map).length >= 4096) { delete map[Object.keys(map)[0]]; this.data.dropped++; }
    map[id] = value;
  }
  private merge(target: Bucket, source: Bucket, accountDrops = true): number {
    let omitted = 0;
    const index = new Map(target.rows.map(r => [key(r), r]));
    for (const row of source.rows) {
      const old = index.get(key(row));
      if (old) { old.amount += row.amount; old.count += row.count; old.value += row.value; }
      else if (target.rows.length < this.maxRows) { const copy = { ...row }; target.rows.push(copy); index.set(key(copy), copy); }
      else { omitted++; if (accountDrops) this.data.dropped++; }
    }
    target.end = Math.max(target.end, source.end);
    if (source.frame && (!target.frame || source.frame.time >= target.frame.time)) target.frame = source.frame;
    return omitted;
  }
  private fold(source: Bucket[], target: Bucket[], limit: number, resolution: number) {
    while (source.length > limit) {
      const b = source.shift()!, start = Math.floor(b.start / resolution) * resolution;
      let to = target.find(x => x.start === start);
      if (!to) { to = { start, end: b.end, resolution, rows: [] }; target.push(to); }
      this.merge(to, b);
    }
  }
  private roll(time: number) {
    if (time - this.data.current.start < this.interval) { this.data.current.end = time; return; }
    this.data.current.end = time;
    this.data.fine.push(this.data.current);
    this.data.current = { start: time, end: time, resolution: this.interval, rows: [] };
    this.index.clear(); this.scalarRows = new WeakMap();
    this.fold(this.data.fine, this.data.hourly, this.limits[0], 3600);
    this.fold(this.data.hourly, this.data.daily, this.limits[1], 86400);
    while (this.data.daily.length > this.limits[2]) this.data.truncatedBefore = this.data.daily.shift()!.end;
  }
  step(realDt = 0) {
    const at = performance.now();
    if (realDt > 0 && Number.isFinite(realDt)) for (const co of Object.values(this.sim.st.companies)) if (co.kind === 'player' && co.online) { const times = this.data.onlineSeconds ??= {}; if (Object.hasOwn(times, co.id)) times[co.id] += realDt; else this.boundedPut(times, co.id, realDt); }
    this.roll(this.sim.time);
    if (this.sim.time - this.lastCleanup >= 1) {
      this.lastCleanup = this.sim.time;
      for (const [id, wait] of Object.entries(this.data.waits)) { const group = this.sim.st.groups[wait.group]; if (!group || !['mine', 'haul'].includes(this.sim.opOf(group).k)) delete this.data.waits[id]; }
      for (const id of Object.keys(this.data.journeys)) if (!this.sim.st.ships[id.slice(id.indexOf(':') + 1)]) delete this.data.journeys[id];
    }
    if (this.sim.time - this.data.lastSample >= this.interval) {
      this.data.current.frame = this.sample(); this.data.lastSample = this.sim.time;
      this.enforceLimit();
    }
    this.cpuMs += performance.now() - at;
  }
  private enforceLimit() {
    this.bytes = new TextEncoder().encode(JSON.stringify(this.data)).byteLength;
    // Keep current and newest data. Retention loss is explicit in every response.
    while (this.bytes > this.maxBytes) {
      if (this.data.fine.length > 1) { this.fold(this.data.fine, this.data.hourly, this.data.fine.length - 1, 3600); this.fold(this.data.hourly, this.data.daily, this.limits[1], 86400); }
      else if (this.data.hourly.length > 1) this.fold(this.data.hourly, this.data.daily, this.data.hourly.length - 1, 86400);
      else {
      const source = this.data.daily.length ? this.data.daily : this.data.hourly.length ? this.data.hourly : this.data.fine;
      if (!source.length) {
        if (this.data.current.rows.length) { const n = Math.min(this.data.current.rows.length, Math.max(64, Math.ceil(this.data.current.rows.length / 4))); this.data.current.rows.splice(-n); this.scalarRows = new WeakMap(); this.data.dropped += n - 1; this.index = new Map(this.data.current.rows.map(r => [key(r), r])); }
        else if (this.data.current.frame) delete this.data.current.frame;
        else { const map = [this.data.journeys, this.data.projects, this.data.waits, this.data.onlineSeconds ?? {}].find(m => Object.keys(m).length); if (!map) break; delete map[Object.keys(map)[0]]; }
        this.data.dropped++; this.bytes = new TextEncoder().encode(JSON.stringify(this.data)).byteLength; continue;
      }
      this.data.truncatedBefore = source.shift()!.end;
      }
      this.bytes = new TextEncoder().encode(JSON.stringify(this.data)).byteLength;
    }
  }
  snapshot(): AnalyticsStore { this.enforceLimit(); return JSON.parse(JSON.stringify(this.data)); }
  private assessedAssets(company: string): { assets: number; liabilities: number } {
    const w = this.sim.st, co = w.companies[company];
    const value = (cargo: Record<string, number>) => Object.entries(cargo).reduce((n, [k, qty]) => n + qty * itemPrice(k), 0);
    let assets = this.sim.netWorth(company);
    for (const ship of Object.values(w.ships)) if (ship.owner === company) assets += value(ship.cargo);
    for (const station of Object.values(w.stations)) {
      for (const listing of station.listings ?? []) if (listing.seller === company) assets += listing.qty * itemPrice(listing.item);
      if (station.owner !== company) continue;
      for (const plan of station.modules) if (!plan.built) assets += (plan.paid ?? 0) + value(plan.reserved ?? {}) + value(plan.used ?? {});
      for (const build of station.builds ?? []) assets += build.paid + (build.started ? value(buildNeeds(build.classId, build.loadoutId, build.fit, build)) : 0);
    }
    const liabilities = (co.upkeep?.debt ?? 0) + (co.upkeep?.acc ?? 0);
    return { assets: assets - liabilities, liabilities };
  }
  sample(viewer?: string, countDrops = true): Frame {
    const w = this.sim.st;
    const bounded = <T>(items: T[], limit = 512) => { if (countDrops && items.length > limit) this.data.dropped += items.length - limit; return items.slice(0, limit); };
    const companies = bounded(Object.values(w.companies).filter(co => co.kind === 'player' && (!viewer || co.id === viewer))).map(co => {
      const ships = Object.values(w.ships).filter(s => s.owner === co.id), classes: Record<string, number> = {};
      for (const s of ships) classes[s.classId] = (classes[s.classId] ?? 0) + 1;
      return { id: co.id, name: co.name, credits: co.credits, ...this.assessedAssets(co.id), rep: co.rep, ships: ships.length, classes, stations: Object.values(w.stations).filter(s => s.owner === co.id).length, research: co.tech?.length ?? 0, age: w.time - co.createdAt, played: this.data.onlineSeconds?.[co.id] ?? 0 };
    });
    const markets = bounded(Object.values(w.stations).filter(s => s.public && s.market)).map(st => ({ id: st.id, name: st.name, system: this.sim.sysOf(st.pos)?.id ?? '', funds: st.funds ?? 0, goods: Object.fromEntries(Object.entries(st.market!).map(([k, m]) => [k, { price: priceOf(m, 'sell', (w.contentV ?? 0) >= 3) * (1 - (st.tax ?? 0)), buy: priceOf(m, 'buy', (w.contentV ?? 0) >= 3), stock: m.stock, target: m.target }])) }));
    const warehouses = bounded(Object.values(w.stations).flatMap(st => Object.entries(st.storage).filter(([co, c]) => w.companies[co]?.kind === 'player' && (!viewer || co === viewer) && (storeUsed(c) > 0 || st.owner === co || w.companies[co].pendingLoot?.[st.id] || (w.companies[co].leases?.[st.id] ?? 0) > 0)).map(([company, c]) => ({ company, station: st.id, used: storeUsed(c), cap: st.public ? ((w.contentV ?? 0) >= 3 ? publicCap(w.companies[company], st) : 0) : storageCap(st), mode: ((w.contentV ?? 0) >= 3 && !st.public && !st.modules.some(m => m.kind === 'core' && m.built) ? 'construction' : st.public && (w.contentV ?? 0) < 3 || !st.public && storageCap(st) === 0 ? 'unlimited' : 'capacity') as 'capacity' | 'construction' | 'unlimited', pending: cargoSum(w.companies[company].pendingLoot?.[st.id] ?? {}) }))));
    return { time: w.time, supply: moneySupply(w), companyCredits: Object.values(w.companies).reduce((n, co) => n + co.credits, 0), budgets: Object.values(w.stations).reduce((n, st) => n + (st.funds ?? 0), 0), companies, markets, warehouses, waits: bounded(Object.values(this.data.waits)), systems: Object.values(w.systems).map(s => ({ id: s.id, name: s.name, security: effSec(s), heat: s.heat, influence: { ...s.inf }, raids: s.stats.raids })) };
  }
  query(scope: 'admin' | 'player', viewer: string, query: AnalyticsQuery = {}): AnalyticsResult {
    const hours = Math.max(1, Math.min(8760, Number.isFinite(query.hours) ? query.hours! : 6)), from = Math.max(this.data.started, this.sim.time - hours * 3600);
    const filter = (row: Metric) => (scope === 'admin' || row.company === viewer && !row.kind.startsWith('currency.')) && (!query.company || row.company === query.company || row.kind.startsWith('currency.') && (row.from === `co:${query.company}` || row.to === `co:${query.company}`)) && (!query.system || row.system === query.system) && (!query.ship || row.ship === query.ship) && (!query.station || row.station === query.station);
    const redact = (frame: Frame): Frame => ({ ...frame, supply: scope === 'admin' ? frame.supply : 0, companyCredits: scope === 'admin' ? frame.companyCredits : 0, budgets: scope === 'admin' ? frame.budgets : 0, companies: frame.companies.filter(c => (scope === 'admin' || c.id === viewer) && (!query.company || c.id === query.company)), markets: frame.markets.filter(m => (!query.system || m.system === query.system) && (!query.station || m.id === query.station)), warehouses: frame.warehouses.filter(x => (scope === 'admin' || x.company === viewer) && (!query.company || x.company === query.company) && (!query.station || x.station === query.station)), waits: frame.waits.filter(x => (scope === 'admin' || x.company === viewer) && (!query.company || x.company === query.company)), systems: frame.systems.filter(s => !query.system || s.id === query.system) });
    const all = [...this.data.daily, ...this.data.hourly, ...this.data.fine, this.data.current].filter(b => b.end >= from).sort((a, b) => a.start - b.start);
    const resolution = Math.max(this.interval, Math.ceil(hours * 3600 / 120 / this.interval) * this.interval);
    const bins = new Map<number, Bucket>();
    let queryOmitted = 0;
    for (const b of all) {
      // An aggregate crossing the requested boundary is returned as a whole and labelled by its span.
      const start = Math.floor(b.start / resolution) * resolution;
      let bin = bins.get(start); if (!bin) { bin = { start: b.start, end: b.end, resolution: Math.max(resolution, b.resolution), rows: [] }; bins.set(start, bin); }
      queryOmitted += this.merge(bin, { ...b, rows: b.rows.filter(filter).map(r => scope === 'player' && r.kind === 'market.seller' ? { ...r, kind: 'market' } : r), frame: b.frame ? redact(b.frame) : undefined }, false);
    }
    const totals: Bucket = { start: from, end: this.sim.time, resolution, rows: [] };
    for (const b of bins.values()) queryOmitted += this.merge(totals, b, false);
    const current = redact(this.sample(scope === 'player' ? viewer : undefined, false));
    const alerts = this.detect([...bins.values()], current, totals.rows).filter(a => scope === 'admin' || a.company === viewer);
    return { cash: cashSummary(totals.rows), scope, started: this.data.started, now: this.sim.time, from: Math.min(from, ...[...bins.values()].map(b => b.start)), interval: this.interval, points: [...bins.values()], current, totals: totals.rows, alerts, health: { dropped: this.data.dropped, failures: this.data.failures, bytes: this.bytes, maxBytes: this.maxBytes, reconciliation: scope === 'admin' ? moneySupply(this.sim.st) - this.data.openingSupply - this.data.created + this.data.destroyed - (this.data.unobservedSupply ?? 0) : 0, truncatedBefore: this.data.truncatedBefore, queryOmitted, gaps: (this.data.gaps ?? []).map(g => scope === 'admin' ? { ...g } : { ...g, supplyDelta: 0 }) }, ...(scope === 'admin' ? { thresholds: this.alerts } : {}) };
  }
  private detect(points: Bucket[], frame: Frame, rows: Metric[]) {
    const out: { kind: string; text: string; company?: string; system?: string }[] = [], cfg = this.alerts;
    const first = points.find(p => p.frame)?.frame;
    if (first && frame.time > first.time) for (const co of frame.companies) {
      const prev = first.companies.find(c => c.id === co.id); if (!prev) continue;
      const hours = (frame.time - first.time) / 3600, assets = (co.assets - prev.assets) / hours, rep = (co.rep - prev.rep) / hours;
      if (assets > cfg.assetPerHour) out.push({ kind: 'growth', company: co.id, text: `${co.name}: 자산 +${Math.round(assets).toLocaleString()} cr/h > ${cfg.assetPerHour.toLocaleString()}` });
      if (rep > cfg.repPerHour) out.push({ kind: 'reputation', company: co.id, text: `${co.name}: 평판 +${rep.toFixed(1)}/h > ${cfg.repPerHour}` });
    }
    for (const wait of frame.waits) if (frame.time - wait.since >= cfg.waitSeconds) out.push({ kind: 'logistics', company: wait.company, text: `${wait.group}: ${Math.round(frame.time - wait.since)}초 대기 ≥ ${cfg.waitSeconds}초 · ${wait.reason}` });
    for (const market of frame.markets) for (const [id, m] of Object.entries(market.goods)) {
      if (m.stock < m.target * cfg.saturationRatio) continue;
      const samples = points.map(p => p.frame).filter((f): f is Frame => !!f).sort((a, b) => a.time - b.time);
      let since = frame.time;
      for (let i = samples.length - 1; i >= 0; i--) { const g = samples[i].markets.find(x => x.id === market.id)?.goods[id]; if (!g || g.stock < g.target * cfg.saturationRatio) break; since = samples[i].time; }
      if (frame.time - since >= cfg.saturationSeconds) out.push({ kind: 'saturation', system: market.system, text: `${market.name} ${id}: 재고/목표 ${(m.stock / m.target).toFixed(1)}배 ≥ ${cfg.saturationRatio}배, 관측 시점 기준 ${Math.round(frame.time - since)}초 ≥ ${cfg.saturationSeconds}초` });
    }
    const trades = rows.filter(r => r.kind === 'market'), total = trades.reduce((n, r) => n + r.value, 0);
    for (const s of frame.systems) { const value = trades.filter(r => r.system === s.id).reduce((n, r) => n + r.value, 0); if (total >= cfg.tradeMinimum && value / total > cfg.tradeShare) out.push({ kind: 'concentration', system: s.id, text: `${s.name}: 거래액 ${Math.round(value).toLocaleString()}/${Math.round(total).toLocaleString()} cr (${(value / total * 100).toFixed(1)}%) > ${cfg.tradeShare * 100}%` }); }
    for (const r of rows.filter(r => r.kind === 'research.duration')) { const expected = r.baseline ?? TECHS[r.item ?? '']?.time; if (expected && r.value > 0 && r.amount / r.value < expected * cfg.researchFraction) out.push({ kind: 'research', company: r.company, text: `${r.item}: 실제 평균 ${(r.amount / r.value).toFixed(1)}초 / 기본 ${expected}초 < ${cfg.researchFraction * 100}%` }); }
    const combat = new Map<string, { company?: string; item?: string; n: number; wins: number }>();
    for (const r of rows.filter(r => r.kind === 'combat.participation' || r.kind === 'combat.win')) {
      const key = `${r.company}:${r.item}`, group = combat.get(key) ?? { company: r.company, item: r.item, n: 0, wins: 0 };
      if (r.kind === 'combat.win') group.wins += r.amount; else group.n += r.amount; combat.set(key, group);
    }
    for (const r of combat.values()) if (r.n >= cfg.combatSamples && r.wins / r.n > cfg.combatWinRate) out.push({ kind: 'combat', company: r.company, text: `${r.item}: 승리 ${r.wins}/${r.n}척·교전 (${(r.wins / r.n * 100).toFixed(1)}%) > ${cfg.combatWinRate * 100}%, 편성·대전 상대 영향 포함` });
    const weapons = new Map<string, { company?: string; item?: string; damage: number; hits: number }>();
    for (const r of rows.filter(r => r.kind === 'combat.weapon')) { const key = `${r.company}:${r.item}`, group = weapons.get(key) ?? { company: r.company, item: r.item, damage: 0, hits: 0 }; group.damage += r.amount; group.hits += r.value; weapons.set(key, group); }
    for (const r of weapons.values()) { const base = WEAPONS[r.item ?? '']?.damage; if (base && r.hits >= cfg.weaponSamples && r.damage / r.hits > base * cfg.weaponDamageRatio) out.push({ kind: 'weapon', company: r.company, text: `${r.item}: 피격당 선체 피해 ${(r.damage / r.hits).toFixed(1)} / 기본 ${base}, ${r.hits}회 ≥ ${cfg.weaponSamples}회 · 기준 ${cfg.weaponDamageRatio}배` }); }
    return out.slice(0, 200);
  }
}
