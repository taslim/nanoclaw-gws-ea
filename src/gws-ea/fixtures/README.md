# gws-ea boundary recordings

Real outputs that boundary tests replay (R7, KTD11). `recordings.ts` loads them.

## Provenance

Recorded on 2026-09-25 on the operator's macOS machine, during the live
`gws-ea create` gate (non-interactive, `--capture-fixtures`) and CLI probes run
right after it:

| File | Source | Command |
|---|---|---|
| `docker-context-inspect.json` | capture sink record | `docker context inspect` (Docker Desktop, context `desktop-linux`) |
| `gcloud-auth-print-access-token.reauth-failed.stderr.txt` | probe, stderr; exit code 1 | `gcloud auth print-access-token` for an account whose sign-in had to be renewed |
| `onecli-version.stdout.json` | probe, stdout | `onecli version` |

Tool versions: Google Cloud SDK 564.0.0 (core 2026.04.03, running on Python
3.9, which produces the warning at the top of the gcloud stderr), OneCLI CLI
2.2.5, Docker Desktop with Docker Compose v5.5.1.

The capture sink record keeps the sink's envelope (`kind`, `program`, `args`,
`exit_code`, `stdout`, `stderr`). Probe files hold only the recorded stream, as
recorded.

A successful gcloud or Cloudflare response could not be recorded: the gate
stopped at Google Cloud sign-in. Tests for those readers use documented response
shapes until an operator run with `--capture-fixtures` records them.

## Sanitization

Keys, JSON types, formatting, and every other byte stay as recorded. Only
identifying values change, and each becomes a value from the reserved synthetic
set:

- UUIDs and hex IDs become zero-filled values of the same length. An instance
  ID keeps a v4 UUID's version and variant digits, so it stays valid:
  `00000000-0000-4000-8000-000000000000`. A short trailing ordinal may keep
  distinct resources distinct.
- Home directories become `/home/operator`.
- Email addresses and hostnames use `example.com`.
- The Google Cloud project is `gws-ea-00000000000040008000`, the ID gws-ea
  derives from that instance ID, with the service account emails derived from
  it.
- IP addresses become `0.0.0.0` or `::`.

In `docker-context-inspect.json`, the home directory and the context-store hash
(a SHA-256 of the context name) were replaced. The two probe files contained no
identifying values and are unchanged.

`src/gws-ea/fixtures.test.ts` scans this directory and fails on an IP address,
an email, a UUID, a long hex string, a home path, or a credential prefix
outside the reserved set. Stage new captures in `.gws-ea-fixture-staging/`
(gitignored), sanitize them, and copy them here.
