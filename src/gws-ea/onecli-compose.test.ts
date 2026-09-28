import { parse as parseYaml } from 'yaml';

import { describe, expect, it } from 'vitest';

import { createOnecliRuntimeLayout, ONECLI_WAIT_TIMEOUT_SECONDS, renderOnecliCompose } from './onecli-compose.js';
import { ONECLI_GATEWAY_VERSION } from './pins.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
/** The pins the instance's release recorded; a later launcher's own pins never apply to it. */
const PINS = { gateway: '1.41.3', cli: '2.2.4' } as const;
/** The content-addressed wrapper gateway image the launcher builds and passes in. */
const WRAPPER_IMAGE = 'gws-ea-onecli-gateway:0123456789abcdef';

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

    const source = renderOnecliCompose(layout, PINS, WRAPPER_IMAGE);
    const compose = record(parseYaml(source));
    const services = record(compose.services);
    const postgres = record(services.postgres);
    const app = record(services.app);
    const gateway = record(services.gateway);

    expect(Object.keys(services).sort()).toEqual(['app', 'gateway', 'postgres']);
    expect(PINS.gateway).not.toBe(ONECLI_GATEWAY_VERSION);
    expect(app.image).toBe(`ghcr.io/onecli/onecli:${PINS.gateway}`);
    expect(gateway.image).toBe(WRAPPER_IMAGE);
    expect(postgres.image).toBe('postgres:18-alpine');
    expect(source).not.toContain('container_name');

    // The gateway runs the wrapper image, which installs the egress firewall
    // (needs NET_ADMIN) via its ENTRYPOINT and drops the capability before the
    // gateway starts, so the service carries no command of its own.
    expect(gateway.cap_add).toEqual(['NET_ADMIN']);
    expect(gateway.command).toBeUndefined();
    expect(app.cap_add).toBeUndefined();

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
    const source = renderOnecliCompose(layout, PINS, WRAPPER_IMAGE);
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
    const services = record(record(parseYaml(renderOnecliCompose(layout, PINS, WRAPPER_IMAGE))).services);
    const budget = Object.values(services).reduce<number>((total, service) => {
      const check = record(record(service).healthcheck);
      const seconds = (value: unknown) => Number(String(value).replace(/s$/u, ''));
      return total + Number(check.retries) * (seconds(check.interval) + seconds(check.timeout));
    }, 0);

    expect(ONECLI_WAIT_TIMEOUT_SECONDS).toBe(budget);
  });

  it('gives two instances separate Compose resources and loopback bindings', () => {
    const first = createOnecliRuntimeLayout({
      instanceId: INSTANCE_ID,
      instanceRoot: '/private/instances/first',
      project: 'gws-ea-12345678123441238123123456789abc',
      appPort: 31_002,
      gatewayPort: 31_003,
      cliExecutable: '/opt/onecli/bin/onecli',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const second = createOnecliRuntimeLayout({
      instanceId: 'fedcba98-7654-4321-8765-fedcba987654',
      instanceRoot: '/private/instances/second',
      project: 'gws-ea-fedcba98765443218765fedcba987654',
      appPort: 32_002,
      gatewayPort: 32_003,
      cliExecutable: '/opt/onecli/bin/onecli',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });

    for (const key of [
      'project',
      'rootDirectory',
      'composeFile',
      'cliHome',
      'secretsDirectory',
      'postgresPasswordFile',
      'encryptionKeyFile',
      'gatewayInternalSecretFile',
      'backendNetwork',
      'agentEgressNetwork',
      'postgresVolume',
      'appVolume',
      'appUrl',
      'gatewayUrl',
    ] as const) {
      expect(second[key], key).not.toBe(first[key]);
    }
    const firstCompose = record(parseYaml(renderOnecliCompose(first, PINS, WRAPPER_IMAGE)));
    const secondCompose = record(parseYaml(renderOnecliCompose(second, PINS, WRAPPER_IMAGE)));
    expect(record(record(firstCompose.services).app).ports).toEqual(['127.0.0.1:31002:10254']);
    expect(record(record(secondCompose.services).app).ports).toEqual(['127.0.0.1:32002:10254']);
    expect(record(record(firstCompose.services).gateway).ports).toEqual(['127.0.0.1:31003:10255']);
    expect(record(record(secondCompose.services).gateway).ports).toEqual(['127.0.0.1:32003:10255']);
  });
});
