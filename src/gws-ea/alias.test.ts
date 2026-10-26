import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../cli/dispatch.js';
import { parseArgv } from '../cli/parse-argv.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getAliasSetup } from '../modules/gws-ea-profile/db.js';
import {
  ALIAS,
  ASSISTANT_EMAIL,
  PRINCIPAL_EMAIL,
  publishAliasTestProfile,
} from '../modules/gws-ea-profile/testing/alias-profile.js';
import '../modules/gws-ea-profile/index.js';
import {
  aliasCandidateAfter,
  aliasNextActions,
  aliasHost,
  aliasStem,
  ensureAssistantAlias,
  firstAliasCandidate,
  parseAliasName,
  type AliasDecision,
  type AliasHost,
} from './alias.js';
import { runCli, type CliRuntime } from './cli.js';
import type { InteractivePrompts, RunEvent } from './events.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { readProvisionJournal, withInstanceOperation, reserveInstance } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { provisionAssistantResources } from './provision.js';
import { expectResultContract } from './testing/result-contract.js';
import type { ProvisionResult } from './phases.js';
import { claimInstanceAlias, getInstanceReservation } from './registry.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

describe("the assistant's web alias name", () => {
  it('reverses the name, lowercased, in ASCII, without spaces', () => {
    expect(aliasStem('Juno')).toEqual({ status: 'derived', stem: 'onuj' });
    expect(aliasStem('Juno Hale')).toEqual({ status: 'derived', stem: 'elahonuj' });
    expect(aliasStem('  Rémy  Vance ')).toEqual({ status: 'derived', stem: 'ecnavymer' });
    expect(aliasStem("Morgan O'Ellery-2")).toEqual({ status: 'derived', stem: '2yrelleonagrom' });
  });

  it('moves the first letter to the end of a palindrome instead', () => {
    expect(aliasStem('Anna')).toEqual({ status: 'derived', stem: 'nnaa' });
    expect(aliasStem('Ada')).toEqual({ status: 'derived', stem: 'daa' });
  });

  it('requires the operator to name the alias for a single repeated letter or a name without ASCII letters', () => {
    for (const name of ['A', 'Aaa', 'a a', '007', '李娜', '---'])
      expect(aliasStem(name), name).toMatchObject({ status: 'name_required' });
  });

  it('keeps a long name within the length an address allows, suffix included', () => {
    const stem = aliasStem('x'.repeat(30) + 'Juno'.repeat(20));
    expect(stem).toMatchObject({ status: 'derived' });
    if (stem.status !== 'derived') return;
    expect(stem.stem.length).toBe(60);
    expect(aliasCandidateAfter(stem.stem, `${stem.stem}9998`)).toBe(`${stem.stem}9999`);
  });

  it('offers the reversed name first, and skips a role address to the next candidate', () => {
    expect(firstAliasCandidate('onuj')).toBe('onuj');
    // "Nimda" reverses to a role address certificate authorities mail to prove control of a domain.
    expect(aliasStem('Nimda')).toEqual({ status: 'derived', stem: 'admin' });
    expect(firstAliasCandidate('admin')).toBe('admin2');
    expect(firstAliasCandidate('postmaster')).toBe('postmaster2');
  });

  it('moves from a candidate to the next with a growing number, and from a name of its own back to the first', () => {
    expect(aliasCandidateAfter('onuj', 'onuj')).toBe('onuj2');
    expect(aliasCandidateAfter('onuj', 'onuj2')).toBe('onuj3');
    expect(aliasCandidateAfter('onuj', 'onuj9')).toBe('onuj10');
    // A stem that ends in a digit numbers on after it.
    expect(aliasCandidateAfter('onuj2', 'onuj2')).toBe('onuj22');
    expect(aliasCandidateAfter('onuj2', 'onuj22')).toBe('onuj23');
    // Not in the sequence: an operator's own name, or a number no candidate has.
    expect(aliasCandidateAfter('onuj', 'juno.web')).toBe('onuj');
    expect(aliasCandidateAfter('onuj', 'onuj02')).toBe('onuj');
    expect(aliasCandidateAfter('onuj', 'onuj1')).toBe('onuj');
    expect(aliasCandidateAfter('admin', 'juno.web')).toBe('admin2');
    expect(aliasCandidateAfter('onuj', 'onuj9999')).toBeUndefined();
  });
});

describe("the operator's own alias name (--alias)", () => {
  it('takes a local part or a whole address, lowercased', () => {
    expect(parseAliasName('Juno.Web')).toEqual({ local: 'juno.web' });
    expect(parseAliasName(' juno-hale_2 ')).toEqual({ local: 'juno-hale_2' });
    expect(parseAliasName('Juno@Hale.Example.Test')).toEqual({ local: 'juno', domain: 'hale.example.test' });
  });

  it('refuses what cannot be a Workspace alias, a role address, or a name without letters', () => {
    for (const value of [
      '',
      '.juno',
      'juno.',
      'ju..no',
      'ju no',
      'juno+web',
      'júno',
      '1234',
      'x'.repeat(65),
      'juno@',
      'juno@localhost',
      'a@b@example.test',
      'Postmaster',
      'webmaster@example.test',
      'noreply',
    ]) {
      expect(() => parseAliasName(value), value).toThrow(GwsEaError);
    }
  });
});

// ---------------------------------------------------------------------------
// The setup step, through the host's own alias commands and a fake Gmail
// ---------------------------------------------------------------------------

const roots: string[] = [];

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-alias-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function reservation(workspaceEmail: string, port: number): InstanceReservationInput {
  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: port, onecli_gateway: port + 1 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: workspaceEmail,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

/** `ncl <args>` as the assistant's host answers it: the same commands, dispatched in this process. */
async function hostNcl(args: readonly string[]): Promise<unknown> {
  const { command, args: parsed } = parseArgv([...args]);
  const frame = await dispatch({ id: command, command, args: parsed }, { caller: 'host' });
  if (!frame.ok) throw new GwsEaError('ncl_failed', `ncl ${args.join(' ')} failed: ${frame.error.message}`);
  return frame.data;
}

interface StepWorld {
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
  readonly events: RunEvent[];
  run(decision?: AliasDecision): Promise<ProvisionResult>;
  claimed(): Promise<string | undefined>;
}

async function stepWorld(host: AliasHost = aliasHost(hostNcl)): Promise<StepWorld> {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation(ASSISTANT_EMAIL, 31_002));
  const events: RunEvent[] = [];
  return {
    paths,
    instanceId: reserved.instance_id,
    events,
    run: (decision) =>
      ensureAssistantAlias(
        { paths, instanceId: reserved.instance_id, host, ...(decision ? { decision } : {}) },
        { emit: (event) => events.push(event) },
      ),
    claimed: async () =>
      (await getInstanceReservation(paths, reserved.instance_id)).exclusive_resource_claims.alias_email,
  };
}

function aliasTerminal(world: StepWorld, attendPause: InteractivePrompts['attendPause']): CliRuntime {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected setup prompt');
  };
  return {
    paths: world.paths,
    stdout: () => undefined,
    stderr: () => undefined,
    environment: {},
    aliasNcl: async (_runtime, args) => hostNcl(args),
    prompts: {
      providerCredential: unused,
      googleCloudSignIn: unused,
      googleAccount: unused,
      googleWorkspaceSignIn: unused,
      attendPause,
    },
  };
}

function paused(result: ProvisionResult) {
  if (result.status !== 'paused') throw new Error('The step did not pause');
  return result.pause;
}

describe('the web alias setup step', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await publishAliasTestProfile();
  });

  afterEach(async () => {
    await closeDb();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('claims the first candidate and pauses with the Admin console steps to add it, sending nothing', async () => {
    const world = await stepWorld();

    const pause = paused(await world.run());

    expect(pause).toEqual({
      kind: 'human-action',
      phase: 'provision_alias',
      code: 'alias_required',
      message: `Add ${ALIAS} as an alias of ${ASSISTANT_EMAIL} in the Google Admin console, then confirm it.`,
      details: [
        '1. Open Google Admin:',
        '   https://admin.google.com/ac/users',
        '',
        `2. Select Juno (${ASSISTANT_EMAIL}).`,
        '   Go to User information > Alternate email addresses (email aliases).',
        '',
        '3. Add the alias:',
        '   Alternate email: onuj',
        '   Domain: example.test',
        '',
        '4. Save, then return here to confirm.',
      ],
      resumeFlag: '--alias-added',
      actionUrl: 'https://admin.google.com/ac/users',
      aliasCandidate: ALIAS,
    });
    expect(await world.claimed()).toBe(ALIAS);
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: ALIAS });
    expect(world.events).toContainEqual({ type: 'domain-effect', step: 'provision_alias', changed: true });

    // A resume before the operator confirms shows the same step again, changing nothing.
    expect(paused(await world.run())).toEqual(pause);
  });

  it('records the alias on operator confirmation without sending mail, and a later run keeps it', async () => {
    const world = await stepWorld();
    await world.run();

    await expect(world.run({ kind: 'added' })).resolves.toEqual({ status: 'ready' });

    await expect(getAliasSetup()).resolves.toMatchObject({ alias: ALIAS });
    expect(await world.claimed()).toBe(ALIAS);
    await expect(world.run()).resolves.toEqual({ status: 'ready' });
    await expect(world.run({ kind: 'added' })).resolves.toEqual({ status: 'ready' });
  });

  it('offers the first candidate without confirming it when no pending alias was shown', async () => {
    const world = await stepWorld();

    expect(paused(await world.run({ kind: 'added' }))).toMatchObject({
      code: 'alias_required',
      aliasCandidate: ALIAS,
    });
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: ALIAS });
    expect(await world.claimed()).toBe(ALIAS);
  });

  it('confirms an explicitly named alias without a pending candidate', async () => {
    const world = await stepWorld();

    await expect(world.run({ kind: 'added', name: 'juno.web' })).resolves.toEqual({ status: 'ready' });
    await expect(getAliasSetup()).resolves.toEqual({ alias: 'juno.web@example.test', candidate: null });
  });

  it('moves a taken candidate to the next, and a resume after it offers only the new one', async () => {
    const world = await stepWorld();
    await world.run();

    const next = paused(await world.run({ kind: 'taken' }));
    expect(next).toMatchObject({
      code: 'alias_required',
      message: `Add onuj2@example.test as an alias of ${ASSISTANT_EMAIL} in the Google Admin console, then confirm it.`,
    });
    expect(await world.claimed()).toBe('onuj2@example.test');
    expect(paused(await world.run())).toEqual(next);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: null,
      candidate: 'onuj2@example.test',
    });

    expect(paused(await world.run({ kind: 'taken' }))).toMatchObject({
      message: expect.stringContaining('onuj3@example.test'),
    });
  });

  it("uses the operator's own name, validated, and confirms it in one step", async () => {
    const world = await stepWorld();
    await world.run();

    expect(paused(await world.run({ kind: 'named', name: 'Juno.Web' }))).toMatchObject({
      code: 'alias_required',
      message: expect.stringContaining('Add juno.web@example.test as an alias'),
    });
    expect(await world.claimed()).toBe('juno.web@example.test');

    await expect(world.run({ kind: 'added', name: 'juno.hale@example.test' })).resolves.toEqual({
      status: 'ready',
    });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'juno.hale@example.test' });
    expect(await world.claimed()).toBe('juno.hale@example.test');

    // Once configured, the alias does not change here.
    await expect(world.run({ kind: 'named', name: 'juno.hale' })).resolves.toEqual({ status: 'ready' });
    await expect(world.run({ kind: 'named', name: 'other' })).rejects.toMatchObject({ code: 'alias_recorded' });
    await expect(world.run({ kind: 'taken' })).rejects.toMatchObject({ code: 'alias_recorded' });
  });

  it("refuses the operator's own name when it is the assistant's, the principal's, or another assistant's", async () => {
    const world = await stepWorld();
    const peer = await reserveInstance(world.paths, reservation('remy@example.test', 32_002));
    await claimInstanceAlias(world.paths, peer.instance_id, 'juno.web@example.test');

    for (const name of [ASSISTANT_EMAIL, PRINCIPAL_EMAIL, 'remy', 'juno.web']) {
      await expect(world.run({ kind: 'named', name }), name).rejects.toMatchObject({ code: 'alias_unavailable' });
    }
    expect(await world.claimed()).toBeUndefined();
  });

  it('skips a candidate another assistant already holds, as its alias or its workspace email', async () => {
    const world = await stepWorld();
    const peer = await reserveInstance(world.paths, reservation('onuj2@example.test', 32_002));
    await claimInstanceAlias(world.paths, peer.instance_id, ALIAS);

    expect(paused(await world.run())).toMatchObject({
      message: expect.stringContaining('Add onuj3@example.test as an alias'),
    });
    expect(await world.claimed()).toBe('onuj3@example.test');
  });

  it('releases a proposed alias on skip and remembers the choice on a later resume', async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    await world.run();
    expect(await world.claimed()).toBe(ALIAS);
    const skip = await withInstanceOperation(world.paths, world.instanceId, (operation) =>
      provisionAssistantResources(operation, {}, {}, { skip: true, ncl: async (_runtime, args) => hostNcl(args) }),
    );
    expect(skip).toMatchObject({ status: 'ready' });
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: null });
    expect(await world.claimed()).toBeUndefined();
    expect((await readProvisionJournal(world.paths, world.instanceId)).decisions.alias_skipped_at).toBeDefined();
    const resumed = await withInstanceOperation(world.paths, world.instanceId, (operation) =>
      provisionAssistantResources(
        operation,
        {},
        {},
        {
          ncl: async () => {
            throw new Error('A skipped alias must not be proposed on resume');
          },
        },
      ),
    );
    expect(resumed).toMatchObject({ status: 'ready' });
  });

  it("takes the operator's word on it from gws-ea alias", async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const enable = async (...flags: string[]) => {
      const stdout: string[] = [];
      const exit = await runCli(['alias', '--id', world.instanceId, ...flags, '--json'], {
        paths: world.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        aliasNcl: (_runtime, args) => hostNcl(args),
      });
      const result: unknown = JSON.parse(stdout.join('\n'));
      expectResultContract('alias', result);
      return { exit, result };
    };
    // Each candidate the step claims is a change, reported independently of browser availability.
    const asked = (address: string) => ({
      exit: 10,
      result: { changed: true, data: { pause: { message: expect.stringContaining(`Add ${address} as an alias`) } } },
    });

    expect(await enable()).toMatchObject({
      ...asked(ALIAS),
      result: {
        ...asked(ALIAS).result,
        next_actions: [
          { kind: 'external', url: 'https://admin.google.com/ac/users' },
          {
            kind: 'command',
            argv: ['gws-ea', 'alias', '--id', world.instanceId, '--alias-added'],
          },
        ],
      },
    });
    expect(await enable('--alias-taken')).toMatchObject(asked('onuj2@example.test'));
    expect(await enable('--alias', 'Juno.Web')).toMatchObject(asked('juno.web@example.test'));
    expect(await enable('--alias-added')).toMatchObject({ exit: 0, result: { outcome: 'succeeded' } });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'juno.web@example.test' });
  });

  it('waits for terminal confirmation and completes alias setup in the same command', async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const pauses: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected setup prompt');
    };
    const exit = await runCli(['alias', '--id', world.instanceId], {
      paths: world.paths,
      stdout: () => undefined,
      stderr: () => undefined,
      environment: {},
      aliasNcl: async (_runtime, args) => hostNcl(args),
      prompts: {
        providerCredential: unused,
        googleCloudSignIn: unused,
        googleAccount: unused,
        googleWorkspaceSignIn: unused,
        attendPause: async (pause) => {
          pauses.push(pause.code);
          expect(await getAliasSetup()).toMatchObject({ alias: null, candidate: ALIAS });
          return { kind: 'continue', decisions: { alias: { kind: 'added' } } };
        },
      },
    });

    expect(exit).toBe(0);
    expect(pauses).toEqual(['alias_required']);
    expect((await getAliasSetup()).alias).toBe(ALIAS);
  });
  it.each(['added', 'taken', 'named'] as const)(
    're-prompts instead of applying a stale %s answer to a new candidate',
    async (kind) => {
      const world = await stepWorld();
      await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
      const shown: string[] = [];
      const exit = await runCli(
        ['alias', '--id', world.instanceId],
        aliasTerminal(world, async (pause) => {
          shown.push(pause.message);
          if (shown.length > 1) return { kind: 'stop' };
          await hostNcl(['gws-ea-alias', 'propose', '--address', 'onuj2@example.test']);
          const alias: AliasDecision = kind === 'named' ? { kind, name: 'stale.alias' } : { kind };
          return { kind: 'continue', decisions: { alias } };
        }),
      );
      expect(exit).toBe(10);
      expect(shown).toHaveLength(2);
      expect(shown[0]).toContain(`Add ${ALIAS} as an alias`);
      expect(shown[1]).toContain('Add onuj2@example.test as an alias');
      expect(await getAliasSetup()).toEqual({ alias: null, candidate: 'onuj2@example.test' });
    },
  );

  it('discards a name supplied for an empty candidate after another command proposes an alias', async () => {
    const world = await stepWorld();
    await world.run();

    expect(paused(await world.run({ kind: 'named', name: 'stale.alias', expectedCandidate: null }))).toMatchObject({
      code: 'alias_required',
      aliasCandidate: ALIAS,
    });
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: ALIAS });
  });

  it('handles taken, custom name, and confirmation in one alias command', async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const answers: AliasDecision[] = [{ kind: 'taken' }, { kind: 'named', name: 'juno.web' }, { kind: 'added' }];
    const candidates: (string | null)[] = [];
    const exit = await runCli(
      ['alias', '--id', world.instanceId],
      aliasTerminal(world, async () => {
        candidates.push((await getAliasSetup()).candidate);
        const answer = answers.shift();
        if (answer === undefined) throw new Error('Unexpected alias prompt');
        return { kind: 'continue', decisions: { alias: answer } };
      }),
    );
    expect(exit).toBe(0);
    expect(candidates).toEqual([ALIAS, 'onuj2@example.test', 'juno.web@example.test']);
    expect(await getAliasSetup()).toEqual({ alias: 'juno.web@example.test', candidate: null });
  });

  it('ignores confirmation after a terminal interrupt and removes signal listeners', async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const before = signals.map((signal) => process.listenerCount(signal));
    const exit = await runCli(
      ['alias', '--id', world.instanceId],
      aliasTerminal(world, async (_pause, signal) => {
        process.emit('SIGINT');
        expect(signal.aborted).toBe(true);
        return { kind: 'continue', decisions: { alias: { kind: 'added' } } };
      }),
    );
    expect(exit).toBe(10);
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: ALIAS });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(before);
  });

  it('leaves the proposed alias pending when the operator stops at the terminal', async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const stdout: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('Unexpected setup prompt');
    };
    let asked = false;
    const exit = await runCli(['alias', '--id', world.instanceId], {
      paths: world.paths,
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      environment: {},
      aliasNcl: async (_runtime, args) => hostNcl(args),
      prompts: {
        providerCredential: unused,
        googleCloudSignIn: unused,
        googleAccount: unused,
        googleWorkspaceSignIn: unused,
        attendPause: async () => {
          asked = true;
          return { kind: 'stop' };
        },
      },
    });
    expect(asked).toBe(true);
    expect(exit).toBe(10);
    expect(stdout.filter((line) => line.includes('https://admin.google.com/ac/users'))).toEqual([
      '     https://admin.google.com/ac/users',
    ]);
    expect(stdout.join('\n')).toContain('--alias-taken');
    expect(stdout.join('\n')).toContain('--alias <name>');
    expect(await getAliasSetup()).toEqual({ alias: null, candidate: ALIAS });
  });
});

describe('a name that gives no alias', () => {
  /** A host serving `name`'s profile, and the alias commands in memory. */
  function scriptedHost(name: string): AliasHost & { proposed: (string | null)[] } {
    let candidate: string | null = null;
    const proposed: (string | null)[] = [];
    return {
      proposed,
      identity: async () => ({ name, email: 'aaa@example.test', domain: 'example.test', principalEmails: [] }),
      setup: async () => ({ alias: null, candidate }),
      async propose(address) {
        proposed.push(address);
        candidate = address;
        return { alias: null, candidate };
      },
      confirm: async (address) => ({ alias: address, candidate: null }),
    };
  }

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('asks the operator to name it, then takes their name', async () => {
    const host = scriptedHost('Aaa');
    const paths = await testPaths();
    const { instance_id: instanceId } = await reserveInstance(paths, reservation('aaa@example.test', 31_002));
    const run = (decision?: AliasDecision) =>
      ensureAssistantAlias({ paths, instanceId, host, ...(decision ? { decision } : {}) }, {});

    const firstPause = paused(await run());
    expect(firstPause).toMatchObject({
      code: 'alias_name_required',
      message: expect.stringMatching(/^Name Aaa's web alias: "Aaa" reads the same reversed/u),
      resumeFlag: '--alias <name>',
    });
    expect(aliasNextActions(instanceId, firstPause)).toContainEqual({
      kind: 'external',
      instruction: 'Supply the input requested by --alias <name>.',
    });
    expect(paused(await run({ kind: 'taken' }))).toMatchObject({ code: 'alias_name_required' });
    expect(paused(await run({ kind: 'named', name: 'juno.web' }))).toMatchObject({ code: 'alias_required' });
    expect(host.proposed.at(-1)).toBe('juno.web@example.test');

    // The operator's name is taken too, and nothing of the assistant's own is left: the request is withdrawn.
    expect(paused(await run({ kind: 'taken' }))).toMatchObject({ code: 'alias_name_required' });
    expect(host.proposed.at(-1)).toBeNull();
    expect((await getInstanceReservation(paths, instanceId)).exclusive_resource_claims.alias_email).toBeUndefined();
  });

  it('refuses a host report it cannot read', async () => {
    const paths = await testPaths();
    const { instance_id: instanceId } = await reserveInstance(paths, reservation('aaa@example.test', 31_002));
    const host = aliasHost(async () => ({ alias: 'not an address', candidate: null }));

    await expect(ensureAssistantAlias({ paths, instanceId, host }, {})).rejects.toMatchObject({
      code: 'invalid_child_output',
    });
  });
});
