#!/bin/sh
set -eu
for module in document viewer; do
  source_path="src/modules/gws-ea-artifacts/$module.ts"
  target_path="container/agent-runner/src/artifacts/generated/$module.ts"
  if [ "${1:-}" = "--check" ]; then
    cmp -s "$source_path" "$target_path" || {
      echo "$target_path is stale; run pnpm artifact-viewer:generate" >&2
      exit 1
    }
  else
    mkdir -p container/agent-runner/src/artifacts/generated
    cp "$source_path" "$target_path"
  fi
done
