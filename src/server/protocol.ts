import type { Cmd } from '../world/sim';
import type { WorldState, WorldEvent } from '../world/types';
import type { Order, OrderRecord } from '../sim/types';
import type { BattleSetup } from '../sim/world';

export type ClientMsg =
  | { t: 'hello'; name: string; token?: string }
  | { t: 'cmd'; id: number; cmd: Cmd }
  | { t: 'bjoin'; eng: string }
  | { t: 'border'; id: number; eng: string; groupId: number; order: Order | null; opts: { retreatAt?: number; release?: boolean } }
  | { t: 'speed'; v: number }
  | { t: 'ping'; at: number }
  | { t: 'view'; sys: string };

/** what clients see of the world (no RNG / auth) */
/** finished battles as listed to clients (setup/orders are fetched on demand with bjoin) */
export type BattleRecordLite = Omit<import('../world/types').BattleRecord, 'setup' | 'orders'>;
export type WorldView = Omit<WorldState, 'events' | 'rng' | 'battleLog'> & { battleLog?: BattleRecordLite[] };

export type ServerMsg =
  | { t: 'welcome'; company: string; token: string; sp: boolean; serverTime: number }
  | { t: 'snap'; at: number; speed: number; state: WorldView }
  | { t: 'events'; list: WorldEvent[] }
  | { t: 'ack'; id: number; err: string | null }
  | { t: 'binit'; eng: string; setup: BattleSetup; orders: OrderRecord[]; tick: number; /** finished: play it back as a replay */ replay?: boolean; names?: [string, string] }
  | { t: 'border'; eng: string; rec: OrderRecord }
  | { t: 'players'; list: { id: string; name: string; online: boolean; color: string }[] }
  | { t: 'pong'; at: number; serverTime: number }
  /** compact ship kinematics: [id, x, y, z, vx, vy, vz, heading, warp(0/1)] per ship */
  | { t: 'mov'; at: number; s: (string | number)[][] }
  | { t: 'stats'; tickMs: number; tickMax: number; rate: number; bytes: number; ships: number; conns: number; battles: number; battleMs?: number }
  | { t: 'error'; msg: string };

export interface SaveFile { v: number; world: WorldState; auth: Record<string, string> }
