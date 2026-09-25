import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REDACTED,
  createStreamRedactor,
  envKeyNames,
  redact,
  registerSecret,
  registerSecretDirectory,
} from './redact.js';

const PEM_BODY = [
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
  'k3n0dBase64BodyLineTwoAbCdEfGhIjKlMnOpQrStUvWxYz0123',
];
const PEM = ['-----BEGIN PRIVATE KEY-----', ...PEM_BODY, '-----END PRIVATE KEY-----'].join('\n');

function uniqueSecret(label: string): string {
  return `${label}-${randomBytes(12).toString('hex')}`;
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('GWS-EA redactor', () => {
  it('redacts registered secret values, including their JSON-escaped and per-line forms', () => {
    const secret = uniqueSecret('value');
    const multiLine = `${uniqueSecret('first')}\n${uniqueSecret('second')}`;
    registerSecret(secret);
    registerSecret(multiLine);
    const [firstLine, secondLine] = multiLine.split('\n');

    expect(redact(`token=${secret}; retry`)).toBe(`token=${REDACTED}; retry`);
    expect(redact(JSON.stringify({ value: multiLine }))).not.toContain(firstLine!);
    expect(redact(`only the second line leaked: ${secondLine}`)).toBe(`only the second line leaked: ${REDACTED}`);
  });

  it('ignores values too short to be distinguishable secrets', () => {
    registerSecret('short');
    registerSecret('   ');
    expect(redact('a short answer')).toBe('a short answer');
  });

  it('registers every file in a secret directory and tolerates a missing directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-redact-'));
    roots.push(root);
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const apiKey = uniqueSecret('api-key');
    const nestedToken = uniqueSecret('nested');
    await writeFile(path.join(root, 'onecli-admin-api-key'), `${apiKey}\n`, { mode: 0o600 });
    await writeFile(path.join(nested, 'tunnel-token'), nestedToken, { mode: 0o600 });

    await registerSecretDirectory(root);
    await registerSecretDirectory(path.join(root, 'absent'));

    expect(redact(`stderr: rejected ${apiKey}`)).toBe(`stderr: rejected ${REDACTED}`);
    expect(redact(`connector ${nestedToken}`)).toBe(`connector ${REDACTED}`);
  });

  it('redacts PEM blocks, including JSON-escaped newlines and truncated blocks', () => {
    expect(redact(`before\n${PEM}\nafter`)).toBe(`before\n${REDACTED}\nafter`);

    const escaped = JSON.stringify({ private_key: `${PEM}\n`, client_email: 'bot@example.com' });
    const redactedEscaped = redact(escaped);
    expect(redactedEscaped).not.toContain(PEM_BODY[0]);
    expect(redactedEscaped).toContain('bot@example.com');

    expect(redact(`tail starts mid-key\n${PEM_BODY[1]}\n-----END PRIVATE KEY-----\nlater`)).toBe(`${REDACTED}\nlater`);
    expect(redact(`head\n-----BEGIN PRIVATE KEY-----\n${PEM_BODY[0]}`)).toBe(`head\n${REDACTED}`);
  });

  it('redacts private_key fields even without PEM markers', () => {
    expect(redact('{"private_key": "c29tZS1rZXktbWF0ZXJpYWw=", "type": "service_account"}')).toBe(
      `{"private_key": "${REDACTED}", "type": "service_account"}`,
    );
    expect(redact('{\\"private_key\\": \\"c29tZS1rZXk\\\\n\\"}')).toBe(`{\\"private_key\\": \\"${REDACTED}\\"}`);
  });

  it('redacts bearer headers, URL-embedded passwords, and known token prefixes', () => {
    expect(redact('Authorization: Bearer abc.def-ghi_123')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redact('fetch https://operator:hunter2secret@example.com/repo.git')).toBe(
      `fetch https://operator:${REDACTED}@example.com/repo.git`,
    );
    expect(redact('token ya29.a0AfH6SMBx-y_z')).toBe(`token ${REDACTED}`);
    expect(redact('key sk-ant-api03-AbC_dEf-123')).toBe(`key ${REDACTED}`);
    expect(redact('onecli oc_AbCdEfGhIjKlMnOpQrStUv')).toBe(`onecli ${REDACTED}`);
    expect(redact('tunnel eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQ==')).toBe(`tunnel ${REDACTED}`);
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl done')).toBe(`jwt ${REDACTED} done`);
  });

  it('leaves ordinary diagnostics intact', () => {
    const diagnostic =
      'ERROR: (gcloud.projects.describe) NOT_FOUND: Project gws-ea-1234 was not found (proc_oc_handler, key-id 42)';
    expect(redact(diagnostic)).toBe(diagnostic);
  });

  it('keeps a PEM block redacted when a stream splits it across chunks', () => {
    const stream = createStreamRedactor();
    const secret = uniqueSecret('streamed');
    registerSecret(secret);
    const output = [
      stream.push('step 1/3\n-----BEGIN RSA PRIVATE KEY-----\n'),
      stream.push(`${PEM_BODY[0]}\n`),
      stream.push(`${PEM_BODY[1]}\n-----END RSA PRIVATE KEY-----\nstep 2/3 ${secret.slice(0, 10)}`),
      stream.push(`${secret.slice(10)}\nstep 3/3`),
      stream.end(),
    ].join('');

    expect(output).toBe(`step 1/3\n${REDACTED}\nstep 2/3 ${REDACTED}\nstep 3/3`);
  });

  it('reads .env content as key names only', () => {
    expect(
      envKeyNames('# comment\nONECLI_URL=http://127.0.0.1:1\n\nexport GCHAT_ENDPOINT_URL=https://x\nnot a pair\n'),
    ).toEqual(['ONECLI_URL', 'GCHAT_ENDPOINT_URL']);
  });
});
