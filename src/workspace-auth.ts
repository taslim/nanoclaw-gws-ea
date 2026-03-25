/**
 * Google Workspace OAuth Setup Script
 *
 * One-time setup to authorize the EA's Google Workspace account.
 * Generates tokens for both:
 *   - Host-side googleapis (Google Chat polling)
 *   - Container-side google_workspace_mcp (Workspace tools)
 *
 * Prerequisites:
 *   1. Create OAuth Desktop App in GCP Console
 *   2. Enable APIs: Chat, Drive, Docs, Sheets, Tasks, People, Gmail
 *   3. Save client credentials to ~/.workspace-mcp/gcp-oauth.keys.json
 *      Format: { "installed": { "client_id": "...", "client_secret": "...", "redirect_uris": ["http://localhost"] } }
 *
 * Usage: npm run auth:workspace
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { URL } from 'url';

import { google } from 'googleapis';

const WORKSPACE_DIR = path.join(os.homedir(), '.workspace-mcp');
const KEYS_PATH = path.join(WORKSPACE_DIR, 'gcp-oauth.keys.json');
const HOST_CREDS_PATH = path.join(WORKSPACE_DIR, 'credentials.json');
const MCP_CREDS_DIR = path.join(WORKSPACE_DIR, 'credentials');

// Scopes needed for all Workspace tools + Chat polling
const SCOPES = [
  // Identity — MCP server requires all three as BASE_SCOPES
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  // Google Chat (host-side polling + container-side MCP)
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.messages.readonly',
  'https://www.googleapis.com/auth/chat.messages.create',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  // Drive
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  // Docs
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/documents.readonly',
  // Sheets
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  // Tasks
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/tasks.readonly',
  // Contacts (People API)
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts',
  // Directory (resolve workspace member emails for principal detection)
  'https://www.googleapis.com/auth/directory.readonly',
  // Gmail (host-side polling + container-side Workspace MCP)
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const REDIRECT_PORT = 3456;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

async function main(): Promise<void> {
  // Ensure directory exists
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(MCP_CREDS_DIR, { recursive: true });

  // Check for client credentials
  if (!fs.existsSync(KEYS_PATH)) {
    console.error(`Missing OAuth client credentials at: ${KEYS_PATH}`);
    console.error('');
    console.error('Setup steps:');
    console.error('  1. Go to GCP Console > APIs & Services > Credentials');
    console.error('  2. Create an OAuth 2.0 Client ID (Desktop Application)');
    console.error('  3. Download the JSON and save it to the path above');
    console.error('  4. Enable these APIs in GCP Console:');
    console.error('     - Google Chat API');
    console.error('     - Google Drive API');
    console.error('     - Google Docs API');
    console.error('     - Google Sheets API');
    console.error('     - Google Tasks API');
    console.error('     - People API (Contacts)');
    console.error('     - Gmail API');
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const clientConfig = keys.installed || keys.web;

  if (!clientConfig?.client_id || !clientConfig?.client_secret) {
    console.error(
      'Invalid OAuth client credentials — missing client_id or client_secret',
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    REDIRECT_URI,
  );

  // Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // Force consent to get refresh_token
  });

  console.log('Opening browser for Google OAuth consent...\n');
  console.log('If the browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log('');

  // Open browser
  const { exec } = await import('child_process');
  exec(`open "${authUrl}"`);

  // Start local server to capture the callback
  const code = await waitForAuthCode();

  console.log('Authorization code received, exchanging for tokens...');

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Save host-side credentials (googleapis format)
  const hostCreds = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
    scope: tokens.scope,
  };
  fs.writeFileSync(HOST_CREDS_PATH, JSON.stringify(hostCreds, null, 2));
  console.log(`Host credentials saved to: ${HOST_CREDS_PATH}`);

  // Save container-side credentials (google_workspace_mcp format)
  // The MCP server expects: { token, refresh_token, token_uri, client_id, client_secret, scopes, expiry }
  const mcpCreds = {
    token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_uri: 'https://oauth2.googleapis.com/token',
    client_id: clientConfig.client_id,
    client_secret: clientConfig.client_secret,
    scopes: SCOPES,
    expiry: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
  };

  // Use the authenticated account's email as filename
  let accountEmail = 'default';
  try {
    const people = google.people({ version: 'v1', auth: oauth2Client });
    const me = await people.people.get({
      resourceName: 'people/me',
      personFields: 'emailAddresses',
    });
    const primaryEmail = me.data.emailAddresses?.find(
      (e) => e.metadata?.primary,
    )?.value;
    if (primaryEmail) accountEmail = primaryEmail;
  } catch {
    // Fall back to 'default' if People API isn't enabled yet
  }

  // Warn if the authenticated account doesn't match ASSISTANT_EMAIL from .env
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^ASSISTANT_EMAIL=["']?([^"'\n]+)["']?/m);
    if (
      match &&
      match[1] &&
      accountEmail !== 'default' &&
      match[1].toLowerCase() !== accountEmail.toLowerCase()
    ) {
      console.warn(
        `\n⚠️  WARNING: Authenticated as ${accountEmail}, but ASSISTANT_EMAIL in .env is ${match[1]}.`,
      );
      console.warn(
        `   Make sure you're signing in with the EA's Google account, not the principal's.`,
      );
      console.warn(
        `   If this was intentional, you can ignore this warning.\n`,
      );
    }
  }

  const mcpCredsPath = path.join(MCP_CREDS_DIR, `${accountEmail}.json`);
  fs.writeFileSync(mcpCredsPath, JSON.stringify(mcpCreds, null, 2));
  console.log(`MCP credentials saved to: ${mcpCredsPath}`);

  console.log('\nSetup complete! Next steps:');
  console.log('  1. Rebuild the container: ./container/build.sh');
  console.log('  2. Configure the Chat App in GCP Console');
  console.log('  3. Start a DM with your EA in Google Chat');

  process.exit(0);
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authorization successful!</h1><p>You can close this tab.</p>',
        );
        server.close();
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Missing authorization code</h1>');
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Listening for OAuth callback on port ${REDIRECT_PORT}...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 300_000);
  });
}

main().catch((err) => {
  console.error('Workspace auth failed:', err.message);
  process.exit(1);
});
