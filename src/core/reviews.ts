import type { ProjectContext } from './context.js';
import { adapter } from '../adapters/index.js';
import { git, gitState, renderChanges } from './git.js';
import { readWorktrees, verifyWorktree } from './worktrees.js';
import { exclusive, stamp, write } from './storage.js';
const bullets = (items: string[]) => items.map(item => `- ${item}`).join('\n') || '(none)';
export async function review(hub: ProjectContext, agent: string, save = false) {
    adapter(agent);
    const build = async () => {
        const entry = (await readWorktrees(hub)).find(w => w.agent === agent);
        const locks = await hub.locks(); let text: string;
        if (!entry) {
            const state = await gitState(hub.root);
            const overlaps = state.changes.flatMap(c => [c.file, ...(c.original ? [c.original] : [])]).filter(f => Object.hasOwn(locks, f) && locks[f].owner !== agent);
            text = `# AgentHub Review: ${agent}\n\nNo registered worktree. Showing current project metadata; changes cannot be reliably attributed to this agent.\n\n${renderChanges(state)}\n## Conflict Warnings\n\n${bullets(overlaps.map(f => `${f}: locked by ${locks[f].owner}`))}\n\n## Suggested Next Steps\n\nInspect the current changes and run relevant tests. Use agenthub worktree create ${agent} for isolated future work. Merge manually only after review.\n`;
        } else {
            await verifyWorktree(hub, entry);
            const base = (await git(hub.root, ['rev-parse', '--verify', 'HEAD'])).trim();
            const head = (await git(hub.root, ['rev-parse', '--verify', `refs/heads/${entry.branch}`])).trim();
            let baseBranch: string;
            try { baseBranch = (await git(hub.root, ['symbolic-ref', '--short', 'HEAD'])).trim(); } catch { baseBranch = `detached ${base.slice(0, 12)}`; }
            const mergeBase = (await git(hub.root, ['merge-base', base, head])).trim();
            const scope = ['--', '.', ':(exclude).agenthub'];
            const [rawFiles, stat, commits, state] = await Promise.all([
                git(hub.root, ['diff', '--no-renames', '--name-only', '-z', mergeBase, head, ...scope]),
                git(hub.root, ['diff', '--stat', mergeBase, head, ...scope]),
                git(hub.root, ['log', '--format=%h %s', `${base}..${head}`, '--']),
                gitState(entry.path)
            ]);
            const changed = rawFiles.split('\0').filter(Boolean);
            const allFiles = [...new Set([...changed, ...state.changes.flatMap(c => [c.file, ...(c.original ? [c.original] : [])])])];
            const conflicts = allFiles.filter(f => Object.hasOwn(locks, f) && locks[f].owner !== agent).map(f => `${JSON.stringify(f)} is locked by ${locks[f].owner} (${locks[f].taskId}).`);
            text = `# AgentHub Review: ${agent}\n\n## Worktree\n\nPath: ${entry.path}\nBranch: ${entry.branch}\nBase: ${baseBranch} (${base.slice(0, 12)})\nMerge base: ${mergeBase.slice(0, 12)}\n\nCommitted changes are compared from the common ancestor to the agent branch. Uncommitted changes are shown separately.\n\n## Changed Files\n\n${bullets(changed.map(f => JSON.stringify(f)))}\n\n## Diff Stat\n\n${stat || '(none)'}\n\n## Commits\n\n${commits || '(none)'}\n\n## Uncommitted Changes\n\n${renderChanges(state)}\n## Conflict Warnings\n\n${conflicts.length ? bullets(conflicts) : 'No locked-file conflicts detected.'}\n\n## Suggested Next Steps\n\n1. Inspect the changed files and any conflict warnings.\n2. Run tests in ${entry.path}.\n3. Preserve uncommitted work, then merge manually only after review. This report does not prove merge safety.\n`;
        }
        if (!save) return { text };
        const file = hub.p('reviews', `${stamp()}-${agent}-review.md`);
        await write(file, text); await hub.log('review_saved', file, agent);
        return { text, file };
    };
    return save ? exclusive(hub.root, build) : build();
}
