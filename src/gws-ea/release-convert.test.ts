import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveControlPlanePaths } from './paths.js';
import { assertConverted, legacyInstanceRoot } from './release-convert.js';
import type { InstanceReservation } from './types.js';

const paths = resolveControlPlanePaths({ configRoot: '/machine/config/gws-ea', stateRoot: '/machine/state/gws-ea' });

function reservation(legacyCheckout?: string): InstanceReservation {
  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 36_001, onecli_app: 36_002, onecli_gateway: 36_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://convert.example.test/webhook/gchat' },
      gcp_project_id: 'convert-project',
      gcp_account: 'operator@example.test',
      gchat_service_account: 'gws-ea-chat@convert-project.iam.gserviceaccount.com',
      workspace_email: 'convert@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
    ...(legacyCheckout === undefined ? {} : { checkout_realpath: legacyCheckout }),
  };
}

describe('the legacy-root locator', () => {
  it('finds instances/<id> only for an entry that still records its checkout', () => {
    const unconverted = reservation('/machine/state/gws-ea/instances/old/nanoclaw');
    const converted = reservation();

    expect(legacyInstanceRoot(paths, unconverted)).toBe(
      path.join(paths.stateRoot, 'instances', unconverted.instance_id),
    );
    expect(legacyInstanceRoot(paths, converted)).toBeUndefined();
    expect(paths.instanceRoot(converted.instance_id)).toBe(
      path.join(paths.stateRoot, converted.instance_id.slice(0, 8)),
    );
  });

  it('refuses an unconverted assistant with the update that converts it, and passes a converted one', () => {
    const unconverted = reservation('/machine/state/gws-ea/instances/old/nanoclaw');
    const id = unconverted.instance_id;

    expect(() => assertConverted(paths, unconverted)).toThrow(
      expect.objectContaining({
        code: 'legacy_layout',
        message: `Assistant ${id} is on the legacy layout: run gws-ea update --id ${id} to convert it.`,
      }),
    );
    expect(() => assertConverted(paths, reservation())).not.toThrow();
  });
});
