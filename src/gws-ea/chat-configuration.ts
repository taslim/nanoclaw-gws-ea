/**
 * Google Chat app configuration has no API: the operator finishes it in the
 * Cloud console, then confirms with `--chat-configured`, which the provision
 * journal records as a decision.
 */
export function googleChatConfigurationUrl(projectId: string): string {
  const url = new URL('https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat');
  url.searchParams.set('project', projectId);
  return url.href;
}
