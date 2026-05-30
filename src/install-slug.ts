/**
 * Per-checkout install identifiers. Slug is sha1(projectRoot)[:8] — lets two
 * NanoClaw installs coexist on one host without clobbering service
 * registration or docker image tags.
 *
 * GWS-EA fork delta: when `.env::ASSISTANT_NAME` is set, launchd label and
 * systemd unit names prepend `<assistant>-` to the slug, matching the
 * OneCLI `<assistant>-<purpose>` convention while keeping slug-based
 * collision protection. Container image base stays slug-only.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

function readAssistantName(projectRoot?: string): string | null {
  const root = projectRoot ?? process.cwd();
  try {
    const content = fs.readFileSync(path.join(root, '.env'), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (!t.startsWith('ASSISTANT_NAME=')) continue;
      let v = t.slice('ASSISTANT_NAME='.length).trim();
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      return v || null;
    }
  } catch {
    // .env missing or unreadable — caller falls back to slug-only naming.
  }
  return null;
}

export function slugifyAssistant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/**
 * launchd Label + plist basename.
 * EA installs: `com.<assistant>-nanoclaw-<slug>`.
 * Non-EA fallback: `com.nanoclaw-v2-<slug>`.
 */
export function getLaunchdLabel(projectRoot?: string): string {
  const slug = getInstallSlug(projectRoot);
  const name = readAssistantName(projectRoot);
  if (name) {
    const assistantSlug = slugifyAssistant(name);
    if (assistantSlug) return `com.${assistantSlug}-nanoclaw-${slug}`;
  }
  return `com.nanoclaw-v2-${slug}`;
}

/**
 * systemd unit name (no .service suffix).
 * EA installs: `<assistant>-nanoclaw-<slug>`. Non-EA fallback: `nanoclaw-v2-<slug>`.
 */
export function getSystemdUnit(projectRoot?: string): string {
  const slug = getInstallSlug(projectRoot);
  const name = readAssistantName(projectRoot);
  if (name) {
    const assistantSlug = slugifyAssistant(name);
    if (assistantSlug) return `${assistantSlug}-nanoclaw-${slug}`;
  }
  return `nanoclaw-v2-${slug}`;
}

/** Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `nanoclaw-agent-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
