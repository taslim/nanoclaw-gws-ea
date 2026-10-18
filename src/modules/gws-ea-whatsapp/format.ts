interface TextSegment {
  content: string;
  isProtected: boolean;
}

function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

// WhatsApp tags `@<phone-digits>` (5–15 digit local part — covers short test
// numbers up to ITU E.164 max). A leading `+` is accepted but stripped so
// the literal in text matches the digits in the JID — WhatsApp clients
// scan the rendered text for `@<digits>` and cross-reference it with the
// contextInfo.mentionedJid list to draw the bold/clickable tag.
const MENTION_RE = /(^|[^\w@+])@\+?(\d{5,15})(?!\d)/g;

/** Extract `@<digits>` mentions from text and normalize them. */
export function parseWhatsAppMentions(text: string): { text: string; mentions: string[] } {
  const mentions = new Set<string>();
  const out = text.replace(MENTION_RE, (_full, lead: string, digits: string) => {
    mentions.add(`${digits}@s.whatsapp.net`);
    return `${lead}@${digits}`;
  });
  return { text: out, mentions: [...mentions] };
}

/**
 * Convert Claude's markdown to WhatsApp-native formatting and extract any
 * `@<phone>` mentions. Code-block regions are passed through untouched so
 * phone-like sequences inside code aren't tagged.
 */
export function formatWhatsApp(text: string): { text: string; mentions: string[] } {
  const segments = splitProtectedRegions(text);
  const mentions = new Set<string>();
  const out = segments
    .map(({ content, isProtected }) => {
      if (isProtected) return content;
      const transformed = transformForWhatsApp(content);
      const { text: withMentions, mentions: found } = parseWhatsAppMentions(transformed);
      for (const m of found) mentions.add(m);
      return withMentions;
    })
    .join('');
  return { text: out, mentions: [...mentions] };
}
