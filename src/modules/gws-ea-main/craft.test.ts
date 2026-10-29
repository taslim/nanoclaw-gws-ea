import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { lookup } from '../../cli/registry.js';
import { runnerToolNames, unknownToolNames } from '../../test-utils/runner-tools.js';
import { CHAT_SHARED_SKILLS } from '../gws-ea-chat-agents/shape.js';
import '../gws-ea-manual/index.js';
import '../gws-ea-matters/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-whereabouts/index.js';

const PLAYBOOKS = ['days-and-weeks', 'travel', 'errands', 'meetings'] as const;

describe('time and place craft at the point of use', () => {
  it.each(PLAYBOOKS)('ships %s with essentials before the worked example and traps', (skill) => {
    const text = fs.readFileSync(path.resolve('container/skills', skill, 'SKILL.md'), 'utf8');
    expect(text).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n`, 'u'));
    const sections = ['## What great looks like', '## Method and why', '## Worked example', '## Traps'];
    const positions = sections.map((section) => text.indexOf(section));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(text).toContain('Morgan Ellery');
  });

  it.each(PLAYBOOKS)('%s names existing tools and native CLI commands', (skill) => {
    const text = fs.readFileSync(path.resolve('container/skills', skill, 'SKILL.md'), 'utf8');
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

  it('keeps main’s planning playbooks out of the outward chat skill selection', () => {
    for (const skill of PLAYBOOKS) expect(CHAT_SHARED_SKILLS).not.toContain(skill);
  });

  it.each([
    'container/skills/gcalendar/instructions.md',
    'src/modules/gws-ea-external-email/guidance.md',
    'src/modules/gws-ea-chat-agents/external-chat.guidance.md',
    'src/modules/gws-ea-chat-agents/job.guidance.md',
  ])('puts the shared event-writing craft in %s', (file) => {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    for (const requirement of [
      /location/iu,
      /sized (?:time )?block/iu,
      /all-day/iu,
      /lead time/iu,
      /in person/iu,
      /video/iu,
      /phone/iu,
      /hybrid/iu,
      /who calls whom/iu,
      /named.*(?:not invited|without invitations)/iu,
      /about them/iu,
      /hold time/iu,
      /principal.created/iu,
    ]) {
      expect(text, `${file}: ${requirement.source}`).toMatch(requirement);
    }
  });

  it('makes the shared chat scheduling instructions require usable attendance details', () => {
    const text = fs.readFileSync(
      path.resolve('container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md'),
      'utf8',
    );
    for (const attendance of [/in person/iu, /location/iu, /video/iu, /phone/iu, /hybrid/iu, /who calls whom/iu]) {
      expect(text, attendance.source).toMatch(attendance);
    }
    expect(text).not.toContain('only when helpful');
  });
});
