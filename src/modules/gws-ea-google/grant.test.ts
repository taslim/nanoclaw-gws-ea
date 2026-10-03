import { describe, expect, it } from 'vitest';

import {
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SKILLS,
  GOOGLE_SERVICES,
  GOOGLE_SIGN_IN_SCOPES,
  HOST_GOOGLE_SERVICES,
  missingGoogleScopes,
  parseGoogleGrant,
} from './grant.js';

const VALID = {
  schema_version: 1,
  account: 'Robin@Example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email'],
  granted_at: '2026-09-30T10:00:00.000Z',
};

describe("the assistant's Google grant", () => {
  it('reads a grant, lowercasing the account', () => {
    expect(parseGoogleGrant(VALID)).toEqual({ ...VALID, account: 'robin@example.test' });
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

  it('asks in one sign-in for identity and every service, agent-facing and host-only', () => {
    expect(GOOGLE_SIGN_IN_SCOPES).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ]);
    expect(GOOGLE_SERVICES).toEqual({ ...AGENT_GOOGLE_SERVICES, ...HOST_GOOGLE_SERVICES });
  });

  it("names each required scope a grant lacks, accepting Google's long form of email", () => {
    const beforeThisRelease = [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      ...AGENT_GOOGLE_SERVICES.calendar.scopes,
      ...HOST_GOOGLE_SERVICES.gmail.scopes,
    ];
    expect(missingGoogleScopes(beforeThisRelease)).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
    ]);
    expect(missingGoogleScopes([...GOOGLE_SIGN_IN_SCOPES])).toEqual([]);
  });
});

describe('the Google services agents reach', () => {
  it('exposes read-only Gmail and the directory beside Calendar, each on its own host, key, and skill', () => {
    expect(EXPOSED_GOOGLE_SERVICES).toEqual(['calendar', 'gmail-read', 'directory']);
    expect(AGENT_GOOGLE_SERVICES['gmail-read']).toEqual({
      capability: 'google-mail-read',
      secretName: 'google-gmail-read',
      hostPattern: 'gmail.googleapis.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      skill: 'gmail',
    });
    expect(AGENT_GOOGLE_SERVICES.directory).toEqual({
      capability: 'google-directory',
      secretName: 'google-directory',
      hostPattern: 'people.googleapis.com',
      scopes: ['https://www.googleapis.com/auth/directory.readonly'],
      skill: 'gpeople',
    });
    expect(AGENT_GOOGLE_SERVICES.calendar).toMatchObject({
      capability: 'google-calendar',
      secretName: 'google-calendar',
      skill: 'gcalendar',
    });
    expect(EXPOSED_GOOGLE_SKILLS).toEqual(['gcalendar', 'gmail', 'gpeople']);
  });

  it('keeps the inbox-modifying Gmail scope off every service an agent can reach', () => {
    const agentScopes = EXPOSED_GOOGLE_SERVICES.flatMap((id) => AGENT_GOOGLE_SERVICES[id].scopes);
    expect(HOST_GOOGLE_SERVICES.gmail.scopes).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    expect(agentScopes).not.toContain('https://www.googleapis.com/auth/gmail.modify');
    // A host-only service names no gateway credential, so nothing could publish it.
    expect(HOST_GOOGLE_SERVICES.gmail).not.toHaveProperty('secretName');
  });
});
