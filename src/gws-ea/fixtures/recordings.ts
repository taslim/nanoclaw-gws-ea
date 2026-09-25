/**
 * Real command outputs recorded on 2026-09-25 and sanitized (see README.md),
 * as the outcomes boundary tests replay.
 */
import { readFileSync } from 'node:fs';

import type { SanitizedCommandOutcome } from '../process.js';
import dockerContextInspect from './docker-context-inspect.json' with { type: 'json' };

function recorded(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

/** `docker context inspect` on Docker Desktop for macOS, from the capture sink. */
export const RECORDED_DOCKER_CONTEXT_INSPECT: SanitizedCommandOutcome = {
  stdout: dockerContextInspect.stdout,
  stderr: dockerContextInspect.stderr,
  exitCode: dockerContextInspect.exit_code,
};

/** `gcloud auth print-access-token` for an account whose sign-in must be renewed, behind gcloud's Python warning. */
export const RECORDED_GCLOUD_REAUTHENTICATION_FAILED: SanitizedCommandOutcome = {
  stdout: '',
  stderr: recorded('./gcloud-auth-print-access-token.reauth-failed.stderr.txt'),
  exitCode: 1,
};

/** `onecli version` from OneCLI CLI 2.2.5 with no server version to report. */
export const RECORDED_ONECLI_VERSION: SanitizedCommandOutcome = {
  stdout: recorded('./onecli-version.stdout.json'),
  stderr: '',
  exitCode: 0,
};
