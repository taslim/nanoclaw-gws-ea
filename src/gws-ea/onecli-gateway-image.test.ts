import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ONECLI_WRAPPER_LABEL,
  computeWrapperImageHash,
  resolveWrapperGatewayImage,
  wrapperImageSourceDir,
  wrapperImageTag,
} from './onecli-gateway-image.js';
import { ONECLI_GATEWAY_VERSION } from './pins.js';

describe('wrapper gateway image identity', () => {
  it('tags with the content hash and a stable label', () => {
    expect(wrapperImageTag('abcdef0123456789')).toBe('gws-ea-onecli-gateway:abcdef0123456789');
    expect(ONECLI_WRAPPER_LABEL).toBe('dev.gws-ea.onecli-wrapper');
    expect(wrapperImageSourceDir().endsWith('/onecli-gateway-image')).toBe(true);
  });

  it('resolves the same hash and tag together', async () => {
    const resolved = await resolveWrapperGatewayImage({ gateway: '1.42.0' });
    const hash = await computeWrapperImageHash({ gateway: '1.42.0' });
    expect(resolved.hash).toBe(hash);
    expect(resolved.image).toBe(wrapperImageTag(hash));
    // A short, hex, deterministic digest of the build context.
    expect(resolved.hash).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('varies the identity when the base pin changes', async () => {
    // The base tag is part of the hashed context, so a rules-only change is not the
    // only thing that rebuilds — a base bump must yield a distinct image too. If the
    // base were dropped from the hash inputs, these would collide and a base change
    // would silently reuse a stale image.
    const a = await computeWrapperImageHash({ gateway: '1.42.0' });
    const b = await computeWrapperImageHash({ gateway: '1.41.0' });
    expect(a).not.toBe(b);
    expect(wrapperImageTag(a)).not.toBe(wrapperImageTag(b));
  });

  it('is stable across repeated computation for the same pin', async () => {
    const a = await computeWrapperImageHash({ gateway: '1.42.0' });
    const b = await computeWrapperImageHash({ gateway: '1.42.0' });
    expect(a).toBe(b);
  });
});

/**
 * The add-onecli pin GWS-EA reviewed on 2026-11-10 and stays behind: NanoClaw
 * moved to 1.45.0 for agent grants, not for a fix GWS-EA's gateway needs (see
 * onecli-gateway-image/README.md). Any later NanoClaw move fails the guard
 * below until GWS-EA follows it or reviews it again.
 */
const REVIEWED_ADD_ONECLI_GATEWAY = '1.45.0';

describe("GWS-EA's gateway pin", () => {
  it("is never older than the add-onecli skill's, unless GWS-EA reviewed that pin and stays behind it", () => {
    const skill = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '../../.claude/skills/add-onecli/versions.json'), 'utf8'),
    ) as Record<string, unknown>;
    const release = (version: unknown): number[] =>
      String(version)
        .split('-')[0]!
        .split('.')
        .map((part) => Number(part));
    const [ours, nanoclaw] = [release(ONECLI_GATEWAY_VERSION), release(skill['onecli-gateway'])];
    const order = ours.map((part, index) => part - nanoclaw[index]!).find((difference) => difference !== 0) ?? 0;

    expect(nanoclaw.every(Number.isSafeInteger), 'add-onecli no longer pins onecli-gateway to one version').toBe(true);
    if (skill['onecli-gateway'] === REVIEWED_ADD_ONECLI_GATEWAY) return;
    expect(
      order,
      `OneCLI ${ONECLI_GATEWAY_VERSION} is older than add-onecli's ${String(skill['onecli-gateway'])}: follow it, or review it and record it as REVIEWED_ADD_ONECLI_GATEWAY with the reason in onecli-gateway-image/README.md`,
    ).toBeGreaterThanOrEqual(0);
  });
});
