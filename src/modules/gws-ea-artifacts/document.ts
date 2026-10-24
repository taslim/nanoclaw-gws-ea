import { createHash } from 'node:crypto';
import { defaultTreeAdapter, html as htmlNamespace, parse, serialize, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export const ARTIFACT_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
export interface ArtifactSourceLink {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}
export interface ArtifactDocument {
  readonly html: string;
  readonly staticHtml: string;
  readonly sources: readonly ArtifactSourceLink[];
  readonly handlerHashes: readonly string[];
  /** Authored script or inline handlers exist. A scripted page never gets direct link navigation. */
  readonly scripted: boolean;
  readonly lang: string;
}
const BLOCKED = new Set([
  'base',
  'form',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
  'fencedframe',
  'link',
  'audio',
  'video',
  'source',
  'track',
  'foreignObject',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'discard',
  'noscript',
]);
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'cite',
  'longdesc',
  'manifest',
]);
const SOURCE_LINK_ATTRIBUTES = new Set(['href', 'target', 'rel', 'data-artifact-source', 'role', 'tabindex']);
const TEL_LINK = /^tel:\+?[0-9][0-9 ().-]{2,30}$/u;
// One address and nothing else: no headers or body that could carry page content into a message.
const MAILTO_LINK = /^mailto:[^\s?#&,;:<>"'@]+@[^\s?#&,;:<>"'@]+\.[a-z]{2,}$/iu;
const LANG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu;
export const ARTIFACT_STATIC_NOTICE = 'The controls on this page work in Chrome on a computer or an Android phone.';
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/iu;
const DATA_CSS = /^data:(?:image\/(?:png|jpeg|gif|webp|avif)|font\/(?:woff2?|ttf|otf));base64,[a-z0-9+/=\s]+$/iu;
function isElement(node: Node): node is Element {
  return 'tagName' in node;
}
function textContent(node: Node): string {
  return 'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
}
function assertCss(css: string): void {
  if (css.includes('\\') || /\/\*(?![\s\S]*?\*\/)/u.test(css))
    throw new Error('CSS escapes and incomplete comments are unsupported.');
  const plain = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  if (/@import|expression\s*\(|-moz-binding|(?<![\w-])behavior\s*:/iu.test(plain))
    throw new Error('External CSS is unsupported.');
  for (const match of plain.matchAll(/url\s*\(\s*([\s\S]*?)\s*\)/giu)) {
    const url = match[1].replace(/^(['"])([\s\S]*)\1$/u, '$2').trim();
    if (!/^#[a-z0-9_.:-]+$/iu.test(url) && !DATA_CSS.test(url))
      throw new Error('CSS assets must be inline data or local SVG references.');
  }
  if (/image-set\s*\(/iu.test(plain)) throw new Error('CSS image-set is unsupported; use inline images.');
}
function walk(node: Node, visit: (element: Element) => void): void {
  if (isElement(node)) visit(node);
  if ('childNodes' in node) for (const child of node.childNodes) walk(child, visit);
  if (isElement(node) && node.tagName === 'template') walk((node as DefaultTreeAdapterMap['template']).content, visit);
}
function removeAttribute(element: Element, name: string): void {
  element.attrs = element.attrs.filter((attribute) => attribute.name !== name);
}
/** Bounded, standards-parsed, self-contained source. This validation is not the runtime network boundary. */
export function parseArtifactDocument(html: string): ArtifactDocument {
  if (Buffer.byteLength(html, 'utf8') > ARTIFACT_DOCUMENT_MAX_BYTES)
    throw new Error('Artifact source exceeds the 4 MiB limit.');
  const document = parse(html, {
    onParseError(error) {
      if (error.code !== 'missing-doctype') throw new Error(`Malformed artifact HTML: ${error.code}.`);
    },
  });
  const sources: ArtifactSourceLink[] = [];
  const sourceAnchors: Array<{ readonly element: Element; readonly url: string }> = [];
  let contactLinks = 0;
  const handlerHashes = new Set<string>();
  let scripted = false;
  walk(document, (element) => {
    if (element.tagName === 'script') scripted = true;
    if (BLOCKED.has(element.tagName)) throw new Error(`Unsupported artifact element: ${element.tagName}.`);
    if (element.tagName === 'meta' && element.attrs.some((attribute) => attribute.name === 'http-equiv'))
      throw new Error('HTTP meta directives are unsupported.');
    if (element.tagName === 'script' && element.attrs.some((attribute) => attribute.name === 'src'))
      throw new Error('Scripts must be inline.');
    if (element.tagName === 'style') assertCss(textContent(element));
    for (const attribute of [...element.attrs]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        scripted = true;
        handlerHashes.add(`'sha256-${createHash('sha256').update(attribute.value).digest('base64')}'`);
      }
      if (name === 'style') assertCss(attribute.value);
      if (['srcset', 'imagesrcset', 'ping', 'download', 'form', 'autofocus', 'is'].includes(name))
        throw new Error(`Unsupported artifact attribute: ${name}.`);
      if (!URL_ATTRIBUTES.has(name)) continue;
      if ((element.tagName === 'a' || element.tagName === 'area') && name === 'href') {
        const value = attribute.value.trim();
        if (value.startsWith('#')) continue;
        if (/^(?:tel|mailto):/iu.test(value)) {
          if (!TEL_LINK.test(value) && !MAILTO_LINK.test(value))
            throw new Error('Phone links take only a number, and email links only one address.');
          contactLinks += 1;
          // In its own frame the viewer's frame policy would replace the page with an error; a new context
          // hands the number or address to the device and leaves the page in place.
          element.attrs = element.attrs.filter(({ name }) => name === 'href' || !SOURCE_LINK_ATTRIBUTES.has(name));
          element.attrs.push({ name: 'target', value: '_blank' }, { name: 'rel', value: 'noopener noreferrer' });
          continue;
        }
        let url: URL;
        try {
          url = new URL(value);
        } catch (error) {
          if (error instanceof TypeError)
            throw new Error('Source links must be absolute HTTPS URLs.', { cause: error });
          throw error;
        }
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('Source links must be canonical HTTPS URLs without credentials.');
        const id = `source-${sources.length + 1}`;
        sources.push({ id, label: textContent(element).trim().slice(0, 180) || url.hostname, url: url.href });
        sourceAnchors.push({ element, url: url.href });
      } else if (name === 'href' && attribute.value.startsWith('#')) {
        continue;
      } else if (name === 'src' && element.tagName === 'img' && DATA_IMAGE.test(attribute.value)) {
        continue;
      } else throw new Error(`Artifact ${name} must not reference a remote resource.`);
    }
  });
  if (handlerHashes.size > 128)
    throw new Error('Use script event listeners instead of more than 128 distinct inline event handlers.');
  if (scripted && contactLinks > 0) throw new Error('Phone and email links need a page without scripts.');
  // A page without authored script keeps ordinary links: nothing on it can follow one without the reader.
  // A scripted page hands each exact parsed source to the trusted viewer for a deliberate second step.
  sourceAnchors.forEach(({ element, url }, index) => {
    element.attrs = element.attrs.filter(({ name }) => !SOURCE_LINK_ATTRIBUTES.has(name));
    element.attrs.push(
      ...(scripted
        ? [
            { name: 'data-artifact-source', value: sources[index].id },
            { name: 'role', value: 'button' },
            { name: 'tabindex', value: '0' },
          ]
        : [
            { name: 'href', value: url },
            { name: 'target', value: '_blank' },
            { name: 'rel', value: 'noopener noreferrer' },
          ]),
    );
  });
  const root = document.childNodes.filter(isElement).find((node) => node.tagName === 'html');
  const declaredLang = root?.attrs.find((attribute) => attribute.name === 'lang')?.value.trim() ?? '';
  const normalized = serialize(document);
  const fallback = parse(normalized);
  function makeStatic(node: Node): void {
    if ('childNodes' in node) {
      node.childNodes = node.childNodes.filter((child) => !(isElement(child) && child.tagName === 'script'));
      for (const child of node.childNodes) makeStatic(child);
    }
    if (isElement(node)) {
      node.attrs = node.attrs.filter(
        (attribute) =>
          !attribute.name.toLowerCase().startsWith('on') && !['nonce', 'contenteditable'].includes(attribute.name),
      );
      // Controls on an unscripted page can only drive CSS, which works everywhere; scripted controls cannot.
      if (scripted && ['input', 'button', 'select', 'textarea'].includes(node.tagName)) {
        removeAttribute(node, 'disabled');
        node.attrs.push({ name: 'disabled', value: '' });
        const style = node.attrs.find((attribute) => attribute.name === 'style');
        const muted = 'opacity:.55!important;cursor:not-allowed!important';
        if (style) style.value += `;${muted}`;
        else node.attrs.push({ name: 'style', value: muted });
      }
      if (node.tagName === 'template') makeStatic((node as DefaultTreeAdapterMap['template']).content);
    }
  }
  makeStatic(fallback);
  walk(fallback, (element) => {
    if (element.tagName !== 'body' || !scripted) return;
    const notice = defaultTreeAdapter.createElement('aside', htmlNamespace.NS.HTML, [
      { name: 'role', value: 'note' },
      { name: 'data-artifact-notice', value: '' },
      {
        name: 'style',
        value:
          'display:block!important;font:14px/1.5 system-ui,sans-serif!important;color:inherit!important;background:rgba(127,127,127,.14)!important;padding:10px 16px!important;margin:0 0 16px!important;border:0!important',
      },
    ]);
    defaultTreeAdapter.insertText(notice, ARTIFACT_STATIC_NOTICE);
    const first = element.childNodes[0];
    if (first) defaultTreeAdapter.insertBefore(element, notice, first);
    else defaultTreeAdapter.appendChild(element, notice);
  });
  return {
    html: normalized,
    staticHtml: serialize(fallback),
    sources,
    handlerHashes: [...handlerHashes],
    scripted,
    lang: LANG.test(declaredLang) ? declaredLang : 'en',
  };
}
/** Add the trusted response nonce through the parser, including scripts nested in templates. */
export function artifactExecutableHtml(document: ArtifactDocument, nonce: string): string {
  const parsed = parse(document.html);
  walk(parsed, (element) => {
    if (element.tagName === 'script') {
      removeAttribute(element, 'nonce');
      element.attrs.push({ name: 'nonce', value: nonce });
    }
  });
  return serialize(parsed);
}
