#!/bin/sh
# Creates only disposable local repositories. Does not touch the system clipboard.
set -eu
SOURCE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEMO_PARENT=$(mktemp -d "${TMPDIR:-/tmp}/agenthub-v02-demo.XXXXXX")
mkdir "$DEMO_PARENT/project"
cd "$DEMO_PARENT/project"
ah() { node "$SOURCE_ROOT/dist/index.js" "$@"; }
git init -q
printf '.agenthub/\n' > .gitignore
printf 'AgentHub v0.2 demo\n' > README.md
git add .gitignore README.md
git -c user.name=AgentHubDemo -c user.email=demo@example.invalid commit -qm initial
ah init
ah task create "Add greeting" --files greeting.js
ah task assign task_001 codex
ah lock greeting.js --agent codex --task task_001
ah worktree create codex
ah handoff codex --quiet
WORK_DIR="$DEMO_PARENT/project-agenthub-codex"
printf 'console.log("AgentHub v0.2 works");\n' > "$WORK_DIR/greeting.js"
node "$WORK_DIR/greeting.js"
git -C "$WORK_DIR" add greeting.js
git -C "$WORK_DIR" -c user.name=AgentHubDemo -c user.email=demo@example.invalid commit -qm "Add greeting"
ah worktree status
ah review codex --save
cat > summary.md <<'SUMMARY'
## Summary of Changes
- Added and executed the greeting script.
## Files Modified
- greeting.js
## Important Decisions
- Use a plain Node script for the demo.
## Follow-up Tasks
- Document the greeting script
## AgentHub Memory Updates
- The greeting was validated locally.
SUMMARY
ah ingest summary.md --agent codex --task task_001 --extract --dry-run
ah ingest summary.md --agent codex --task task_001 --extract
ah complete task_001 --note "Validated with Node" --unlock
ah sync
ah resume
ah doctor
ah worktree remove codex
printf '\nDemo retained at: %s\nAgent branch retained for manual review/merge.\n' "$DEMO_PARENT/project"
