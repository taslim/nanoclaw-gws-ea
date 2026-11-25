/**
 * Verifies the pinned `gogcli` binary in `container/Dockerfile`:
 *   1. Exact single `GOGCLI_VERSION`, `GOGCLI_SHA256_AMD64`, and `GOGCLI_SHA256_ARM64` ARGs.
 *   2. Both SHA-256 pins match GitHub's release asset digests on `openclaw/gogcli`.
 *   3. No published GitHub Security Advisory on `openclaw/gogcli` or OSV Go vulnerability
 *      for `github.com/openclaw/gogcli` / `github.com/steipete/gogcli` affects `GOGCLI_VERSION`.
 *
 * Usage:
 *   node --import tsx scripts/gogcli-check.ts [--dockerfile container/Dockerfile] [--json]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GOGCLI_REPO = 'openclaw/gogcli';
export const GOGCLI_GO_MODULES = ['github.com/openclaw/gogcli', 'github.com/steipete/gogcli'] as const;

export interface GogcliPin {
  readonly version: string;
  readonly sha256Amd64: string;
  readonly sha256Arm64: string;
}

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly digest?: string | null;
}

export interface GitHubRelease {
  readonly tag_name: string;
  readonly assets: readonly GitHubReleaseAsset[];
}

export interface GitHubAdvisoryVulnerability {
  readonly vulnerable_version_range?: string | null;
  readonly first_patched_version?: string | null;
}

export interface GitHubAdvisory {
  readonly ghsa_id: string;
  readonly cve_id?: string | null;
  readonly summary: string;
  readonly severity?: string | null;
  readonly state?: string | null;
  readonly html_url?: string | null;
  readonly vulnerabilities?: readonly GitHubAdvisoryVulnerability[] | null;
}

export interface OsvVulnerability {
  readonly id: string;
  readonly summary?: string;
  readonly aliases?: readonly string[];
  readonly references?: readonly { readonly type?: string; readonly url?: string }[];
}

export interface OsvQueryResponse {
  readonly vulns?: readonly OsvVulnerability[];
}

export interface AdvisoryHit {
  readonly source: 'github' | 'osv';
  readonly id: string;
  readonly severity: string;
  readonly summary: string;
  readonly url: string;
  readonly range?: string;
  readonly patched?: string;
}

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;

function extractSingleArg(dockerfile: string, name: string, pattern: RegExp, description: string): string {
  const regex = new RegExp(`^\\s*ARG\\s+${name}=([^\\s#]+)`, 'gmu');
  const matches = [...dockerfile.matchAll(regex)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ARG ${name}=... line in Dockerfile (found ${matches.length})`);
  }
  const value = matches[0]![1]!;
  if (!pattern.test(value)) {
    throw new Error(`ARG ${name} must be ${description}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseDockerfileGogcliPin(dockerfile: string): GogcliPin {
  return {
    version: extractSingleArg(dockerfile, 'GOGCLI_VERSION', VERSION_RE, 'an exact x.y.z version'),
    sha256Amd64: extractSingleArg(dockerfile, 'GOGCLI_SHA256_AMD64', SHA256_RE, 'a 64-char lowercase hex sha256'),
    sha256Arm64: extractSingleArg(dockerfile, 'GOGCLI_SHA256_ARM64', SHA256_RE, 'a 64-char lowercase hex sha256'),
  };
}

function parseSemver(version: string): readonly [number, number, number] {
  const clean = version.trim().replace(/^v/u, '');
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/u.exec(clean);
  if (!match) throw new Error(`Invalid semver version: ${JSON.stringify(version)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(left: string, right: string): number {
  const [a1, a2, a3] = parseSemver(left);
  const [b1, b2, b3] = parseSemver(right);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

/**
 * Evaluates a comma-separated semver constraint such as `< 0.44.0`, `<= 0.43.0`,
 * `>= 0.40.0, < 0.44.0`, or `= 0.43.0`. Unknown syntax throws so malformed
 * upstream data is surfaced rather than silently treated as unaffected.
 */
export function versionMatchesRange(version: string, range: string): boolean {
  const clauses = range
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    const match = /^(<=|>=|<|>|==|=)?\s*v?([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(clause);
    if (!match) throw new Error(`Unsupported semver range clause: ${JSON.stringify(clause)}`);
    const op = match[1] ?? '=';
    const target = match[2]!;
    const cmp = compareSemver(version, target);
    const ok =
      op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : op === '>=' ? cmp >= 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

export function verifyReleaseDigests(pin: GogcliPin, release: GitHubRelease): string[] {
  const errors: string[] = [];
  const expected: ReadonlyArray<readonly [arch: string, sha: string]> = [
    ['amd64', pin.sha256Amd64],
    ['arm64', pin.sha256Arm64],
  ];
  for (const [arch, sha] of expected) {
    const assetName = `gogcli_${pin.version}_linux_${arch}.tar.gz`;
    const asset = release.assets.find((entry) => entry.name === assetName);
    if (!asset) {
      errors.push(`Release ${release.tag_name} is missing asset ${assetName}`);
      continue;
    }
    const want = `sha256:${sha}`;
    if (asset.digest !== want) {
      errors.push(
        `GOGCLI_SHA256_${arch.toUpperCase()} does not match GitHub's digest for ${assetName} ` +
          `(pinned ${want}, GitHub reports ${asset.digest ?? 'none'})`,
      );
    }
  }
  return errors;
}

export function findMatchingGitHubAdvisories(version: string, advisories: readonly GitHubAdvisory[]): AdvisoryHit[] {
  const hits: AdvisoryHit[] = [];
  for (const advisory of advisories) {
    if (advisory.state && advisory.state !== 'published') continue;
    const vulns = advisory.vulnerabilities ?? [];
    for (const vuln of vulns) {
      const range = vuln.vulnerable_version_range?.trim();
      if (!range) continue;
      if (versionMatchesRange(version, range)) {
        hits.push({
          source: 'github',
          id: advisory.cve_id || advisory.ghsa_id,
          severity: advisory.severity ?? 'unknown',
          summary: advisory.summary,
          url: advisory.html_url ?? `https://github.com/${GOGCLI_REPO}/security/advisories/${advisory.ghsa_id}`,
          range,
          ...(vuln.first_patched_version ? { patched: vuln.first_patched_version } : {}),
        });
        break;
      }
    }
  }
  return hits;
}

export function findMatchingOsvAdvisories(responses: readonly OsvQueryResponse[]): AdvisoryHit[] {
  const seen = new Set<string>();
  const hits: AdvisoryHit[] = [];
  for (const response of responses) {
    for (const vuln of response.vulns ?? []) {
      if (seen.has(vuln.id)) continue;
      seen.add(vuln.id);
      const url =
        vuln.references?.find((ref) => typeof ref.url === 'string')?.url ?? `https://osv.dev/vulnerability/${vuln.id}`;
      hits.push({
        source: 'osv',
        id: vuln.id,
        severity: 'unknown',
        summary: vuln.summary ?? 'Reported vulnerability in OSV',
        url,
      });
    }
  }
  return hits;
}

function githubHeaders(): Record<string, string> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nanoclaw-gws-ea-gogcli-check',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.json()) as T;
}

export interface CheckReport {
  readonly pin: GogcliPin;
  readonly digestErrors: readonly string[];
  readonly advisories: readonly AdvisoryHit[];
  readonly warnings: readonly string[];
}

export async function checkGogcliPin(dockerfilePath: string, strictOsv = false): Promise<CheckReport> {
  const pin = parseDockerfileGogcliPin(readFileSync(dockerfilePath, 'utf8'));
  const headers = githubHeaders();
  const [release, ghAdvisories] = await Promise.all([
    fetchJson<GitHubRelease>(`https://api.github.com/repos/${GOGCLI_REPO}/releases/tags/v${pin.version}`, { headers }),
    fetchJson<GitHubAdvisory[]>(
      `https://api.github.com/repos/${GOGCLI_REPO}/security-advisories?state=published&per_page=100`,
      { headers },
    ),
  ]);
  const digestErrors = verifyReleaseDigests(pin, release);
  const advisories = [...findMatchingGitHubAdvisories(pin.version, ghAdvisories)];
  const warnings: string[] = [];

  try {
    const osvResponses = await Promise.all(
      GOGCLI_GO_MODULES.map((moduleName) =>
        fetchJson<OsvQueryResponse>('https://api.osv.dev/v1/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'nanoclaw-gws-ea-gogcli-check' },
          body: JSON.stringify({ version: pin.version, package: { name: moduleName, ecosystem: 'Go' } }),
        }),
      ),
    );
    const knownIds = new Set(advisories.map((hit) => hit.id));
    for (const hit of findMatchingOsvAdvisories(osvResponses)) {
      if (!knownIds.has(hit.id)) advisories.push(hit);
    }
  } catch (error) {
    if (strictOsv) throw error;
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Could not reach OSV API for gogcli ${pin.version}: ${message}`);
  }

  return { pin, digestErrors, advisories, warnings };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dockerfile = 'container/Dockerfile';
  let jsonOutput = false;
  let strictOsv = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dockerfile' && args[i + 1]) dockerfile = args[++i]!;
    else if (arg === '--json') jsonOutput = true;
    else if (arg === '--strict-osv') strictOsv = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  const report = await checkGogcliPin(dockerfile, strictOsv);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.digestErrors.length > 0 || report.advisories.length > 0) process.exitCode = 1;
    return;
  }

  for (const warning of report.warnings) {
    console.warn(`::warning file=${dockerfile}::${warning}`);
  }
  for (const error of report.digestErrors) {
    console.error(`::error file=${dockerfile}::${error}`);
  }
  for (const hit of report.advisories) {
    const fix = hit.patched ? ` (fixed in ${hit.patched})` : '';
    console.error(
      `::error file=${dockerfile}::gogcli ${report.pin.version} is affected by ${hit.id} [${hit.severity}]${fix}: ${hit.summary} (${hit.url})`,
    );
  }
  if (report.digestErrors.length > 0 || report.advisories.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `gogcli ${report.pin.version}: amd64/arm64 digests match ${GOGCLI_REPO} release v${report.pin.version}, 0 advisories.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(`::error::gogcli check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
