/**
 * Per-checkout install identifiers. Lets two NanoClaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `nanoclaw-agent:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 *
 * NANOCLAW_INSTALL_ID overrides the cwd derivation for deployments where
 * the checkout path is not a stable identity (copied or ephemeral trees), so
 * identity can come from the environment instead. The value flows into
 * docker labels, image names, and service unit names — hence the
 * conservative charset. Unset = today's behavior, byte-identical.
 */
import { createHash } from 'crypto';

const INSTALL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface InstallScopedNames {
  readonly launchdLabel: string;
  readonly systemdUnit: string;
  readonly containerImageBase: string;
  readonly defaultContainerImage: string;
  readonly containerInstallLabel: string;
}

/** Names shared by every host and container resource owned by one install. */
export function getInstallScopedNames(installSlug: string): InstallScopedNames {
  if (!INSTALL_ID_PATTERN.test(installSlug)) {
    throw new Error(`Install slug must be 1-32 chars of [a-z0-9_-] starting alphanumeric (got '${installSlug}')`);
  }
  const containerImageBase = `nanoclaw-agent-v2-${installSlug}`;
  return {
    launchdLabel: `com.nanoclaw-v2-${installSlug}`,
    systemdUnit: `nanoclaw-v2-${installSlug}`,
    containerImageBase,
    defaultContainerImage: `${containerImageBase}:latest`,
    containerInstallLabel: `nanoclaw-install=${installSlug}`,
  };
}

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  const override = process.env.NANOCLAW_INSTALL_ID;
  if (override) {
    if (!INSTALL_ID_PATTERN.test(override)) {
      throw new Error(`NANOCLAW_INSTALL_ID must be 1-32 chars of [a-z0-9_-] starting alphanumeric (got '${override}')`);
    }
    return override;
  }
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `com.nanoclaw-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return getInstallScopedNames(getInstallSlug(projectRoot)).launchdLabel;
}

/** systemd unit name (no .service suffix). e.g. `nanoclaw-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return getInstallScopedNames(getInstallSlug(projectRoot)).systemdUnit;
}

/** Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return getInstallScopedNames(getInstallSlug(projectRoot)).containerImageBase;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return getInstallScopedNames(getInstallSlug(projectRoot)).defaultContainerImage;
}
