import { describe, expect, it } from 'vitest';

import {
  ONECLI_WRAPPER_LABEL,
  computeWrapperImageHash,
  resolveWrapperGatewayImage,
  wrapperImageSourceDir,
  wrapperImageTag,
} from './onecli-gateway-image.js';

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
