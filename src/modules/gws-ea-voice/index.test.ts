import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import type { InboundPreparationRequest } from '../../inbound-preparation.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { MessagingGroup } from '../../types.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { gwsEaProfileMigration } from '../gws-ea-profile/migration.js';

const paths = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  get DATA_DIR() {
    return paths.data;
  },
}));
import { prepareVoiceContent, voiceHealth } from './index.js';
import { lookup } from '../../cli/registry.js';

let root: string;
beforeEach(async () => {
  await runMigrations(await initTestDb(), [...getRegisteredMigrations(), gwsEaProfileMigration]);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-prepare-test-')));
  paths.data = root;
  vi.stubEnv('GWS_EA_VOICE_POLICY_FILE', path.join(root, 'policy.json'));
  await fs.writeFile(
    path.join(root, 'policy.json'),
    JSON.stringify({ schemaVersion: 1, enabled: false, installationDir: null }),
  );
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  await fs.rm(root, { force: true, recursive: true });
});

interface Conversation {
  readonly channelType: string;
  readonly platformId: string;
  readonly isGroup: boolean;
  readonly sender?: string;
}

/** Morgan Ellery's direct message with the assistant. */
const PRINCIPAL_DM: Conversation = { channelType: 'gchat', platformId: 'spaces/principal', isGroup: false };

function request(content: unknown, conversation: Conversation = PRINCIPAL_DM): InboundPreparationRequest {
  const timestamp = new Date().toISOString();
  const messagingGroup: MessagingGroup = {
    id: 'conversation',
    channel_type: conversation.channelType,
    platform_id: conversation.platformId,
    name: null,
    is_group: conversation.isGroup ? 1 : 0,
    unknown_sender_policy: 'strict',
    created_at: timestamp,
  };
  return {
    content: JSON.stringify(content),
    channelType: conversation.channelType,
    instance: conversation.channelType,
    platformId: conversation.platformId,
    messageId: 'note',
    timestamp,
    ...(conversation.sender === undefined
      ? {}
      : { authenticatedSender: { userId: conversation.sender, kind: 'human' as const } }),
    session: {
      id: 'session',
      agent_group_id: 'main',
      messaging_group_id: 'conversation',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: timestamp,
    },
    messagingGroup,
  };
}

describe('inert optional content preparation', () => {
  it('preserves text exactly and starts no child when the host has disabled voice', async () => {
    const typed = request({ text: '/typed-command', sender: 'principal' });
    expect(await prepareVoiceContent(typed)).toBe(typed.content);
    const content = {
      text: 'caption',
      sender: 'principal',
      attachments: [
        {
          type: 'audio',
          filename: 'recording.ogg',
          data: Buffer.from('original').toString('base64'),
          audioSource: { kind: 'voice-note', forwarded: true },
        },
        { type: 'audio' },
      ],
    };
    const prepared = JSON.parse(await prepareVoiceContent(request(content))) as {
      text: string;
      sender: string;
      attachments: Record<string, unknown>[];
    };
    expect(prepared.text).toBe('caption');
    expect(prepared.sender).toBe('principal');
    expect(prepared.attachments[0]).toMatchObject({
      data: content.attachments[0].data,
      audioSource: { kind: 'voice-note', forwarded: true },
      speech: { status: 'unavailable', reason: 'operator-enablement-required', inPrincipalPrivateConversation: false },
    });
    expect(prepared.attachments[1].speech).toEqual({
      status: 'unavailable',
      reason: 'operator-enablement-required',
      inPrincipalPrivateConversation: false,
    });
    expect((await voiceHealth()).inflight).toBe(0);
    expect(await fs.readdir(root)).toEqual(['policy.json']);
  });
  it('copies contained native media to normal inline staging even when disabled, removing host paths', async () => {
    await fs.mkdir(path.join(root, 'attachments'));
    const file = path.join(root, 'attachments', 'note.ogg');
    await fs.writeFile(file, 'original recording');
    const prepared = JSON.parse(
      await prepareVoiceContent(
        request({ attachments: [{ type: 'audio', path: file, localPath: 'attachments/note.ogg' }] }),
      ),
    ) as { attachments: Record<string, unknown>[] };
    expect(prepared.attachments[0].data).toBe(Buffer.from('original recording').toString('base64'));
    expect(prepared.attachments[0]).not.toHaveProperty('path');
    expect(prepared.attachments[0]).not.toHaveProperty('localPath');
  });
  it('gives each of several audio attachments a distinct safe deterministic inbox name', async () => {
    const note = request({
      attachments: [
        { type: 'audio', name: 'note.ogg', data: Buffer.from('one').toString('base64') },
        { type: 'audio', name: 'note.ogg', data: Buffer.from('two').toString('base64') },
      ],
    });
    const first = JSON.parse(await prepareVoiceContent(note)) as { attachments: { name: string }[] };
    const retry = JSON.parse(await prepareVoiceContent(note)) as { attachments: { name: string }[] };
    expect(new Set(first.attachments.map((attachment) => attachment.name)).size).toBe(2);
    expect(retry.attachments.map((attachment) => attachment.name)).toEqual(
      first.attachments.map((attachment) => attachment.name),
    );
  });
  it('keeps operator diagnostics out of agent-accessible commands', async () => {
    expect(lookup('gws-ea-voice-health')).toMatchObject({ access: 'hidden', hostOnly: true });
    expect(await voiceHealth()).toMatchObject({
      schemaVersion: 1,
      enabled: false,
      readiness: 'unavailable',
      reason: 'operator-enablement-required',
      queued: 0,
      inflight: 0,
    });
  });
  it("retains an adapter's explicit media-download failure and the original caption", async () => {
    const prepared = JSON.parse(
      await prepareVoiceContent(
        request({
          text: 'Please handle this',
          attachments: [{ type: 'audio', speech: { status: 'failed', reason: 'media-download-failed' } }],
        }),
      ),
    ) as { text: string; attachments: Record<string, unknown>[] };
    expect(prepared.text).toBe('Please handle this');
    expect(prepared.attachments[0].speech).toEqual({
      status: 'failed',
      reason: 'media-download-failed',
      inPrincipalPrivateConversation: false,
    });
  });

  it('composes no voice section into any agent group', async () => {
    const sections = await getRequiredProjectDocSections({
      id: 'main',
      name: 'main',
      folder: 'main',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    expect(sections.map((section) => section.name)).not.toContain('Voice notes');
  });
});

describe("the mark for the principal's own private conversation", () => {
  const MORGAN_CHAT = 'gchat:users/1001';
  const MORGAN_EMAIL = 'email:morgan.ellery@example.com';

  beforeEach(async () => {
    const at = new Date().toISOString();
    for (const id of [MORGAN_CHAT, MORGAN_EMAIL]) {
      await upsertUser({ id, kind: id.split(':')[0], display_name: 'Morgan Ellery', created_at: at });
      await bindVerifiedPrincipalUser(id, at);
    }
  });

  async function markOf(conversation: Conversation, attachment: Record<string, unknown> = {}): Promise<unknown> {
    const prepared = JSON.parse(
      await prepareVoiceContent(
        request(
          { attachments: [{ type: 'audio', data: Buffer.from('note').toString('base64'), ...attachment }] },
          conversation,
        ),
      ),
    ) as { attachments: { speech: Record<string, unknown> }[] };
    return prepared.attachments[0].speech.inPrincipalPrivateConversation;
  }

  it.each([
    [
      'a verified principal user in their direct message, named by a raw platform handle',
      { ...PRINCIPAL_DM, sender: 'users/1001' },
    ],
    ['a verified principal user in their direct message, named in full', { ...PRINCIPAL_DM, sender: MORGAN_CHAT }],
    [
      'mail on the principal email conversation',
      { channelType: 'email', platformId: 'email:principal', isGroup: false, sender: MORGAN_EMAIL },
    ],
  ] as const)('marks a recording from %s', async (_case, conversation) => {
    expect(await markOf(conversation)).toBe(true);
  });

  it.each([
    [
      "an outsider's email on the inbox",
      { channelType: 'email', platformId: 'email:inbox', isGroup: true, sender: 'email:juno.hale@example.com' },
    ],
    [
      "the principal's own email on an external-email thread",
      { channelType: 'email', platformId: 'email:inbox', isGroup: true, sender: MORGAN_EMAIL },
    ],
    [
      'the principal in a shared space',
      { channelType: 'gchat', platformId: 'spaces/launch', isGroup: true, sender: MORGAN_CHAT },
    ],
    ['someone else in a direct message', { ...PRINCIPAL_DM, sender: 'gchat:users/2002' }],
    ['a direct message with no authenticated sender', PRINCIPAL_DM],
  ] as const)('does not mark a recording from %s', async (_case, conversation) => {
    expect(await markOf(conversation)).toBe(false);
  });

  it('marks a recording the adapter could not fetch', async () => {
    expect(
      await markOf(
        { ...PRINCIPAL_DM, sender: MORGAN_CHAT },
        { data: undefined, speech: { status: 'failed', reason: 'media-download-failed' } },
      ),
    ).toBe(true);
  });
});
