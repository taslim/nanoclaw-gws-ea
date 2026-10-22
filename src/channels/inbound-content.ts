/** Source facts asserted by an adapter, rather than inferred from a speaker. */
export interface AudioSource {
  kind: 'voice-note' | 'audio';
  forwarded?: boolean;
  quoted?: boolean;
}

/** A terminal outcome for one recording. Recognized wording is never rewritten. */
export type SpeechResult = (
  | { status: 'recognized'; text: string; language: string }
  | { status: 'unavailable' | 'no-speech' | 'failed'; reason?: string }
) & {
  /** Diagnostic identifiers stay inside stored content, outside ordinary replies. */
  engine?: string;
  model?: string;
  /**
   * The recording came in the principal's own private conversation, as the
   * host judged when it arrived, so a status line may name who can change
   * voice notes. Absent reads as anywhere else.
   */
  inPrincipalPrivateConversation?: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Conversation context includes transcriptions as message text. This must never
 * be used for command classification, platform mentions, or regex engagement.
 */
export function parseInboundContent(raw: string): {
  text: string;
  sender: string | null;
  senderId: string | null;
} {
  try {
    return extractInboundContent(JSON.parse(raw) as unknown);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { text: raw, sender: null, senderId: null };
  }
}

/** Read already parsed content without parsing retained media a second time. */
export function extractInboundContent(value: unknown): {
  text: string;
  sender: string | null;
  senderId: string | null;
} {
  const parsed = record(value);
  if (!parsed) return { text: '', sender: null, senderId: null };

  const parts = [typeof parsed.text === 'string' ? parsed.text : ''];
  if (Array.isArray(parsed.attachments)) {
    for (const value of parsed.attachments) {
      const attachment = record(value);
      const speech = record(attachment?.speech);
      if (speech?.status !== 'recognized' || typeof speech.text !== 'string' || !speech.text) continue;
      const source = record(attachment?.audioSource);
      if (source?.forwarded === true) parts.push('[Forwarded]');
      if (source?.quoted === true) parts.push('[Quoted]');
      parts.push(speech.text);
    }
  }
  return {
    text: parts.filter((part) => part.length > 0).join('\n'),
    sender: typeof parsed.sender === 'string' ? parsed.sender : null,
    senderId: typeof parsed.senderId === 'string' ? parsed.senderId : null,
  };
}
