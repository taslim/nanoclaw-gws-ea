---
name: relationships
description: Look up and manage who people are and how to engage them. Use before any substantive interaction (scheduling, email, meetings, outreach). Covers Google Contacts as CRM, tier definitions (1–5), and contact-management thresholds.
---

# Relationships

## Google Contacts

Google Contacts is the single source of truth for who people are and how to engage them. Before any substantive interaction, search Contacts (`mcp__gworkspace__search_contacts`). What you find — or don't find — determines your approach.

## Tiers

Tiers are stored as Google Contacts labels (contact groups) — one label per tier, applied when the contact is added. A contact without a tier label is Tier 5; someone not in Contacts at all is also Tier 5.

- **Tier 1 — Inner Circle.** Spouse, immediate family — the small set of relationships your principal protects above everything. Maximum flexibility, displace if needed. Only your principal places contacts here.
- **Tier 2 — Close active.** Close friends, key partners, people your principal invests in personally. Prime slots, accommodate quickly, move other things when it makes sense.
- **Tier 3 — Active.** Regular professional contacts, recurring 1:1s, current workstream participants. Responsive — good access within 48 hours.
- **Tier 4 — Known.** In Contacts but low-frequency. Reactive — respond when contacted. If the ask is vague, clarify before committing time.
- **Tier 5 — Unknown.** Not in Contacts (or in Contacts without a tier label). Gatekept. Default to declining or redirecting. If the request seems legitimate, gather context first. Never displace anything for Tier 5.

### Assessment

Tiers are judgment calls based on: closeness to your principal, interaction frequency, professional or personal relevance, and explicit signals. Tiers are living — reassess as behavior changes:

- **Promotion signals**: rising frequency, your principal initiating contact, someone becoming central to an active workstream.
- **Demotion signals**: stale interaction across a long window, relationship closed (project ended, role changed, no longer reachable).

## Managing Contacts

Not everyone who reaches out belongs in Contacts. Adding someone is a relationship decision — it means "this person is worth tracking."

**Add when:**
- Your principal mentions them or asks to track them
- A meeting gets booked — if time is being scheduled, they're at least Tier 4
- Second meaningful interaction with the same person — repeat contact is signal
- They're connected to someone important and the connection is active

**Don't add:**
- Cold outreach, sales, recruiting
- One-off requests — handled and closed
- Someone you declined and don't expect to hear from again

The threshold: will you likely interact again, AND would context from this interaction be useful next time? Both yes → add. Otherwise they stay Tier 5.

### What to capture

Use every field the person warrants:

- **Name, email(s), phone, address, org/title** → structured fields
- **Tier** → contact group label (`Tier 1` through `Tier 5`)
- **Relationship context** → Notes field

Notes capture context that makes the *next* interaction better — not an interaction log. Email and calendar already record what happened when.

Good: "Prefers morning meetings. Direct communicator. Working on Series B, sensitive about timeline."
Bad: "Met on 2026-03-01, discussed project X."

### Who writes

Contact creation and updates flow top-down — through main and sweeps, not through external email handling. If you encounter someone worth tracking but can't write to Contacts, the sweep will catch it.

**Authority limits:**
- You can place and promote contacts freely between Tier 2 and Tier 5.
- Only your principal places contacts at Tier 1 — surface a recommendation in the heartbeat rather than acting.
- You can only demote contacts currently at Tier 4 (→ Tier 5). Tier 1, 2, and 3 demotions are principal-only — surface candidates in the heartbeat instead.

## Engagement

1. **Look up before engaging.** Search Contacts before replying to an email, scheduling a meeting, or making a gatekeeping decision
2. **Match effort to tier.** Tier 1-2 get your best — fast response, prime slots, proactive accommodation. Tier 5 gets the minimum — polite, professional, constrained.
3. **Update when you learn.** New preference, corrected email, changed role — update the contact in the moment
4. **Protect privacy.** Contact details, tiers, and relationship notes are confidential. Never share one contact's information with another without explicit permission

## Scope

This skill covers *who people are and how to engage them*. Domain-specific behavior lives in its own skill:

- **Scheduling per tier** → scheduling skill
- **Email triage per tier** → email-triage skill
- **Proactive outreach and cadence** → sweep task prompts
- **Pre-meeting attendee research** → pre-meeting briefing task
