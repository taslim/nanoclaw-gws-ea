import { spawn } from 'child_process';

const INTERACTIVE_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'BROWSER',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

export interface InheritScriptOptions {
  readonly env?: Readonly<Record<string, string>>;
}

/** Minimal interactive environment with no ambient credential variables. */
export function buildInteractiveEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = { NANOCLAW_SETUP_WIZARD: '1' };
  for (const key of INTERACTIVE_ENVIRONMENT_KEYS) {
    const value = ambient[key];
    if (value !== undefined && !value.includes('\0')) environment[key] = value;
  }
  return environment;
}

/**
 * Run a script with the terminal handed over (inherited stdio). Extracted from
 * setup/auto.ts so channel flows can reuse it without importing the driver.
 *
 * Hand the terminal over before spawning, or the child's first prompt eats
 * a keystroke that never reaches it.
 *
 * `stdio: 'inherit'` gives the child our own fd 0 — the same file
 * description, not a copy. clack leaves stdin resumed between prompts and
 * puts the TTY in raw mode during one, so this process is still reading
 * that fd when the child starts. Bytes it pulls in are buffered here and
 * are gone as far as the child is concerned, which is why "Press Enter"
 * needed pressing twice: the first went to a parent nobody was asking.
 */
export function runInheritScript(cmd: string, args: string[], options: InheritScriptOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const tty = Boolean(process.stdin.isTTY);
    const wasRaw = tty && process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);
    process.stdin.pause();

    // Tells the child it has a UI in front of it, so it can leave the
    // reporting to us instead of printing its own alongside ours.
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: options.env ?? { ...process.env, NANOCLAW_SETUP_WIZARD: '1' },
    });
    child.on('close', (code) => {
      // Deliberately not restoring raw mode: clack sets it per prompt, and
      // handing it back a cooked TTY is the state it expects to find.
      process.stdin.resume();
      resolve(code ?? 1);
    });
  });
}
