// Follow-up analysis for experiment batch C (fleet-loss recovery with the real respawn delay,
// one-off lair raid) and the long autonomy run.
//   npx vite-node scripts/audit/followup.ts exp <exp-c.json>
//   npx vite-node scripts/audit/followup.ts long <autonomy-72h.json>
import fs from 'node:fs';
import type { Sample, BattleRec, EventRec } from './lib';
import { marketProfile, r1 } from './lib';

type Arm = { samples: Sample[]; battles: BattleRec[]; events: EventRec[]; hash: string; note?: unknown; final: { lairs: { id: string; alive: boolean; respawnAt: number }[]; player: unknown } };
const [mode, file] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));

if (mode === 'exp') {
  const R = d.results as Record<string, Arm>;
  console.log('hash', Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.hash])));
  for (const name of Object.keys(R)) {
    const a = R[name], t0 = a.samples[0].t;
    console.log(`\n## ${name}`, JSON.stringify(a.note ?? {}));
    const rows = a.samples.filter((_, i) => i < 8 || i % 6 === 0);
    console.log('t(h) | astra union | ember pir | ember inf u/p/g | ember eff | ember heat | lairs | cinderco machinery% | player cr');
    for (const s of rows) console.log(r1((s.t - t0) / 3600), '|', s.sys.astra.union, '|', s.sys.ember.pirates, '|', s.sys.ember.inf.join('/'), '|', s.sys.ember.eff, '|', s.sys.ember.heat, '|', s.lairs, '|', r1((s.mkt.cinderco?.g.machinery?.[0] ?? 0) * 100), '|', s.playerCredits ?? '-');
    const ev = a.events.filter(e => /재건|파괴|재편성|해방|소굴/.test(e.text)).map(e => `${r1((e.t - t0) / 60)}m ${e.text}`);
    console.log('events:', ev.slice(0, 20).join('\n  '));
    const by: Record<string, number> = {}; for (const b of a.battles) by[b.sys ?? '?'] = (by[b.sys ?? '?'] ?? 0) + 1;
    console.log('battles', a.battles.length, JSON.stringify(by), 'lairs', JSON.stringify(a.final.lairs.filter(l => !l.alive)), 'player', JSON.stringify(a.final.player));
  }
} else {
  const S: Sample[] = d.samples, B: BattleRec[] = d.battles, E: EventRec[] = d.events;
  const per = (h0: number, h1: number) => B.filter(b => b.t1 >= h0 * 3600 && b.t1 < h1 * 3600).length;
  console.log('battles total', B.length, 'per 12h:', [0, 12, 24, 36, 48, 60].map(h => per(h, h + 12)).join(' / '));
  const pick = [0, 1, 6, 12, 24, 36, 48, 60, 72].map(h => S.find(s => s.t >= h * 3600) ?? S.at(-1)!);
  console.log('h | union | pirates | guild | lairs | wrecks | funds(avg) | contracts');
  for (const s of pick) console.log(r1(s.t / 3600), '|', s.ships.union, '|', s.ships.pirates, '|', s.ships.guild, '|', s.lairs, '|', s.wrecks, '|', r1(Object.values(s.mkt).reduce((a, m) => a + m.funds, 0) / Object.keys(s.mkt).length * 100), '|', JSON.stringify(s.contractsOpen));
  const kinds: [string, RegExp][] = [['band', /해적 무리가 출격/], ['rogueIn', /떠돌이 해적.*(나타|출몰)/], ['rogueOut', /떠돌이 해적.*떠났/], ['regroup', /재편성/], ['lairDown', /에 의해 파괴되었다/], ['lairUp', /재건되었다/]];
  for (const [k, re] of kinds) { const ts = E.filter(e => re.test(e.text)).map(e => e.t); console.log(k, ts.length, 'per 24h:', [0, 24, 48].map(h => ts.filter(t => t >= h * 3600 && t < (h + 24) * 3600).length).join('/')); }
  const sysB: Record<string, number> = {}; for (const b of B) sysB[b.sys ?? '?'] = (sysB[b.sys ?? '?'] ?? 0) + 1; console.log('battles by sys', JSON.stringify(sysB));
  const late = S.filter(s => s.t >= 48 * 3600);
  const prof = marketProfile(late);
  console.log('markets 48-72h: goods', prof.length, 'flat(sd<1%)', prof.filter(r => r.sdLateHalf < 0.01).length, 'within ±5%', prof.filter(r => Math.abs(r.ratioEnd - 1) <= 0.05).length, 'short<60%', prof.filter(r => r.ratioEnd < 0.6).map(r => `${r.st}:${r.good}`).join(','), 'moving', prof.filter(r => r.sdLateHalf >= 0.05).map(r => `${r.st}:${r.good}`).join(','));
  const changed = Object.keys(S[0].sys).filter(id => { const a = S.find(s => s.t >= 3600)!.sys[id].inf, b = S.at(-1)!.sys[id].inf; return a.some((v, i) => Math.abs(v - b[i]) > 1); });
  console.log('systems whose influence moved >1 between 1h and 72h:', changed.join(','));
  console.log('NPC credits', JSON.stringify(d.final.companies.filter((c: { kind: string }) => c.kind !== 'player').map((c: { id: string; credits: number }) => [c.id, c.credits])));
}
