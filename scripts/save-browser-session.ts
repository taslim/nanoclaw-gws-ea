#!/usr/bin/env npx tsx
/**
 * Save a browser login session for the agent to use.
 *
 * Opens a visible Chromium browser so you can log in manually.
 * When you're done, press Enter in the terminal to save the session.
 *
 * Usage:
 *   npx tsx scripts/save-browser-session.ts <name> [url]
 *
 * Examples:
 *   npx tsx scripts/save-browser-session.ts linkedin https://linkedin.com
 *   npx tsx scripts/save-browser-session.ts github https://github.com/login
 *   npx tsx scripts/save-browser-session.ts jira https://mycompany.atlassian.net
 *
 * Saves to: groups/main/auth/<name>.json
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const name = process.argv[2];
const url = process.argv[3] || 'about:blank';

if (!name) {
  console.error('Usage: npx tsx scripts/save-browser-session.ts <name> [url]');
  console.error('Example: npx tsx scripts/save-browser-session.ts github https://github.com/login');
  process.exit(1);
}

const authDir = path.join(process.cwd(), 'groups', 'main', 'auth');
const outFile = path.join(authDir, `${name}.json`);

fs.mkdirSync(authDir, { recursive: true });

async function main() {
  console.log(`\nOpening browser → ${url}`);
  console.log('Log in, then come back here and press Enter to save.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(url);

  // Wait for user to finish logging in
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question('Press Enter when logged in... ', () => {
      rl.close();
      resolve();
    });
  });

  // Save storage state (cookies + localStorage)
  const state = await context.storageState();
  fs.writeFileSync(outFile, JSON.stringify(state, null, 2));

  await browser.close();

  console.log(`\nSession saved → ${outFile}`);
  console.log(`Cookies: ${state.cookies.length}`);
  console.log(`Origins: ${state.origins.length}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
