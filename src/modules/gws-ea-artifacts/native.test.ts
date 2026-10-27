import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
const { ROOT } = await vi.hoisted(async () => ({
  ROOT: `${(await import('node:os')).tmpdir()}/artifacts-native-${process.pid}`,
}));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { getGroupCapabilities } from '../../capabilities.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { runGuarded } from '../../delivery-guard.js';
import { sessionDir, resolveSystemSession } from '../../session-manager.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getDueOutboundMessages, openOutboundDb } from '../../mailbox/sqlite/session-db.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { ARTIFACT_ACTIONS } from './actions.js';
import { ArtifactSharing } from './sharing.js';
import { createArtifactViewHandler } from './server.js';
import { createArtifactViewResolver } from './access.js';
import { createWebIdentity, createWebIdentityVerifier } from '../gws-ea-web/access.js';
import { createWebHandler } from '../gws-ea-web/server.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';

let origin: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (origin ? origin.close(() => resolve()) : resolve()));
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
interface Saved {
  artifact_id: string;
  source_hash: string;
}
interface Checkpoint {
  stage: string;
  saved: Saved;
  named: { share_id: string };
  published: { share_id: string };
  other: Saved;
  revised?: Saved;
}
interface AuthorEvidence {
  examples: Array<{ saved: Saved }>;
  measured: Saved;
  native_save: { p95_ms: number };
}
it.skipIf(!process.env.GWS_EA_ARTIFACT_NATIVE_IMAGE)(
  'uses actual shell-less Linux authors, native mailboxes and authenticated origin; measures 256 KiB latency',
  async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    await runMigrations(await initTestDb());
    const now = new Date().toISOString();
    for (const id of ['canonical', 'author']) {
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
      await ensureContainerConfig(id);
      await updateContainerConfigJson(id, 'capabilities', ['artifacts', 'files-read', 'files-write', 'request-status']);
      expect(await getGroupCapabilities(id)).not.toContain('shell');
    }
    await getDb().run(
      "UPDATE gws_ea_profile SET main_agent_group_id='canonical',assistant_first_name='Aya',principal_first_name='Morgan' WHERE singleton=1",
    );
    await upsertUser({ id: 'gchat:principal', kind: 'gchat', display_name: 'Principal', created_at: now });
    await bindVerifiedPrincipalUser('gchat:principal', now);
    for (const email of ['principal@example.com', 'second@example.com'])
      await getDb().run('INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)', email, now);
    await createMessagingGroup({
      id: 'chat',
      channel_type: 'gchat',
      platform_id: 'chat',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    await getDb().run(
      "INSERT INTO gws_ea_principal_messages(message_id,messaging_group_id,user_id,timestamp,text) VALUES('spaces/AAAAjuno/messages/remy.1','chat','gchat:principal',?,'Share the selected revision with Alex and Sam, publish, republish and revoke it.')",
      now,
    );
    const main = (await resolveSystemSession('canonical', 'system:artifacts-native')).session;
    const author = (await resolveSystemSession('author', 'system:artifacts-native')).session;
    const config: WebPolicyFile = {
      schemaVersion: 1,
      enabled: true,
      hostname: 'aya.example.com',
      listenPort: 9123,
      accessIssuer: 'https://fixture.cloudflareaccess.com',
      accessAud: 'fixture-aud',
      cloudflare: {
        accountId: 'fixture',
        applicationId: 'fixture',
        operatorConfigFile: path.join(ROOT, 'unused.json'),
      },
    };
    fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify(config), { mode: 0o600 });
    vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(ROOT, 'policy.json'));
    const keys = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'native-fixture', alg: 'RS256' };
    const jwks = vi.fn(async () => Response.json({ keys: [jwk] }));
    const verifier = createWebIdentityVerifier(config.accessIssuer, config.accessAud, jwks);
    const identities = new Map<string, string>();
    for (const email of [
      'principal@example.com',
      'second@example.com',
      'third@example.com',
      'alex@example.com',
      'sam@example.com',
      'stranger@example.com',
    ])
      identities.set(
        email,
        await new SignJWT({ email })
          .setProtectedHeader({ alg: 'RS256', kid: 'native-fixture' })
          .setIssuer(config.accessIssuer)
          .setAudience(config.accessAud)
          .setExpirationTime('1h')
          .sign(keys.privateKey),
      );
    origin = createServer(
      createWebHandler(
        config.hostname,
        createArtifactViewHandler({
          hostname: config.hostname,
          resolve: createArtifactViewResolver(config, createWebIdentity(config, verifier)),
        }),
      ),
    );
    await new Promise<void>((resolve) => origin!.listen(0, '127.0.0.1', resolve));
    const address = origin.address();
    if (!address || typeof address === 'string') throw new Error('No fixture origin');
    const view = (route: string, email?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: route,
            headers: { host: config.hostname, ...(email ? { 'cf-access-jwt-assertion': identities.get(email)! } : {}) },
          },
          (response) => {
            let body = '';
            expect(response.headers['cache-control']).toBe('no-store');
            response.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.on('error', reject);
        request.end();
      });
    const stages: string[] = [];
    async function check(stage: Checkpoint): Promise<void> {
      const privatePath = `/artifacts/${stage.saved.artifact_id}`;
      const namedPath = `/artifacts/share/${stage.named.share_id}`;
      const publicPath = `/artifacts/public/${stage.published.share_id}`;
      const head = stage.revised?.source_hash ?? stage.saved.source_hash;
      for (const email of ['principal@example.com', 'second@example.com']) {
        const response = await view(privatePath, email);
        expect(response.status).toBe(200);
        expect(response.body).toContain(`/frame/${head}`);
      }
      for (const email of ['alex@example.com', 'sam@example.com']) {
        expect((await view(privatePath, email)).status).toBe(404);
        expect((await view(`/artifacts/${stage.other.artifact_id}`, email)).status).toBe(404);
        const named = await view(namedPath, email);
        expect(named.status).toBe(stage.stage === 'revoked' ? 404 : 200);
        if (named.status === 200) expect(named.body).toContain(`/frame/${stage.saved.source_hash}`);
      }
      expect((await view(namedPath, 'stranger@example.com')).status).toBe(404);
      const publishedHash = ['replaced', 'revoked'].includes(stage.stage) ? head : stage.saved.source_hash;
      const published = await view(publicPath);
      expect(published.status).toBe(200);
      expect(published.body).toContain(`/frame/${publishedHash}`);
      expect((await view(`${publicPath}/frame/${publishedHash}`)).status).toBe(200);
      if (stage.revised) {
        const unavailableHash = publishedHash === head ? stage.saved.source_hash : head;
        expect((await view(`${publicPath}/frame/${unavailableHash}`)).status).toBe(404);
        expect((await view(`${namedPath}/frame/${head}`, 'alex@example.com')).status).toBe(404);
      }
      if (stage.stage === 'revoked') {
        await getDb().run("DELETE FROM gws_ea_principal_addresses WHERE email='principal@example.com'");
        await getDb().run(
          'INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)',
          'third@example.com',
          now,
        );
        expect((await view(privatePath, 'principal@example.com')).status).toBe(404);
        expect((await view(privatePath, 'third@example.com')).status).toBe(200);
        expect((await view(privatePath, 'second@example.com')).status).toBe(200);
      }
      stages.push(stage.stage);
    }
    // Only remote admission is substituted; listener readiness and JWT verification are real.
    let admissions = 0;
    const sharing = new ArtifactSharing({
      verifyAdmission: async () => {
        admissions++;
      },
      publicationReady: () => origin?.listening === true,
    });
    let nativeRequests = 0;
    let crossMountReadRetries = 0;
    const deliveryPollMs = 1_000;
    async function run(session: Session, phase: 'author' | 'main'): Promise<string> {
      const workspace = sessionDir(session.agent_group_id, session.id);
      fs.mkdirSync(path.join(workspace, 'agent'), { recursive: true });
      if (phase === 'main')
        fs.writeFileSync(path.join(workspace, 'agent/references.json'), JSON.stringify(authorEvidence.examples));
      const repo = process.cwd();
      const mounts = [
        `${path.join(repo, 'container/agent-runner/src')}:/app/src:ro`,
        `${path.join(repo, 'container/agent-runner/node_modules')}:/app/node_modules:ro`,
        `${workspace}:/workspace`,
      ];
      const cidfile = path.join(ROOT, `${phase}.cid`);
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--cidfile',
          cidfile,
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--user',
          `${process.getuid!()}:${process.getgid!()}`,
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=128m',
          ...mounts.flatMap((mount) => ['--volume', mount]),
          '--env',
          'BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-cache',
          '--env',
          'HTTPS_PROXY=http://127.0.0.1:9',
          '--workdir',
          '/app',
          '--entrypoint',
          'bun',
          process.env.GWS_EA_ARTIFACT_NATIVE_IMAGE!,
          '--no-install',
          '/app/src/artifacts/native-acceptance.fixture.ts',
          phase,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let finished = false;
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      void exit.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      const handled = new Set<string>();
      const checked = new Set<string>();
      const deadline = Date.now() + 80_000;
      try {
        while (!finished && Date.now() < deadline) {
          const db = openOutboundDb(outboundDbPath(session.agent_group_id, session.id));
          let rows: ReturnType<typeof getDueOutboundMessages> = [];
          let retryRead = false;
          try {
            rows = getDueOutboundMessages(db);
          } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'SQLITE_READONLY_ROLLBACK') {
              crossMountReadRetries++;
              retryRead = true;
            } else throw error;
          } finally {
            db.close();
          }
          if (retryRead) {
            await delay(deliveryPollMs);
            continue;
          }
          for (const row of rows) {
            if (handled.has(row.id)) continue;
            handled.add(row.id);
            nativeRequests++;
            const content = JSON.parse(row.content) as Record<string, unknown>;
            if (content.action === 'artifact_list' && content.limit === 1) await delay(50);
            const action = ARTIFACT_ACTIONS.find(([name]) => name === content.action);
            if (action) await runGuarded(action[0], action[2], action[1], content, session, null);
            else if (content.action === 'artifact_share')
              await runGuarded('artifact_share', sharing.deliveryGuard, sharing.handler, content, session, null);
            else throw new Error(`Unexpected native action ${String(content.action)}`);
          }
          const checkpointFile = path.join(workspace, 'agent/checkpoint.json');
          if (fs.existsSync(checkpointFile)) {
            const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) as Checkpoint;
            if (!checked.has(checkpoint.stage)) {
              await check(checkpoint);
              checked.add(checkpoint.stage);
              fs.writeFileSync(path.join(workspace, 'agent/checked.txt'), checkpoint.stage);
            }
          }
          await delay(deliveryPollMs);
        }
        expect(finished, `Native ${phase} exceeded its bounded deadline: ${stderr}`).toBe(true);
        expect(await exit, stderr).toBe(0);
        return workspace;
      } finally {
        if (fs.existsSync(cidfile)) {
          const id = fs.readFileSync(cidfile, 'utf8').trim();
          expect(id, 'Owned fixture container ID').toMatch(/^[a-f0-9]{64}$/u);
          await promisify(execFile)('docker', ['rm', '--force', id], { timeout: 10_000 }).catch((error: unknown) => {
            if (!(error instanceof Error) || !error.message.includes('No such container')) throw error;
          });
        }
        if (!finished) child.kill('SIGTERM');
        await Promise.race([exit, delay(10_000)]);
      }
    }
    const authorWorkspace = await run(author, 'author');
    const authorEvidence = JSON.parse(
      fs.readFileSync(path.join(authorWorkspace, 'agent/native-result.json'), 'utf8'),
    ) as AuthorEvidence;
    expect(authorEvidence.examples).toHaveLength(3);
    expect(authorEvidence.native_save.p95_ms).toBeLessThanOrEqual(3000);
    const mainWorkspace = await run(main, 'main');
    expect(stages).toEqual(['initial', 'private-revised', 'replaced', 'revoked']);
    expect(admissions).toBe(1);
    expect(jwks).toHaveBeenCalledTimes(1);
    const measuredPath = `/artifacts/${authorEvidence.measured.artifact_id}`;
    expect((await view(measuredPath, 'second@example.com')).status).toBe(200);
    const durations: number[] = [];
    for (let index = 0; index < 50; index++) {
      const start = performance.now();
      expect((await view(measuredPath, 'second@example.com')).status).toBe(200);
      durations.push(performance.now() - start);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    expect(p95).toBeLessThanOrEqual(100);
    expect(jwks).toHaveBeenCalledTimes(1);
    const directory = process.env.GWS_EA_ARTIFACT_EVIDENCE_DIR;
    if (directory) {
      fs.mkdirSync(directory, { recursive: true });
      for (const [name, workspace] of [
        ['native-author', authorWorkspace],
        ['native-main', mainWorkspace],
      ])
        fs.cpSync(path.join(workspace, 'agent'), path.join(directory, name), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'native-performance.json'),
        JSON.stringify(
          {
            ...authorEvidence,
            origin: { samples: 50, p95_ms: p95, durations_ms: durations },
            admission_fixture_calls: admissions,
            jwks_fixture_calls: jwks.mock.calls.length,
            handled_native_requests: nativeRequests,
            delivery_poll_ms: deliveryPollMs,
            runner_answer_poll_ms: 500,
            cross_mount_read_retries: crossMountReadRetries,
            http_stages: stages,
            shell_capability: false,
          },
          null,
          2,
        ),
      );
    }
  },
  180_000,
);
