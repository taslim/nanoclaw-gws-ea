/**
 * Google Chat Channel for NanoClaw GWS-EA
 * Implements the Channel interface — messages flow through the standard
 * message loop, just like WhatsApp and Telegram.
 *
 * Polls Google Chat API for new messages and delivers them via callbacks.
 * Agent output is routed back through sendMessage() -> Chat API.
 *
 * Self-registers via registerChannel() — imported by the barrel file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, chat_v1 } from 'googleapis';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  GCHAT_POLL_INTERVAL,
  PRINCIPAL_NAME,
  isPrincipalEmail,
} from '../config.js';
import { getLatestMessage, storeReaction } from '../db.js';
import { logger } from '../logger.js';
import { Attachment, Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const assistantNameLower = ASSISTANT_NAME.toLowerCase();

export class GChatChannel implements Channel {
  name = 'gchat';

  private chat: chat_v1.Chat | null = null;
  private oauth2Client: InstanceType<typeof google.auth.OAuth2> | null = null;
  private opts: ChannelOpts;
  private selfUserId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime: string | null = null;
  // Cache: spaceName -> { userId -> email }
  private memberEmailCache = new Map<string, Map<string, string>>();
  // Track latest inbound thread per space so replies go to the right thread.
  private activeThreads = new Map<string, string>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const homeDir = os.homedir();
    const keysPath = path.join(
      homeDir,
      '.workspace-mcp',
      'gcp-oauth.keys.json',
    );
    const credsPath = path.join(homeDir, '.workspace-mcp', 'credentials.json');

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const credsFile = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    // google-calendar-mcp auto-migrates flat tokens to {normal: {...}} format
    const creds = credsFile.normal || credsFile;

    const clientConfig = keys.installed || keys.web;
    this.oauth2Client = new google.auth.OAuth2(
      clientConfig.client_id,
      clientConfig.client_secret,
      clientConfig.redirect_uris?.[0],
    );

    this.oauth2Client.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
    });

    // Persist refreshed tokens back to disk
    this.oauth2Client.on('tokens', (tokens) => {
      const existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      const target = existing.normal || existing;
      if (tokens.access_token) target.access_token = tokens.access_token;
      if (tokens.refresh_token) target.refresh_token = tokens.refresh_token;
      if (tokens.expiry_date) target.expiry_date = tokens.expiry_date;
      fs.writeFileSync(credsPath, JSON.stringify(existing, null, 2));
      logger.debug('Workspace OAuth tokens refreshed and saved');
    });

    this.chat = google.chat({ version: 'v1', auth: this.oauth2Client });

    // Resolve self user ID via token introspection.
    // Force a token refresh first — getTokenInfo validates the raw string
    // and fails on expired tokens without triggering the refresh flow.
    try {
      const { token } = await this.oauth2Client.getAccessToken();
      if (token) {
        const tokenInfo = await this.oauth2Client.getTokenInfo(token);
        if (tokenInfo.sub) {
          this.selfUserId = `users/${tokenInfo.sub}`;
          logger.info(
            { userId: this.selfUserId, email: tokenInfo.email },
            'Google Chat: identified self',
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to get self user ID',
      );
    }

    logger.info(
      `Google Chat channel connected (polling every ${GCHAT_POLL_INTERVAL / 1000}s)`,
    );

    // Initial poll
    await this.poll();

    // Recurring poll
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => logger.error({ err }, 'Chat poll error'));
    }, GCHAT_POLL_INTERVAL);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.chat) {
      logger.warn('Google Chat not connected, cannot send message');
      return;
    }

    const spaceId = jid.replace(/^gchat:/, '');
    const threadName = this.activeThreads.get(jid);

    try {
      await this.chat.spaces.messages.create({
        parent: `spaces/${spaceId}`,
        ...(threadName
          ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' }
          : {}),
        requestBody: {
          text,
          ...(threadName ? { thread: { name: threadName } } : {}),
        },
      });
      // Clear after sending so scheduled tasks / proactive sweeps post at top level
      if (threadName) this.activeThreads.delete(jid);
      logger.info(
        { jid, length: text.length, thread: threadName || 'top-level' },
        'Google Chat message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Google Chat message');
    }
  }

  /**
   * Create a DM space with a user via spaces.setup() and optionally send
   * the first message. Returns the space ID. If a DM already exists,
   * returns the existing one.
   * Same-org only — spaces.setup() cannot add external users.
   */
  async createDM(email: string, firstMessage?: string): Promise<string> {
    if (!this.chat) {
      throw new Error('Google Chat not connected');
    }

    const response = await this.chat.spaces.setup({
      requestBody: {
        space: {
          spaceType: 'DIRECT_MESSAGE',
          singleUserBotDm: false,
        },
        memberships: [
          {
            member: {
              name: `users/${email}`,
              type: 'HUMAN',
            },
          },
        ],
      },
    });

    const spaceName = response.data.name;
    if (!spaceName) {
      throw new Error('spaces.setup() returned no space name');
    }

    const spaceId = spaceName.replace('spaces/', '');
    logger.info({ email, spaceId }, 'Created/found DM space');

    // Send the first message immediately using the same auth context
    if (firstMessage) {
      await this.chat.spaces.messages.create({
        parent: `spaces/${spaceId}`,
        requestBody: { text: firstMessage },
      });
      logger.info({ spaceId }, 'First message sent in DM space');
    }

    return spaceId;
  }

  isConnected(): boolean {
    return this.chat !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gchat:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.chat = null;
    logger.info('Google Chat channel stopped');
  }

  async getAuthHeaders(): Promise<Record<string, string>> {
    if (!this.oauth2Client) return {};
    const { token } = await this.oauth2Client.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Google Chat API doesn't support typing indicators for user auth
  }

  /**
   * Send a reaction to a specific message
   */
  async sendReaction(
    chatJid: string,
    messageKey: {
      id: string;
      remoteJid: string;
      fromMe?: boolean;
      participant?: string;
    },
    emoji: string,
    options?: { skipStore?: boolean },
  ): Promise<void> {
    if (!this.chat) {
      logger.warn({ chatJid, emoji }, 'Cannot send reaction - not connected');
      return;
    }

    // Empty emoji = remove reaction (matches WhatsApp behavior).
    // GChat uses reactions.delete instead of create-with-empty.
    if (!emoji) {
      if (!this.selfUserId) {
        logger.warn({ chatJid }, 'Cannot remove reaction — selfUserId unknown');
        return;
      }

      try {
        const res = await this.chat.spaces.messages.reactions.list({
          parent: messageKey.id,
          filter: `user.name = "${this.selfUserId}"`,
        });

        const myReactions = (res.data.reactions || []).filter(
          (r) => r.emoji?.unicode === '👀',
        );
        for (const r of myReactions) {
          if (r.name) {
            await this.chat.spaces.messages.reactions.delete({ name: r.name });
          }
        }

        if (!options?.skipStore) {
          storeReaction({
            message_id: messageKey.id,
            message_chat_jid: chatJid,
            reactor_jid: this.selfUserId,
            emoji: '',
            timestamp: new Date().toISOString(),
          });
        }

        logger.info(
          { chatJid, messageId: messageKey.id, removed: myReactions.length },
          'Reaction removed',
        );
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to remove reaction');
        throw err;
      }
      return;
    }

    try {
      // messageKey.id is the full resource name (spaces/XXX/messages/YYY)
      await this.chat.spaces.messages.reactions.create({
        parent: messageKey.id,
        requestBody: { emoji: { unicode: emoji } },
      });

      if (!options?.skipStore) {
        storeReaction({
          message_id: messageKey.id,
          message_chat_jid: chatJid,
          reactor_jid: this.selfUserId || 'self',
          emoji,
          timestamp: new Date().toISOString(),
        });
      }

      logger.info(
        { chatJid, messageId: messageKey.id, emoji },
        'Reaction sent',
      );
    } catch (err) {
      logger.error({ chatJid, emoji, err }, 'Failed to send reaction');
      throw err;
    }
  }

  /**
   * React to the most recent message in a chat
   */
  async reactToLatestMessage(chatJid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(chatJid);
    if (!latest) {
      throw new Error(`No messages found for chat ${chatJid}`);
    }

    const messageKey = {
      id: latest.id,
      remoteJid: chatJid,
      fromMe: latest.fromMe,
    };

    await this.sendReaction(chatJid, messageKey, emoji);
  }

  /**
   * Poll for new messages across all spaces.
   */
  private async poll(): Promise<void> {
    if (!this.chat) return;

    try {
      const spacesResponse = await this.chat.spaces.list({
        pageSize: 100,
        filter: 'spaceType = "DIRECT_MESSAGE" OR spaceType = "SPACE"',
      });

      const spaces = spacesResponse.data.spaces || [];
      if (spaces.length === 0) return;

      const filterTime =
        this.lastPollTime ||
        new Date(Date.now() - GCHAT_POLL_INTERVAL * 2).toISOString();

      for (const space of spaces) {
        if (!space.name) continue;

        const spaceId = space.name.replace('spaces/', '');
        const chatJid = `gchat:${spaceId}`;
        const spaceName = space.displayName || 'Direct Message';

        try {
          const messagesResponse = await this.chat.spaces.messages.list({
            parent: space.name,
            pageSize: 25,
            orderBy: 'createTime desc',
            filter: `createTime > "${filterTime}"`,
          });

          const messages = messagesResponse.data.messages || [];
          if (messages.length === 0) continue;

          // Resolve member emails for this space (cached)
          const memberEmails = await this.resolveSpaceMemberEmails(space.name);

          for (const msg of messages) {
            if (!msg.name) continue;
            const msgAttachments = (
              msg as chat_v1.Schema$Message & {
                attachment?: Array<
                  chat_v1.Schema$Attachment & {
                    attachmentDataRef?: { resourceName?: string };
                  }
                >;
              }
            ).attachment;
            if (!msg.text && !msgAttachments?.length) continue;

            const senderUserId = msg.sender?.name || '';
            const senderDisplayName = msg.sender?.displayName || 'Unknown';

            // Skip messages from self
            if (this.selfUserId && senderUserId === this.selfUserId) continue;

            const timestamp = msg.createTime || new Date().toISOString();
            const msgId = msg.name; // spaces/XXX/messages/YYY

            // Resolve sender email and identity
            const senderEmail = memberEmails.get(senderUserId) || '';
            const isPrincipal = !!senderEmail && isPrincipalEmail(senderEmail);

            // Build sender name with identity context
            const senderLabel = isPrincipal
              ? `${senderDisplayName} [${PRINCIPAL_NAME}]`
              : senderDisplayName;

            // Notify about chat metadata for discovery
            const isGroupSpace = space.spaceType === 'SPACE';
            this.opts.onChatMetadata(
              chatJid,
              timestamp,
              spaceName,
              'gchat',
              isGroupSpace,
            );

            // GChat msg keys are compound: "THREAD_KEY.MSG_KEY". For a top-level
            // message both halves are identical (e.g. "abc.abc", thread "abc").
            // A true thread reply has a different second half (e.g. "abc.xyz").
            const threadKey = msg.thread?.name?.split('/').pop() || '';
            const isThreadReply = !!(
              threadKey &&
              msg.name?.includes(`${threadKey}.`) &&
              !msg.name?.endsWith(`${threadKey}.${threadKey}`)
            );

            // Check for quote reply context
            let quotePrefix = '';
            const quotedMeta = (
              msg as chat_v1.Schema$Message & {
                quotedMessageMetadata?: {
                  quotedMessageSnapshot?: { sender?: string; text?: string };
                };
              }
            ).quotedMessageMetadata?.quotedMessageSnapshot;
            if (quotedMeta?.text) {
              const sender = quotedMeta.sender || 'someone';
              quotePrefix = `[Reply to ${sender}: "${quotedMeta.text}"] `;
            }

            // Implicit trigger: quote-replying to the EA or @mentioning it
            // bypasses requiresTrigger so users don't need the trigger word.
            // Skip if the message already contains the explicit trigger.
            let implicitTrigger = false;
            const msgText = msg.text || '';
            if (!msgText.toLowerCase().includes(assistantNameLower)) {
              if (quotedMeta?.sender) {
                const senderFirst = quotedMeta.sender.trim().split(/\s/)[0];
                implicitTrigger =
                  senderFirst.toLowerCase() === assistantNameLower ||
                  quotedMeta.sender.trim().toLowerCase() === assistantNameLower;
              }
              if (
                !implicitTrigger &&
                this.selfUserId &&
                msg.annotations?.some(
                  (a) => a.userMention?.user?.name === this.selfUserId,
                )
              ) {
                implicitTrigger = true;
              }
            }

            // --- Extract attachments ---
            const attachments: Attachment[] = [];

            // From Google Chat API attachment objects
            for (const att of (msgAttachments || []).slice(0, 5)) {
              const resourceName = att.attachmentDataRef?.resourceName;
              if (resourceName) {
                attachments.push({
                  url: `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`,
                  filename: att.contentName || 'attachment',
                  mimeType: att.contentType || 'application/octet-stream',
                });
              }
            }

            // From image URLs embedded in text (Google CDN)
            const text = msg.text || '';
            if (text.includes('googleusercontent.com')) {
              const imageUrlPattern =
                /https:\/\/lh[0-9]*\.googleusercontent\.com\/[^\s)]+/g;
              for (const match of text.matchAll(imageUrlPattern)) {
                attachments.push({
                  url: match[0],
                  filename: 'image.jpg',
                  mimeType: 'image/jpeg',
                  extractedFromText: match[0],
                });
              }
            }

            const content = [
              isThreadReply ? `[thread:${threadKey}]` : '',
              implicitTrigger ? DEFAULT_TRIGGER : '',
              quotePrefix,
              msg.text || '',
            ]
              .filter(Boolean)
              .join(' ');

            // Only track thread for replies within an existing thread,
            // not for standalone messages (which also have thread.name in GChat)
            if (isThreadReply && msg.thread?.name) {
              this.activeThreads.set(chatJid, msg.thread.name);
            }

            // Deliver message — onMessage handles auto-registration for unregistered GChat DMs
            this.opts.onMessage(chatJid, {
              id: msgId,
              chat_jid: chatJid,
              sender: senderEmail || senderUserId,
              sender_name: senderLabel,
              content,
              timestamp,
              is_from_me: false,
              ...(attachments.length > 0 && { attachments }),
            });

            logger.info(
              {
                chatJid,
                spaceName,
                sender: senderDisplayName,
                isPrincipal,
                senderEmail,
              },
              'Google Chat message stored',
            );
          }
        } catch (err) {
          logger.warn(
            { space: space.name, err },
            'Failed to list messages for space',
          );
        }
      }

      this.lastPollTime = new Date().toISOString();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMsg }, 'Failed to list Chat spaces');
    }
  }

  /**
   * Resolve space member emails via People API directory lookup.
   * Requires directory.readonly scope. Cached per space.
   */
  private async resolveSpaceMemberEmails(
    spaceName: string,
  ): Promise<Map<string, string>> {
    const cached = this.memberEmailCache.get(spaceName);
    if (cached) return cached;

    const emailMap = new Map<string, string>();

    try {
      const membersResponse = await this.chat!.spaces.members.list({
        parent: spaceName,
        pageSize: 100,
      });

      const members = membersResponse.data.memberships || [];
      const people = google.people({ version: 'v1', auth: this.oauth2Client! });

      for (const membership of members) {
        const userId = membership.member?.name;
        if (!userId || membership.member?.type !== 'HUMAN') continue;

        const numericId = userId.replace('users/', '');
        try {
          const person = await people.people.get({
            resourceName: `people/${numericId}`,
            personFields: 'emailAddresses',
            sources: [
              'READ_SOURCE_TYPE_PROFILE',
              'READ_SOURCE_TYPE_DOMAIN_CONTACT',
              'READ_SOURCE_TYPE_CONTACT',
            ],
          });
          const email = person.data.emailAddresses?.find(
            (e) => e.metadata?.primary || e.metadata?.sourcePrimary,
          )?.value;
          if (email) {
            emailMap.set(userId, email);
            logger.debug({ userId, email }, 'Resolved Chat member email');
          }
        } catch (err) {
          logger.debug(
            { userId, err: err instanceof Error ? err.message : String(err) },
            'People API directory lookup failed',
          );
        }
      }
    } catch (err) {
      logger.debug(
        {
          space: spaceName,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to list space members',
      );
    }

    this.memberEmailCache.set(spaceName, emailMap);
    return emailMap;
  }
}

// Self-register: factory checks for credentials, returns channel or null
registerChannel('gchat', (opts) => {
  const homeDir = os.homedir();
  const keysPath = path.join(homeDir, '.workspace-mcp', 'gcp-oauth.keys.json');
  const credsPath = path.join(homeDir, '.workspace-mcp', 'credentials.json');

  if (!fs.existsSync(keysPath) || !fs.existsSync(credsPath)) {
    logger.info('Google Chat channel: credentials not found, skipping');
    return null;
  }

  return new GChatChannel(opts);
});
