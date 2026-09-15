import { promises as fs } from 'node:fs';
import type { Hub } from './hub.js';
import type { Task } from '../types/index.js';
import { exists, readJson } from './storage.js';
import { gitState } from './git.js';
import { tail } from './runner-process.js';
const clip = (s:string,n:number) => s.length > n ? s.slice(0,n)+'\n[truncated]' : s;
export const completionFormat = '## Summary of Changes\n- ...\n\n## Files Modified\n- ...\n\n## Important Decisions\n- ...\n\n## Follow-up Tasks\n- ...\n\n## AgentHub Memory Updates\n- ...';
export async function continuation(hub: Hub, task: Task, agent: string, workdir: string) {
    const sessions: {endedAt:string; agent:string;workdir:string;classification:string;result:string}[] = [];
    if (await exists(hub.p('sessions'))) for (const entry of await fs.readdir(hub.p('sessions'),{withFileTypes:true})) {
        if (!entry.isDirectory()) continue;
        try {
            const m = await readJson<Record<string,unknown>>(hub.p('sessions',entry.name,'metadata.json'));
            if (m.taskId !== task.id || typeof m.endedAt !== 'string' || typeof m.agent !== 'string' || typeof m.workdir !== 'string') continue;
            sessions.push({endedAt:m.endedAt,agent:m.agent,workdir:m.workdir,classification:String(m.classification),result:await tail(hub.p('sessions',entry.name,'result.md'),1800)});
        } catch { /* Incomplete sessions cannot supply a reliable checkpoint. */ }
    }
    sessions.sort((a,b)=>b.endedAt.localeCompare(a.endedAt));
    const recent = sessions.slice(0,3);
    const [sourceGit,destinationGit,locks] = await Promise.all([gitState(hub.root),gitState(workdir),hub.locks()]);
    let review = '(none)';
    if (await exists(hub.p('reviews'))) {
        const files = (await fs.readdir(hub.p('reviews'))).filter(f=>f.endsWith('.md')).sort();
        if (files.length) review = clip(await tail(hub.p('reviews',files[files.length-1]),1800),1800);
    }
    const paths = (g:typeof sourceGit) => g.repository ? g.changes.slice(0,25).map(c=>`${c.status} ${JSON.stringify(c.file)}`).join('\n') || '(clean)' : '(no Git repository)';
    return `# AgentHub Continuation Prompt\n\n## Task\n\n${task.id}: ${clip(task.title,300)}\n${clip(task.description,1200)}\nTarget agent: ${agent}\nWorkdir: ${workdir}\nTask scope: ${clip(task.files.join(', '),1000) || '(inspect and establish scope)'}\n\n## Previous Agent Work\n\n${recent.map(s=>`${s.agent}: ${s.classification} at ${s.endedAt}\nSource worktree: ${s.workdir}\n${s.result}`).join('\n\n') || '(No completed automation sessions recorded.)'}\n\n## Recent Changed Files\n\nCoordinator (${hub.root}):\n${paths(sourceGit)}\nDestination (${workdir}):\n${paths(destinationGit)}\n\nRecent review (may concern another task; verify before relying on it):\n${review}\n\n## Current Known State\n\nTask status: ${task.status}\nRecent notes:\n${clip(task.notes.slice(-3).join('\n'),1500)}\nLocks owned by other agents:\n${clip(Object.entries(locks).filter(([,l])=>l.owner!==agent).map(([f,l])=>`${f}: ${l.owner} (${l.taskId})`).join('\n'),1200) || '(none)'}\n\n## What Not To Redo\n\nTreat prior summaries as reported work, not verified completion. Inspect the source worktrees before repeating work. Unmerged commits and uncommitted changes are NOT copied by continue itself. An earlier explicit agenthub switch may have applied a patch; inspect the target files and switch records before repeating work. Do not assume previous files are present, overwrite other agents' changes, or merge automatically.\n\n## Your Job Now\n\nContinue only ${task.id}. Inspect local instructions and actual code, identify what is still missing, then implement and test within the task scope. Respect locks. Read project memory in ${hub.p('memory')} as context. Do not run AgentHub ingest/sync/complete commands; the coordinator handles postprocessing. Return a final Markdown summary. Do not infer usage limits from these records.\n\n## Required Completion Format\n\n${completionFormat}\n`;
}
