import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callHost, readState, type SyntheticEvent } from './state.js';
import { scenarioRuntime } from '../runtime.js';
import type { ScenarioComposition } from '../types.js';
import { checkStoreCases } from './store-checks.js';
import { prepareSyntheticShell } from './sandbox.js';

const [file, agent, tree] = process.argv.slice(2);
if (!file || !agent || !tree) throw new Error('check <fixture> <agent> <tree>');
const directory = path.dirname(file);
const scenario = readState(file).scenario;
const composition = JSON.parse(
  fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
) as ScenarioComposition;
const isolation = {
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};
const runtime = scenarioRuntime(
  composition,
  {
    nanoclaw: {
      command: process.execPath,
      args: [path.join(tree, 'scripts/scenarios/fake-host/mcp.ts'), file, JSON.stringify(composition.capabilities)],
    },
  },
  {
    SYNTHETIC_AUTH_CONTEXT: 'inherited-auth-context',
    ...Object.fromEntries(Object.keys(composition.moduleEnvironment).map((key) => [key, 'stale-inherited-value'])),
  },
  isolation,
);
assert.equal(runtime.env.SYNTHETIC_AUTH_CONTEXT, 'inherited-auth-context');
assert.equal(runtime.env.ANTHROPIC_BASE_URL, isolation.ANTHROPIC_BASE_URL);
for (const [key, value] of Object.entries(composition.moduleEnvironment)) assert.equal(runtime.env[key], value, key);
for (const tool of runtime.production.disallowedTools) assert.ok(runtime.applied.disallowedTools.includes(tool), tool);
assert.ok(runtime.applied.strictMcpConfig);
assert.deepEqual(Object.keys(runtime.applied.mcpServers), ['nanoclaw']);
assert.equal(
  runtime.fixtureWithheld.includes('WebSearch'),
  !composition.fixturePublicWeb && !runtime.production.disallowedTools.includes('WebSearch'),
);
assert.equal(
  runtime.fixtureWithheld.includes('Agent'),
  !composition.fixturePlanning && !runtime.production.disallowedTools.includes('Agent'),
);
if (scenario.audience !== 'main') {
  for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Agent']) {
    assert.ok(
      runtime.production.disallowedTools.includes(tool),
      `${scenario.audience} must withhold ${tool} in production`,
    );
    assert.ok(!runtime.applied.tools?.includes(tool));
    assert.ok(!runtime.applied.allowedTools.includes(tool));
  }
  assert.ok(runtime.applied.tools?.includes('Read'));
  assert.ok(!composition.capabilities.includes('conversation-context'));
  assert.ok(!fs.existsSync(path.join(agent, 'memory')));
  assert.deepEqual(composition.skills, scenario.audience === 'external-chat' ? ['whatsapp-formatting'] : []);
} else {
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'])
    assert.ok(!runtime.production.disallowedTools.includes(tool), `main must retain ${tool}`);
}
fs.writeFileSync(
  path.join(directory, 'applied-configuration.json'),
  JSON.stringify(
    {
      capabilities: composition.capabilities,
      storedCapabilities: composition.storedCapabilities,
      production: runtime.production,
      applied: runtime.applied,
      fixtureWithheldTools: runtime.fixtureWithheld,
      fixtureExternalMcpWithheld: runtime.fixtureExternalMcpWithheld,
      moduleEnvironment: composition.moduleEnvironment,
      inheritedAuthenticationPreserved: true,
      contributionOverridesInherited: true,
      fixtureIsolationAppliedLast: true,
      modelCalls: 0,
    },
    null,
    2,
  ),
);
const snapshot = (await callHost(file, 'snapshot', { phase: 'preflight' })) as {
  events: SyntheticEvent[];
  mail: { snippet?: string }[];
};
fs.writeFileSync(path.join(directory, 'preflight-canonical-snapshot.json'), JSON.stringify(snapshot, null, 2));
if (scenario.id === 'search-before-asking') {
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0]?.summary, 'Dinner with Juno');
  assert.equal(snapshot.events[0]?.location, 'Harbor House, 800 Fiction Lane, San Francisco');
  assert.ok(snapshot.mail[0]?.snippet?.includes('Dinner with Juno is at Harbor House'));
  for (const argv of [
    ['principal-addresses', 'list', '--json'],
    ['matters', 'list', '--json'],
    ['matters', 'help'],
  ]) {
    const answer = (await callHost(file, 'ncl', { argv, phase: 'preflight' })) as {
      frame: { ok: boolean };
      stdout: string;
    };
    assert.equal(answer.frame.ok, true, answer.stdout);
    assert.ok(answer.stdout.trim());
    if (argv[0] === 'principal-addresses') assert.ok(answer.stdout.includes('bookable'), answer.stdout);
  }
  const calendar = (await callHost(file, 'action', {
    action: 'days',
    requestId: 'preflight-days',
    start: '2026-11-03',
    end: '2026-11-03',
    phase: 'preflight',
  })) as { frame?: { ok: boolean; data?: { message?: string } } };
  assert.equal(calendar.frame?.ok, true, JSON.stringify(calendar));
  assert.ok(calendar.frame?.data?.message?.includes('Dinner with Juno'));
  assert.ok(calendar.frame?.data?.message?.includes('Harbor House, 800 Fiction Lane, San Francisco'));
  const mail = (await callHost(file, 'gog', {
    argv: ['gmail', 'messages', 'search', 'Juno dinner'],
    phase: 'preflight',
  })) as {
    messages: { snippet?: string }[];
  };
  assert.ok(mail.messages[0]?.snippet?.includes('Dinner with Juno is at Harbor House'));
  const native = (await callHost(file, 'action', {
    action: 'check',
    requestId: 'preflight-check-overlap',
    start: '2026-11-03T19:30:00-08:00',
    end: '2026-11-03T20:00:00-08:00',
    phase: 'preflight',
  })) as { frame?: { ok: boolean; error?: unknown } };
  assert.equal(native.frame?.ok, true, JSON.stringify(native));
  assert.ok(JSON.stringify(native).includes('30 minutes overlap'));
  const noClash = (await callHost(file, 'action', {
    action: 'check',
    requestId: 'preflight-no-conflict',
    start: '2026-11-03T10:00:00-08:00',
    end: '2026-11-03T10:30:00-08:00',
    phase: 'preflight',
  })) as { frame?: { ok: boolean; data?: { message?: string } } };
  assert.equal(noClash.frame?.ok, true);
  assert.ok(!noClash.frame?.data?.message?.includes('minutes overlap'));
} else if (scenario.observationOnly) {
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.mail, []);
  const brief = fs.readFileSync(path.join(agent, 'role-brief.md'), 'utf8');
  assert.ok(brief.includes('JUNO-CEDAR-27'));
  assert.ok(brief.includes('18:45 America/Los_Angeles'));
  const doc = fs.readFileSync(path.join(agent, 'CLAUDE.md'), 'utf8');
  assert.ok(doc.includes('Aster'));
  assert.ok(doc.includes('Morgan Ellery'));
  assert.ok(doc.includes(scenario.audience === 'external-chat' ? 'External Chat' : 'External Email'));
  const denied = (await callHost(file, 'ncl', {
    argv: ['principal-addresses', 'list', '--json'],
    phase: 'preflight',
  })) as { frame: { ok: boolean } };
  assert.equal(denied.frame.ok, false, 'sealed role must have native CLI disabled');
  if (scenario.audience === 'external-chat') {
    assert.ok(composition.context?.includes('Principal present: false'));
    assert.ok(composition.context?.includes('Juno Hale'));
  }
} else await checkStoreCases(file, snapshot);
if (composition.close) {
  const close = spawnSync('bun', [path.join(tree, 'scripts/scenarios/fake-host/close-process-check.ts'), file, tree], {
    encoding: 'utf8',
  });
  assert.equal(close.status, 0, close.stderr);
}
if (scenario.observationOnly) {
  const report = spawnSync('bun', [path.join(tree, 'scripts/scenarios/fake-host/report-check.ts'), file], {
    encoding: 'utf8',
  });
  assert.equal(report.status, 0, report.stderr);
}
const route = spawnSync('bun', [path.join(tree, 'scripts/scenarios/fake-host/route-check.ts'), file], {
  encoding: 'utf8',
});
assert.equal(route.status, 0, route.stderr);
if (scenario.audience === 'main') {
  const week = spawnSync('bun', [path.join(tree, 'scripts/scenarios/fake-host/week-check.ts'), directory, tree], {
    encoding: 'utf8',
  });
  assert.equal(week.status, 0, week.stderr);
  const shell = prepareSyntheticShell(path.dirname(file), tree);
  const execute = (command: string) =>
    spawnSync('/usr/bin/sandbox-exec', ['-f', shell.profile, '/bin/bash', '--noprofile', '--norc', '-c', command], {
      cwd: agent,
      env: {
        PATH: `${shell.bin}:/usr/bin:/bin:/opt/homebrew/bin`,
        HOME: agent,
        TZ: 'America/Los_Angeles',
        SCENARIO_PHASE: 'preflight',
      },
      encoding: 'utf8',
    });
  const discovery = execute(
    'find . -iname "*gcalendar*" 2>/dev/null | head -20; ls .claude/skills; ncl principal-addresses list --json 2>&1; ncl matters list --json 2>&1; gog calendar calendars 2>&1 | head -100',
  );
  fs.writeFileSync(path.join(path.dirname(file), 'preflight-shell.json'), JSON.stringify(discovery, null, 2));
  assert.equal(discovery.status, 0, discovery.stderr + discovery.stdout);
  assert.ok(discovery.stdout.includes('gcalendar'));
  assert.ok(discovery.stdout.includes('morgan.ellery@example.test'));
  const sentinel = path.join(path.dirname(file), 'outside-agent-sentinel.txt');
  fs.writeFileSync(sentinel, 'INVENTED-PRIVATE-SENTINEL');
  const refused = execute(`cat '${sentinel}'`);
  assert.notEqual(refused.status, 0);
  assert.ok(!refused.stdout.includes('INVENTED-PRIVATE-SENTINEL'));
  const written = execute("printf 'synthetic write' > synthetic-write-proof.txt; cat synthetic-write-proof.txt");
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, 'synthetic write');
  fs.rmSync(path.join(agent, 'synthetic-write-proof.txt'));
  const memory = path.join(agent, 'memory');
  const savedMemory = path.join(agent, '.preflight-saved-memory');
  const outsideMemory = path.join(directory, 'outside-memory');
  fs.mkdirSync(outsideMemory);
  fs.writeFileSync(path.join(outsideMemory, 'private.md'), 'INVENTED-SNAPSHOT-SENTINEL');
  fs.renameSync(memory, savedMemory);
  fs.symlinkSync(outsideMemory, memory);
  try {
    const escaped = (await callHost(file, 'snapshot', { phase: 'preflight' })) as { memory: Record<string, string> };
    assert.deepEqual(escaped.memory, {});
    assert.ok(!JSON.stringify(escaped).includes('INVENTED-SNAPSHOT-SENTINEL'));
  } finally {
    fs.unlinkSync(memory);
    fs.renameSync(savedMemory, memory);
  }
}
fs.writeFileSync(
  path.join(path.dirname(file), 'preflight.json'),
  JSON.stringify(
    {
      passed: true,
      audience: scenario.audience,
      appliedNativeConfiguration: true,
      nativeShellDiscovery: scenario.audience === 'main',
      syntheticFileWrite: scenario.audience === 'main',
      outsideSyntheticSentinelRefused: scenario.audience === 'main',
      snapshotMemorySymlinkRefused: scenario.audience === 'main',
      ...(scenario.id === 'search-before-asking'
        ? {
            nativeCli: 3,
            calendarAndMailRead: true,
            nativeActions: ['days', 'check'],
          }
        : scenario.observationOnly
          ? {
              roleBriefRead: true,
              sealedCliRefused: true,
              nativeInternalTaskReport: true,
              outwardDeliveryVerified: false,
            }
          : { nativeCaseStoresAndTools: true }),
      initialReplyStampShared: true,
      modelCalls: 0,
    },
    null,
    2,
  ),
);
console.log('Native host and sandbox preflight passed; no model calls.');
