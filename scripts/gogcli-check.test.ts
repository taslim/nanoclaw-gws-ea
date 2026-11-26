import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  findMatchingGitHubAdvisories,
  findMatchingOsvAdvisories,
  parseDockerfileGogcliPin,
  queryOsvAdvisories,
  verifyReleaseDigests,
  versionMatchesRange,
  type GitHubRelease,
  type GogcliPin,
} from './gogcli-check.js';

const AMD64_SHA = 'a'.repeat(64);
const ARM64_SHA = 'b'.repeat(64);

const SAMPLE_DOCKERFILE = `
FROM node:22-slim
ARG GOGCLI_VERSION=0.43.0
ARG GOGCLI_SHA256_AMD64=${AMD64_SHA}
ARG GOGCLI_SHA256_ARM64=${ARM64_SHA}
`;

const SAMPLE_PIN: GogcliPin = {
  version: '0.43.0',
  sha256Amd64: AMD64_SHA,
  sha256Arm64: ARM64_SHA,
};

describe('parseDockerfileGogcliPin', () => {
  it('extracts version and both sha256 pins from container/Dockerfile', () => {
    expect(parseDockerfileGogcliPin(SAMPLE_DOCKERFILE)).toEqual(SAMPLE_PIN);
  });

  it('rejects duplicate, missing, or malformed pins', () => {
    expect(() => parseDockerfileGogcliPin('ARG GOGCLI_VERSION=0.43.0\n')).toThrow(/GOGCLI_SHA256_AMD64/);
    expect(() => parseDockerfileGogcliPin(`${SAMPLE_DOCKERFILE}\nARG GOGCLI_VERSION=0.44.0\n`)).toThrow(/found 2/);
    expect(() => parseDockerfileGogcliPin(SAMPLE_DOCKERFILE.replace(AMD64_SHA, 'not-hex'))).toThrow(
      /64-char lowercase hex/,
    );
  });
});

describe('verifyReleaseDigests', () => {
  const release: GitHubRelease = {
    tag_name: 'v0.43.0',
    assets: [
      { name: 'gogcli_0.43.0_linux_amd64.tar.gz', digest: `sha256:${AMD64_SHA}` },
      { name: 'gogcli_0.43.0_linux_arm64.tar.gz', digest: `sha256:${ARM64_SHA}` },
    ],
  };

  it('passes when both architecture digests match GitHub release assets', () => {
    expect(verifyReleaseDigests(SAMPLE_PIN, release)).toEqual([]);
  });

  it('reports digest mismatches and missing assets', () => {
    const errors = verifyReleaseDigests(SAMPLE_PIN, {
      tag_name: 'v0.43.0',
      assets: [{ name: 'gogcli_0.43.0_linux_amd64.tar.gz', digest: `sha256:${'c'.repeat(64)}` }],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('GOGCLI_SHA256_AMD64');
    expect(errors[1]).toContain('missing asset gogcli_0.43.0_linux_arm64.tar.gz');
  });
});

describe('semver and advisory matching', () => {
  it('evaluates single and compound version ranges accurately', () => {
    expect(compareSemver('0.43.0', '0.44.0')).toBeLessThan(0);
    expect(versionMatchesRange('0.43.0', '< 0.44.0')).toBe(true);
    expect(versionMatchesRange('0.44.0', '< 0.44.0')).toBe(false);
    expect(versionMatchesRange('0.43.0', '<= 0.43.0')).toBe(true);
    expect(versionMatchesRange('0.43.0', '>= 0.40.0, < 0.44.0')).toBe(true);
    expect(versionMatchesRange('0.39.9', '>= 0.40.0, < 0.44.0')).toBe(false);
    expect(versionMatchesRange('0.43.0', '= 0.43.0')).toBe(true);
    expect(() => versionMatchesRange('0.43.0', '~0.43.0')).toThrow(/Unsupported semver range/);
  });

  it('matches only published GitHub advisories affecting the pinned version', () => {
    const hits = findMatchingGitHubAdvisories('0.43.0', [
      {
        ghsa_id: 'GHSA-draft-1',
        state: 'draft',
        summary: 'Draft',
        vulnerabilities: [{ vulnerable_version_range: '< 0.44.0' }],
      },
      {
        ghsa_id: 'GHSA-old-1',
        state: 'published',
        summary: 'Already patched',
        vulnerabilities: [{ vulnerable_version_range: '< 0.43.0', patched_versions: '0.43.0' }],
      },
      {
        ghsa_id: 'GHSA-hit-1',
        cve_id: 'CVE-2026-9999',
        severity: 'high',
        state: 'published',
        summary: 'Token leak in redirect',
        html_url: 'https://github.com/openclaw/gogcli/security/advisories/GHSA-hit-1',
        vulnerabilities: [{ vulnerable_version_range: '>= 0.40.0, < 0.44.0', patched_versions: '0.44.0' }],
      },
    ]);
    expect(hits).toEqual([
      {
        source: 'github',
        id: 'CVE-2026-9999',
        severity: 'high',
        summary: 'Token leak in redirect',
        url: 'https://github.com/openclaw/gogcli/security/advisories/GHSA-hit-1',
        range: '>= 0.40.0, < 0.44.0',
        patched: '0.44.0',
      },
    ]);
  });

  it('deduplicates OSV vulnerability hits across module paths', () => {
    const hits = findMatchingOsvAdvisories([
      { vulns: [{ id: 'GO-2026-0001', summary: 'Issue 1', references: [{ url: 'https://example.test/1' }] }] },
      {
        vulns: [
          { id: 'GO-2026-0001', summary: 'Issue 1' },
          { id: 'GO-2026-0002', summary: 'Issue 2' },
        ],
      },
    ]);
    expect(hits).toEqual([
      { source: 'osv', id: 'GO-2026-0001', severity: 'unknown', summary: 'Issue 1', url: 'https://example.test/1' },
      {
        source: 'osv',
        id: 'GO-2026-0002',
        severity: 'unknown',
        summary: 'Issue 2',
        url: 'https://osv.dev/vulnerability/GO-2026-0002',
      },
    ]);
  });

  it('follows OSV next_page_token even across pages without vulns and retains fulfilled hits on partial failure', async () => {
    const seenTokens: Array<string | undefined> = [];
    const partial = await queryOsvAdvisories(
      '0.43.0',
      ['github.com/openclaw/gogcli', 'github.com/steipete/gogcli'],
      false,
      async (payload) => {
        if (payload.package.name === 'github.com/steipete/gogcli') {
          throw new Error('HTTP 503 from https://api.osv.dev/v1/query');
        }
        seenTokens.push(payload.page_token);
        if (!payload.page_token) return { next_page_token: 'page-2' };
        return { vulns: [{ id: 'GO-2026-0099', summary: 'Late page finding' }] };
      },
    );
    expect(seenTokens).toEqual([undefined, 'page-2']);
    expect(partial.advisories).toEqual([
      {
        source: 'osv',
        id: 'GO-2026-0099',
        severity: 'unknown',
        summary: 'Late page finding',
        url: 'https://osv.dev/vulnerability/GO-2026-0099',
      },
    ]);
    expect(partial.warnings).toHaveLength(1);
    expect(partial.warnings[0]).toContain('github.com/steipete/gogcli');

    await expect(
      queryOsvAdvisories('0.43.0', ['github.com/openclaw/gogcli', 'github.com/steipete/gogcli'], true, async (p) => {
        if (p.package.name === 'github.com/steipete/gogcli') throw new Error('HTTP 503');
        return {};
      }),
    ).rejects.toThrow(/OSV query failed for gogcli 0.43.0/);
  });

  it('retains advisories fetched on earlier OSV pages when a subsequent page fails', async () => {
    const partial = await queryOsvAdvisories('0.43.0', ['github.com/openclaw/gogcli'], false, async (payload) => {
      if (!payload.page_token) {
        return {
          vulns: [{ id: 'GO-2026-0100', summary: 'Page 1 finding' }],
          next_page_token: 'page-2',
        };
      }
      throw new Error('HTTP 503 on page 2');
    });
    expect(partial.advisories).toEqual([
      {
        source: 'osv',
        id: 'GO-2026-0100',
        severity: 'unknown',
        summary: 'Page 1 finding',
        url: 'https://osv.dev/vulnerability/GO-2026-0100',
      },
    ]);
    expect(partial.warnings).toHaveLength(1);
    expect(partial.warnings[0]).toContain('HTTP 503 on page 2');

    await expect(
      queryOsvAdvisories('0.43.0', ['github.com/openclaw/gogcli'], true, async (payload) => {
        if (!payload.page_token) {
          return { vulns: [{ id: 'GO-2026-0100', summary: 'Page 1 finding' }], next_page_token: 'page-2' };
        }
        throw new Error('HTTP 503 on page 2');
      }),
    ).rejects.toThrow(/HTTP 503 on page 2/);
  });
});
