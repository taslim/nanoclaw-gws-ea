import { normalizeGatewayApprovalSummary } from '../gateway-approval-summary.js';
/** OneCLI typed configuration and supervised native approval adapter. */
import { OneCLI, type ContainerConfig, type ApprovalRequest } from '@onecli-sh/sdk';

import { DATA_DIR } from '../config.js';
import { combinedCaBundle, stageOnecliFile } from './onecli-files.js';
import { createProviderCredentialConnection } from './onecli-credentials.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayApprovalDecision,
  type GatewayApprovalScope,
  type GatewayContribution,
  type GatewayCredentialScope,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

const env = readEnvFile([
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_PROJECT_ID',
  'ONECLI_GATEWAY_CONTAINER',
  'ANTHROPIC_BASE_URL',
  'ONECLI_CONSOLE_URL',
]);
const onecliUrl = process.env.ONECLI_URL || env.ONECLI_URL;
const onecliApiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
const onecliProjectId = process.env.ONECLI_PROJECT_ID || env.ONECLI_PROJECT_ID;
const gatewayContainer = process.env.ONECLI_GATEWAY_CONTAINER || env.ONECLI_GATEWAY_CONTAINER || 'onecli';
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey });
const healthUrl = new URL('/v1/health', onecliUrl || 'https://api.onecli.sh').toString();
const liveLeases = new Set<{ unavailable?: string; notify?: (reason: string) => void }>();
let healthTimer: NodeJS.Timeout | null = null;
let probing = false;

type OneCLIContribution = Omit<GatewayContribution, 'networkAccess'>;
type GatewayMount = NonNullable<GatewayContribution['mounts']>[number];

/** Stage immutable per-content files; SDK temporary basenames are shared across agents. */
export function contributionFromConfig(
  config: ContainerConfig,
  groupScope: string,
  dataDir = DATA_DIR,
): OneCLIContribution {
  const env = { ...config.env };
  const mounts: GatewayMount[] = [];
  const mount = (kind: 'ca' | 'combined' | 'stub', content: string, containerPath: string) => {
    mounts.push({
      class: 'allowlisted-extra',
      hostPath: stageOnecliFile(dataDir, kind, content),
      containerPath,
      mode: 'ro',
      groupScope,
    });
  };
  mount('ca', config.caCertificate, config.caCertificateContainerPath);
  const combined = combinedCaBundle(config.caCertificate);
  if (combined) {
    const target = '/tmp/onecli-combined-ca.pem';
    mount('combined', combined, target);
    env.SSL_CERT_FILE = target;
    env.DENO_CERT = target;
  }
  for (const stub of config.credentialStubs ?? []) mount('stub', stub.content, stub.containerPath);
  return { env, mounts };
}

export function withProviderEnv(contribution: OneCLIContribution, baseUrl = anthropicBaseUrl): OneCLIContribution {
  if (!baseUrl) return contribution;
  return {
    ...contribution,
    env: { ...contribution.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
  };
}

function stopHealthMonitor(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

async function probeHealth(): Promise<void> {
  if (probing || liveLeases.size === 0) return;
  probing = true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (err) {
    const reason = 'OneCLI gateway unavailable';
    log.error(reason, { err });
    stopHealthMonitor();
    for (const lease of liveLeases) {
      lease.unavailable = reason;
      lease.notify?.(reason);
    }
  } finally {
    probing = false;
  }
}

function monitorLease(signal: AbortSignal): Pick<GatewaySessionLease, 'onUnavailable'> {
  const lease: { unavailable?: string; notify?: (reason: string) => void } = {};
  liveLeases.add(lease);
  if (!healthTimer) {
    healthTimer = setInterval(() => void probeHealth(), 5_000);
    healthTimer.unref();
  }
  const close = () => {
    liveLeases.delete(lease);
    if (liveLeases.size === 0) stopHealthMonitor();
  };
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return {
    onUnavailable(report) {
      lease.notify = report;
      if (lease.unavailable) report(lease.unavailable);
    },
  };
}

/** This installation's credentials for OneCLI's app and gateway APIs. */
function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${onecliApiKey || ''}`,
    ...(onecliProjectId ? { 'X-Project-Id': onecliProjectId } : {}),
  };
}

/**
 * One call to OneCLI's management API. A failure is named by route and status
 * alone: OneCLI responses can preview secrets, and a parse error quotes them.
 */
async function management(method: 'GET' | 'PUT' | 'PATCH', route: string, body?: unknown): Promise<unknown> {
  if (!onecliUrl) throw new Error('OneCLI credential scope cannot be applied: ONECLI_URL is not configured');
  const response = await fetch(`${onecliUrl.replace(/\/+$/, '')}${route}`, {
    method,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  }).catch(() => undefined);
  if (!response) throw new Error(`OneCLI ${method} ${route} did not answer`);
  if (!response.ok) throw new Error(`OneCLI ${method} ${route} failed (${response.status})`);
  if (method !== 'GET') return undefined;
  const read = await response.json().then(
    (value: unknown) => ({ value }),
    () => undefined,
  );
  if (!read) throw new Error(`OneCLI ${method} ${route} returned unreadable data`);
  return read.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The one OneCLI agent that is `agentGroupId`, with its secret mode. */
async function agentFor(agentGroupId: string): Promise<{ id: string; secretMode: string }> {
  const agents = await management('GET', '/v1/agents');
  if (!Array.isArray(agents) || !agents.every(isRecord)) throw new Error('OneCLI returned an unreadable agent list');
  const matches = agents.filter((agent) => agent.identifier === agentGroupId);
  if (matches.length === 0) throw new Error(`OneCLI has no agent for ${agentGroupId}`);
  if (matches.length > 1) throw new Error(`${matches.length} agents claim ${agentGroupId} in OneCLI`);
  const [agent] = matches;
  if (typeof agent!.id !== 'string' || !agent!.id || typeof agent!.secretMode !== 'string') {
    throw new Error(`OneCLI returned an unreadable agent for ${agentGroupId}`);
  }
  return { id: agent!.id, secretMode: agent!.secretMode };
}

async function assignedSecrets(agentId: string): Promise<Set<string>> {
  const ids = await management('GET', `/v1/agents/${encodeURIComponent(agentId)}/secrets`);
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) {
    throw new Error('OneCLI returned an unreadable secret assignment');
  }
  return new Set(ids);
}

/** Whether a host pattern lies within one of the model provider's domains (a domain covers its subdomains). */
function withinModelDomains(hostPattern: string, domains: readonly string[]): boolean {
  const host = hostPattern.startsWith('*.') ? hostPattern.slice(2) : hostPattern;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Drop the gateway's cached connect decisions for this project. The gateway
 * caches each agent's resolved injections per host for up to a minute, and
 * OneCLI's agent routes do not flush that cache, so without this a narrowed
 * identity could keep its wider access until the entries expire.
 */
async function flushGatewayDecisions(signal: AbortSignal): Promise<void> {
  const headers = authHeaders();
  const gatewayUrl = await resolveGatewayUrl(headers, signal);
  const response = await fetch(`${gatewayUrl}/v1/cache/invalidate`, {
    method: 'POST',
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    redirect: 'error',
  }).catch(() => undefined);
  if (!response?.ok) {
    throw new Error(
      `OneCLI's gateway did not flush its cached credential decisions${response ? ` (${response.status})` : ''}`,
    );
  }
}

/**
 * Restrict the agent to its scope before it runs. An `only` scope puts the
 * agent in selective mode with exactly the named secrets and the model
 * provider's, correcting an identity OneCLI (re)created in its default mode,
 * verifies the result, and flushes the gateway's cached decisions; anything
 * it cannot do fails the spawn. An `all` scope leaves the agent's mode to
 * OneCLI's own policy.
 */
async function applyCredentialScope(
  agentGroupId: string,
  scope: GatewayCredentialScope,
  signal: AbortSignal,
): Promise<void> {
  if (scope.kind === 'all') return;
  const [agent, vault] = await Promise.all([agentFor(agentGroupId), management('GET', '/v1/secrets')]);
  if (!Array.isArray(vault) || !vault.every(isRecord)) throw new Error('OneCLI returned unreadable secret metadata');
  const wanted = new Set<string>();
  for (const name of scope.credentials) {
    const named = vault.filter((secret) => secret.name === name);
    if (named.length > 1) throw new Error(`OneCLI holds ${named.length} secrets named ${name}; refusing to choose`);
    if (typeof named[0]?.id === 'string') wanted.add(named[0].id);
    else log.warn('A credential in the agent group scope is not in OneCLI', { agentGroupId, credential: name });
  }
  for (const secret of vault) {
    if (
      typeof secret.id === 'string' &&
      typeof secret.hostPattern === 'string' &&
      withinModelDomains(secret.hostPattern, scope.modelDomains)
    ) {
      wanted.add(secret.id);
    }
  }
  const same = (held: ReadonlySet<string>) => held.size === wanted.size && [...wanted].every((id) => held.has(id));
  const route = `/v1/agents/${encodeURIComponent(agent.id)}`;
  if (!same(await assignedSecrets(agent.id))) await management('PUT', `${route}/secrets`, { secretIds: [...wanted] });
  if (agent.secretMode !== 'selective') await management('PATCH', `${route}/secret-mode`, { mode: 'selective' });
  const verified = await agentFor(agentGroupId);
  if (verified.id !== agent.id || verified.secretMode !== 'selective' || !same(await assignedSecrets(agent.id))) {
    throw new Error(`OneCLI credential scope for ${agentGroupId} did not take`);
  }
  await flushGatewayDecisions(signal);
  log.info('OneCLI credential scope applied', { agentGroupId, credentials: scope.credentials, secrets: wanted.size });
}

async function ensureSession(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> {
  // The OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  if (input.disposition !== 'adopt') {
    await onecli.ensureAgent({ name: input.groupName, identifier: input.key.agentGroupId });
  }
  // Every spawn and adoption, before the agent can run: OneCLI may have
  // recreated the identity in its default mode since the last one.
  await applyCredentialScope(input.key.agentGroupId, input.credentialScope, signal);
  const config = await onecli.getContainerConfig({ agent: input.key.agentGroupId });
  log.info('OneCLI gateway applied', { agentGroupId: input.key.agentGroupId, sessionId: input.key.sessionId });
  return {
    ...monitorLease(signal),
    contribution: {
      ...withProviderEnv(contributionFromConfig(config, input.key.agentGroupId)),
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: gatewayContainer },
      },
    },
  };
}

async function subscribeApprovals(
  decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>,
  signal: AbortSignal,
  _resolved?: (requestId: string) => Promise<void>,
  scope?: GatewayApprovalScope,
): Promise<void> {
  if (!scope) throw new Error('OneCLI approval subscription requires installation ownership scope');
  const subscribedAt = Date.now();
  if (signal.aborted) return;
  const headers = authHeaders();
  const gatewayUrl = await resolveGatewayUrl(headers, signal);
  const inFlight = new Set<string>();
  try {
    while (!signal.aborted) {
      const url = new URL(`${gatewayUrl}/v1/approvals/pending`);
      if (inFlight.size) url.searchParams.set('exclude', [...inFlight].join(','));
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      });
      if (!response.ok) throw new Error(`OneCLI approval poll failed (${response.status})`);
      const payload: unknown = await response.json();
      if (!isApprovalPoll(payload)) throw new Error('OneCLI approval poll returned invalid data');
      for (const request of payload.requests) {
        if (inFlight.has(request.id)) continue;
        inFlight.add(request.id);
        void (async () => {
          try {
            // A shared poll includes other installations. Never decide their requests.
            if (!(await scope.ownsAgentGroup(request.agent.externalId ?? ''))) return;
            let decision: 'approve' | 'deny';
            if (signal.aborted || Date.parse(request.createdAt) < subscribedAt) {
              decision = 'deny';
            } else {
              try {
                const outcome = await decide(toGatewayApprovalRequest(request));
                if (outcome === 'unavailable') return;
                decision = outcome;
              } catch (err) {
                log.error('OneCLI approval translation failed closed', { requestId: request.id, err });
                decision = 'deny';
              }
            }
            if (signal.aborted) return;
            const decisionUrl = new URL(`${gatewayUrl}/v1/approvals/${encodeURIComponent(request.id)}/decision`);
            const submitted = await fetch(decisionUrl, {
              method: 'POST',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ decision }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
            });
            if (!submitted.ok && submitted.status !== 410) {
              throw new Error(`OneCLI approval decision failed (${submitted.status})`);
            }
          } catch (err) {
            if (!signal.aborted)
              log.error('OneCLI approval request failed and remains pending', { requestId: request.id, err });
          } finally {
            inFlight.delete(request.id);
          }
        })();
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

async function resolveGatewayUrl(headers: Record<string, string>, signal: AbortSignal): Promise<string> {
  const configured = process.env.ONECLI_GATEWAY_URL;
  if (configured) return validatedGatewayUrl(configured);
  const response = await fetch(
    new URL(`${(onecliUrl || 'https://api.onecli.sh').replace(/\/+$/, '')}/v1/gateway-url`),
    {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: 'error',
    },
  );
  if (!response.ok) throw new Error(`Failed to resolve gateway URL (${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('url' in body) || typeof body.url !== 'string') {
    throw new Error('OneCLI returned an invalid gateway URL');
  }
  return validatedGatewayUrl(body.url);
}

function validatedGatewayUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OneCLI returned an invalid gateway URL');
  }
  return url.toString().replace(/\/+$/, '');
}

function isApprovalPoll(value: unknown): value is { requests: ApprovalRequest[] } {
  return (
    !!value &&
    typeof value === 'object' &&
    'requests' in value &&
    Array.isArray(value.requests) &&
    value.requests.every((request: unknown) => {
      if (!request || typeof request !== 'object') return false;
      const fields = request as Record<string, unknown>;
      const agent = fields.agent;
      return (
        typeof fields.id === 'string' &&
        typeof fields.createdAt === 'string' &&
        typeof fields.method === 'string' &&
        typeof fields.host === 'string' &&
        typeof fields.path === 'string' &&
        !!agent &&
        typeof agent === 'object' &&
        'name' in agent &&
        typeof agent.name === 'string' &&
        'externalId' in agent &&
        (agent.externalId === null || typeof agent.externalId === 'string')
      );
    })
  );
}

function toGatewayApprovalRequest(request: ApprovalRequest): GatewayApprovalRequest {
  const path = request.path.split(/[?#]/, 1)[0];
  return {
    id: request.id,
    trigger: 'policy',
    destination: { host: request.host, method: request.method },
    agentGroupId: request.agent.externalId ?? '',
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    summary: normalizeGatewayApprovalSummary(
      { agent: request.agent.name, method: request.method, host: request.host, path },
      (request as ApprovalRequest & { summary?: ApprovalSummary }).summary,
    ),
    title: 'Credentials Request',
    question: buildQuestion(request, request.agent.name),
    audit: { method: request.method, host: request.host, path },
  };
}

interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

function safeApprovalText(value: string): string {
  return value.replace(/[<>&`*_~[\]()]/g, '_').replace(/[\0\r]/g, '');
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* \`${safeApprovalText(agentName)}\``];
  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* \`${safeApprovalText(summary.action)}\``);
    let budget = 2_200;
    for (const { label, value } of summary.details) {
      if (budget <= 0) break;
      const raw = safeApprovalText(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
      const shown = raw.slice(0, Math.min(900, budget));
      const safeLabel = safeApprovalText(String(label));
      lines.push(shown.includes('\n') ? `*${safeLabel}:*\n\`\`\`\n${shown}\n\`\`\`` : `*${safeLabel}:* \`${shown}\``);
      budget -= shown.length + String(label).length + 8;
    }
  } else {
    lines.push(`\`${safeApprovalText(`${request.method} ${request.host}${request.path.split(/[?#]/, 1)[0]}`)}\``);
  }
  return lines.join('\n').slice(0, 2_600);
}

registerGatewayProvider({
  kind: 'onecli',
  connections: {
    async connect() {
      const consoleUrl = process.env.ONECLI_CONSOLE_URL || env.ONECLI_CONSOLE_URL;
      return consoleUrl
        ? {
            status: 'action_required' as const,
            action: 'operator_console' as const,
            connect_url: consoleUrl,
            message:
              'Connect the account in OneCLI and grant access to the agent, then retry the original request. A native connect_url returned by the gateway can be used directly.',
          }
        : {
            status: 'unsupported' as const,
            message:
              'Use the native connect_url returned by OneCLI, or ask the operator to set ONECLI_CONSOLE_URL for a console handoff. Do not guess a dashboard URL from an API URL.',
          };
    },
  },
  credentials: {
    connection: (target) =>
      createProviderCredentialConnection(target, { url: onecliUrl, apiKey: onecliApiKey, projectId: onecliProjectId }),
  },
  agentSkills: ['onecli-gateway'],
  sessions: { ensure: ensureSession, enforcesCredentialScope: true },
  approvals: { legacyActions: ['onecli_credential'], subscribe: subscribeApprovals },
});
