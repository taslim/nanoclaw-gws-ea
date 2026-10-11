/**
 * The Google Chat API's configuration has no API: the operator gives it the
 * assistant's name, an avatar, and a description, with interactive features
 * off, in the Cloud console, then confirms with `--chat-configured`, which the
 * provision journal records as a decision. The assistant talks in Chat as its
 * own account, so the configuration names no endpoint and no add-on.
 */
export function googleChatConfigurationUrl(projectId: string): string {
  const url = new URL('https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat');
  url.searchParams.set('project', projectId);
  return url.href;
}
