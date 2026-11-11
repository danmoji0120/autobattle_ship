// Experiment B — controlled interventions on forks of the SAME warmed-up world.
//   npx vite-node scripts/audit/experiments.ts <seed> <warmupH> <armH> <out.json> [arm,arm,...]
// Each arm starts from an identical serialized state; "control" and "control2" must match exactly
// (determinism check), so any difference in another arm is caused by its intervention.
import fs from 'node:fs';
import { WorldSim } from '../../src/world/sim';
import { priceOf } from '../../src/world/market';
import type { WorldState } from '../../src/world/types';
import { run, sample } from './lib';

const seed = Number(process.argv[2] ?? 1), warmH = Number(process.argv[3] ?? 2), armH = Number(process.argv[4] ?? 3);
const out = process.argv[5] ?? `experiments-${seed}.json`;
const only = process.argv[6]?.split(',');

const base = WorldSim.create(seed);
run(base, warmH, 3600);
const snap = base.serialize();
const fork = () => new WorldSim(JSON.parse(snap) as WorldState);
const anySim = (s: WorldSim) => s as unknown as Record<string, (...a: unknown[]) => unknown>;
const sysOfId = (s: WorldSim, id: string) => s.st.systems[id];

type Arm = { name: string; why: string; setup?: (s: WorldSim) => { player?: string; note?: unknown } | void; onStep?: (s: WorldSim, ctx: Record<string, unknown>) => void; finish?: (s: WorldSim, ctx: Record<string, unknown>) => unknown };

/** a player PMC with a strong battle fleet docked at Astra */
function warFleet(s: WorldSim, name: string) {
  const pid = s.addPlayer(name);
  const g = s.newGroup(pid, '원정 함대');
  const cm = s.newCommander(pid, 3); g.commanderId = cm.id;
  const astra = s.st.stations.astra;
  for (const [cl, lo] of [['battleship', 'std'], ['battleship', 'std'], ['cruiser', 'gun'], ['cruiser', 'missile'], ['cruiser', 'multi'], ['destroyer', 'aa'], ['destroyer', 'aa'], ['destroyer', 'strike'], ['destroyer', 'strike']] as const)
    s.spawnShip(pid, cl, lo, g.id, { x: astra.pos.x + 900, y: 0, z: astra.pos.z + 900 });
  return { pid, g };
}

const arms: Arm[] = [
  { name: 'control', why: '개입 없음' },
  { name: 'control2', why: '개입 없음 (결정론 검사: control과 완전히 같아야 함)' },
  {
    // a war breaks out in a settled hub: three tier-4 war bands appear next to Astra and keep coming
    name: 'war_astra', why: '아스트라(정착, 4개 공영 시장)에 4등급 해적 전투단 3개를 투입하고 2시간 동안 30분마다 1개씩 증원',
    setup: s => { const ctx = { n: 0 }; spawnWar(s, 3); return { note: ctx }; },
    onStep: (s, ctx) => { const k = Math.floor((s.st.time - (ctx.t0 as number ?? (ctx.t0 = s.st.time))) / 1800); if (k > (ctx.k as number ?? 0) && k <= 4) { ctx.k = k; spawnWar(s, 1); } },
  },
  {
    // the trade route into Ember is blocked: maximal pirate pressure kept on the system all the time
    name: 'blockade_ember', why: '엠버(위험, 신더 정거장)의 해적 열기를 100으로 유지 — 항로 봉쇄 상황',
    onStep: s => { sysOfId(s, 'ember').heat = 100; },
  },
  {
    // catastrophic loss: every Union warship in Astra is lost at once
    name: 'union_wiped_astra', why: '아스트라의 연합 함선 전부를 한 번에 제거(대패 상황)',
    setup: s => {
      let n = 0;
      for (const g of Object.values(s.st.groups)) if (g.owner === 'union' && g.npc?.sys === 'astra') {
        for (const id of g.shipIds) { delete s.st.ships[id]; n++; }
        // exactly what finishEngagement does after a wiped-out force: rebuild after respawnTime(system)
        g.shipIds = []; g.npc.nextRefit = Math.max(g.npc.nextRefit, s.st.time + (anySim(s).respawnTime.call(s, s.st.systems.astra) as number));
      }
      return { note: { removed: n } };
    },
  },
  {
    // a player dumps a large cargo of alloy at Helios (the biggest alloy consumer) and buys it back elsewhere
    name: 'player_dump_alloy', why: '플레이어가 헬리오스에 합금 3,000을 판매(시장 충격과 회복 측정)',
    setup: s => {
      const pid = s.addPlayer('투매 PMC');
      const helios = s.st.stations.helios;
      helios.storage[pid].alloy = 3000;
      const before = { stock: helios.market!.alloy.stock, price: priceOf(helios.market!.alloy, 'sell', true), funds: helios.funds, credits: s.st.companies[pid].credits };
      const err = s.command(pid, { c: 'sell', station: 'helios', res: 'alloy', amount: 3000 });
      const after = { stock: helios.market!.alloy.stock, price: priceOf(helios.market!.alloy, 'sell', true), funds: helios.funds, credits: s.st.companies[pid].credits, left: helios.storage[pid].alloy };
      return { player: pid, note: { err, before, after } };
    },
  },
  {
    // the player intervenes militarily: a strong fleet destroys the Ember pirate lair
    name: 'player_assault_lair', why: '플레이어 함대(전함 2·순양함 3·구축함 4)가 엠버 해적 소굴(redclaw)을 공격',
    setup: s => {
      const { pid, g } = warFleet(s, '원정 PMC');
      const err = s.command(pid, { c: 'setOp', group: g.id, op: { k: 'attack', lair: 'redclaw' } });
      return { player: pid, note: { err } };
    },
  },
  {
    // counterfactual for the stagnation hypothesis: the idle war bands parked in Black Fang hold the
    // global pirate ship cap (70); remove them once and see whether raiding elsewhere resumes
    name: 'cap_released', why: '검은 송곳니에 주둔한(표적이 없는) 해적 함선을 한 번 제거 — 전역 해적 상한(70척) 가설 검증',
    setup: s => {
      let n = 0;
      for (const g of Object.values(s.st.groups)) if (g.owner === 'pirates' && g.npc?.sys === 'fang') { for (const id of g.shipIds) { delete s.st.ships[id]; n++; } g.shipIds = []; }
      return { note: { removed: n } };
    },
  },
  {
    // an ordinary active player: the starting miners work Kestrel and sell at Astra, the guard escorts
    name: 'player_miner', why: '일반 플레이어: 시작 채굴반이 케스트렐 광상에서 채굴해 아스트라에 판매, 경비대 호위',
    setup: s => {
      const pid = s.addPlayer('채굴 PMC');
      const gs = Object.values(s.st.groups).filter(g => g.owner === pid);
      const miners = gs.find(g => g.name === '제1 채굴반')!, guard = gs.find(g => g.name === '경비대')!;
      const e1 = s.command(pid, { c: 'setOp', group: miners.id, op: { k: 'mine', field: 'kestrel', deliver: 'astra', sell: true } });
      const e2 = s.command(pid, { c: 'setOp', group: guard.id, op: { k: 'escort', group: miners.id } });
      return { player: pid, note: { e1, e2 } };
    },
  },
  {
    name: 'player_passive', why: '같은 플레이어를 등록만 하고 아무것도 하지 않음 (채굴 실험의 대조군)',
    setup: s => ({ player: s.addPlayer('채굴 PMC') }),
  },
  {
    // are the guild traders (the only NPC goods movers) visible in the markets at all?
    name: 'no_guild', why: '길드 상선(유일한 NPC 상품 운송)을 모두 제거하고 재등장도 막음',
    setup: s => { for (const g of Object.values(s.st.groups)) if (g.owner === 'guild') { for (const id of g.shipIds) delete s.st.ships[id]; g.shipIds = []; } },
    onStep: s => { for (const g of Object.values(s.st.groups)) if (g.owner === 'guild' && g.shipIds.length) { for (const id of g.shipIds) delete s.st.ships[id]; g.shipIds = []; } },
  },
  {
    // the player destroys the lair once and goes home: how long does the liberation last on its own?
    name: 'player_raid_and_leave', why: '같은 함대가 redclaw를 한 번 파괴한 뒤 아스트라로 귀환(이후 개입 없음)',
    setup: s => {
      const { pid, g } = warFleet(s, '원정 PMC');
      const err = s.command(pid, { c: 'setOp', group: g.id, op: { k: 'attack', lair: 'redclaw' } });
      return { player: pid, note: { err, group: g.id } };
    },
    onStep: (s, ctx) => {
      if (ctx.left || s.st.lairs.redclaw.alive) return;
      const g = Object.values(s.st.groups).find(x => x.name === '원정 함대')!;
      ctx.left = s.command(g.owner, { c: 'setOp', group: g.id, op: { k: 'dock', station: 'astra' } }) ?? 'ok';
    },
  },
  {
    // the same fleet, sitting at home (control for the assault: same RNG use, same ships)
    name: 'player_fleet_idle', why: '같은 플레이어 함대를 생성만 하고 대기 (군사 개입 실험의 대조군)',
    setup: s => { const { pid } = warFleet(s, '원정 PMC'); return { player: pid }; },
  },
];

function spawnWar(s: WorldSim, n: number) {
  const astra = s.st.stations.astra;
  for (let i = 0; i < n; i++) {
    const a = i * 2.1 + s.st.time;
    const at = { x: astra.pos.x + Math.cos(a) * 7000, y: 0, z: astra.pos.z + Math.sin(a) * 7000 };
    const comp = anySim(s).bandComp.call(s, 4) as [string, string][];
    anySim(s).spawnBand.call(s, '침공 전투단', comp, at, { role: 'band', sys: 'astra', home: '', homePos: at }, { k: 'raid', home: '' }, 4);
  }
}

const results: Record<string, unknown> = {};
for (const arm of arms) {
  if (only && !only.includes(arm.name)) continue;
  const s = fork();
  const ctx: Record<string, unknown> = {};
  const set = arm.setup?.(s) ?? {};
  const r = run(s, armH, 600, { player: set.player, onStep: arm.onStep ? x => arm.onStep!(x, ctx) : undefined });
  const st = s.st;
  results[arm.name] = { why: arm.why, note: set.note, ...r, hash: hash(s.serialize()),
    final: { lairs: Object.values(st.lairs).map(l => ({ id: l.id, alive: l.alive, respawnAt: Math.round(l.respawnAt) })), recover: Object.fromEntries(Object.values(st.systems).map(x => [x.id, Math.round(x.recoverUntil ?? 0)])),
      contracts: Object.values(st.contracts).filter(k => !k.done).map(k => ({ kind: k.kind, station: k.stationId, title: k.title, reward: k.reward })),
      player: set.player ? { credits: st.companies[set.player].credits, stats: st.companies[set.player].stats, rep: st.companies[set.player].rep, ships: Object.values(st.ships).filter(x => x.owner === set.player).length } : null } };
  console.log(`${arm.name}: ${r.wallS.toFixed(0)}s battles ${r.battles.length}`);
}
fs.writeFileSync(out, JSON.stringify({ seed, warmH, armH, start: sample(base), results }));

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
