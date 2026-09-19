import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

import { buildInteractiveEnvironment, runInheritScript } from '../lib/inherit-script.js';
import { brightSelect } from '../lib/bright-select.js';
import type {
  CollectedProviderCredential,
  SetupProviderCredentialMetadata,
  SetupProviderProvisioning,
} from './registry.js';

const ANTHROPIC_HOST = 'api.anthropic.com';

function customEndpointCredential(allowAmbientConfiguration: boolean): CollectedProviderCredential | undefined {
  if (!allowAmbientConfiguration) return undefined;
  const baseUrl = process.env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const value = process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (!baseUrl || !value) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`Invalid Anthropic base URL: ${baseUrl}`);
  }
  return {
    method: 'custom-endpoint',
    credential: {
      name: 'Anthropic',
      type: 'generic',
      value,
      hostPattern: host,
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    },
  };
}

export function claudeCredentialMetadata(
  options: {
    readonly allowAmbientConfiguration?: boolean;
  } = {},
): SetupProviderCredentialMetadata {
  const custom = customEndpointCredential(options.allowAmbientConfiguration === true);
  if (custom) {
    const { value: _value, ...metadata } = custom.credential;
    return metadata;
  }
  return { name: 'Anthropic', type: 'anthropic', hostPattern: ANTHROPIC_HOST };
}

function cancelled(value: unknown): never {
  if (p.isCancel(value)) throw new Error('Provider authentication was cancelled');
  throw new Error('Provider authentication returned an invalid answer');
}

async function collectSubscriptionToken(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanoclaw-claude-auth-'));
  const outputFile = path.join(directory, 'credential');
  try {
    const exitCode = await runInheritScript(
      '/bin/bash',
      ['setup/register-claude-token.sh', '--output-file', outputFile],
      { env: buildInteractiveEnvironment() },
    );
    if (exitCode !== 0) throw new Error("Couldn't complete the Claude sign-in");
    const info = await stat(outputFile);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      throw new Error('Claude sign-in produced an unsafe credential file');
    }
    const token = (await readFile(outputFile, 'utf8')).trim();
    if (!/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/u.test(token)) {
      throw new Error('Claude sign-in returned an invalid OAuth token');
    }
    return token;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collectPastedToken(method: 'oauth' | 'api'): Promise<string> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';
  const answer = await p.password({
    message: `Paste your ${label}`,
    clearOnError: true,
    validate: (value) => {
      const cleaned = (value ?? '').replace(/\s+/gu, '');
      if (!cleaned) return 'Required';
      if (!cleaned.startsWith(prefix)) return `Should start with ${prefix}…`;
      if (method === 'oauth' && !/^sk-ant-oat[A-Za-z0-9_-]{80,500}AA$/u.test(cleaned)) {
        return cleaned.length < 90
          ? 'Token looks truncated — widen your terminal so it fits on one line, then paste again.'
          : "Token shape doesn't look right (expected sk-ant-oat…AA).";
      }
      return undefined;
    },
  });
  if (p.isCancel(answer) || typeof answer !== 'string') return cancelled(answer);
  return answer.replace(/\s+/gu, '');
}

export async function collectClaudeCredential(options: {
  readonly allowSkip: boolean;
  readonly allowAmbientConfiguration?: boolean;
}): Promise<CollectedProviderCredential | null> {
  const custom = customEndpointCredential(options.allowAmbientConfiguration === true);
  if (custom) return custom;

  const choices = [
    {
      value: 'subscription',
      label: 'Sign in with my Claude subscription',
      hint: 'recommended if you have Pro or Max',
    },
    { value: 'oauth', label: 'Paste an OAuth token I already have', hint: 'sk-ant-oat…' },
    { value: 'api', label: 'Paste an Anthropic API key', hint: 'pay-per-use via console.anthropic.com' },
  ];
  if (options.allowSkip) {
    choices.push({
      value: 'skip',
      label: "Skip — I'll connect later",
      hint: 'the assistant cannot run until connected',
    });
  }
  const answer = await brightSelect<string>({
    message: 'How would you like to connect to Claude?',
    options: choices,
  });
  if (p.isCancel(answer) || typeof answer !== 'string') return cancelled(answer);
  if (answer === 'skip') return null;
  if (answer !== 'subscription' && answer !== 'oauth' && answer !== 'api') return cancelled(answer);

  const value = answer === 'subscription' ? await collectSubscriptionToken() : await collectPastedToken(answer);
  return {
    method: answer,
    credential: { ...claudeCredentialMetadata(), value },
  };
}

export const claudeProvisioning: SetupProviderProvisioning = {
  credentialMetadata: claudeCredentialMetadata,
  collectCredential: collectClaudeCredential,
};
