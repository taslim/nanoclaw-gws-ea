import { defaultTreeAdapter, html as htmlNamespace, parse, serialize } from 'parse5';
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
/** A page without authored script may open its own ordinary links in a new tab. */
function childSandbox(document: ArtifactDocument): string {
  return document.scripted ? 'allow-scripts' : 'allow-popups allow-popups-to-escape-sandbox';
}
function childPolicy(document: ArtifactDocument, scriptSource: string): string {
  return `default-src 'none'; script-src ${scriptSource}; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox ${childSandbox(document)}`;
}
export function renderArtifactChild(input: {
  readonly document: ArtifactDocument;
  readonly nonce: string;
}): ArtifactHtmlResponse {
  const { document, nonce } = input;
  if (!/^[a-zA-Z0-9_-]{16,128}$/u.test(nonce)) throw new Error('Invalid artifact nonce.');
  // Nothing to verify or swap: the page is complete as served and runs no script at all. Without script it
  // cannot open a connection, and a connection allowlist here would also cut off the tabs its links open.
  if (!document.scripted) return { body: document.staticHtml, headers: headers(childPolicy(document, "'none'")) };
  const executable = artifactExecutableHtml(document, nonce);
  // The static notice stays hidden while a capable browser verifies isolation, so it never flashes there.
  const bootstrap = `(()=>{'use strict';${LINK_HELPER}
const authored=${scriptJson(executable)};
const notice=document.querySelector('[data-artifact-notice]');
const major=Number(/(?:Chrome|Chromium)\\/(\\d+)/.exec(navigator.userAgent)?.[1]||0);
if(major<${ARTIFACT_MIN_CHROMIUM}||typeof ReportingObserver!=='function'||typeof RTCPeerConnection!=='function')return;
notice?.style.setProperty('display','none','important');
let settled=false;let observer;let timer;
function finish(verified){if(settled)return;settled=true;clearTimeout(timer);observer?.disconnect();if(!verified){notice?.style.removeProperty('display');return;}
document.open();document.write(authored);document.close();bindSources();document.documentElement.dataset.artifactMode='interactive';}
try{observer=new ReportingObserver(reports=>{for(const report of reports){const body=report.body?.toJSON?.();if(report.type==='connection-allowlist'&&body?.disposition==='enforce'&&body?.connection==='webrtc'&&Array.isArray(body?.allowlist)&&body.allowlist.length===0){finish(true);break;}}},{types:['connection-allowlist'],buffered:false});observer.observe();timer=setTimeout(()=>finish(false),900);const connection=new RTCPeerConnection({iceServers:[]});connection.close();}catch{finish(false);}
})();`;
  const parsed = parse(document.staticHtml);
  const html = parsed.childNodes.filter(defaultTreeAdapter.isElementNode).find((node) => node.tagName === 'html');
  const body = html?.childNodes.filter(defaultTreeAdapter.isElementNode).find((node) => node.tagName === 'body');
  if (!body) throw new Error('Artifact static document has no body.');
  const script = defaultTreeAdapter.createElement('script', htmlNamespace.NS.HTML, [{ name: 'nonce', value: nonce }]);
  defaultTreeAdapter.insertText(script, bootstrap);
  defaultTreeAdapter.appendChild(body, script);
  const handlers = document.handlerHashes.length ? ` 'unsafe-hashes' ${document.handlerHashes.join(' ')}` : '';
  return {
    body: serialize(parsed),
    headers: {
      ...headers(childPolicy(document, `'nonce-${nonce}'${handlers}`)),
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
  // Only a scripted page routes its links through this list; an unscripted page's links open directly.
  const bootstrap =
    document.scripted && document.sources.length
      ? `<script nonce="${nonce}">(()=>{'use strict';const frame=document.querySelector('iframe');const ids=new Set(${scriptJson(document.sources.map((source) => source.id))});window.addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!=='null'||!event.data||Object.keys(event.data).sort().join(',')!=='id,type'||event.data.type!=='artifact-source'||!ids.has(event.data.id))return;const details=document.querySelector('details');details.open=true;document.getElementById(event.data.id).focus();});})();</script>`
      : '';
  const style = `:root{color-scheme:light dark;--bg:light-dark(#fbfaf8,#161514);--panel:light-dark(#fff,#201f1c);--text:light-dark(#1d1c1a,#edebe7);--muted:light-dark(#57544e,#aaa7a0);--line:light-dark(#e4e1db,#302e2b);--accent:light-dark(#1f5fbf,#80aaff)}html,body{margin:0;height:100%;font:14px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg)}body{display:flex;flex-direction:column}header{position:relative;display:flex;align-items:center;gap:12px;min-height:44px;box-sizing:border-box;padding:6px 16px;border-bottom:1px solid var(--line)}h1{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}summary{list-style:none;cursor:pointer;padding:4px 12px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:13px;white-space:nowrap}summary::-webkit-details-marker{display:none}details[open]>summary{color:var(--text);border-color:var(--muted)}ol{position:absolute;z-index:1;top:100%;left:0;right:0;margin:0;padding:8px 16px 12px 36px;max-height:60vh;overflow:auto;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:0 12px 24px rgb(0 0 0/.12)}li{padding:6px 0}a{color:var(--accent);text-underline-offset:.18em}small{display:block;color:var(--muted)}iframe{flex:1;width:100%;min-height:0;border:0;background:var(--bg)}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;
  return {
    body: `<!doctype html><html lang="${escapeHtml(document.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body><header><h1>${escapeHtml(title)}</h1>${links ? `<details><summary>Sources (${document.sources.length})</summary><ol>${links}</ol></details>` : ''}</header><iframe title="${escapeHtml(title)}" sandbox="${childSandbox(document)}" referrerpolicy="no-referrer" src="${escapeHtml(childUrl)}"></iframe>${bootstrap}</body></html>`,
    headers: headers(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src ${childUrl}; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    ),
  };
}
