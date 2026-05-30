import path from 'path';

import type { InboundEvent } from './channels/adapter.js';
import { DATA_DIR } from './config.js';
import { log } from './log.js';
import { transcribeAudio } from './transcription.js';

interface MaybeAttachment {
  type?: unknown;
  mimeType?: unknown;
  data?: unknown;
  name?: unknown;
  filename?: unknown;
  localPath?: unknown;
}

function isAudioAttachment(att: MaybeAttachment): boolean {
  if (typeof att.mimeType === 'string' && att.mimeType.startsWith('audio/')) return true;
  if (typeof att.type === 'string' && att.type === 'audio') return true;
  return false;
}

function attachmentHint(att: MaybeAttachment): string | undefined {
  if (typeof att.name === 'string' && att.name) return att.name;
  if (typeof att.filename === 'string' && att.filename) return att.filename;
  return undefined;
}

async function transcribeOne(att: MaybeAttachment): Promise<string | null> {
  const hint = attachmentHint(att);
  try {
    if (typeof att.data === 'string') {
      const buf = Buffer.from(att.data, 'base64');
      return await transcribeAudio(buf, hint);
    }
    if (typeof att.localPath === 'string') {
      const abs = path.resolve(DATA_DIR, att.localPath);
      if (!abs.startsWith(DATA_DIR + path.sep)) {
        log.warn('Audio attachment localPath escapes DATA_DIR', { localPath: att.localPath });
        return null;
      }
      return await transcribeAudio({ path: abs }, hint);
    }
    log.warn('Audio attachment has no decodable bytes', { hint });
    return null;
  } catch (err) {
    log.warn('Audio transcription threw unexpectedly', { hint, err });
    return null;
  }
}

/**
 * Runs once per inbound event at the top of `routeInbound` — a fan-out to N
 * agent groups still triggers exactly one ffmpeg+whisper invocation.
 */
export async function transcribeInboundAudio(event: InboundEvent): Promise<void> {
  const raw = event.message.content;
  if (typeof raw !== 'string') return;
  // Heuristic pre-filter — covers both `mimeType: "audio/..."` and
  // `type: "audio"` shapes. The real guard is `isAudioAttachment` below.
  if (!raw.includes('audio/') && !raw.includes('"audio"')) return;

  let parsed: { text?: unknown; attachments?: MaybeAttachment[] } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const attachments = parsed.attachments;
  if (!Array.isArray(attachments)) return;

  const audioIndices: number[] = [];
  for (let i = 0; i < attachments.length; i++) {
    if (isAudioAttachment(attachments[i])) audioIndices.push(i);
  }
  if (audioIndices.length === 0) return;

  const transcripts = await Promise.all(audioIndices.map((i) => transcribeOne(attachments[i])));

  audioIndices.forEach((i, k) => {
    const att = attachments[i];
    const transcript = transcripts[k];
    const entry: Record<string, unknown> = { type: 'audio-transcript' };
    const name = attachmentHint(att);
    if (name) entry.name = name;
    if (typeof att.mimeType === 'string') entry.mimeType = att.mimeType;
    if (transcript) {
      entry.text = transcript;
    } else {
      entry.status = 'unavailable';
    }
    attachments[i] = entry;
  });

  event.message.content = JSON.stringify(parsed);
}
