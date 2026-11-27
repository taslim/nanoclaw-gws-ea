/** Node runs it directly by stripping types, so it imports only builtins. */
import fs from 'node:fs';
import path from 'node:path';

// Tests import only this module's types: a value import would run the CLI in the test process.
const CONTROL_FILE = 'fake-link.json';
const LOG_FILE = 'fake-link.jsonl';
const ANSWER_FILE = 'fake-link-answer';

export interface FakeLinkControl {
  readonly login?: 'wait' | 'approve' | 'deny' | 'expire' | 'timeout' | 'garbled' | 'no_phrase';
  readonly verificationUrl?: string;
  readonly phrase?: string;
  readonly token?: string;
  readonly logoutFails?: boolean;
}

export interface FakeLinkRecord {
  readonly args: readonly string[];
  readonly authFile: string | null;
  readonly proxy: string | null;
  readonly pid: number;
}

const args = process.argv.slice(2);

if (args.includes('--mcp')) {
  await import(new URL('./fake-stdio-app.ts', import.meta.url).href);
} else {
  const control: FakeLinkControl = fs.existsSync(CONTROL_FILE)
    ? (JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')) as FakeLinkControl)
    : {};
  const authFile = process.env.LINK_AUTH_FILE ?? null;
  const record: FakeLinkRecord = { args, authFile, proxy: process.env.LINK_HTTP_PROXY ?? null, pid: process.pid };
  fs.appendFileSync(path.join(process.cwd(), LOG_FILE), `${JSON.stringify(record)}\n`);

  const line = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const chunk = (data: Record<string, unknown>): void => line({ type: 'chunk', data });
  const done = (command: string): void => line({ type: 'done', ok: true, meta: { command, duration: '1ms' } });
  const fail = (message: string): never => {
    line({ type: 'error', ok: false, error: { code: 'UNKNOWN', message } });
    process.exit(1);
  };
  const readState = (): { auth: Record<string, unknown> | null; pendingDeviceAuth: unknown } => {
    if (!authFile || !fs.existsSync(authFile)) return { auth: null, pendingDeviceAuth: null };
    return JSON.parse(fs.readFileSync(authFile, 'utf8')) as {
      auth: Record<string, unknown> | null;
      pendingDeviceAuth: unknown;
    };
  };
  const writeState = (state: unknown): void => {
    if (authFile) fs.writeFileSync(authFile, JSON.stringify(state, null, '\t'), { mode: 0o600 });
  };
  const verificationUrl = control.verificationUrl ?? 'https://app.link.com/device?code=fake';
  const phrase = control.phrase ?? 'apple-banana-cherry';
  const token = control.token ?? 'fake-link-token';
  const pendingRecord = {
    authenticated: false,
    credentials_path: authFile,
    pending: true,
    verification_url: verificationUrl,
    phrase,
  };
  const approve = (): void => {
    writeState({
      auth: {
        access_token: token,
        refresh_token: token,
        expires_in: 3600,
        token_type: 'Bearer',
        expires_at: Date.now() + 3_600_000,
      },
      pendingDeviceAuth: null,
    });
    chunk({
      authenticated: true,
      access_token: `${token.slice(0, 20)}...`,
      token_type: 'Bearer',
      credentials_path: authFile,
    });
    done('auth login');
  };

  const [group, command] = args;
  if (group === 'auth' && command === 'login') {
    writeState({
      auth: null,
      pendingDeviceAuth: {
        device_code: 'fake-device',
        interval: 5,
        expires_at: Date.now() + 600_000,
        verification_url: verificationUrl,
        phrase,
      },
    });
    if (control.login === 'no_phrase') chunk({ instruction: 'Present the verification_url to the user.' });
    else
      chunk({
        verification_url: verificationUrl,
        phrase,
        instruction: 'Present the verification_url to the user and ask them to approve in the Link app.',
      });
    chunk(pendingRecord);
    switch (control.login ?? 'wait') {
      case 'approve':
        approve();
        break;
      case 'deny':
        fail('Authorization denied by user.');
        break;
      case 'expire':
        fail('Device code expired. Please restart the login flow.');
        break;
      case 'timeout':
        chunk(pendingRecord);
        done('auth login');
        break;
      case 'garbled':
        process.stdout.write('Polling…\n');
        // A referenced timer keeps the process alive so only the host's kill can end it.
        setInterval(() => undefined, 60_000);
        await new Promise(() => undefined);
        break;
      case 'no_phrase':
      case 'wait':
        for (;;) {
          const answer = fs.existsSync(ANSWER_FILE) ? fs.readFileSync(ANSWER_FILE, 'utf8').trim() : '';
          if (answer === 'approve') {
            approve();
            break;
          }
          if (answer === 'deny') fail('Authorization denied by user.');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        break;
    }
  } else if (group === 'auth' && command === 'status') {
    const { auth } = readState();
    chunk(
      auth
        ? { authenticated: true, token_type: 'Bearer', credentials_path: authFile }
        : { authenticated: false, credentials_path: authFile },
    );
    done('auth status');
  } else if (group === 'auth' && command === 'logout') {
    if (control.logoutFails) fail('Request failed: POST https://login.link.com/device/revoke');
    if (authFile) fs.rmSync(authFile, { force: true });
    process.stdout.write('{"authenticated":false}\n');
  } else {
    fail(`The fake Link CLI does not run ${args.join(' ')}`);
  }
}
