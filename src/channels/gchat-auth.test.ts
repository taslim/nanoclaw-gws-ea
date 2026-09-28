import { createGoogleChatAdapter, type GoogleChatAdapter } from '@chat-adapter/gchat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const endpointUrl = 'https://assistant.example.com/webhook/gchat';
const botUserId = 'users/123456789';

interface VerifyIdTokenOptions {
  audience: string | string[];
  idToken: string;
}

interface VerifiedTicket {
  getPayload(): {
    aud: string;
    email: string;
    email_verified: boolean;
    iss: string;
  };
}

interface IdentityVerifier {
  verifyIdToken(options: VerifyIdTokenOptions): Promise<VerifiedTicket>;
}

interface ObservableGoogleChatAdapter {
  handleMessageEvent(event: unknown, options: unknown): void;
  oauth2Client: IdentityVerifier;
  chat: { processMessage: (adapter: unknown, threadId: string, message: unknown, options: unknown) => void };
}

function webhookRequest(token?: string, url = endpointUrl, text = 'hello'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chat: {
        messagePayload: {
          message: {
            name: 'spaces/space/messages/message',
            sender: { displayName: 'Principal', name: 'users/principal', type: 'HUMAN' },
            text,
          },
          space: { name: 'spaces/space', type: 'DM' },
        },
      },
    }),
  });
}

const endpointB = 'https://assistant-b.example.com/webhook/gchat';
const addOnIdentityA = 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
const addOnIdentityB = 'service-999999999999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';

interface VerifiedClaims {
  readonly aud: string;
  readonly email: string;
}

interface PinnedAdapterConfig {
  readonly audience: string;
  readonly addOnIdentity: string;
  readonly clientEmail: string;
  readonly projectId: string;
  readonly botUserId: string;
}

function pinnedAdapter(config: PinnedAdapterConfig, claimsByToken: ReadonlyMap<string, VerifiedClaims>) {
  const adapter = createGoogleChatAdapter({
    credentials: {
      client_email: config.clientEmail,
      private_key: 'not-used-by-this-test',
      project_id: config.projectId,
    },
    endpointUrl: config.audience,
    botUserId: config.botUserId,
    workspaceAddOnServiceAccountEmail: config.addOnIdentity,
  });
  const observable = adapter as unknown as ObservableGoogleChatAdapter;
  const processMessage = vi.fn<ObservableGoogleChatAdapter['chat']['processMessage']>();
  observable.chat = { processMessage };
  const handleMessageEvent = vi.spyOn(observable, 'handleMessageEvent');
  const verifyIdToken = vi
    .spyOn(observable.oauth2Client, 'verifyIdToken')
    .mockImplementation(async ({ audience: expected, idToken }) => {
      const claims = claimsByToken.get(idToken);
      if (!claims || claims.aud !== expected) throw new Error('Wrong recipient, payload audience does not match');
      return {
        getPayload: () => ({
          ...claims,
          email_verified: true,
          iss: 'https://accounts.google.com',
        }),
      };
    });
  return { adapter, handleMessageEvent, processMessage, verifyIdToken };
}

describe('two pinned Google Chat audiences', () => {
  const configA: PinnedAdapterConfig = {
    audience: endpointUrl,
    addOnIdentity: addOnIdentityA,
    clientEmail: 'chat-bot@project-a.example.test',
    projectId: 'project-a',
    botUserId: 'users/111111111',
  };
  const configB: PinnedAdapterConfig = {
    audience: endpointB,
    addOnIdentity: addOnIdentityB,
    clientEmail: 'chat-bot@project-b.example.test',
    projectId: 'project-b',
    botUserId: 'users/222222222',
  };
  const claims = new Map<string, VerifiedClaims>([
    ['a-event', { aud: endpointUrl, email: addOnIdentityA }],
    ['b-event', { aud: endpointB, email: addOnIdentityB }],
    ['a-identity-b-audience', { aud: endpointB, email: addOnIdentityA }],
  ]);

  it('dispatches each verifier-accepted event only through its own adapter', async () => {
    const a = pinnedAdapter(configA, claims);
    const b = pinnedAdapter(configB, claims);

    const aResponse = await a.adapter.handleWebhook(webhookRequest('a-event', endpointUrl, 'A marker'));
    const bResponse = await b.adapter.handleWebhook(webhookRequest('b-event', endpointB, 'B marker'));

    expect([aResponse.status, bResponse.status]).toEqual([200, 200]);
    expect(a.verifyIdToken).toHaveBeenCalledWith({ idToken: 'a-event', audience: endpointUrl });
    expect(b.verifyIdToken).toHaveBeenCalledWith({ idToken: 'b-event', audience: endpointB });
    expect(a.handleMessageEvent).toHaveBeenCalledOnce();
    expect(b.handleMessageEvent).toHaveBeenCalledOnce();
    expect(a.processMessage).toHaveBeenCalledOnce();
    expect(b.processMessage).toHaveBeenCalledOnce();
    expect(a.processMessage.mock.calls[0]?.[2]).toMatchObject({ text: 'A marker' });
    expect(b.processMessage.mock.calls[0]?.[2]).toMatchObject({ text: 'B marker' });
  });

  it('rejects an A-audience event at B before handler or bridge dispatch', async () => {
    const a = pinnedAdapter(configA, claims);
    const b = pinnedAdapter(configB, claims);

    expect((await a.adapter.handleWebhook(webhookRequest('a-event', endpointUrl))).status).toBe(200);
    const response = await b.adapter.handleWebhook(webhookRequest('a-event', endpointB));

    expect(response.status).toBe(401);
    expect(b.verifyIdToken).toHaveBeenCalledWith({ idToken: 'a-event', audience: endpointB });
    expect(a.processMessage).toHaveBeenCalledOnce();
    expect(b.handleMessageEvent).not.toHaveBeenCalled();
    expect(b.processMessage).not.toHaveBeenCalled();
  });

  it('rejects A’s dedicated project identity even when the token names B’s audience', async () => {
    const b = pinnedAdapter(configB, claims);

    const response = await b.adapter.handleWebhook(webhookRequest('a-identity-b-audience', endpointB));

    expect(response.status).toBe(401);
    expect(b.verifyIdToken).toHaveBeenCalledWith({ idToken: 'a-identity-b-audience', audience: endpointB });
    expect(b.handleMessageEvent).not.toHaveBeenCalled();
    expect(b.processMessage).not.toHaveBeenCalled();
  });
});

function verifiedEmail(token: string): string {
  switch (token) {
    case 'exact-audience-untrusted-email':
      return 'attacker@example.test';
    case 'exact-audience-addon':
      return 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
    case 'exact-audience-foreign-addon':
      return 'service-999999999999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
    default:
      return 'chat@system.gserviceaccount.com';
  }
}

describe('Google Chat request authentication', () => {
  let adapter: GoogleChatAdapter;
  let observable: ObservableGoogleChatAdapter;
  let verifyIdToken: ReturnType<typeof vi.spyOn>;
  let handleMessageEvent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = createGoogleChatAdapter({
      credentials: { client_email: 'bot@example.test', private_key: 'not-used-by-this-test' },
      endpointUrl,
      botUserId,
      workspaceAddOnServiceAccountEmail: 'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
    });
    observable = adapter as unknown as ObservableGoogleChatAdapter;
    verifyIdToken = vi
      .spyOn(observable.oauth2Client, 'verifyIdToken')
      .mockImplementation(async ({ audience, idToken }) => {
        const tokenAudience = idToken.startsWith('exact-audience')
          ? endpointUrl
          : 'https://attacker.example/webhook/gchat';
        if (tokenAudience !== audience) throw new Error('Wrong recipient, payload audience does not match');
        return {
          getPayload: () => ({
            aud: tokenAudience,
            email: verifiedEmail(idToken),
            email_verified: idToken !== 'exact-audience-unverified-email',
            iss: 'https://accounts.google.com',
          }),
        };
      });
    handleMessageEvent = vi.spyOn(observable, 'handleMessageEvent');
  });

  it('rejects an unsigned request before dispatch', async () => {
    const response = await adapter.handleWebhook(webhookRequest());

    expect(response.status).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(handleMessageEvent).not.toHaveBeenCalled();
  });

  it('rejects a token whose audience differs from the configured endpoint', async () => {
    const response = await adapter.handleWebhook(webhookRequest('wrong-audience'));

    expect(response.status).toBe(401);
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'wrong-audience', audience: endpointUrl });
    expect(handleMessageEvent).not.toHaveBeenCalled();
  });

  it('accepts an exact-audience token and reaches the message handler', async () => {
    const response = await adapter.handleWebhook(webhookRequest('exact-audience'));

    expect(response.status).toBe(200);
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: 'exact-audience', audience: endpointUrl });
    expect(handleMessageEvent).toHaveBeenCalledOnce();
  });

  it('accepts the dedicated project’s Workspace Add-on identity', async () => {
    const response = await adapter.handleWebhook(webhookRequest('exact-audience-addon'));

    expect(response.status).toBe(200);
    expect(handleMessageEvent).toHaveBeenCalledOnce();
  });

  it.each(['exact-audience-untrusted-email', 'exact-audience-unverified-email', 'exact-audience-foreign-addon'])(
    'rejects exact-audience token with untrusted identity claims: %s',
    async (token) => {
      const response = await adapter.handleWebhook(webhookRequest(token));

      expect(response.status).toBe(401);
      expect(verifyIdToken).toHaveBeenCalledWith({ idToken: token, audience: endpointUrl });
      expect(handleMessageEvent).not.toHaveBeenCalled();
    },
  );

  it('normalizes an exact app mention in a real group message', () => {
    const raw = {
      chat: {
        messagePayload: {
          message: {
            annotations: [
              {
                length: 13,
                startIndex: 0,
                type: 'USER_MENTION',
                userMention: {
                  type: 'MENTION',
                  user: { displayName: 'NanoClaw Bot', name: botUserId, type: 'BOT' },
                },
              },
            ],
            createTime: '2026-09-17T12:00:00.000Z',
            name: 'spaces/space/messages/message',
            sender: { displayName: 'Principal', name: 'users/principal', type: 'HUMAN' },
            text: '@NanoClaw Bot help',
            thread: { name: 'spaces/space/threads/thread' },
          },
          space: { name: 'spaces/space', type: 'ROOM' },
        },
      },
    };

    const message = adapter.parseMessage(raw);

    expect(message.text).toBe('@bot help');
  });
});
