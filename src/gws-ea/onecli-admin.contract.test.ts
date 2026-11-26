/**
 * The OneCLI admin client against a real OneCLI. It runs Docker, so
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
  createProviderCredentialConnection,
  listOneCliCredentialsForHost,
  removeOneCliCredentialsById,
} from '../gateway-providers/onecli-credentials.js';
import {
  backupOnecliDatabase,
  findCredentialSecret,
  importProviderCredential,
  persistOnecliApiKeyFiles,
  prepareReleaseGatewayImage,
  reconcileOnecliRuntime,
  removeOnecliRuntime,
  restoreOnecliDatabase,
  restoreReleaseGateway,
  verifyOnecliGrantConversion,
  type OnecliRuntimeReceipt,
} from './onecli.js';
import { createOnecliAdmin, fetchOnecliApiKey, type OnecliAdmin } from './onecli-admin.js';
import { createOnecliRuntimeLayout, renderOnecliCompose, type OnecliRuntimeLayout } from './onecli-compose.js';
import { resolveWrapperGatewayImage } from './onecli-gateway-image.js';
import { ONECLI_GATEWAY_VERSION } from './pins.js';
import { resolveDockerEndpoint } from './prerequisites.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandResult } from './process.js';

/** The OneCLI gateway version this contract last passed against. */
const VERIFIED_ONECLI_GATEWAY = '1.45.0';

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
    'creates an agent with zero grants, answers 409 on duplicate, attaches/detaches grants, and returns 410 on legacy endpoints',
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
      expect(agents).toHaveLength(1);
      const [agent] = agents;
      expect(agent).toMatchObject({ id: expect.any(String), identifier, name: 'main' });
      expect(agent!.secretMode).not.toBe('all');

      expect(await admin.listAgentSecretGrants(agent!.id)).toEqual([]);

      const secrets = await admin.listSecrets();
      const [firstSecret, secondSecret] = secrets.map((s) => s.id as string);
      expect(firstSecret).toBeTruthy();
      expect(secondSecret).toBeTruthy();

      await admin.attachAgentSecretGrant(agent!.id, firstSecret!);
      await admin.attachAgentSecretGrant(agent!.id, secondSecret!);
      expect((await admin.listAgentSecretGrants(agent!.id)).slice().sort()).toEqual(
        [firstSecret!, secondSecret!].sort(),
      );

      await admin.detachAgentSecretGrant(agent!.id, secondSecret!);
      expect(await admin.listAgentSecretGrants(agent!.id)).toEqual([firstSecret!]);

      const legacy = await fetch(new URL(`/v1/agents/${encodeURIComponent(agent!.id)}/secret-mode`, layout!.appUrl), {
        method: 'PATCH',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'all' }),
        redirect: 'error',
      });
      expect(legacy.status).toBe(410);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "limits a runtime credential to its path, lists one host's secrets exactly, and removes them by ID",
    async () => {
      const management = { url: layout!.appUrl, apiKey };
      const host = 'mcp.contract.example.test';
      const app = createProviderCredentialConnection(
        {
          kind: 'api-key',
          name: 'gws-ea-app-contract',
          host,
          path: '/mcp',
          proxyValue: 'gateway-managed',
          injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
        },
        management,
      );
      expect(await app.find()).toBeNull();
      await app.save('contract-app-token');
      const operator = await admin.createSecret({
        name: 'Contract operator',
        type: 'generic',
        value: 'contract-operator-value',
        hostPattern: host,
        headerName: 'x-api-key',
      });
      const elsewhere = await admin.createSecret({
        name: 'Contract elsewhere',
        type: 'generic',
        value: 'contract-elsewhere-value',
        hostPattern: `other.${host}`,
        headerName: 'x-api-key',
      });

      const stored = (await admin.listSecrets()).find((secret) => secret.name === 'gws-ea-app-contract');
      expect(stored).toMatchObject({ hostPattern: host, pathPattern: '/mcp' });
      expect(await app.find()).toEqual({ reusable: true });
      const listed = await listOneCliCredentialsForHost(host, management);
      expect(listed).toHaveLength(2);
      expect(listed).toEqual(
        expect.arrayContaining([
          { id: stored!.id, name: 'gws-ea-app-contract' },
          { id: operator, name: 'Contract operator' },
        ]),
      );

      expect(
        await removeOneCliCredentialsById([...listed.map(({ id }) => id), 'contract-missing'], management),
      ).toEqual([...listed.map(({ id }) => ({ id, outcome: 'removed' })), { id: 'contract-missing', outcome: 'gone' }]);
      expect(await listOneCliCredentialsForHost(host, management)).toEqual([]);
      expect((await admin.listSecrets()).some((secret) => secret.id === elsewhere)).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );
});

describe.runIf(CONTRACT)('OneCLI 1.42.0 -> 1.45.0 -> 1.42.0 upgrade and rollback contract', () => {
  it(
    'backs up 1.42.0 Postgres, upgrades to 1.45.0 with verified grant conversion, and rolls back cleanly to 1.42.0',
    async () => {
      const fromPins = { gateway: '1.42.0' } as const;
      const toPins = { gateway: ONECLI_GATEWAY_VERSION } as const;
      const upgradeRoot = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onecli-upgrade-contract-'));
      const dockerEndpoint = await resolveDockerEndpoint();
      const [appPort, gatewayPort] = await freePorts();
      const upgradeLayout = createOnecliRuntimeLayout({
        instanceId: randomUUID(),
        instanceRoot: upgradeRoot,
        project: `gws-ea-upg-${randomBytes(4).toString('hex')}`,
        appPort,
        gatewayPort,
        dockerEndpoint,
      });
      const docker = (args: readonly string[]) =>
        runSanitizedCommand({
          command: 'docker',
          args,
          cwd: upgradeRoot,
          env: buildToolEnvironment(process.env, { DOCKER_HOST: dockerEndpoint }),
          timeoutMs: CALL_TIMEOUT_MS,
        });
      const wrapper142 = await resolveWrapperGatewayImage(fromPins);
      const wrapper145 = await resolveWrapperGatewayImage(toPins);
      const built142 = (await docker(['image', 'ls', '--quiet', wrapper142.image])).stdout.trim() === '';
      const built145 = (await docker(['image', 'ls', '--quiet', wrapper145.image])).stdout.trim() === '';

      try {
        // 1. Bring up a real 1.42.0 OneCLI stack with main (all) and browser (selective, model-only).
        const receipt142 = await reconcileOnecliRuntime(upgradeLayout, fromPins);
        const key142 = await fetchOnecliApiKey(upgradeLayout.appUrl);
        const admin142 = createOnecliAdmin(upgradeLayout.appUrl, key142);

        const model = await importProviderCredential(receipt142, {
          name: 'Anthropic',
          type: 'anthropic',
          value: `sk-ant-api03-upgrade-${'0'.repeat(80)}`,
          hostPattern: 'api.anthropic.com',
        });
        const gcal = await admin142.createSecret({
          name: 'google-calendar',
          type: 'generic',
          value: 'ya29-upgrade-calendar-token',
          hostPattern: 'www.googleapis.com',
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        });
        const opMcp = await admin142.createSecret({
          name: 'Operator MCP',
          type: 'generic',
          value: 'op-mcp-secret-value',
          hostPattern: 'mcp.operator.example.test',
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        });

        const mainGroup = `ag-main-${randomUUID().slice(0, 8)}`;
        const browserGroup = `ag-browser-${randomUUID().slice(0, 8)}`;
        await admin142.createAgent({ name: 'main', identifier: mainGroup });
        await admin142.createAgent({ name: 'browser', identifier: browserGroup });
        const agents142 = await admin142.listAgents();
        const mainAgent = agents142.find((agent) => agent.identifier === mainGroup)!;
        const browserAgent = agents142.find((agent) => agent.identifier === browserGroup)!;
        expect(mainAgent.secretMode).toBe('all');

        // Configure browser as selective + model-only using legacy 1.42 routes.
        const setMode = await fetch(
          new URL(`/v1/agents/${encodeURIComponent(browserAgent.id)}/secret-mode`, upgradeLayout.appUrl),
          {
            method: 'PATCH',
            headers: { authorization: `Bearer ${key142}`, 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'selective' }),
          },
        );
        expect(setMode.ok).toBe(true);
        const setSecrets = await fetch(
          new URL(`/v1/agents/${encodeURIComponent(browserAgent.id)}/secrets`, upgradeLayout.appUrl),
          {
            method: 'PUT',
            headers: { authorization: `Bearer ${key142}`, 'content-type': 'application/json' },
            body: JSON.stringify({ secretIds: [model.id] }),
          },
        );
        expect(setSecrets.ok).toBe(true);

        // 2. Stage the 1.45.0 image while 1.42.0 serves, then take a fenced Postgres backup.
        const change = await prepareReleaseGatewayImage(upgradeLayout, { from: fromPins, to: toPins });
        expect(change).toEqual({
          current: wrapper142.image,
          release: wrapper145.image,
          currentVersion: fromPins.gateway,
          releaseVersion: toPins.gateway,
        });
        const backupFile = path.join(upgradeRoot, 'onecli-db-142.sql');
        await backupOnecliDatabase(upgradeLayout, backupFile);

        // 3. Upgrade to 1.45.0 via restoreReleaseGateway (isolation + [grant-conversion] gate).
        const compose142 = renderOnecliCompose(upgradeLayout, fromPins, wrapper142.image);
        const compose145 = renderOnecliCompose(upgradeLayout, toPins, wrapper145.image);
        await restoreReleaseGateway(upgradeLayout, toPins, { compose: compose145, left: compose142 });
        await verifyOnecliGrantConversion(upgradeLayout);

        const admin145 = createOnecliAdmin(upgradeLayout.appUrl, key142);
        const agents145 = await admin145.listAgents();
        expect(agents145.every((agent) => agent.secretMode !== 'all')).toBe(true);
        expect((await admin145.listAgentSecretGrants(mainAgent.id)).slice().sort()).toEqual(
          [model.id, gcal, opMcp].sort(),
        );
        expect(await admin145.listAgentSecretGrants(browserAgent.id)).toEqual([model.id]);

        // Mutate 1.45.0 so rollback visibly restores pre-upgrade state.
        const postUpgradeSecret = await admin145.createSecret({
          name: 'Post-upgrade secret',
          type: 'generic',
          value: 'post-upgrade-value',
          hostPattern: 'post.upgrade.example.test',
          headerName: 'x-api-key',
        });
        await admin145.attachAgentSecretGrant(mainAgent.id, postUpgradeSecret);

        // 4. Roll back Postgres from the 1.42.0 backup and restore 1.42.0 Compose.
        await restoreOnecliDatabase(upgradeLayout, backupFile);
        await restoreReleaseGateway(upgradeLayout, fromPins, { compose: compose142, left: compose145 });

        const secretsBack = await admin142.listSecrets();
        expect(secretsBack.map((secret) => secret.id)).toEqual(expect.arrayContaining([model.id, gcal, opMcp]));
        expect(secretsBack.some((secret) => secret.id === postUpgradeSecret)).toBe(false);
        const agentsBack = await admin142.listAgents();
        expect(agentsBack.find((agent) => agent.id === mainAgent.id)?.secretMode).toBe('all');
        expect(agentsBack.find((agent) => agent.id === browserAgent.id)?.secretMode).toBe('selective');
      } finally {
        await removeOnecliRuntime(upgradeLayout);
        if (built142 && (await docker(['image', 'ls', '--quiet', wrapper142.image])).stdout.trim() !== '') {
          await docker(['image', 'rm', wrapper142.image]);
        }
        if (built145 && (await docker(['image', 'ls', '--quiet', wrapper145.image])).stdout.trim() !== '') {
          await docker(['image', 'rm', wrapper145.image]);
        }
        await rm(upgradeRoot, { recursive: true, force: true });
      }
    },
    START_TIMEOUT_MS,
  );
});
