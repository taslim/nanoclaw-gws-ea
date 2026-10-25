/** Each resident instruction file keeps its own cap and a reason for any raise. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHAT_SHARED_SKILLS } from '../modules/gws-ea-chat-agents/shape.js';
import { MAIN_SHARED_SKILLS } from '../modules/gws-ea-main/index.js';
import { registeredGuidanceFiles } from '../modules/gws-ea-profile/guidance.js';
// Every module, so each registered guidance file is known.
import '../modules/index.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** New sizes plus small editing margins; these are file caps, never an aggregate budget. */
const CAPS: Readonly<Record<string, { readonly words: number; readonly reason: string }>> = {
  'src/modules/gws-ea-profile/character.md': {
    words: 750,
    reason:
      "689 words of shared identity and trust: review restored 'repeat', the mistake rule's limits, 'confident without hedging' and the one password rule; then 52 for copyable codes and shaping complex messages to cut the reader's load; plus 9. Role-specific memory stays in main.",
  },
  'src/modules/gws-ea-main/guidance.md': {
    words: 2_420,
    reason:
      '2,339 words: the rewrite kept authority, memory and browser guardrails, and review restored thirteen judgment clauses it had dropped and the rundown gate; plus 81 for local edits.',
  },
  'src/modules/gws-ea-external-email/guidance.md': {
    words: 930,
    reason: '897 words retain the email writing examples and sealed-thread authority, plus 33 for local edits.',
  },
  'src/modules/gws-ea-chat-agents/external-chat.guidance.md': {
    words: 310,
    reason: '293 words of external-chat role and privacy boundaries, plus 17 for local edits.',
  },
  'src/modules/gws-ea-chat-agents/job.guidance.md': {
    words: 300,
    reason: '286 words of job-scoped work, memory and authority, plus 14 for local edits.',
  },
  'src/modules/gws-ea-browser/main-guidance.md': {
    words: 400,
    reason:
      '378 words: the saved-payment-only boundary a replay found missing, the strict disclosure rule and the unknown-destination next step; plus 22. Main-only mechanics stay in its role.',
  },
  'templates/gws-ea/browser/instructions.md': {
    words: 1_040,
    reason: '997 words preserve the sealed browser errand and its safety boundaries, plus 43 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-artifacts.instructions.md': {
    words: 300,
    reason: '285 words of artifact lifecycle and sharing mechanics, plus 15 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-browser.instructions.md': {
    words: 1_250,
    reason: '1,211 words retain the host browser tool protocols and uncertain-outcome rules, plus 39 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-chat-documents.instructions.md': {
    words: 225,
    reason: '213 words retain job document revision and sharing rules, plus 12 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md': {
    words: 360,
    reason: '341 words retain shared chat reporting and scheduling mechanics, plus 19 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-chat-outreach.instructions.md': {
    words: 140,
    reason: '132 words retain principal citations and outreach refusal handling, plus 8 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-chat.instructions.md': {
    words: 225,
    reason: '213 words retain chat handoff, disclosure and WhatsApp linking mechanics, plus 12 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-email-external.instructions.md': {
    words: 510,
    reason: '490 words retain external-email reporting, sign-in and scheduling protocols, plus 20 for local edits.',
  },
  'container/agent-runner/src/mcp-tools/gws-ea-email.instructions.md': {
    words: 55,
    reason: '48 words teach main the email handoff boundary, plus 7 for local edits.',
  },
  'container/skills/gcalendar/instructions.md': {
    words: 145,
    reason: '135 words load the calendar procedure and name its host tools, plus 10 for local edits.',
  },
  'container/skills/gmail/instructions.md': {
    words: 90,
    reason: '83 words load the mail-reading procedure and its pagination rules, plus 7 for local edits.',
  },
  'container/skills/gpeople/instructions.md': {
    words: 85,
    reason: '79 words load the directory lookup procedure and disambiguation rule, plus 6 for local edits.',
  },
  'container/skills/gworkspace/instructions.md': {
    words: 175,
    reason: '165 words load the Google file procedure and its ownership rules, plus 10 for local edits.',
  },
  'container/skills/whatsapp-formatting/instructions.md': {
    words: 320,
    reason: '305 words retain real-number mentions and Markdown handling, plus 15 for local edits.',
  },
};

function filesUnder(relative: string): string[] {
  return fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

/** Discover resident guidance, including newly selected skills; on-demand SKILL.md procedures carry no cap. */
function guidanceFiles(): string[] {
  const moduleFiles = fs
    .readdirSync(path.join(ROOT, 'src/modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('gws-ea-'))
    .flatMap((entry) => filesUnder(`src/modules/${entry.name}`))
    .filter((file) => file.endsWith('guidance.md') || file === 'src/modules/gws-ea-profile/character.md');
  const runnerFiles = filesUnder('container/agent-runner/src/mcp-tools').filter((file) =>
    /^gws-ea.*\.instructions\.md$/u.test(path.posix.basename(file)),
  );
  const templateFiles = filesUnder('templates/gws-ea').filter(
    (file) => path.posix.basename(file) === 'instructions.md',
  );
  const skillFiles = [...new Set([...MAIN_SHARED_SKILLS, ...CHAT_SHARED_SKILLS])]
    .map((skill) => `container/skills/${skill}/instructions.md`)
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
  return [
    ...new Set([...registeredGuidanceFiles(), ...moduleFiles, ...runnerFiles, ...templateFiles, ...skillFiles]),
  ].sort();
}

function uncappedFiles(files: readonly string[]): string[] {
  return files.filter((file) => CAPS[file] === undefined);
}

describe('GWS-EA resident guidance caps', () => {
  const files = guidanceFiles();

  it('lists every resident instruction file exactly once, with no stale entries', () => {
    expect(uncappedFiles(files)).toEqual([]);
    expect(Object.keys(CAPS).filter((file) => !files.includes(file))).toEqual([]);
  });

  it.each(Object.entries(CAPS))('keeps %s within its documented word cap', (file, { words, reason }) => {
    expect(reason.trim(), file).not.toBe('');
    const count = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\s+/u).filter(Boolean).length;
    expect(count, `${file}: ${count} words; cap ${words}. ${reason}`).toBeLessThanOrEqual(words);
  });

  it('detects a new guidance file that has no cap', () => {
    const added = 'src/modules/gws-ea-new-role/guidance.md';
    expect(uncappedFiles([...files, added])).toEqual([added]);
  });
});
