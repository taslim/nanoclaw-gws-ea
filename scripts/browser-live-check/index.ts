/**
 * pnpm exec tsx scripts/browser-live-check/index.ts
 *
 * Account-free checks through the production Chrome launch/connection path.
 * A fresh throwaway profile and a deny-all proxy are always used here.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeEvidence, type LiveCheckReport, type ProbeResult } from './evidence.js';
import { assessQuietOperation, FocusSampler } from './focus-sampler.js';
import { launchProbeBrowser, localProbes } from './probes.js';

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('This live check requires the target Mac');
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-host-browser`;
  const sampler = new FocusSampler();
  const probes: ProbeResult[] = [];
  let chromeVersion = 'unavailable';
  const { stdout } = await execFileAsync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5_000 });
  await sampler.start();
  try {
    probes.push(
      await sampler.runProbe('local_browser_session', async () => {
        const probeBrowser = await launchProbeBrowser();
        chromeVersion = probeBrowser.browser.version();
        try {
          probes.push(...(await localProbes(probeBrowser, sampler.runProbe.bind(sampler))));
          return {
            status: 'passed',
            detail: {
              profile: 'owner-only temporary profile, removed after run',
              network: 'deny-all proxy',
              transport: 'owned Chrome child on explicit loopback CDP port',
              debuggerPort: probeBrowser.debuggerPort,
              isolation: 'not measured; use the deployed capability check for its assistant-network route',
            },
          };
        } finally {
          await probeBrowser.close();
        }
      }),
    );
  } finally {
    await sampler.stop();
  }
  const quiet = assessQuietOperation(sampler.observations);
  probes.push({
    name: 'quiet_operation',
    status: quiet.status,
    detail: {
      changes: quiet.changes,
      unavailable: quiet.unavailable,
      sampledFrontmostAndClipboardCounter: true,
      clipboardContentsRead: false,
    },
  });
  const notRun = {
    keychain_prompts:
      'Requires operator visual observation, including a fresh/rebooted login; no Keychain interaction was attempted',
    native_popups_and_external_apps:
      'Requires runtime suppression before a page-initiated popup or external-app attempt can be exercised safely',
    download_and_file_chooser:
      'Requires runtime interception and durable handoff; local transport alone does not prove these contracts',
    public_site_flows:
      'Not run by this deny-all check; publicSiteProbes requires the production public-only proxy and establishes anonymous page loading only',
    operator_chrome_comparison: 'Operator is unavailable; the harness never adopts a personal profile',
    secret_confinement: 'Requires the implemented runtime secret boundary',
    concurrency: 'Requires native job/session leases and the implemented runtime',
    watch_soak: 'Requires implemented watch scheduler and a real multi-day measurement',
    public_only_egress:
      'Local probes use deny-all egress; this does not prove the runtime public-address filter, rebinding handling, or TLS fingerprint',
    other_desktop_states: 'Fast User Switching, another Space, display sleep and operator typing were not exercised',
  };
  for (const [name, reason] of Object.entries(notRun)) probes.push({ name, status: 'not-run', detail: { reason } });
  const report: LiveCheckReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    chromeVersion,
    macosVersion: stdout.trim(),
    probes,
    observations: sampler.observations,
    decisions: {
      transport:
        probes.find((probe) => probe.name === 'owned_loopback_cdp')?.status === 'passed'
          ? 'production owned loopback CDP attachment verified'
          : 'production loopback CDP attachment not proven',
      chromeBuild: chromeVersion,
      minimized: probes.find((probe) => probe.name === 'minimized_rendering_and_input')?.status ?? 'not-run',
      detection:
        'Selected production configuration only; merchant compatibility requires independent anonymous navigation checks',
      apiSurface: probes.find((probe) => probe.name === 'playwright_api_surface')?.status ?? 'not-run',
      acceptance:
        'Local native evidence only; not-run entries and locked-desktop samples cannot establish active-desktop, assistant-network or real errand acceptance',
    },
  };
  const destination = await writeEvidence({ outputRoot: resolve('docs/rebuild/evidence'), runId, report });
  process.stdout.write(
    `${destination}\n${JSON.stringify(
      probes.map(({ name, status }) => ({ name, status })),
      null,
      2,
    )}\n`,
  );
  if (probes.some((probe) => probe.status === 'failed')) process.exitCode = 1;
}

await main();
