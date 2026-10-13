import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundPreparationRequest } from '../../inbound-preparation.js';

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
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-prepare-test-')));
  paths.data = root;
  vi.stubEnv('GWS_EA_VOICE_POLICY_FILE', path.join(root, 'policy.json'));
  await fs.writeFile(
    path.join(root, 'policy.json'),
    JSON.stringify({ schemaVersion: 1, enabled: false, installationDir: null }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { force: true, recursive: true });
});

function request(content: unknown): InboundPreparationRequest {
  const timestamp = new Date().toISOString();
  return {
    content: JSON.stringify(content),
    channelType: 'gchat',
    instance: 'gchat',
    platformId: 'spaces/principal',
    messageId: 'note',
    timestamp,
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
    messagingGroup: {
      id: 'conversation',
      channel_type: 'gchat',
      platform_id: 'spaces/principal',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: timestamp,
    },
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
      speech: { status: 'unavailable', reason: 'operator-enablement-required' },
    });
    expect(prepared.attachments[1].speech).toEqual({ status: 'unavailable', reason: 'operator-enablement-required' });
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
    expect(prepared.attachments[0].speech).toEqual({ status: 'failed', reason: 'media-download-failed' });
  });
});
