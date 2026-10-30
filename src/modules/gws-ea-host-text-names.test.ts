/**
 * Host text names only what its reader has. GWS-EA's host
 * modules write the tool answers, refusals, notes and notices agents read. A
 * text that names a tool, a gog command or an `ncl` command its reader does
 * not hold sends that reader down a path that fails, so every prose string and
 * template literal in the non-test, non-fixture sources under
 * `src/modules/gws-ea-*` is read with the TypeScript compiler, and:
 *
 * - each snake_case word is a runner tool, a word the runner's tool
 *   definitions use, a browser operational code, or listed for its file;
 * - each `gog <service> <command>` is one of the commands gog is given;
 * - each `ncl <resource> [<verb>]` is registered;
 * - each tool, gog command and `ncl` command a text names is one its reader
 *   holds. A reader is a capability set: main, external-email, the browser, a
 *   delegator other than main, and the principal, who holds none. A file whose
 *   texts all go to one reader is listed with it. In any other file, a text
 *   that names one carries a reader tag, `/** to: <reader> *\/` or a JSDoc
 *   block whose last line is `to: <reader>`, on the literal or on a
 *   declaration or statement around it; a text that names nothing needs none.
 *   A tag may name more than one reader, `to: main, delegator`, for an answer
 *   any of them may receive. A mention attributed to another agent ("main
 *   records it with `record_purchase_outcome`") is listed for its file, with
 *   its reason.
 *
 * Operator logs (the first argument of `log.*`) are not read. A capability's
 * description (`registerCapability`) lists the tools its key grants to whoever
 * configures a group, so its names must exist, but no reader is checked.
 *
 * Resident guidance and instruction Markdown also names only `ncl` commands
 * every listed reader can use. Its other names are not scanned:
 * a backticked `browser` may name the destination rather than the browser tool.
 *
 * What it cannot see: a tool named in plain words ("the Google tool"); a real
 * command used wrongly (`ncl matters place` where a new matter needs `open`);
 * a text built in one module and sent from another, which is checked
 * against the reader of the file it is written in; and a name assembled at
 * run time (`${tool}`), since every interpolation is blanked before the scan.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveCapabilities, SHELL_CAPABILITY } from '../capabilities.js';
import { MAIN_CHAT_CAPABILITY, MAIN_SHARED_SKILLS, mainCapabilitySelection } from './gws-ea-main/index.js';
import { registeredGuidanceFiles } from './gws-ea-profile/guidance.js';
import { noVerifiedPrincipalMessage } from './gws-ea-profile/approval-wording.js';
import { GROUP_SCOPE_RESOURCES, listCommands, lookup } from '../cli/registry.js';
import { runnerToolCapabilities, runnerToolVocabulary } from '../test-utils/runner-tools.js';
import { BROWSER_CAPABILITIES } from './gws-ea-browser/group.js';
import { BROWSER_DELEGATE_CAPABILITY, PURCHASE_OUTCOME_CAPABILITY } from './gws-ea-browser/guidance.js';
import { OPERATIONAL_CODES } from './gws-ea-browser/operational-codes.js';
import { EXTERNAL_EMAIL_CAPABILITIES } from './gws-ea-external-email/group.js';
import { CHAT_SHARED_SKILLS, EXTERNAL_CHAT_CAPABILITIES, JOB_CHAT_CAPABILITIES } from './gws-ea-chat-agents/shape.js';
import { GOG_COMMANDS } from './gws-ea-google/index.js';
// They register the `ncl` commands host texts name.
import '../cli/resources/index.js';
import './gws-ea-profile/index.js';
import './gws-ea-people/index.js';
import './gws-ea-preferences/index.js';
import './gws-ea-privacy/index.js';
import './gws-ea-matters/index.js';
import './gws-ea-chats/directory.js';
// Every module, so each registered guidance file is known.
import './index.js';

const MODULES = path.resolve(import.meta.dirname);
const ROOT = path.resolve(MODULES, '../..');

const READERS = ['main', 'external-email', 'external-chat', 'job', 'browser', 'delegator', 'principal'] as const;
type Reader = (typeof READERS)[number];

function isReader(name: string): name is Reader {
  return (READERS as readonly string[]).includes(name);
}

/** What a reader holds: its capability keys, and how far its `ncl` reaches. */
interface Holdings {
  readonly keys: ReadonlySet<string>;
  readonly ncl: 'global' | 'group' | 'none';
}

const DELEGATE_KEYS = [BROWSER_DELEGATE_CAPABILITY, PURCHASE_OUTCOME_CAPABILITY];

const HOLDINGS: Readonly<Record<Reader, Holdings>> = {
  // Create/update reconciliation stores main's current release defaults; browser access grants both delegate keys:
  // policy version 1 lists main alone, and main records every unconfirmed purchase.
  main: { keys: new Set([...mainCapabilitySelection(), MAIN_CHAT_CAPABILITY, ...DELEGATE_KEYS]), ncl: 'global' },
  'external-email': { keys: new Set(EXTERNAL_EMAIL_CAPABILITIES), ncl: 'none' },
  'external-chat': { keys: new Set(EXTERNAL_CHAT_CAPABILITIES), ncl: 'none' },
  job: { keys: new Set(JOB_CHAT_CAPABILITIES), ncl: 'none' },
  browser: { keys: new Set(BROWSER_CAPABILITIES), ncl: 'none' },
  // Another group the browser setting lists, as the operator creates one: every default key, what the
  // setting grants, and `cli_scope: group`.
  delegator: { keys: new Set([...resolveCapabilities('all', 'delegator'), ...DELEGATE_KEYS]), ncl: 'group' },
  principal: { keys: new Set(), ncl: 'none' },
};

/** Where a text goes and what it may name besides what its reader holds. */
interface Policy {
  /** Each file whose texts all go to one reader, relative to `src/modules`. */
  readonly readers: Readonly<Record<string, Reader>>;
  /** Snake_case words that are no tool, tool field or code, by file, each with what it is. */
  readonly words: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Names a text attributes to another agent, by file, each with why its reader may read it. */
  readonly attributed: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const POLICY: Policy = {
  readers: {
    // `ncl matters` help and answers, and the notes of matters' looks and daily sync.
    'gws-ea-matters/index.ts': 'main',
    'gws-ea-matters/looks.ts': 'main',
    'gws-ea-matters/sync.ts': 'main',
    'gws-ea-matters/tool-matter.ts': 'main',
    // The answers of main's calendar tools.
    'gws-ea-meetings/principal-events.ts': 'main',
    'gws-ea-chats/context.ts': 'external-chat',
    'gws-ea-chat-agents/docs.ts': 'job',
    // `ncl people` and `ncl preferences` help, answers and guidance.
    'gws-ea-people/index.ts': 'main',
    'gws-ea-preferences/index.ts': 'main',
  },
  words: {
    'gws-ea-artifacts/db.ts': {
      head_revision: 'a column in the host-only SQL compare-and-swap condition, not prose sent to an agent',
    },
    'gws-ea-artifacts/sharing.ts': {
      gws_ea_artifact_shares: 'a host-only SQL table named in the shared JOIN fragment',
      gws_ea_artifact_revisions: 'a host-only SQL table named in the shared JOIN fragment',
    },
    'gws-ea-chats/handoffs.ts': {
      delivered_session_id: 'a column in the optional SQL delivery filter, read only by the host',
    },
    'gws-ea-workspace/docs-api.ts': {
      nc_job_doc: 'the Drive app-property key used to find a document after an uncertain create',
    },
    'gws-ea-browser/authentication-submit.ts': {
      not_inserted: 'a status in the script the host runs in the page, which only the host reads',
    },
    'gws-ea-browser/purchase-wording.ts': {
      authority_id: "a field of the commit the host queues itself; its refusal reaches the host's queue",
    },
    'gws-ea-chats/context.ts': {
      sender_id: 'an attribute of each message tag the chat agent reads, written by the runner formatter',
    },
    'gws-ea-chat/subscription.ts': {
      target_resource: "a field in the filter the host sends Google's Workspace Events API",
    },
    'gws-ea-inbox/render.ts': {
      gmail_quote: 'an HTML class in the reply markup, as Gmail writes a quoted message',
      gmail_attr: 'an HTML class in the reply markup, as Gmail writes the line above a quote',
    },
    'gws-ea-profile/index.ts': {
      calendar_access: "a field of `ncl principal-addresses list`'s answer",
      calendar_checked_at: "a field of `ncl principal-addresses list`'s answer",
    },
    'gws-ea-profile/wiring-policy.ts': {
      sender_scope: 'a wiring field, as `ncl wirings` names it, in the refusal of a wrong main wiring',
      session_mode: 'a wiring field, as `ncl wirings` names it, in the refusal of a wrong main wiring',
    },
  },
  attributed: {
    'gws-ea-browser/disclosures.ts': {
      'ncl private-values list': 'it says main reads the ids there, and that another agent asks main',
    },
  },
};

/** One prose literal, with the readers its tag names, if any. */
interface HostText {
  readonly line: number;
  readonly text: string;
  readonly tag: readonly string[] | undefined;
  /** Inside a `registerCapability` call: its names must exist, and no reader is checked. */
  readonly registry: boolean;
}

/** A reader tag: `/** to: main *\/`, or a JSDoc block whose last line is `to: main`. */
const TAG = /(?:^\/\*\*|\n\s*\*) to: ([a-z-]+(?:, [a-z-]+)*)(?: |\n\s*)\*\/$/u;
const SQL = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|WHERE)\b/u;
/** A column list, `id, title, created_at`: identifiers only. */
const COLUMNS = /^\s*[a-z_]+(?:\s*,\s*[a-z_]+)*\s*$/u;

function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join('');
  }
  return undefined;
}

function isProse(text: string): boolean {
  return text.includes(' ') && /[A-Za-z]/u.test(text) && !SQL.test(text) && !COLUMNS.test(text);
}

/** The prose literals of one source, operator logs left out. */
function hostTexts(file: string, text: string): HostText[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tagOf = (node: ts.Node): string[] | undefined => {
    for (let at: ts.Node = node; !ts.isSourceFile(at); at = at.parent) {
      for (const range of ts.getLeadingCommentRanges(text, at.getFullStart()) ?? []) {
        const tag = TAG.exec(text.slice(range.pos, range.end))?.[1];
        if (tag !== undefined) return tag.split(', ');
      }
    }
    return undefined;
  };
  // A description may be written out in a constant the call reads, as Google's keys' are.
  const describing = new Set<string>();
  const collect = (node: ts.Node, inCall: boolean): void => {
    const call = inCall || (ts.isCallExpression(node) && node.expression.getText() === 'registerCapability');
    if (call && ts.isIdentifier(node)) describing.add(node.text);
    ts.forEachChild(node, (child) => collect(child, call));
  };
  collect(source, false);
  const texts: HostText[] = [];
  const visit = (node: ts.Node, registry: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'log') {
        for (const argument of node.arguments.slice(1)) visit(argument, registry);
        return;
      }
      if (callee.getText() === 'registerCapability') registry = true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && describing.has(node.name.text)) registry = true;
    const value = literalText(node);
    if (value !== undefined && isProse(value)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      texts.push({ line: line + 1, text: value, tag: tagOf(node), registry });
    }
    ts.forEachChild(node, (child) => visit(child, registry));
  };
  visit(source, false);
  return texts;
}

/** A name a text uses: a word that has only to exist, or a tool or command a reader must hold. */
interface Mention {
  /** As the text writes it: `free_time`, `gog calendar events`, `ncl matters open`. */
  readonly name: string;
  /** Why it names nothing real, when it does not. */
  readonly unknown?: string;
  /** Whether a reader holds it; absent for a word that only has to exist. */
  readonly held?: (holdings: Holdings) => boolean;
}

const TOOL_KEYS = runnerToolCapabilities();
const VOCABULARY = runnerToolVocabulary();
const GOG_KEYS: ReadonlyMap<string, string> = new Map(
  Object.entries(GOG_COMMANDS).flatMap(([key, commands]) => commands.map((command) => [command, key] as const)),
);
const GOG_SERVICES = new Set([...GOG_KEYS.keys()].map((command) => command.split('.')[0]));

const SNAKE = /(?<![\w.$/-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w(-])/gu;
const BACKTICKED = /`([a-z]+)`/gu;
const COMMAND = /\b(gog|ncl) ([a-z][a-z-]*)((?: [a-z][a-z-]*(?:\|[a-z][a-z-]*)*){0,2})/gu;

function toolMention(name: string, keys: ReadonlySet<string>): Mention {
  return { name, held: (holdings) => [...keys].some((key) => holdings.keys.has(key)) };
}

function gogMention(service: string, words: readonly string[]): Mention {
  if (!GOG_SERVICES.has(service)) {
    return { name: `gog ${[service, ...words.slice(0, 1)].join(' ')}`, unknown: 'not a command gog is given' };
  }
  const hasGog = (holdings: Holdings, keys: readonly string[]): boolean =>
    holdings.keys.has(SHELL_CAPABILITY) && keys.some((key) => holdings.keys.has(key));
  for (let length = words.length; length > 0; length -= 1) {
    const path = [service, ...words.slice(0, length)];
    const key = GOG_KEYS.get(path.join('.'));
    if (key !== undefined) return { name: `gog ${path.join(' ')}`, held: (holdings) => hasGog(holdings, [key]) };
  }
  if (words.length > 0) return { name: `gog ${service} ${words[0]}`, unknown: 'not a command gog is given' };
  const keys = [
    ...new Set([...GOG_KEYS].filter(([command]) => command.startsWith(`${service}.`)).map(([, key]) => key)),
  ];
  return { name: `gog ${service}`, held: (holdings) => hasGog(holdings, keys) };
}

function nclMention(resource: string, words: readonly string[]): Mention {
  const reaches = (holdings: Holdings, scoped: string | undefined): boolean =>
    holdings.ncl === 'global' ||
    (holdings.ncl === 'group' && (scoped === undefined || GROUP_SCOPE_RESOURCES.has(scoped)));
  for (let length = words.length; length >= 0; length -= 1) {
    const path = [resource, ...words.slice(0, length)];
    const command = lookup(path.join('-'));
    if (command !== undefined) {
      return {
        name: `ncl ${path.join(' ')}`,
        held: (holdings) => !command.hostOnly && reaches(holdings, command.resource),
      };
    }
  }
  const known = listCommands().some(({ name }) => name.startsWith(`${resource}-`));
  if (!known) return { name: `ncl ${resource}`, unknown: 'no ncl resource' };
  if (words.length > 0) return { name: `ncl ${resource} ${words[0]}`, unknown: 'not a registered ncl command' };
  return { name: `ncl ${resource}`, held: (holdings) => reaches(holdings, resource) };
}

/** Every tool, command and snake_case word a text names. */
function mentionsIn(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const [word] of text.matchAll(SNAKE)) {
    const key = TOOL_KEYS.get(word);
    mentions.push(key === undefined ? { name: word } : toolMention(word, key));
  }
  // A one-word tool (`browser`, `purchase`) is a name only when backticked: bare, it is a word.
  for (const [, word = ''] of text.matchAll(BACKTICKED)) {
    const key = TOOL_KEYS.get(word);
    if (key !== undefined) mentions.push(toolMention(word, key));
  }
  return [...mentions, ...commandMentionsIn(text)];
}

/** Reuse the registry and scope checks for commands in both TypeScript prose and Markdown. */
function commandMentionsIn(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const [, tool, first, rest] of text.matchAll(COMMAND)) {
    if (first === undefined) continue;
    const words = (rest ?? '').split(' ').filter((word) => word.length > 0);
    // Guidance may name alternatives as `ncl chats list|get`; each must exist.
    const alternatives = words.reduce<string[][]>(
      (paths, word) => paths.flatMap((prefix) => word.split('|').map((part) => [...prefix, part])),
      [[]],
    );
    for (const path of alternatives) mentions.push(tool === 'gog' ? gogMention(first, path) : nclMention(first, path));
  }
  return mentions;
}

interface Findings {
  readonly problems: string[];
  /** The policy entries the file's texts relied on: `<file>` for its reader, `<file> <name>` for a listed name. */
  readonly used: Set<string>;
}

/** What is wrong with one source's texts under `policy`. */
function check(file: string, source: string, policy: Policy = POLICY): Findings {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const { line, text, tag, registry } of hostTexts(file, source)) {
    const at = `${file}:${line}`;
    const unknownReaders = (tag ?? []).filter((reader) => !isReader(reader));
    if (unknownReaders.length > 0) problems.push(`${at}: the tag names no reader: ${unknownReaders.join(', ')}`);
    for (const mention of mentionsIn(text)) {
      const named = `${at} ${mention.name}`;
      if (mention.unknown !== undefined) {
        problems.push(`${named}: ${mention.unknown}`);
        continue;
      }
      if (mention.held === undefined) {
        if (VOCABULARY.has(mention.name) || OPERATIONAL_CODES.has(mention.name)) continue;
        if (policy.words[file]?.[mention.name] !== undefined) used.add(`${file} ${mention.name}`);
        else problems.push(`${named}: no tool, tool field or operational code`);
        continue;
      }
      if (registry) continue;
      if (policy.attributed[file]?.[mention.name] !== undefined) {
        used.add(`${file} ${mention.name}`);
        continue;
      }
      const fileReader = policy.readers[file];
      const readers = tag ?? (fileReader === undefined ? undefined : [fileReader]);
      if (readers === undefined) {
        problems.push(`${named}: no reader; tag the text or list its file`);
        continue;
      }
      if (tag === undefined) used.add(file);
      for (const reader of readers.filter(isReader)) {
        if (!mention.held(HOLDINGS[reader])) problems.push(`${named}: ${reader} does not hold it`);
      }
    }
  }
  return { problems, used };
}

/** The non-test, non-fixture sources of every GWS-EA module, relative to `src/modules`. */
function moduleSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(MODULES, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing') walk(relative);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('fixture')) {
        sources.push(relative);
      }
    }
  };
  for (const entry of fs.readdirSync(MODULES, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('gws-ea-')) walk(entry.name);
  }
  return sources;
}

/** Every policy entry, as `check` reports it used. */
function policyEntries(policy: Policy): string[] {
  return [
    ...Object.keys(policy.readers),
    ...[policy.words, policy.attributed].flatMap((listed) =>
      Object.entries(listed).flatMap(([file, names]) => Object.keys(names).map((name) => `${file} ${name}`)),
    ),
  ];
}

describe('the names in GWS-EA host text', () => {
  const sources = new Map(moduleSources().map((file) => [file, fs.readFileSync(path.join(MODULES, file), 'utf8')]));
  const findings = [...sources].map(([file, source]) => check(file, source));

  it('are each real and held by the text’s reader', () => {
    expect(findings.flatMap(({ problems }) => problems)).toEqual([]);
  });

  it('lists no file or name the texts no longer need', () => {
    const used = new Set(findings.flatMap(({ used: entries }) => [...entries]));
    expect(policyEntries(POLICY).filter((entry) => !used.has(entry))).toEqual([]);
  });

  it('gives every listed word and attributed name its reason', () => {
    for (const listed of [POLICY.words, POLICY.attributed]) {
      for (const [file, names] of Object.entries(listed)) {
        for (const [name, reason] of Object.entries(names)) expect(reason.trim(), `${file} ${name}`).not.toBe('');
      }
    }
  });

  it('keeps browser execution sentences in the reader-tagged wording files', () => {
    for (const name of ['credential-operations', 'purchase', 'watches']) {
      const file = `gws-ea-browser/${name}.ts`;
      const prose = hostTexts(file, sources.get(file) ?? '').filter(({ text }) =>
        /\b[a-z]{2,}\s+[a-z]{2,}\s+[a-z]{2,}\b/iu.test(text),
      );
      expect(
        prose.map(({ text }) => text),
        file,
      ).toEqual([]);
    }
  });

  it('gives every approval without a verified principal the same actionable next step', () => {
    expect(noVerifiedPrincipalMessage()).toContain('Pause here');
    expect(noVerifiedPrincipalMessage()).toContain('connected and verified before you can try again');
    for (const file of [
      'gws-ea-privacy/index.ts',
      'gws-ea-profile/index.ts',
      'gws-ea-browser/watches.ts',
      'gws-ea-browser/consent-approval.ts',
      'gws-ea-browser/purchase.ts',
      'gws-ea-browser/credential-operations.ts',
      'gws-ea-browser/reservation-guarantee.ts',
    ]) {
      expect(sources.get(file), file).toContain('DENY(noVerifiedPrincipalMessage())');
    }
  });
});

/** Each resident instruction's possible readers, including optional browser access on a CLI-disabled job. */
const GUIDANCE_READERS: Readonly<Record<string, readonly Reader[]>> = {
  'src/modules/gws-ea-profile/character.md': ['main', 'external-email', 'external-chat', 'job'],
  'src/modules/gws-ea-main/guidance.md': ['main'],
  'src/modules/gws-ea-external-email/guidance.md': ['external-email'],
  'src/modules/gws-ea-chat-agents/external-chat.guidance.md': ['external-chat'],
  'src/modules/gws-ea-chat-agents/job.guidance.md': ['job'],
  'src/modules/gws-ea-browser/main-guidance.md': ['main', 'delegator', 'job'],
  'templates/gws-ea/browser/instructions.md': ['browser'],
  'container/agent-runner/src/mcp-tools/gws-ea-artifacts.instructions.md': ['main', 'delegator', 'job'],
  'container/agent-runner/src/mcp-tools/gws-ea-browser.instructions.md': ['browser'],
  'container/agent-runner/src/mcp-tools/gws-ea-chat-documents.instructions.md': ['job'],
  'container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md': ['external-chat', 'job'],
  'container/agent-runner/src/mcp-tools/gws-ea-chat-outreach.instructions.md': ['main'],
  'container/agent-runner/src/mcp-tools/gws-ea-chat.instructions.md': ['main'],
  'container/agent-runner/src/mcp-tools/gws-ea-email-external.instructions.md': ['external-email'],
  // Default-on: a group that stores `all` holds it too.
  'container/agent-runner/src/mcp-tools/gws-ea-email.instructions.md': ['main', 'delegator'],
  // Google skill instructions are generic: a non-main recipient may have group-scoped or disabled CLI.
  'container/skills/gcalendar/instructions.md': ['main', 'delegator', 'job'],
  'container/skills/gmail/instructions.md': ['main', 'delegator', 'job'],
  'container/skills/gpeople/instructions.md': ['main', 'delegator', 'job'],
  'container/skills/gworkspace/instructions.md': ['main', 'delegator', 'job'],
  'container/skills/whatsapp-formatting/instructions.md': ['main', 'external-chat', 'job', 'delegator'],
};

function guidanceFilesUnder(relative: string): string[] {
  return fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? guidanceFilesUnder(file) : [file];
  });
}

/** Discover readers independently of the pinned map so a new file cannot silently escape checking. */
function guidanceFiles(): string[] {
  const moduleFiles = fs
    .readdirSync(MODULES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('gws-ea-'))
    .flatMap((entry) => guidanceFilesUnder(`src/modules/${entry.name}`))
    .filter((file) => file.endsWith('guidance.md') || file === 'src/modules/gws-ea-profile/character.md');
  const runnerFiles = guidanceFilesUnder('container/agent-runner/src/mcp-tools').filter((file) =>
    /^gws-ea.*\.instructions\.md$/u.test(path.posix.basename(file)),
  );
  const templateFiles = guidanceFilesUnder('templates/gws-ea').filter(
    (file) => path.posix.basename(file) === 'instructions.md',
  );
  const skillFiles = [...new Set([...MAIN_SHARED_SKILLS, ...CHAT_SHARED_SKILLS])]
    .map((skill) => `container/skills/${skill}/instructions.md`)
    .filter((file) => fs.existsSync(path.join(ROOT, file)));
  return [
    ...new Set([...registeredGuidanceFiles(), ...moduleFiles, ...runnerFiles, ...templateFiles, ...skillFiles]),
  ].sort();
}

function guidanceNclProblems(file: string, text: string): string[] {
  const readers = GUIDANCE_READERS[file];
  if (readers === undefined) return [`${file}: no guidance readers listed`];
  return text.split('\n').flatMap((line, index) =>
    commandMentionsIn(line)
      .filter(({ name }) => name.startsWith('ncl '))
      .flatMap((mention) => {
        const named = `${file}:${index + 1} ${mention.name}`;
        if (mention.unknown !== undefined) return [`${named}: ${mention.unknown}`];
        return readers
          .filter((reader) => mention.held?.(HOLDINGS[reader]) !== true)
          .map((reader) => `${named}: ${reader} does not hold it`);
      }),
  );
}

describe('the ncl commands in GWS-EA guidance', () => {
  const files = guidanceFiles();

  it('pins every resident instruction file to its readers, with no stale entries', () => {
    expect(files).toEqual(Object.keys(GUIDANCE_READERS).sort());
  });

  it('names only registered commands every reader can use', () => {
    expect(files.flatMap((file) => guidanceNclProblems(file, fs.readFileSync(path.join(ROOT, file), 'utf8')))).toEqual(
      [],
    );
  });

  it('refuses main-only ncl in shared browser delegation guidance, including its job reader', () => {
    const file = 'src/modules/gws-ea-browser/main-guidance.md';
    expect(guidanceNclProblems(file, 'Read `ncl private-values list` before disclosing.')).toEqual([
      `${file}:1 ncl private-values list: delegator does not hold it`,
      `${file}:1 ncl private-values list: job does not hold it`,
    ]);
    expect(guidanceNclProblems(file, 'Use `browser` for this errand.')).toEqual([]);
  });

  it.each([
    ['ncl imaginary list', 'ncl imaginary: no ncl resource'],
    ['ncl people search', 'ncl people search: not a registered ncl command'],
    ['ncl chats list|invent', 'ncl chats invent: not a registered ncl command'],
  ])('refuses the unknown command %s', (command, problem) => {
    const file = 'src/modules/gws-ea-main/guidance.md';
    expect(guidanceNclProblems(file, `Use \`${command}\`.`)).toEqual([`${file}:1 ${problem}`]);
  });

  it('refuses main-only commands in a generic Google skill', () => {
    const file = 'container/skills/gcalendar/instructions.md';
    expect(guidanceNclProblems(file, 'Read `ncl principal-addresses list` first.')).toEqual([
      `${file}:1 ncl principal-addresses list: delegator does not hold it`,
      `${file}:1 ncl principal-addresses list: job does not hold it`,
    ]);
  });

  it('refuses to check a new instruction file until its readers are listed', () => {
    const file = 'src/modules/gws-ea-new-role/guidance.md';
    expect(guidanceNclProblems(file, 'Read `ncl people list`.')).toEqual([`${file}: no guidance readers listed`]);
  });
});

describe('the host-text names check', () => {
  /** A policy for fixture files under `gws-ea-fixture/`. */
  const FIXTURES: Policy = {
    readers: { 'gws-ea-fixture/main-notes.ts': 'main', 'gws-ea-fixture/browser-notes.ts': 'browser' },
    words: { 'gws-ea-fixture/render.ts': { gmail_quote: 'an HTML class in the reply markup' } },
    attributed: {
      'gws-ea-fixture/browser-notes.ts': { record_purchase_outcome: 'it says main records the outcome' },
    },
  };
  const problems = (file: string, source: string): string[] => check(file, source, FIXTURES).problems;

  it('fails on a text that names a tool its reader does not hold', () => {
    expect(problems('gws-ea-fixture/main-notes.ts', `const NOTE = 'Offer the times free_time gives.';`)).toEqual([
      'gws-ea-fixture/main-notes.ts:1 free_time: main does not hold it',
    ]);
  });

  it('checks chat variants against the chat reader and keeps main out of them', () => {
    const source = "const NOTE = 'Use free_time, book and tell_main for this chat.';";
    expect(problems('gws-ea-fixture/mixed.ts', '/** to: external-chat */\n' + source)).toEqual([]);
    expect(problems('gws-ea-fixture/main-notes.ts', source)).toEqual([
      'gws-ea-fixture/main-notes.ts:1 free_time: main does not hold it',
      'gws-ea-fixture/main-notes.ts:1 tell_main: main does not hold it',
    ]);
  });

  it('fails on a gog command gog is not given, and passes one it is', () => {
    expect(problems('gws-ea-fixture/main-notes.ts', `const NOTE = 'Answer it with gog calendar respond.';`)).toEqual([
      'gws-ea-fixture/main-notes.ts:1 gog calendar respond: not a command gog is given',
    ]);
    expect(
      problems(
        'gws-ea-fixture/main-notes.ts',
        `const NOTE = 'Read the calendar list with gog calendar calendars first.';`,
      ),
    ).toEqual([]);
  });

  it.each(['calender events', 'contacts list'])('fails on a gog service that is not given: %s', (command) => {
    expect(problems('gws-ea-fixture/main-notes.ts', `const NOTE = 'Read it with gog ${command}.';`)).toEqual([
      `gws-ea-fixture/main-notes.ts:1 gog ${command}: not a command gog is given`,
    ]);
  });

  it('fails on any ncl named to an agent without it, and on an ncl command that is not registered', () => {
    expect(
      problems('gws-ea-fixture/browser-notes.ts', 'const NOTE = `Keep the errand in \\`ncl matters\\`.`;'),
    ).toEqual(['gws-ea-fixture/browser-notes.ts:1 ncl matters: browser does not hold it']);
    expect(problems('gws-ea-fixture/main-notes.ts', `const NOTE = 'Find them with ncl people search.';`)).toEqual([
      'gws-ea-fixture/main-notes.ts:1 ncl people search: not a registered ncl command',
    ]);
  });

  it('holds a delegator other than main to group-scope ncl and the delegate tools', () => {
    const source = [
      '/** to: delegator */',
      `const NOTE = 'Settle it with record_purchase_outcome, see your tasks with ncl tasks list, and find them with ncl people list.';`,
    ].join('\n');
    expect(problems('gws-ea-fixture/mixed.ts', source)).toEqual([
      'gws-ea-fixture/mixed.ts:2 ncl people list: delegator does not hold it',
    ]);
  });

  it('passes a field name the runner’s tools use, and a word listed for its file only there', () => {
    const source = `const NOTE = 'Reply on the thread_key you were given.';`;
    expect(problems('gws-ea-fixture/main-notes.ts', source)).toEqual([]);
    const markup = `const HTML = '<div class="gmail_quote"> quoted </div>';`;
    expect(problems('gws-ea-fixture/render.ts', markup)).toEqual([]);
    expect(problems('gws-ea-fixture/main-notes.ts', markup)).toEqual([
      'gws-ea-fixture/main-notes.ts:1 gmail_quote: no tool, tool field or operational code',
    ]);
  });

  it('fails on an untagged text that names a tool in a file with more than one reader, and passes it tagged', () => {
    const untagged = `const NOTE = 'Wake main with tell_main and wait.';`;
    expect(problems('gws-ea-fixture/mixed.ts', untagged)).toEqual([
      'gws-ea-fixture/mixed.ts:1 tell_main: no reader; tag the text or list its file',
    ]);
    expect(problems('gws-ea-fixture/mixed.ts', `/** to: external-email */\n${untagged}`)).toEqual([]);
    const inBlock = `/**\n * What external-email does.\n * to: main\n */\n${untagged}`;
    expect(problems('gws-ea-fixture/mixed.ts', inBlock)).toEqual([
      'gws-ea-fixture/mixed.ts:5 tell_main: main does not hold it',
    ]);
    expect(problems('gws-ea-fixture/mixed.ts', `/** to: everyone */\n${untagged}`)).toEqual([
      'gws-ea-fixture/mixed.ts:2: the tag names no reader: everyone',
    ]);
  });

  it('passes a mention attributed to another agent through its listed entry', () => {
    const source = `const NOTE = 'The order is unconfirmed: main records it with \`record_purchase_outcome\`.';`;
    expect(problems('gws-ea-fixture/browser-notes.ts', source)).toEqual([]);
    expect(check('gws-ea-fixture/browser-notes.ts', source, { ...FIXTURES, attributed: {} }).problems).toEqual([
      'gws-ea-fixture/browser-notes.ts:1 record_purchase_outcome: browser does not hold it',
    ]);
  });

  it('reads no operator log, and checks the names in a capability description only for existence', () => {
    expect(problems('gws-ea-fixture/mixed.ts', `log.info('free_time ran for a thread', { note: 'ok' });`)).toEqual([]);
    const capability = `registerCapability('x', { description: 'free_time and tell_main: the thread tools', default: 'off' });`;
    expect(problems('gws-ea-fixture/mixed.ts', capability)).toEqual([]);
    expect(problems('gws-ea-fixture/mixed.ts', capability.replace('free_time', 'free_slots'))).toEqual([
      'gws-ea-fixture/mixed.ts:1 free_slots: no tool, tool field or operational code',
    ]);
  });

  it('names a one-word tool only when it is backticked', () => {
    expect(problems('gws-ea-fixture/main-notes.ts', `const NOTE = 'Make the purchase, then watch the page.';`)).toEqual(
      [],
    );
    expect(problems('gws-ea-fixture/main-notes.ts', 'const NOTE = `Call \\`purchase\\` with that control.`;')).toEqual([
      'gws-ea-fixture/main-notes.ts:1 purchase: main does not hold it',
    ]);
  });
});
