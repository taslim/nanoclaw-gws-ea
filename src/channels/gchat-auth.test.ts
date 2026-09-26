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
}

function webhookRequest(token?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request(endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chat: {
        messagePayload: {
          message: {
            name: 'spaces/space/messages/message',
            sender: { displayName: 'Principal', name: 'users/principal', type: 'HUMAN' },
            text: 'hello',
          },
          space: { name: 'spaces/space', type: 'DM' },
        },
      },
    }),
  });
}

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
