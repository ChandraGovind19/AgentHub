import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Hub } from './hub.js';
import { adapter } from '../adapters/index.js';
import { gitExecutable } from './git.js';
import { readWorktrees, verifyWorktree } from './worktrees.js';
import { claimStatus, exclusive, json, now, stamp, write } from './storage.js';
import { completionFormat } from './continuation.js';
const exec = promisify(execFile);
// Even status must not refresh the index during a read-only preview.
async function git(root: string, args: string[]) {
    return exec(await gitExecutable(), ['-C', root, ...args], {
        env: {...process.env, GIT_OPTIONAL_LOCKS:'0'}, maxBuffer:16*1024*1024, timeout:30000
    });
}
const scope = ['--', '.', ':(exclude).agenthub'];
const statusArgs = ['status','--porcelain=v1','--untracked-files=all','--ignored'];
export interface SwitchOptions { from: string; to: string; apply?: boolean; dryRun?: boolean; includeUntracked?: boolean }
export async function switchTask(hub: Hub, taskId: string, options: SwitchOptions) {
    if (options.apply && options.dryRun) throw new Error('Choose --apply or --dry-run, not both.');
    adapter(options.from); adapter(options.to);
    if (options.from === options.to) throw new Error('Source and target agents must differ.');
    const perform = async () => {
        const task = (await hub.tasks()).find(t=>t.id===taskId);
        if (!task) throw new Error(`Unknown task ${taskId}. Run agenthub task list.`);
        const trees = await readWorktrees(hub);
        const source = trees.find(w=>w.agent===options.from), target = trees.find(w=>w.agent===options.to);
        if (!source) throw new Error(`Missing source worktree for ${options.from}.`);
        if (!target) throw new Error(`Missing target worktree for ${options.to}.`);
        const sourcePath = await verifyWorktree(hub,source), targetPath = await verifyWorktree(hub,target);
        for (const entry of (await fs.readdir(hub.p())).filter(f=>f.startsWith('.run-')&&!f.includes('.stale-'))) if (await claimStatus(hub.p(entry))==='active') throw new Error('An automation run is active. Stop it before transferring patches.');
        const [sourceStatus,targetStatus,untracked,unmerged,head,targetHead] = await Promise.all([
            git(sourcePath,statusArgs),git(targetPath,statusArgs),
            git(sourcePath,['ls-files','--others','--exclude-standard','-z',...scope]),
            git(sourcePath,['ls-files','--unmerged','-z']),
            git(sourcePath,['rev-parse','HEAD']),git(targetPath,['rev-parse','HEAD'])
        ]);
        if (targetStatus.stdout.trim()) throw new Error('Target worktree is dirty (including untracked or ignored files). Preserve its changes before switching.');
        if (unmerged.stdout) throw new Error('Source has unresolved conflicts. Resolve them before switching.');
        const untrackedFiles = untracked.stdout.split('\0').filter(Boolean);
        if (untrackedFiles.length && !options.includeUntracked) throw new Error(`Source contains untracked files: ${untrackedFiles.map(f=>JSON.stringify(f)).join(', ')}. Use --include-untracked, or stage intended new files with git add before switching; nothing was transferred.`);
        const base = head.stdout.trim();
        const [diff,names,stat] = await Promise.all([
            git(sourcePath,['diff','--binary','--full-index','--src-prefix=a/','--dst-prefix=b/','--no-ext-diff','--no-textconv','--no-renames',base,...scope]),
            git(sourcePath,['diff','--name-only','-z','--no-ext-diff','--no-textconv',base,...scope]),
            git(sourcePath,['diff','--stat','--no-ext-diff','--no-textconv',base,...scope])
        ]);
        let patch = diff.stdout;
        for (const file of untrackedFiles) {
            // `diff --no-index` exits 1 when the file has content; that output is the new-file hunk we want.
            try { patch += (await git(sourcePath,['diff','--no-index','--binary','--no-ext-diff','--no-textconv','--','/dev/null',file])).stdout; }
            catch (e) { const error = e as Error & {code?:unknown;stdout?:string}; if (error.code!==1||!error.stdout) throw new Error(`Cannot read untracked file ${file}: ${error.message}`); patch += error.stdout; }
        }
        if (!patch.trim()) throw new Error('Source worktree has no tracked changes to transfer. Committed branch history is not included.');
        if (/^index .* 160000$|^(?:new|deleted) file mode 160000$/m.test(patch)) throw new Error('Submodule changes are not supported by patch transfer.');
        const files = [...names.stdout.split('\0').filter(Boolean), ...untrackedFiles];
        const nextCommand = `agenthub continue ${taskId} --agent ${options.to} --worktree existing --review`;
        const prompt = (applied: boolean) => `# AgentHub Continuation Prompt\n\n## Task\n\n${task.id}: ${task.title}\n${task.description}\n\n## Patch Transfer\n\nSource: ${options.from} at ${sourcePath}\nSource HEAD: ${base}\nTarget: ${options.to} at ${targetPath}\n${applied ? 'Git apply exited successfully. Inspect and test the staged changes before continuing.' : 'Transfer preview or failed apply: do not assume the patch is present or conflict-free.'}\n\n## Recent Changed Files\n\n${files.map(f=>`- ${JSON.stringify(f)}`).join('\n')}\n\n## What Not To Redo\n\nThe patch covers tracked uncommitted changes relative to source HEAD, not committed branch history. Source changes are preserved. Check actual target files and existing locks; do not repeat already transferred work or merge automatically.\n\n## Your Job Now\n\nContinue only ${taskId} in ${targetPath}. Inspect project instructions and coordination memory at ${hub.p('memory')}. Respect advisory locks; assignment and ownership have not changed.\n\n## Required Completion Format\n\n${completionFormat}\n`;
        const preview = {taskId,from:options.from,to:options.to,source:sourcePath,target:targetPath,sourceHead:base,targetHead:targetHead.stdout.trim(),files,diffStat:stat.stdout+untrackedFiles.map(f=>` ${f} (untracked; new file)\n`).join(''),sourceStatus:sourceStatus.stdout,targetStatusBefore:targetStatus.stdout,nextCommand};
        if (!options.apply) return {dryRun:true,...preview,continuationPrompt:prompt(false)};
        const switchId = `switch_${stamp()}_${taskId}_${options.from}-to-${options.to}`;
        const folder = hub.p('switches',switchId);
        await fs.mkdir(folder,{recursive:true,mode:0o700});
        await write(path.join(folder,'source-status.txt'),sourceStatus.stdout);
        await write(path.join(folder,'target-status-before.txt'),targetStatus.stdout);
        await write(path.join(folder,'transfer.patch'),patch);
        await write(path.join(folder,'continuation-prompt.md'),prompt(false));
        const metadata = {switchId,...preview,startedAt:now(),endedAt:null as string|null,applied:false,exitCode:null as number|null,error:null as string|null};
        await json(path.join(folder,'metadata.json'),metadata);
        let stdout='',stderr='';
        try {
            // Recheck after preparing logs so an intervening edit/checkout isn't silently overwritten.
            await verifyWorktree(hub,source); await verifyWorktree(hub,target);
            if ((await git(targetPath,statusArgs)).stdout.trim() || (await git(targetPath,['rev-parse','HEAD'])).stdout.trim()!==metadata.targetHead) throw new Error('Target changed during preparation; apply refused.');
            const result = await git(targetPath,['apply','--3way','--',path.join(folder,'transfer.patch')]);
            stdout=result.stdout;stderr=result.stderr;metadata.applied=true;metadata.exitCode=0;
        } catch(e) {
            const error = e as Error & {stdout?:string;stderr?:string;code?:unknown};
            stdout=error.stdout || '';stderr=error.stderr || error.message;
            metadata.exitCode=typeof error.code==='number' ? error.code : 1;metadata.error=error.message;
        } finally {
            await write(path.join(folder,'apply-stdout.log'),stdout);
            await write(path.join(folder,'apply-stderr.log'),stderr);
            let after: string;
            try {after=(await git(targetPath,statusArgs)).stdout;} catch(e) {after=`Unable to read target status: ${(e as Error).message}\n`;metadata.error ||= after;}
            await write(path.join(folder,'target-status-after.txt'),after);
            await write(path.join(folder,'continuation-prompt.md'),prompt(metadata.applied));
            metadata.endedAt=now();await json(path.join(folder,'metadata.json'),metadata);
        }
        return {dryRun:false,...metadata,folder};
    };
    return options.apply ? exclusive(hub.root,perform) : perform();
}
