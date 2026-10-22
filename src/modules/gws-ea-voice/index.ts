/** Inactive until the operator's shared host policy selects verified assets. */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { extForMime } from '../../attachment-naming.js';
import type { SpeechResult } from '../../channels/inbound-content.js';
import { register } from '../../cli/registry.js';
import { DATA_DIR } from '../../config.js';
import { VOICE_RECIPE_ID } from '../../gws-ea/voice-assets.js';
import { isRecord } from '../../gws-ea/validation.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { registerInboundPreparer, type InboundPreparationRequest } from '../../inbound-preparation.js';
import { EMAIL_CHANNEL_TYPE, PRINCIPAL_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import { isVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { readVoiceReadiness } from './config.js';
import { VoiceProcessError } from './process.js';
import { readOriginalAudio, VoiceMediaError } from './staging.js';
import { transcribeAudio, VoiceRecognitionError } from './transcribe.js';

const MAX_PENDING_NOTES = 8;
const stop = new AbortController();
let tail: Promise<void> = Promise.resolve();
let queued = 0;
let inflight = 0;
let lastOutcome: { status: SpeechResult['status']; at: string } | null = null;
let lastFailure: { reason: string; at: string } | null = null;

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function failureReason(error: unknown): string {
  if (error instanceof VoiceMediaError || error instanceof VoiceProcessError || error instanceof VoiceRecognitionError)
    return error.code;
  return 'recognition-failed';
}

/**
 * Whether a recording came in the principal's own private conversation: mail
 * on their own email conversation, or a verified principal user in a direct
 * message. An external-email thread is the inbox's, even for the principal's
 * own mail, and a shared space is never private.
 */
async function inPrincipalPrivateConversation(request: InboundPreparationRequest): Promise<boolean> {
  const conversation = request.messagingGroup;
  if (conversation.channel_type === EMAIL_CHANNEL_TYPE && conversation.platform_id === PRINCIPAL_PLATFORM_ID)
    return true;
  const handle = request.authenticatedSender?.userId;
  if (conversation.is_group !== 0 || !handle) return false;
  return isVerifiedPrincipalUser(handle.includes(':') ? handle : `${conversation.channel_type}:${handle}`);
}

function observed(speech: SpeechResult): void {
  const at = new Date().toISOString();
  lastOutcome = { status: speech.status, at };
  if (speech.status === 'recognized') lastFailure = null;
  else if (speech.status === 'failed') lastFailure = { reason: speech.reason ?? 'recognition-failed', at };
}

async function prepareRecord(
  request: InboundPreparationRequest,
  content: Record<string, unknown>,
  attachments: Record<string, unknown>[],
  blocked?: 'voice-busy' | 'aborted',
): Promise<string> {
  const readiness = await readVoiceReadiness();
  const principals = await inPrincipalPrivateConversation(request);
  const otherNames = new Set(
    Array.isArray(content.attachments)
      ? content.attachments
          .map(record)
          .filter((attachment) => attachment !== undefined && !attachments.includes(attachment))
          .map((attachment) => attachment?.name)
          .filter((name): name is string => typeof name === 'string')
      : [],
  );
  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const sourceSpeech = record(attachment.speech);
    if (
      sourceSpeech?.status === 'failed' &&
      typeof attachment.data !== 'string' &&
      typeof attachment.path !== 'string'
    ) {
      const reason =
        typeof sourceSpeech.reason === 'string' && /^[a-z0-9-]{1,80}$/.test(sourceSpeech.reason)
          ? sourceSpeech.reason
          : 'media-download-failed';
      const failure: SpeechResult = { status: 'failed', reason, inPrincipalPrivateConversation: principals };
      attachment.speech = failure;
      delete attachment.localPath;
      observed(failure);
      continue;
    }
    let speech: SpeechResult;
    // A bad recording must reach the normal turn as a limitation, not reject
    // routing or disguise a prefix as a complete instruction.
    /* eslint-disable no-catch-all/no-catch-all -- media errors become terminal attachment outcomes */
    try {
      if (stop.signal.aborted) throw new VoiceProcessError('aborted');
      const original = await readOriginalAudio(attachment, path.join(DATA_DIR, 'attachments'));
      attachment.data = original.toString('base64');
      delete attachment.path;
      delete attachment.localPath;
      const originalName = attachment.name ?? attachment.filename;
      if (attachment.filename === undefined && typeof originalName === 'string') attachment.filename = originalName;
      let name = `voice-${index + 1}.${extForMime(attachment.mimeType) || 'bin'}`;
      while (otherNames.has(name)) name = `_${name}`;
      otherNames.add(name);
      attachment.name = name;
      if (readiness.status !== 'ready') speech = { status: 'unavailable', reason: readiness.reason };
      else if (blocked) speech = { status: 'failed', reason: blocked };
      else {
        // Disablement or asset selection can change while a long note runs.
        // Re-check before every next recording; never silently switch models.
        const current = await readVoiceReadiness();
        if (current.status !== 'ready') speech = { status: 'unavailable', reason: current.reason };
        else if (current.installation.installationDir !== readiness.installation.installationDir)
          speech = { status: 'unavailable', reason: 'voice-installation-unhealthy' };
        else
          speech = await transcribeAudio(
            original,
            readiness.installation,
            path.join(await realpath(DATA_DIR), '.voice-tmp'),
            stop.signal,
          );
      }
    } catch (error) {
      speech =
        readiness.status === 'unavailable'
          ? { status: 'unavailable', reason: readiness.reason }
          : { status: 'failed', reason: failureReason(error) };
    }
    /* eslint-enable no-catch-all/no-catch-all */
    delete attachment.path;
    delete attachment.localPath;
    attachment.speech = { ...speech, inPrincipalPrivateConversation: principals } satisfies SpeechResult;
    observed(speech);
  }
  return JSON.stringify(content);
}

/** Native content-only seam: caption, authority, and adapter source facts survive. */
export async function prepareVoiceContent(request: InboundPreparationRequest): Promise<string> {
  let value: unknown;
  try {
    value = JSON.parse(request.content) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return request.content;
    throw error;
  }
  const content = record(value);
  if (!content || !Array.isArray(content.attachments)) return request.content;
  const audio = content.attachments
    .map(record)
    .filter(
      (attachment): attachment is Record<string, unknown> =>
        attachment !== undefined &&
        (attachment.type === 'audio' ||
          attachment.type === 'voice' ||
          (typeof attachment.mimeType === 'string' && attachment.mimeType.toLowerCase().startsWith('audio/'))),
    );
  if (audio.length === 0) return request.content;
  if (queued >= MAX_PENDING_NOTES || stop.signal.aborted) {
    inflight++;
    try {
      return await prepareRecord(request, content, audio, stop.signal.aborted ? 'aborted' : 'voice-busy');
    } finally {
      inflight--;
    }
  }
  queued++;
  const operation = tail.then(async () => {
    queued--;
    inflight++;
    try {
      return await prepareRecord(request, content, audio);
    } finally {
      inflight--;
    }
  });
  tail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function voiceHealth(): Promise<{
  schemaVersion: 1;
  recipe: string;
  enabled: boolean;
  readiness: 'ready' | 'unavailable';
  reason?: string;
  queued: number;
  inflight: number;
  lastOutcome: typeof lastOutcome;
  lastFailure: typeof lastFailure;
}> {
  const readiness = await readVoiceReadiness();
  return {
    schemaVersion: 1,
    recipe: VOICE_RECIPE_ID,
    enabled: readiness.enabled,
    readiness: readiness.status,
    ...(readiness.status === 'unavailable' ? { reason: readiness.reason } : {}),
    queued,
    inflight,
    lastOutcome,
    lastFailure,
  };
}

registerInboundPreparer(prepareVoiceContent);
onHostStart(({ signal }) => {
  if (signal.aborted) stop.abort();
  else signal.addEventListener('abort', () => stop.abort(), { once: true });
});
onHostShutdown(async () => {
  stop.abort();
  await tail;
});
register({
  name: 'gws-ea-voice-health',
  description: 'Report host voice policy, readiness, and observed recognition outcomes.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    const keys = Object.keys(raw);
    if (keys.length) throw new Error(`Unknown voice field: --${keys[0]}`);
    return undefined;
  },
  handler: async () => voiceHealth(),
});
