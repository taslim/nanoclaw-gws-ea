/**
 * Guard conformance — checked with the real registries.
 *
 * The old registry walk is gone: an unmapped consult or an undeclared
 * unguarded registration is now unconstructible — await guard() takes the defined
 * GuardedAction value (a dropped module-edge import or typo'd name is a
 * compile error), and the keyed registries require a guard spec or an
 * explicit unguarded(<reason>) declaration. What's left to verify is the
 * cross-registry pairing the compiler can't see: every holding action has a
 * registered approve continuation. (At runtime a missing continuation is
 * handled loudly at click time — the requester is told no handler is
 * installed; this test keeps the tree from shipping that state.)
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Production barrels — side-effect imports populate the real registries.
import '../cli/commands/index.js';
import '../modules/index.js';
import '../cli/delivery-action.js';
import '../cli/dispatch.js'; // registers the cli_command approval handler

import { commandGuard, listCommands } from '../cli/registry.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getApprovalHandler } from '../modules/approvals/primitive.js';
// Main's app tools and the policy that keeps every other path off main's MCP servers.
import '../modules/gws-ea-connections/actions.js';
import { selfModAddMcpServer } from '../modules/self-mod/guard.js';
import { defineGuardedAction, listGuardedActions } from './guard-actions.js';
import { guard } from './guard.js';
import { HOLD, type GuardActor } from './types.js';

describe('guard conformance', () => {
  it('every holding action pairs with a registered approval handler', () => {
    const holding = listGuardedActions().filter((spec) => spec.grantActionName);
    expect(holding.length).toBeGreaterThan(0);

    const dangling = holding.filter((spec) => !getApprovalHandler(spec.grantActionName as string));
    expect(dangling.map((s) => s.action)).toEqual([]);
  });

  it('every mutating ncl command derives a guard that holds via cli_command', () => {
    const mutating = listCommands().filter((cmd) => cmd.access === 'approval');
    expect(mutating.length).toBeGreaterThan(0);

    const wrong = mutating.filter((cmd) => commandGuard(cmd.name).grantActionName !== 'cli_command');
    expect(wrong.map((c) => c.name)).toEqual([]);
  });

  it('the domain catalog entries are defined once the module barrels load', () => {
    const actions = new Set(listGuardedActions().map((s) => s.action));
    for (const expected of [
      'agents.create',
      'a2a.send',
      'self_mod.install_packages',
      'self_mod.add_mcp_server',
      'senders.admit',
      'channels.register',
    ]) {
      expect(actions.has(expected), `catalog is missing "${expected}"`).toBe(true);
    }
  });

  it('defining the same action twice throws — names are the catalog key', () => {
    defineGuardedAction({ action: 'test.dup-define', decide: () => HOLD('x') });
    expect(() => defineGuardedAction({ action: 'test.dup-define', decide: () => HOLD('x') })).toThrow(
      /already defined/,
    );
  });
});

/**
 * Every host path that writes a group's stored MCP servers, by the source that writes them, with how main's are kept
 * to its app tools. A new writer fails the inventory until it is classified here.
 */
const MCP_SERVER_WRITERS: Readonly<Record<string, string>> = {
  'src/cli/resources/groups.ts': 'ncl groups config add-mcp-server / remove-mcp-server: refused for main',
  'src/templates/restamp.ts': 'ncl groups create --template, updating a stamped group: refused for main',
  'src/templates/create-agent.ts': 'stamping a new agent: writes only the group it creates',
  'src/modules/self-mod/apply.ts': 'the add_mcp_server delivery action: refused for main',
  'src/modules/gws-ea-connections/apply.ts': "host-owned: main's app entries reconciled to the connections store",
};

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [file] : [];
  });
}

describe("main's MCP servers change only through its app tools", () => {
  const MAIN = 'ag-main';
  const OTHER = 'ag-other';
  const main: GuardActor = { kind: 'agent', agentGroupId: MAIN, sessionId: 'sess-main' };
  const host: GuardActor = { kind: 'host' };

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    const now = new Date().toISOString();
    for (const id of [MAIN, OTHER]) {
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
      await ensureContainerConfig(id);
    }
    await getDb().run(
      "UPDATE gws_ea_profile SET assistant_first_name = 'Juno', principal_first_name = 'Morgan', main_agent_group_id = ? WHERE singleton = 1",
      MAIN,
    );
  });
  afterEach(async () => {
    await closeDb();
  });

  it('knows every source that writes stored MCP servers', () => {
    const writers = sourceFiles('src')
      .filter((file) => /updateContainerConfigJson\(\s*[^,]+,\s*'mcp_servers'/u.test(fs.readFileSync(file, 'utf8')))
      .map((file) => file.split(path.sep).join('/'))
      .sort();
    expect(writers).toEqual(Object.keys(MCP_SERVER_WRITERS).sort());
  });

  it("refuses main's raw config commands with the app-tool pointer, while the operator's host calls go through", async () => {
    const commands: [string, Record<string, unknown>][] = [
      ['groups-config-add-mcp-server', { id: MAIN, name: 'homeboard', url: 'https://homeboard.nownow.ai/mcp' }],
      ['groups-config-remove-mcp-server', { id: MAIN, name: 'homeboard' }],
      ['groups-create', { id: MAIN, template: 'gws-ea/main', yes: true }],
    ];
    for (const [command, payload] of commands) {
      expect(await guard(commandGuard(command), { actor: main, payload }), command).toMatchObject({
        effect: 'deny',
        reason: expect.stringContaining('use add_app or delete_app'),
      });
      expect(await guard(commandGuard(command), { actor: host, payload }), command).toMatchObject({ effect: 'allow' });
    }
    // Creating a new agent from a template names no group whose servers it changes.
    expect(
      await guard(commandGuard('groups-create'), { actor: main, payload: { id: MAIN, template: 'x', new: true } }),
    ).not.toMatchObject({ reason: expect.stringContaining('add_app') });
  });

  it('refuses the add_mcp_server delivery action for main, and an app_ server name for any group', async () => {
    const other: GuardActor = { kind: 'agent', agentGroupId: OTHER, sessionId: 'sess-other' };

    expect(await guard(selfModAddMcpServer, { actor: main, payload: { name: 'homeboard' } })).toMatchObject({
      effect: 'deny',
      reason: expect.stringContaining('use add_app or delete_app'),
    });
    expect(await guard(selfModAddMcpServer, { actor: other, payload: { name: 'homeboard' } })).toMatchObject({
      effect: 'hold',
    });
    expect(await guard(selfModAddMcpServer, { actor: other, payload: { name: 'app_0a1b2c3d4e5f' } })).toMatchObject({
      effect: 'deny',
      reason: expect.stringContaining("principal's connected apps"),
    });
    expect(
      await guard(commandGuard('groups-config-remove-mcp-server'), {
        actor: other,
        payload: { id: OTHER, name: 'app_0a1b2c3d4e5f' },
      }),
    ).toMatchObject({ effect: 'deny', reason: expect.stringContaining("principal's connected apps") });
  });
});
