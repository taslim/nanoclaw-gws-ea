# GWS-EA main

This Agent Plugins 1.0 template creates the canonical `main` executive-assistant agent group.

Its always-loaded instructions establish the generic assistant/principal relationship and point to the detailed operating doctrine in `ai.nanoco.nanoclaw/context/additional_context/operating-doctrine.md`. Names and other instance identity come from runtime context; they are intentionally absent here.

Stamp the template through NanoClaw's existing local template path:

```bash
ncl groups create --template gws-ea/main
```

The template carries no tools, credentials, runtime selection, or deployment configuration.
