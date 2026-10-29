import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { grantsInstructions } from '../../capabilities.js';
import { lookup } from '../../cli/registry.js';
import { runnerToolCapabilities, runnerToolNames, unknownToolNames } from '../../test-utils/runner-tools.js';
import { CHAT_SHARED_SKILLS, EXTERNAL_CHAT_CAPABILITIES, JOB_CHAT_CAPABILITIES } from '../gws-ea-chat-agents/shape.js';
import { EXTERNAL_EMAIL_CAPABILITIES } from '../gws-ea-external-email/group.js';
import '../gws-ea-manual/index.js';
import '../gws-ea-matters/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-whereabouts/index.js';

const PLAYBOOKS = ['days-and-weeks', 'travel', 'errands', 'meetings'] as const;
const MAIN_CRAFT = 'container/skills/gcalendar/instructions.md';
const EXTERNAL_EMAIL = 'src/modules/gws-ea-external-email/guidance.md';
const CHAT_SCHEDULING = 'container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md';
const OUTWARD_ROLES = [
  { role: 'external-email', capabilities: EXTERNAL_EMAIL_CAPABILITIES, file: EXTERNAL_EMAIL },
  { role: 'external-chat', capabilities: EXTERNAL_CHAT_CAPABILITIES, file: CHAT_SCHEDULING },
  { role: 'job', capabilities: JOB_CHAT_CAPABILITIES, file: CHAT_SCHEDULING },
] as const;

/** The calendar craft every agent that writes events holds resident, each part with the reason that makes it judgment. */
const CRAFT = [
  /location/iu,
  /title says what/iu,
  /in person, the place and no link/iu,
  /video, a link and no address/iu,
  /who calls whom/iu,
  /hybrid, both, as for a lunch with someone dialling in/iu,
  /sensible default and say which/iu,
  /so they get it and its changes/iu,
  /usually invite/iu,
];

const read = (file: string): string => fs.readFileSync(path.resolve(file), 'utf8');

describe('time and place craft at the point of use', () => {
  it.each(PLAYBOOKS)('ships %s with essentials before the worked example and traps', (skill) => {
    const text = read(`container/skills/${skill}/SKILL.md`);
    expect(text).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n`, 'u'));
    const sections = ['## What great looks like', '## Method and why', '## Worked example', '## Traps'];
    const positions = sections.map((section) => text.indexOf(section));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(text).toContain('Morgan Ellery');
  });

  it.each(PLAYBOOKS)('%s names existing tools and native CLI commands', (skill) => {
    const text = read(`container/skills/${skill}/SKILL.md`);
    expect(unknownToolNames(text, ['gcalendar', 'main'])).toEqual([]);
    const tools = runnerToolNames();
    for (const match of text.matchAll(/mcp__nanoclaw__([a-z_]+)/gu)) {
      expect(tools.has(match[1] ?? ''), match[0]).toBe(true);
    }
    for (const match of text.matchAll(/`ncl ([^`\n]+)`/gu)) {
      const command = match[1]?.split(' --')[0]?.replaceAll(' ', '-') ?? '';
      expect(lookup(command), match[0]).toBeDefined();
    }
  });

  it.each(PLAYBOOKS)('%s writes example times as main speaks them', (skill) => {
    expect(read(`container/skills/${skill}/SKILL.md`)).not.toMatch(/\b\d{2}:\d{2}\b/u);
  });

  it('keeps main’s planning playbooks out of the outward chat skill selection', () => {
    for (const skill of PLAYBOOKS) expect(CHAT_SHARED_SKILLS).not.toContain(skill);
  });

  it.each([MAIN_CRAFT, EXTERNAL_EMAIL, CHAT_SCHEDULING])('holds the calendar craft and its reasons in %s', (file) => {
    const text = read(file);
    for (const part of CRAFT) expect(text, part.source).toMatch(part);
  });

  it.each([EXTERNAL_EMAIL, CHAT_SCHEDULING])(
    'shapes outward meetings for the principal and leaves main what only main can do in %s',
    (file) => {
      const text = read(file);
      for (const part of [
        /requester's ask/iu,
        /recorded meeting lengths/iu,
        /whoever needs the meeting usually owns it/iu,
        /other side has an assistant, usually agree a time and let them send the invitation/iu,
        /judge a hold/iu,
        /booking link to main.* book nothing, because you can't book through a web page/iu,
        /never volunteer a trip/iu,
        /main's to protect, since only main writes the principal's own blocks/iu,
      ])
        expect(text, part.source).toMatch(part);
    },
  );

  it.each(OUTWARD_ROLES)('gives $role scheduling tools it holds, none of main’s', (actor) => {
    const grants = new Set<string>(actor.capabilities);
    if (actor.role !== 'external-email') expect(grantsInstructions('gws-ea-chat-external', grants)).toBe(true);
    const toolCapabilities = runnerToolCapabilities();
    const text = read(actor.file);
    for (const name of ['free_time', 'book', 'change_booking', 'cancel_booking', 'tell_main']) {
      expect(text, name).toContain(`\`${name}\``);
      expect(
        [...(toolCapabilities.get(name) ?? [])].some((key) => grants.has(key)),
        name,
      ).toBe(true);
    }
    expect(text).not.toContain('/app/skills/gcalendar');
    for (const name of ['days', 'check', 'create_event', 'change_event', 'cancel_event']) {
      expect(
        [...(toolCapabilities.get(name) ?? [])].some((key) => grants.has(key)),
        name,
      ).toBe(false);
    }
  });
});
