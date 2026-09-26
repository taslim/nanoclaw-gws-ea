import { parse as parseYaml } from 'yaml';

import { describe, expect, it } from 'vitest';

import { createOnecliRuntimeLayout, ONECLI_WAIT_TIMEOUT_SECONDS, renderOnecliCompose } from './onecli-compose.js';
import { ONECLI_GATEWAY_VERSION } from './pins.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
/** The pins the instance's release recorded; a later launcher's own pins never apply to it. */
const PINS = { gateway: '1.41.3', cli: '2.2.4' } as const;

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe('instance-owned OneCLI Compose specification', () => {
  it('runs the instance’s recorded OneCLI pin, isolates app and database, and publishes only loopback ports', () => {
    const layout = createOnecliRuntimeLayout({
      instanceId: INSTANCE_ID,
      instanceRoot: '/private/instances/test',
      project: 'gws-ea-12345678123441238123123456789abc',
      appPort: 31_002,
      gatewayPort: 31_003,
      cliExecutable: '/opt/onecli/bin/onecli',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });

    const source = renderOnecliCompose(layout, PINS);
    const compose = record(parseYaml(source));
    const services = record(compose.services);
    const postgres = record(services.postgres);
    const app = record(services.app);
    const gateway = record(services.gateway);

    expect(Object.keys(services).sort()).toEqual(['app', 'gateway', 'postgres']);
    expect(PINS.gateway).not.toBe(ONECLI_GATEWAY_VERSION);
    expect(app.image).toBe(`ghcr.io/onecli/onecli:${PINS.gateway}`);
    expect(gateway.image).toBe(`ghcr.io/onecli/onecli:${PINS.gateway}`);
    expect(postgres.image).toBe('postgres:18-alpine');
    expect(source).not.toContain('container_name');

    expect(postgres.ports).toBeUndefined();
    expect(app.ports).toEqual(['127.0.0.1:31002:10254']);
    expect(gateway.ports).toEqual(['127.0.0.1:31003:10255']);
    expect(record(app.networks)).toEqual({ backend: null });
    expect(record(postgres.networks)).toEqual({ backend: null });
    expect(record(gateway.networks)).toEqual({
      backend: null,
      'agent-egress': { aliases: ['host.docker.internal'] },
    });

    const networks = record(compose.networks);
    expect(record(networks['agent-egress'])).toMatchObject({
      name: layout.agentEgressNetwork,
      internal: true,
    });
    expect(record(networks.backend)).toMatchObject({ name: layout.backendNetwork });
    expect(record(networks.backend).internal).not.toBe(true);
  });

  it('contains only secret-file references and no runtime secret material', () => {
    const layout = createOnecliRuntimeLayout({
      instanceId: INSTANCE_ID,
      instanceRoot: '/private/instances/test',
      project: 'gws-ea-12345678123441238123123456789abc',
      appPort: 31_002,
      gatewayPort: 31_003,
      cliExecutable: '/opt/onecli/bin/onecli',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const source = renderOnecliCompose(layout, PINS);
    const compose = record(parseYaml(source));
    const secrets = record(compose.secrets);

    expect(secrets).toEqual({
      postgres_password: { file: layout.postgresPasswordFile },
      secret_encryption_key: { file: layout.encryptionKeyFile },
      gateway_internal_secret: { file: layout.gatewayInternalSecretFile },
    });
    expect(source).not.toMatch(/POSTGRES_PASSWORD:\s*[^/\n]/);
    expect(source).not.toMatch(/SECRET_ENCRYPTION_KEY:\s*[^/\n]/);
    expect(source).toContain('$$(cat /run/secrets/postgres_password)');
  });

  it('sizes the start wait to the health budgets it renders', () => {
    const layout = createOnecliRuntimeLayout({
      instanceId: INSTANCE_ID,
      instanceRoot: '/private/instances/test',
      project: 'gws-ea-12345678123441238123123456789abc',
      appPort: 31_002,
      gatewayPort: 31_003,
      cliExecutable: '/opt/onecli/bin/onecli',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const services = record(record(parseYaml(renderOnecliCompose(layout, PINS))).services);
    const budget = Object.values(services).reduce<number>((total, service) => {
      const check = record(record(service).healthcheck);
      const seconds = (value: unknown) => Number(String(value).replace(/s$/u, ''));
      return total + Number(check.retries) * (seconds(check.interval) + seconds(check.timeout));
    }, 0);

    expect(ONECLI_WAIT_TIMEOUT_SECONDS).toBe(budget);
  });
});
