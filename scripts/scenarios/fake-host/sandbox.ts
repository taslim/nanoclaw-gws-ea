import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A real shell with read/write/network access restricted to this invented host. */
export function prepareSyntheticShell(directory: string, tree: string): { profile: string; bin: string; bun: string } {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec'))
    throw new Error(
      'This initial hand-run host requires macOS sandbox-exec. No unsandboxed shell fallback is allowed.',
    );
  const located = spawnSync('/usr/bin/which', ['bun'], { encoding: 'utf8' });
  if (located.status !== 0) throw new Error('The installed Bun runtime is required.');
  const bun = fs.realpathSync(located.stdout.trim());
  const agent = path.join(directory, 'agent');
  const endpointFile = path.join(directory, 'host-endpoint.json');
  const endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')) as { url: string };
  const port = new URL(endpoint.url).port;
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const executable of ['gog', 'ncl'])
    fs.writeFileSync(
      path.join(bin, executable),
      `#!/bin/sh\nexec ${shellQuote(bun)} ${shellQuote(path.join(tree, 'scripts/scenarios/fake-host/cli.ts'))} ${shellQuote(path.join(directory, 'fixture.json'))} ${shellQuote(executable)} "$@"\n`,
      { mode: 0o700 },
    );
  const readRoots = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/opt/homebrew',
    '/dev',
    agent,
    bin,
    path.join(tree, 'scripts/scenarios'),
    path.join(tree, 'container/skills'),
  ];
  const readFiles = [
    '/',
    endpointFile,
    path.join(tree, 'package.json'),
    path.join(tree, 'tsconfig.json'),
    path.join(tree, 'src'),
    path.join(tree, 'src/modules'),
    path.join(tree, 'src/modules/gws-ea-whereabouts'),
    path.join(tree, 'src/modules/gws-ea-whereabouts/clock.ts'),
    path.join(tree, 'src/modules/gws-ea-whereabouts/clock.js'),
    '/private/etc/localtime',
    '/private/etc/hosts',
    '/private/etc/resolv.conf',
  ];
  const profile = path.join(directory, 'synthetic-shell.sb');
  fs.writeFileSync(
    profile,
    [
      '(version 1)',
      '(deny default)',
      '(allow process-exec process-fork)',
      '(allow sysctl-read)',
      '(allow file-read-metadata)',
      `(allow file-read* ${readRoots.map((root) => `(subpath ${JSON.stringify(fs.realpathSync(root))})`).join(' ')} ${readFiles.map((file) => `(literal ${JSON.stringify(fs.existsSync(file) ? fs.realpathSync(file) : file)})`).join(' ')})`,
      `(allow file-write* (subpath ${JSON.stringify(fs.realpathSync(agent))}) (literal "/dev/null"))`,
      `(allow network-outbound (remote ip "localhost:${port}"))`,
    ].join('\n'),
  );
  return { profile, bin, bun };
}
export function syntheticShellCommand(profile: string, command: string, tree: string): string {
  const directory = path.dirname(profile);
  const agent = path.join(directory, 'agent');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(path.join(agent, '.tmp'), { recursive: true });
  const relocated = command
    .replaceAll('/workspace/agent', agent)
    .replaceAll('/app/skills', path.join(tree, 'container/skills'));
  return `/usr/bin/env -i PATH=${shellQuote(`${bin}:/usr/bin:/bin:/opt/homebrew/bin`)} HOME=${shellQuote(agent)} TMPDIR=${shellQuote(path.join(agent, '.tmp'))} TZ=America/Los_Angeles /usr/bin/sandbox-exec -f ${shellQuote(profile)} /bin/bash --noprofile --norc -c ${shellQuote(relocated)}`;
}
