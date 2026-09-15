import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const now = () => new Date().toISOString();
export const stamp = () => `${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
export async function exists(file: string) { try {
    await fs.access(file);
    return true;
}
catch {
    return false;
} }
export async function readJson<T>(file: string): Promise<T> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    }
    catch (e) {
        throw new Error(`Cannot read ${file}: ${(e as Error).message}. Run agenthub doctor; restore missing or corrupt state from backup.`);
    }
}
export async function write(file: string, value: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temp, value, { flag: 'wx' });
        await fs.rename(temp, file);
    }
    finally {
        await fs.rm(temp, { force: true });
    }
}
export async function json(file: string, value: unknown) { await write(file, JSON.stringify(value, null, 2) + '\n'); }
export async function discover(cwd: string): Promise<string> {
    let dir = path.resolve(cwd);
    while (true) {
        if (await exists(path.join(dir, '.agenthub')))
            return dir;
        const parent = path.dirname(dir);
        if (parent === dir)
            throw new Error('No initialized project found. Run agenthub init in your project root.');
        dir = parent;
    }
}
// Claims are directories recording the owning process. A claim whose owner no longer runs is stale and is
// reclaimed automatically, so a crashed or interrupted command never wedges later commands.
export type ClaimStatus = 'free' | 'active' | 'stale';
export async function claimStatus(dir: string): Promise<ClaimStatus> {
    let owner: { pid?: unknown } | undefined;
    try { owner = JSON.parse(await fs.readFile(path.join(dir, 'owner.json'), 'utf8')); }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'active';
        // No owner file: either a legacy lock, a crash between mkdir and write, or a claim being written right now.
        try { return Date.now() - (await fs.stat(dir)).mtimeMs > 30000 ? 'stale' : 'active'; } catch { return 'free'; }
    }
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return 'active';
    try { process.kill(pid, 0); return 'active'; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'active'; }
}
export async function claim(dir: string, busyMessage: string) {
    for (let attempt = 0; ; attempt++) {
        try { await fs.mkdir(dir); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            if (attempt === 0 && await claimStatus(dir) === 'stale') {
                // Rename first so only one process can take a stale claim; the loser sees EEXIST or ENOENT and reports busy.
                const stale = `${dir}.stale-${randomUUID()}`;
                try { await fs.rename(dir, stale); await fs.rm(stale, { recursive: true, force: true }); } catch { /* Reclaimed by another process. */ }
                continue;
            }
            throw new Error(busyMessage);
        }
        await fs.writeFile(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now() }));
        return;
    }
}
export const release = (dir: string) => fs.rm(dir, { recursive: true, force: true });
// Cross-process writer mutex.
export async function exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
    const lock = path.join(root, '.agenthub', '.write-lock');
    await claim(lock, 'AgentHub is being updated. Retry when the other command finishes. A lock left by a crashed command is reclaimed automatically.');
    try {
        return await action();
    }
    finally {
        await release(lock);
    }
}
