# Remove Google Chat

Every step is idempotent — safe to re-run.

## 1. Remove the registration

Delete the self-registration import from `src/channels/index.ts` (skip if already gone):

```typescript
import './gchat.js';
```

Then delete the copied registration test:

```bash
rm -f src/channels/gchat-registration.test.ts
```

## 2. Remove credentials

Remove `GCHAT_CREDENTIALS`, `GCHAT_ENDPOINT_URL`, and `GCHAT_BOT_USER_ID` from `.env`.

## 3. Keep the base-owned composition

Keep `@chat-adapter/gchat`, `src/channels/gchat.ts`,
`src/channels/gchat.test.ts`, and `src/channels/gchat-auth.test.ts`. They are
owned by the base checkout and remain part of its compiled channel composition;
removal disables Google Chat by deleting its registration and runtime
configuration only.

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
