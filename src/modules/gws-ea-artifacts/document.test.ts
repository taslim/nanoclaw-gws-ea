import { describe, expect, it } from 'vitest';
import { parseArtifactDocument } from './document.js';

describe('artifact document policy', () => {
  it('keeps information while removing every static executable surface and suppressing controls', () => {
    const document = parseArtifactDocument(
      '<!doctype html><html><head><style>body{color:#123}</style></head><body><h1>Forecast</h1><p>Base case: $42</p><button onclick="this.textContent=42">Calculate</button><script>document.title="executed"</script><svg><text>42</text></svg></body></html>',
    );
    expect(document.staticHtml).toContain('Base case: $42');
    expect(document.staticHtml).toContain('<text>42</text>');
    expect(document.staticHtml).toContain('disabled=""');
    expect(document.staticHtml).toContain('Interactive controls are unavailable');
    expect(document.staticHtml).not.toContain('<script');
    expect(document.staticHtml).not.toContain('onclick');
    expect(document.html).toContain('onclick');
  });
  it('keeps an entirely static document readable without claiming interactions are unavailable', () => {
    const document = parseArtifactDocument(
      '<!doctype html><h1>Decision brief</h1><p>Choose the local option.</p><details><summary>Evidence</summary><p>Nearby facts</p></details>',
    );
    expect(document.staticHtml).toContain('<details>');
    expect(document.staticHtml).toContain('Nearby facts');
    expect(document.staticHtml).not.toContain('Interactive controls are unavailable');
  });
  it('extracts exact HTTPS sources, leaves fragments local, and never puts external hrefs in the child', () => {
    const document = parseArtifactDocument(
      '<!doctype html><a href="https://example.com/p?a=1&amp;b=2">Evidence</a><a href="#detail">Detail</a><h2 id="detail">Details</h2>',
    );
    expect(document.sources).toEqual([{ id: 'source-1', label: 'Evidence', url: 'https://example.com/p?a=1&b=2' }]);
    expect(document.html).not.toContain('href="https:');
    expect(document.html).toContain('href="#detail"');
  });
  it('rejects oversized source and ambiguous duplicate HTML attributes before rendering', () => {
    expect(() => parseArtifactDocument('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB');
    expect(() => parseArtifactDocument('<!doctype html><div title="a" title="b">Text</div>')).toThrow(
      'duplicate-attribute',
    );
  });
  it.each([
    '<form><input></form>',
    '<iframe src="about:blank"></iframe>',
    '<base href="https://example.com">',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<script src="https://example.com/s.js"></script>',
    '<img src="https://example.com/p">',
    '<style>body{background:url(https://example.com)}</style>',
    '<style>@im/**/port "https://example.com";</style>',
    '<style>body{background:u\\72l(https://example.com)}</style>',
    '<a href="javascript:alert(1)">bad</a>',
    '<svg><animate attributeName="href" to="https://example.com"/></svg>',
  ])('rejects unsupported or remote features: %s', (source) => {
    expect(() => parseArtifactDocument(`<!doctype html>${source}`)).toThrow();
  });
});
