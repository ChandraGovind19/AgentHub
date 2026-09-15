import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Hub } from './hub.js';
import { agentConfig, commandParts, executablePath, nativeAgent } from './agent-config.js';
import { readWorktrees, verifyWorktree } from './worktrees.js';
import { gitState } from './git.js';
import { claim as takeClaim, exists, json, now, release, stamp, write } from './storage.js';
import { classify, execute, tail, type Classification } from './runner-process.js';
import { continuation } from './continuation.js';
export interface RunOptions {agent?:string;dryRun?:boolean;worktree?:string;extract?:boolean;review?:boolean;sync?:boolean;timeout?:string|number;requireClean?:boolean;ingestOnFailure?:boolean}
export async function runTask(hub: Hub, taskId:string, options:RunOptions = {}, mode:'run'|'continue' = 'run') {
    const task = (await hub.tasks()).find(t=>t.id===taskId);
    if (!task) throw new Error(`Unknown task ${taskId}. Run agenthub task list.`);
    const agent = options.agent || task.assignedAgent;
    if (!agent) throw new Error(`Task ${taskId} has no assigned agent. Assign one or use --agent.`);
    nativeAgent(agent);
    const policy = options.worktree || 'existing';
    if (!['existing','auto','none'].includes(policy)) throw new Error('--worktree must be existing, auto, or none.');
    const timeout = Number(options.timeout ?? 900);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('--timeout must be a positive number of seconds, at most 86400.');
    const config = await agentConfig(hub,agent);
    const field = agent==='codex' ? 'execCommand' : 'printCommand';
    const [requested,...args] = commandParts(config[field]!,field);
    if (!args.length) args.push(agent==='codex' ? 'exec' : '-p');
    const command = await executablePath(requested,hub.root);
    if (!command) throw new Error(`${agent} automation executable not found. Configure --${agent==='codex'?'exec':'print'}-command with agenthub config agent ${agent}.`);
    if (config.model) args.push('--model',config.model);
    if (agent==='codex' && config.effort) args.push('-c',`model_reasoning_effort="${config.effort}"`);
    if (agent==='claude') {
        args.push('--output-format','text');
        if (config.permissionMode && config.permissionMode!=='default') args.push('--permission-mode',config.permissionMode);
    }
    // A per-task claim prevents two automation commands racing the same task, without blocking all coordination writes.
    const claim = hub.p(`.run-${taskId}`);
    if (!options.dryRun) await takeClaim(claim,`Task ${taskId} already has an active run. Wait for it to finish; a claim left by a crashed run is reclaimed automatically.`);
    try {
        let workdir = hub.root; let wouldCreateWorktree = false;
        if (policy!=='none') {
            let entry = (await readWorktrees(hub)).find(w=>w.agent===agent);
            if (!entry && policy==='existing') throw new Error(`No registered worktree for ${agent}. Use --worktree auto or --worktree none.`);
            if (!entry && policy==='auto') {
                if (options.dryRun) { wouldCreateWorktree=true; workdir=path.join(path.dirname(hub.root),`${path.basename(hub.root)}-agenthub-${agent}`); }
                else entry=await hub.worktreeCreate(agent);
            }
            if (entry) workdir=await verifyWorktree(hub,entry);
        }
        if (options.requireClean && !wouldCreateWorktree) {
            const state=await gitState(workdir);
            if (!state.repository) throw new Error('--require-clean requires a Git working tree.');
            if (state.changes.length) throw new Error('Working tree is dirty. Preserve existing changes before running with --require-clean.');
        }
        let prompt: string;
        if (mode==='continue') prompt=await continuation(hub,task,agent,workdir);
        else {
            prompt=(await hub.handoff(agent)).text;
            prompt+=`\n# Automation Task Focus\n\nThis run is only for ${task.id}: ${task.title}\n${task.description}\nFiles: ${task.files.join(', ') || '(inspect and establish scope)'}\nUse ${workdir}; this overrides directory recommendations above. The explicit --agent selection overrides the task's stored assignee for this execution only. Do not work on other listed tasks. Do not execute AgentHub ingest/sync/complete commands: the coordinator performs those operations. Return the required final Markdown summary. Do not merge or commit automatically.\n`;
        }
        if (options.dryRun) {
            const promptPath=hub.p('handoffs',`${stamp()}-${agent}-${mode}-preview.md`);await write(promptPath,prompt);
            return {dryRun:true,agent,taskId,mode,command,args:agent==='codex'?[...args,'--output-last-message','<session>/result.md','-']:args,workdir,wouldCreateWorktree,promptPath,timeout,extract:options.extract!==false,sync:options.sync!==false,review:!!options.review};
        }
        const sessionId=`session_${stamp()}_${agent}_${taskId}`;const folder=hub.p('sessions',sessionId);
        await fs.mkdir(folder,{recursive:true,mode:0o700});await write(path.join(folder,'prompt.md'),prompt);
        const resultFile=path.join(folder,'result.md');
        if (agent==='codex') args.push('--output-last-message',resultFile,'-');
        const started=Date.now();
        const metadata={sessionId,taskId,agent,mode,workdir,command,args,startedAt:now(),endedAt:null as string|null,durationMs:0,exitCode:null as number|null,signal:null as string|null,classification:null as Classification|null,timedOut:false,extracted:false,ingested:false,reviewed:false,synced:false,postprocessErrors:[] as string[]};
        const metadataFile=path.join(folder,'metadata.json');await json(metadataFile,metadata);
        try {
            const result=await execute(command,args,workdir,prompt,folder,timeout);
            metadata.exitCode=result.exitCode;metadata.signal=result.signal;metadata.timedOut=result.timedOut;
            if (!await exists(resultFile)) await fs.copyFile(path.join(folder,'stdout.log'),resultFile);
            const diagnostic=(await tail(path.join(folder,'stderr.log')))+'\n'+await tail(path.join(folder,'stdout.log'));
            metadata.classification=classify(result.exitCode,result.timedOut,diagnostic,!!result.launchError||!!result.ioError);
            if (result.launchError) metadata.postprocessErrors.push(`Launch: ${result.launchError}`);
            if (result.ioError) metadata.postprocessErrors.push(`Log capture: ${result.ioError}`);
            const success=metadata.classification==='success';
            const post = async (label:string,action:()=>Promise<void>)=>{try {await action();} catch(e){metadata.postprocessErrors.push(`${label}: ${(e as Error).message}`);}};
            if (success || options.ingestOnFailure) await post('Ingest',async()=>{
                // Bound auto-imports; retain complete oversized output on disk for manual review.
                if ((await fs.stat(resultFile)).size>1024*1024) throw new Error('Result exceeds 1 MiB; saved for manual ingest.');
                const summary=await fs.readFile(resultFile,'utf8');
                if (!summary.trim()) throw new Error('No final summary; nothing ingested.');
                if (options.extract!==false) {await hub.ingestExtract(summary,agent,taskId);metadata.extracted=true;}
                else await hub.ingest(summary,agent,taskId);
                metadata.ingested=true;
            });
            if (options.review) await post('Review',async()=>{await hub.review(agent,true);metadata.reviewed=true;});
            if (options.sync!==false) await post('Sync',async()=>{await hub.sync();metadata.synced=true;});
        } catch(e) {
            metadata.classification ||= 'unknown_error';metadata.postprocessErrors.push((e as Error).message);
        } finally {
            if (!await exists(resultFile)) await write(resultFile,'');
            metadata.endedAt=now();metadata.durationMs=Date.now()-started;await json(metadataFile,metadata);
        }
        return {dryRun:false,...metadata,sessionFolder:folder};
    } finally {if (!options.dryRun) await release(claim);}
}
