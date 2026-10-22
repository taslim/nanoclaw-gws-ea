import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechResult } from '../../channels/inbound-content.js';
import {
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
  type VerifiedVoiceInstallation,
} from '../../gws-ea/voice-assets.js';
import type { InboundPreparationRequest } from '../../inbound-preparation.js';

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
vi.mock('./config.js', async () => ({
  ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
  readVoiceReadiness: boundary.readiness,
}));
vi.mock('./transcribe.js', async () => ({
  ...(await vi.importActual<typeof import('./transcribe.js')>('./transcribe.js')),
  transcribeAudio: boundary.transcribe,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const recognized: SpeechResult = {
  status: 'recognized',
  text: 'Move it to Thursday—actually Friday, if Remy confirms.',
  language: 'en',
};
/** The stored result: a recording in an unverified sender's conversation carries a false mark. */
const stored = (speech: SpeechResult): SpeechResult => ({ ...speech, inPrincipalPrivateConversation: false });
let root: string;
let installation: VerifiedVoiceInstallation;
let voice: typeof import('./index.js');
let lifecycle: typeof import('../../host-lifecycle.js');

beforeEach(async () => {
  // Queue, stop signal, and lifecycle registrations belong to a fresh host.
  vi.resetModules();
  const db = await import('../../db/index.js');
  const { getRegisteredMigrations } = await import('../../db/migrations/index.js');
  const { gwsEaProfileMigration } = await import('../gws-ea-profile/migration.js');
  await db.runMigrations(await db.initTestDb(), [...getRegisteredMigrations(), gwsEaProfileMigration]);
  boundary.readiness.mockReset();
  boundary.transcribe.mockReset();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lifecycle-test-')));
  boundary.data = root;
  const installationDir = path.join(root, 'verified-installation');
  installation = {
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
  // Verification and real ASR have their own tests. Only these slow boundaries
  // are controlled here; staging, preparation, health, and shutdown are real.
  boundary.readiness.mockResolvedValue({ status: 'ready', enabled: true, installation });
  boundary.transcribe.mockResolvedValue(recognized);
  voice = await import('./index.js');
  lifecycle = await import('../../host-lifecycle.js');
});
afterEach(async () => {
  await lifecycle.stopHostModules();
  await (await import('../../db/index.js')).closeDb();
  await fs.rm(root, { recursive: true, force: true });
});

function request(recordings: string[] = ['original']): InboundPreparationRequest {
  const timestamp = new Date().toISOString();
  return {
    content: JSON.stringify({
      text: 'Original caption',
      sender: 'Principal',
      senderId: 'future-channel:principal',
      attachments: recordings.map((recording) => ({
        type: 'audio',
        filename: 'original.ogg',
        mimeType: 'audio/ogg',
        data: Buffer.from(recording).toString('base64'),
        audioSource: { kind: 'voice-note', forwarded: true, quoted: true },
      })),
    }),
    channelType: 'future-channel',
    instance: 'future-instance',
    platformId: 'conversation',
    messageId: 'source-note',
    authenticatedSender: { userId: 'future-channel:principal', kind: 'human' },
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
      channel_type: 'future-channel',
      platform_id: 'conversation',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: timestamp,
    },
  };
}

function content(prepared: string) {
  return JSON.parse(prepared) as {
    text: string;
    sender: string;
    senderId: string;
    attachments: {
      filename: string;
      name: string;
      data: string;
      audioSource: { kind: 'voice-note'; forwarded: boolean; quoted: boolean };
      speech: SpeechResult;
    }[];
  };
}

describe('enabled voice preparation through the host entrypoint', () => {
  it('recognizes a channel-independent note without changing caption, identity, audio, or provenance', async () => {
    const note = request();
    const originalRequest = structuredClone(note);
    const prepared = content(await voice.prepareVoiceContent(note));
    expect(note).toEqual(originalRequest);
    expect(prepared).toMatchObject({
      text: 'Original caption',
      sender: 'Principal',
      senderId: note.authenticatedSender?.userId,
      attachments: [
        {
          filename: 'original.ogg',
          data: Buffer.from('original').toString('base64'),
          audioSource: { kind: 'voice-note', forwarded: true, quoted: true },
          speech: recognized,
        },
      ],
    });
    expect(boundary.transcribe).toHaveBeenCalledExactlyOnceWith(
      Buffer.from('original'),
      installation,
      path.join(root, '.voice-tmp'),
      expect.any(AbortSignal),
    );
    expect(await voice.voiceHealth()).toMatchObject({
      readiness: 'ready',
      queued: 0,
      inflight: 0,
      lastOutcome: { status: 'recognized' },
      lastFailure: null,
    });
  });

  it('serializes recognition, reports queued work, and rejects a saturated note without ASR', async () => {
    const entered = deferred<void>();
    const finish = deferred<SpeechResult>();
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    boundary.transcribe.mockImplementation(async (audio) => {
      active++;
      peak = Math.max(peak, active);
      order.push(audio.toString());
      try {
        if (audio.toString() === 'note-0') {
          entered.resolve();
          return await finish.promise;
        }
        return recognized;
      } finally {
        active--;
      }
    });
    const first = voice.prepareVoiceContent(request(['note-0']));
    await entered.promise;
    const pending = Array.from({ length: 8 }, (_, index) => voice.prepareVoiceContent(request([`note-${index + 1}`])));
    try {
      expect(await voice.voiceHealth()).toMatchObject({ queued: 8, inflight: 1 });
      const busy = content(await voice.prepareVoiceContent(request(['overflow'])));
      expect(busy.attachments[0]).toMatchObject({
        data: Buffer.from('overflow').toString('base64'),
        speech: { status: 'failed', reason: 'voice-busy' },
      });
      expect(boundary.transcribe).toHaveBeenCalledTimes(1);
      expect(await voice.voiceHealth()).toMatchObject({
        queued: 8,
        inflight: 1,
        lastFailure: { reason: 'voice-busy' },
      });
    } finally {
      finish.resolve(recognized);
      await Promise.all([first, ...pending]);
    }
    expect(order).toEqual(Array.from({ length: 9 }, (_, index) => `note-${index}`));
    expect(peak).toBe(1);
    expect((await Promise.all([first, ...pending])).map((prepared) => content(prepared).attachments[0].speech)).toEqual(
      Array.from({ length: 9 }, () => stored(recognized)),
    );
    expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 0, lastFailure: null });
  });

  it('counts preparation while readiness is pending and respects disablement before recognition', async () => {
    const readiness = deferred<import('./config.js').VoiceReadiness>();
    const entered = deferred<void>();
    boundary.readiness.mockImplementationOnce(() => {
      entered.resolve();
      return readiness.promise;
    });
    const operation = voice.prepareVoiceContent(request());
    await entered.promise;
    try {
      expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 1 });
      boundary.readiness.mockResolvedValue({
        status: 'unavailable',
        enabled: false,
        reason: 'operator-enablement-required',
      });
    } finally {
      readiness.resolve({ status: 'ready', enabled: true, installation });
    }
    expect(content(await operation).attachments[0].speech).toEqual(
      stored({ status: 'unavailable', reason: 'operator-enablement-required' }),
    );
    expect(boundary.transcribe).not.toHaveBeenCalled();
    expect(await voice.voiceHealth()).toMatchObject({ enabled: false, queued: 0, inflight: 0 });
  });

  it.each(['disablement', 'selection change'] as const)('rechecks %s before a second recording', async (change) => {
    const entered = deferred<void>();
    const finish = deferred<SpeechResult>();
    boundary.transcribe.mockImplementationOnce(() => {
      entered.resolve();
      return finish.promise;
    });
    const operation = voice.prepareVoiceContent(request(['first', 'second']));
    await entered.promise;
    if (change === 'disablement')
      boundary.readiness.mockResolvedValue({
        status: 'unavailable',
        enabled: false,
        reason: 'operator-enablement-required',
      });
    else
      boundary.readiness.mockResolvedValue({
        status: 'ready',
        enabled: true,
        installation: { ...installation, installationDir: path.join(root, 'different-selection') },
      });
    finish.resolve(recognized);
    const prepared = content(await operation);
    expect(prepared.attachments[0].speech).toEqual(stored(recognized));
    expect(prepared.attachments[1]).toMatchObject({
      data: Buffer.from('second').toString('base64'),
      speech: {
        status: 'unavailable',
        reason: change === 'disablement' ? 'operator-enablement-required' : 'voice-installation-unhealthy',
      },
    });
    expect(boundary.transcribe).toHaveBeenCalledTimes(1);
    expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 0 });
  });

  it('aborts recognition and drains admitted work through the real host shutdown callback', async () => {
    const entered = deferred<AbortSignal>();
    const finish = deferred<SpeechResult>();
    boundary.transcribe.mockImplementationOnce((_audio, _installation, _temporaryRoot, signal) => {
      entered.resolve(signal);
      return finish.promise;
    });
    const first = voice.prepareVoiceContent(request(['first']));
    const signal = await entered.promise;
    const queued = voice.prepareVoiceContent(request(['queued']));
    let stopped = false;
    const shutdown = lifecycle.stopHostModules().then(() => {
      stopped = true;
    });
    try {
      expect(signal.aborted).toBe(true);
      expect(await voice.voiceHealth()).toMatchObject({ queued: 1, inflight: 1 });
      expect(stopped).toBe(false);
    } finally {
      const { VoiceProcessError } = await import('./process.js');
      finish.reject(new VoiceProcessError('aborted'));
      await shutdown;
    }
    for (const prepared of await Promise.all([first, queued]))
      expect(content(prepared).attachments[0].speech).toEqual(stored({ status: 'failed', reason: 'aborted' }));
    expect(stopped).toBe(true);
    expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 0, lastFailure: { reason: 'aborted' } });
    const later = content(await voice.prepareVoiceContent(request(['later'])));
    expect(later.attachments[0].speech).toEqual(stored({ status: 'failed', reason: 'aborted' }));
    expect(boundary.transcribe).toHaveBeenCalledTimes(1);
    expect(await voice.voiceHealth()).toMatchObject({ queued: 0, inflight: 0 });
  });
});
