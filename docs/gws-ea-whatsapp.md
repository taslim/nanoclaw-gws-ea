# WhatsApp and group chats

Each assistant uses its own WhatsApp number, different from the principal’s. A
number can belong to only one assistant on this machine. Google Chat remains
available while WhatsApp is being linked or needs a fresh link.

## Link an account

The principal can ask their assistant in their Google Chat DM to connect
WhatsApp, giving both phone numbers with country codes. The assistant returns a
pairing code. On the assistant’s phone, open WhatsApp’s **Linked devices**, choose
to link with a phone number, and enter that code before it expires. The pairing
window is three minutes; an expired attempt needs a fresh code. If WhatsApp
already authenticated the account before its connection opens, the host retains
those credentials and completes the normal native reconnect instead.

After the account connects, the assistant supplies a second, short binding
code. The principal sends that code from their own WhatsApp number to the
assistant’s number within 30 minutes. Until this proof arrives, the host holds
that number’s messages and sends it no private reply. Forwarded codes do not
prove ownership. A valid proof releases the earlier held messages once.

The operator can also begin linking from the checkout:

```sh
gws-ea whatsapp link --id <instance-id> --number +15550000000 --principal-number +447700900123
```

These are operator commands. The principal uses their conversation with the
assistant and does not need commands or agent names.

## Observe and recover a link

```sh
gws-ea whatsapp status --id <instance-id>
gws-ea status --id <instance-id>
gws-ea status --id <instance-id> --details
gws-ea status --id <instance-id> --json
```

Status lists the WhatsApp state and number, the shared chat agent, and every job
agent’s chat, lifecycle state, and observed health. Health checks read the actual
stored and effective capabilities and the current gateway identity and secret
assignments. An identity with `all` secrets, an extra policy capability, or a
non-model credential is degraded. An observation that cannot complete is
unknown; it does not hide other agents. A retired job is healthy when its gateway
identity is absent or selective with no credentials.

- `unlinked`: there is no active account link.
- `linking`: a pairing attempt is waiting for the phone.
- `connected`: the account connected; a new principal must still complete binding
  if the separate WhatsApp status says binding is pending.
- `needs-relink`: the linked device was logged out. Status retains its number.
  The assistant tells the principal once in Google Chat and waits for their
  reply before requesting another pairing code.

A re-link keeps the existing assistant number and principal proof. The operator
requests one without either number:

```sh
gws-ea whatsapp link --id <instance-id>
```

To change either number or the bound principal, unlink first, then link with both
new numbers and complete a fresh binding proof. A changed principal phone number
cannot inherit their old binding.

```sh
gws-ea whatsapp unlink --id <instance-id>
```

Unlink withdraws that WhatsApp identity’s owner privilege, membership, and main
wiring. It keeps conversation history, first-contact restrictions, refusals,
notices, and accepted send receipts. An interrupted unlink resumes without
forgetting a completed native sign-out.

## Updates, rollback, and private state

All account state lives under the assistant’s
`<instance-root>/secrets/whatsapp/`, outside `state/`:

| File              | Contents                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| `auth.sqlite`     | Baileys credentials, Signal keys, and account-specific native sign-out proof |
| `link.json`       | Account numbers, principal identity, exact proof time, and linking state     |
| `messages.sqlite` | Durable incoming messages and pending/completed logical send receipts        |
| `contacts.sqlite` | First-contact admissions, rolling cap, time-lock, and refusals               |
| `notices.sqlite`  | Pending/delivered link notices and changed-number receipts                   |

These are host-only owner-readable files. Do not copy them into a release or
snapshot. Update and rollback leave the entire directory in place. Snapshot
restore quarantines central/session state while retaining the current account
state. Already accepted logical sends retain their receipts across a restore.

At startup the host reconciles the restored central binding against the current
private proof. It withdraws stale WhatsApp bindings, restores the current
principal’s exact proof epoch and main routing, and leaves Google Chat bindings
alone. A proof persisted just before a central write failed is completed on
retry; the principal does not need to prove it again. If the account was
unlinked after the snapshot, restoring that snapshot does not restore its
WhatsApp authority.

A snapshot rollback names job agents created since the snapshot and the chats
they served. Their gateway identities and grants remain as the rollback report
states. Startup reconciles registered live chat agents to the release shape,
preserving separately authorized job browser access. Creation or promotion does
not grant browser access to a job, and the shared chat agent cannot receive that
grant.

## Remove an assistant

Use the usual `gws-ea remove --id <instance-id>` flow. Removal first asks the
running host to perform its native WhatsApp unlink, before stopping that host.
If the host is stopped, fenced, or unavailable, removal stops and verifies that
exact instance and drains its containers through the existing teardown, then
opens a bounded sign-out-only Baileys connection using the retained credentials.
It never starts the full assistant for this purpose.

A successful native logout sends Baileys’ remove-companion-device operation and
closes the socket. Baileys exposes no separate server acknowledgment. A server
logged-out response is also proof that the device is gone. Generic
`needs-relink`, a connection error, or missing credentials is not logout proof.
New authenticated account credentials invalidate older proof, including when
re-linking the same number. An unregistered code attempt can retain an exact-account
logout proof because it has created no new device. An unregistered pending pairing can be discarded without a device
logout.

A failed native logout retains the account files and number claim; retry removal
after connectivity is restored. If registered credentials are missing, removal
cannot prove logout and stops with that reason. Removal records completed
teardown/sign-out durably, so a later cleanup failure can resume without sending
another logout. Once it finishes, the whole `secrets/whatsapp/` directory is
deleted and the number claim is released for another assistant. Other
assistants’ state and claims are untouched.
