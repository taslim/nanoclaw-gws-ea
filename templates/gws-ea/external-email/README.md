# GWS-EA external-email

This Agent Plugins 1.0 template creates the `external-email` agent group: the part of a GWS-EA assistant that writes every email to someone other than the principal.

The host stamps it once, when it starts and the assistant's profile names no `external-email` group, and records the group beside `main`. Nobody stamps it by hand.

The template deliberately stamps nothing but this plugin: no persona, context, skills, MCP servers, or tasks. Its guidance ships with each release as a read-only section from the `gws-ea-external-email` module (`src/modules/gws-ea-external-email/guidance.md`), and its two names come from the `gws-ea-profile` module.

What the group may do is fixed by the host, not by this template: the `files-read`, `time`, `request-status`, `gws-ea-reminders` and `gws-ea-email-external` capabilities, no CLI, and no shared skills. That is its thread's email, scheduling and word to `main`, its own reminders, and reading the files that reached its thread, with no write tools and no memory shared between threads. The host refuses to start it if any of that changes.

The template carries no credentials, runtime selection, or deployment configuration.
