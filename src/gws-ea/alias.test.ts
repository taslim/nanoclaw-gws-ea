import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../cli/dispatch.js';
import { parseArgv } from '../cli/parse-argv.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getAliasSetup } from '../modules/gws-ea-profile/db.js';
import { setActiveInbox } from '../modules/gws-ea-inbox/runtime.js';
import {
  ALIAS,
  aliasInbox,
  ASSISTANT_EMAIL,
  FakeAliasGmail,
  PRINCIPAL_EMAIL,
  publishAliasTestProfile,
} from '../modules/gws-ea-inbox/testing/alias-mailbox.js';
import '../modules/gws-ea-profile/index.js';
import '../modules/gws-ea-inbox/index.js';
import {
  aliasCandidateAfter,
  aliasHost,
  aliasStem,
  ensureAssistantAlias,
  firstAliasCandidate,
  parseAliasName,
  type AliasDecision,
  type AliasHost,
} from './alias.js';
import { runCli } from './cli.js';
import type { RunEvent } from './events.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { ProvisionResult } from './phases.js';
import { claimInstanceAlias, getInstanceReservation } from './registry.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import { GwsEaError, type InstanceReservationInput } from './types.js';

describe("the assistant's web alias name (R21)", () => {
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
  readonly gmail: FakeAliasGmail;
  readonly events: RunEvent[];
  readonly sleeps: number[];
  run(decision?: AliasDecision): Promise<ProvisionResult>;
  claimed(): Promise<string | undefined>;
}

async function stepWorld(host: AliasHost = aliasHost(hostNcl)): Promise<StepWorld> {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation(ASSISTANT_EMAIL, 31_002));
  const gmail = new FakeAliasGmail();
  setActiveInbox(aliasInbox(gmail));
  const events: RunEvent[] = [];
  const sleeps: number[] = [];
  return {
    paths,
    instanceId: reserved.instance_id,
    gmail,
    events,
    sleeps,
    run: (decision) =>
      ensureAssistantAlias(
        { paths, instanceId: reserved.instance_id, host, ...(decision ? { decision } : {}) },
        { emit: (event) => events.push(event) },
        async (milliseconds) => void sleeps.push(milliseconds),
      ),
    claimed: async () =>
      (await getInstanceReservation(paths, reserved.instance_id)).exclusive_resource_claims.alias_email,
  };
}

function paused(result: ProvisionResult) {
  if (result.status !== 'paused') throw new Error('The step did not pause');
  return result.pause;
}

describe('the web alias setup step (KTD13)', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await publishAliasTestProfile();
  });

  afterEach(async () => {
    setActiveInbox(undefined);
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
        `Open Juno (${ASSISTANT_EMAIL}), then User information > Alternate email addresses (email aliases)`,
        'Add the alternate email onuj on example.test, then Save',
        'If the Admin console says the address is already in use, continue with --alias-taken for the next name',
        'To choose the name yourself, continue with --alias <name>',
      ],
      resumeFlag: '--alias-added',
      actionUrl: 'https://admin.google.com/ac/users',
    });
    expect(await world.claimed()).toBe(ALIAS);
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: ALIAS, probe_message_id: null });
    expect(world.gmail.sent).toEqual([]);
    expect(world.events).toContainEqual({ type: 'domain-effect', step: 'provision_alias', changed: true });

    // A resume before the operator confirms shows the same step again, changing nothing.
    expect(paused(await world.run())).toEqual(pause);
    expect(world.gmail.sent).toEqual([]);
  });

  it('records the alias once its probe arrives, keeping the claim, and a later run sends nothing', async () => {
    const world = await stepWorld();
    await world.run();
    world.gmail.onSend = (id) => world.gmail.deliver(id);

    await expect(world.run({ kind: 'added' })).resolves.toEqual({ status: 'ready' });

    expect(world.gmail.sent).toHaveLength(1);
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: ALIAS });
    expect(await world.claimed()).toBe(ALIAS);
    await expect(world.run()).resolves.toEqual({ status: 'ready' });
    await expect(world.run({ kind: 'added' })).resolves.toEqual({ status: 'ready' });
    expect(world.gmail.sent).toHaveLength(1);
  });

  it('tries the first candidate at once when the operator says it is added before seeing it', async () => {
    const world = await stepWorld();
    world.gmail.onSend = (id) => world.gmail.deliver(id);

    await expect(world.run({ kind: 'added' })).resolves.toEqual({ status: 'ready' });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: ALIAS });
  });

  it('stays pending as not added yet when the probe bounces', async () => {
    const world = await stepWorld();
    await world.run();
    world.gmail.onSend = () => world.gmail.bounce();

    const pause = paused(await world.run({ kind: 'added' }));

    expect(pause).toMatchObject({
      code: 'alias_not_added',
      message: `The test message to ${ALIAS} bounced: it is not an alias of ${ASSISTANT_EMAIL} yet.`,
      resumeFlag: '--alias-added',
    });
    expect(pause.details?.join('\n')).toMatch(/up to 24 hours/u);
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: null, candidate: ALIAS });
    expect(world.sleeps).toEqual([]);
  });

  it('waits briefly, then stays pending with "up to 24 hours" when nothing arrives, and records a late arrival on resume', async () => {
    const world = await stepWorld();
    await world.run();

    const pause = paused(await world.run({ kind: 'added' }));

    expect(pause).toMatchObject({
      code: 'alias_not_delivered',
      message: `The test message to ${ALIAS} has not arrived yet: Google can take up to 24 hours to start delivering to a new alias.`,
    });
    expect(pause.resumeFlag).toBeUndefined();
    expect(world.sleeps).toEqual([2_000, 3_000, 5_000, 5_000, 5_000, 10_000]);
    expect(world.events.filter((event) => event.type === 'step-waiting')).toHaveLength(6);

    world.gmail.deliver();
    await expect(world.run()).resolves.toEqual({ status: 'ready' });
    expect(world.gmail.sent).toHaveLength(1);
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: ALIAS });
  });

  it('refuses a copy that came through a Google Group', async () => {
    const world = await stepWorld();
    await world.run();
    world.gmail.onSend = () => world.gmail.deliverThroughGroup('List-Id');

    expect(paused(await world.run({ kind: 'added' }))).toMatchObject({
      code: 'alias_is_group',
      resumeFlag: '--alias-taken',
    });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: null });
  });

  it('moves a taken candidate to the next, and a resume after it offers only the new one', async () => {
    const world = await stepWorld();
    await world.run();
    await world.run({ kind: 'added' });

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
      probe_message_id: null,
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

    world.gmail.onSend = (id) => world.gmail.deliver(id);
    await expect(world.run({ kind: 'added', name: 'juno.hale@example.test' })).resolves.toEqual({
      status: 'ready',
    });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'juno.hale@example.test' });
    expect(await world.claimed()).toBe('juno.hale@example.test');

    // Once verified, the alias does not change here.
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

  it("takes the operator's word on it from capabilities enable browser", async () => {
    const world = await stepWorld();
    await persistTestRuntime(world.paths, await getInstanceReservation(world.paths, world.instanceId));
    const enable = async (...flags: string[]) => {
      const stdout: string[] = [];
      const exit = await runCli(['capabilities', 'enable', 'browser', '--id', world.instanceId, ...flags, '--json'], {
        paths: world.paths,
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        browserInspection: { ncl: (_runtime, args) => hostNcl(args) },
      });
      return { exit, result: JSON.parse(stdout.join('\n')) as unknown };
    };
    // Each candidate the step claims is a change, reported even when the browser policy already stood.
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
            argv: ['gws-ea', 'capabilities', 'enable', 'browser', '--id', world.instanceId, '--alias-added'],
          },
        ],
      },
    });
    expect(await enable('--alias-taken')).toMatchObject(asked('onuj2@example.test'));
    expect(await enable('--alias', 'Juno.Web')).toMatchObject(asked('juno.web@example.test'));
    world.gmail.onSend = (id) => world.gmail.deliver(id);
    expect(await enable('--alias-added')).toMatchObject({ exit: 0, result: { outcome: 'succeeded' } });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: 'juno.web@example.test' });
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
      setup: async () => ({ alias: null, candidate, probeSent: false }),
      async propose(address) {
        proposed.push(address);
        candidate = address;
        return { alias: null, candidate, probeSent: false };
      },
      probe: async () => 'not_sent',
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

    expect(paused(await run())).toMatchObject({
      code: 'alias_name_required',
      message: expect.stringMatching(/^Name Aaa's web alias: "Aaa" reads the same reversed/u),
      resumeFlag: '--alias <name>',
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
    const host = aliasHost(async () => ({ alias: 'not an address', candidate: null, probe_sent: false }));

    await expect(ensureAssistantAlias({ paths, instanceId, host }, {})).rejects.toMatchObject({
      code: 'invalid_child_output',
    });
  });
});
