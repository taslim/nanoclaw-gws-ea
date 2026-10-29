import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callHost } from './state.js';

export async function runFixtureCommand(file: string, executable: string, args: readonly string[]): Promise<string> {
  if (executable === 'gog')
    return JSON.stringify(await callHost(file, 'gog', { argv: args, phase: process.env.SCENARIO_PHASE ?? 'agent' }));
  if (executable !== 'ncl') throw new Error(`Unknown synthetic executable: ${executable}`);
  const phase = process.env.SCENARIO_PHASE ?? 'agent';
  const answer =
    phase === 'close-script-proof'
      ? await callHost(file, 'probe', { steps: [{ method: 'ncl', args: { argv: args } }], phase: 'preflight' })
      : await callHost(file, 'ncl', { argv: args, phase });
  if (phase === 'close-script-proof')
    fs.writeFileSync(
      path.join(path.dirname(file), 'preflight-close-script-native.json'),
      JSON.stringify(answer, null, 2),
    );
  const result = (
    phase === 'close-script-proof' ? (answer as { results: { answer: unknown }[] }).results[0]?.answer : answer
  ) as {
    frame: { ok: boolean };
    stdout: string;
  };
  if (!result.frame.ok) throw new Error(result.stdout);
  return result.stdout;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, executable, ...args] = process.argv.slice(2);
  if (!file || !executable) throw new Error('Missing synthetic host context');
  console.log(await runFixtureCommand(file, executable, args));
}
