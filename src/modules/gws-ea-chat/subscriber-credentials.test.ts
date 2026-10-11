import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSubscriberToken, PUBSUB_SCOPE, SubscriberCredentialError } from './subscriber-credentials.js';
import { FakeGoogleEvents, PROJECT, SUBSCRIBER_TOKEN } from './testing/fake-google-events.js';

const CLIENT_EMAIL = `gws-ea-chat@${PROJECT}.iam.gserviceaccount.com`;

let root: string;
let keyFile: string;
let fake: FakeGoogleEvents;

function writeKey(fields: Record<string, unknown>, mode = 0o600): void {
  fs.writeFileSync(keyFile, JSON.stringify(fields), { mode });
  fs.chmodSync(keyFile, mode);
}

function serviceAccountKey(): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    type: 'service_account',
    project_id: PROJECT,
    private_key_id: 'key-juno-1',
    private_key: privateKey,
    client_email: CLIENT_EMAIL,
  };
}

function jwtClaims(assertion: string): Record<string, unknown> {
  const payload = assertion.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-ea-chat-subscriber-'));
  keyFile = path.join(root, 'chat-subscriber.json');
  fake = new FakeGoogleEvents();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the subscriber token', () => {
  it("mints a Pub/Sub token from the owner-only key, signed as the subscriber's account", async () => {
    writeKey(serviceAccountKey());
    const token = createSubscriberToken({ keyFile, fetch: fake.fetch });

    await expect(token()).resolves.toBe(SUBSCRIBER_TOKEN);
    const [exchange] = fake.requests;
    expect(exchange?.url.href).toBe('https://oauth2.googleapis.com/token');
    const body = exchange?.body as Record<string, string>;
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(jwtClaims(body.assertion ?? '')).toMatchObject({ iss: CLIENT_EMAIL, scope: PUBSUB_SCOPE });

    // Held until it nears expiry.
    await expect(token()).resolves.toBe(SUBSCRIBER_TOKEN);
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses a key that is missing, readable by others, or not a service account key', async () => {
    const token = createSubscriberToken({ keyFile, fetch: fake.fetch });
    await expect(token()).rejects.toThrow(
      new SubscriberCredentialError(`The Chat subscriber key is missing: ${keyFile}`),
    );

    writeKey(serviceAccountKey(), 0o644);
    await expect(token()).rejects.toThrow(SubscriberCredentialError);
    await expect(token()).rejects.toThrow('readable only by its owner');

    writeKey({ type: 'service_account', client_email: CLIENT_EMAIL });
    await expect(token()).rejects.toThrow(
      new SubscriberCredentialError(`The Chat subscriber key is not a service account key: ${keyFile}`),
    );
    expect(fake.requests).toEqual([]);
  });

  it('refuses a key Google refuses, and reads the key again on the next call', async () => {
    writeKey(serviceAccountKey());
    fake.tokenFailure = { status: 400, error: 'invalid_grant' };
    const token = createSubscriberToken({ keyFile, fetch: fake.fetch });
    await expect(token()).rejects.toThrow(SubscriberCredentialError);
    await expect(token()).rejects.toThrow('invalid_grant');

    // The operator replaces the key with a new account's: the next token is signed with it.
    fake.tokenFailure = undefined;
    const replaced = `gws-ea-chat-2@${PROJECT}.iam.gserviceaccount.com`;
    writeKey({ ...serviceAccountKey(), client_email: replaced });
    await expect(token()).resolves.toBe(SUBSCRIBER_TOKEN);
    const exchange = fake.requests.at(-1)?.body as Record<string, string>;
    expect(jwtClaims(exchange.assertion ?? '')).toMatchObject({ iss: replaced });
  });
});
