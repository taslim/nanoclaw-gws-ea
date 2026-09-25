import path from 'node:path';

import { stringify } from 'yaml';

import { assertInstanceId } from './registry.js';
import { requireDockerEndpoint } from './validation.js';

export const ONECLI_INSTANCE_LABEL = 'dev.gws-ea.instance-id' as const;
export const ONECLI_RESOURCE_ROLE_LABEL = 'dev.gws-ea.onecli-role' as const;

/**
 * The OneCLI versions an instance's release pinned, as its release-preflight
 * receipt records them. An instance runs these, never the launcher's own, so
 * a launcher upgrade never upgrades a running assistant.
 */
export interface OnecliPins {
  readonly gateway: string;
  readonly cli: string;
}

export function onecliGatewayImage(pins: Pick<OnecliPins, 'gateway'>): string {
  return `ghcr.io/onecli/onecli:${pins.gateway}`;
}

export const ONECLI_POSTGRES_IMAGE = 'postgres:18-alpine';

/** Each service's healthcheck, in seconds; Compose starts them in this dependency order. */
const HEALTH_BUDGETS = {
  postgres: { interval: 2, timeout: 3, retries: 30 },
  app: { interval: 2, timeout: 3, retries: 60 },
  gateway: { interval: 2, timeout: 3, retries: 60 },
} as const;

/**
 * How long `up --wait` may wait: every service, started after the one it
 * depends on is healthy, may use its whole budget of failed checks, each an
 * interval plus a timed-out probe.
 */
export const ONECLI_WAIT_TIMEOUT_SECONDS = Object.values(HEALTH_BUDGETS).reduce(
  (total, budget) => total + budget.retries * (budget.interval + budget.timeout),
  0,
);

function healthcheck(service: keyof typeof HEALTH_BUDGETS, test: string) {
  const budget = HEALTH_BUDGETS[service];
  return {
    test: ['CMD-SHELL', test],
    interval: `${budget.interval}s`,
    timeout: `${budget.timeout}s`,
    retries: budget.retries,
  };
}

export interface OnecliRuntimeLayout {
  readonly instanceId: string;
  readonly project: string;
  readonly rootDirectory: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly cliHome: string;
  readonly secretsDirectory: string;
  readonly postgresPasswordFile: string;
  readonly encryptionKeyFile: string;
  readonly gatewayInternalSecretFile: string;
  readonly providerStagingFile: string;
  readonly backendNetwork: string;
  readonly agentEgressNetwork: string;
  readonly postgresVolume: string;
  readonly appVolume: string;
  readonly appPort: number;
  readonly gatewayPort: number;
  readonly appUrl: string;
  readonly gatewayUrl: string;
  readonly cliExecutable: string;
  /** The local Docker endpoint recorded for this instance (KTD3), given to every Docker command. */
  readonly dockerEndpoint: string;
}

export interface OnecliRuntimeLayoutInput {
  readonly instanceId: string;
  readonly instanceRoot: string;
  readonly project: string;
  readonly appPort: number;
  readonly gatewayPort: number;
  readonly cliExecutable: string;
  readonly dockerEndpoint: string;
}

export function createOnecliRuntimeLayout(input: OnecliRuntimeLayoutInput): OnecliRuntimeLayout {
  assertInstanceId(input.instanceId);
  assertPort(input.appPort, 'appPort');
  assertPort(input.gatewayPort, 'gatewayPort');
  if (input.appPort === input.gatewayPort) {
    throw new Error('OneCLI app and gateway ports must be different');
  }

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(input.project)) {
    throw new Error('OneCLI Compose project is invalid');
  }
  if (!path.isAbsolute(input.cliExecutable) || path.resolve(input.cliExecutable) !== input.cliExecutable) {
    throw new Error('OneCLI CLI path must be absolute and normalized');
  }
  const rootDirectory = path.resolve(input.instanceRoot, 'onecli');
  const project = input.project;
  const secretsDirectory = path.join(rootDirectory, 'secrets');
  return {
    instanceId: input.instanceId,
    project,
    rootDirectory,
    composeFile: path.join(rootDirectory, 'compose.yaml'),
    envFile: path.join(rootDirectory, 'compose.env'),
    cliHome: path.join(rootDirectory, 'cli-home'),
    secretsDirectory,
    postgresPasswordFile: path.join(secretsDirectory, 'postgres-password'),
    encryptionKeyFile: path.join(secretsDirectory, 'encryption-key'),
    gatewayInternalSecretFile: path.join(secretsDirectory, 'gateway-internal-secret'),
    providerStagingFile: path.join(secretsDirectory, 'provider-credential.staging'),
    backendNetwork: `${project}-backend`,
    agentEgressNetwork: `${project}-agent-egress`,
    postgresVolume: `${project}-postgres`,
    appVolume: `${project}-app`,
    appPort: input.appPort,
    gatewayPort: input.gatewayPort,
    appUrl: `http://127.0.0.1:${input.appPort}`,
    gatewayUrl: `http://127.0.0.1:${input.gatewayPort}`,
    cliExecutable: input.cliExecutable,
    dockerEndpoint: requireDockerEndpoint(input.dockerEndpoint, 'Docker endpoint', 'invalid_runtime_config'),
  };
}

export function renderOnecliCompose(layout: OnecliRuntimeLayout, pins: Pick<OnecliPins, 'gateway'>): string {
  const labels = {
    [ONECLI_INSTANCE_LABEL]: layout.instanceId,
  };
  const gatewayImage = onecliGatewayImage(pins);
  const databaseUrl = 'postgresql://onecli:$$(cat /run/secrets/postgres_password)@postgres:5432/onecli';
  const sharedSecrets = ['postgres_password', 'secret_encryption_key', 'gateway_internal_secret'];

  return stringify(
    {
      services: {
        postgres: {
          image: ONECLI_POSTGRES_IMAGE,
          restart: 'unless-stopped',
          environment: {
            POSTGRES_DB: 'onecli',
            POSTGRES_USER: 'onecli',
            POSTGRES_PASSWORD_FILE: '/run/secrets/postgres_password',
          },
          secrets: ['postgres_password'],
          volumes: [`${layout.postgresVolume}:/var/lib/postgresql`],
          networks: { backend: null },
          healthcheck: healthcheck('postgres', 'pg_isready -U onecli -d onecli'),
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'postgres',
          },
        },
        app: {
          image: gatewayImage,
          restart: 'unless-stopped',
          command: [
            '/bin/sh',
            '-ceu',
            `export DATABASE_URL="${databaseUrl}" SECRET_ENCRYPTION_KEY="$$(cat /run/secrets/secret_encryption_key)" GATEWAY_INTERNAL_SECRET="$$(cat /run/secrets/gateway_internal_secret)"; PRISMA="node /app/packages/db/node_modules/prisma/build/index.js"; SCHEMA="--schema /app/packages/db/prisma/schema.prisma"; if ! $$PRISMA migrate deploy $$SCHEMA; then $$PRISMA migrate resolve --applied 0_init $$SCHEMA; $$PRISMA migrate deploy $$SCHEMA; fi; printf '{"authMode":"local","oauthConfigured":false}\n' > /app/data/runtime-config.json; exec node apps/web/server.js`,
          ],
          environment: {
            HOSTNAME: '0.0.0.0',
            PORT: '10254',
            NODE_ENV: 'production',
            APP_URL: layout.appUrl,
            GATEWAY_API_URL: layout.gatewayUrl,
            GATEWAY_BASE_URL: 'host.docker.internal:10255',
          },
          secrets: sharedSecrets,
          volumes: [`${layout.appVolume}:/app/data`],
          networks: { backend: null },
          ports: [`127.0.0.1:${layout.appPort}:10254`],
          depends_on: {
            postgres: { condition: 'service_healthy' },
          },
          healthcheck: healthcheck('app', 'wget -q -O /dev/null http://127.0.0.1:10254/api/health'),
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'app',
          },
        },
        gateway: {
          image: gatewayImage,
          restart: 'unless-stopped',
          command: [
            '/bin/sh',
            '-ceu',
            `export DATABASE_URL="${databaseUrl}" SECRET_ENCRYPTION_KEY="$$(cat /run/secrets/secret_encryption_key)" GATEWAY_INTERNAL_SECRET="$$(cat /run/secrets/gateway_internal_secret)"; exec onecli-gateway --port 10255 --data-dir /app/data`,
          ],
          environment: {
            NODE_ENV: 'production',
            APP_URL: 'http://app:10254',
            INTERNAL_API_URL: 'http://app:10254',
          },
          secrets: sharedSecrets,
          volumes: [`${layout.appVolume}:/app/data`],
          networks: {
            backend: null,
            'agent-egress': {
              aliases: ['host.docker.internal'],
            },
          },
          ports: [`127.0.0.1:${layout.gatewayPort}:10255`],
          depends_on: {
            app: { condition: 'service_healthy' },
          },
          healthcheck: healthcheck('gateway', 'wget -q -O /dev/null http://127.0.0.1:10255/healthz'),
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'gateway',
          },
        },
      },
      secrets: {
        postgres_password: { file: layout.postgresPasswordFile },
        secret_encryption_key: { file: layout.encryptionKeyFile },
        gateway_internal_secret: { file: layout.gatewayInternalSecretFile },
      },
      volumes: {
        [layout.postgresVolume]: {
          name: layout.postgresVolume,
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'postgres-data',
          },
        },
        [layout.appVolume]: {
          name: layout.appVolume,
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'app-data',
          },
        },
      },
      networks: {
        backend: {
          name: layout.backendNetwork,
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'backend',
          },
        },
        'agent-egress': {
          name: layout.agentEgressNetwork,
          internal: true,
          labels: {
            ...labels,
            [ONECLI_RESOURCE_ROLE_LABEL]: 'agent-egress',
          },
        },
      },
    },
    { lineWidth: 0, aliasDuplicateObjects: false },
  );
}

function assertPort(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}
