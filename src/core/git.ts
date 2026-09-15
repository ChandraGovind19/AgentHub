import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../types/index.js';
const exec = promisify(execFile);
let selectedGit: Promise<string> | undefined;
export function gitExecutable(): Promise<string> {
    return selectedGit ||= (async () => {
        if (process.env.AGENTHUB_GIT) return process.env.AGENTHUB_GIT;
        if (process.platform === 'darwin') {
            const supportsRemove = (v: string) => { const m = v.match(/(\d+)\.(\d+)/); return !!m && (Number(m[1]) > 2 || Number(m[1]) === 2 && Number(m[2]) >= 17); };
            try { if (!supportsRemove((await exec('git', ['--version'])).stdout) && supportsRemove((await exec('/usr/bin/git', ['--version'])).stdout)) return '/usr/bin/git'; } catch { /* Default Git below reports any availability error. */ }
        }
        return 'git';
    })();
}
export async function git(root: string, args: string[]) { return (await exec(await gitExecutable(), ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 30000 })).stdout; }
export function parseStatus(raw: string): GitState['changes'] {
    const records = raw.split('\0');
    const result: GitState['changes'] = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record)
            continue;
        const status = record.slice(0, 2);
        const file = record.slice(3);
        const original = /[RC]/.test(status) ? records[++i] : undefined;
        if (file === '.agenthub' || file.startsWith('.agenthub/'))
            continue;
        result.push({ status, file, ...(original ? { original } : {}) });
    }
    return result;
}
export async function gitState(root: string): Promise<GitState> {
    const empty: GitState = { available: true, repository: false, branch: '(no repository)', changes: [], stagedStat: '', unstagedStat: '' };
    try {
        await exec(await gitExecutable(), ['--version']);
    }
    catch {
        return { ...empty, available: false };
    }
    try {
        await git(root, ['rev-parse', '--show-toplevel']);
    }
    catch {
        return empty;
    }
    let branch: string;
    try {
        branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim();
    }
    catch {
        branch = `detached ${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()}`;
    }
    const scope = ['--', '.', ':(exclude).agenthub'];
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const [raw, stagedStat, unstagedStat] = await Promise.all([
        git(root, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', ...scope]),
        git(root, ['diff', '--cached', '--stat', ...scope]), git(root, ['diff', '--stat', ...scope])
    ]);
    return { available: true, repository: true, branch, changes: parseStatus(raw).map(c => ({ ...c, file: prefix && c.file.startsWith(prefix) ? c.file.slice(prefix.length) : c.file, ...(c.original ? { original: prefix && c.original.startsWith(prefix) ? c.original.slice(prefix.length) : c.original } : {}) })).filter(c => c.file !== '.agenthub' && !c.file.startsWith('.agenthub/')), stagedStat, unstagedStat };
}
export function renderChanges(g: GitState): string {
    if (!g.repository)
        return `# Current Git Changes\n\n${g.available ? 'No Git repository. Task, memory, and handoff commands still work.' : 'Git is unavailable. Install Git to include change metadata.'}\n`;
    return `# Current Git Changes\n\nBranch: ${g.branch}\n\n## Changed Files\n\n${g.changes.map(c => `- ${JSON.stringify(c.file)} [${c.status}]${c.original ? ` (from ${JSON.stringify(c.original)})` : ''}`).join('\n') || 'Working tree clean (excluding .agenthub metadata).'}\n\n## Staged Diff Stat\n\n${g.stagedStat || '(none)'}\n## Unstaged Diff Stat\n\n${g.unstagedStat || '(none)'}\n## Suggested Handoff Note\n\nInspect changed files before editing overlapping work. Git metadata does not identify which agent made a change. Untracked file contents are not included in diff statistics.\n`;
}
