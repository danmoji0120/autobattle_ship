import type { Cmd } from '../world/sim';
import type { WorldState, WorldEvent } from '../world/types';
import type { Order, OrderRecord } from '../sim/types';
import type { BattleSetup } from '../sim/world';

export type ClientMsg =
  /** multiplayer: identity comes from the authenticated session, never from this message */
  | { t: 'hello'; name: string; token?: string; /** 2 = the client applies state deltas ('sd'); absent = full snapshots */ proto?: number }
  /** create the account's PMC (once); `legacy` = an old browser token to carry over an unclaimed PMC */
  | { t: 'createPmc'; name: string; legacy?: string; /** A-3.1 background id (the server resolves what it grants) */ background?: string }
  | { t: 'cmd'; id: number; cmd: Cmd }
  | { t: 'bjoin'; eng: string }
  | { t: 'border'; id: number; eng: string; groupId: number; order: Order | null; opts: { retreatAt?: number; release?: boolean; /** P11: pull the sender's whole side out */ withdraw?: boolean } }
  | { t: 'speed'; v: number }
  | { t: 'ping'; at: number }
  | { t: 'view'; sys: string }
  | { t: 'analytics'; id: number; scope: 'player' | 'admin'; query?: import('./analytics').AnalyticsQuery };

/** what clients see of the world (no RNG / auth) */
/** finished battles as listed to clients (setup/orders are fetched on demand with bjoin) */
export type BattleRecordLite = Omit<import('../world/types').BattleRecord, 'setup' | 'orders'>;
export type WorldView = Omit<WorldState, 'events' | 'rng' | 'battleLog'> & { battleLog?: BattleRecordLite[] };

export type ServerMsg =
  | { t: 'welcome'; company: string; token: string; sp: boolean; serverTime: number }
  | { t: 'snap'; at: number; speed: number; state: WorldView }
  /** protocol 2: state changes since the previous message (see server/sync.ts) */
  | import('./sync').SyncMsg
  | { t: 'events'; list: WorldEvent[] }
  | { t: 'ack'; id: number; err: string | null }
  | { t: 'binit'; eng: string; setup: BattleSetup; orders: OrderRecord[]; tick: number; /** finished: play it back as a replay */ replay?: boolean; names?: string[] }
  | { t: 'border'; eng: string; rec: OrderRecord }
  | { t: 'players'; list: { id: string; name: string; online: boolean; color: string }[] }
  | { t: 'pong'; at: number; serverTime: number }
  /** compact ship kinematics: [id, x, y, z, vx, vy, vz, heading, warp(0/1)] per ship */
  | { t: 'mov'; at: number; s: (string | number)[][] }
  | { t: 'stats'; tickMs: number; tickMax: number; rate: number; bytes: number; ships: number; conns: number; battles: number; battleMs?: number }
  | { t: 'error'; msg: string }
  /** the connection has no signed-in account */
  | { t: 'auth'; need: 'login' }
  /** signed in, but the account has no PMC in this world yet */
  | { t: 'needPmc'; /** what the new company will receive in this world (absent from older servers) */ start?: { credits: number; station: string; /** A-3.1: P10 worlds — the founding backgrounds and exactly what each grants */ backgrounds?: import('../world/backgrounds').BackgroundTerm[] } }
  | { t: 'pmcErr'; msg: string }
  | { t: 'analytics'; id: number; data?: import('./analytics').AnalyticsResult; error?: string; admin?: boolean };

export interface SaveFile {
  v: number; world: WorldState;
  /** Server-only, bounded observability history. Never included in WorldView. */
  analytics?: import('./analytics').AnalyticsStore;
  /** legacy (pre-account) browser tokens → company; only usable once, to carry a PMC over to an account */
  auth: Record<string, string>;
  /** account UUID → company id in this world. Saved with the world, so backups and resets stay consistent */
  accounts?: Record<string, string>;
}
