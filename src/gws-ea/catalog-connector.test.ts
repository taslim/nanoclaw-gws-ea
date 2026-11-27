import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogEntry, operatorEnabled, readCatalogPolicy } from '../modules/gws-ea-connections/catalog.js';
import { verifyHostCliReceipt, type HostCliTransport } from '../modules/gws-ea-connections/host-cli-receipt.js';
import { installLink, provisionLink, type CatalogRetirement } from './catalog-connector.js';
import { provisionInstalledConnectors } from './connector-provisioning.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { SanitizedCommand } from './process.js';
import { claimInstanceWeb } from './registry.js';
import type { InstanceRuntimeConfig, UpsertEnvVars } from './service.js';
import type { NanoclawServiceHelpers } from './service-control.js';
import { expectResultContract } from './testing/result-contract.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import { GwsEaError } from './types.js';

const pnpm = vi.hoisted(() => ({
  calls: [] as { args: readonly string[]; files: string[]; manifest: string; home: string | undefined }[],
}));
vi.mock('./process.js', async (original) => {
  const actual = await original<typeof import('./process.js')>();
  // Lays out what a frozen install of the staged package files produces: the lockfile decides the version, and a
  // manifest it does not match is refused as frozen pnpm refuses it.
  const install = async (command: SanitizedCommand) => {
    if (command.command !== 'pnpm') return actual.runSanitizedCommand(command);
    const manifest = await readFile(path.join(command.cwd, 'package.json'), 'utf8');
    pnpm.calls.push({
      args: command.args,
      files: (await readdir(command.cwd)).sort(),
      manifest,
      home: command.env?.HOME,
    });
    const locked = /'@stripe\/link-cli':\n\s+specifier: (\S+)\n\s+version: (\S+)/u.exec(
      await readFile(path.join(command.cwd, 'pnpm-lock.yaml'), 'utf8'),
    );
    const requested = (JSON.parse(manifest) as { dependencies: Record<string, string> }).dependencies[
      '@stripe/link-cli'
    ];
    if (!locked || locked[1] !== requested) throw new Error('ERR_PNPM_OUTDATED_LOCKFILE');
    const version = locked[2];
    const cli = path.join(command.cwd, 'node_modules/@stripe/link-cli');
    await mkdir(path.join(cli, 'dist'), { recursive: true });
    await writeFile(
      path.join(cli, 'package.json'),
      JSON.stringify({ name: '@stripe/link-cli', version, bin: { 'link-cli': 'dist/cli.js' } }),
    );
    await writeFile(path.join(cli, 'dist/cli.js'), `// link-cli ${version}\n`);
    const undici = path.join(command.cwd, 'node_modules/undici');
    await mkdir(undici, { recursive: true });
    await writeFile(path.join(undici, 'package.json'), JSON.stringify({ name: 'undici', main: 'index.js' }));
    await writeFile(path.join(undici, 'index.js'), 'module.exports = {};\n');
    return { stdout: '', stderr: '' };
  };
  return { ...actual, runSanitizedCommand: install };
});
// Another release ships its own committed Link package files; a test stands in for that release by pointing the
// installer's copy at a fixture directory.
const releasePackage = vi.hoisted(() => ({ directory: undefined as string | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  const copyFile: typeof actual.copyFile = (source, destination, mode) => {
    const file = String(source);
    const committed = path.dirname(file).endsWith(path.join('connector-packages', 'link'));
    return actual.copyFile(
      committed && releasePackage.directory ? path.join(releasePackage.directory, path.basename(file)) : source,
      destination,
      mode,
    );
  };
  return { ...actual, default: { ...actual, copyFile }, copyFile };
});
// `before` fails the policy write before its rename; `after` lets the rename land, then fails as a later step would.
const policyWrites = vi.hoisted(() => ({ fail: false as false | 'before' | 'after' }));
vi.mock('../community-portal/private-file.js', async (original) => {
  const actual = await original<typeof import('../community-portal/private-file.js')>();
  return {
    ...actual,
    writePrivate: async (file: string, value: unknown) => {
      const policy = path.basename(file) === 'catalog.json';
      if (policy && policyWrites.fail === 'before') throw new Error('The policy write failed.');
      await actual.writePrivate(file, value);
      if (policy && policyWrites.fail === 'after') throw new Error('The directory sync failed.');
    },
  };
});
const hostNcl = vi.hoisted(() =>
  vi.fn<(runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>>(),
);
vi.mock('./ncl.js', async (original) => ({
  ...(await original<typeof import('./ncl.js')>()),
  runInstanceNclJson: hostNcl,
}));

async function runCli(...args: Parameters<typeof import('./cli.js').runCli>) {
  return (await import('./cli.js')).runCli(...args);
}
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup/set-env.ts'))) as {
  upsertEnvVars: UpsertEnvVars;
};

const LINK = catalogEntry('link')!;
const PINNED = LINK.transport as HostCliTransport;
const RETIRE_LINK = ['gws-ea-connections-catalog-retire', '--entry', 'link'];
const confirmed = (entry: string, retired = 1) => ({ schemaVersion: 1, entry, retired, remaining: 0 });

let root: string;
let paths: ControlPlanePaths;
let policyFile: string;
let ports = 33000;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'catalog-connector-')));
  paths = resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
  policyFile = path.join(paths.configRoot, 'catalog.json');
  pnpm.calls = [];
  releasePackage.directory = undefined;
  policyWrites.fail = false;
  hostNcl.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function assistant(webHostname?: string): Promise<InstanceRuntimeConfig> {
  const id = randomUUID();
  ports += 10;
  const reservation = await reserveInstance(paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: ports, onecli_gateway: ports + 1 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: `${id}@example.test`,
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  });
  const runtime = await persistTestRuntime(paths, reservation);
  if (webHostname) await claimInstanceWeb(paths, id, { hostname: webHostname, listen_port: ports + 2 });
  return runtime;
}

function services(stopped: readonly InstanceRuntimeConfig[] = []): NanoclawServiceHelpers {
  return {
    createCommandRunner: () => ({ run: () => '', tryRun: () => ({ ok: false, stdout: '' }) }),
    detectService: (projectRoot) => ({
      mode: 'launchd',
      active: !stopped.some((runtime) => runtime.checkout_root === projectRoot),
    }),
    stopService: async () => undefined,
    startService: () => undefined,
    drainContainers: async () => undefined,
    verifyServiceHealth: async () => true,
  };
}

async function cli(argv: readonly string[], runtime: Parameters<typeof runCli>[1] = {}) {
  const output: string[] = [];
  const code = await runCli([...argv], {
    paths,
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    upsertEnvVars,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    ...runtime,
  });
  const json = argv.includes('--json');
  return { code, output, result: json ? (JSON.parse(output.join('\n')) as Record<string, unknown>) : undefined };
}

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

describe('Link connector', () => {
  it('installs the pinned version from the committed lockfile with a verifiable receipt, enables it and binds every assistant', async () => {
    const assistants = [await assistant(), await assistant()];
    const committed = await readFile(
      path.join(CONTROL_PLANE_ROOT, 'src/gws-ea/connector-packages/link/package.json'),
      'utf8',
    );

    const installed = await installLink(paths, { upsertEnvVars, environment: { PATH: '/usr/bin', HOME: '/operator' } });

    const directory = path.join(paths.configRoot, 'connectors', 'link', '1.6.0');
    expect(installed).toEqual({
      name: 'link',
      scope: 'host',
      enabled: true,
      version: '1.6.0',
      installation_dir: directory,
    });
    expect(pnpm.calls).toHaveLength(1);
    expect(pnpm.calls[0].args).toEqual([
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--prod',
      '--package-import-method=copy',
      '--config.manage-package-manager-versions=false',
    ]);
    expect(pnpm.calls[0].files).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(pnpm.calls[0].manifest).toBe(committed);
    expect(pnpm.calls[0].home).not.toBe('/operator');
    expect(await readdir(path.join(paths.configRoot, 'connectors', 'link'))).toEqual(['1.6.0']);
    await expect(verifyHostCliReceipt(directory, PINNED)).resolves.toEqual({
      entryFile: path.join(directory, 'node_modules/@stripe/link-cli/dist/cli.js'),
    });
    const state = await readCatalogPolicy(policyFile);
    expect(state).toEqual({
      status: 'read',
      policy: {
        schemaVersion: 1,
        link: { enabled: true, versions: { '1.6.0': { installationDir: directory } } },
        shop: null,
      },
    });
    expect((await stat(policyFile)).mode & 0o777).toBe(0o600);
    expect(operatorEnabled(LINK, state)).toBe(true);
    for (const runtime of assistants)
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
        `GWS_EA_CATALOG_POLICY_FILE=${policyFile}\n`,
      );

    await installLink(paths, { upsertEnvVars });
    expect(pnpm.calls).toHaveLength(1);
  });

  it('installs a newly pinned version beside the one a rolled-back assistant still runs', async () => {
    await installLink(paths);
    const next = { ...PINNED, version: '1.7.0' };
    const committed = path.join(CONTROL_PLANE_ROOT, 'src/gws-ea/connector-packages/link');
    const nextRelease = path.join(root, 'next-release-link-package');
    await mkdir(nextRelease);
    // The next release's committed files pin Link 1.7.0 and leave every other package as it was.
    const pin = (text: string, pattern: RegExp) =>
      text.replace(pattern, (match) => match.replaceAll(PINNED.version, next.version));
    await writeFile(
      path.join(nextRelease, 'package.json'),
      pin(await readFile(path.join(committed, 'package.json'), 'utf8'), /"@stripe\/link-cli": "[^"]+"/u),
    );
    await writeFile(
      path.join(nextRelease, 'pnpm-lock.yaml'),
      pin(
        await readFile(path.join(committed, 'pnpm-lock.yaml'), 'utf8'),
        /'@stripe\/link-cli':\n\s+specifier: \S+\n\s+version: \S+/u,
      ),
    );

    await expect(provisionLink(paths, next)).rejects.toMatchObject({ code: 'link_install_unverified' });
    expect(await exists(path.join(paths.configRoot, 'connectors', 'link', '1.7.0'))).toBe(false);
    releasePackage.directory = nextRelease;
    await provisionLink(paths, next);
    releasePackage.directory = undefined;
    await provisionLink(paths, PINNED);

    const staged = pnpm.calls.map(
      (call) =>
        (JSON.parse(call.manifest) as { dependencies: Record<string, string> }).dependencies['@stripe/link-cli'],
    );
    expect(staged).toEqual(['1.6.0', '1.6.0', '1.7.0']);
    const older = path.join(paths.configRoot, 'connectors', 'link', '1.6.0');
    const newer = path.join(paths.configRoot, 'connectors', 'link', '1.7.0');
    await expect(verifyHostCliReceipt(older, PINNED)).resolves.toBeDefined();
    await expect(verifyHostCliReceipt(newer, next)).resolves.toBeDefined();
    const state = await readCatalogPolicy(policyFile);
    expect(state).toMatchObject({
      status: 'read',
      policy: {
        link: { enabled: true, versions: { '1.6.0': { installationDir: older }, '1.7.0': { installationDir: newer } } },
      },
    });
    expect(operatorEnabled(LINK, state)).toBe(true);
    expect(operatorEnabled({ ...LINK, transport: next }, state)).toBe(true);
  });

  it('shows installed versions from local records and verifies their receipts only on check', async () => {
    await installLink(paths);

    const shown = await cli(['connectors', 'show', 'link', '--json']);
    expect(shown.code).toBe(0);
    expectResultContract('connectors show link', shown.result);
    expect(shown.result?.data).toMatchObject({
      setup: 'installed',
      readiness: { status: 'not_checked', checked: false },
      details: {
        pinned_version: '1.6.0',
        enabled: true,
        versions: [{ version: '1.6.0', pinned: true, receipt: 'not_checked' }],
      },
    });
    const checked = await cli(['connectors', 'check', 'link', '--json']);
    expect(checked.code).toBe(0);
    expectResultContract('connectors check link', checked.result);
    expect(checked.result?.data).toMatchObject({
      readiness: { status: 'ready', checked: true },
      details: { versions: [{ version: '1.6.0', receipt: 'verified' }] },
    });

    await appendFile(
      path.join(paths.configRoot, 'connectors/link/1.6.0/node_modules/@stripe/link-cli/dist/cli.js'),
      'x',
    );

    expect((await cli(['connectors', 'show', 'link', '--json'])).result?.data).toMatchObject({
      details: { versions: [{ receipt: 'not_checked' }] },
    });
    const failed = await cli(['connectors', 'check', 'link', '--json']);
    expect(failed.code).toBe(1);
    expectResultContract('connectors check link', failed.result);
    expect(failed.result).toMatchObject({
      data: { details: { versions: [{ receipt: 'invalid' }] } },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'link'] }],
    });
  });

  it('disconnects a running assistant and leaves a stopped one to its next start, then removes the install', async () => {
    const running = await assistant();
    const stopped = await assistant();
    await installLink(paths, { upsertEnvVars });
    let enabledWhenAsked: boolean | undefined;
    hostNcl.mockImplementation(async () => {
      const state = await readCatalogPolicy(policyFile);
      enabledWhenAsked = state.status === 'read' ? state.policy.link?.enabled : undefined;
      return confirmed('link');
    });

    const { code, result } = await cli(['connectors', 'uninstall', 'link', '--json'], {
      serviceHelpers: services([stopped]),
    });

    expect(code).toBe(0);
    expectResultContract('connectors uninstall link', result);
    expect(hostNcl.mock.calls).toEqual([[expect.objectContaining({ instance_id: running.instance_id }), RETIRE_LINK]]);
    expect(enabledWhenAsked).toBe(false);
    expect(result?.data).toMatchObject({
      name: 'link',
      enabled: false,
      outcome: 'removed',
      assistants: expect.arrayContaining([
        expect.objectContaining({ instance_id: running.instance_id, outcome: 'retired', retired: 1, remaining: 0 }),
        expect.objectContaining({ instance_id: stopped.instance_id, outcome: 'stopped' }),
      ]),
    });
    expect(await exists(path.join(paths.configRoot, 'connectors', 'link'))).toBe(false);
    expect(await readCatalogPolicy(policyFile)).toEqual({
      status: 'read',
      policy: { schemaVersion: 1, link: null, shop: null },
    });
  });

  it('keeps the install and says how to finish while a running assistant has not confirmed', async () => {
    const first = await assistant();
    const second = await assistant();
    await installLink(paths, { upsertEnvVars });
    hostNcl.mockImplementation(async (runtime) => {
      if (runtime.instance_id === second.instance_id)
        throw new GwsEaError('ncl_failed', 'The assistant did not answer.');
      return confirmed('link');
    });

    const pending = await cli(['connectors', 'uninstall', 'link', '--json'], { serviceHelpers: services() });

    expect(pending.code).toBe(10);
    expectResultContract('connectors uninstall link', pending.result);
    const data = pending.result?.data as { reason: string; assistants: { instance_id: string; message: string }[] };
    expect(pending.result).toMatchObject({
      outcome: 'paused',
      data: { outcome: 'pending' },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', 'link'] }],
    });
    expect(data.reason).toContain(second.instance_id);
    expect(data.reason).not.toContain(first.instance_id);
    expect(data.assistants.find((entry) => entry.instance_id === second.instance_id)?.message).toContain(
      'gws-ea connectors uninstall link',
    );
    await expect(
      verifyHostCliReceipt(path.join(paths.configRoot, 'connectors/link/1.6.0'), PINNED),
    ).resolves.toBeDefined();
    const disabled = await readCatalogPolicy(policyFile);
    expect(disabled).toMatchObject({ status: 'read', policy: { link: { enabled: false } } });
    expect(operatorEnabled(LINK, disabled)).toBe(false);
    expect((await cli(['connectors', 'show', 'link', '--json'])).result).toMatchObject({
      data: { setup: 'uninstall_incomplete' },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'uninstall', 'link'] }],
    });

    hostNcl.mockImplementation(async () => confirmed('link', 0));
    expect((await cli(['connectors', 'uninstall', 'link', '--json'], { serviceHelpers: services() })).code).toBe(0);
    expect(await exists(path.join(paths.configRoot, 'connectors', 'link'))).toBe(false);
  });

  it('reports a retry as a change only when an assistant confirms it disconnected Link', async () => {
    const answering = await assistant();
    const silent = await assistant();
    await installLink(paths, { upsertEnvVars });
    let retired: number | undefined;
    hostNcl.mockImplementation(async (runtime) => {
      if (runtime.instance_id === silent.instance_id || retired === undefined)
        throw new GwsEaError('ncl_failed', 'The assistant did not answer.');
      return confirmed('link', retired);
    });
    const uninstall = () => cli(['connectors', 'uninstall', 'link', '--json'], { serviceHelpers: services() });
    expect((await uninstall()).result).toMatchObject({ outcome: 'paused', changed: true });

    retired = 1;
    const disconnected = await uninstall();
    expect(disconnected.result).toMatchObject({ outcome: 'paused', changed: true });
    expect((disconnected.result?.data as { assistants: CatalogRetirement[] }).assistants).toContainEqual(
      expect.objectContaining({ instance_id: answering.instance_id, outcome: 'retired', retired: 1 }),
    );

    retired = 0;
    expect((await uninstall()).result).toMatchObject({ outcome: 'paused', changed: false });
  });
});

describe('Shop connector', () => {
  const REDIRECT = 'https://aya.example.test/connections/callback/mcp.shop.com';
  const ALLOW = `Allow ${REDIRECT} as a redirect URL of your Shopify client in the Shopify Dev Dashboard.`;
  const shopRoot = () => path.join(paths.configRoot, 'connectors', 'shop');

  async function recordedShop() {
    const state = await readCatalogPolicy(policyFile);
    if (state.status !== 'read' || !state.policy.shop) throw new Error('Shop is not recorded');
    return state.policy.shop;
  }

  async function secretSource(secret: string): Promise<string> {
    const source = path.join(paths.configRoot, `shop-secret-${randomUUID()}`);
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, `${secret}\n`, { mode: 0o600 });
    return source;
  }

  function installShop(clientId: string, source?: string) {
    return cli([
      'connectors',
      'install',
      'shop',
      '--client-id',
      clientId,
      ...(source ? ['--client-secret-file', source] : []),
      '--json',
    ]);
  }

  it('refuses to register without a client ID', async () => {
    const { code, result } = await cli(['connectors', 'install', 'shop', '--json']);
    expect(code).toBe(2);
    expectResultContract('connectors install shop', result);
    expect(result).toMatchObject({ error: { code: 'invalid_arguments' } });
    expect(await exists(policyFile)).toBe(false);
  });

  it('records the client, stores its secret privately and lists each assistant’s redirect URL to allow', async () => {
    const served = await assistant('aya.example.test');
    const unserved = await assistant();
    const secret = 'shop-client-secret-sentinel';
    const source = path.join(paths.configRoot, 'shop-secret');
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, `${secret}\n`, { mode: 0o600 });

    const installed = await cli([
      'connectors',
      'install',
      'shop',
      '--client-id',
      'gws-ea-shop-client',
      '--client-secret-file',
      source,
      '--json',
    ]);

    expect(installed.code).toBe(0);
    expectResultContract('connectors install shop', installed.result);
    expect(installed.result).toMatchObject({
      data: { client_id: 'gws-ea-shop-client', client_secret: true, operator_actions: [ALLOW] },
      next_actions: expect.arrayContaining([{ kind: 'external', instruction: ALLOW }]),
    });
    const stored = (await recordedShop()).clientSecretFile!;
    expect(await readCatalogPolicy(policyFile)).toEqual({
      status: 'read',
      policy: { schemaVersion: 1, link: null, shop: { clientId: 'gws-ea-shop-client', clientSecretFile: stored } },
    });
    expect(path.dirname(stored)).toBe(shopRoot());
    expect(await readFile(stored, 'utf8')).toBe(secret);
    expect((await stat(stored)).mode & 0o777).toBe(0o600);
    for (const runtime of [served, unserved])
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
        `GWS_EA_CATALOG_POLICY_FILE=${policyFile}\n`,
      );

    const shown = await cli(['connectors', 'show', 'shop', '--json']);
    expectResultContract('connectors show shop', shown.result);
    expect(shown.result?.data).toMatchObject({
      setup: 'installed',
      details: {
        client_id: 'gws-ea-shop-client',
        client_secret: true,
        assistants: expect.arrayContaining([
          { instance_id: served.instance_id, redirect_uri: REDIRECT },
          { instance_id: unserved.instance_id, redirect_uri: null },
        ]),
      },
    });
    const human = await cli(['connectors', 'show', 'shop']);
    expect(human.output.join('\n')).toContain(REDIRECT);
    const checked = await cli(['connectors', 'check', 'shop', '--id', served.instance_id, '--json']);
    expectResultContract('connectors check shop', checked.result);
    expect(checked.result?.data).toMatchObject({ readiness: { status: 'ready' } });

    expect([...installed.output, ...shown.output, ...human.output].join('\n')).not.toContain(secret);
    for (const file of await readdir(paths.logsRoot, { recursive: true })) {
      const full = path.join(paths.logsRoot, file);
      if ((await stat(full)).isFile()) expect(await readFile(full, 'utf8')).not.toContain(secret);
    }
  });

  it('tells a new assistant’s operator which redirect URL to allow, and says nothing on later starts', async () => {
    const runtime = await assistant('aya.example.test');
    expect((await cli(['connectors', 'install', 'shop', '--client-id', 'gws-ea-shop-client', '--json'])).code).toBe(0);

    const created = await withInstanceOperation(paths, runtime.instance_id, (operation) =>
      provisionInstalledConnectors(operation, {}, {}, { created: true }),
    );
    const started = await withInstanceOperation(paths, runtime.instance_id, (operation) =>
      provisionInstalledConnectors(operation, {}),
    );

    expect(created?.pending).toEqual([
      { name: 'shop', reason: 'shop_redirect_to_allow', message: expect.stringContaining(REDIRECT) },
    ]);
    expect(created?.next_actions).toEqual([{ kind: 'external', instruction: ALLOW }]);
    expect(started).toEqual({ pending: [], next_actions: [] });
    expect(pnpm.calls).toEqual([]);
  });

  it.each([
    ['empty', '\n'],
    ['holding whitespace inside the secret', 'shop-client secret-sentinel\n'],
  ])('refuses a secret file that is %s and leaves the recorded client as it was', async (_case, contents) => {
    expect((await cli(['connectors', 'install', 'shop', '--client-id', 'gws-ea-shop-client', '--json'])).code).toBe(0);
    const before = await readFile(policyFile, 'utf8');
    const source = path.join(paths.configRoot, 'shop-secret');
    await writeFile(source, contents, { mode: 0o600 });

    const { code, result } = await cli([
      'connectors',
      'install',
      'shop',
      '--client-id',
      'gws-ea-shop-client-next',
      '--client-secret-file',
      source,
      '--json',
    ]);

    expect(code).not.toBe(0);
    expect(result).toMatchObject({ error: { code: 'shop_client_secret_invalid' } });
    expect(await readFile(policyFile, 'utf8')).toBe(before);
    expect(await readdir(shopRoot())).toEqual([]);
  });

  it('publishes a replacement client and its secret together, keeping the old pair when publishing fails', async () => {
    expect((await installShop('gws-ea-shop-client', await secretSource('first-secret-sentinel'))).code).toBe(0);
    const first = await recordedShop();
    const before = await readFile(policyFile, 'utf8');
    const replacement = await secretSource('second-secret-sentinel');

    policyWrites.fail = 'before';
    expect((await installShop('gws-ea-shop-client-next', replacement)).code).not.toBe(0);
    expect(await readFile(policyFile, 'utf8')).toBe(before);
    expect(await readFile(first.clientSecretFile!, 'utf8')).toBe('first-secret-sentinel');
    expect(await readdir(shopRoot())).toEqual([path.basename(first.clientSecretFile!)]);

    policyWrites.fail = false;
    expect((await installShop('gws-ea-shop-client-next', replacement)).code).toBe(0);
    const second = await recordedShop();
    expect(second.clientId).toBe('gws-ea-shop-client-next');
    expect(second.clientSecretFile).not.toBe(first.clientSecretFile);
    expect(await readFile(second.clientSecretFile!, 'utf8')).toBe('second-secret-sentinel');
    expect((await stat(second.clientSecretFile!)).mode & 0o777).toBe(0o600);
    expect(await readdir(shopRoot())).toEqual([path.basename(second.clientSecretFile!)]);
  });

  it('keeps the new secret when its policy landed before the write reported failure', async () => {
    expect((await installShop('gws-ea-shop-client', await secretSource('first-secret-sentinel'))).code).toBe(0);

    policyWrites.fail = 'after';
    expect((await installShop('gws-ea-shop-client-next', await secretSource('second-secret-sentinel'))).code).not.toBe(
      0,
    );
    const published = await recordedShop();
    expect(published.clientId).toBe('gws-ea-shop-client-next');
    expect(await readFile(published.clientSecretFile!, 'utf8')).toBe('second-secret-sentinel');
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['holding whitespace inside the secret', 'shop-client secret-sentinel'],
  ])(
    'treats a stored secret that is %s as unusable on check and names the reinstall to run',
    async (_case, contents) => {
      expect((await installShop('gws-ea-shop-client', await secretSource('shop-client-secret-sentinel'))).code).toBe(0);
      const stored = (await recordedShop()).clientSecretFile!;
      if (contents === null) await rm(stored);
      else await writeFile(stored, contents, { mode: 0o600 });

      const checked = await cli(['connectors', 'check', 'shop', '--json']);

      expect(checked.code).toBe(1);
      expectResultContract('connectors check shop', checked.result);
      const data = checked.result?.data as { readiness: { status: string }; reasons: string[] };
      expect(data.readiness.status).toBe('not_ready');
      expect(data.reasons.join('\n')).toContain('stored Shop client secret');
      const actions = checked.result?.next_actions as { kind: string; instruction?: string }[];
      expect(actions).toContainEqual({
        kind: 'external',
        instruction: expect.stringContaining(
          'gws-ea connectors install shop --client-id gws-ea-shop-client --client-secret-file ',
        ),
      });
      expect(checked.output.join('\n')).not.toContain('secret-sentinel');
    },
  );

  it('removes the stored secret when Shop is installed again with a client ID only', async () => {
    const source = path.join(paths.configRoot, 'shop-secret');
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, 'shop-client-secret-sentinel', { mode: 0o600 });
    await cli(['connectors', 'install', 'shop', '--client-id', 'gws-ea-shop-client', '--client-secret-file', source]);
    const stored = (await recordedShop()).clientSecretFile!;
    expect(await exists(stored)).toBe(true);

    const { code, result } = await cli([
      'connectors',
      'install',
      'shop',
      '--client-id',
      'gws-ea-public-client',
      '--json',
    ]);

    expect(code).toBe(0);
    expect(result?.data).toMatchObject({ client_id: 'gws-ea-public-client', client_secret: false });
    expect(await readCatalogPolicy(policyFile)).toEqual({
      status: 'read',
      policy: { schemaVersion: 1, link: null, shop: { clientId: 'gws-ea-public-client', clientSecretFile: null } },
    });
    expect(await readdir(shopRoot())).toEqual([]);
  });

  it('disconnects Shop on running assistants before removing the stored secret', async () => {
    await assistant('aya.example.test');
    const source = path.join(paths.configRoot, 'shop-secret');
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    await writeFile(source, 'shop-client-secret-sentinel', { mode: 0o600 });
    await cli(['connectors', 'install', 'shop', '--client-id', 'gws-ea-shop-client', '--client-secret-file', source]);
    hostNcl.mockImplementation(async () => confirmed('shop'));

    const { code, result } = await cli(['connectors', 'uninstall', 'shop', '--json'], { serviceHelpers: services() });

    expect(code).toBe(0);
    expectResultContract('connectors uninstall shop', result);
    expect(hostNcl.mock.calls.map(([, args]) => args)).toEqual([
      ['gws-ea-connections-catalog-retire', '--entry', 'shop'],
    ]);
    expect(result?.data).toMatchObject({ name: 'shop', registered: false, outcome: 'removed' });
    expect(await exists(path.join(paths.configRoot, 'connectors', 'shop'))).toBe(false);
    expect(await readCatalogPolicy(policyFile)).toMatchObject({ status: 'read', policy: { shop: null } });
  });
});
