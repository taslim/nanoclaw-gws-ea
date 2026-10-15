import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runProbe, type ProbeResult, type ProbeStatus } from './evidence.js';

const execFileAsync = promisify(execFile);
export const DESKTOP_SAMPLE_INTERVAL_MS = 750;
export const DESKTOP_READ_TIMEOUT_MS = 5_000;

export interface DesktopObservation {
  sampledAt: string;
  frontmostApp: string | null;
  clipboardChangeCount: number | null;
  space: string | null;
  errors: string[];
}

/** Reads the pasteboard's counter only. Clipboard contents never cross this boundary. */
async function readDesktop(): Promise<DesktopObservation> {
  const sampledAt = new Date().toISOString();
  try {
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        "ObjC.import('AppKit'); JSON.stringify({frontmostApp: $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js, clipboardChangeCount: Number($.NSPasteboard.generalPasteboard.changeCount)})",
      ],
      { encoding: 'utf8', timeout: DESKTOP_READ_TIMEOUT_MS },
    );
    const value: unknown = JSON.parse(stdout);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('frontmostApp' in value) ||
      typeof value.frontmostApp !== 'string' ||
      !('clipboardChangeCount' in value) ||
      typeof value.clipboardChangeCount !== 'number' ||
      !Number.isInteger(value.clipboardChangeCount)
    ) {
      throw new Error('macOS returned an invalid desktop observation');
    }
    return {
      sampledAt,
      frontmostApp: value.frontmostApp,
      clipboardChangeCount: value.clipboardChangeCount,
      // AppKit offers no supported passive active-Space identifier. Do not
      // substitute a window count, or invoke UI scripting that changes Spaces.
      space: null,
      errors: ['Passive active-Space observation is unavailable'],
    };
  } catch (error: unknown) {
    return {
      sampledAt,
      frontmostApp: null,
      clipboardChangeCount: null,
      space: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function assessQuietOperation(observations: readonly DesktopObservation[]): {
  status: ProbeStatus;
  changes: string[];
  unavailable: string[];
} {
  const changes: string[] = [];
  const unavailable: string[] = [];
  const fields = [
    ['frontmostApp', 'frontmost_app'],
    ['space', 'space'],
    ['clipboardChangeCount', 'clipboard'],
  ] as const;
  for (const [field, label] of fields) {
    const values = observations.map((observation) => observation[field]);
    if (new Set(values.filter((value) => value !== null)).size > 1) changes.push(label);
    if (values.length < 2 || values.some((value) => value === null)) unavailable.push(label);
  }
  if (observations.some((observation) => observation.frontmostApp === 'com.apple.loginwindow')) {
    unavailable.push('active_desktop');
  }
  return {
    status: changes.length > 0 ? 'failed' : unavailable.length > 0 ? 'not-run' : 'passed',
    changes,
    unavailable,
  };
}

export class FocusSampler {
  readonly observations: DesktopObservation[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;

  async start(): Promise<void> {
    await this.sample();
    this.timer = setInterval(() => {
      // A slow macOS read skips ticks instead of retaining a backlog.
      if (!this.pending) void this.sample();
    }, DESKTOP_SAMPLE_INTERVAL_MS);
  }

  async sample(): Promise<void> {
    // Probe boundaries also wait for an in-flight read before sampling.
    while (this.pending) await this.pending;
    const pending = readDesktop().then((observation) => {
      this.observations.push(observation);
    });
    this.pending = pending;
    try {
      await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }

  async runProbe(name: string, execute: () => Promise<Omit<ProbeResult, 'name'>>): Promise<ProbeResult> {
    const start = this.observations.length;
    await this.sample();
    const result = await runProbe(name, execute);
    await this.sample();
    const quiet = assessQuietOperation(this.observations.slice(start));
    return {
      ...result,
      status: quiet.status === 'failed' ? 'failed' : result.status,
      detail: {
        ...result.detail,
        quietObservation: {
          status: quiet.status,
          changes: quiet.changes,
          unavailable: quiet.unavailable,
        },
      },
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.pending;
    await this.sample();
  }
}
