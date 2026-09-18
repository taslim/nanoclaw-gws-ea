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

Remove `GCHAT_CREDENTIALS` and `GCHAT_ENDPOINT_URL` from `.env`.

## 3. Remove the package

```bash
pnpm uninstall @chat-adapter/gchat
```

## 4. Rebuild and restart

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
# Linux: systemctl --user restart $(systemd_unit)
```
