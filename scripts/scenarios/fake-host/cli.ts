import { fileURLToPath } from 'node:url';
import { callHost } from './state.js';

export async function runFixtureCommand(file: string, executable: string, args: readonly string[]): Promise<string> {
  const phase = process.env.SCENARIO_PHASE ?? 'agent';
  if (executable === 'gog') return JSON.stringify(await callHost(file, 'gog', { argv: args, phase }));
  if (executable !== 'ncl') throw new Error(`Unknown synthetic executable: ${executable}`);
  const result = (await callHost(file, 'ncl', { argv: args, phase })) as { frame: { ok: boolean }; stdout: string };
  if (!result.frame.ok) throw new Error(result.stdout);
  return result.stdout;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, executable, ...args] = process.argv.slice(2);
  if (!file || !executable) throw new Error('Missing synthetic host context');
  console.log(await runFixtureCommand(file, executable, args));
}
