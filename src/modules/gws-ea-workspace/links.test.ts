/**
 * Which links the link check reads (KTD5): exactly the Docs, Sheets,
 * Slides, Forms and Drive shapes on docs.google.com, drive.google.com and
 * forms.gle, however their scheme, userinfo or port is written. Every other
 * URL passes untouched, and a redirector is never read through.
 */
import { describe, expect, it } from 'vitest';

import { fileProbeUrl, googleLinkOf, googleLinksIn } from './links.js';

const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab';
const FORM = '1FAIpQLSdNoelArcherRsvpForm_Spring-2026';

describe('a Google file link', () => {
  it.each([
    ['a Doc', `https://docs.google.com/document/d/${DOC}/edit`, 'document'],
    ['a Sheet', `https://docs.google.com/spreadsheets/d/${DOC}/view#gid=0`, 'spreadsheets'],
    ['a Slides deck', `https://docs.google.com/presentation/d/${DOC}/preview`, 'presentation'],
    ['a copy link', `https://docs.google.com/document/d/${DOC}/copy`, 'document'],
    ['a bare /d/ link', `https://docs.google.com/document/d/${DOC}`, 'document'],
    ['a form to edit', `https://docs.google.com/forms/d/${DOC}/edit`, 'forms'],
    ['a Drive file', `https://drive.google.com/file/d/${DOC}/view?usp=sharing`, 'file'],
    ['a Drive folder', `https://drive.google.com/drive/folders/${DOC}`, 'folder'],
    ['an open?id= link', `https://drive.google.com/open?id=${DOC}`, undefined],
    ['a uc?id= link', `https://drive.google.com/uc?id=${DOC}&export=download`, undefined],
  ])('reads %s by its file id', (_name, url, product) => {
    expect(googleLinkOf(url)).toEqual({
      kind: 'file',
      url,
      fileId: DOC,
      ...(product === undefined ? {} : { product }),
    });
  });

  it('reads past the /u/N/ and /a/<domain>/ prefixes', () => {
    for (const url of [
      `https://docs.google.com/document/u/1/d/${DOC}/edit`,
      `https://docs.google.com/a/northwind.example/document/d/${DOC}/edit`,
      `https://drive.google.com/drive/u/0/folders/${DOC}`,
      `https://drive.google.com/a/northwind.example/file/d/${DOC}/view`,
    ]) {
      expect(googleLinkOf(url)).toMatchObject({ kind: 'file', fileId: DOC });
    }
  });

  it('keeps a resource key exactly as written', () => {
    expect(googleLinkOf(`https://drive.google.com/file/d/${DOC}/view?resourcekey=0-Ab_Cd-Ef`)).toMatchObject({
      fileId: DOC,
      resourceKey: '0-Ab_Cd-Ef',
    });
  });

  it('reads a form responder link and a short form link as forms only a signed-out visit can judge', () => {
    expect(googleLinkOf(`https://docs.google.com/forms/d/e/${FORM}/viewform?usp=sf_link`)).toEqual({
      kind: 'form',
      url: `https://docs.google.com/forms/d/e/${FORM}/viewform?usp=sf_link`,
      probeUrl: `https://docs.google.com/forms/d/e/${FORM}/viewform`,
    });
    expect(googleLinkOf(`https://docs.google.com/forms/u/0/d/e/${FORM}/formResponse`)).toMatchObject({
      kind: 'form',
      probeUrl: `https://docs.google.com/forms/d/e/${FORM}/viewform`,
    });
    expect(googleLinkOf(`https://docs.google.com/forms/d/${DOC}/viewform`)).toMatchObject({
      kind: 'form',
      probeUrl: `https://docs.google.com/forms/d/${DOC}/viewform`,
    });
    expect(googleLinkOf('https://forms.gle/Rsvp7NoelArcher')).toEqual({
      kind: 'form',
      url: 'https://forms.gle/Rsvp7NoelArcher',
      probeUrl: 'https://forms.gle/Rsvp7NoelArcher',
    });
  });

  it('reads a file published to the web as published, by its publish id or its file id', () => {
    expect(googleLinkOf('https://docs.google.com/document/d/e/2PACX-1vRemyVance/pub')).toMatchObject({
      kind: 'published',
      probeUrl: 'https://docs.google.com/document/d/e/2PACX-1vRemyVance/pub',
    });
    expect(googleLinkOf('https://docs.google.com/spreadsheets/d/e/2PACX-1vRemyVance/pubhtml?gid=0')).toMatchObject({
      kind: 'published',
      probeUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRemyVance/pubhtml',
    });
    expect(googleLinkOf(`https://docs.google.com/document/d/${DOC}/pub`)).toMatchObject({
      kind: 'published',
      probeUrl: `https://docs.google.com/document/d/${DOC}/pub`,
    });
  });

  it.each([
    ['http', `http://docs.google.com/document/d/${DOC}/edit`],
    ['userinfo', `https://juno@docs.google.com/document/d/${DOC}/edit`],
    ['a port', `https://docs.google.com:8443/document/d/${DOC}/edit`],
  ])('checks a link written over %s by its file id, never fetching it as written', (_name, url) => {
    expect(googleLinkOf(url)).toMatchObject({ kind: 'file', fileId: DOC, product: 'document' });
  });

  it.each([
    ['a lookalike host', `https://docs.google.com.northwind.example/document/d/${DOC}/edit`],
    ['another host carrying the path', `https://northwind.example/docs.google.com/document/d/${DOC}`],
    ['the google.com/url redirector', `https://www.google.com/url?q=https://docs.google.com/document/d/${DOC}/edit`],
    ['a Meet link', 'https://meet.google.com/abc-defg-hij'],
    ['a Calendar link', 'https://calendar.google.com/calendar/event?eid=abc'],
    ['a Maps link', 'https://maps.google.com/?q=Northwind'],
    ['a Google API host', `https://www.googleapis.com/drive/v3/files/${DOC}`],
    ['a Drawing', `https://docs.google.com/drawings/d/${DOC}/edit`],
    ['a Docs page that names no file', 'https://docs.google.com/document/u/0/'],
  ])('passes %s untouched', (_name, url) => {
    expect(googleLinkOf(url)).toBeUndefined();
  });
});

describe('the links in what the assistant wrote', () => {
  it('finds links as written, in markdown, and as autolinks, without the punctuation around them', () => {
    const links = googleLinksIn([
      `The plan is at https://docs.google.com/document/d/${DOC}/edit.`,
      `See [the tracker](https://docs.google.com/spreadsheets/d/${DOC}x/edit) and <https://forms.gle/Rsvp7NoelArcher>.`,
      `(https://drive.google.com/drive/folders/${DOC}y)`,
    ]);
    expect(links.map((link) => link.url)).toEqual([
      `https://docs.google.com/document/d/${DOC}/edit`,
      `https://docs.google.com/spreadsheets/d/${DOC}x/edit`,
      'https://forms.gle/Rsvp7NoelArcher',
      `https://drive.google.com/drive/folders/${DOC}y`,
    ]);
  });

  it('reads a link hidden behind markdown link text', () => {
    expect(googleLinksIn([`Here is [the deck](https://docs.google.com/presentation/d/${DOC}/edit "Deck").`])).toEqual([
      { kind: 'file', url: `https://docs.google.com/presentation/d/${DOC}/edit`, fileId: DOC, product: 'presentation' },
    ]);
  });

  it('lists a file once, however many times and ways it is linked', () => {
    const links = googleLinksIn([
      `https://docs.google.com/document/d/${DOC}/edit and [again](https://docs.google.com/document/d/${DOC}/view)`,
      `https://drive.google.com/open?id=${DOC}`,
    ]);
    expect(links).toHaveLength(1);
  });

  it('finds nothing in text with no checked link', () => {
    expect(googleLinksIn(['Join at https://meet.google.com/abc-defg-hij', 'no links here', ''])).toEqual([]);
  });
});

describe('where a signed-out visit to a file goes', () => {
  it('opens a file the way Google serves it to someone with only the link, resource key included', () => {
    const doc = googleLinkOf(`https://docs.google.com/document/d/${DOC}/copy?resourcekey=0-Rk`);
    const drive = googleLinkOf(`https://drive.google.com/open?id=${DOC}`);
    if (doc?.kind !== 'file' || drive?.kind !== 'file') throw new Error('not read as files');
    expect(fileProbeUrl(doc)).toBe(`https://docs.google.com/document/d/${DOC}/edit?resourcekey=0-Rk`);
    expect(fileProbeUrl(drive)).toBe(`https://drive.google.com/file/d/${DOC}/view`);
    expect(fileProbeUrl(drive, 'application/vnd.google-apps.spreadsheet')).toBe(
      `https://docs.google.com/spreadsheets/d/${DOC}/edit`,
    );
    expect(fileProbeUrl(drive, 'application/vnd.google-apps.folder')).toBe(
      `https://drive.google.com/drive/folders/${DOC}`,
    );
  });
});
