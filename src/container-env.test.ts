/**
 * The module-contributed container env seam, through the real composition: a
 * registered contributor's env reaches the agent container's contributed
 * lane, derived from the group's capabilities, and a contributor that would
 * override a key core composes, or another contributor's key, refuses the
 * spawn.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import type { ContainerConfig } from './container-config.js';
import { registerContainerEnv } from './container-env.js';
import { composeSessionSpec } from './container-runner.js';
import { mountPolicy } from './drivers/index.js';
import { validateSpec } from './drivers/types.js';
import type { Session } from './types.js';

/** What the fixture contributor sets for each group a case names; one registry serves every case. */
const SETTINGS_BY_GROUP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'ag-tz': { TZ: 'UTC' },
  'ag-home': { HOME: '/root' },
  'ag-mailbox': { NANOCLAW_MAILBOX_BACKEND: 'other' },
  'ag-provider': { XDG_DATA_HOME: '/elsewhere' },
  'ag-gateway': { HTTPS_PROXY: 'http://elsewhere:1' },
  'ag-smuggled': { 'TZ=UTC': '' },
  'ag-credential': { FIXTURE_UPSTREAM: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA' },
};

const NONE: Readonly<Record<string, string>> = {};

registerContainerEnv('fixture:reach', ({ capabilities }) =>
  capabilities.has('web') ? { FIXTURE_REACH: 'web' } : NONE,
);
registerContainerEnv('fixture:settings', ({ agentGroupId }) => SETTINGS_BY_GROUP[agentGroupId] ?? NONE);
registerContainerEnv('fixture:twin-a', ({ agentGroupId }) =>
  agentGroupId === 'ag-twins' ? { FIXTURE_TWIN: 'a' } : NONE,
);
registerContainerEnv('fixture:twin-b', ({ agentGroupId }) =>
  agentGroupId === 'ag-twins' ? { FIXTURE_TWIN: 'b' } : NONE,
);

function compose(agentGroupId: string, capabilities: readonly string[] = ['reply', 'web']) {
  return composeSessionSpec({
    agentGroup: {
      id: agentGroupId,
      name: agentGroupId,
      folder: agentGroupId,
      agent_provider: null,
      created_at: '2026-10-03T00:00:00.000Z',
    },
    session: { id: 'session-1', agent_group_id: agentGroupId } as Session,
    containerName: `nanoclaw-v2-${agentGroupId}-1700000000000`,
    mounts: [],
    containerConfig: { capabilities: [...capabilities] } as unknown as ContainerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: { env: { XDG_DATA_HOME: '/workspace/xdg' } },
    gateway: {
      env: { HTTPS_PROXY: 'http://gateway:15001' },
      networkAccess: { endpoint: 'localhost', target: { kind: 'host' } },
    },
  });
}

describe('module-contributed container env', () => {
  it("puts a contributor's settings on the contributed lane, from the group's capabilities", () => {
    const withWeb = compose('ag-plain', ['reply', 'web']).containers[0];
    const withoutWeb = compose('ag-plain', ['reply']).containers[0];

    expect(withWeb.contributedEnv).toMatchObject({
      FIXTURE_REACH: 'web',
      XDG_DATA_HOME: '/workspace/xdg',
      HTTPS_PROXY: 'http://gateway:15001',
    });
    expect(withWeb.env).not.toHaveProperty('FIXTURE_REACH');
    expect(withoutWeb.contributedEnv).not.toHaveProperty('FIXTURE_REACH');
  });

  it.each([
    ['the timezone', 'ag-tz', 'TZ'],
    ['the home directory', 'ag-home', 'HOME'],
    ["the mailbox's", 'ag-mailbox', 'NANOCLAW_MAILBOX_BACKEND'],
    ["the model provider's", 'ag-provider', 'XDG_DATA_HOME'],
    ["the gateway's", 'ag-gateway', 'HTTPS_PROXY'],
  ])('refuses the spawn when a contributor would override %s key', (_owner, agentGroupId, key) => {
    expect(() => compose(agentGroupId)).toThrow(`spec-invalid: container env contributor "fixture:settings"`);
    expect(() => compose(agentGroupId)).toThrow(`'${key}'`);
  });

  it('refuses the spawn when two contributors set one key', () => {
    expect(() => compose('ag-twins')).toThrow(
      `spec-invalid: container env contributors "fixture:twin-a" and "fixture:twin-b" both set 'FIXTURE_TWIN'`,
    );
  });

  it('refuses a key that is not an environment variable name, so none can smuggle in another', () => {
    expect(() => compose('ag-smuggled')).toThrow(`spec-invalid: container env contributor "fixture:settings"`);
  });

  it('leaves a credential value refused by the spec check', () => {
    const spec = compose('ag-credential');

    expect(() => validateSpec(spec, mountPolicy())).toThrow(
      "denied-by-policy: credential value in contributed env 'FIXTURE_UPSTREAM' on agent",
    );
  });

  it('refuses a malformed or duplicate contributor id', () => {
    expect(() => registerContainerEnv('fixture', () => ({}))).toThrow('"<module-id>:<contributor-id>"');
    expect(() => registerContainerEnv('fixture:reach', () => ({}))).toThrow('already registered');
  });
});
