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
  | { t: 'ping'; at: number };

/** what clients see of the world (no RNG / auth) */
export type WorldView = Omit<WorldState, 'events' | 'rng'>;

export type ServerMsg =
  | { t: 'welcome'; company: string; token: string; sp: boolean; serverTime: number }
  | { t: 'snap'; at: number; speed: number; state: WorldView }
  | { t: 'events'; list: WorldEvent[] }
  | { t: 'ack'; id: number; err: string | null }
  | { t: 'binit'; eng: string; setup: BattleSetup; orders: OrderRecord[]; tick: number }
  | { t: 'border'; eng: string; rec: OrderRecord }
  | { t: 'players'; list: { id: string; name: string; online: boolean; color: string }[] }
  | { t: 'pong'; at: number; serverTime: number }
  | { t: 'error'; msg: string };

export interface SaveFile { v: number; world: WorldState; auth: Record<string, string> }
