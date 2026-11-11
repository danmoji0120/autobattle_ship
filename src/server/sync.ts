// World-state replication for clients (protocol 2).
//
// The legacy protocol rebuilt and serialized the whole visible world once per client every second
// (`legacyView`). Protocol 2 produces exactly the same client-side state, but:
//   • every entity is serialized once per broadcast frame for each visibility variant (public / owner /
//     per-company), and unchanged entities keep the same interned string from the previous frame;
//   • each client only receives entities whose serialized form differs from what it already holds
//     (plus deletions, collection presence changes and, when needed, the server's key order);
//   • ship kinematics (pos, vel, heading) travel in a compact array, so a moving ship whose other fields
//     are unchanged costs ~100 bytes instead of its full record.
// The reconstructed state (see applySync) is equal to legacyView for the same client and moment; this is
// enforced by tests/sync.test.ts. Visibility rules are unchanged: they live in one place (VIEW below)
// and legacyView keeps the original implementation as the reference.

import type { WorldState, WShip, Station, Site } from '../world/types';
import type { WorldView } from './protocol';

export const SYNC_PROTO = 2;

/** who a view is built for */
export interface Viewer { company?: string; view?: string }

/** keyed collections replicated entity by entity (others are replicated as whole values) */
const COLLECTIONS = ['companies', 'groups', 'commanders', 'stations', 'fields', 'lairs', 'systems', 'logistics', 'logisticsJobs', 'procurementPlans', 'contracts', 'engagements', 'sites', 'uniques', 'ships'] as const;
type Col = typeof COLLECTIONS[number];
const IS_COL = new Set<string>(COLLECTIONS);
/** never replicated: server-only state */
const HIDDEN = new Set(['events', 'rng', 'grants', 'conversions', 'exclusive']);
const OWNED = new Set<string>(['logistics', 'logisticsJobs', 'procurementPlans']);

// ───────────────────────────────────────────────────────────── visibility rules (shared by both paths)

const ZERO_STATS = () => ({ earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 });
function publicCompany(id: string, co: any) {
  return { id, name: co.name, kind: co.kind, color: co.color, online: co.online, createdAt: co.createdAt, homeStation: co.homeStation, credits: 0, rep: 0, stats: ZERO_STATS(), milestones: [] };
}
/** station without its storage map (storage is per viewer and is added separately) */
function stationBody(st: Station, own: boolean) {
  return { ...st, storage: undefined, ...(own ? {} : { builds: undefined, orders: undefined, jobs: undefined, modules: st.modules.map(m => ({ kind: m.kind, progress: m.progress, built: m.built, slot: m.slot })) }) };
}
function publicGroup(g: any) { return { ...g, op: { k: 'idle' as const }, status: '운항 중', commanderId: null, march: undefined }; }
function publicShip(s: WShip) { return { ...s, cargo: {}, cargoWork: undefined, logisticsPool: undefined, logisticsJob: undefined, fitting: undefined, fit: undefined }; }
function siteFor(s: Site, company: string) { return { ...s, scan: s.scan[company] !== undefined ? { [company]: s.scan[company] } : {}, seen: [company] }; }
const fullGroup = (st: WorldState, g: any, company?: string) => g.owner === company || st.companies[g.owner]?.kind !== 'player';
const fullCompany = (id: string, co: any, company?: string) => id === company || co.kind !== 'player';

/** the system a viewer is looking at (defaults to where its company is based) */
export function viewSystem(st: WorldState, v: Viewer, sysOf: (p: { x: number; y: number; z: number }) => { id: string } | undefined): string {
  if (v.view) return v.view;
  const co = v.company ? st.companies[v.company] : null;
  const home = co ? st.stations[co.homeStation] : null;
  return (home && sysOf(home.pos)?.id) || 'astra';
}
/** interest management: your own ships anywhere + everything in the system you are viewing */
export function shipVisible(s: WShip, company: string | undefined, origin: { x: number } | undefined): boolean {
  return s.owner === company || (!!origin && Math.round((s.pos.x - origin.x) / 250000) === 0);
}

/** The original per-client view (protocol 1). Kept as the reference implementation and for old clients. */
export function legacyView(st: WorldState, v: Viewer, sysId: string): WorldView {
  const { events: _e, rng: _r, ships: _s, engagements, battleLog, ...base } = st;
  void _e; void _r; void _s;
  const eng: Record<string, any> = {};
  for (const [id, e] of Object.entries(engagements)) { const { setup: _x, orders: _o, ...lite } = e; void _x; void _o; eng[id] = lite; }
  const log = (battleLog ?? []).map(({ setup: _x, orders: _o, ...lite }) => { void _x; void _o; return lite; });
  const c = v.company;
  const companies = Object.fromEntries(Object.entries(base.companies).map(([id, co]) => [id, fullCompany(id, co, c) ? co : publicCompany(id, co)]));
  const stations = Object.fromEntries(Object.entries(base.stations).map(([id, s]) => [id, { ...s, storage: { ...(c && s.storage[c] ? { [c]: s.storage[c] } : {}) }, ...(s.owner === c ? {} : { builds: undefined, orders: undefined, jobs: undefined, modules: s.modules.map(m => ({ kind: m.kind, progress: m.progress, built: m.built, slot: m.slot })) }) }]));
  const groups = Object.fromEntries(Object.entries(base.groups).map(([id, g]) => [id, fullGroup(st, g, c) ? g : publicGroup(g)]));
  const origin = st.systems[sysId]?.origin;
  const ships = Object.fromEntries(Object.values(st.ships).filter(s => shipVisible(s, c, origin)).map(s => [s.id, s.owner === c ? s : publicShip(s)]));
  const own = <T extends { owner: string }>(m: Record<string, T> | undefined) => m ? Object.fromEntries(Object.entries(m).filter(([, r]) => r.owner === c)) : undefined;
  return {
    ...base, engagements: eng, battleLog: log, companies, stations, ships, groups,
    logistics: own(base.logistics), logisticsJobs: own(base.logisticsJobs), procurementPlans: own(base.procurementPlans),
    grants: undefined, conversions: undefined, exclusive: undefined,
    sites: base.sites ? Object.fromEntries(Object.entries(base.sites).filter(([, s]) => !!c && s.seen.includes(c)).map(([id, s]) => [id, siteFor(s, c!)])) : undefined,
  } as WorldView;
}

// ───────────────────────────────────────────────────────────── protocol 2: frames and per-client deltas

/** what a client holds of one entity: its body JSON (+ the bucket it came from) and an optional second part */
interface Parts { readonly a: string; readonly ab: string; readonly b?: string }
type Intern = Map<string, string>;

// ── field patches: an entity whose JSON changed is sent as the fields that changed (two levels deep)
interface Fields { keys: string[]; vals: Map<string, string>; subs: Map<string, Fields> }
function fieldsOf(obj: any, depth: number): Fields {
  const keys: string[] = [], vals = new Map<string, string>(), subs = new Map<string, Fields>();
  for (const k in obj) {
    const v = obj[k], j = JSON.stringify(v);
    if (j === undefined) continue; // undefined / functions are not part of the JSON
    keys.push(k); vals.set(k, j);
    if (depth > 1 && v && typeof v === 'object' && !Array.isArray(v)) subs.set(k, fieldsOf(v, depth - 1));
  }
  return { keys, vals, subs };
}
/** key order a client gets by applying sets/deletes to `a`: survivors keep their place, new keys are appended */
function sameOrder(a: Fields, b: Fields): boolean {
  let i = 0;
  for (const k of a.keys) if (b.vals.has(k) && b.keys[i++] !== k) return false;
  for (const k of b.keys) if (!a.vals.has(k) && b.keys[i++] !== k) return false;
  return true;
}
/**
 * Patch turning JSON `from` into `to` as `[{field:value}, {field:{sub:value}}?, [[field] | [field, sub]]?]`,
 * or null when the whole entity is as small or the key order could not be reproduced by the client.
 */
export function makePatch(from: string, to: string, cache?: { from?: Fields; to?: Fields }): string | null {
  if (from[0] !== '{' || to[0] !== '{') return null;
  const a = cache?.from ?? fieldsOf(JSON.parse(from), 2), b = fieldsOf(JSON.parse(to), 2);
  if (cache) cache.to = b;
  if (!sameOrder(a, b)) return null;
  const top: string[] = [], nested: string[] = [], dels: string[] = [];
  for (const k of a.keys) if (!b.vals.has(k)) dels.push('[' + key(k) + ']');
  for (const k of b.keys) {
    const va = a.vals.get(k), vb = b.vals.get(k)!;
    if (va === vb) continue;
    const sa = a.subs.get(k), sb = b.subs.get(k);
    if (va !== undefined && sa && sb && sameOrder(sa, sb)) {
      const sets: string[] = [];
      for (const s of sa.keys) if (!sb.vals.has(s)) dels.push('[' + key(k) + ',' + key(s) + ']');
      for (const s of sb.keys) { const x = sb.vals.get(s)!; if (sa.vals.get(s) !== x) sets.push(key(s) + ':' + x); }
      if (sets.length) nested.push(key(k) + ':{' + sets.join(',') + '}');
    } else top.push(key(k) + ':' + vb);
  }
  let p = '[{' + top.join(',') + '}';
  if (nested.length || dels.length) p += ',{' + nested.join(',') + '}';
  if (dels.length) p += ',[' + dels.join(',') + ']';
  p += ']';
  return p.length < to.length ? p : null;
}
/** client side of makePatch (copy on write; untouched fields keep their identity) */
export function applyPatch(e: any, p: [Record<string, unknown>, Record<string, Record<string, unknown>>?, string[][]?]): any {
  const out = { ...e };
  Object.assign(out, p[0]);
  if (p[1]) for (const k in p[1]) out[k] = Object.assign({ ...out[k] }, p[1][k]);
  if (p[2]) for (const d of p[2]) {
    if (d.length === 1) delete out[d[0]];
    else { if (out[d[0]] === e[d[0]]) out[d[0]] = { ...out[d[0]] }; delete out[d[0]][d[1]]; }
  }
  return out;
}

interface PatchEntry { from: string; to: string; p: string | null; toFields?: Fields }

/** One broadcast moment: lazily serialized, interned entity strings shared by every client. */
export class SyncFrame {
  readonly scalars = new Map<string, string>();
  /** per collection: is it present in the world (undefined collections stay undefined for clients) */
  readonly present = new Set<Col>();
  readonly cur = new Map<string, Intern>();
  private patches = new Map<string, PatchEntry>();
  stringified = 0;
  patched = 0;
  constructor(readonly st: WorldState, private prev: Map<string, Intern>, private prevPatches: Map<string, PatchEntry>, readonly at: number, readonly speed: number) {
    for (const k of Object.keys(st)) {
      if (HIDDEN.has(k) || IS_COL.has(k)) continue;
      const v = (st as any)[k];
      if (v === undefined && k !== 'battleLog') continue;
      const json = k === 'battleLog' ? JSON.stringify(((v ?? []) as any[]).map(({ setup: _x, orders: _o, ...lite }) => lite)) : JSON.stringify(v);
      if (json !== undefined) this.scalars.set(k, json);
    }
    // the legacy view always carries a battle log (empty when the world has none yet)
    if (!this.scalars.has('battleLog')) this.scalars.set('battleLog', '[]');
    for (const col of COLLECTIONS) if ((st as any)[col] !== undefined) this.present.add(col);
  }
  /** interned JSON of `make()` under (bucket, id): reused from the previous frame when equal */
  str(bucket: string, id: string, make: () => unknown): string {
    let m = this.cur.get(bucket);
    if (!m) this.cur.set(bucket, m = new Map());
    const have = m.get(id);
    if (have !== undefined) return have;
    this.stringified++;
    const s = JSON.stringify(make()) ?? 'null';
    const old = this.prev.get(bucket)?.get(id);
    const v = old === s ? old : s;
    m.set(id, v);
    return v;
  }
  /** field patch from what a client holds to the current JSON (shared by every client holding the same version) */
  patch(bucket: string, id: string, from: string, to: string): string | null {
    const k = bucket + '\u0000' + id;
    const hit = this.patches.get(k) ?? this.prevPatches.get(k);
    if (hit && hit.from === from && hit.to === to) { this.patches.set(k, hit); return hit.p; }
    this.patched++;
    // the previous patch of this entity ended where this one starts: its parsed fields are reused
    const cache: { from?: Fields; to?: Fields } = { from: hit && hit.to === from ? hit.toFields : undefined };
    const r: PatchEntry = { from, to, p: makePatch(from, to, cache), toFields: cache.to };
    this.patches.set(k, r);
    return r.p;
  }
  retirePatches() { return this.patches; }
}

/** what one client currently holds */
export class ClientSync {
  scalars = new Map<string, string>();
  present = new Set<Col>();
  sent = new Map<Col, Map<string, Parts>>();
  /** the next message must rebuild the whole state (first message, or after a resync) */
  full = true;
  reset() { this.scalars.clear(); this.present.clear(); this.sent.clear(); this.full = true; }
}

const KIN_OK = (s: WShip) => typeof s.heading === 'number' && s.pos && s.vel && typeof s.pos.x === 'number' && typeof s.vel.x === 'number';

function entities(f: SyncFrame, col: Col, v: Viewer, origin: { x: number } | undefined, out: Map<string, Parts>) {
  const st = f.st, c = v.company, map = (st as any)[col] as Record<string, any>;
  const one = (id: string, ab: string, make: () => unknown) => out.set(id, { a: f.str(ab, id, make), ab });
  switch (col) {
    case 'companies':
      for (const id in map) { const co = map[id], full = fullCompany(id, co, c); one(id, full ? 'co' : 'co.p', () => full ? co : publicCompany(id, co)); }
      return;
    case 'stations':
      for (const id in map) {
        const s = map[id] as Station, own = s.owner === c, ab = own ? 'st.o' : 'st.p';
        const a = f.str(ab, id, () => stationBody(s, own));
        const b = c && s.storage[c] ? f.str('st.s:' + c, id, () => s.storage[c]) : '';
        out.set(id, b ? { a, ab, b } : { a, ab });
      }
      return;
    case 'groups':
      for (const id in map) { const g = map[id], full = fullGroup(st, g, c); one(id, full ? 'g' : 'g.p', () => full ? g : publicGroup(g)); }
      return;
    case 'ships':
      for (const id in map) {
        const s = map[id] as WShip;
        if (!shipVisible(s, c, origin)) continue;
        const own = s.owner === c;
        if (KIN_OK(s)) {
          const ab = own ? 'sh.o' : 'sh.p';
          out.set(s.id, { a: f.str(ab, s.id, () => ({ ...(own ? s : publicShip(s)), pos: undefined, vel: undefined, heading: undefined })), ab, b: f.str('sh.k', s.id, () => [s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.y, s.vel.z, s.heading]) });
        } else one(s.id, own ? 'sh.of' : 'sh.pf', () => own ? s : publicShip(s));
      }
      return;
    case 'engagements':
      for (const id in map) one(id, 'en', () => { const { setup: _x, orders: _o, ...lite } = map[id]; return lite; });
      return;
    case 'sites':
      if (!c) return;
      for (const id in map) { const s = map[id] as Site; if (s.seen.includes(c)) one(id, 'si:' + c, () => siteFor(s, c)); }
      return;
    default:
      if (OWNED.has(col)) { for (const id in map) if (map[id].owner === c) one(id, col, () => map[id]); return; }
      for (const id in map) one(id, col, () => map[id]);
  }
}

const same = (x: Parts | undefined, y: Parts) => !!x && x.a === y.a && x.b === y.b;
const key = (s: string) => JSON.stringify(s);

/**
 * Message (JSON text) bringing `cs` up to date with frame `f` for viewer `v`, or null when nothing changed.
 *   { t:'sd', at, speed, full?, s:{scalar:value}, x:[removed keys], c:[collections now present],
 *     u:{col:{id:entity}}, p:{col:{id:patch}}, k:{id:[px,py,pz,vx,vy,vz,heading]}, d:{col:[ids]}, o:{col:[ids in server order]} }
 * Entities in `u` replace the client's copy, `p` patches it (see makePatch), `k` sets a ship's kinematics.
 */
export function syncMessage(f: SyncFrame, cs: ClientSync, v: Viewer, sysId: string, force = false): string | null {
  const full = cs.full;
  if (full) { cs.scalars.clear(); cs.present.clear(); cs.sent.clear(); }
  const s: string[] = [], x: string[] = [], c: string[] = [], u: string[] = [], p: string[] = [], k: string[] = [], d: string[] = [], o: string[] = [];
  for (const [name, json] of f.scalars) if (cs.scalars.get(name) !== json) { s.push(key(name) + ':' + json); cs.scalars.set(name, json); }
  for (const name of [...cs.scalars.keys()]) if (!f.scalars.has(name)) { x.push(key(name)); cs.scalars.delete(name); }
  const origin = f.st.systems[sysId]?.origin;
  for (const col of COLLECTIONS) {
    if (!f.present.has(col)) {
      if (cs.present.delete(col)) { x.push(key(col)); cs.sent.delete(col); }
      continue;
    }
    if (!cs.present.has(col)) { cs.present.add(col); c.push(key(col)); }
    const prev = cs.sent.get(col) ?? new Map<string, Parts>();
    const next = new Map<string, Parts>();
    entities(f, col, v, origin, next);
    const ups: string[] = [], pats: string[] = [], dels: string[] = [];
    let added = false;
    for (const [id, parts] of next) {
      const old = prev.get(id);
      if (same(old, parts)) continue;
      if (!old) added = true;
      const isShipK = col === 'ships' && parts.ab.startsWith('sh.') && parts.b !== undefined;
      if (isShipK) {
        // kinematics whenever anything changed (the client may have moved it); the body only when it changed
        k.push(key(id) + ':' + parts.b);
        if (old && old.b !== undefined && old.a === parts.a) continue;
      }
      // a patch applies to what the client holds when it came from the same bucket (same visibility)
      let pat: string | null = null;
      if (old && old.ab === parts.ab && old.a !== parts.a && (col !== 'ships' || (old.b !== undefined) === (parts.b !== undefined))) pat = f.patch(parts.ab, id, old.a, parts.a);
      if (col === 'stations') {
        const store = parts.b !== undefined ? `{${key(v.company!)}:${parts.b}}` : '{}';
        if (old && old.ab === parts.ab && (pat !== null || old.a === parts.a)) {
          // body patch (or none) + the viewer's storage when that changed
          const storeSet = old.b !== parts.b ? `"storage":${store}` : '';
          const p0 = pat ?? '[{}]';
          const merged = storeSet ? '[{' + storeSet + (p0.startsWith('[{}') ? '}' + p0.slice(3) : ',' + p0.slice(2)) : p0;
          pats.push(key(id) + ':' + merged);
        } else ups.push(key(id) + ':' + `{"storage":${store}${parts.a === '{}' ? '}' : ',' + parts.a.slice(1)}`);
      } else if (pat !== null) pats.push(key(id) + ':' + pat);
      else ups.push(key(id) + ':' + parts.a);
    }
    for (const id of prev.keys()) if (!next.has(id)) dels.push(key(id));
    if (added && prev.size) {
      // the client appends new keys; tell it the server's order when that differs
      const expect: string[] = [];
      for (const id of prev.keys()) if (next.has(id)) expect.push(id);
      for (const id of next.keys()) if (!prev.has(id)) expect.push(id);
      let i = 0, differs = false;
      for (const id of next.keys()) if (expect[i++] !== id) { differs = true; break; }
      if (differs) o.push(key(col) + ':[' + [...next.keys()].map(key).join(',') + ']');
    }
    if (ups.length) u.push(key(col) + ':{' + ups.join(',') + '}');
    if (pats.length) p.push(key(col) + ':{' + pats.join(',') + '}');
    if (dels.length) d.push(key(col) + ':[' + dels.join(',') + ']');
    cs.sent.set(col, next);
  }
  cs.full = false;
  if (!full && !force && !s.length && !x.length && !c.length && !u.length && !p.length && !k.length && !d.length) return null;
  let m = `{"t":"sd","at":${JSON.stringify(f.at)},"speed":${JSON.stringify(f.speed)}`;
  if (full) m += ',"full":1';
  if (s.length) m += ',"s":{' + s.join(',') + '}';
  if (x.length) m += ',"x":[' + x.join(',') + ']';
  if (c.length) m += ',"c":[' + c.join(',') + ']';
  if (u.length) m += ',"u":{' + u.join(',') + '}';
  if (p.length) m += ',"p":{' + p.join(',') + '}';
  if (k.length) m += ',"k":{' + k.join(',') + '}';
  if (d.length) m += ',"d":{' + d.join(',') + '}';
  if (o.length) m += ',"o":{' + o.join(',') + '}';
  return m + '}';
}

export interface SyncMsg {
  t: 'sd'; at: number; speed: number; full?: 1; s?: Record<string, unknown>; x?: string[]; c?: string[];
  u?: Record<string, Record<string, any>>; p?: Record<string, Record<string, any>>; k?: Record<string, number[]>; d?: Record<string, string[]>; o?: Record<string, string[]>;
}

/** Client side: the next state after a protocol-2 message. Unchanged collections and entities keep their identity. */
export function applySync(prev: WorldView | null, m: SyncMsg): WorldView {
  const next: any = m.full || !prev ? {} : { ...prev };
  if (m.s) for (const name in m.s) next[name] = m.s[name];
  if (m.x) for (const name of m.x) delete next[name];
  if (m.c) for (const col of m.c) if (m.full || !next[col]) next[col] = {};
  const touched = new Set<string>();
  const cow = (col: string) => { if (!touched.has(col)) { touched.add(col); next[col] = { ...(next[col] ?? {}) }; } return next[col] as Record<string, any>; };
  if (m.u) for (const col in m.u) { const map = cow(col), ups = m.u[col]; for (const id in ups) map[id] = ups[id]; }
  if (m.p) for (const col in m.p) { const map = cow(col), ps = m.p[col]; for (const id in ps) map[id] = applyPatch(map[id], ps[id]); }
  if (m.k) {
    const ships = cow('ships');
    for (const id in m.k) {
      const r = m.k[id], body = ships[id];
      ships[id] = { ...body, pos: { x: r[0], y: r[1], z: r[2] }, vel: { x: r[3], y: r[4], z: r[5] }, heading: r[6] };
    }
  }
  if (m.d) for (const col in m.d) { const map = cow(col); for (const id of m.d[col]) delete map[id]; }
  if (m.o) for (const col in m.o) { const map = next[col] as Record<string, any>, ordered: Record<string, any> = {}; for (const id of m.o[col]) ordered[id] = map[id]; next[col] = ordered; }
  return next as WorldView;
}

/** Keeps interned strings (and field patches) between frames. One per server. */
export class SyncHub {
  private interned = new Map<string, Intern>();
  private lastUse = new Map<string, number>();
  private patches = new Map<string, PatchEntry>();
  private n = 0;
  frame(st: WorldState, at: number, speed: number): SyncFrame {
    return new SyncFrame(st, this.interned, this.patches, at, speed);
  }
  /** call once every client of the frame has been served */
  done(f: SyncFrame) {
    this.n++;
    // buckets this frame did not touch (e.g. a per-company view nobody needed now) keep their strings for a while
    for (const [b, m] of f.cur) { this.interned.set(b, m); this.lastUse.set(b, this.n); }
    for (const [b, t] of this.lastUse) if (this.n - t > 120) { this.lastUse.delete(b); this.interned.delete(b); }
    this.patches = f.retirePatches();
  }
}
