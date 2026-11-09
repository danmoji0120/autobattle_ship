import { configProblems, runBattle, summarize, type BattleResult, type LabConfig } from './labModel';

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ config: LabConfig; count: number; swap: boolean }>) => void) | null; postMessage: (message: unknown) => void };
scope.onmessage = (event: MessageEvent<{ config: LabConfig; count: number; swap: boolean }>) => {
  try {
    const { config, count, swap } = event.data;
    const problems = configProblems(config);
    if (problems.length) throw new Error(problems.join('\n'));
    if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('반복 횟수는 1~10,000이어야 합니다');
    const battles: BattleResult[] = [], total = count * (swap ? 2 : 1);
    for (let i = 0; i < count; i++) {
      const seed = (config.seed + i) % 2147483648;
      battles.push(runBattle(config, seed, false));
      if (swap) battles.push(runBattle(config, seed, true));
      scope.postMessage({ type: 'progress', done: battles.length, total });
    }
    scope.postMessage({ type: 'complete', result: { schema: 'siderarium-combat-results-1', config, battles, summary: summarize(battles) } });
  } catch (error) { scope.postMessage({ type: 'error', error: (error as Error).message }); }
};
