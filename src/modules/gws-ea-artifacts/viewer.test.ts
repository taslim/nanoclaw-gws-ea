import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createSocket } from 'node:dgram';
import { createServer as createTcpServer } from 'node:net';
import { Script } from 'node:vm';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { defaultTreeAdapter, parse } from 'parse5';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArtifactDocument } from './document.js';
import { renderArtifactChild, renderArtifactViewer } from './viewer.js';
const configuredChrome = process.env.ARTIFACT_TEST_CHROMIUM || process.env.GWS_EA_BROWSER_TEST_CHROME;
const executablePath =
  configuredChrome ??
  [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(existsSync);
if (configuredChrome && !existsSync(configuredChrome))
  throw new Error(`Configured artifact test Chromium is missing: ${configuredChrome}`);
const nonce = '0123456789abcdef0123456789abcdef';
it.each([
  '<p>Budget</p>',
  '<p title="</body>">Budget</p>',
  '<style>body::after{content:"</body>"}</style><p>Budget</p>',
  '<template><p title="</body>">Template</p></template><p>Budget</p>',
])('places an intact executable bootstrap in the actual body despite literal closing tags: %s', (content) => {
  const document = parseArtifactDocument(
    `<!doctype html><html><body>${content}<p>$& $\` $'</p><script>document.title="Interactive"</script></body></html><!-- </body> -->`,
  );
  const rendered = parse(renderArtifactChild({ document, nonce }).body);
  const html = rendered.childNodes.filter(defaultTreeAdapter.isElementNode).find((node) => node.tagName === 'html');
  const body = html?.childNodes.filter(defaultTreeAdapter.isElementNode).find((node) => node.tagName === 'body');
  if (!body) throw new Error('Missing rendered body.');
  const scripts = body.childNodes.filter(defaultTreeAdapter.isElementNode).filter((node) => node.tagName === 'script');
  expect(scripts).toHaveLength(1);
  expect(scripts[0].attrs).toContainEqual({ name: 'nonce', value: nonce });
  const bootstrap = scripts[0].childNodes
    .filter(defaultTreeAdapter.isTextNode)
    .map((node) => node.value)
    .join('');
  expect(bootstrap).toContain("$&amp; $` $'");
  expect(() => new Script(bootstrap)).not.toThrow();
});
it('runs no script on an unscripted page and lets only its own links leave, while scripted pages stay isolated', () => {
  const plain = parseArtifactDocument('<!doctype html><html lang="pt"><a href="https://example.com/a">A</a></html>');
  const plainChild = renderArtifactChild({ document: plain, nonce });
  expect(plainChild.body).not.toContain('<script');
  expect(plainChild.headers['content-security-policy']).toContain("script-src 'none'");
  expect(plainChild.headers['content-security-policy']).toContain(
    'sandbox allow-popups allow-popups-to-escape-sandbox',
  );
  expect(plainChild.headers['connection-allowlist']).toBeUndefined();
  const plainViewer = renderArtifactViewer({
    document: plain,
    nonce,
    title: 'Plan',
    childUrl: 'https://views.example.com/a/frame/x',
  }).body;
  expect(plainViewer).toContain('<html lang="pt">');
  expect(plainViewer).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
  expect(plainViewer).not.toContain('<script');
  const scripted = parseArtifactDocument('<!doctype html><a href="https://example.com/a">A</a><script>void 0</script>');
  const scriptedChild = renderArtifactChild({ document: scripted, nonce });
  expect(scriptedChild.headers['content-security-policy']).toMatch(/sandbox allow-scripts$/u);
  expect(scriptedChild.headers['connection-allowlist']).toBeDefined();
  expect(
    renderArtifactViewer({ document: scripted, nonce, title: 'Plan', childUrl: 'https://views.example.com/a/frame/x' })
      .body,
  ).toContain('sandbox="allow-scripts"');
});
const fixtureHtml = `<!doctype html><html><head><style>body{font:18px system-ui;margin:20px}button,input{font:inherit}svg{max-width:100%}</style></head><body><h1>Budget scenario</h1><p>Base budget: $42</p><label>Multiplier <input id="factor" type="number" value="2"></label><button id="calculate">Calculate</button><output id="result">84</output><p><a href="https://example.com/source">Evidence</a></p><script>document.querySelector('#calculate').addEventListener('click',()=>document.querySelector('#result').textContent=42*Number(document.querySelector('#factor').value));</script></body></html>`;
let browser: Browser;
let server: Server;
let origin: string;
let mode = 'enforced';
let source = fixtureHtml;
const traffic: string[] = [];
const udp = createSocket('udp4');
let udpPort: number;
const udpPackets: number[] = [];
const tcpConnections: number[] = [];
const tcp = createTcpServer((socket) => {
  tcpConnections.push(1);
  socket.destroy();
});
let tcpPort: number;
let frameRequests = 0;
async function pageFixture(
  userAgent?: string,
): Promise<{ context: BrowserContext; page: Awaited<ReturnType<BrowserContext['newPage']>> }> {
  const context = await browser.newContext({ ...(userAgent ? { userAgent } : {}) });
  const page = await context.newPage();
  await page.goto(origin);
  return { context, page };
}
describe.skipIf(!executablePath)('actual Chromium artifact boundary', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    udpPort = udp.address().port;
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
    const tcpAddress = tcp.address();
    if (!tcpAddress || typeof tcpAddress === 'string') throw new Error('Missing TCP port.');
    tcpPort = tcpAddress.port;
    udp.on('message', (message) => udpPackets.push(message.length));
    server = createServer((request, response) => {
      if (request.url?.startsWith('/collect')) {
        traffic.push(request.url);
        response.writeHead(200).end('observed');
        return;
      }
      const document = parseArtifactDocument(source);
      const child = request.url === '/frame';
      if (child) frameRequests += 1;
      const rendered = child
        ? renderArtifactChild({ document, nonce })
        : renderArtifactViewer({
            document,
            nonce,
            title: '</title><script>bad()</script>',
            childUrl: 'https://artifact.test/frame',
          });
      const headers = { ...rendered.headers };
      if (child && mode !== 'enforced') {
        delete headers['connection-allowlist'];
        if (mode === 'report') headers['connection-allowlist-report-only'] = '(); report-to=gws-ea-artifact-isolation';
      }
      // Translate only the fixture's origin; the production viewer requires configured HTTPS.
      if (headers['content-security-policy'])
        headers['content-security-policy'] = headers['content-security-policy'].replaceAll(
          'https://artifact.test',
          origin,
        );
      response.writeHead(200, headers).end(rendered.body.replaceAll('https://artifact.test', origin));
    });
    server.on('upgrade', (request, socket) => {
      traffic.push(request.url ?? 'websocket-upgrade');
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    udp.close();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
  it('runs keyboard-accessible local calculation only after real enforced verification and keeps mobile readable', async () => {
    mode = 'enforced';
    source = fixtureHtml;
    const { context, page } = await pageFixture();
    try {
      const frame = page.frames()[1];
      await frame.waitForFunction("document.documentElement.dataset.artifactMode === 'interactive'");
      expect(await frame.locator('[data-artifact-notice]').count()).toBe(0);
      await frame.locator('#factor').fill('3');
      await frame.locator('#calculate').focus();
      await page.keyboard.press('Enter');
      expect(await frame.locator('#result').textContent()).toBe('126');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await frame.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true);
      expect(await page.title()).toBe('</title><script>bad()</script>');
    } finally {
      await context.close();
    }
  });
  it.each(['none', 'report', 'unsupported'])(
    'keeps scripts and event handlers inert for %s verification',
    async (fixtureMode) => {
      mode = fixtureMode;
      source =
        '<!doctype html><h1>Readable complete information</h1><button onclick="document.body.textContent=\'LEAK\'">Action</button><script>document.body.textContent="LEAK"</script>';
      const { context, page } = await pageFixture(fixtureMode === 'unsupported' ? 'Firefox/150' : undefined);
      try {
        // A capable Chromium hides the notice while it verifies isolation, so it never flashes there.
        await page.waitForTimeout(250);
        expect(await page.frames()[1].locator('[data-artifact-notice]').isVisible()).toBe(
          fixtureMode === 'unsupported',
        );
        await page.waitForTimeout(800);
        const frame = page.frames()[1];
        expect(await frame.locator('body').textContent()).toContain('Readable complete information');
        expect(await frame.locator('button').isDisabled()).toBe(true);
        expect(await frame.locator('html').getAttribute('data-artifact-mode')).toBeNull();
        expect(await frame.locator('[data-artifact-notice]').isVisible()).toBe(true);
      } finally {
        await context.close();
      }
    },
  );
  it('requires a trusted parent click for an exact parsed source, ignoring spoofed frame messages', async () => {
    mode = 'enforced';
    source = fixtureHtml;
    const { context, page } = await pageFixture();
    try {
      await page.evaluate("postMessage({type:'artifact-source',id:'source-1'},'*')");
      expect(await page.locator('details').getAttribute('open')).toBeNull();
      await page.frames()[1].waitForFunction("document.documentElement.dataset.artifactMode === 'interactive'");
      await page.frames()[1].waitForFunction("document.readyState === 'complete'");
      // Local headless Chrome intermittently drops synthetic mouse input that opens a tab; keyboard activation
      // is a real user gesture and exercises the same link policy.
      await page.frames()[1].locator('[data-artifact-source]').focus();
      await page.keyboard.press('Enter');
      await page.locator('details[open]').waitFor({ timeout: 1500 });
      expect(await page.locator('a#source-1').getAttribute('href')).toBe('https://example.com/source');
      expect(await page.evaluate('document.activeElement?.id')).toBe('source-1');
      const popupRequest = page.waitForEvent('popup', { timeout: 1500 });
      await context.route('https://example.com/source', (route) =>
        route.fulfill({ status: 200, body: 'Deliberate source' }),
      );
      await page.keyboard.press('Enter');
      const popup = await popupRequest;
      await popup.waitForLoadState();
      expect(await popup.content()).toContain('Deliberate source');
    } finally {
      await context.close();
    }
  });
  it("opens an unscripted page's own link in one tap while the page runs no script at all", async () => {
    mode = 'enforced';
    source =
      '<!doctype html><html lang="pt"><h1>Plain page</h1><p><a href="https://example.com/direct">Direct source</a></p><p><a href="#end">Jump</a></p><p id="end">End</p></html>';
    const { context, page } = await pageFixture();
    try {
      expect(await page.locator('html').getAttribute('lang')).toBe('pt');
      const frame = page.frames()[1];
      await frame.locator('a[href="https://example.com/direct"]').waitFor();
      expect(await frame.evaluate('document.scripts.length')).toBe(0);
      await context.route('https://example.com/direct', (route) =>
        route.fulfill({ status: 200, body: 'Direct source opened' }),
      );
      const popupRequest = page.waitForEvent('popup', { timeout: 3000 });
      await frame.locator('a[href="https://example.com/direct"]').focus();
      await page.keyboard.press('Enter');
      const popup = await popupRequest;
      await popup.waitForLoadState();
      expect(await popup.content()).toContain('Direct source opened');
      expect(await page.locator('details').getAttribute('open')).toBeNull();
      await frame.locator('a[href="#end"]').focus();
      await page.keyboard.press('Enter');
      expect(frame.url()).toBe(`${origin}/frame#end`);
    } finally {
      await context.close();
    }
  });
  it('blocks network channels, workers, connection hints, popups and navigation under the real enforced child response', async () => {
    mode = 'enforced';
    // Positive control: these listeners observe actual browser ICE traffic without the child policy.
    const control = await pageFixture();
    try {
      await control.page.evaluate(
        `globalThis.controlPeer=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'},{urls:'turn:127.0.0.1:${tcpPort}?transport=tcp',username:'u',credential:'p'}]});controlPeer.createDataChannel('x');controlPeer.createOffer().then(o=>controlPeer.setLocalDescription(o));`,
      );
      await control.page.waitForTimeout(700);
      expect(udpPackets.length).toBeGreaterThan(0);
      expect(tcpConnections.length).toBeGreaterThan(0);
    } finally {
      await control.context.close();
    }
    traffic.length = 0;
    udpPackets.length = 0;
    tcpConnections.length = 0;
    const attacks = [
      `fetch('${origin}/collect-fetch').catch(()=>{});`,
      `const x=new XMLHttpRequest();x.open('POST','${origin}/collect-xhr');x.send('x');`,
      `navigator.sendBeacon('${origin}/collect-beacon','x');`,
      `new WebSocket('${origin.replace('http:', 'ws:')}/collect-ws');`,
      `new EventSource('${origin}/collect-events');`,
      `const image=new Image();image.src='${origin}/collect-image';document.body.append(image);`,
      `const s=document.createElement('style');s.textContent='body{background:url(${origin}/collect-css)}';document.head.append(s);`,
      `const font=new FontFace('remote','url(${origin}/collect-font)');font.load().catch(()=>{});document.fonts.add(font);`,
      `const script=document.createElement('script');script.nonce=document.currentScript.nonce;script.src='${origin}/collect-script';document.body.append(script);`,
      `new Worker(URL.createObjectURL(new Blob(['fetch("${origin}/collect-worker")'],{type:'text/javascript'})));`,
      `const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'},{urls:'turn:127.0.0.1:${tcpPort}?transport=tcp',username:'u',credential:'p'}]});pc.createDataChannel('x');pc.createOffer().then(o=>pc.setLocalDescription(o));`,
      `for(const rel of ['dns-prefetch','preconnect']){const link=document.createElement('link');link.rel=rel;link.href='${origin}/collect-dns';document.head.append(link);}`,
      `try{new WebTransport('https://127.0.0.1:${udpPort}/collect-transport')}catch{}`,
      `window.open('${origin}/collect-popup');`,
      `try{top.location='${origin}/collect-top'}catch{};`,
      `const a=document.createElement('a');a.href='${origin}/collect-download';a.download='x';document.body.append(a);a.click();`,
      `location.href='${origin}/collect-self';`,
      `location.reload();`,
      `const form=document.createElement('form');form.method='POST';form.action='${origin}/collect-form';document.body.append(form);form.submit();`,
      `const frame=document.createElement('iframe');frame.src='${origin}/collect-frame';document.body.append(frame);`,
      `location.href='data:text/html,<img src="${origin}/collect-data">';`,
      `const next='<scr'+'ipt nonce="'+document.currentScript.nonce+'">fetch("${origin}/collect-blob").catch(()=>{})</scr'+'ipt>';location.href=URL.createObjectURL(new Blob([next],{type:'text/html'}));`,
    ];
    for (const attack of attacks) {
      source = `<!doctype html><h1>Safe information</h1><script>document.documentElement.dataset.attackStarted='yes';${attack}</script>`;
      frameRequests = 0;
      const { context, page } = await pageFixture();
      try {
        await page.waitForTimeout(500);
        const child = page.frames().find((frame) => frame.url() === `${origin}/frame`);
        if (child) {
          expect(await child.locator('html').getAttribute('data-attack-started'), attack).toBe('yes');
        } else {
          // A denied navigation may replace the child with Chromium's local error document.
          expect(
            page.frames().map((frame) => frame.url()),
            attack,
          ).toContain('chrome-error://chromewebdata/');
        }
        expect(frameRequests, attack).toBe(1);
      } finally {
        await context.close();
      }
    }
    expect(traffic).toEqual([]);
    expect(udpPackets).toEqual([]);
    expect(tcpConnections).toEqual([]);
  }, 30_000);
});
