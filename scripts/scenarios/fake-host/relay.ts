/* eslint-disable no-catch-all/no-catch-all -- inference transport/parsing failures stay in raw evidence and never expose request headers */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** Records synthetic inference bodies and raw response events, never credentials. */
export async function startRequestRecorder(
  directory: string,
  scriptedEndpoint?: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const upstreamRoot = scriptedEndpoint ? new URL(scriptedEndpoint) : new URL('https://api.anthropic.com');
  if (
    scriptedEndpoint &&
    (upstreamRoot.protocol !== 'http:' ||
      upstreamRoot.hostname !== '127.0.0.1' ||
      !upstreamRoot.port ||
      upstreamRoot.pathname !== '/' ||
      upstreamRoot.username ||
      upstreamRoot.password ||
      upstreamRoot.search ||
      upstreamRoot.hash)
  )
    throw new Error('A scripted scenario API must be an exact loopback HTTP origin.');
  fs.mkdirSync(directory, { recursive: true });
  let sequence = 0;
  const handle = async (incoming: http.IncomingMessage, outgoing: http.ServerResponse): Promise<void> => {
    const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname;
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
      outgoing.writeHead(403).end('Scenario recorder permits only Anthropic inference endpoints.');
      return;
    }
    const request = ++sequence;
    const prefix = path.join(directory, String(request).padStart(3, '0'));
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    fs.writeFileSync(`${prefix}.request.json`, body);
    fs.writeFileSync(
      `${prefix}.meta.json`,
      JSON.stringify({ pathname, method: incoming.method, startedAt: new Date().toISOString() }),
    );
    // Header values exist only in memory for forwarding. Neither the saved request
    // nor diagnostics includes Authorization, API keys, cookies or account headers.
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (['host', 'connection', 'content-length', 'accept-encoding'].includes(name) || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('accept-encoding', 'identity');
    const controller = new AbortController();
    outgoing.on('close', () => {
      if (!outgoing.writableEnded) controller.abort();
    });
    try {
      const upstream = await fetch(`${upstreamRoot.origin}${incoming.url}`, {
        method: incoming.method,
        headers,
        body,
        signal: controller.signal,
        ...(scriptedEndpoint ? { redirect: 'error' as const } : {}),
      });
      outgoing.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      });
      const capture = fs.createWriteStream(`${prefix}.response.txt`);
      if (upstream.body)
        for await (const bytes of upstream.body) {
          capture.write(bytes);
          outgoing.write(bytes);
        }
      capture.end();
      outgoing.end();
      fs.writeFileSync(
        `${prefix}.status.json`,
        JSON.stringify({ status: upstream.status, completedAt: new Date().toISOString() }),
      );
    } catch (error) {
      fs.writeFileSync(
        `${prefix}.status.json`,
        JSON.stringify({
          status: 'transport-error',
          error: error instanceof Error ? error.name : 'UnknownError',
          completedAt: new Date().toISOString(),
        }),
      );
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('Inference recorder transport failed.');
    }
  };
  const server = http.createServer((incoming, outgoing) => {
    void handle(incoming, outgoing).catch((_error: unknown) => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('Inference recorder transport failed');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Recorder did not bind loopback.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function rawUsage(directory: string): readonly unknown[] {
  const usages: unknown[] = [];
  for (const name of fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith('.response.txt'))
    .sort()) {
    const raw = fs.readFileSync(path.join(directory, name), 'utf8');
    if (!raw.startsWith('event:')) {
      try {
        const response = JSON.parse(raw) as { usage?: unknown };
        if (response.usage) usages.push({ file: name, usage: response.usage });
      } catch {
        /* a transport error is retained, never a pass */
      }
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as { type?: string; usage?: unknown; message?: { usage?: unknown } };
        const usage = event.usage ?? event.message?.usage;
        if (usage) usages.push({ file: name, event: event.type, usage });
      } catch {
        /* incomplete raw data remains visible in the evidence */
      }
    }
  }
  return usages;
}
