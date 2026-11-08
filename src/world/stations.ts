// A missing size identifies a pre-P9.6 station and keeps its old rules.
import type { Size } from '../content/schema';
import type { Module, Station, WorldState } from './types';
import { FACILITIES } from './industry';

export interface StationSizeDef {
  name: string; credits: number; mats: Record<string, number>; work: number;
  power: number; storage: number; capacity: number; berth: Size; berths: number;
  industrialTier: number; upkeep: number; cargoRate: number;
}

// S retains the existing foundation price and material requirement. The other tiers trade capital
// and recurring costs for industrial footprint, logistics throughput and larger fleets.
export const STATION_SIZES: Record<Size, StationSizeDef> = {
  S:  { name: '소형', credits: 8_000, mats: { alloy: 300 }, work: 60, power: 20, storage: 4_000, capacity: 8, berth: 'M', berths: 4, industrialTier: 1, upkeep: 100, cargoRate: 12 },
  M:  { name: '중형', credits: 20_000, mats: { alloy: 600, structure: 20 }, work: 100, power: 40, storage: 12_000, capacity: 14, berth: 'L', berths: 8, industrialTier: 2, upkeep: 300, cargoRate: 20 },
  L:  { name: '대형', credits: 50_000, mats: { alloy: 1_400, structure: 80, machinery: 30 }, work: 180, power: 80, storage: 30_000, capacity: 24, berth: 'L', berths: 14, industrialTier: 3, upkeep: 800, cargoRate: 35 },
  XL: { name: '초대형', credits: 120_000, mats: { alloy: 3_000, structure: 200, machinery: 80, electronics: 30 }, work: 300, power: 160, storage: 80_000, capacity: 39, berth: 'XL', berths: 24, industrialTier: 4, upkeep: 2_000, cargoRate: 60 },
};

export const stationSize = (st: Pick<Station, 'size'>): StationSizeDef | undefined => st.size ? STATION_SIZES[st.size] : undefined;
export const validStationSize = (v: unknown): v is Size => typeof v === 'string' && Object.hasOwn(STATION_SIZES, v);
/** A larger slip occupies more of the finite structural footprint. */
export const facilityCapacity = (kind: string) => kind === 'core' ? 0 : Math.max(1, FACILITIES[kind]?.yard ?? 1);
export const occupiedCapacity = (st: Pick<Station, 'modules'>) => st.modules.reduce((n, m) => n + facilityCapacity(m.kind), 0);
export const facilityTier = (kind: string) => FACILITIES[kind]?.yard ?? (['rare_refinery', 'composite_plant', 'engine_plant', 'reactor_plant'].includes(kind) ? 2 : 1);
export function facilityProblem(st: Station, kind: string): string | null {
  const size = stationSize(st); if (!size) return null;
  if (facilityTier(kind) > size.industrialTier) return `${st.size}급 정거장에는 이 규모의 산업 시설을 설치할 수 없습니다`;
  const used = occupiedCapacity(st), need = facilityCapacity(kind);
  if (used + need > size.capacity) return `시설 용량 부족 (${used}+${need}/${size.capacity})`;
  return null;
}
export function stationBerths(st: Station): number | undefined {
  const size = stationSize(st); if (!size) return undefined;
  return Math.min(28, size.berths + st.modules.filter(m => m.built && (m.kind === 'dock' || m.kind === 'hangar')).length * 2);
}
export function occupiedBerths(w: Pick<WorldState, 'ships'>, station: string, except?: string): number {
  return Object.values(w.ships).filter(s => s.id !== except && s.state === 'docked' && s.task.k === 'docked' && s.task.station === station).length;
}
export function stationUpkeep(st: Station): number {
  const size = stationSize(st);
  return size && st.modules.some(m => m.kind === 'core' && m.built) ? size.upkeep : 0;
}
/** The initial construction site remains able to receive just its outstanding construction inputs. */
export function stationCargoRate(st: Station): number | undefined {
  const size = stationSize(st); if (!size || !st.modules.some(m => m.kind === 'core' && m.built)) return undefined;
  const docks = st.modules.filter(m => m.built && m.kind === 'dock').length;
  return size.cargoRate * (1 + docks * 0.5);
}
export const moduleMaterials = (m: Module): Record<string, number> => m.materials ?? FACILITIES[m.kind]?.mats ?? {};
export const moduleWork = (m: Module): number => m.work ?? FACILITIES[m.kind]?.work ?? 1;
export function moduleUnlocks(st: Station, kind: string): string {
  const size = stationSize(st);
  if (size && kind === 'core') return `정박 · 창고 ${size.storage.toLocaleString()} · 하역 · 자체 건설반`;
  if (size && kind === 'dock') return '기본 화물 처리 속도 +50% · 정박 정원 +2';
  if (size && kind === 'hangar') return '정박 정원 +2 · 정박 함선 정비 속도 +50%';
  return FACILITIES[kind]?.unlocks ?? '';
}
