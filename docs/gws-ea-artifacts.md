# HTML artifacts

An artifact is one saved HTML information view: a brief, comparison, explanation,
plan or local calculator. The principal requests it in conversation and receives
a private link. The assistant authors a self-contained document using its normal file tools
and design guidance, then saves it through the native artifact tools.

All essential information is present in the initial document. Local scripts may
filter, sort or calculate embedded information. They cannot submit data, send
messages, command an agent or perform account actions. A browser without verified
network isolation receives the complete static view; controls that need scripts
are unavailable. A document that is entirely static needs no warning.

## Operation and access

Enable this optional capability for an assistant through the
[operator CLI](gws-ea-cli.md#html-artifacts). It uses a Named Cloudflare Tunnel and
one Access application per assistant. The default is one operator hostname with
the assistant's first name as its stable prefix. A dedicated assistant hostname
is supported in an active zone of the configured account. Prefix collisions fail
before ingress opens; they are resolved with another configured hostname.

Cloudflare credentials and connector tokens are host-only, separate files.
Management permissions cover the selected account/zones and the required Tunnel,
DNS, Access applications/policies and PIN identity-provider operations. Account
permissions are not isolation scoped to a single Access application. These files
never enter an author container, source checkout or artifact response.

Private readers sign in through Cloudflare's email one-time PIN. Use one of the
principal's currently confirmed profile addresses; every such address can open
all private artifacts for that assistant. There is no artifact address book.
Named guests must sign in with their exact invitation email. Public snapshots
need no login. Identity seats and account capacity depend on the operator's
Cloudflare plan; verify that allowance before inviting readers. Viewing also
depends on the operator host and connector being available.

| Link                           | Content and authority                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `/aya/<artifact_id>`           | Current private head; current principal addresses only                       |
| `/aya/share/<share_id>`        | The granted revision; its exact active named audience or a current principal |
| `/aya/public/<publication_id>` | The selected active public revision                                          |

A guest cannot browse drafts, history, another artifact or a listing. A private
edit does not alter a named grant or public snapshot. Explicit replacement names
the new revision and current share generation. A public replacement preserves its
public URL. Withdrawal, deletion, expiry and disablement stop origin access;
copies already downloaded cannot be recalled.

There is no default expiry and no implicit upkeep schedule. A later source change
requires a deliberate revision. An artifact's requested expiry also bounds its
shares. Delete removes source and access together, retaining only minimal retry
tombstones so late requests cannot recreate it.

## Authoring and native tools

The `artifact-designer` skill is lazy design guidance. Authors use their existing
file read/write/edit tools, with no shell requirement, to create a regular UTF-8
HTML file under `/workspace/agent/` or edit a checked-out inbox file. Include
styles, scripts, SVG and data assets inline. Aim for ordinary markup around
32 KiB; the hard single-document limit is 4 MiB including real data and images.
Preserve the information within that limit instead of truncating it.

Canonical main gains the capability when the assistant enables it. Other eligible
groups require explicit `artifacts` selection, with file-read/write permissions
for authoring. Sealed browser and external-message agents do not inherit it.
Workers manage their own artifacts and hand references to main; main can oversee
assistant-owned content and handles external sharing. Current host authority is
checked on every request, including stale schemas after revocation or retirement.
For a group with a custom skill selection, include `artifact-designer` in that
existing selection as well; selecting `artifacts` does not override a custom
skill list. Main's release reconciliation includes the design skill automatically.

| Tool              | Native contract                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `artifact_save`   | Create with stable `create_key`, `title`, `file`; revise with `artifact_id` and `expected_revision`; optionally require exact source bytes with `expected_hash`; return IDs, hash, bytes, generation and private URL     |
| `artifact_read`   | Return scoped metadata; `checkout: true` writes the selected revision to this session's inbox; `revision` selects an older source without exposing a later private title                                                 |
| `artifact_list`   | Scoped metadata only; `limit` is 1–100, default 20; pass `next_cursor` as `after`; main receives named share counts by stored state and the public slot as `share_summary`, without recipient/history expansion          |
| `artifact_share`  | Main-only closed union: `named_publish`, `public_publish`, `named_replace`, `public_replace`, `revoke`; select an exact revision/hash and audience; replacements/revocation require `share_id` and `expected_generation` |
| `artifact_delete` | Delete owned content and access with the current artifact `expected_generation`; main may act across authors                                                                                                             |

Main's `artifact_read` returns one complete sharing grant in `shares`, including
its exact recipients, revision/hash, state, generation, expiry and URL. Pass its
`shares_next_cursor` as `shares_after` to continue; a null cursor ends the list.
This pages metadata without imposing a share-count or retention cap. Every
recipient remains retrievable. Counts describe stored states; expiry and current
policy still determine usable access.

Host operations use the existing two-mailbox request/answer path and guarded
delivery actions. A timeout does not cancel a mutation: use `request_status`
with the returned request ID before retrying. Exact request results are journaled
with authenticated session identity and fingerprints. Creation keys prevent
duplicate objects across new request IDs; revisions use head compare-and-swap.
Saving, publishing and serving artifacts launch no browser. Saving and viewing
require no model or Cloudflare management call. The host validates saved HTML;
real-browser tests verify the viewer’s rendering and isolation boundary.

## Privacy and viewer boundary

Sharing requires the principal's instruction for the exact saved revision,
audience, recipients and expiry. A recent authenticated principal-message mark
proves provenance; main still judges its meaning. Registered private values are
checked against complete immutable source, including comments, attributes, SVG
and scripts. A clearance for another message or audience does not transfer.
Existing privacy approval handles detected details requiring confirmation.
Encoded/constructed values and rasterized text remain matcher limitations.

The host parses with `parse5` and rejects remote assets, forms, frames and other
unsupported surfaces. A trusted wrapper hosts an opaque sandboxed child and
restrictive CSP. The child receives enforced empty `Connection-Allowlist`.
Authored scripts start only after supported-engine/version checks and a
non-egressing enforcement probe verify the browser's control. CSP or request
interception alone is not that proof. HTTPS source anchors become exact targets
in a trusted parent control for deliberate reader navigation.

The loopback origin validates configured host, canonical path and current local
object state on every GET/HEAD, including each hash-pinned child response. Private
and named routes verify the expected issuer, RS256 signature, application AUD,
time claims and email through `jose`; only the configured issuer provides JWKS.
An assertion for one assistant cannot authorize another. Every content/error
response uses `no-store`. Current principal removal, grant revocation, expiry and
capability disablement win over an otherwise valid unexpired JWT. Offline JWT
verification cannot discover external session revocation by itself.

## Recovery and verification

Use `capabilities show artifacts --id …` for local observation and `check` for
bounded verification; neither repairs. Optional startup failure leaves ordinary
conversation available. The origin stays unavailable until Access prerequisites
and its local listener are verified. New named admission can remain pending;
native request status reports the eventual outcome. Revoke/delete/disable during
an in-flight update cannot be undone by its late response.
Publication also waits for completed operator activation, including verified
ingress and an active connector. A local listener alone cannot settle it as
usable. If activation is interrupted, `check` reports it and `enable` resumes
verification before publication can proceed.

Central-data snapshots contain immutable HTML and pointers. Update/restore
reconciles remote intent before serving; unknown policy compatibility fails
closed. Disable preserves content and namespace. Removal follows the assistant's
owned-resource receipt, retaining shared Tunnel, DNS and PIN resources while
other assistants need them. Inspect any reported unproven create rather than
identifying ownership by a friendly name. Only after removing its possible
resource should the operator acknowledge that exact attempt.

Focused host suites live in `src/modules/gws-ea-artifacts/`; runner suites live
in `container/agent-runner/src/artifacts/` and the artifact MCP tests. Browser
fixtures honor `ARTIFACT_TEST_CHROMIUM`, then `GWS_EA_BROWSER_TEST_CHROME`, then
conventional installed Linux/macOS Chrome paths. An explicitly missing executable
fails the fixture instead of silently skipping it. CI supplies Chrome to both
host and runner suites.

The opt-in `native.test.ts` runs the actual Linux source reader and two-mailbox
tools in a disposable image with Bun and Chromium, host UID/GID mapping,
read-only root/source/dependencies, temporary session mounts and no network.
It creates no service and removes only its exact owned container IDs. Set
`GWS_EA_ARTIFACT_NATIVE_IMAGE` to a compatible local image and optionally
`GWS_EA_ARTIFACT_EVIDENCE_DIR` to a temporary output directory, then run:

```sh
pnpm exec vitest run src/modules/gws-ea-artifacts/native.test.ts
```

This fixture uses synthetic JWT signing keys/JWKS and substitutes remote guest
admission. It proves local authorization and native execution, not Cloudflare
PIN sign-in, live path overrides, tunnel delivery, identity seats or remote
resource cleanup. Those require a separately owned disposable Cloudflare setup.

Before deployment, complete that live check with two disposable assistants:
sign in with every principal address, verify exact named-guest access and
cross-assistant denial, open public snapshots without signing in, then withdraw
access while retaining an old session. Verify `no-store`, namespace collisions,
Tunnel delivery and last/non-last assistant cleanup. The PR's local acceptance
does not replace this deployment gate.
