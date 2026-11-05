import { Rng } from '../sim/rng';
import type { WorldState, Station, Field, Lair, Company, V, StarSystem, Planet, SysKind } from './types';
import { emptyCargo } from './types';
import { sysOriginX, berthPos } from './geom';

export const WORLD_VERSION = 4;

export const SEC_BAND: { min: number; kind: SysKind; name: string; color: string }[] = [
  { min: 90, kind: 'core', name: '핵심 성계', color: '#6fe0ff' },
  { min: 70, kind: 'settled', name: '주요 거주 성계', color: '#7dffb0' },
  { min: 40, kind: 'frontier', name: '변방 성계', color: '#ffd166' },
  { min: 15, kind: 'danger', name: '위험 성계', color: '#ff8a4c' },
  { min: 0, kind: 'lawless', name: '무법 성계', color: '#ff4a3a' },
];
export const secBand = (sec: number) => SEC_BAND.find(b => sec >= b.min) ?? SEC_BAND[SEC_BAND.length - 1];

interface SysDef {
  id: string; name: string; idx: number; radius: number; security: number; desc: string;
  star: StarSystem['star']; nebula: [string, string]; map: { x: number; y: number };
}

const SYSTEMS: SysDef[] = [
  { id: 'helios', name: '헬리오스', idx: 0, radius: 42000, security: 96, desc: '연합 관리청의 수도 성계. 함대가 촘촘히 주둔해 해적은 감히 들어오지 못한다. 대신 세금이 높고 자원은 빈약하다.',
    star: { name: '헬리오스', color: '#cfe4ff', size: 2600 }, nebula: ['#14284f', '#1d4a6a'], map: { x: 0.12, y: 0.46 } },
  { id: 'astra', name: '아스트라', idx: 1, radius: 70000, security: 80, desc: '신생 PMC들이 첫발을 내딛는 거주 성계. 내행성 항로는 연합 순찰대가 지키지만 외곽 빙결대에는 떠돌이 해적이 드나든다.',
    star: { name: '아스트라', color: '#ffe2b0', size: 3000 }, nebula: ['#33204f', '#123850'], map: { x: 0.36, y: 0.5 } },
  { id: 'drake', name: '드레이크 변경', idx: 2, radius: 56000, security: 52, desc: '광맥이 풍부한 변방. 연합 전초기지 하나가 넓은 공역을 맡고 있어, 해적 은신처가 버젓이 운영된다. 호위 없는 채굴은 도박이다.',
    star: { name: '드레이크', color: '#ffb070', size: 2400 }, nebula: ['#3a2a14', '#1e3a2a'], map: { x: 0.6, y: 0.24 } },
  { id: 'ember', name: '엠버 성운', idx: 3, radius: 60000, security: 26, desc: '붉은 성운에 잠긴 위험 성계. 막대한 광석과 수정이 잠들어 있지만 붉은 갈퀴단이 항로를 장악했다. 정부군은 광산 조합 경비대뿐.',
    star: { name: '엠버', color: '#ff7a50', size: 2000 }, nebula: ['#4a1410', '#3a1a30'], map: { x: 0.62, y: 0.74 } },
  { id: 'fang', name: '검은 송곳니 공역', idx: 4, radius: 50000, security: 8, desc: '무법 공역. 검은 송곳니 해적단이 사실상 지배한다. 성계 최대의 수정 광상과 함선 묘지가 있지만, 대함대 없이 들어오면 돌아가지 못한다.',
    star: { name: '니그라', color: '#b080ff', size: 1800 }, nebula: ['#200a30', '#0a1a28'], map: { x: 0.88, y: 0.56 } },
];

const LINKS: [string, string][] = [['helios', 'astra'], ['astra', 'drake'], ['astra', 'ember'], ['drake', 'ember'], ['ember', 'fang']];

export function newWorld(seed: number): WorldState {
  const rng = new Rng(seed);
  const st: WorldState = {
    version: WORLD_VERSION, seed, rng: [], time: 0, nextId: 1,
    companies: {}, ships: {}, groups: {}, commanders: {}, stations: {}, fields: {}, lairs: {}, systems: {}, contracts: {}, engagements: {},
    events: [], eventSeq: 1, news: [],
  };
  const company = (c: Partial<Company> & Pick<Company, 'id' | 'name' | 'kind' | 'color'>) => {
    st.companies[c.id] = { credits: 0, rep: 0, createdAt: 0, stats: { earned: 0, mined: 0, kills: 0, lost: 0, battlesWon: 0, contracts: 0 }, milestones: [], homeStation: 'astra', ...c };
  };
  company({ id: 'guild', name: '성계 상인 길드', kind: 'guild', color: '#e8c070' });
  company({ id: 'union', name: '연합 관리청', kind: 'union', color: '#7fb0ff' });
  company({ id: 'pirates', name: '해적', kind: 'pirate', color: '#ff4a3a' });

  // ------------------------------------------------------------ systems
  for (const d of SYSTEMS) {
    st.systems[d.id] = {
      id: d.id, name: d.name, idx: d.idx, origin: { x: sysOriginX(d.idx), y: 0, z: 0 }, radius: d.radius, kind: 'settled', security: d.security, heat: 0,
      desc: d.desc, star: d.star, nebula: d.nebula, map: d.map, planets: [], gates: [], lanes: [],
      stats: { pirateKills: 0, unionLosses: 0, civLosses: 0, raids: 0, bands: 0 },
    };
    const s = st.systems[d.id];
    s.kind = d.security >= 90 ? 'core' : d.security >= 70 ? 'settled' : d.security >= 40 ? 'frontier' : d.security >= 15 ? 'danger' : 'lawless';
  }
  const S = (id: string) => st.systems[id];
  /** system-local polar/cartesian → global */
  const at = (sys: string, x: number, z: number, y = 0): V => ({ x: S(sys).origin.x + x, y, z: S(sys).origin.z + z });
  const orbit = (sys: string, r: number, a: number, y = 0): V => at(sys, Math.cos(a) * r, Math.sin(a) * r, y);
  const off = (p: V, dx: number, dz: number, dy = 0): V => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });

  const planet = (sys: string, p: Omit<Planet, 'pos' | 'moons'> & { r: number; a: number; moons?: [string, number][] }): Planet => {
    const pos = orbit(sys, p.r, p.a, -p.size * 0.15);
    const moons = (p.moons ?? []).map(([name, size], i) => { const ma = p.a + 1.3 + i * 2.1; const mr = p.size * 2.2 + i * p.size * 0.9; return { name, size, pos: off(pos, Math.cos(ma) * mr, Math.sin(ma) * mr, (i % 2 ? 1 : -1) * p.size * 0.2) }; });
    const pl: Planet = { id: p.id, name: p.name, pos, size: p.size, color: p.color, atmo: p.atmo, ring: p.ring, moons, desc: p.desc };
    S(sys).planets.push(pl);
    return pl;
  };

  // gates (paired)
  const gatePos: Record<string, V> = {
    'helios>astra': orbit('helios', 30000, 2.2, 60), 'astra>helios': orbit('astra', 26000, 5.6, 60),
    'astra>drake': orbit('astra', 63000, 1.45, 80), 'drake>astra': orbit('drake', 47000, 3.3, 80),
    'astra>ember': orbit('astra', 61000, 3.7, -60), 'ember>astra': orbit('ember', 50000, 0.5, -60),
    'drake>ember': orbit('drake', 50000, 5.4, 40), 'ember>drake': orbit('ember', 52000, 2.0, 40),
    'ember>fang': orbit('ember', 54000, 4.3, -30), 'fang>ember': orbit('fang', 42000, 1.1, -30),
  };
  for (const [a, b] of LINKS) {
    for (const [x, y] of [[a, b], [b, a]]) S(x).gates.push({ id: `gate:${x}>${y}`, name: `${S(y).name} 점프게이트`, to: y, exit: `gate:${y}>${x}`, pos: gatePos[`${x}>${y}`] });
  }

  const station = (sys: string, s: Omit<Station, 'storage' | 'modules' | 'defenseHp' | 'founded'>) => {
    const sec = S(sys).security;
    st.stations[s.id] = { tax: sec >= 90 ? 0.12 : sec >= 70 ? 0.05 : sec >= 40 ? 0.02 : 0, ...s, storage: {}, modules: [], defenseHp: 1, founded: 0 };
  };
  const field = (sys: string, f: Omit<Field, 'salvage' | 'expires' | 'danger'> & { danger?: number }) => {
    const sec = S(sys).security;
    st.fields[f.id] = { danger: sec >= 70 ? 1 : sec >= 40 ? 2 : 3, rich: sec >= 90 ? 0.8 : sec >= 70 ? 1 : sec >= 40 ? 1.35 : sec >= 15 ? 1.7 : 2.2, ...f, salvage: false, expires: 0 };
  };
  const lair = (sys: string, l: Omit<Lair, 'hp' | 'alive' | 'respawnAt' | 'nextBand'>) => { st.lairs[l.id] = { ...l, hp: 1, alive: true, respawnAt: 0, nextBand: 150 + rng.range(0, 120) }; void sys; };

  // ============================================================ HELIOS (core)
  const prime = planet('helios', { id: 'prime', name: '헬리오스 프라임', r: 14000, a: 0.6, size: 2200, color: '#4a7ad0', atmo: '#9cd0ff', ring: false, moons: [['아르고', 320], ['세라', 220]], desc: '연합의 수도 행성.' });
  const talos = planet('helios', { id: 'talos', name: '탈로스', r: 26000, a: 3.4, size: 1300, color: '#8a7a6a', atmo: '#c0b0a0', ring: false, desc: '채굴이 끝난 암석 행성.' });
  planet('helios', { id: 'minerva', name: '미네르바', r: 37000, a: 5.0, size: 3400, color: '#8a6ab0', atmo: '#c8b0ff', ring: true, moons: [['오르', 400]], desc: '보라빛 가스 행성.' });
  station('helios', {
    id: 'helios', name: '헬리오스 조선소', owner: 'union', public: true, style: 1, pos: off(prime.pos, 4200, 1800, 0), radius: 320, garrison: 3,
    market: { ore: { stock: 2500, target: 3000, base: 10 }, alloy: { stock: 3000, target: 2500, base: 27 }, crystal: { stock: 200, target: 500, base: 115 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer', 'cruiser', 'battleship', 'miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '연합 관리청의 군수 조선소. 평판이 높은 PMC에게만 대형 군함을 판다. 핵심 성계라 판매세 12%.',
  });
  station('helios', {
    id: 'exchange', name: '프라임 궤도 거래소', owner: 'guild', public: true, style: 0, pos: off(prime.pos, -3800, -2600, 0), radius: 260, garrison: 2,
    market: { ore: { stock: 4000, target: 4000, base: 9 }, alloy: { stock: 2000, target: 2000, base: 30 }, crystal: { stock: 80, target: 600, base: 125 } },
    services: { repair: true, shipyard: ['miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '수도의 상업 중심. 수정 매입가가 가장 높지만 경쟁이 치열하고 세금이 무겁다.',
  });
  field('helios', { id: 'garden', name: '정원 띠', pos: off(talos.pos, 3200, -1500, 0), radius: 700, res: 'ore', amount: 4000, max: 4000, regen: 0.6, rocks: 70 });

  // ============================================================ ASTRA (settled, the central system)
  planet('astra', { id: 'ignis', name: '이그니스', r: 9000, a: 1.2, size: 900, color: '#c05030', atmo: '#ff9060', ring: false, desc: '항성에 바짝 붙은 용암 행성.' });
  const terra = planet('astra', { id: 'terranova', name: '테라 노바', r: 20000, a: 4.0, size: 2000, color: '#3a8a7a', atmo: '#90e0ff', ring: false, moons: [['루나', 300], ['세벡', 200]], desc: '아스트라의 거주 행성. 인구 3억.' });
  const barca = planet('astra', { id: 'barca', name: '바르카', r: 38000, a: 0.4, size: 4200, color: '#b08a5a', atmo: '#f0d0a0', ring: true, moons: [['티르', 420], ['오넨', 300], ['카이', 240]], desc: '고리를 두른 거대 가스 행성. 고리에서 광석이 난다.' });
  const kel = planet('astra', { id: 'kel', name: '켈', r: 57000, a: 2.6, size: 1300, color: '#a0c8e0', atmo: '#e0f4ff', ring: false, moons: [['미르', 200]], desc: '외곽의 얼음 행성. 연합 순찰이 드물다.' });
  const astraPos = off(terra.pos, 3800, 2600, 0);
  station('astra', {
    id: 'astra', name: '아스트라 자유항', owner: 'guild', public: true, style: 0, pos: astraPos, radius: 260, garrison: 2,
    market: { ore: { stock: 3000, target: 4000, base: 11 }, alloy: { stock: 1500, target: 1500, base: 32 }, crystal: { stock: 150, target: 400, base: 90 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer', 'miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '아스트라 최대의 중립 항구. 신생 PMC들이 이곳에서 첫 계약을 따낸다.',
  });
  station('astra', {
    id: 'bastion', name: '연합 제7 순찰기지', owner: 'union', public: true, style: 1, pos: orbit('astra', 31000, 2.9, 0), radius: 300, garrison: 3,
    market: { ore: { stock: 1500, target: 2000, base: 12 }, alloy: { stock: 2000, target: 2000, base: 29 }, crystal: { stock: 100, target: 300, base: 100 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer'], recruit: false, contracts: true, refit: true },
    desc: '아스트라 연합 신속대응함대의 모항. 외곽 항로 치안을 책임진다.',
  });
  station('astra', {
    id: 'nova', name: '노바 정제소', owner: 'guild', public: true, style: 2, pos: off(barca.pos, -7000, 3500, 0), radius: 240, garrison: 1,
    market: { ore: { stock: 2000, target: 6000, base: 15 }, alloy: { stock: 2500, target: 2500, base: 29 }, crystal: { stock: 100, target: 600, base: 110 } },
    services: { repair: true, shipyard: ['miner', 'hauler'], recruit: false, contracts: true, refit: false },
    desc: '광석을 대량으로 사들여 합금을 생산하는 정제 단지. 광석 매입가가 높다.',
  });
  station('astra', {
    id: 'barcaco', name: '바르카 채굴 조합', owner: 'guild', public: true, style: 2, pos: off(barca.pos, 6500, -6000, 0), radius: 220, garrison: 1,
    market: { ore: { stock: 2500, target: 5000, base: 13 }, alloy: { stock: 800, target: 1200, base: 33 }, crystal: { stock: 60, target: 300, base: 95 } },
    services: { repair: true, shipyard: ['miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: false },
    desc: '바르카 고리의 광부들이 세운 조합 정거장.',
  });
  field('astra', { id: 'kestrel', name: '케스트렐 암초대', pos: off(astraPos, 4200, -2600, -30), radius: 650, res: 'ore', amount: 7000, max: 7000, regen: 1.2, rocks: 90 });
  field('astra', { id: 'grey', name: '회색 띠', pos: orbit('astra', 27000, 4.9, 40), radius: 850, res: 'ore', amount: 10000, max: 10000, regen: 1.5, rocks: 120 });
  field('astra', { id: 'still', name: '고요한 바다', pos: off(terra.pos, -6000, 5200, 0), radius: 800, res: 'ore', amount: 9000, max: 9000, regen: 1.2, rocks: 110 });
  field('astra', { id: 'barcaring', name: '바르카 고리', pos: off(barca.pos, 0, -10500, -80), radius: 1200, res: 'ore', amount: 16000, max: 16000, regen: 2.2, rocks: 160, rich: 1.15 });
  field('astra', { id: 'kelice', name: '켈 빙결대', pos: off(kel.pos, -4500, 3000, 50), radius: 900, res: 'crystal', amount: 1800, max: 1800, regen: 0.3, rocks: 80, rich: 1.25, danger: 2 });

  // ============================================================ DRAKE REACH (frontier)
  const drake2 = planet('drake', { id: 'drake2', name: '드레이크 II', r: 15000, a: 2.0, size: 1500, color: '#8a5a3a', atmo: '#e0a070', ring: false, moons: [['파편', 180]], desc: '척박한 광산 행성.' });
  const orca = planet('drake', { id: 'orca', name: '오르카', r: 34000, a: 5.8, size: 3600, color: '#4a7a90', atmo: '#a0e0f0', ring: true, moons: [['혹등', 360], ['범고래', 260]], desc: '청록색 빙하 거인.' });
  station('drake', {
    id: 'drakeout', name: '드레이크 전초기지', owner: 'union', public: true, style: 1, pos: off(drake2.pos, 3500, 2200, 0), radius: 280, garrison: 1,
    market: { ore: { stock: 800, target: 3000, base: 16 }, alloy: { stock: 600, target: 1500, base: 36 }, crystal: { stock: 40, target: 300, base: 105 } },
    services: { repair: true, shipyard: ['corvette', 'destroyer', 'miner', 'hauler', 'constructor'], recruit: true, contracts: true, refit: true },
    desc: '변방 유일의 연합 기지. 광석과 합금이 늘 부족해 비싸게 사 준다. 판매세 2%.',
  });
  field('drake', { id: 'rust', name: '녹슨 띠', pos: off(drake2.pos, -5200, 4400, 0), radius: 900, res: 'ore', amount: 14000, max: 14000, regen: 2.0, rocks: 130 });
  field('drake', { id: 'deep', name: '심연 암초', pos: orbit('drake', 26000, 0.9, -60), radius: 1000, res: 'ore', amount: 16000, max: 16000, regen: 2.2, rocks: 140 });
  field('drake', { id: 'orcagem', name: '오르카 결정원', pos: off(orca.pos, -6500, 3000, 50), radius: 800, res: 'crystal', amount: 2600, max: 2600, regen: 0.4, rocks: 80 });
  lair('drake', { id: 'gravel', name: '자갈 해적단 은신처', owner: 'pirates', pos: orbit('drake', 44000, 0.2, -120), maxBands: 2, tier: 2, kind: 'hideout' });

  // ============================================================ EMBER NEBULA (danger)
  const cinderP = planet('ember', { id: 'cinder', name: '시더', r: 17000, a: 3.1, size: 1700, color: '#7a3020', atmo: '#ff7040', ring: false, desc: '잿빛 대기에 덮인 행성.' });
  planet('ember', { id: 'hale', name: '헤일', r: 40000, a: 5.4, size: 3000, color: '#a04a3a', atmo: '#ffa080', ring: true, moons: [['재', 300]], desc: '붉은 폭풍의 가스 행성.' });
  station('ember', {
    id: 'cinderco', name: '엠버 광산 조합', owner: 'guild', public: true, style: 2, pos: off(cinderP.pos, 3600, -2400, 0), radius: 240, garrison: 1,
    market: { ore: { stock: 3000, target: 3000, base: 12 }, alloy: { stock: 900, target: 1500, base: 38 }, crystal: { stock: 120, target: 400, base: 100 } },
    services: { repair: true, shipyard: ['miner', 'hauler', 'corvette'], recruit: true, contracts: true, refit: true },
    desc: '위험을 감수하는 광부들의 조합. 세금이 없고 계약 보수가 두둑하지만, 조합 경비대만으로는 해적을 막기 어렵다.',
  });
  field('ember', { id: 'ember', name: '붉은 먼지구름', pos: off(cinderP.pos, -6000, 6000, -60), radius: 1100, res: 'ore', amount: 20000, max: 20000, regen: 2.8, rocks: 160 });
  field('ember', { id: 'azure', name: '청색 수정원', pos: orbit('ember', 32000, 1.2, 80), radius: 900, res: 'crystal', amount: 3500, max: 3500, regen: 0.6, rocks: 90 });
  lair('ember', { id: 'redclaw', name: '붉은 갈퀴단 은신처', owner: 'pirates', pos: orbit('ember', 42000, 1.9, -120), maxBands: 3, tier: 3, kind: 'lair' });

  // ============================================================ FANG HOLLOW (lawless)
  planet('fang', { id: 'nigra', name: '니그라 I', r: 16000, a: 4.0, size: 1400, color: '#3a2a4a', atmo: '#a080ff', ring: false, desc: '빛을 삼키는 검은 행성.' });
  const wreckP = planet('fang', { id: 'graveP', name: '무덤성', r: 30000, a: 2.2, size: 2200, color: '#4a4a5a', atmo: '#8090a0', ring: true, desc: '옛 전쟁의 잔해가 궤도를 덮고 있다.' });
  station('fang', {
    id: 'rustport', name: '녹슨 정박지', owner: 'guild', public: true, style: 0, pos: orbit('fang', 36000, 0.8, 0), radius: 220, garrison: 0,
    market: { ore: { stock: 1000, target: 1000, base: 10 }, alloy: { stock: 600, target: 900, base: 34 }, crystal: { stock: 600, target: 600, base: 70 } },
    services: { repair: true, shipyard: [], recruit: true, contracts: true, refit: false },
    desc: '무법 공역의 암시장. 아무도 묻지 않는다. 해적도 이곳만큼은 건드리지 않는 불문율이 있다.',
  });
  field('fang', { id: 'void', name: '공허의 결정', pos: orbit('fang', 24000, 5.6, 40), radius: 1000, res: 'crystal', amount: 6000, max: 6000, regen: 1.0, rocks: 110 });
  field('fang', { id: 'graves', name: '함선 묘지', pos: off(wreckP.pos, 0, -8000, 0), radius: 1200, res: 'alloy', amount: 5000, max: 5000, regen: 0.5, rocks: 80 });
  lair('fang', { id: 'fang', name: '검은 송곳니 요새', owner: 'pirates', pos: orbit('fang', 12000, 1.6, 150), maxBands: 3, tier: 4, kind: 'fortress' });
  lair('fang', { id: 'hollow', name: '송곳니 전초', owner: 'pirates', pos: orbit('fang', 40000, 3.6, -100), maxBands: 2, tier: 3, kind: 'lair' });

  // trade lanes (visual + patrol routes)
  S('helios').lanes = [['gate:helios>astra', 'helios'], ['helios', 'exchange']];
  S('astra').lanes = [['gate:astra>helios', 'astra'], ['astra', 'bastion'], ['astra', 'nova'], ['nova', 'barcaco'], ['barcaco', 'gate:astra>drake'], ['bastion', 'gate:astra>ember']];
  S('drake').lanes = [['gate:drake>astra', 'drakeout'], ['drakeout', 'gate:drake>ember']];
  S('ember').lanes = [['gate:ember>astra', 'cinderco'], ['cinderco', 'gate:ember>drake'], ['cinderco', 'gate:ember>fang']];
  S('fang').lanes = [['gate:fang>ember', 'rustport']];

  for (const s of Object.values(st.stations)) for (const c of Object.keys(st.companies)) s.storage[c] = emptyCargo();
  st.rng = rng.state();
  return st;
}

/** bring an older save into the multi-system world: keep players, their fleets, commanders and bases */
export function migrateWorld(old: WorldState): WorldState {
  if ((old.version ?? 0) >= WORLD_VERSION) return old;
  const st = newWorld(old.seed);
  st.time = old.time; st.eventSeq = old.eventSeq; st.nextId = Math.max(old.nextId, st.nextId) + 10;
  const astra = st.systems.astra;
  const players = Object.values(old.companies).filter(c => c.kind === 'player');
  const keep = new Set(players.map(c => c.id));
  for (const c of players) { st.companies[c.id] = { ...c, homeStation: st.stations[c.homeStation] ? c.homeStation : 'astra' }; }
  // public storage carries over where the station still exists
  for (const [id, s] of Object.entries(old.stations)) {
    if (s.public && st.stations[id]) for (const c of keep) if (s.storage[c]) st.stations[id].storage[c] = { ...s.storage[c] };
  }
  for (const s of Object.values(st.stations)) for (const c of keep) s.storage[c] ??= emptyCargo();
  // player-founded stations: the old map was centred on the free port → keep their offset from it
  const oldAstra = old.stations.astra?.pos ?? { x: 0, y: 0, z: 0 };
  for (const s of Object.values(old.stations)) {
    if (s.public || !keep.has(s.owner)) continue;
    let pos = { x: st.stations.astra.pos.x + (s.pos.x - oldAstra.x), y: 0, z: st.stations.astra.pos.z + (s.pos.z - oldAstra.z) };
    for (let k = 0; k < 20 && Object.values(st.stations).some(o => Math.hypot(o.pos.x - pos.x, o.pos.z - pos.z) < 2600); k++) pos = { x: pos.x + 1800, y: 0, z: pos.z - 1200 };
    st.stations[s.id] = { ...s, pos, storage: { ...s.storage } };
    for (const c of Object.keys(st.companies)) st.stations[s.id].storage[c] ??= emptyCargo();
  }
  for (const [id, c] of Object.entries(old.commanders)) if (c.owner && keep.has(c.owner)) st.commanders[id] = { ...c };
  const fieldOk = (id: string) => !!st.fields[id];
  const stOk = (id: string) => !!st.stations[id];
  let berth = 0;
  for (const g of Object.values(old.groups)) {
    if (!keep.has(g.owner)) continue;
    const op = g.op;
    const ok = op.k === 'idle' || (op.k === 'mine' && fieldOk(op.field) && stOk(op.deliver)) || (op.k === 'haul' && stOk(op.from) && stOk(op.to)) || (op.k === 'dock' && stOk(op.station)) || (op.k === 'build' && stOk(op.station)) || op.k === 'escort';
    st.groups[g.id] = { ...g, op: ok ? op : { k: 'idle' }, cooldown: 0, fleeing: false, status: ok ? g.status : '성계 재편 — 새 명령 대기' };
  }
  for (const s of Object.values(old.ships)) {
    if (!keep.has(s.owner) || !st.groups[s.groupId]) continue;
    const ns = { ...s, warp: undefined, engagement: undefined, fx: undefined } as typeof s;
    const dockAt = s.task.k === 'docked' && st.stations[s.task.station] ? st.stations[s.task.station] : null;
    if (dockAt && s.task.k === 'docked') { ns.pos = berthPos(st.stations[dockAt.id], s.task.berth); ns.state = 'docked'; }
    else {
      // ships in space (or mid-battle) re-enter near the free port
      ns.state = 'space'; ns.task = { k: 'none' };
      const a = (berth++) * 0.7;
      ns.pos = { x: st.stations.astra.pos.x + Math.cos(a) * 900, y: 0, z: st.stations.astra.pos.z + Math.sin(a) * 900 };
    }
    ns.vel = { x: 0, y: 0, z: 0 };
    st.ships[s.id] = ns;
  }
  // keep group ship lists consistent
  for (const g of Object.values(st.groups)) { g.shipIds = g.shipIds.filter(id => st.ships[id]); g.childIds = g.childIds.filter(id => st.groups[id]); if (g.parentId && !st.groups[g.parentId]) { g.parentId = null; g.override = true; } }
  st.events = (old.events ?? []).slice(-60);
  st.events.push({ id: st.eventSeq++, t: st.time, kind: 'world', text: `성계 지도가 확장되었다: ${Object.values(st.systems).map(s => s.name).join(' · ')}. 기존 함대는 ${astra.name} 성계로 재배치되었다.` });
  return st;
}
