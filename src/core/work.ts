import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Hub } from './hub.js';
import { exclusive, exists, json, now, readJson, stamp, write } from './storage.js';
import { git, gitState } from './git.js';
import { nativeAgent } from './agent-config.js';
import { nativeTranscript, renderTranscript, cleanTerminalOutput, briefing } from './transcripts.js';
// Work sessions model the primary AgentHub use case: one shared checkout, one agent at a time.
// When Claude Code hits its usage limit, Codex continues from the same journal and diff, and vice versa.
export interface WorkSession { id: string; agent: string; taskId: string | null; mode: string; startedAt: string; endedAt: string | null; head: string | null; workdir: string }
interface WorkState { sessions: WorkSession[] }
export const journalFile = (hub: Hub) => hub.p('memory', 'journal.md');
const journalHeader = '# Work Journal\n\nShared running log for Claude Code and Codex. Newest entries at the bottom. Each agent appends short entries while it works and a final `## Handoff` entry before stopping.\n';
export const display = (agent: string) => agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent;
export const otherAgent = (agent: string) => agent === 'claude' ? 'codex' : 'claude';
const clipEnd = (s: string, n: number) => s.length > n ? '[earlier entries omitted]\n' + s.slice(-n) : s;
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + '\n[truncated]' : s;
export async function readWork(hub: Hub): Promise<WorkState> {
    if (!await exists(hub.p('work.json'))) return { sessions: [] };
    const value = await readJson<WorkState>(hub.p('work.json'));
    if (!value || !Array.isArray(value.sessions) || value.sessions.some(s => !s || typeof s.id !== 'string' || typeof s.agent !== 'string' || typeof s.startedAt !== 'string')) throw new Error('Invalid work.json. Run agenthub doctor.');
    return value;
}
export async function readJournal(hub: Hub) { return await exists(journalFile(hub)) ? fs.readFile(journalFile(hub), 'utf8') : ''; }
export async function chooseAgent(hub: Hub, requested?: string) {
    if (requested) { nativeAgent(requested); return { agent: requested, reason: 'requested' }; }
    const last = (await readWork(hub)).sessions.at(-1);
    if (last) return { agent: otherAgent(last.agent), reason: `${display(last.agent)} worked last, ${last.startedAt}` };
    const preferred = (await hub.config()).defaultAgent;
    return { agent: ['claude', 'codex'].includes(preferred) ? preferred : 'claude', reason: 'first work session' };
}
async function headOf(dir: string) { try { return (await git(dir, ['rev-parse', 'HEAD'])).trim(); } catch { return null; } }
export async function workPrompt(hub: Hub, agent: string, taskId?: string | null, workdir = hub.root) {
    nativeAgent(agent);
    const previous = (await readWork(hub)).sessions.at(-1);
    const task = taskId ? (await hub.tasks()).find(t => t.id === taskId) : undefined;
    if (taskId && !task) throw new Error(`Unknown task ${taskId}. Run agenthub task list.`);
    if (!await exists(journalFile(hub))) await write(journalFile(hub), journalHeader);
    const journal = clipEnd(await fs.readFile(journalFile(hub), 'utf8'), 8000);
    const state = await gitState(workdir);
    const status = state.repository ? state.changes.slice(0, 80).map(c => `${c.status} ${c.file}`).join('\n') || '(clean working tree)' : '(no Git repository)';
    let since = '';
    if (previous?.head && state.repository) {
        try {
            const commits = (await git(workdir, ['log', '--oneline', '--no-decorate', `${previous.head}..HEAD`])).trim();
            const stat = (await git(workdir, ['diff', '--stat', previous.head, '--', '.', ':(exclude).agenthub'])).trim();
            since = `\n## What changed since ${display(previous.agent)}'s session started\n\nCommits:\n${commits || '(none)'}\n\nFiles (committed and uncommitted):\n${clip(stat, 4000) || '(none)'}\n`;
        } catch { since = '\n## What changed since the previous session\n\n(The previous session\'s baseline commit is no longer reachable; rely on the journal and git log.)\n'; }
    }
    const project = clip(await fs.readFile(hub.p('project.md'), 'utf8'), 3000);
    const recovered = previous ? await recoverSession(hub, previous) : '';
    const taskSection = task ? `## Task\n\n${task.id}: ${task.title}\n${task.description}\nStatus: ${task.status}\nFiles: ${task.files.join(', ') || '(not scoped)'}\n${task.notes.length ? `Recent notes:\n${clip(task.notes.slice(-3).join('\n'), 1500)}\n` : ''}\n` : '';
    return `# AgentHub work session — you are ${display(agent)}

This checkout is shared by Claude Code and Codex, used one at a time: when one hits its usage limit, the other continues. ${previous ? `The previous session was ${display(previous.agent)}, started ${previous.startedAt}${previous.endedAt ? `, ended ${previous.endedAt}` : ''}.` : 'This is the first session.'} Pick up exactly where the journal leaves off. Do not redo finished work.

## How to work in this session

1. Read the journal below, then inspect the working tree (git status, git diff) before changing anything.
2. As you work, append short entries to .agenthub/memory/journal.md: what changed, why, and what is next. Append only; never rewrite earlier entries.
3. Whenever you finish a meaningful step, append a short entry. If you notice your context or usage limit approaching, or the user says "handoff", append a final entry titled "## Handoff — ${display(agent)} — <ISO time>" with: current state, uncommitted files, exact next steps, open questions. If you run out before you can, that is fine: AgentHub hands your session log and the diff to ${display(otherAgent(agent))} automatically.
4. Do not modify anything else under .agenthub/ and do not set up other coordination files.

## Project

${project}
${taskSection}## Journal (most recent entries)

${journal}

## Working tree right now (${workdir})

${status}
${since}${recovered}
Begin by stating in one or two lines what you understand the current state to be, then continue the work.`;
}
// What the previous agent actually did, without asking it: its native session log, else the dashboard's captured terminal output.
async function recoverSession(hub: Hub, previous: WorkSession) {
    const name = display(previous.agent);
    try { const transcript = await nativeTranscript(previous.agent, previous.workdir, previous.startedAt, previous.endedAt); if (transcript) return `\n## What ${name} did last session (recovered from its session log; it may have stopped mid-task)\n\n${briefing(transcript, name)}\n\nConversation tail:\n${renderTranscript(transcript, name)}\n`; } catch { /* Best effort. */ }
    try {
        const sessions = hub.p('sessions'); if (!await exists(sessions)) return '';
        for (const entry of (await fs.readdir(sessions)).sort().reverse()) {
            const meta = await readJson<{workId?: string}>(path.join(sessions, entry, 'metadata.json')).catch(() => null);
            if (meta?.workId !== previous.id) continue;
            const log = path.join(sessions, entry, 'transcript.log'); if (!await exists(log)) return '';
            const tail = cleanTerminalOutput((await fs.readFile(log, 'utf8')).slice(-12000)).slice(-4000);
            return tail ? `\n## Last terminal output from ${name} (captured by the dashboard; TUI redraws removed)\n\n${tail}\n` : '';
        }
    } catch { /* Best effort. */ }
    return '';
}
export async function beginWork(hub: Hub, agent: string, taskId: string | null | undefined, workdir: string, mode: 'work' | 'dashboard-terminal') {
    return exclusive(hub.root, async () => {
        const work = await readWork(hub);
        const session: WorkSession = { id: `work_${stamp()}`, agent, taskId: taskId || null, mode, startedAt: now(), endedAt: null, head: await headOf(workdir), workdir };
        work.sessions = [...work.sessions.slice(-49), session];
        await json(hub.p('work.json'), work);
        await hub.log('work_started', `${display(agent)} started${taskId ? ` on ${taskId}` : ''} in ${workdir}`, agent);
        return session;
    });
}
export async function endWork(hub: Hub, id: string) {
    return exclusive(hub.root, async () => {
        const work = await readWork(hub); const session = work.sessions.find(s => s.id === id);
        if (!session || session.endedAt) return;
        session.endedAt = now(); await json(hub.p('work.json'), work);
        await hub.log('work_ended', `${display(session.agent)} session ended. Next: agenthub work (${display(otherAgent(session.agent))})`, session.agent);
    });
}
