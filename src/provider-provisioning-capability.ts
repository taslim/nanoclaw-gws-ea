import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SHARED_CAPABILITY_FILES = [
  'setup/lib/bright-select.ts',
  'setup/lib/captured-token.ts',
  'setup/lib/inherit-script.ts',
  '.claude/skills/add-onecli/scripts/install-claude.sh',
  '.claude/skills/add-onecli/scripts/register-claude-token.sh',
  'src/provider-credential.ts',
] as const;
const NON_PROVISIONING_PROVIDER_FILES = new Set(['install.ts', 'skill-descriptor.ts']);

async function collectFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Provider setup capability cannot contain a symlink: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
    } else if (entry.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) {
      files.push(path.relative(root, absolute));
    }
  }
  return files;
}

/**
 * Fingerprint the executable setup surface used to list and authenticate
 * providers. GWS-EA uses this as a deliberately strict launcher/target
 * equivalence proof before any cloud or container mutation.
 */
export async function providerProvisioningCapabilityDigest(projectRoot: string): Promise<string> {
  const normalizedRoot = path.resolve(projectRoot);
  const providersRoot = path.join(normalizedRoot, 'setup', 'providers');
  const providersInfo = await lstat(providersRoot);
  if (!providersInfo.isDirectory() || providersInfo.isSymbolicLink()) {
    throw new Error('Provider setup capability root must be a physical directory');
  }
  const files = (await collectFiles(normalizedRoot, providersRoot)).filter(
    (file) => !NON_PROVISIONING_PROVIDER_FILES.has(path.basename(file)),
  );
  for (const relativePath of SHARED_CAPABILITY_FILES) {
    const info = await lstat(path.join(normalizedRoot, relativePath));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Provider setup capability file must be a regular file: ${relativePath}`);
    }
    files.push(relativePath);
  }
  files.sort();

  const digest = createHash('sha256');
  for (const relativePath of files) {
    const contents = await readFile(path.join(normalizedRoot, relativePath));
    digest.update(`${relativePath}\0${contents.byteLength}\0`, 'utf8');
    digest.update(contents);
  }
  return digest.digest('hex');
}

export function assertProviderProvisioningCapabilityDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error('Provider setup capability digest is invalid');
  }
  return value;
}
