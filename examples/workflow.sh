#!/bin/sh
# Run after npm install from anywhere. Uses a disposable project, retained for inspection.
set -eu
SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEMO_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agenthub-demo.XXXXXX")
cd "$DEMO_DIR"
ah() { node "$SOURCE_ROOT/dist/index.js" "$@"; }
git init -q
ah init
ah task create "Implement greeting" --files greeting.js
ah task assign task_001 codex
ah lock greeting.js --agent codex --task task_001
ah handoff codex
printf 'console.log("Hello from AgentHub");\n' > greeting.js
node greeting.js
ah ingest --text "Added greeting.js and verified it prints Hello from AgentHub." --agent codex --task task_001
ah task update task_001 --status done
ah unlock greeting.js
ah sync
ah resume
ah doctor
printf '\nDemo project: %s\n' "$DEMO_DIR"
