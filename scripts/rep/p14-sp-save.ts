// P14.0 browser save: a single-player P10 world on the reputation rules (repV) with one company whose standing covers
// every band the 평판·관계 tab shows. The values come from the real engine (repGain / repRecord / repOffense), not
// from hand-written fields, so the log, the gates and the grudge timer are the real ones:
//   credit ≈27 after the strike (우호) · iron 46 with 12 iron contracts (신뢰: the iron battleship blueprint unlocked) · guild 18 (협력)
//   · miners ≈8 (중립) · ceres 0 · union negative after a strike (불신, grudge running) · pirates −30 (적대 — set directly, with a log line)
//   npx vite-node scripts/rep/p14-sp-save.ts <out.json>
import { writeFileSync } from 'node:fs';
import { GameServer, type Conn } from '../../src/server/core';
import { SYNC_PROTO } from '../../src/server/sync';
import { WorldSim } from '../../src/world/sim';
import { repGain, repRecord, repOffense, coRep, CREDIT } from '../../src/world/reputation';

// a single-player host only to obtain a valid browser token; the world itself is a P10 repV world
const g = new GameServer(null, { singleplayer: true, snapInterval: 1 } as any, 133);
let tok = '';
const conn: Conn = { id: 'a', lastEvent: 0, battles: new Set(), send: (m: any) => { if (m.t === 'welcome') tok = m.token; }, sendText: () => {} };
g.connect(conn); g.handle('a', { t: 'hello', name: '관계 PMC', proto: SYNC_PROTO } as any);
const sim = WorldSim.create(133, { layout: 'p10', rep: 'p14' });
const w = sim.st;
const me = sim.addPlayer('관계 PMC');
const rival = sim.addPlayer('경쟁 PMC');
w.companies[me].credits = 5e6;
// spread the gains over game time so hourly budgets and gates apply as they would in play
const climb = (s: string, to: number, src: 'trade' | 'delivery' | 'bounty' | 'kill' | 'lair' | 'lair_contract', why: string) => {
  for (let i = 0; i < 4000 && ((s === CREDIT ? w.companies[me].rep : w.companies[me].standing?.[s] ?? 0) < to); i++) { w.time += 600; repGain(w, me, s, src, 3, why); }
};
for (let i = 0; i < 12; i++) repRecord(w, me, 'iron', 'k', `sp:iron:${i}`);
for (let i = 0; i < 12; i++) repRecord(w, me, CREDIT, 'k', `sp:credit:${i}`);
for (let i = 0; i < 3; i++) repRecord(w, me, 'guild', 'k', `sp:guild:${i}`);
climb('iron', 46, 'lair', '해적 기지 파괴 (철갑 국경)');
climb(CREDIT, 31, 'delivery', '납품 계약 완료');
climb('guild', 18, 'delivery', '조합 물류 계약');
climb('miners', 6, 'delivery', '광부 연합 부품 납품');
climb('union', 4, 'bounty', '연합 현상금');
repOffense(w, me, 'union', 'strike', 0, 'sp:strike', '연합 경비대 공격');
w.companies[me].standing!.pirates = -30; coRep(w.companies[me]).log.push({ t: w.time, s: 'pirates', d: -30, why: '해적 기지 파괴 (해적 세력 적대)' } as any);
w.companies[rival].standing = { iron: 77 }; w.companies[rival].rep = 66;
const save = { v: 1, world: JSON.parse(sim.serialize()), auth: { [tok]: me }, accounts: {} };
const co = w.companies[me];
writeFileSync(process.argv[2] ?? 'p14-sp.json', JSON.stringify({ save, token: tok, me, rival, credit: co.rep, standing: co.standing }));
console.log(JSON.stringify({ me, credit: co.rep, standing: co.standing, log: co.repx?.log.length, time: w.time }));
process.exit(0);
