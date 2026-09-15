import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adapter } from '../adapters/index.js';
import type { ProjectContext } from './context.js';
import { git, gitState } from './git.js';
import { exists, exclusive, json, now, readJson } from './storage.js';
export interface Worktree { agent: string; branch: string; path: string; createdAt: string; updatedAt: string; identity: string }
interface GitWorktree { path: string; branch?: string; bare?: boolean }
export async function readWorktrees(hub: ProjectContext): Promise<Worktree[]> {
    if (!await exists(hub.p('worktrees.json'))) return [];
    const rows = await readJson<unknown>(hub.p('worktrees.json'));
    if (!Array.isArray(rows) || rows.some(w => !w || typeof w.agent !== 'string' || typeof w.branch !== 'string' || typeof w.path !== 'string' || !path.isAbsolute(w.path) || typeof w.identity !== 'string' || !w.identity || !Number.isFinite(Date.parse(w.createdAt)) || !Number.isFinite(Date.parse(w.updatedAt)))) throw new Error('Invalid worktrees.json. Run agenthub doctor and restore valid metadata.');
    for (const w of rows) adapter(w.agent);
    if (new Set(rows.map(w => w.agent)).size !== rows.length || new Set(rows.map(w => w.path)).size !== rows.length || new Set(rows.map(w => w.identity)).size !== rows.length) throw new Error('Duplicate worktree metadata. Run agenthub doctor.');
    return rows;
}
export async function gitWorktrees(root: string): Promise<GitWorktree[]> {
    const text = await git(root, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
    return text.trim().split('\n\n').filter(Boolean).map(block => {
        const lines = block.split('\n'); const name = lines.find(l => l.startsWith('worktree '))?.slice(9);
        if (!name || name.startsWith('"')) throw new Error('Unsupported quoted Git worktree path. Use worktree paths without control characters.');
        return { path: name, branch: lines.find(l => l.startsWith('branch '))?.slice(7), bare: lines.includes('bare') };
    });
}
async function canonical(file: string): Promise<string> {
    const suffix: string[] = []; let parent = path.resolve(file);
    while (!await exists(parent)) { const next = path.dirname(parent); if (next === parent) throw new Error(`Cannot resolve path ${file}`); suffix.unshift(path.basename(parent)); parent = next; }
    return path.join(await fs.realpath(parent), ...suffix);
}
function contains(parent: string, child: string) { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
async function repositoryRoot(hub: ProjectContext) {
    const version = (await git(hub.root, ['--version'])).match(/(\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 17) throw new Error('Git 2.17 or newer is required for worktree removal. Install a newer Git or set AGENTHUB_GIT to its executable.');
    let top: string;
    try { top = (await git(hub.root, ['rev-parse', '--show-toplevel'])).trim(); } catch { throw new Error('Worktrees require a Git repository. Initialize Git and create an initial commit first.'); }
    const root = await fs.realpath(hub.root);
    if (await fs.realpath(top) !== root) throw new Error('Worktree commands require AgentHub initialized at the Git repository root, not a nested project.');
    try { await git(root, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Error('Create an initial Git commit before creating worktrees.'); }
    return root;
}
async function safeTarget(root: string, input: string) {
    if (!input.trim() || /[\x00-\x1f\x7f]/.test(input)) throw new Error('Use a nonempty worktree path without control characters.');
    const target = await canonical(input);
    if (contains(root, target) || contains(target, root) || target.split(path.sep).some(p => p === '.agenthub' || p === '.git')) throw new Error('Worktree path must be outside the project and Git/AgentHub metadata, and cannot contain the project.');
    return target;
}
async function commonDir(root: string) { return fs.realpath(path.resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim())); }
async function administrativeDir(root: string) { return fs.realpath(path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim())); }
// A marker in Git's administrative directory binds our metadata to a worktree we created.
// No arbitrary directory is recursively deleted by AgentHub; removal is always delegated to Git.
export async function verifyWorktree(hub: ProjectContext, entry: Worktree) {
    const root = await repositoryRoot(hub); const target = await safeTarget(root, entry.path);
    if (target !== entry.path) throw new Error('Worktree path changed or now resolves through a different symlink. Refusing operation.');
    const registered = (await gitWorktrees(root)).find(w => w.path === target);
    if (!registered || registered.bare) throw new Error(`Worktree ${target} is not registered with this Git repository.`);
    if (registered.branch !== `refs/heads/${entry.branch}`) throw new Error(`Worktree branch differs from registered branch ${entry.branch}. Switch it back before continuing.`);
    if (!await exists(target)) throw new Error(`Worktree path is missing: ${target}. Restore it before continuing.`);
    if (await commonDir(target) !== await commonDir(root)) throw new Error('Worktree belongs to a different repository.');
    const admin = await administrativeDir(target); const common = await commonDir(root);
    if (!contains(path.join(common, 'worktrees'), admin) || admin === path.join(common, 'worktrees')) throw new Error('Refusing operation on a primary checkout.');
    const marker = await readJson<Worktree & { projectRoot: string }>(path.join(admin, 'agenthub-owner.json'));
    if (marker.projectRoot !== root || marker.identity !== entry.identity || marker.path !== target || marker.agent !== entry.agent || marker.branch !== entry.branch) throw new Error('Worktree ownership marker does not match AgentHub metadata. Refusing operation.');
    return target;
}
export async function createWorktree(hub: ProjectContext, agent: string, options: { path?: string; branch?: string } = {}) {
    adapter(agent);
    return exclusive(hub.root, async () => {
        const root = await repositoryRoot(hub); const rows = await readWorktrees(hub);
        if (rows.some(w => w.agent === agent)) throw new Error(`Agent ${agent} already has a worktree. Run agenthub worktree status.`);
        const branch = options.branch || `agenthub/${agent}`;
        if (branch.startsWith('-') || /[\x00-\x20]/.test(branch)) throw new Error('Invalid worktree branch name.');
        try { await git(root, ['check-ref-format', `refs/heads/${branch}`]); } catch { throw new Error(`Invalid worktree branch name: ${branch}`); }
        const requested = options.path ? path.resolve(root, options.path) : path.join(path.dirname(root), `${path.basename(root)}-agenthub-${agent}`);
        const target = await safeTarget(root, requested);
        const worktrees = await gitWorktrees(root);
        for (const w of worktrees) { const other = await canonical(w.path); if (contains(other, target) || contains(target, other)) throw new Error('Target overlaps an existing Git worktree.'); }
        try { const stat = await fs.lstat(requested); if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.readdir(requested)).length) throw new Error('Worktree target already exists and is not an empty directory.'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        let branchExists = false;
        try { await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); branchExists = true; } catch { /* New branch. */ }
        const time = now(); const entry: Worktree = { agent, branch, path: target, createdAt: time, updatedAt: time, identity: randomUUID() };
        await git(root, ['worktree', 'add', ...(branchExists ? [] : ['-b', branch]), target, ...(branchExists ? [branch] : ['HEAD'])]);
        // Keep a created worktree intact on bookkeeping failure so no user data can be lost.
        try {
            const admin = await administrativeDir(target);
            await json(path.join(admin, 'agenthub-owner.json'), { ...entry, projectRoot: root });
            await json(hub.p('worktrees.json'), [...rows, entry]);
            await hub.ensureAgent(agent);
            await hub.log('worktree_created', `${branch} at ${target}`, agent);
        } catch (error) { throw new Error(`Git created ${target}, but AgentHub bookkeeping failed: ${(error as Error).message}. Keep this directory and inspect git worktree list and .agenthub/worktrees.json before retrying.`); }
        return entry;
    });
}
export async function worktreeStatus(hub: ProjectContext) {
    const rows = await readWorktrees(hub);
    return Promise.all(rows.map(async entry => {
        const present = await exists(entry.path);
        try { await verifyWorktree(hub, entry); return { ...entry, exists: present, git: await gitState(entry.path) }; }
        catch (error) { return { ...entry, exists: present, error: (error as Error).message }; }
    }));
}
export async function removeWorktree(hub: ProjectContext, agent: string, force = false) {
    adapter(agent);
    return exclusive(hub.root, async () => {
        const rows = await readWorktrees(hub); const entry = rows.find(w => w.agent === agent);
        if (!entry) throw new Error(`No registered AgentHub worktree for ${agent}. Run agenthub worktree list.`);
        const target = await verifyWorktree(hub, entry);
        // Include ignored and AgentHub files: no local data should disappear silently.
        const dirty = await git(target, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']);
        if (dirty.trim() && !force) throw new Error('Worktree has uncommitted, untracked, or ignored files. Commit or preserve them first, or use --force to explicitly discard local data.');
        await git(hub.root, ['worktree', 'remove', ...(force ? ['--force'] : []), target]);
        await json(hub.p('worktrees.json'), rows.filter(w => w.agent !== agent));
        await hub.log('worktree_removed', `Removed ${target}; branch ${entry.branch} retained`, agent);
        return entry;
    });
}
