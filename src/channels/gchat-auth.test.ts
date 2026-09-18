import { createGoogleChatAdapter, type GoogleChatAdapter } from '@chat-adapter/gchat';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const endpointUrl = 'https://assistant.example.com/webhook/gchat';

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

describe('Google Chat request authentication', () => {
  let adapter: GoogleChatAdapter;
  let observable: ObservableGoogleChatAdapter;
  let verifyIdToken: ReturnType<typeof vi.spyOn>;
  let handleMessageEvent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = createGoogleChatAdapter({
      credentials: { client_email: 'bot@example.test', private_key: 'not-used-by-this-test' },
      endpointUrl,
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
            email:
              idToken === 'exact-audience-untrusted-email'
                ? 'attacker@example.test'
                : 'chat@system.gserviceaccount.com',
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

  it.each(['exact-audience-untrusted-email', 'exact-audience-unverified-email'])(
    'rejects exact-audience token with untrusted identity claims: %s',
    async (token) => {
      const response = await adapter.handleWebhook(webhookRequest(token));

      expect(response.status).toBe(401);
      expect(verifyIdToken).toHaveBeenCalledWith({ idToken: token, audience: endpointUrl });
      expect(handleMessageEvent).not.toHaveBeenCalled();
    },
  );
});
