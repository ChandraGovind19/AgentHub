# AgentHub desktop roadmap

The CLI is a client of the reusable `Hub` facade. v0.2 adds independent services for clipboard access, completion, ingest planning/application, Git worktrees and reviews. They depend on a narrow `ProjectContext` interface rather than the CLI. A desktop app can call these services with an authorized project root and display their structured results. v0.3 adds executable discovery, per-agent config and foreground native CLI attach. It does not control desktop apps or import native transcripts/usage.

## Build the desktop client incrementally

1. **Project dashboard and task board:** render tasks, advisory locks, memory, last activity and Git status. Complete tasks with a visible keep/release-lock choice. Keep coordination state in the original project, not copies of `.agenthub` inside worktrees.
2. **Handoff preview:** render Markdown as untrusted text, preview the target branch/directory and copy using the shared clipboard service. Add buttons to reveal/open the worktree folder in an editor. Future Codex/Claude open-folder buttons must use a documented, reliable public integration; otherwise show the path for manual opening.
3. **Ingest preview:** show the structured extraction plan, ignored paths, proposed decisions, follow-up tasks and durable notes. Apply the same service after review. Add content hashes/revision checks so an approval cannot apply to a changed file or project state. Re-import detection should precede batch imports.
4. **Worktree manager:** list recorded paths alongside live Git status. Surface ownership verification errors, branch changes and missing paths. Preview custom paths and branch names before creating. Removal should display local/ignored changes and require an explicit choice before discarding anything. Keep branches after removal.
5. **Review panel:** display merge-base diffs, commits, uncommitted changes and lock overlap warnings. Add a real code diff viewer and test results later. Keep merging manual until dedicated merge previews and recovery paths are implemented.

## Runtime and authorization

An Electron main process can import the TypeScript core; Tauri can use a local Node sidecar. Expose typed, validated IPC methods. Authorize each project root explicitly, and separately authorize external worktree destinations. Keep filesystem/subprocess access outside the renderer; never let rendered Markdown or imported summary text authorize commands. Do not expose a local server publicly. Use argument arrays for Git commands and do not shell-execute imported content.

Git worktree ownership is checked against an administrative marker plus central metadata. It is a guard against accidental mismatches, not a security boundary against an attacker with write access to the repository. Do not trust moved/tampered projects without revalidation. Worktree-local tracked AgentHub files are stale snapshots, not the live coordination store.

## Storage and later work

CLI writes use atomic per-file replacement and a writer mutex, but multi-file state updates and Git/JSON operations are not transactional. A process crash can leave partial state, and failed bookkeeping after creation intentionally preserves the worktree. Introduce transactional SQLite and operation recovery before background writers, automated cleanup or multi-project bulk actions. Add optimistic concurrency checks for GUI/manual memory saves, which currently bypass the mutex.

Later: smart switching, local MCP, opt-in merge previews, PR review, notifications, conversation import, attributable cost/token accounting and optional semantic summaries. Live agent sessions, desktop automation and automatic merging remain outside v0.4.

## Native-terminal product direction

Preserve the native Codex and Claude terminal UX rather than cloning their UI. Their slash commands, model/session controls, permission prompts and status displays remain native. AgentHub contributes coordination, worktree selection, local checkpoints and deterministic handoffs. Native authentication owns credentials; AgentHub does not store passwords, keys or fabricated limits.

- **v0.3 (implemented):** `agents`, `config agent`, foreground `attach`, session lifecycle metadata, and the simple `start` menu. Inherited terminal IO keeps the CLI usable; task context is saved for manual submission. No polling or waiting model processes are started.
- **v0.4 (implemented):** explicit automated `run`/`continue` through native automation commands, stdin prompts, streamed/captured output, bounded continuation context, session metadata, timeout handling, and guarded extract/review/sync. Failed sessions retain partial results. Work is not transferred or merged automatically.
- **v0.5 (implemented):** safe patch-based switching and explicit `switch --apply --continue`, reusing compact continuation and session logs. No slash bridge or committed-history transfer.
- **v0.6 (implemented):** `agenthub dashboard` / `agenthub ui` provides a local-only, read-only project control room, with tasks, agents, worktrees, sessions, switches, reviews and recommended copyable commands. It binds only to 127.0.0.1, serves scoped artifacts as plain text, and makes no model calls. Copyable commands keep execution explicit before adding browser actions.
- **v0.7A (implemented):** confirmed dashboard actions for sync, resume, review, run, continue, switch and completion. A fixed CLI allowlist, POST/session tokens, single-use confirmation and one action at a time preserve explicit execution. Logs and output stay local. No automatic paid calls or arbitrary shell execution.
- **v0.7B (implemented):** one embedded native terminal using optional node-pty and local xterm.js assets, protected POST/SSE I/O, resize, stop escalation, session metadata and shared attach preparation. Native slash commands and auth remain native; no prompt is submitted automatically or transcript saved. Dashboard actions are blocked while a terminal is active.
- **v0.7C (implemented):** dark control-room presentation with a sticky project header, responsive section navigation, consistent cards/tables/badges, clearer costly and completion actions, and terminal agent/task/worktree/status/elapsed context. This is a frontend-only refinement over the existing safety and orchestration paths.
- **v0.7E (implemented):** terminal fidelity refinements preserve ANSI color, cursor movement, redraw and alternate-screen behavior through local xterm.js. Each pane starts with its measured browser dimensions and a `xterm-256color`/truecolor environment, then forwards resize and raw key input to its PTY. Browser font metrics can still differ from a physical terminal; use a wide pane, 100% zoom, and a modern browser.
- **v0.7D (implemented):** two fixed embedded panes, left and right, with independent PTYs, output channels, controls, elapsed time and metadata. Claude and Codex can run side by side. At most two sessions are permitted; shared actions remain blocked while either is active. Shutdown stops both; no transcript capture or arbitrary command endpoint is added.
- **Future:** improved reconnect/state recovery and a desktop wrapper. Preserve native UI, explicit project/worktree authorization and local-only access; no private APIs or GUI automation. Unlimited terminal tabs remain out of scope.

The attach service separates planning/configuration from child launch and returns structured results. A future PTY transport can replace inherited stdio without changing coordination state. Live native conversation attachment/resumption, slash interception and background switching are not implemented yet. Automated prompt submission is available only through explicit run/continue commands. Closing a native session returns control to the menu; other agents stay unstarted.

## Automation transport and dashboard evolution

`run.ts` coordinates preparation and postprocessing, `runner-process.ts` owns child-process IO/timeouts, and `continuation.ts` builds bounded local context. Attach remains an independent inherited-terminal transport. A future dashboard can expose run plans, stream logs and display classifications without scraping or recreating the native CLI UI. Use PTYs for attach panels and captured streams for automation panels.

Require explicit selection before switching agents. Show the source and destination worktrees, unmerged changes, prompt preview and native permission settings. The current continuation starts a new native invocation, not a resumed conversation; do not label it as native session migration. Preserve checkpoints on failure and avoid automated retries after ambiguous exits, since work may already have happened. Host-crash recovery and transactional storage remain future work.
