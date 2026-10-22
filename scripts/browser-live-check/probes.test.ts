import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { launchProbeBrowser } from './probes.js';

const execFileAsync = promisify(execFile);
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;

async function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

describe.skipIf(!chromePath)('native live-check harness', () => {
  it('uses the owned loopback production connection and removes its disposable resources', async () => {
    const probe = await launchProbeBrowser({ chromePath });
    let debuggerPort = 0;
    try {
      // A separate harness launcher could pass its own API checks while production uses another transport.
      expect(probe).toHaveProperty('debuggerPort', expect.any(Number));
      expect(Number.isInteger(probe.debuggerPort)).toBe(true);
      expect(probe.debuggerPort).toBeGreaterThan(0);
      expect(probe.debuggerPort).toBeLessThanOrEqual(65_535);
      debuggerPort = probe.debuggerPort;
      const { stdout } = await execFileAsync('lsof', ['-nP', '-a', `-iTCP:${debuggerPort}`, '-sTCP:LISTEN', '-Fpn'], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      const records = stdout.trim().split('\n');
      expect(records.filter((record) => record.startsWith('p'))).toEqual([`p${probe.child.pid}`]);
      const listeners = records.filter((record) => record.startsWith('n'));
      expect(listeners.length).toBeGreaterThan(0);
      expect(listeners.every((record) => record === `n127.0.0.1:${debuggerPort}`)).toBe(true);
      const page = await probe.newPage();
      await page.goto(
        "data:text/html,<h1>Before</h1><button onclick=\"document.querySelector('h1').textContent='After'\">Run</button>",
      );
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      expect(await page.locator('h1').textContent()).toBe('After');
      expect(await page.evaluate(() => ({ api: typeof Notification, permission: Notification.permission }))).toEqual({
        api: 'function',
        permission: 'denied',
      });
      await page.close();
    } finally {
      await probe.close();
    }
    expect(probe.child.exitCode !== null || probe.child.signalCode !== null).toBe(true);
    expect(await reachable(debuggerPort)).toBe(false);
    await expect(stat(probe.profile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(probe.artifacts)).rejects.toMatchObject({ code: 'ENOENT' });
    await probe.close();
  }, 45_000);
});
