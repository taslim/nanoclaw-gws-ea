import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseArtifactDocument } from './document.js';
import { renderArtifactChild, renderArtifactViewer } from './viewer.js';

export interface ArtifactViewRoute {
  readonly audience: 'private' | 'share' | 'public';
  readonly id: string;
  readonly viewPath: string;
  readonly expectedSourceHash?: string;
}
export interface AuthorizedArtifactView {
  readonly title: string;
  readonly html: string;
  readonly sourceHash: string;
}
export interface ArtifactViewServerOptions {
  readonly hostname: string;
  /** Must resolve the current selected revision and current audience authority on every request, including HEAD/child. */
  readonly resolve: (request: IncomingMessage, route: ArtifactViewRoute) => Promise<AuthorizedArtifactView | undefined>;
}
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
function parseRoute(url: string): ArtifactViewRoute | undefined {
  if (!url.startsWith('/artifacts/')) return undefined;
  const route = url.slice('/artifacts'.length);
  const match = new RegExp(`^/(?:((?:share|public))/)?(${UUID})(/frame/([a-f0-9]{64}))?$`, 'u').exec(route);
  if (!match) return undefined;
  return {
    audience: match[1] === 'share' ? 'share' : match[1] === 'public' ? 'public' : 'private',
    id: match[2],
    viewPath: `/artifacts/${match[1] ? `${match[1]}/` : ''}${match[2]}`,
    ...(match[4] ? { expectedSourceHash: match[4] } : {}),
  };
}
/** View-only origin. The caller owns listening and supplies real current authorization; there is no permissive default. */
export function createArtifactViewHandler(
  options: ArtifactViewServerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(options.hostname))
    throw new Error('Invalid canonical artifact host.');
  return (request, response) => {
    const finish = (status: number, body = ''): void => {
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const route = request.url ? parseRoute(request.url) : undefined;
    if (!route) {
      finish(404);
      return;
    }
    const serve = async (): Promise<void> => {
      const selected = await options.resolve(request, route);
      if (!selected) {
        finish(404);
        return;
      }
      if (
        !/^[a-f0-9]{64}$/u.test(selected.sourceHash) ||
        createHash('sha256').update(selected.html).digest('hex') !== selected.sourceHash
      ) {
        finish(503);
        return;
      }
      if (route.expectedSourceHash !== undefined && route.expectedSourceHash !== selected.sourceHash) {
        finish(404);
        return;
      }
      const document = parseArtifactDocument(selected.html);
      const nonce = randomBytes(24).toString('base64url');
      const rendered = route.expectedSourceHash
        ? renderArtifactChild({ document, nonce })
        : renderArtifactViewer({
            document,
            nonce,
            title: selected.title,
            childUrl: `https://${options.hostname}${route.viewPath}/frame/${selected.sourceHash}`,
          });
      response.writeHead(200, rendered.headers);
      response.end(request.method === 'HEAD' ? undefined : rendered.body);
    };
    void serve().catch((_error: unknown) => {
      if (!response.headersSent) finish(503);
      else response.destroy();
    });
  };
}
