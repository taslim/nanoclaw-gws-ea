import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadSecretSource, parsePrincipalEmailFlags } from './create-input.js';
import { redact, REDACTED } from './redact.js';
import { normalizePrincipalEmail } from './validation.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function configRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-secrets-'));
  roots.push(root);
  const config = path.join(root, 'config');
  await mkdir(config, { mode: 0o700 });
  return config;
}

async function secretsFile(directory: string, contents: string, mode = 0o600): Promise<string> {
  const file = path.join(directory, 'secrets.env');
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
  return file;
}

describe('principal email inputs', () => {
  it('keeps every --principal-email once, lowercased, in the order given', () => {
    expect(parsePrincipalEmailFlags([' Ada@Example.TEST ', 'second@work.example.test', 'ada@example.test'])).toEqual([
      'ada@example.test',
      'second@work.example.test',
    ]);
    expect(parsePrincipalEmailFlags([])).toEqual([]);
  });

  it.each(['not-an-email', 'ada@example', 'a`b@example.test', `${'a'.repeat(250)}@example.test`])(
    'refuses %s at input, naming the flag',
    (value) => {
      expect(() => parsePrincipalEmailFlags(['ada@example.test', value])).toThrow(
        expect.objectContaining({
          code: 'invalid_arguments',
          message: expect.stringMatching(/^--principal-email: /u),
          details: { flag: '--principal-email' },
        }),
      );
    },
  );

  it('normalizes one address the way every layer stores it, or says it cannot be one', () => {
    expect(normalizePrincipalEmail(' Ada@Example.TEST')).toBe('ada@example.test');
    expect(normalizePrincipalEmail('ada@example')).toBeUndefined();
  });
});

describe('secret inputs', () => {
  it('reads secrets from the environment first, then an owner-only file, and registers them', async () => {
    const root = await configRoot();
    const fileSecret = `file-provider-${Date.now()}-secret`;
    const file = await secretsFile(
      root,
      `# operator secrets\nGWS_EA_PROVIDER_CREDENTIAL="${fileSecret}"\nGWS_EA_CLOUDFLARE_API_TOKEN=from-file-token\n`,
      0o400,
    );

    const source = await loadSecretSource({
      environment: { GWS_EA_CLOUDFLARE_API_TOKEN: 'from-environment-token' },
      file,
      configRoot: root,
    });

    expect(source.get('providerCredential')).toBe(fileSecret);
    expect(source.get('cloudflareAccountToken')).toBe('from-environment-token');
    expect(redact(fileSecret)).toBe(REDACTED);
    expect(redact('from-environment-token')).toBe(REDACTED);
  });

  it('supplies nothing when neither source has a value', async () => {
    const source = await loadSecretSource({ environment: {}, configRoot: await configRoot() });
    expect(source.get('providerCredential')).toBeUndefined();
  });

  it.each([
    [
      'outside the config root',
      async (root: string) => secretsFile(path.dirname(root), 'GWS_EA_PROVIDER_CREDENTIAL=x\n'),
    ],
    ['readable by the group', async (root: string) => secretsFile(root, 'GWS_EA_PROVIDER_CREDENTIAL=x\n', 0o640)],
    [
      'a symlink into the config root',
      async (root: string) => {
        const target = await secretsFile(root, 'GWS_EA_PROVIDER_CREDENTIAL=x\n');
        const link = path.join(root, 'link.env');
        await symlink(target, link);
        return link;
      },
    ],
    ['missing', async (root: string) => path.join(root, 'absent.env')],
  ])('refuses a secrets file %s', async (_case, create) => {
    const root = await configRoot();
    const file = await create(root);
    await expect(loadSecretSource({ environment: {}, file, configRoot: root })).rejects.toMatchObject({
      code: expect.stringMatching(/^(unsafe_secrets_file|secrets_file_missing)$/u),
    });
  });

  it('refuses a secrets file elsewhere even before the config root exists', async () => {
    const root = await configRoot();
    const file = await secretsFile(path.dirname(root), 'GWS_EA_PROVIDER_CREDENTIAL=x\n');
    await expect(
      loadSecretSource({ environment: {}, file, configRoot: path.join(root, 'not-created') }),
    ).rejects.toMatchObject({ code: 'unsafe_secrets_file' });
    await expect(
      loadSecretSource({
        environment: {},
        file: path.join(root, 'not-created', 's.env'),
        configRoot: path.join(root, 'not-created'),
      }),
    ).rejects.toMatchObject({ code: 'secrets_file_missing' });
  });

  it('refuses unknown or malformed entries without echoing their values', async () => {
    const root = await configRoot();
    const file = await secretsFile(root, 'GWS_EA_TYPO_TOKEN=leak-canary\n');
    const error = await loadSecretSource({ environment: {}, file, configRoot: root }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'invalid_secrets_file' });
    expect(String((error as Error).message)).toContain('GWS_EA_TYPO_TOKEN');
    expect(String((error as Error).message)).not.toContain('leak-canary');
  });
});
