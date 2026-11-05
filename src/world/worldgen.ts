import { Rng } from '../sim/rng';
import type { WorldState, Station, Field, Lair, Company, V } from './types';
import { emptyCargo } from './types';

const v = (x: number, z: number, y = 0): V => ({ x, y, z });

export const WORLD_VERSION = 3;

export function newWorld(seed: number): WorldState {
  const rng = new Rng(seed);
  const st: WorldState = {
    version: WORLD_VERSION, seed, rng: [], time: 0, nextId: 1,
    companies: {}, ships: {}, groups: {}, commanders: {}, stations: {}, fields: {}, lairs: {}, contracts: {}, engagements: {},
    events: [], eventSeq: 1, news: [],
  };
  const company = (c: Partial<Company> & Pick<Company, 'id' | 'name' | 'kind' | 'color'>) => {
    st.companies[c.id] = { credits: 0, rep: 0, createdAt: 0, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [], homeStation: 'astra', ...c };
  };
  company({ id: 'guild', name: '성계 상인 길드', kind: 'guild', color: '#e8c070' });
  company({ id: 'union', name: '연합 관리청', kind: 'union', color: '#7fb0ff' });
  company({ id: 'pirates', name: '붉은 갈퀴단', kind: 'pirate', color: '#ff4a3a' });

  const station = (s: Omit<Station, 'storage' | 'modules' | 'defenseHp' | 'founded'>) => {
    st.stations[s.id] = { ...s, storage: {}, modules: [], defenseHp: 1, founded: 0 };
  };
  station({
    id: 'astra', name: '아스트라 자유항', owner: 'guild', public: true, style: 0, pos: v(0, 0), radius: 260,
    market: { ore: { stock: 3000, target: 4000, base: 11 }, alloy: { stock: 1500, target: 1500, base: 32 }, crystal: { stock: 150, target: 400, base: 85 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer', 'miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '성계 최대의 중립 항구. 신생 PMC들이 이곳에서 첫 계약을 따낸다.',
  });
  station({
    id: 'helios', name: '헬리오스 조선소', owner: 'union', public: true, style: 1, pos: v(-7600, 4200, -40), radius: 320,
    market: { ore: { stock: 2500, target: 3000, base: 12 }, alloy: { stock: 3000, target: 2500, base: 27 }, crystal: { stock: 200, target: 500, base: 95 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer', 'cruiser', 'battleship', 'miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '연합 관리청의 군수 조선소. 평판이 높은 PMC에게만 대형 군함을 판다.',
  });
  station({
    id: 'nova', name: '노바 정제소', owner: 'guild', public: true, style: 2, pos: v(7200, 5400, 60), radius: 240,
    market: { ore: { stock: 2000, target: 6000, base: 15 }, alloy: { stock: 2500, target: 2500, base: 29 }, crystal: { stock: 100, target: 600, base: 110 } },
    services: { repair: true, shipyard: ['miner', 'hauler'], recruit: false, contracts: true, refit: false },
    desc: '광석을 대량으로 사들여 합금을 생산하는 정제 단지. 광석 매입가가 가장 높다.',
  });

  const field = (f: Omit<Field, 'salvage' | 'expires'>) => { st.fields[f.id] = { ...f, salvage: false, expires: 0 }; };
  field({ id: 'kestrel', name: '케스트렐 암초대', pos: v(2900, -2100, -30), radius: 650, res: 'ore', amount: 7000, max: 7000, regen: 1.2, rocks: 90, danger: 1 });
  field({ id: 'grey', name: '회색 띠', pos: v(-3600, -3900, 40), radius: 850, res: 'ore', amount: 10000, max: 10000, regen: 1.5, rocks: 120, danger: 1 });
  field({ id: 'still', name: '고요한 바다', pos: v(-9800, -1600, 0), radius: 800, res: 'ore', amount: 9000, max: 9000, regen: 1.2, rocks: 110, danger: 1 });
  field({ id: 'ember', name: '붉은 먼지구름', pos: v(8400, -4800, -60), radius: 950, res: 'ore', amount: 16000, max: 16000, regen: 2.5, rocks: 150, danger: 3 });
  field({ id: 'azure', name: '청색 수정원', pos: v(-1800, 10600, 80), radius: 700, res: 'crystal', amount: 2200, max: 2200, regen: 0.35, rocks: 70, danger: 3 });

  const lair = (l: Omit<Lair, 'hp' | 'alive' | 'respawnAt' | 'nextBand'>) => { st.lairs[l.id] = { ...l, hp: 1, alive: true, respawnAt: 0, nextBand: 70 + rng.range(0, 40) }; };
  lair({ id: 'redclaw', name: '붉은 갈퀴단 은신처', owner: 'pirates', pos: v(12500, -8200, -120), maxBands: 2 });
  lair({ id: 'fang', name: '검은 송곳니 기지', owner: 'pirates', pos: v(2600, 14200, 150), maxBands: 2 });

  for (const s of Object.values(st.stations)) for (const c of Object.keys(st.companies)) s.storage[c] = emptyCargo();
  st.rng = rng.state();
  return st;
}
