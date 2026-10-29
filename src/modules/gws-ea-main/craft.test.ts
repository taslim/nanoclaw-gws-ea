import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { grantsInstructions } from '../../capabilities.js';
import { lookup } from '../../cli/registry.js';
import { buildMounts } from '../../container-runner.js';
import { registerProviderContainerConfig } from '../../providers/provider-container-registry.js';
import { runnerToolCapabilities, runnerToolNames, unknownToolNames } from '../../test-utils/runner-tools.js';
import type { AgentGroup, Session } from '../../types.js';
import { CHAT_SHARED_SKILLS, EXTERNAL_CHAT_CAPABILITIES, JOB_CHAT_CAPABILITIES } from '../gws-ea-chat-agents/shape.js';
import { EXTERNAL_EMAIL_CAPABILITIES } from '../gws-ea-external-email/group.js';
import '../gws-ea-manual/index.js';
import '../gws-ea-matters/index.js';
import '../gws-ea-preferences/index.js';
import '../gws-ea-whereabouts/index.js';

const PLAYBOOKS = ['days-and-weeks', 'travel', 'errands', 'meetings'] as const;
const PROCEDURE = 'container/skills/gcalendar/SKILL.md';
const OUTWARD_ROLES = [
  { role: 'external-email', capabilities: EXTERNAL_EMAIL_CAPABILITIES, skills: [] },
  { role: 'external-chat', capabilities: EXTERNAL_CHAT_CAPABILITIES, skills: CHAT_SHARED_SKILLS },
  { role: 'job', capabilities: JOB_CHAT_CAPABILITIES, skills: CHAT_SHARED_SKILLS },
] as const;

registerProviderContainerConfig('craft-read-test', () => ({}), { providesAgentSurfaces: true });

interface ClaudeReadPolicy {
  readonly tools?: readonly string[];
  readonly withheldTools: readonly string[];
  readonly externalMcpServers: boolean;
}

interface ClaudeReadPolicyModule {
  resolveClaudeCapabilityPolicy(grants: ReadonlySet<string>): ClaudeReadPolicy;
  allowsBuiltinTool(policy: ClaudeReadPolicy, toolName: string): boolean;
}

function procedureSection(heading: string, next: string): string {
  const text = fs.readFileSync(path.resolve(PROCEDURE), 'utf8');
  const start = text.indexOf(`## ${heading}\n`);
  const end = text.indexOf(`## ${next}\n`, start);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  expect(end, next).toBeGreaterThan(start);
  return text.slice(start, end);
}

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
    'container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md',
  ])('keeps calendar craft out of the resident %s', (file) => {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    if (file === 'container/skills/gcalendar/instructions.md') {
      expect(text).toContain('Run the `gcalendar` skill before');
    }
    expect(text).not.toContain('who calls whom');
  });

  it('keeps complete shared calendar craft in the on-demand procedure', () => {
    const text = procedureSection('Calendar craft', 'Outward scheduling');
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
      expect(text, requirement.source).toMatch(requirement);
    }
  });

  it('keeps outward shaping facts, ownership, privacy and move etiquette at the point of use', () => {
    const text = procedureSection('Outward scheduling', 'Main calendar tools');
    for (const requirement of [
      /relationship/iu,
      /six.month/iu,
      /recorded lengths/iu,
      /requester.*information/iu,
      /kind/iu,
      /buffer/iu,
      /preferred times/iu,
      /default/iu,
      /day.s zone/iu,
      /tentative stays/iu,
      /unknown travel/iu,
      /outside usual hours/iu,
      /never volunteer a trip/iu,
      /whoever needs.*owns/iu,
      /other side.*assistant/iu,
      /hold/iu,
      /booking link/iu,
      /organizer/iu,
      /no second event/iu,
    ]) {
      expect(text, requirement.source).toMatch(requirement);
    }
  });

  it.each(OUTWARD_ROLES)(
    'gives $role a native read-only route without main’s tools or selected skill',
    async (actor) => {
      const policyModule = (await import(
        path.resolve('container/agent-runner/src/providers/claude-config.ts')
      )) as ClaudeReadPolicyModule;
      const policy = policyModule.resolveClaudeCapabilityPolicy(new Set(actor.capabilities));
      expect(policyModule.allowsBuiltinTool(policy, 'Read')).toBe(true);
      expect(policyModule.allowsBuiltinTool(policy, 'Bash')).toBe(false);
      expect(actor.skills).not.toContain('gcalendar');
      const grants = new Set<string>(actor.capabilities);
      const route =
        actor.role === 'external-email'
          ? 'src/modules/gws-ea-external-email/guidance.md'
          : 'container/agent-runner/src/mcp-tools/gws-ea-chat-external.instructions.md';
      if (actor.role !== 'external-email') expect(grantsInstructions('gws-ea-chat-external', grants)).toBe(true);
      const resident = fs.readFileSync(path.resolve(route), 'utf8');
      expect(resident).toContain('Read');
      expect(resident).toContain('`/app/skills/gcalendar/SKILL.md`');
      expect(resident).toContain('outward procedure');
      const toolCapabilities = runnerToolCapabilities();
      const text = procedureSection('Outward scheduling', 'Main calendar tools');
      for (const name of text.split('`').filter((word, index) => index % 2 === 1 && /^[a-z_]+$/u.test(word))) {
        expect(
          [...(toolCapabilities.get(name) ?? [])].some((key) => grants.has(key)),
          name,
        ).toBe(true);
      }
      for (const name of ['days', 'check', 'create_event', 'change_event', 'cancel_event']) {
        expect(
          [...(toolCapabilities.get(name) ?? [])].some((key) => grants.has(key)),
          name,
        ).toBe(false);
      }
      const group: AgentGroup = {
        id: `craft-${actor.role}`,
        name: actor.role,
        folder: `craft-${actor.role}`,
        agent_provider: null,
        created_at: '2026-10-28T00:00:00.000Z',
      };
      const session: Session = {
        id: 'craft-session',
        agent_group_id: group.id,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: group.created_at,
      };
      const mounts = await buildMounts(
        group,
        session,
        {
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: [...actor.skills],
          capabilities: [...actor.capabilities],
        },
        'craft-read-test',
        {},
      );
      const shared = mounts.find((mount) => mount.containerPath === '/app/skills');
      expect(shared).toMatchObject({ readonly: true, mountClass: 'install-surface' });
      expect(fs.existsSync(path.join(shared?.hostPath ?? '', 'gcalendar/SKILL.md'))).toBe(true);
    },
  );
});
