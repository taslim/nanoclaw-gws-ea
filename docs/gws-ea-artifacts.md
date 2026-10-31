# HTML artifacts

An artifact is one saved HTML information view: a brief, comparison, explanation,
plan or local calculator. The principal requests it in conversation and receives
a private link. The assistant authors a self-contained document using its normal file tools
and design guidance, then saves it through the native artifact tools.

All essential information is present in the initial document. Local scripts may
filter, sort or calculate embedded information. They cannot submit data, send
messages, command an agent or perform account actions. A browser without verified
network isolation receives the complete static view, with a note that the
controls work in Chrome on a computer or an Android phone. A document without
authored script is served with no script at all: its links open in a new tab in
one tap, and it may carry `tel:` (a number only) and `mailto:` (one address,
nothing else) links.

## Operation and access

Install the optional `web` connector host-wide through the
[operator CLI](gws-ea-cli.md#assistant-web). It verifies and records one Cloudflare
account, Access team and active zone, then provisions a shared Named Cloudflare
Tunnel and a separate DNS record and Access application for each compatible
running assistant with a complete profile. The address also serves the
principal-only `/logins` page for browsing logins by site, adding and removing
them, and editing their labels, websites, usernames or saved passwords; it never
reveals a password. There is no artifacts connector
or second activation step.

Before updating an existing web install to this release, run
`gws-ea connectors uninstall web` using the **current checkout**. Then pull the
release, run `bash gws-ea.sh`, run `gws-ea update --all`, and install web again
with `gws-ea connectors install web` and its setup options. The previous
artifacts-only Cloudflare route is intentionally refused because it leaves
`/logins` outside Access. Local saved HTML and logins survive the uninstall.

Verify with `gws-ea connectors check web --id <instance_id>` and open `/logins`
as the principal. To roll back to the older route contract, first uninstall web
using the currently installed new checkout, then return to the older version,
reinstall web there and run its readiness check.

An assistant named Aya claims `aya.example.com` on zone `example.com`. Its first
name uses the shared ASCII reduction, capped at 63 characters, with no suffix or
override. The claim survives renames. An unusable name or a duplicate leaves web
pending with the reason and holder; recreate under another first name or remove
the holder. A foreign exact or wildcard DNS record, Access destination or tunnel
route leaves the name unclaimed until the operator resolves it. Other setup
prerequisites remain pending; create, resume, update, start and restart retry
installed web setup. A repeated install verifies a ready assistant without
restarting its authors.

Only canonical `/artifacts` routes reach the artifact feature, using GET and
HEAD. The host separately handles `/logins` for the current principal alone.
Root, unknown paths, encoded aliases and another Host serve no content.
Cloudflare Access protects the whole hostname; public artifact snapshots keep
their explicit public route.

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

| Link | Content and authority |
| --- | --- |
| `/artifacts/<artifact_id>` | Current private head; current principal addresses only |
| `/artifacts/share/<share_id>` | The granted revision; its exact active named audience or a current principal |
| `/artifacts/public/<publication_id>` | The selected active public revision |

A guest cannot browse drafts, history, another artifact or a listing. A private
edit does not alter a named grant or public snapshot. Explicit replacement names
the new revision and current share generation. A public replacement preserves its
public URL. Withdrawal, deletion, expiry and connector uninstall stop origin access;
copies already downloaded cannot be recalled.

There is no default expiry and no implicit upkeep schedule. A later source change
requires a deliberate revision. An artifact's requested expiry also bounds its
shares. Delete removes source and access together, retaining only minimal retry
tombstones so late requests cannot recreate it.

## Authoring and native tools

The `artifact-designer` skill is lazy design guidance. It holds principles for
the reader and the information, a house `starter.html` page whose stylesheet
every page carries (authors with a shell copy it and fill its body; others
write it out whole), and element patterns read on demand. It deliberately has no
full-page examples, because models copy an example's surface. Authors use their
existing file read/write/edit tools, with no shell requirement, to create a
regular UTF-8 HTML file under `/workspace/agent/` or edit a checked-out inbox
file. Include styles, scripts, SVG and data assets inline. A typical page is
8–20 KB; the hard single-document limit is 4 MiB including real data and images.
Preserve the information within that limit instead of truncating it.

Canonical main gains the capability when web is provisioned for the
assistant. A temporary listener, tunnel or verification outage leaves authoring
available; uninstall, removal or confirmed ownership loss closes it. Other eligible groups require explicit `artifacts` selection, with file-read/write permissions
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
restrictive CSP. A document without authored script or inline handlers gets
`script-src 'none'` and a sandbox that only lets its own links open new tabs
(`allow-popups allow-popups-to-escape-sandbox`): with no script on the page,
nothing can follow a link without the reader, so its HTTPS, `tel:` and `mailto:`
anchors stay ordinary links opening in a new context. A scripted child gets
`sandbox allow-scripts` and an enforced empty `Connection-Allowlist`. Its authored
scripts start only after supported-engine/version checks and a non-egressing
enforcement probe verify the browser's control, during which the static notice
stays hidden. CSP or request interception alone is not that proof. Its HTTPS
source anchors become exact targets in a trusted parent control for deliberate
reader navigation, and it may not carry `tel:` or `mailto:` links. The wrapper
follows the reader's light or dark preference and the document's `lang`.

The loopback origin validates configured host, canonical path and current local
object state on every GET/HEAD, including each hash-pinned child response. Private
and named routes verify the expected issuer, RS256 signature, application AUD,
time claims and email through `jose`; only the configured issuer provides JWKS.
An assertion for one assistant cannot authorize another. Every content/error
response uses `no-store`. Current principal removal, grant revocation, expiry and
closed origin policy all override an otherwise valid unexpired JWT. Offline JWT
verification cannot discover external session revocation by itself.

## Recovery and verification

Use `connectors show web --id …` for local observation and `check` for
bounded verification; neither repairs. Optional startup failure leaves ordinary
conversation available. The origin stays unavailable until Access prerequisites
and its local listener are verified. New named admission can remain pending;
native request status reports the eventual outcome. Revoke/delete/uninstall during
an in-flight update cannot be undone by its late response.
Publication also waits for completed operator setup, including verified
ingress and an active connector. A local listener alone cannot settle it as
usable. If setup is interrupted, `check` reports it and `install` resumes
verification before publication can proceed.

Central-data snapshots contain immutable HTML and pointers. Update/restore
reconciles remote intent before serving; unknown policy compatibility fails
closed. `connectors uninstall web` closes every assistant origin before
any remote deletion, then removes verified owned per-assistant resources and
shared resources last. Issued links stop working. Local HTML content and
external PIN providers or unrelated tunnel routes remain. The host receipt
resumes interrupted cleanup, and provisioning waits until cleanup completes.
Per-assistant removal follows its separate owned-resource receipt and keeps
the shared connector, tunnel, PIN, configuration and tokens even when the last
assistant is removed. Only connector uninstall removes shared resources. Its
result instructs the operator to revoke the management token in Cloudflare and
remove the original credential file.

Inspect any reported unproven create rather than identifying ownership by a
friendly name. Only after removing its possible resource should the operator
acknowledge that exact attempt with `--discard-unproven`.

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
Tunnel delivery, per-assistant cleanup with shared resources retained, and
connector uninstall with shared resources removed. The PR's local acceptance
does not replace this deployment gate.
