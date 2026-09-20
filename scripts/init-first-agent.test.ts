/**
 * scripts/init-first-agent.ts --instance: the DM row is created for that
 * exact adapter instance and the welcome is addressed to it.
 *
 * What breaks without it: wiring a second Telegram bot (registry key
 * telegram-mega) lands on the default bot's messaging_groups row and the
 * welcome goes out through the default bot.
 * Kill condition: drop `args.instance` from createMessagingGroup (the row's
 * instance falls back to 'telegram'), or from the getMessagingGroupByPlatform
 * lookups (the seeded-default case reuses the default row instead of creating
 * its own), or `instance: dmMg.instance` from the socket payload
 * (to.instance vanishes), or the URL-safe check in parseArgs (a key with a
 * space is accepted and stored).
 *
 * Drives the real entry point in a child process against a temp cwd
 * (PROJECT_ROOT = cwd, so data/v2.db and data/cli.sock are temp) with a fake
 * CLI socket standing in for the running service. Same shape as
 * scripts/migrate.test.ts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, 'init-first-agent.ts');
const TSX_LOADER = path.resolve(import.meta.dirname, '../node_modules/tsx/dist/loader.mjs');

interface MgRow {
  channel_type: string;
  platform_id: string;
  instance: string;
}

interface BootstrapRows {
  userDms: number;
  roles: number;
  members: number;
  wirings: Array<{ sender_scope: string; session_mode: string }>;
}

function installGwsProfileTables(db: Database.Database, mainAgentGroupId: string, verifiedUserId?: string): void {
  db.exec(`
    CREATE TABLE gws_ea_profile (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      assistant_display_name TEXT,
      assistant_workspace_email TEXT,
      principal_display_name TEXT,
      principal_timezone TEXT,
      main_agent_group_id TEXT UNIQUE REFERENCES agent_groups(id),
      updated_at TEXT
    );
    CREATE TABLE gws_ea_principal_users (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      verified_at TEXT NOT NULL
    );
    INSERT INTO gws_ea_profile (singleton) VALUES (1);
  `);
  db.prepare('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1').run(mainAgentGroupId);
  db.prepare(
    `INSERT INTO schema_version (version, name, applied)
     VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM schema_version), ?, ?)`,
  ).run('module:gws-ea-profile:create-profile', new Date().toISOString());
  if (verifiedUserId) {
    db.prepare('INSERT INTO gws_ea_principal_users (user_id, verified_at) VALUES (?, ?)').run(
      verifiedUserId,
      new Date().toISOString(),
    );
  }
}

describe('scripts/init-first-agent.ts --instance', () => {
  let cwd: string;
  let server: net.Server;
  let nextWelcome: ((line: { id?: string; to: Record<string, unknown> }) => void) | null = null;
  /** Resolves with the next JSON line the script writes to the CLI socket. */
  const welcome = () =>
    new Promise<{ id?: string; to: Record<string, unknown> }>((resolve) => {
      nextWelcome = resolve;
    });

  beforeEach(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ifa-'));
    fs.mkdirSync(path.join(cwd, 'data'));
    server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
      });
      socket.on('end', () => nextWelcome?.(JSON.parse(buf.trim())));
    });
    await new Promise<void>((resolve) => server.listen(path.join(cwd, 'data', 'cli.sock'), resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function run(extra: string[]): Promise<{ status: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const args = [
        '--import',
        TSX_LOADER,
        SCRIPT,
        '--channel',
        'telegram',
        '--user-id',
        'telegram:42',
        '--platform-id',
        'telegram:42',
        '--display-name',
        'Amit',
        ...extra,
      ];
      const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  function messagingGroups(): MgRow[] {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return db
        .prepare('SELECT channel_type, platform_id, instance FROM messaging_groups ORDER BY instance')
        .all() as MgRow[];
    } finally {
      db.close();
    }
  }

  function bootstrapRows(): BootstrapRows {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return {
        userDms: (db.prepare('SELECT count(*) AS count FROM user_dms').get() as { count: number }).count,
        roles: (db.prepare('SELECT count(*) AS count FROM user_roles').get() as { count: number }).count,
        members: (db.prepare('SELECT count(*) AS count FROM agent_group_members').get() as { count: number }).count,
        wirings: db
          .prepare('SELECT sender_scope, session_mode FROM messaging_group_agents ORDER BY id')
          .all() as Array<{ sender_scope: string; session_mode: string }>,
      };
    } finally {
      db.close();
    }
  }

  function hasTable(name: string): boolean {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
    } finally {
      db.close();
    }
  }

  function destinationCount(agentGroupId: string): number {
    const db = new Database(path.join(cwd, 'data', 'v2.db'), { readonly: true });
    try {
      return (
        db
          .prepare(
            `SELECT count(*) AS count
               FROM agent_destinations
              WHERE agent_group_id = ? AND target_type = 'channel'`,
          )
          .get(agentGroupId) as { count: number }
      ).count;
    } finally {
      db.close();
    }
  }

  it('creates the DM row for the named instance and addresses the welcome to it', async () => {
    const w = welcome();
    const r = await run(['--instance', 'telegram-mega']);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram-mega' },
    ]);
    expect((await w).to).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:42',
      threadId: 'telegram:42',
      instance: 'telegram-mega',
    });
  }, 60_000);

  it('without --instance keeps the default-instance row (instance = channel_type)', async () => {
    const w = welcome();
    const r = await run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([{ channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram' }]);
    expect((await w).to).toMatchObject({ platformId: 'telegram:42', instance: 'telegram' });
    expect(bootstrapRows().userDms).toBe(0);
    expect(hasTable('gws_ea_profile')).toBe(false);
    expect(hasTable('gws_ea_principal_users')).toBe(false);
  }, 60_000);

  // The same chat paired on the default bot and on a named bot: two rows,
  // the default row untouched, the second welcome through the named bot.
  it('with the default-instance row already present, --instance creates its own exact row and addresses the welcome to it', async () => {
    const w1 = welcome();
    expect((await run([])).status).toBe(0); // bot #1 already wired
    await w1;
    const w2 = welcome();
    const r = await run(['--instance', 'telegram-mega']);
    expect(r.status, r.stderr).toBe(0);
    expect(messagingGroups()).toEqual([
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram' },
      { channel_type: 'telegram', platform_id: 'telegram:42', instance: 'telegram-mega' },
    ]);
    expect((await w2).to).toEqual({
      channelType: 'telegram',
      platformId: 'telegram:42',
      threadId: 'telegram:42',
      instance: 'telegram-mega',
    });
  }, 90_000);

  it('rejects an --instance that is not a URL-safe registry key before touching the DB', async () => {
    const r = await run(['--instance', 'telegram mega']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--instance must be a URL-safe adapter registry key');
    expect(fs.existsSync(path.join(cwd, 'data', 'v2.db'))).toBe(false);
  }, 60_000);

  it('persists the verified DM and repairs its destination when resuming an interrupted wiring', async () => {
    const seedWelcome = welcome();
    const seeded = await run(['--instance', 'telegram-mega']);
    expect(seeded.status, seeded.stderr).toBe(0);
    await seedWelcome;
    expect(bootstrapRows().userDms).toBe(0);
    const db = new Database(path.join(cwd, 'data', 'v2.db'));
    const targetGroupId = (db.prepare('SELECT id FROM agent_groups LIMIT 1').get() as { id: string }).id;
    db.prepare('DELETE FROM messaging_group_agents').run();
    installGwsProfileTables(db, targetGroupId, 'telegram:42');
    db.close();

    const flags = [
      '--instance',
      'telegram-mega',
      '--agent-group-id',
      targetGroupId,
      '--verified-principal',
      '--role',
      'owner',
      '--sender-scope',
      'known',
      '--session-mode',
      'agent-shared',
      '--event-id',
      'gws-ea-welcome:stable',
    ];
    const firstWelcome = welcome();
    const first = await run(flags);
    expect(first.status, first.stderr).toBe(0);
    expect((await firstWelcome).id).toBe('gws-ea-welcome:stable');

    const interrupted = new Database(path.join(cwd, 'data', 'v2.db'));
    interrupted
      .prepare("DELETE FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel'")
      .run(targetGroupId);
    interrupted.close();
    expect(destinationCount(targetGroupId)).toBe(0);

    const secondWelcome = welcome();
    const second = await run(flags);
    expect(second.status, second.stderr).toBe(0);
    expect((await secondWelcome).id).toBe('gws-ea-welcome:stable');
    expect(destinationCount(targetGroupId)).toBe(1);
    expect(bootstrapRows()).toEqual({
      userDms: 1,
      roles: 1,
      members: 1,
      wirings: [{ sender_scope: 'known', session_mode: 'agent-shared' }],
    });
  }, 90_000);

  it('rejects verified-principal bootstrap when the target main user was not independently verified', async () => {
    const seedWelcome = welcome();
    expect((await run(['--instance', 'telegram-mega'])).status).toBe(0);
    await seedWelcome;
    const db = new Database(path.join(cwd, 'data', 'v2.db'));
    const targetGroupId = (db.prepare('SELECT id FROM agent_groups LIMIT 1').get() as { id: string }).id;
    db.prepare('DELETE FROM messaging_group_agents').run();
    installGwsProfileTables(db, targetGroupId);
    db.close();

    const result = await run([
      '--instance',
      'telegram-mega',
      '--agent-group-id',
      targetGroupId,
      '--verified-principal',
      '--role',
      'owner',
      '--sender-scope',
      'known',
      '--session-mode',
      'agent-shared',
      '--event-id',
      'gws-ea-welcome:unverified',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not mapped to a verified principal');
    expect(bootstrapRows().wirings).toEqual([]);
  }, 90_000);

  it('keeps an ordinary existing wiring unchanged on a vanilla rerun', async () => {
    const firstWelcome = welcome();
    expect((await run([])).status).toBe(0);
    await firstWelcome;

    const secondWelcome = welcome();
    const rerun = await run(['--engage-pattern', '^hello$']);
    expect(rerun.status, rerun.stderr).toBe(0);
    await secondWelcome;
    expect(bootstrapRows().wirings).toEqual([{ sender_scope: 'all', session_mode: 'shared' }]);
  }, 90_000);

  it('fails closed when an existing wiring does not match requested bootstrap semantics', async () => {
    const firstWelcome = welcome();
    expect((await run([])).status).toBe(0);
    await firstWelcome;

    const result = await run(['--sender-scope', 'known', '--session-mode', 'agent-shared']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match requested bootstrap');
    expect(bootstrapRows()).toMatchObject({
      userDms: 0,
      wirings: [{ sender_scope: 'all', session_mode: 'shared' }],
    });
  }, 90_000);
});
