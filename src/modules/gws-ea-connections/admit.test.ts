import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayHostCredential } from '../../gateway-providers/credential-connection.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';
import {
  admitAppUrl,
  appCredentialName,
  assistantProtectedHosts,
  type AdmissionDependencies,
  type AdmissionRefusal,
} from './admit.js';
import type { OperatorServer } from './apply.js';

const WEB_HOST = 'juno.example.test';
const ROOT = path.join(fs.realpathSync(tmpdir()), `gws-ea-connections-admit-${process.pid}`);
const policy: WebPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: WEB_HOST,
  listenPort: 9123,
  accessIssuer: 'https://team.cloudflareaccess.com',
  accessAud: 'assistant-aud',
  cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: '/private/tmp/operator.json' },
};

let apps: Map<string, string>;
let operators: OperatorServer[];
let secrets: Map<string, GatewayHostCredential[]>;
let gatewayLists: boolean;
let listed: string[];

function dependencies(): AdmissionDependencies {
  return {
    appByHost: async (host) => {
      const id = apps.get(host);
      return id === undefined ? undefined : { id };
    },
    operatorServers: async () => operators,
    gatewayCredentials: gatewayLists
      ? async (host) => {
          listed.push(host);
          return secrets.get(host) ?? [];
        }
      : undefined,
    protectedHosts: assistantProtectedHosts,
  };
}

async function refusal(url: string, appId?: string): Promise<AdmissionRefusal | undefined> {
  const admission = await admitAppUrl(url, dependencies(), { appId });
  return admission.admitted ? undefined : admission.reason;
}

beforeEach(() => {
  apps = new Map();
  operators = [];
  secrets = new Map();
  gatewayLists = true;
  listed = [];
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { mode: 0o700 });
  const file = path.join(ROOT, 'web-policy.json');
  fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', file);
  vi.stubEnv('ONECLI_URL', 'http://gateway.example.test:10254');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('admitAppUrl', () => {
  it('admits a free https host and returns its canonical URL and host', async () => {
    const admission = await admitAppUrl('https://Mcp.Ledger.Example.test/mcp', dependencies());
    expect(admission).toEqual({
      admitted: true,
      url: 'https://mcp.ledger.example.test/mcp',
      host: 'mcp.ledger.example.test',
    });
  });

  it.each([
    ['https://example.test/mcp?api_key=sentinel', 'credentials_in_url'],
    ['https://example.test/mcp?', 'credentials_in_url'],
    ['https://morgan:hunter2@example.test/mcp', 'credentials_in_url'],
    ['http://example.test/mcp', 'not_https'],
    ['not a url', 'invalid_url'],
    ['https://example.test:8443/mcp', 'invalid_url'],
    ['https://example.test/mcp#tools', 'invalid_url'],
    ['https://example.test./mcp', 'invalid_url'],
    ['https://203.0.113.9/mcp', 'invalid_url'],
    ['https://example.test/m%20cp', 'invalid_url'],
    ['https://example.test/mcp;v=1', 'invalid_url'],
    ['https://link.host-cli.invalid/', 'invalid_url'],
    ['https://Host-CLI.invalid/mcp', 'invalid_url'],
  ] as const)('refuses %s as %s without asking the gateway', async (url, reason) => {
    expect(await refusal(url)).toBe(reason);
    expect(listed).toEqual([]);
  });

  it("admits a catalog app's host entered as an address", async () => {
    expect(await admitAppUrl('https://mcp.notion.com/sse', dependencies())).toEqual({
      admitted: true,
      url: 'https://mcp.notion.com/sse',
      host: 'mcp.notion.com',
    });
  });

  it('refuses the host of an operator http entry', async () => {
    operators = [{ key: 'ledgerly', url: 'https://app.ledgerly.example.test/mcp' }];
    expect(await refusal('https://app.ledgerly.example.test/mcp')).toBe('host_in_use');
    expect(await refusal('https://app.ledgerly.example.test/other')).toBe('host_in_use');
  });

  it('refuses a host another app holds but lets that app check its own', async () => {
    apps.set('mcp.ledger.example.test', 'app-ledger');
    expect(await refusal('https://mcp.ledger.example.test/mcp')).toBe('host_in_use');
    expect(await refusal('https://mcp.ledger.example.test/mcp', 'app-ledger')).toBeUndefined();
  });

  it("refuses a host with a gateway secret that is not this app's own", async () => {
    secrets.set('tasks.example.test', [{ id: 'secret-1', name: 'tasks' }]);
    expect(await refusal('https://tasks.example.test/mcp')).toBe('host_in_use');
    secrets.set('notes.example.test', [{ id: 'secret-2', name: appCredentialName('app-notes') }]);
    expect(await refusal('https://notes.example.test/mcp', 'app-notes')).toBeUndefined();
    expect(await refusal('https://notes.example.test/mcp')).toBe('host_in_use');
  });

  it.each([
    'gmail.googleapis.com',
    'www.googleapis.com',
    'api.anthropic.com',
    'chatgpt.com',
    WEB_HOST,
    'gateway.example.test',
  ])("refuses %s as one of the assistant's own services", async (host) => {
    expect(await refusal(`https://${host}/mcp`)).toBe('own_service');
  });

  it('refuses when the gateway cannot list credentials by host', async () => {
    gatewayLists = false;
    expect(await refusal('https://mcp.ledger.example.test/mcp')).toBe('unavailable');
  });
});
