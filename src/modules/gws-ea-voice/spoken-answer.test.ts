/**
 * Speech never answers a request. On a channel whose requests are text
 * (Google Chat under the assistant's account), the bridge decides whether a
 * message answers a request from the words the person typed, before the host
 * prepares any recording. A quote-reply to an approval request whose only
 * content is a recording saying "approve" is therefore routed as an ordinary
 * message, its speech is recognized afterwards as source material, and the
 * approval stays open. The typed answer beside it proves the request was
 * answerable all along.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Message, parseMarkdown, type Adapter, type Attachment } from 'chat';

import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import type { SpeechResult } from '../../channels/inbound-content.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getRegisteredMigrations } from '../../db/migrations/index.js';
import { createPendingApproval, createSession } from '../../db/sessions.js';
import {
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
  type VerifiedVoiceInstallation,
} from '../../gws-ea/voice-assets.js';
import { gwsEaProfileMigration } from '../gws-ea-profile/migration.js';

const boundary = vi.hoisted(() => ({
  data: '',
  readiness: vi.fn<typeof import('./config.js').readVoiceReadiness>(),
  transcribe: vi.fn<typeof import('./transcribe.js').transcribeAudio>(),
}));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  get DATA_DIR() {
    return boundary.data;
  },
}));
vi.mock('../../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
vi.mock('./config.js', async () => ({
  ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
  readVoiceReadiness: boundary.readiness,
}));
vi.mock('./transcribe.js', async () => ({
  ...(await vi.importActual<typeof import('./transcribe.js')>('./transcribe.js')),
  transcribeAudio: boundary.transcribe,
}));

import { prepareVoiceContent } from './index.js';

const DM = 'fixture:spaces/AAAAmorgan';
const DM_THREAD = `${DM}:dm`;
const MORGAN = {
  userId: 'users/1001',
  userName: 'Morgan Ellery',
  fullName: 'Morgan Ellery',
  isBot: false,
  isMe: false,
};
const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];
const SPOKEN: SpeechResult = { status: 'recognized', text: 'Approve.', language: 'en' };

function installationAt(installationDir: string): VerifiedVoiceInstallation {
  return {
    installationDir,
    ffmpeg: path.join(installationDir, 'bin/ffmpeg'),
    whisperCli: path.join(installationDir, 'bin/whisper-cli'),
    model: path.join(installationDir, 'models', VOICE_MODEL_CATALOG.base.filename),
    vad: path.join(installationDir, 'models', VOICE_SOURCE_ARTIFACTS.vad.filename),
    receipt: {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      platform: 'darwin',
      architecture: 'arm64',
      model: 'base',
      builtAt: new Date().toISOString(),
      artifacts: {
        ffmpeg: { file: 'bin/ffmpeg', size: 1, sha256: 'a'.repeat(64) },
        whisperCli: { file: 'bin/whisper-cli', size: 1, sha256: 'b'.repeat(64) },
        model: {
          file: `models/${VOICE_MODEL_CATALOG.base.filename}`,
          size: VOICE_MODEL_CATALOG.base.size,
          sha256: VOICE_MODEL_CATALOG.base.sha256,
        },
        vad: {
          file: `models/${VOICE_SOURCE_ARTIFACTS.vad.filename}`,
          size: VOICE_SOURCE_ARTIFACTS.vad.size,
          sha256: VOICE_SOURCE_ARTIFACTS.vad.sha256,
        },
      },
    },
  };
}

let root: string;

beforeEach(async () => {
  await runMigrations(await initTestDb(), [...getRegisteredMigrations(), gwsEaProfileMigration]);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-spoken-answer-test-')));
  boundary.data = root;
  boundary.readiness.mockResolvedValue({
    status: 'ready',
    enabled: true,
    installation: installationAt(path.join(root, 'verified-installation')),
  });
  boundary.transcribe.mockResolvedValue(SPOKEN);
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-main', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
  await createSession({
    id: 'sess-main',
    agent_group_id: 'ag-main',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  });
  await createPendingApproval({
    approval_id: 'appr-payment',
    request_id: 'request-appr-payment',
    action: 'install_packages',
    payload: '{}',
    created_at: now,
    title: 'Request',
    question: 'Pay Remy Vance $120?',
    options_json: JSON.stringify(APPROVAL_OPTIONS),
  });
});

afterEach(async () => {
  await closeDb();
  boundary.readiness.mockReset();
  boundary.transcribe.mockReset();
  await fs.rm(root, { recursive: true, force: true });
});

async function textRequestBridge() {
  let chat: import('chat').ChatInstance | undefined;
  let posts = 0;
  const routed: InboundMessage[] = [];
  const actions: Parameters<ChannelSetup['onAction']>[] = [];
  const adapter = {
    name: 'fixture',
    userName: 'noel',
    initialize: async (instance: import('chat').ChatInstance) => {
      chat = instance;
    },
    channelIdFromThreadId: (threadId: string) => threadId.slice(0, threadId.lastIndexOf(':')),
    isDM: (threadId: string) => threadId.endsWith(':dm'),
    postMessage: async (threadId: string) => {
      posts += 1;
      return { id: `spaces/AAAA/messages/noel.${posts}`, threadId, raw: { createTime: new Date().toISOString() } };
    },
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    redelivers: true,
    extractReplyContext: (raw) => {
      const quote = raw.quote as { name: string } | undefined;
      return quote ? { sender: 'Noel', text: 'Pay Remy Vance $120?', id: quote.name } : null;
    },
    textRequests: { postedAt: (raw) => new Date((raw as { createTime: string }).createTime) },
  });
  await bridge.setup({
    onInbound: (_platformId, _threadId, message) => {
      routed.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: (...call) => {
      actions.push(call);
    },
  });
  const request = await bridge.deliver(DM, null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'appr-payment',
      title: 'Request',
      question: 'Pay Remy Vance $120?',
      options: APPROVAL_OPTIONS,
    },
  });
  return {
    bridge,
    routed,
    actions,
    /** Morgan quotes the request, with these words and recordings. */
    async quote(id: string, text: string, attachments: Attachment[] = []) {
      await chat!.processMessage(
        adapter,
        DM_THREAD,
        new Message({
          id,
          threadId: DM_THREAD,
          text,
          formatted: parseMarkdown(text),
          raw: { quote: { name: request } },
          author: MORGAN,
          metadata: { dateSent: new Date(), edited: false },
          attachments,
        }),
      );
    },
  };
}

describe('a recording that quotes an approval request', () => {
  it('answers nothing, though its speech says approve, while a typed approve answers', async () => {
    const desk = await textRequestBridge();
    try {
      await desk.quote('spaces/AAAA/messages/morgan.1', '', [
        { type: 'audio', name: 'note.ogg', mimeType: 'audio/ogg', fetchData: async () => Buffer.from('spoken') },
      ]);

      expect(desk.actions).toEqual([]);
      expect(desk.routed.map((message) => message.id)).toEqual(['spaces/AAAA/messages/morgan.1']);
      const [spoken] = desk.routed;
      const timestamp = new Date().toISOString();
      const prepared = JSON.parse(
        await prepareVoiceContent({
          content: JSON.stringify(spoken!.content),
          channelType: 'fixture',
          instance: 'fixture',
          platformId: DM,
          messageId: spoken!.id,
          timestamp,
          ...(spoken!.authenticatedSender === undefined ? {} : { authenticatedSender: spoken!.authenticatedSender }),
          session: {
            id: 'sess-main',
            agent_group_id: 'ag-main',
            messaging_group_id: 'mg-dm',
            thread_id: null,
            agent_provider: null,
            status: 'active',
            container_status: 'running',
            last_active: timestamp,
            created_at: timestamp,
          },
          messagingGroup: {
            id: 'mg-dm',
            channel_type: 'fixture',
            platform_id: DM,
            name: null,
            is_group: 0,
            unknown_sender_policy: 'strict',
            created_at: timestamp,
          },
        }),
      ) as { text: string; attachments: { speech: SpeechResult }[] };

      expect(prepared.text).toBe('');
      expect(prepared.attachments[0]!.speech).toMatchObject({ status: 'recognized', text: 'Approve.' });

      await desk.quote('spaces/AAAA/messages/morgan.2', 'approve');

      expect(desk.actions.map(([questionId, value]) => [questionId, value])).toEqual([['appr-payment', 'approve']]);
      expect(desk.routed).toHaveLength(1);
    } finally {
      await desk.bridge.teardown();
    }
  });
});
