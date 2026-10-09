# GWS-EA main

This Agent Plugins 1.0 template creates the canonical `main` executive-assistant agent group.

It stamps only what `main` is made of. Its `welcome` skill runs the principal's first conversation: it asks them to share their calendars, then offers concrete work from what it can see. For `main`, it takes the place of NanoClaw's own `welcome`.

The template deliberately stamps no persona or context files. How a GWS-EA assistant works ships with each release as a read-only section from the `gws-ea-main` module (`src/modules/gws-ea-main/guidance.md`), and names and addresses come from the `gws-ea-profile` module. The template is stamped once, at create, and never again: anything that must change with a release ships in the module's guidance, skills or code. `main`'s persona file therefore belongs to the principal, and standing instructions they give the assistant live there.

Stamp the template through NanoClaw's existing local template path:

```bash
ncl groups create --template gws-ea/main
```

The template carries no credentials, runtime selection, or deployment configuration.
