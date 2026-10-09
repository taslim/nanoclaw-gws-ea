/**
 * The OneCLI admin client against a real OneCLI (KTD14). It runs Docker, so
 * it is opt-in: with `GWS_EA_ONECLI_CONTRACT=1` it brings up a throwaway
 * OneCLI at the pinned gateway version the way gws-ea brings up an
 * assistant's (its own layout, Compose file, and reconcile, with the
 * isolation probe, which needs public egress), under a temp root with a
 * unique Compose project and free ports. It exercises exactly the calls
 * gws-ea makes, then tears the project down, volumes included, and removes
 * the gateway image only when it built it.
 *
 *   GWS_EA_ONECLI_CONTRACT=1 pnpm exec vitest run src/gws-ea/onecli-admin.contract.test.ts
 *
 * Moving the gateway pin needs a passing run against the new version, then
 * that version recorded as `VERIFIED_ONECLI_GATEWAY`; the guard below fails
 * until it is.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findCredentialSecret,
  importProviderCredential,
  persistOnecliApiKeyFiles,
  reconcileOnecliRuntime,
  removeOnecliRuntime,
  type OnecliRuntimeReceipt,
} from './onecli.js';
import { createOnecliAdmin, fetchOnecliApiKey, type OnecliAdmin } from './onecli-admin.js';
import { createOnecliRuntimeLayout, type OnecliRuntimeLayout } from './onecli-compose.js';
import { resolveWrapperGatewayImage } from './onecli-gateway-image.js';
import { ONECLI_GATEWAY_VERSION } from './pins.js';
import { resolveDockerEndpoint } from './prerequisites.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandResult } from './process.js';

/** The OneCLI gateway version this contract last passed against. */
const VERIFIED_ONECLI_GATEWAY = '1.42.0';

const CONTRACT = process.env.GWS_EA_ONECLI_CONTRACT === '1';
/** Pulling, building, and starting a cold OneCLI, as an assistant's create does. */
const START_TIMEOUT_MS = 30 * 60_000;
const TEARDOWN_TIMEOUT_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

const PINS = { gateway: ONECLI_GATEWAY_VERSION } as const;

describe('the OneCLI gateway pin', () => {
  it('is the version the OneCLI contract last passed against', () => {
    expect(
      ONECLI_GATEWAY_VERSION,
      `Run GWS_EA_ONECLI_CONTRACT=1 pnpm exec vitest run src/gws-ea/onecli-admin.contract.test.ts against OneCLI ${ONECLI_GATEWAY_VERSION}, then record it as VERIFIED_ONECLI_GATEWAY`,
    ).toBe(VERIFIED_ONECLI_GATEWAY);
  });
});

/** Two distinct loopback ports nothing listens on, each held until both are chosen. */
async function freePorts(): Promise<readonly [number, number]> {
  const listen = (): Promise<Server> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  const servers = [await listen(), await listen()];
  const ports = servers.map((server) => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('A loopback listener has no port');
    return address.port;
  });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  return [ports[0]!, ports[1]!];
}

describe.runIf(CONTRACT)(`the OneCLI admin client against OneCLI ${ONECLI_GATEWAY_VERSION}`, () => {
  let root: string | undefined;
  let layout: OnecliRuntimeLayout | undefined;
  let docker: ((args: readonly string[]) => Promise<SanitizedCommandResult>) | undefined;
  /** The wrapper gateway image, when this run built it rather than found it. */
  let builtGateway: string | undefined;
  let receipt: OnecliRuntimeReceipt;
  let admin: OnecliAdmin;
  let apiKey: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-contract-'));
    const dockerEndpoint = await resolveDockerEndpoint();
    const [appPort, gatewayPort] = await freePorts();
    layout = createOnecliRuntimeLayout({
      instanceId: randomUUID(),
      instanceRoot: root,
      project: `gws-ea-contract-${randomBytes(4).toString('hex')}`,
      appPort,
      gatewayPort,
      dockerEndpoint,
    });
    const cwd = root;
    docker = (args) =>
      runSanitizedCommand({
        command: 'docker',
        args,
        cwd,
        env: buildToolEnvironment(process.env, { DOCKER_HOST: dockerEndpoint }),
        timeoutMs: CALL_TIMEOUT_MS,
      });
    const { image } = await resolveWrapperGatewayImage(PINS);
    if ((await docker(['image', 'ls', '--quiet', image])).stdout.trim() === '') builtGateway = image;

    receipt = await reconcileOnecliRuntime(layout, PINS);
    apiKey = await fetchOnecliApiKey(layout.appUrl);
    admin = createOnecliAdmin(layout.appUrl, apiKey);
  }, START_TIMEOUT_MS);

  // A teardown that fails keeps the temp root, whose Compose file names what is left to remove.
  afterAll(async () => {
    if (layout) await removeOnecliRuntime(layout);
    if (builtGateway && docker && (await docker(['image', 'ls', '--quiet', builtGateway])).stdout.trim() !== '') {
      await docker(['image', 'rm', builtGateway]);
    }
    if (root) await rm(root, { recursive: true, force: true });
  }, TEARDOWN_TIMEOUT_MS);

  it(
    'hands a keyless loopback caller one local API key, the same on every read and the one its check holds',
    async () => {
      expect(await fetchOnecliApiKey(layout!.appUrl)).toBe(apiKey);
      const files = { runtime: path.join(root!, 'runtime-api-key'), admin: path.join(root!, 'admin-api-key') };
      await persistOnecliApiKeyFiles(receipt, files);
      expect(await readFile(files.admin, 'utf8')).toBe(apiKey);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'stores an anthropic secret from the request body, lists it without its value, and finds it again',
    async () => {
      const credential = {
        name: 'Anthropic',
        type: 'anthropic',
        value: `sk-ant-api03-contract-${'0'.repeat(80)}`,
        hostPattern: 'api.anthropic.com',
      };

      const created = await importProviderCredential(receipt, credential);
      const again = await importProviderCredential(receipt, credential);

      expect(created).toMatchObject({ created: true });
      expect(again).toEqual({ id: created.id, created: false });
      const secrets = await admin.listSecrets();
      expect(JSON.stringify(secrets)).not.toContain(credential.value);
      expect(findCredentialSecret(secrets, credential, { ambiguous: 'ambiguous', conflict: 'conflict' })).toMatchObject(
        {
          id: created.id,
        },
      );
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'stores a header secret given no format with its default, which matches the metadata that named none',
    async () => {
      const credential = {
        name: 'Contract search',
        type: 'generic',
        value: 'contract-search-value',
        hostPattern: 'api.search.example.test',
        headerName: 'x-api-key',
      };

      const created = await importProviderCredential(receipt, credential);

      expect(created).toMatchObject({ created: true });
      const stored = (await admin.listSecrets()).find((secret) => secret.id === created.id);
      expect(stored).toMatchObject({ injectionConfig: { headerName: 'x-api-key', valueFormat: '{value}' } });
      await expect(importProviderCredential(receipt, credential)).resolves.toEqual({
        id: created.id,
        created: false,
      });
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "creates an agent in all secret mode, answers 409 to a second create, and sets the agent's secret mode",
    async () => {
      const identifier = `ag-${randomUUID()}`;
      await admin.createAgent({ name: 'main', identifier });
      const second = await fetch(new URL('/v1/agents', layout!.appUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'main', identifier }),
        redirect: 'error',
      });
      expect(second.status).toBe(409);
      await expect(admin.createAgent({ name: 'main', identifier })).resolves.toBeUndefined();

      const agents = (await admin.listAgents()).filter((agent) => agent.identifier === identifier);
      expect(agents).toEqual([{ id: expect.any(String), identifier, name: 'main', secretMode: 'all' }]);
      const [agent] = agents;
      await admin.setSecretMode(agent!.id, 'selective');
      expect((await admin.listAgents()).find((listed) => listed.id === agent!.id)?.secretMode).toBe('selective');
      await admin.setSecretMode(agent!.id, 'all');
      expect((await admin.listAgents()).find((listed) => listed.id === agent!.id)?.secretMode).toBe('all');
    },
    CALL_TIMEOUT_MS,
  );
});
