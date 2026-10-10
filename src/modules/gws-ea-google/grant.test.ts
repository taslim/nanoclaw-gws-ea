import { describe, expect, it } from 'vitest';

import {
  AGENT_GOOGLE_CREDENTIALS,
  AGENT_GOOGLE_HOSTS,
  AGENT_GOOGLE_SERVICES,
  credentialScopes,
  EXPOSED_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SKILLS,
  GOOGLE_SERVICES,
  GOOGLE_SIGN_IN_SCOPES,
  googleCredentialFor,
  HOST_GOOGLE_SERVICES,
  missingGoogleScopes,
  parseGoogleGrant,
} from './grant.js';

const DRIVE = 'https://www.googleapis.com/auth/drive';
const WORKSPACE_SCOPES = [
  DRIVE,
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/forms.body',
  'https://www.googleapis.com/auth/forms.responses.readonly',
];
/** What the sign-in asks for beyond its services' scopes: every other scope of each product an agent could be handed. */
const CEILING = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.events.owned.readonly',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.events.public.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.calendars',
  'https://www.googleapis.com/auth/calendar.calendars.readonly',
  'https://www.googleapis.com/auth/calendar.acls',
  'https://www.googleapis.com/auth/calendar.acls.readonly',
  'https://www.googleapis.com/auth/calendar.settings.readonly',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.metadata',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.insert',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.metadata',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.activity',
  'https://www.googleapis.com/auth/drive.activity.readonly',
  'https://www.googleapis.com/auth/drive.labels',
  'https://www.googleapis.com/auth/drive.labels.readonly',
  'https://www.googleapis.com/auth/drive.meet.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
  'https://www.googleapis.com/auth/forms.body.readonly',
];

const VALID = {
  schema_version: 1,
  account: 'Juno@Example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
  granted_at: '2026-09-30T10:00:00.000Z',
};

describe("the assistant's Google grant", () => {
  it('reads a grant, lowercasing the account', () => {
    expect(parseGoogleGrant(VALID)).toEqual({ ...VALID, account: 'juno@example.test' });
  });

  it.each([
    ['another schema', { ...VALID, schema_version: 2 }],
    ['no refresh token', { ...VALID, refresh_token: '' }],
    ['a control character', { ...VALID, client_id: 'client\nid' }],
    ['no scopes', { ...VALID, scopes: [] }],
    ['a time that is not canonical', { ...VALID, granted_at: '2026-09-30 10:00' }],
  ])('refuses a grant with %s', (_label, value) => {
    expect(() => parseGoogleGrant(value)).toThrow(/Google grant/);
  });

  it('asks in one sign-in for identity, every service, and the ceiling beyond them, each scope once', () => {
    expect(GOOGLE_SIGN_IN_SCOPES).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
      ...WORKSPACE_SCOPES,
      'https://www.googleapis.com/auth/gmail.modify',
      ...CEILING,
    ]);
    expect(new Set(GOOGLE_SIGN_IN_SCOPES).size).toBe(GOOGLE_SIGN_IN_SCOPES.length);
  });

  it("names each required scope a grant lacks, the ceiling's too, accepting Google's long form of email", () => {
    const beforeThisRelease = [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      ...AGENT_GOOGLE_SERVICES.calendar.scopes,
      ...AGENT_GOOGLE_SERVICES['gmail-read'].scopes,
      ...AGENT_GOOGLE_SERVICES.directory.scopes,
      ...HOST_GOOGLE_SERVICES.gmail.scopes,
    ];
    expect(missingGoogleScopes(beforeThisRelease)).toEqual([...WORKSPACE_SCOPES, ...CEILING]);
    expect(missingGoogleScopes(GOOGLE_SIGN_IN_SCOPES.filter((scope) => scope !== 'https://mail.google.com/'))).toEqual([
      'https://mail.google.com/',
    ]);
    expect(missingGoogleScopes([...GOOGLE_SIGN_IN_SCOPES])).toEqual([]);
  });
});

describe('the Google services agents reach', () => {
  it('keeps Calendar, Gmail and the directory each on its own key and skill', () => {
    expect(AGENT_GOOGLE_SERVICES['gmail-read']).toEqual({
      capability: 'google-mail-read',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      skill: 'gmail',
    });
    expect(AGENT_GOOGLE_SERVICES.directory).toEqual({
      capability: 'google-directory',
      scopes: ['https://www.googleapis.com/auth/directory.readonly'],
      skill: 'gpeople',
    });
    expect(AGENT_GOOGLE_SERVICES.calendar).toMatchObject({ capability: 'google-calendar', skill: 'gcalendar' });
  });

  it('teaches every exposed service, each skill once', () => {
    expect(EXPOSED_GOOGLE_SKILLS).toEqual(['gcalendar', 'gmail', 'gpeople', 'gworkspace']);
  });

  it('adds Drive, Docs, Sheets, Slides and Forms under one Workspace key, each with its write scopes', () => {
    expect(EXPOSED_GOOGLE_SERVICES).toEqual([
      'calendar',
      'gmail-read',
      'directory',
      'drive',
      'docs',
      'sheets',
      'slides',
      'forms',
    ]);
    const workspace = { capability: 'google-workspace', skill: 'gworkspace' };
    expect(AGENT_GOOGLE_SERVICES.drive).toEqual({ ...workspace, scopes: [DRIVE] });
    expect(AGENT_GOOGLE_SERVICES.docs).toEqual({ ...workspace, scopes: ['https://www.googleapis.com/auth/documents'] });
    expect(AGENT_GOOGLE_SERVICES.sheets).toEqual({
      ...workspace,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    expect(AGENT_GOOGLE_SERVICES.slides).toEqual({
      ...workspace,
      scopes: ['https://www.googleapis.com/auth/presentations'],
    });
    expect(AGENT_GOOGLE_SERVICES.forms).toEqual({
      ...workspace,
      scopes: [
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/forms.responses.readonly',
      ],
    });
  });

  it('publishes one credential per Google host, Drive riding with Calendar under its old vault name', () => {
    expect(AGENT_GOOGLE_CREDENTIALS).toEqual([
      { host: 'www.googleapis.com', secretName: 'google-calendar', services: ['calendar', 'drive'] },
      { host: 'gmail.googleapis.com', secretName: 'google-gmail-read', services: ['gmail-read'] },
      { host: 'people.googleapis.com', secretName: 'google-directory', services: ['directory'] },
      { host: 'docs.googleapis.com', secretName: 'google-docs', services: ['docs'] },
      { host: 'sheets.googleapis.com', secretName: 'google-sheets', services: ['sheets'] },
      { host: 'slides.googleapis.com', secretName: 'google-slides', services: ['slides'] },
      { host: 'forms.googleapis.com', secretName: 'google-forms', services: ['forms'] },
    ]);
    expect(new Set(AGENT_GOOGLE_HOSTS).size).toBe(AGENT_GOOGLE_CREDENTIALS.length);
    expect(AGENT_GOOGLE_HOSTS).toEqual(AGENT_GOOGLE_CREDENTIALS.map((credential) => credential.host));
    expect(new Set(AGENT_GOOGLE_CREDENTIALS.map((credential) => credential.secretName)).size).toBe(
      AGENT_GOOGLE_CREDENTIALS.length,
    );
    // Every exposed service is served by exactly one credential.
    for (const id of EXPOSED_GOOGLE_SERVICES) {
      expect(
        AGENT_GOOGLE_CREDENTIALS.filter((credential) => credential.services.includes(id)),
        id,
      ).toHaveLength(1);
    }
    expect(googleCredentialFor('drive')).toBe(googleCredentialFor('calendar'));
    expect(googleCredentialFor('forms').host).toBe('forms.googleapis.com');
  });

  it("asks for each credential's scopes the grant holds, and nothing on a host it holds none for", () => {
    const www = googleCredentialFor('calendar');
    const docs = googleCredentialFor('docs');
    expect(credentialScopes(www, [...GOOGLE_SIGN_IN_SCOPES])).toEqual([
      ...AGENT_GOOGLE_SERVICES.calendar.scopes,
      DRIVE,
    ]);

    const beforeThisRelease = [
      'openid',
      ...AGENT_GOOGLE_SERVICES.calendar.scopes,
      ...HOST_GOOGLE_SERVICES.gmail.scopes,
    ];
    expect(credentialScopes(www, beforeThisRelease)).toEqual(AGENT_GOOGLE_SERVICES.calendar.scopes);
    expect(credentialScopes(docs, beforeThisRelease)).toEqual([]);
    expect(credentialScopes(googleCredentialFor('forms'), [WORKSPACE_SCOPES[4]!])).toEqual([WORKSPACE_SCOPES[4]]);
  });

  it('keeps every host-only scope off every credential an agent can reach', () => {
    const agentScopes = new Set(
      AGENT_GOOGLE_CREDENTIALS.flatMap((credential) => credentialScopes(credential, [...GOOGLE_SIGN_IN_SCOPES])),
    );
    const hostOnly = Object.values(HOST_GOOGLE_SERVICES)
      .flatMap((service) => service.scopes)
      .filter((scope) => !EXPOSED_GOOGLE_SERVICES.some((id) => GOOGLE_SERVICES[id].scopes.includes(scope)));
    expect(hostOnly).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    for (const scope of hostOnly) expect(agentScopes.has(scope), scope).toBe(false);
    // A host-only service names no gateway credential, so nothing could publish it.
    for (const service of Object.values(HOST_GOOGLE_SERVICES)) expect(service).not.toHaveProperty('secretName');
  });

  it("holds Drive for the host's own use with the same scope agents' Calendar credential carries", () => {
    expect(HOST_GOOGLE_SERVICES['drive-host']).toEqual({ scopes: [DRIVE] });
    expect(HOST_GOOGLE_SERVICES['calendar-host']).toEqual({ scopes: AGENT_GOOGLE_SERVICES.calendar.scopes });
  });
});
