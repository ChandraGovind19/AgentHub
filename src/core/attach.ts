import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hub } from './hub.js';
import { agentConfig, commandParts, executablePath, nativeAgent } from './agent-config.js';
import { readWorktrees, verifyWorktree } from './worktrees.js';
import { json, now, write } from './storage.js';
export interface AttachOptions { task?: string; worktree?: string; dryRun?: boolean; prompt?: string }
export async function prepareAttach(hub: Hub, agent: string, options: AttachOptions = {}) {
    nativeAgent(agent);
    const policy = options.worktree || 'existing';
    if (!['existing','auto','none'].includes(policy)) throw new Error('--worktree must be existing, auto, or none.');
    const config = await agentConfig(hub,agent);
    const [command, ...args] = commandParts(config.interactiveCommand!);
    const executable = await executablePath(command,hub.root);
    if (!options.dryRun && !executable) throw new Error(`${agent} executable not found. Install its native CLI or use agenthub config agent ${agent} --interactive-command <path>.`);
    if (options.task) {
        const task = (await hub.tasks()).find(t => t.id === options.task);
        if (!task) throw new Error(`Unknown task ${options.task}. Run agenthub task list.`);
        if (task.assignedAgent && task.assignedAgent !== agent) throw new Error(`Task ${task.id} is assigned to ${task.assignedAgent}. Reassign it explicitly before attaching ${agent}.`);
    }
    let workdir = hub.root; let wouldCreateWorktree = false;
    if (policy !== 'none') {
        let entry = (await readWorktrees(hub)).find(w => w.agent === agent);
        if (!entry && policy === 'existing') throw new Error(`No worktree for ${agent}. Use --worktree auto to create one or --worktree none to use the project directory.`);
        if (!entry && policy === 'auto') {
            if (options.dryRun) { wouldCreateWorktree = true; workdir = path.join(path.dirname(hub.root),`${path.basename(hub.root)}-agenthub-${agent}`); }
            else entry = await hub.worktreeCreate(agent);
        }
        if (entry) workdir = await verifyWorktree(hub,entry);
    }
    if (config.model) args.push('--model',config.model);
    if (agent === 'codex' && config.effort) args.push('-c',`model_reasoning_effort="${config.effort}"`);
    // "default" means use the native installation's default; CLI names differ by version.
    if (agent === 'claude' && config.permissionMode && config.permissionMode !== 'default') args.push('--permission-mode',config.permissionMode);
    // An explicit work prompt is passed as the CLI's initial prompt so the session starts with context already loaded.
    if (options.prompt) args.push(options.prompt);
    let handoffPath: string | undefined;
    if (options.task) {
        const handoff = await hub.handoff(agent);
        handoffPath = handoff.file;
        await write(handoff.file, `${handoff.text}\n## Attach Focus\n\nWork on ${options.task} in ${workdir}. This attach directory overrides any directory recommendation above.\n`);
        // Save context for manual entry; do not submit a paid initial prompt automatically.
    }
    const plan = {agent, command:executable || command, args, workdir, task:options.task || null, config, handoffPath:handoffPath || null, wouldCreateWorktree, dryRun:!!options.dryRun};
    return plan;
}
export async function attach(hub: Hub, agent: string, options: AttachOptions = {}) {
    const plan = await prepareAttach(hub,agent,options);
    if (options.dryRun) return plan;
    const {command:executable,args,workdir,handoffPath}=plan;
    const sessionId = randomUUID(); const file = hub.p('sessions',`${sessionId}.json`);
    const session = {sessionId,agent,mode:'attach',taskId:options.task || null,workdir,command:executable!,args,startedAt:now(),endedAt:null as string|null,exitCode:null as number|null,signal:null as string|null};
    await json(file,session);
    console.error(`Attaching ${agent} in ${workdir}. Use native /status for available usage information.`);
    if (options.prompt) console.error('Continuation prompt submitted automatically.');
    else if (handoffPath) console.error(`Handoff saved: ${handoffPath}\nPaste its contents into the native session when ready.`);
    let launchError: Error | undefined;
    try {
        const result = await new Promise<{code:number|null; signal:string|null}>((resolve,reject) => {
            const child = spawn(executable!,args,{cwd:workdir,stdio:'inherit',shell:false});
            const interrupt = () => { child.kill('SIGINT'); }; const terminate = () => { child.kill('SIGTERM'); };
            process.on('SIGINT',interrupt); process.on('SIGTERM',terminate);
            const cleanup = () => { process.off('SIGINT',interrupt); process.off('SIGTERM',terminate); };
            child.once('error',error => { cleanup(); reject(error); });
            child.once('exit',(code,signal) => { cleanup(); resolve({code,signal}); });
        });
        session.exitCode = result.code; session.signal = result.signal;
    } catch (error) { launchError = error as Error; session.exitCode = 1; }
    finally { session.endedAt = now(); await json(file,session); }
    if (launchError) throw new Error(`Native CLI failed to launch; session metadata saved at ${file}. ${launchError.message}`);
    return {...plan, sessionFile:file, exitCode:session.exitCode, signal:session.signal};
}
