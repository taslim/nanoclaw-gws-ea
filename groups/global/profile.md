# Profile

<!-- This file is the single source of truth for your EA's working profile.
     All procedure docs reference this file instead of hardcoding names/emails.
     Edit this file to customize the EA for your setup. -->

## Identity

- Full name: {ASSISTANT_NAME}
- Principal: {PRINCIPAL_NAME} ({PRINCIPAL_SHORT_NAME})
- Your email: {ASSISTANT_EMAIL}
- Principal's email: {PRINCIPAL_EMAIL}

## Email

- Sign off: "{ASSISTANT_NAME} | EA to {PRINCIPAL_NAME}"

## Calendars

<!-- Define each calendar your principal uses.
     id: Google Calendar ID (from calendar settings — usually an email address, or "primary" for the default)
     mode: how the EA should treat this calendar
       - "primary"   — full access, create new events here
       - "readwrite"  — full access, but don't create events here unless contextually appropriate
       - "readonly"   — can read events but not modify
       - "freebusy"   — can only see busy/free blocks, not event details
     notes: behavioral guidance for the agent -->

| Name | ID | Mode | Notes |
|------|----|------|-------|
| Work | {WORK_CALENDAR_ID} | freebusy | Immovable — schedule around it |
| Projects | {PROJECTS_CALENDAR_ID} | primary | Create and manage events here |
| Personal | {PERSONAL_CALENDAR_ID} | readwrite | Protect by default; family events go here |

## Heartbeat

- Space ID: {HEARTBEAT_SPACE_ID}
