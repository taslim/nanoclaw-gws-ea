/** Disposable Linux acceptance author. Run only through the host's opt-in native fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestAction } from '../action-request.js';
import '../mailbox/compose.js';
import { artifactList, artifactRead, artifactSave, artifactShare } from '../mcp-tools/gws-ea-artifacts.js';
import { requestStatus } from '../mcp-tools/request-status.js';
import type { McpToolDefinition } from '../mcp-tools/types.js';

async function call(tool: McpToolDefinition, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.handler(args);
  assert(!result.isError, JSON.stringify(result));
  const first = result.content[0];
  assert(first?.type === 'text');
  const value: unknown = JSON.parse(first.text);
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const examples: Record<string, unknown>[] = [];
const phase = process.argv[2];
assert(phase === 'author' || phase === 'main');
if (phase === 'author') {
  for (const name of ['executive-brief', 'evidence-comparison', 'capacity-calculator']) {
    const file = `${name}.html`;
    fs.copyFileSync(`/examples/${file}`, `/workspace/agent/${file}`);
    const saved = await call(artifactSave, {
      create_key: name,
      file,
      title: name,
    });
    examples.push({ name, saved });
  }
  const denied = await artifactShare.handler({
    operation: 'public_publish',
    artifact_id: (examples[0].saved as Record<string, unknown>).artifact_id,
    revision: 1,
    expected_hash: (examples[0].saved as Record<string, unknown>).source_hash,
    principal_message: { id: 'spaces/AAAAjuno/messages/remy.1', messaging_group_id: 'chat' },
  });
  assert(denied.isError, 'A worker must not publish');
} else {
  examples.push(
    ...(JSON.parse(fs.readFileSync('/workspace/agent/references.json', 'utf8')) as Record<string, unknown>[]),
  );
  const saved = examples[0].saved as Record<string, unknown>;
  const principal_message = { id: 'spaces/AAAAjuno/messages/remy.1', messaging_group_id: 'chat' };
  const publication = {
    artifact_id: saved.artifact_id,
    revision: 1,
    expected_hash: saved.source_hash,
    principal_message,
  };
  const named = await call(artifactShare, {
    ...publication,
    operation: 'named_publish',
    recipients: [{ email: 'alex@example.com' }, { email: 'sam@example.com' }],
  });
  const published = await call(artifactShare, { ...publication, operation: 'public_publish' });
  async function checkpoint(stage: string, details: Record<string, unknown> = {}): Promise<void> {
    fs.writeFileSync(
      '/workspace/agent/checkpoint.tmp',
      JSON.stringify({ stage, saved, named, published, other: examples[1].saved, ...details }),
    );
    fs.renameSync('/workspace/agent/checkpoint.tmp', '/workspace/agent/checkpoint.json');
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (
        fs.existsSync('/workspace/agent/checked.txt') &&
        fs.readFileSync('/workspace/agent/checked.txt', 'utf8') === stage
      )
        return;
      await Bun.sleep(10);
    }
    throw new Error(`Host did not verify ${stage}`);
  }
  await checkpoint('initial');
  const checkout = await call(artifactRead, { artifact_id: saved.artifact_id, checkout: true });
  const checkoutFile = String(checkout.file);
  const original = fs.readFileSync(checkoutFile, 'utf8');
  assert(original.includes('</main>'));
  fs.writeFileSync(checkoutFile, original.replace('</main>', '<p>Deliberate private revision</p></main>'));
  const revised = await call(artifactSave, {
    artifact_id: saved.artifact_id,
    expected_revision: 1,
    title: 'Private revision',
    file: checkoutFile,
  });
  await checkpoint('private-revised', { revised });
  const replaced = await call(artifactShare, {
    ...publication,
    operation: 'public_replace',
    revision: 2,
    expected_hash: revised.source_hash,
    share_id: published.share_id,
    expected_generation: published.generation,
  });
  await checkpoint('replaced', { revised, replaced });
  const revoked = await call(artifactShare, {
    artifact_id: saved.artifact_id,
    operation: 'revoke',
    share_id: named.share_id,
    expected_generation: named.generation,
    principal_message,
  });
  await checkpoint('revoked', { revised, replaced, revoked });
  const listing = await call(artifactList, {});
  assert(Array.isArray(listing.artifacts) && listing.artifacts.length >= 3);
  fs.writeFileSync(
    '/workspace/agent/main-result.json',
    JSON.stringify({ named, published, revised, replaced, revoked }, null, 2),
  );
}

// The same native transport returns an eventual result after its caller stops waiting.
const late = await requestAction('artifact_list', { limit: 1 }, { timeoutMs: 1, pollMs: 1 });
assert(late.status === 'timeout');
let lateResult: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 100; attempt++) {
  const result = await requestStatus.handler({ request_id: late.requestId });
  const first = result.content[0];
  if (first?.type === 'text' && first.text.startsWith('{')) {
    lateResult = JSON.parse(first.text) as Record<string, unknown>;
    break;
  }
  await Bun.sleep(20);
}
assert(lateResult && Array.isArray(lateResult.artifacts));

if (phase === 'author') {
  const prefix =
    '<!doctype html><html><head><title>256 KiB information</title></head><body><h1>256 KiB information</h1><p>';
  const suffix = '</p></body></html>';
  const source =
    prefix + 'Measured information. '.repeat(13_000).slice(0, 262_144 - prefix.length - suffix.length) + suffix;
  assert(Buffer.byteLength(source) === 262_144);
  fs.writeFileSync('/workspace/agent/measured.html', source);
  const durations: number[] = [];
  let measured: Record<string, unknown> | undefined;
  for (let index = 0; index < 31; index++) {
    const started = performance.now();
    measured = await call(artifactSave, {
      create_key: `measured-${index}`,
      title: '256 KiB information',
      file: 'measured.html',
    });
    if (index > 0) durations.push(performance.now() - started);
    assert(measured.byte_count === 262_144);
  }
  durations.sort((left, right) => left - right);
  const saveP95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert(saveP95 <= 3_000, `Native save p95 ${saveP95} ms exceeds 3 seconds`);
  fs.writeFileSync(
    '/workspace/agent/native-result.json',
    JSON.stringify(
      {
        examples,
        late_status: 'answered',
        measured,
        native_save: { samples: durations.length, p95_ms: saveP95, durations_ms: durations },
      },
      null,
      2,
    ),
  );
}
