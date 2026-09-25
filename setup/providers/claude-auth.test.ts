import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';

const fixture = vi.hoisted(() => ({
  select: vi.fn(),
  password: vi.fn(),
  runInheritScript: vi.fn(),
}));

vi.mock('../lib/bright-select.js', () => ({ brightSelect: fixture.select }));
vi.mock('@clack/prompts', () => ({
  isCancel: () => false,
  password: fixture.password,
}));
vi.mock('../lib/inherit-script.js', () => ({
  buildInteractiveEnvironment: () => ({ NANOCLAW_SETUP_WIZARD: '1', HOME: '/Users/operator' }),
  runInheritScript: fixture.runInheritScript,
}));

import { claudeCredentialMetadata, collectClaudeCredential } from './claude-auth.js';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.runInheritScript.mockResolvedValue(0);
  vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', '');
  vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', '');
});

afterEach(() => vi.unstubAllEnvs());

describe('shared Claude credential flow', () => {
  it('collects an API key through the same provider flow used by setup and GWS-EA', async () => {
    fixture.select.mockResolvedValue('api');
    fixture.password.mockResolvedValue('sk-ant-api-test-value');

    await expect(collectClaudeCredential({ allowSkip: false })).resolves.toEqual({
      method: 'api',
      credential: {
        name: 'Anthropic',
        type: 'anthropic',
        value: 'sk-ant-api-test-value',
        hostPattern: 'api.anthropic.com',
      },
    });
    expect(fixture.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'How would you like to connect to Claude?',
        options: expect.not.arrayContaining([expect.objectContaining({ value: 'skip' })]),
      }),
    );
  });

  it('describes and collects a configured compatible endpoint without a second questionnaire', async () => {
    vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', 'https://models.example.test/v1');
    vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', 'private-token');

    expect(claudeCredentialMetadata({ allowAmbientConfiguration: true })).toEqual({
      name: 'Anthropic',
      type: 'generic',
      hostPattern: 'models.example.test',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    });
    await expect(collectClaudeCredential({ allowSkip: false, allowAmbientConfiguration: true })).resolves.toMatchObject(
      {
        method: 'custom-endpoint',
        credential: { value: 'private-token' },
      },
    );
    expect(fixture.select).not.toHaveBeenCalled();
    expect(fixture.password).not.toHaveBeenCalled();
  });

  it('does not inherit an ambient credential into an isolated assistant vault', async () => {
    vi.stubEnv('NANOCLAW_ANTHROPIC_BASE_URL', 'https://models.example.test/v1');
    vi.stubEnv('NANOCLAW_ANTHROPIC_AUTH_TOKEN', 'ambient-secret');
    fixture.select.mockResolvedValue('api');
    fixture.password.mockResolvedValue('sk-ant-api-explicit');

    expect(claudeCredentialMetadata({ allowAmbientConfiguration: false })).toEqual({
      name: 'Anthropic',
      type: 'anthropic',
      hostPattern: 'api.anthropic.com',
    });
    await expect(
      collectClaudeCredential({ allowSkip: false, allowAmbientConfiguration: false }),
    ).resolves.toMatchObject({ credential: { value: 'sk-ant-api-explicit' } });
    expect(fixture.select).toHaveBeenCalledOnce();
  });

  it('runs subscription authentication through the sanitized inherited-TTY seam', async () => {
    fixture.select.mockResolvedValue('subscription');
    const token = `sk-ant-oat${'a'.repeat(80)}AA`;
    fixture.runInheritScript.mockImplementation(async (_command, args: string[]) => {
      await writeFile(args[2]!, token, { mode: 0o600 });
      return 0;
    });

    await expect(collectClaudeCredential({ allowSkip: false, allowAmbientConfiguration: false })).resolves.toEqual({
      method: 'subscription',
      credential: {
        name: 'Anthropic',
        type: 'anthropic',
        value: token,
        hostPattern: 'api.anthropic.com',
      },
    });
    expect(fixture.runInheritScript).toHaveBeenCalledWith(
      '/bin/bash',
      ['.claude/skills/add-onecli/scripts/register-claude-token.sh', '--output-file', expect.any(String)],
      { env: { NANOCLAW_SETUP_WIZARD: '1', HOME: '/Users/operator' } },
    );
  });
});
