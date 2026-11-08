// Research engine (server-authoritative). Data lives in industry.ts (TECHS, lab facilities).
//
//  - Every built lab instance gives `lines` research slots; a slot only takes projects of the lab's fields.
//  - Projects are a company-wide queue (co.research), each tied to the station whose labs do the work.
//    Queue order decides which project gets a free slot first; several projects run in parallel.
//  - Credits are charged when the project is registered; materials are consumed (atomically, from the
//    company's storage at that station) when the project starts in a slot. A project whose prerequisites
//    are still being researched waits for them ('선행 연구 대기').
//  - Progress: dt × station power factor × company researchMul.
//  - kinds: 'lab' (normal), 'salvage' (reverse-engineering a captured item: consumes the item, faster,
//    cheaper), 'copy' (prints a tradeable blueprint item `bp:<tech>` of a known tech).

import { emit } from './observe';
import type { Station, Company, ResearchProject, WorldState } from './types';
import { qty, addc, hasAll } from './types';
import { FACILITIES, TECHS, EQUIPMENT, ITEMS, itemName, techFx, type Field } from './industry';
import { stationPower } from './production';

export const SALVAGE_TIME = 0.4;
export const COPY_TIME = 0.15;
export const COPY_COST = { electronics: 4, precision: 1 } as Record<string, number>;

/** research slots of a station: one per lab instance × lines, with the fields it can work on */
export function labSlots(st: Station): { kind: string; fields: Field[] }[] {
  const out: { kind: string; fields: Field[] }[] = [];
  for (const m of st.modules) {
    const f = FACILITIES[m.kind];
    if (!m.built || !f?.lab) continue;
    for (let i = 0; i < (f.lines ?? 1); i++) out.push({ kind: m.kind, fields: f.lab as Field[] });
  }
  return out;
}
export const fieldsAt = (st: Station) => new Set(labSlots(st).flatMap(s => s.fields));

/** what a project consumes when it starts */
export function projectCost(p: Pick<ResearchProject, 'tech' | 'source'>): Record<string, number> {
  const t = TECHS[p.tech];
  if (!t) return {};
  if (p.source === 'copy') return { ...COPY_COST };
  if (p.source === 'salvage') {
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(t.cost)) out[k] = Math.ceil(n * 0.3);
    const item = salvageItem(p.tech); if (item) out[item] = (out[item] ?? 0) + 1;
    return out;
  }
  return { ...t.cost };
}
export function projectCredits(tech: string, source?: ResearchProject['source']) {
  const t = TECHS[tech]; if (!t) return 0;
  return source === 'copy' ? Math.round(t.credits * 0.1) : source === 'salvage' ? Math.round(t.credits * 0.25) : t.credits;
}
export function projectTime(tech: string, source?: ResearchProject['source']) {
  const t = TECHS[tech]; if (!t) return 0;
  return Math.round(t.time * (source === 'copy' ? COPY_TIME : source === 'salvage' ? SALVAGE_TIME : 1));
}
/** captured equipment that can be reverse-engineered into this tech */
export function salvageItem(tech: string): string | undefined {
  return Object.values(EQUIPMENT).find(e => e.tech === tech)?.id;
}
/** techs a company could analyse from items in a station's storage */
export function salvageable(co: Company, st: Station): string[] {
  const S = st.storage[co.id];
  return Object.values(EQUIPMENT).filter(e => e.tech && !co.tech?.includes(e.tech) && qty(S, e.id) > 0).map(e => e.tech!);
}

export const known = (co: Company | undefined, tech: string) => !!co?.tech?.includes(tech);
/** prerequisites not yet known */
export const missingPre = (co: Company, tech: string) => (TECHS[tech]?.pre ?? []).filter(p => !known(co, p));

/** validates a new project (returns an error text) */
export function canQueue(co: Company, st: Station, tech: string, source: ResearchProject['source'] = 'lab'): string | null {
  const t = TECHS[tech];
  if (!t) return '알 수 없는 연구';
  if (st.owner !== co.id) return '자사 정거장에서만 연구할 수 있습니다';
  if (!fieldsAt(st).has(t.field)) return `${t.name}: 이 정거장에 해당 분야 연구소가 없습니다`;
  if (t.needLab && source !== 'copy' && !st.modules.some(m => m.built && m.kind === t.needLab)) return `${t.name}: 전문 연구소 필요 — ${FACILITIES[t.needLab]?.name ?? t.needLab}`;
  if (source === 'copy') {
    if (!known(co, tech)) return '보유한 기술만 설계도로 복제할 수 있습니다';
    if (!t.bp) return '이 기술은 설계도로 만들 수 없습니다';
  } else {
    if (known(co, tech)) return '이미 보유한 기술';
    if ((co.research ?? []).some(p => p.tech === tech && p.source !== 'copy')) return '이미 연구 대기열에 있습니다';
    // prerequisites may be known or queued earlier (they finish first)
    const queued = new Set((co.research ?? []).filter(p => p.source !== 'copy').map(p => p.tech));
    const miss = (t.pre ?? []).filter(p => !known(co, p) && !queued.has(p));
    if (miss.length) return `선행 연구 필요: ${miss.map(p => TECHS[p]?.name ?? p).join(', ')}`;
    if (source === 'salvage') {
      const item = salvageItem(tech);
      if (!item || qty(st.storage[co.id], item) < 1) return `분석할 노획품이 없습니다${item ? ` (${itemName(item)})` : ''}`;
    }
  }
  const cr = projectCredits(tech, source);
  if (co.credits < cr) return `자금 부족 — ${(cr - co.credits).toLocaleString()} cr 더 필요`;
  return null;
}

/** one company's research for dt seconds; returns finished projects */
export function stepResearch(stt: WorldState, co: Company, dt: number): ResearchProject[] {
  const list = co.research ?? [];
  if (!list.length) return [];
  const done: ResearchProject[] = [];
  const mul = techFx(co.tech).researchMul;
  // free slots per station (copied, consumed as projects take them)
  const free = new Map<string, { kind: string; fields: Field[] }[]>();
  const slotsOf = (sid: string) => { if (!free.has(sid)) { const st = stt.stations[sid]; free.set(sid, st && st.owner === co.id ? labSlots(st) : []); } return free.get(sid)!; };
  for (const p of list) {
    const st = stt.stations[p.station];
    const t = TECHS[p.tech];
    if (!st || st.owner !== co.id || !t) { p.why = '연구 정거장 상실'; continue; }
    if (p.paused) { p.why = '일시정지'; continue; }
    if (!p.started && p.source !== 'copy') {
      const miss = missingPre(co, p.tech);
      if (miss.length) { p.why = `선행 연구 대기: ${miss.map(x => TECHS[x]?.name ?? x).join(', ')}`; continue; }
    }
    const slots = slotsOf(p.station);
    const i = slots.findIndex(s => s.fields.includes(t.field));
    if (i < 0) { p.why = fieldsAt(st).has(t.field) ? '연구 슬롯 사용 중 — 순서 대기' : '해당 분야 연구소 없음'; continue; }
    if (!p.started) {
      const cost = projectCost(p);
      const S = st.storage[co.id] ??= {};
      if (!hasAll(S, cost)) {
        const short = Object.entries(cost).filter(([k, n]) => qty(S, k) < n).map(([k, n]) => `${itemName(k)} ${Math.ceil(n - qty(S, k))}`);
        p.why = `재료 부족: ${short.join(', ')}`;
        continue;
      }
      for (const [k, n] of Object.entries(cost)) { addc(S, k, -n); emit(stt, { kind: 'consume', reason: 'research', amount: n, company: co.id, station: st.id, item: k }); }
      p.started = true;
      emit(stt, { kind: 'research', reason: 'start', amount: 1, baseline: p.total, method: p.source ?? 'lab', company: co.id, item: p.tech, ref: p.id, station: p.station });
    }
    const [slot] = slots.splice(i, 1);
    const speed = stationPower(st).factor * mul;
    p.left = Math.max(0, p.left - dt * speed);
    p.why = `연구 중 — ${FACILITIES[slot.kind]?.name ?? '연구소'} ×${speed.toFixed(2)}`;
    if (p.left <= 0) done.push(p);
  }
  for (const p of done) {
    emit(stt, { kind: 'research', reason: 'complete', amount: 1, baseline: p.total, method: p.source ?? 'lab', company: co.id, item: p.tech, ref: p.id, station: p.station });
    co.research = co.research!.filter(x => x !== p);
    const st = stt.stations[p.station];
    if (p.source === 'copy') { if (st) addc(st.storage[co.id] ??= {}, `bp:${p.tech}`, 1); }
    else if (!known(co, p.tech)) (co.tech ??= []).push(p.tech);
  }
  return done;
}

/** learning a blueprint item: consumes it from the company's storage at that station */
export function learnBlueprint(co: Company, st: Station, tech: string): string | null {
  const t = TECHS[tech];
  if (!t) return '알 수 없는 설계도';
  if (known(co, tech)) return '이미 보유한 기술';
  const miss = missingPre(co, tech);
  if (miss.length) return `선행 기술 필요: ${miss.map(p => TECHS[p]?.name ?? p).join(', ')}`;
  const S = st.storage[co.id];
  if (qty(S, `bp:${tech}`) < 1) return '창고에 설계도가 없습니다';
  addc(S, `bp:${tech}`, -1);
  (co.tech ??= []).push(tech);
  co.research = (co.research ?? []).filter(p => !(p.tech === tech && p.source !== 'copy' && !p.started));
  return null;
}

/** loot recovered from pirate wrecks by a company with salvage_ops */
export function wreckLoot(rng: () => number, equipment: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { weapon_parts: 1 + Math.floor(rng() * 3), electronics: Math.floor(rng() * 3) };
  const eq = Object.entries(equipment).filter(([k]) => EQUIPMENT[k]);
  if (eq.length && rng() < 0.35) { const [k] = eq[Math.floor(rng() * eq.length)]; out[k] = 1; }
  for (const k of Object.keys(out)) if (!out[k] || !(ITEMS[k] || EQUIPMENT[k])) delete out[k];
  return out;
}

/** growth: what a finished research now lets the company make or build (event text) */
export function unlockSummary(tech: string): string {
  const eq = Object.values(EQUIPMENT).filter(e => e.tech === tech).map(e => e.name);
  const fac = Object.values(FACILITIES).filter(f => f.tech === tech).map(f => f.name);
  const parts = [eq.length ? `생산 가능: ${eq.join(', ')}` : '', fac.length ? `건설 가능: ${fac.join(', ')}` : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(' · ')})` : '';
}
