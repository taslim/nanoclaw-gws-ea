import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getAliasSetup, getAssistantAlias, proposeAliasCandidate } from '../gws-ea-profile/db.js';
import { probeAlias } from './alias-probe.js';
import { setActiveInbox } from './runtime.js';
import {
  ALIAS,
  ASSISTANT_EMAIL as ASSISTANT,
  aliasInbox as inbox,
  FakeAliasGmail,
  headersOf,
  publishAliasTestProfile,
} from './testing/alias-mailbox.js';
import './index.js';

let gmail: FakeAliasGmail;

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await publishAliasTestProfile();
  gmail = new FakeAliasGmail();
});

afterEach(async () => {
  setActiveInbox(undefined);
  await closeDb();
});

describe('the web alias probe (KTD13)', () => {
  it('sends one bland, self-explaining email from the assistant to the alias, with a nonce', async () => {
    await proposeAliasCandidate(ALIAS);

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: true })).resolves.toEqual({
      outcome: 'not_yet',
      alias: null,
    });

    expect(gmail.sent).toHaveLength(1);
    const headers = headersOf(gmail.sent[0]);
    const header = (name: string) => headers.find((entry) => entry.name === name)?.value;
    expect(header('From')).toBe(`Juno <${ASSISTANT}>`);
    expect(header('To')).toBe(ALIAS);
    expect(header('Subject')).toBe('Address check');
    const messageId = header('Message-ID')!;
    expect(messageId).toMatch(/^<alias-check\.[0-9a-f]{32}@example\.test>$/u);
    const nonce = /alias-check\.([0-9a-f]{32})@/u.exec(messageId)![1];
    const body = gmail.sent[0].replace(/=\r\n/gu, '');
    expect(body).toContain(`checks that ${ALIAS} delivers to Juno's mailbox`);
    expect(body).toContain('you can delete it');
    expect(body).toContain(`Check reference: ${nonce}`);
    expect(body).not.toContain('Morgan');
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: ALIAS, probe_message_id: messageId });
  });

  it('records the alias once an inbox copy of the probe arrives, and then sends nothing more', async () => {
    await proposeAliasCandidate(ALIAS);
    gmail.onSend = (id) => gmail.deliver(id);

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: true })).resolves.toEqual({
      outcome: 'verified',
      alias: ALIAS,
    });
    await expect(getAssistantAlias()).resolves.toBe(ALIAS);

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: true })).resolves.toEqual({
      outcome: 'verified',
      alias: ALIAS,
    });
    expect(gmail.sent).toHaveLength(1);
  });

  it('records an alias whose probe arrives after a first read found nothing', async () => {
    await proposeAliasCandidate(ALIAS);
    await probeAlias(inbox(gmail), { address: ALIAS, send: true });
    // Only the copy Gmail keeps as sent: nothing has arrived.
    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toMatchObject({
      outcome: 'not_yet',
    });

    gmail.deliver();
    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toEqual({
      outcome: 'verified',
      alias: ALIAS,
    });
    expect(gmail.sent).toHaveLength(1);
  });

  it('reports a bounce as not added yet, and records nothing', async () => {
    await proposeAliasCandidate(ALIAS);
    gmail.onSend = () => gmail.bounce();

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: true })).resolves.toEqual({
      outcome: 'bounced',
      alias: null,
    });
    await expect(getAliasSetup()).resolves.toMatchObject({ alias: null, candidate: ALIAS });
  });

  it.each(['List-Id', 'X-Google-Group-Id'] as const)(
    'refuses a copy carrying %s as a Google Group, whatever else arrived',
    async (header) => {
      await proposeAliasCandidate(ALIAS);
      await probeAlias(inbox(gmail), { address: ALIAS, send: true });
      gmail.deliverThroughGroup(header);
      gmail.deliver();

      await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toEqual({
        outcome: 'group',
        alias: null,
      });
      await expect(getAssistantAlias()).resolves.toBeNull();
    },
  );

  it('never records an earlier candidate its late probe reaches, and sends nothing for it', async () => {
    await proposeAliasCandidate(ALIAS);
    await probeAlias(inbox(gmail), { address: ALIAS, send: true });
    // The operator found the address taken and moved on before the probe arrived.
    await proposeAliasCandidate('onuj2@example.test');
    gmail.deliver();

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toEqual({
      outcome: 'superseded',
      alias: null,
    });
    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: true })).resolves.toMatchObject({
      outcome: 'superseded',
    });
    await expect(probeAlias(inbox(gmail), { address: 'onuj2@example.test', send: false })).resolves.toEqual({
      outcome: 'not_sent',
      alias: null,
    });
    expect(gmail.sent).toHaveLength(1);
    await expect(getAliasSetup()).resolves.toEqual({
      alias: null,
      candidate: 'onuj2@example.test',
      probe_message_id: null,
    });
  });

  it('checks only the latest probe for a candidate, so a resend starts the read-back afresh', async () => {
    await proposeAliasCandidate(ALIAS);
    await probeAlias(inbox(gmail), { address: ALIAS, send: true });
    const first = gmail.probe.message.id;
    await probeAlias(inbox(gmail), { address: ALIAS, send: true });
    gmail.deliver(first);

    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toMatchObject({
      outcome: 'not_yet',
    });
    gmail.deliver();
    await expect(probeAlias(inbox(gmail), { address: ALIAS, send: false })).resolves.toMatchObject({
      outcome: 'verified',
    });
  });
});

describe("the host's alias commands", () => {
  it('reads the setup, proposes a candidate, and probes it through the running inbox', async () => {
    const run = (command: string, args: Record<string, unknown> = {}) =>
      dispatch({ id: command, command, args }, { caller: 'host' });

    await expect(run('gws-ea-alias-get')).resolves.toMatchObject({
      ok: true,
      data: { alias: null, candidate: null, probe_sent: false },
    });
    await expect(run('gws-ea-alias-propose', { address: ALIAS })).resolves.toMatchObject({
      ok: true,
      data: { alias: null, candidate: ALIAS, probe_sent: false },
    });
    await expect(run('gws-ea-alias-probe', { address: ALIAS, send: true })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/inbox is not running/u) },
    });

    setActiveInbox(inbox(gmail));
    gmail.onSend = (id) => gmail.deliver(id);
    await expect(run('gws-ea-alias-probe', { address: ALIAS, send: true })).resolves.toMatchObject({
      ok: true,
      data: { outcome: 'verified', alias: ALIAS },
    });
    await expect(run('gws-ea-alias-get')).resolves.toMatchObject({
      ok: true,
      data: { alias: ALIAS, candidate: null, probe_sent: false },
    });
  });

  it('withdraws a candidate, and refuses unknown or missing fields', async () => {
    const run = (command: string, args: Record<string, unknown> = {}) =>
      dispatch({ id: command, command, args }, { caller: 'host' });
    await run('gws-ea-alias-propose', { address: ALIAS });

    await expect(run('gws-ea-alias-propose', { none: true })).resolves.toMatchObject({
      ok: true,
      data: { candidate: null },
    });
    await expect(run('gws-ea-alias-propose', {})).resolves.toMatchObject({ ok: false });
    await expect(run('gws-ea-alias-propose', { address: ALIAS, none: true })).resolves.toMatchObject({ ok: false });
    await expect(run('gws-ea-alias-probe', { send: true })).resolves.toMatchObject({ ok: false });
    await expect(run('gws-ea-alias-get', { address: ALIAS })).resolves.toMatchObject({ ok: false });
  });

  it('keeps every alias command from an agent', async () => {
    for (const [command, args] of [
      ['gws-ea-alias-get', {}],
      ['gws-ea-alias-propose', { address: ALIAS }],
      ['gws-ea-alias-probe', { address: ALIAS, send: true }],
    ] as const) {
      await expect(
        dispatch(
          { id: command, command, args },
          { caller: 'agent', sessionId: 'session-main', agentGroupId: 'ag-main', messagingGroupId: 'mg-dm' },
        ),
      ).resolves.toMatchObject({ ok: false, error: { message: expect.stringMatching(/operator-only/u) } });
    }
    await expect(getAliasSetup()).resolves.toEqual({ alias: null, candidate: null, probe_message_id: null });
  });
});
