import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveGchatServiceAccountEmail, deriveGcpProjectId } from './gcloud.js';

/**
 * The committed-fixture scan: a recording may carry an identifying or
 * secret value only from the reserved synthetic set.
 */
const FIXTURES = path.join(import.meta.dirname, 'fixtures');

const RESERVED_HOME = '/home/operator';
/** A zero-filled UUID that keeps a v4 UUID's version and variant digits, so instance-ID checks accept it. */
const RESERVED_INSTANCE_ID = '00000000-0000-4000-8000-000000000000';
const RESERVED_PROJECT = deriveGcpProjectId(RESERVED_INSTANCE_ID);
const RESERVED_SERVICE_ACCOUNT_DOMAIN = deriveGchatServiceAccountEmail(RESERVED_PROJECT).split('@')[1]!;
const RESERVED_IPS = new Set(['0.0.0.0', '::']);

/** All zeros, except at most a short trailing ordinal that keeps distinct resources distinct. */
function zeroFilled(hex: string): boolean {
  return /^0*[0-9a-f]{0,4}$/iu.test(hex);
}

/** A zero-filled UUID, whose version and variant digits may keep their format. */
function zeroFilledUuid(uuid: string): boolean {
  const hex = uuid.replaceAll('-', '');
  return zeroFilled(`${hex.slice(0, 12)}0${hex.slice(13, 16)}0${hex.slice(17)}`);
}

function reservedEmailDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return lower === 'example.com' || lower.endsWith('.example.com') || lower === RESERVED_SERVICE_ACCOUNT_DOMAIN;
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const HEXTET = '[0-9a-f]{1,4}';

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly reserved: (match: RegExpExecArray) => boolean;
}

const RULES: readonly Rule[] = [
  {
    name: 'IPv4 address',
    pattern: new RegExp(`(?<![\\d.])(?:${OCTET}\\.){3}${OCTET}(?!\\.?\\d)`, 'gu'),
    reserved: ([match]) => RESERVED_IPS.has(match),
  },
  {
    name: 'IPv6 address',
    pattern: new RegExp(
      `(?<![\\w:])(?:(?:${HEXTET}:){7}${HEXTET}|(?:${HEXTET}(?::${HEXTET})*)?::(?:${HEXTET}(?::${HEXTET})*)?)(?![\\w:])`,
      'giu',
    ),
    reserved: ([match]) => RESERVED_IPS.has(match),
  },
  {
    name: 'email address',
    pattern: /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu,
    reserved: (match) => reservedEmailDomain(match[1]!),
  },
  {
    name: 'UUID',
    pattern: /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/giu,
    reserved: ([match]) => zeroFilledUuid(match),
  },
  {
    // 32 or more: Cloudflare account, zone, and record IDs as well as 40-hex key IDs and commits.
    name: 'long hex string',
    pattern: /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/giu,
    reserved: ([match]) => zeroFilled(match),
  },
  {
    name: 'home path',
    pattern: /\/(?:Users|home)\/[\w.-]+/gu,
    // A sentence may end right after the reserved home.
    reserved: ([match]) => match.replace(/\.+$/u, '') === RESERVED_HOME,
  },
  {
    name: 'credential prefix',
    pattern: /eyJ|sk-ant-|\boc_|ya29\.|-----BEGIN/gu,
    reserved: () => false,
  },
];

interface Finding {
  readonly rule: string;
  readonly value: string;
}

function scanText(text: string): Finding[] {
  return RULES.flatMap((rule) =>
    [...text.matchAll(rule.pattern)]
      .filter((match) => !rule.reserved(match))
      .map((match) => ({ rule: rule.name, value: match[0] })),
  );
}

/** Every string a JSON document holds, keys included, with escapes decoded. */
function jsonStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStrings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...jsonStrings(entry)]);
  }
  return [];
}

/** Scan a fixture as written and, for JSON, as decoded, so an escape cannot hide a value. */
function scanFixture(name: string, contents: string): Finding[] {
  const decoded = name.endsWith('.json') ? jsonStrings(JSON.parse(contents)) : [];
  const findings = [contents, ...decoded].flatMap(scanText);
  return [...new Map(findings.map((finding) => [`${finding.rule}\0${finding.value}`, finding])).values()];
}

describe('committed fixtures', () => {
  it('carry no IP, email, UUID, long hex string, home path, or credential prefix outside the reserved set', async () => {
    const entries = await readdir(FIXTURES, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(FIXTURES, path.join(entry.parentPath, entry.name)));
    expect(files).toEqual(expect.arrayContaining(['README.md', 'docker-context-inspect.json']));

    const findings = await Promise.all(
      files.map(async (file) => ({
        file,
        findings: scanFixture(file, await readFile(path.join(FIXTURES, file), 'utf8')),
      })),
    );

    expect(findings.filter((result) => result.findings.length > 0)).toEqual([]);
  });
});

describe('fixture scan', () => {
  it.each([
    ['a private IPv4 address', '"origin_ip": "10.24.0.7"', 'IPv4 address'],
    ['a documentation IPv4 address', 'ssh://builder@203.0.113.7', 'IPv4 address'],
    ['an IPv6 address', '"address": "2001:db8:85a3::8a2e:370:7334"', 'IPv6 address'],
    ['a loopback IPv6 address', 'http://[::1]:8080', 'IPv6 address'],
    ['a full IPv6 address', 'fe80:0:0:0:200:f8ff:fe21:67cf', 'IPv6 address'],
    ['a personal email', 'account: jane.doe@gmail.com', 'email address'],
    ['a Workspace email', 'owner@corp.example.org', 'email address'],
    [
      'another project’s service account',
      'gws-ea-chat@gws-ea-1a2b3c4d5e6f7a8b9c0d.iam.gserviceaccount.com',
      'email address',
    ],
    ['a UUID', '"id": "123e4567-e89b-12d3-a456-426614174000"', 'UUID'],
    ['a 40-hex key ID', '"private_key_id": "3e28af43e476702724501d5efc04c79127df1958"', 'long hex string'],
    ['a 32-hex Cloudflare account ID', '"account_id": "9a7806061c88ada191ed06f989cc3dac"', 'long hex string'],
    ['a macOS home path', 'unix:///Users/jane/.docker/run/docker.sock', 'home path'],
    ['a Linux home path', '/home/jane/.config/gcloud', 'home path'],
    ['a macOS home path for the reserved user name', '/Users/operator/.docker', 'home path'],
    ['a JWT', 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln', 'credential prefix'],
    ['an Anthropic key', 'sk-ant-api03-abc', 'credential prefix'],
    ['a OneCLI key', '"apiKey": "oc_abc"', 'credential prefix'],
    ['a Google access token', 'ya29.a0AfB_byC', 'credential prefix'],
    ['a PEM block', '-----BEGIN PRIVATE KEY-----', 'credential prefix'],
  ])('flags %s', (_case, text, rule) => {
    expect(scanText(text).map((finding) => finding.rule)).toContain(rule);
  });

  it('flags a value hidden behind a JSON escape', () => {
    // As written, the key follows an escaped newline and the path is unicode-escaped.
    const escaped = JSON.stringify({ stderr: 'failed\noc_abcdef', path: '/Users/jane' }).replace(
      '/Users/jane',
      '\\u002fUsers\\u002fjane',
    );
    expect(scanText(escaped)).toEqual([]);

    expect(scanFixture('planted.json', escaped).map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['credential prefix', 'home path']),
    );
  });

  it.each([
    ['a zero-filled UUID', '"id": "00000000-0000-0000-0000-000000000000"'],
    ['the reserved instance ID', `"instance_id": "${RESERVED_INSTANCE_ID}"`],
    ['a zero-filled UUID with an ordinal', '"tunnel_id": "00000000-0000-4000-8000-000000000002"'],
    ['a zero-filled hex ID', `"zone_id": "${'0'.repeat(32)}"`],
    ['a zero-filled digest', `meta/${'0'.repeat(64)}`],
    ['an example.com address', 'operator@example.com'],
    ['an example.com subdomain address', 'assistant@chat.example.com'],
    ['the placeholder project’s service account', deriveGchatServiceAccountEmail(RESERVED_PROJECT)],
    ['the reserved home', 'unix:///home/operator/.docker/run/docker.sock'],
    ['the unspecified addresses', 'listen 0.0.0.0 and ::'],
    ['versions and dates', '"Google Cloud SDK": "564.0.0", "core": "2026.04.03", "gsutil": "5.36"'],
    ['words that contain a credential prefix', '"doc_url": "https://example.com/proc_stat"'],
  ])('accepts %s', (_case, text) => {
    expect(scanText(text)).toEqual([]);
  });
});
