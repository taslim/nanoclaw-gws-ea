/**
 * Uninstall: teardown(host) by default; teardown(gcp) with --gcp.
 *
 * Endpoint without --gcp: clone-equivalent local state — no v2 process,
 * no plist, no .env. GCP resources retained (project, SA, Pub/Sub, DWD,
 * Chat app). Re-bootstrap with `bash setup-gws-ea.sh`.
 *
 * Endpoint with --gcp: also runs setup/provision-gcp.sh --delete (which
 * has its own confirmation step, so two prompts).
 *
 * Usage:
 *   pnpm exec tsx setup/uninstall.ts          # interactive confirm
 *   pnpm exec tsx setup/uninstall.ts --yes    # non-interactive (still confirms GCP separately)
 *   pnpm exec tsx setup/uninstall.ts --gcp    # also tear down GCP
 *
 * Or via the wrapper script: bash setup-uninstall.sh
 */
import * as p from '@clack/prompts';
import k from 'kleur';

import { teardown, type TeardownScope } from './teardown.js';

interface Args {
  yes: boolean;
  gcp: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { yes: false, gcp: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--gcp') out.gcp = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

function printHelp(): void {
  console.log(`
${k.bold('uninstall')} — tear down a v2 install on this machine.

Without --gcp: stops service, deletes v2 OneCLI agents, wipes data/, logs/,
dist/, untracked files in groups/ and container/, the launchd plist, and
.env. Result: clone-equivalent local state. GCP resources retained.

With --gcp: additionally runs setup/provision-gcp.sh --delete to tear down
the GCP project / SA / Pub/Sub / DWD / Chat app. That script has its own
confirmation step.

  --yes, -y    skip the local-teardown confirmation
  --gcp        also tear down GCP resources (separate confirmation)
  --help       show this message

Re-bootstrap afterwards with: bash setup-gws-ea.sh
`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(k.red((err as Error).message));
    printHelp();
    process.exit(1);
  }
  if (args.help) {
    printHelp();
    return;
  }

  const scope: TeardownScope = args.gcp ? 'gcp' : 'host';

  p.intro(k.bgRed(k.white(' uninstall ')));
  p.log.warn(
    args.gcp
      ? 'This will remove .env, the launchd plist, runtime state, OneCLI v2 agents, AND GCP resources.'
      : 'This will remove .env, the launchd plist, runtime state, and OneCLI v2 agents. GCP retained.',
  );

  await teardown(scope, { yes: args.yes });

  p.outro(
    args.gcp
      ? k.green('Uninstalled. To set up again: bash setup-gws-ea.sh')
      : k.green('Uninstalled (GCP retained). To set up again: bash setup-gws-ea.sh'),
  );
}

main().catch((err) => {
  console.error(k.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
