import { artifactExecutableHtml, type ArtifactDocument } from './document.js';

export const ARTIFACT_CONNECTION_POLICY = '(); report-to=gws-ea-artifact-isolation';
export const ARTIFACT_MIN_CHROMIUM = 155;
export interface ArtifactHtmlResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  );
}
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}
function headers(csp: string): Readonly<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-dns-prefetch-control': 'off',
    'permissions-policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()',
  };
}
const LINK_HELPER = `function bindSources(){
function choose(event){const anchor=event.target.closest?.('[data-artifact-source]');if(!anchor)return;if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;event.preventDefault();event.stopImmediatePropagation();parent.postMessage({type:'artifact-source',id:anchor.dataset.artifactSource},'*');}
document.addEventListener('click',choose,true);document.addEventListener('keydown',choose,true);}
bindSources();`;
export function renderArtifactChild(input: {
  readonly document: ArtifactDocument;
  readonly nonce: string;
}): ArtifactHtmlResponse {
  const { document, nonce } = input;
  if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(nonce)) throw new Error('Invalid artifact nonce.');
  const executable = artifactExecutableHtml(document, nonce);
  const bootstrap = `(()=>{'use strict';${LINK_HELPER}
const authored=${scriptJson(executable)};
const major=Number(/(?:Chrome|Chromium)\\/(\\d+)/.exec(navigator.userAgent)?.[1]||0);
if(major<${ARTIFACT_MIN_CHROMIUM}||typeof ReportingObserver!=='function'||typeof RTCPeerConnection!=='function')return;
let settled=false;let observer;let timer;
function finish(verified){if(settled)return;settled=true;clearTimeout(timer);observer?.disconnect();if(!verified)return;
document.open();document.write(authored);document.close();bindSources();document.documentElement.dataset.artifactMode='interactive';}
try{observer=new ReportingObserver(reports=>{for(const report of reports){const body=report.body?.toJSON?.();if(report.type==='connection-allowlist'&&body?.disposition==='enforce'&&body?.connection==='webrtc'&&Array.isArray(body?.allowlist)&&body.allowlist.length===0){finish(true);break;}}},{types:['connection-allowlist'],buffered:false});observer.observe();timer=setTimeout(()=>finish(false),900);const connection=new RTCPeerConnection({iceServers:[]});connection.close();}catch{finish(false);}
})();`;
  const body = document.staticHtml.replace('</body>', `<script nonce="${nonce}">${bootstrap}</script></body>`);
  return {
    body,
    headers: {
      ...headers(
        `default-src 'none'; script-src 'nonce-${nonce}'${document.handlerHashes.length ? ` 'unsafe-hashes' ${document.handlerHashes.join(' ')}` : ''}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`,
      ),
      'connection-allowlist': ARTIFACT_CONNECTION_POLICY,
    },
  };
}
export function renderArtifactViewer(input: {
  readonly document: ArtifactDocument;
  readonly title: string;
  readonly childUrl: string;
  readonly nonce: string;
}): ArtifactHtmlResponse {
  const child = new URL(input.childUrl);
  if (
    child.protocol !== 'https:' ||
    child.username ||
    child.password ||
    child.search ||
    child.hash ||
    !/^[a-zA-Z0-9_-]{16,128}$/u.test(input.nonce)
  )
    throw new Error('Invalid artifact viewer coordinates.');
  const { title, childUrl, nonce, document } = input;
  const links = document.sources
    .map(
      (source) =>
        `<li><a id="${source.id}" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a><small>${escapeHtml(new URL(source.url).hostname)}</small></li>`,
    )
    .join('');
  const bootstrap = `(()=>{'use strict';const frame=document.querySelector('iframe');const ids=new Set(${scriptJson(document.sources.map((source) => source.id))});window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null'||!event.data||Object.keys(event.data).sort().join(',')!=='id,type'||event.data.type!=='artifact-source'||!ids.has(event.data.id))return;const details=document.querySelector('details');details.open=true;document.getElementById(event.data.id).focus();});})();`;
  return {
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>html,body{margin:0;height:100%;font:14px system-ui,sans-serif;color:#253247;background:#fff}body{display:flex;flex-direction:column}header{padding:12px 18px;border-bottom:1px solid #dce2e9}h1{font-size:16px;margin:0 0 4px}p{margin:0;color:#526074;font-size:12px}iframe{width:100%;flex:1;border:0;min-height:0}details{margin-top:8px}summary,a{cursor:pointer}a{color:#164fa3}li{padding:5px}small{display:block;color:#526074}a:focus-visible,summary:focus-visible{outline:3px solid #147aca;outline-offset:3px}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}</style></head><body><header><h1>${escapeHtml(title)}</h1>${links ? `<details><summary>Sources (${document.sources.length})</summary><ol>${links}</ol></details>` : ''}</header><iframe title="${escapeHtml(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${escapeHtml(childUrl)}"></iframe><script nonce="${nonce}">${bootstrap}</script></body></html>`,
    headers: headers(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src ${childUrl}; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ),
  };
}
