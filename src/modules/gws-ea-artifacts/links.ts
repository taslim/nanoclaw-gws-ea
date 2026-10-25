import { getDb } from '../../db/connection.js';
import type { OutboundGuardDecision, OutboundSend } from '../../delivery.js';
import { normalizePrincipalEmail } from '../../gws-ea/validation.js';
import type { ChatMember } from '../gws-ea-chats/roster.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import { resolveAudience } from '../gws-ea-privacy/audience.js';
import { linkTargets, messageStrings } from '../gws-ea-privacy/outbound.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { readArtifactsPolicy, type ArtifactsPolicyFile } from './policy.js';

interface ArtifactLinkCheckRequest {
  readonly texts: readonly string[];
  readonly recipients: readonly string[];
  readonly unknownRecipients?: boolean;
  readonly nonPrincipalChatMembers?: boolean;
}
type ArtifactLinkCheck = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
const URLS = /https?:\/\/[^\s<>"'`\\]+/giu;
const TRAILING = /[.,;:!?)\]}*'"]+$/u;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function artifactUrls(texts: readonly string[], config: ArtifactsPolicyFile): readonly string[] {
  return [
    ...new Set(
      texts.flatMap((text) => [
        ...(text.match(URLS) ?? []).map((url) => url.replace(TRAILING, '')),
        ...linkTargets(text),
      ]),
    ),
  ].filter((written) => {
    const url = URL.parse(written);
    return (
      url !== null &&
      url.hostname.replace(/\.$/u, '') === config.hostname &&
      (url.pathname === config.pathPrefix || url.pathname.startsWith(`${config.pathPrefix}/`))
    );
  });
}
export async function hasArtifactLinks(texts: readonly string[]): Promise<boolean> {
  const policy = await readArtifactsPolicy();
  return 'config' in policy && policy.config !== undefined && artifactUrls(texts, policy.config).length > 0;
}

/** Counts the principal and emails main supplied; any other member leaves the audience unknown. */
export async function artifactAudienceForMembers(
  members: readonly Pick<ChatMember, 'is_principal' | 'email' | 'email_source'>[],
): Promise<{
  readonly recipients: readonly string[];
  readonly unknownRecipients: boolean;
  readonly nonPrincipalChatMembers: boolean;
}> {
  const principals = (await listPrincipalAddresses()).map(({ email }) => email);
  const recipients: string[] = [];
  let unknownRecipients = members.length === 0;
  for (const member of members) {
    if (member.is_principal === 1) {
      recipients.push(...principals);
      unknownRecipients ||= principals.length === 0;
    } else if (member.email && member.email_source === 'main') recipients.push(member.email);
    else unknownRecipients = true;
  }
  return {
    recipients: [...new Set(recipients)],
    unknownRecipients,
    nonPrincipalChatMembers: members.some((member) => member.is_principal !== 1),
  };
}
/** Checks only URLs on the configured artifact host, locally: no network, Access token or source read. */
export async function checkArtifactLinksOpenable(request: ArtifactLinkCheckRequest): Promise<ArtifactLinkCheck> {
  const policy = await readArtifactsPolicy();
  if (!('config' in policy) || !policy.config) return { allowed: true };
  const { config } = policy;
  const urls = artifactUrls(request.texts, config);
  if (urls.length === 0) return { allowed: true };
  const principals = new Set(
    (await getDb().hasTable('gws_ea_principal_addresses'))
      ? (await listPrincipalAddresses()).map(({ email }) => email)
      : [],
  );
  const recipients = request.recipients.map((address) => normalizePrincipalEmail(address));
  const refuse = (url: string): ArtifactLinkCheck => ({
    allowed: false,
    reason: `The current artifact access does not let every recipient open ${url}. Use its applied private, named or public link for these exact recipients, or send without it.`,
  });
  for (const written of urls) {
    const url = URL.parse(written);
    if (!url || url.hostname.replace(/\.$/u, '') !== config.hostname) continue;
    if (url.pathname !== config.pathPrefix && !url.pathname.startsWith(`${config.pathPrefix}/`)) continue;
    if (policy.status !== 'enabled' || !(await getDb().hasTable('gws_ea_artifacts'))) return refuse(written);
    if (url.origin !== `https://${config.hostname}` || url.username || url.password || url.search || url.hash)
      return refuse(written);
    const suffix = url.pathname.slice(config.pathPrefix.length);
    const match = new RegExp(`^/(?:((?:share|public))/)?(${UUID})$`, 'u').exec(suffix);
    if (!match || written !== `https://${config.hostname}${url.pathname}`) return refuse(written);
    const now = new Date().toISOString();
    if (!match[1]) {
      const live = await getDb().get<{ artifact_id: string }>(
        `SELECT a.artifact_id FROM gws_ea_artifacts a JOIN gws_ea_artifact_revisions r ON r.artifact_id=a.artifact_id AND r.revision=a.head_revision WHERE a.artifact_id=? AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)`,
        match[2],
        now,
      );
      if (
        !live ||
        request.nonPrincipalChatMembers === true ||
        request.unknownRecipients === true ||
        recipients.length === 0 ||
        recipients.some((email) => email === undefined || !principals.has(email))
      )
        return refuse(written);
    } else {
      const share = await getDb().get<{ share_id: string }>(
        `SELECT s.share_id FROM gws_ea_artifact_shares s JOIN gws_ea_artifacts a ON a.artifact_id=s.artifact_id JOIN gws_ea_artifact_revisions r ON r.artifact_id=s.artifact_id AND r.revision=s.revision AND r.source_hash=s.source_hash WHERE s.share_id=? AND s.kind=? AND s.state='active' AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) AND (s.expires_at IS NULL OR s.expires_at>?)`,
        match[2],
        match[1] === 'share' ? 'named' : 'public',
        now,
        now,
      );
      if (!share) return refuse(written);
      if (match[1] === 'share') {
        const granted = new Set(
          (
            await getDb().all<{ email: string }>(
              'SELECT email FROM gws_ea_artifact_share_recipients WHERE share_id=?',
              share.share_id,
            )
          ).map(({ email }) => email),
        );
        if (
          request.unknownRecipients === true ||
          recipients.length === 0 ||
          recipients.some((email) => email === undefined || (!principals.has(email) && !granted.has(email)))
        )
          return refuse(written);
      }
    }
  }
  return { allowed: true };
}

/** Last local check at the adapter boundary, after handoff and any later revoke or membership change. */
export async function judgeArtifactSend(send: OutboundSend): Promise<OutboundGuardDecision> {
  // The inbox builds its final outside recipients and checks them in sendToOutside.
  if (send.channelType === EMAIL_CHANNEL_TYPE && send.platformId === INBOX_PLATFORM_ID) return { effect: 'allow' };
  const policy = await readArtifactsPolicy();
  if (!('config' in policy) || !policy.config) return { effect: 'allow' };
  const texts = messageStrings(send.content);
  for (const file of send.files ?? []) {
    texts.push(file.filename);
    texts.push(file.data.toString('utf8'));
  }
  if (artifactUrls(texts, policy.config).length === 0) return { effect: 'allow' };
  let audience: {
    readonly recipients: readonly string[];
    readonly unknownRecipients: boolean;
    readonly nonPrincipalChatMembers: boolean;
  };
  if ((await resolveAudience(send)) === 'principal') {
    const recipients = (await listPrincipalAddresses()).map(({ email }) => email);
    audience = { recipients, unknownRecipients: recipients.length === 0, nonPrincipalChatMembers: false };
  } else {
    const target = await getDb().get<{ id: string }>(
      'SELECT id FROM messaging_groups WHERE channel_type=? AND platform_id=? AND instance=?',
      send.channelType,
      send.platformId,
      send.instance ?? send.channelType,
    );
    const members =
      target && (await getDb().hasTable('gws_ea_chat_members'))
        ? await getDb().all<Pick<ChatMember, 'is_principal' | 'email' | 'email_source'>>(
            "SELECT m.is_principal,m.email,m.email_source FROM gws_ea_chat_members m JOIN gws_ea_chats c ON c.messaging_group_id=m.messaging_group_id WHERE m.messaging_group_id=? AND c.state IN ('connected','moving','job')",
            target.id,
          )
        : [];
    audience = await artifactAudienceForMembers(members);
  }
  const checked = await checkArtifactLinksOpenable({ texts, ...audience });
  return checked.allowed ? { effect: 'allow' } : { effect: 'refuse', reason: checked.reason };
}
