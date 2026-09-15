#!/usr/bin/env node
import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { Hub } from './core/hub.js';
import { copyToClipboard } from './core/clipboard.js';
import { exists, write, stamp } from './core/storage.js';
import { agents, agentConfig, configureAgent } from './core/agent-config.js';
import { attach, prepareAttach } from './core/attach.js';
import { beginWork, chooseAgent, endWork, otherAgent, display, workPrompt } from './core/work.js';
import { readyInstruction } from './core/dashboard-terminal.js';
import { start } from './cli/start.js';
import { runTask } from './core/run.js';
import { switchTask } from './core/switch.js';
import { startDashboard } from './core/dashboard.js';
const program = new Command().name('agenthub').description('Local coordination and handoffs for coding agents').version('0.8.0');
const hub = () => Hub.open();
const files = (value: string) => value.split(',').map(f => f.trim()).filter(Boolean);
const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
program.command('init').description('Initialize this directory').action(async () => { const h = await Hub.init(); print(`AgentHub initialized for ${(await h.config()).projectName}.\nCreated .agenthub/ with project memory, tasks, adapters, locks, logs, handoffs, and snapshots.\nStart working: agenthub work claude   (later, when it hits its limit: agenthub work)\n${(await h.changes()).includes('No Git repository') ? 'No Git repository detected.\n' : ''}Consider adding .agenthub/logs/, .agenthub/snapshots/, and .agenthub/.write-lock/ to .gitignore.\nNext: agenthub status`); });
program.command('status').action(async () => print(await (await hub()).status()));
const task = program.command('task').description('Create, assign, and update tasks');
task.command('create <title>').option('--description <text>', 'Task description', '').option('--files <paths>', 'Comma-separated project-relative files', '').action(async (title, o) => print(await (await hub()).createTask(title, o.description, files(o.files))));
task.command('list').option('--status <status>').option('--agent <agent>').action(async (o) => print((await (await hub()).tasks()).filter(t => (!o.status || t.status === o.status) && (!o.agent || t.assignedAgent === o.agent))));
task.command('update <id>').option('--status <status>').option('--note <text>').option('--files <paths>', 'Replace file scope').option('--agent <agent>').action(async (id, o) => print(await (await hub()).updateTask(id, { ...o, files: o.files === undefined ? undefined : files(o.files) })));
task.command('assign <id> <agent>').action(async (id, agent) => print(await (await hub()).updateTask(id, { agent })));
program.command('lock <file>').requiredOption('--agent <agent>').requiredOption('--task <id>').action(async (file, o) => print(`Locked ${await (await hub()).lock(file, o.agent, o.task)} (advisory).`));
program.command('unlock <file>').action(async (file) => print(`Unlocked ${await (await hub()).unlock(file)}.`));
program.command('changes').action(async () => print(await (await hub()).changes()));
program.command('sync').action(async () => { const result = await (await hub()).sync(); print(`${result.text}\nSnapshot: ${result.file}`); });
program.command('handoff <agent>').option('--copy', 'Copy Markdown to the clipboard').option('--quiet', 'Suppress Markdown on stdout').action(async (agent, o) => {
    const result = await (await hub()).handoff(agent);
    if (!o.quiet) print(result.text);
    console.error(`Saved handoff: ${result.file}`);
    if (o.copy) {
        try { await copyToClipboard(result.text); console.error('Handoff copied to clipboard.'); }
        catch (e) { console.error(`${(e as Error).message}\nHandoff was still saved to:\n${result.file}`); process.exitCode = 1; }
    }
});
program.command('complete <id>').option('--note <text>').option('--unlock', 'Release all task locks').option('--keep-locks', 'Keep task locks (default)').action(async (id, o) => {
    const result = await (await hub()).complete(id, o);
    print(`Task ${id} marked done. ${result.remainingFiles.length} related locks remain.`);
    if (result.relatedFiles.length) print(`Related files:\n${result.relatedFiles.map(f => `- ${f}`).join('\n')}`);
    if (o.unlock) print(`Released ${result.releasedFiles.length} locks.`);
    else if (result.remainingFiles.length) print(`Use agenthub complete ${id} --unlock to release them, or run agenthub unlock <file>.`);
});
const worktree = program.command('worktree').description('Manage isolated Git worktrees');
worktree.command('create <agent>').option('--path <path>', 'External path relative to project root').option('--branch <branch>', 'Branch name').action(async (agent, o) => print(await (await hub()).worktreeCreate(agent, o)));
worktree.command('list').action(async () => print(await (await hub()).worktreeList()));
worktree.command('status').action(async () => print(await (await hub()).worktreeStatus()));
worktree.command('remove <agent>').option('--force', 'Discard uncommitted and local files').action(async (agent, o) => { const removed = await (await hub()).worktreeRemove(agent, o.force); print(`Removed ${removed.path}. Branch ${removed.branch} retained.`); });
program.command('review <agent>').option('--save', 'Save Markdown review').option('--copy', 'Copy review to clipboard').action(async (agent, o) => {
    const result = await (await hub()).review(agent, o.save); print(result.text);
    if (result.file) console.error(`Saved review: ${result.file}`);
    if (o.copy) { try { await copyToClipboard(result.text); console.error('Review copied to clipboard.'); } catch (e) { console.error(`${(e as Error).message}\nReview remains available ${result.file ? `at ${result.file}` : 'on stdout; use --save to retain a file'}.`); process.exitCode = 1; } }
});
program.command('resume').action(async () => print(await (await hub()).resume()));
const memory = program.command('memory').description('Read or update project memory').action(async () => print(await (await hub()).memory()));
memory.command('show').action(async () => print(await (await hub()).memory()));
memory.command('add-decision <text>').option('--reason <reason>', 'Decision rationale', '').action(async (text, o) => { await (await hub()).addMemory('decisions', text, o.reason); print('Decision recorded.'); });
memory.command('add-question <text>').action(async (text) => { await (await hub()).addMemory('open-questions', text); print('Question recorded.'); });
memory.command('edit <name>').action(async (name) => {
    const file = (await hub()).memoryPath(name);
    if (name === 'notes' && !await exists(file)) await write(file, '# Durable Notes\n');
    await fs.access(file);
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
        print(`No VISUAL or EDITOR configured. Edit this file:\n${file}`);
        return;
    }
    // The editor is user-controlled shell configuration; the file is passed as a positional argument.
    await new Promise<void>((resolve, reject) => { const child = process.platform === 'win32' ? spawn(editor, [file], { stdio: 'inherit', shell: false }) : spawn('/bin/sh', ['-c', `exec ${editor} "$1"`, 'agenthub-editor', file], { stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}.`))); });
});
program.command('ingest [file]').option('--text <text>').option('--agent <agent>', 'Attribution for the summary', 'generic').option('--task <id>', 'Attach summary to task notes').option('--extract', 'Extract known Markdown sections').option('--dry-run', 'Preview extraction without writes').action(async (file, o) => {
    if (Boolean(file) === (o.text !== undefined)) throw new Error('Provide exactly one summary file or --text.');
    if (o.dryRun && !o.extract) throw new Error('--dry-run requires --extract.');
    const text = file ? await fs.readFile(file, 'utf8') : o.text;
    const h = await hub();
    if (o.extract) print(await h.ingestExtract(text, o.agent, o.task, o.dryRun));
    else print(`Summary stored: ${await h.ingest(text, o.agent, o.task)}`);
});
program.command('switch <task-id>').description('Preview or apply a patch between registered worktrees').requiredOption('--from <agent>').requiredOption('--to <agent>').option('--dry-run', 'Read-only preview (default)').option('--apply', 'Apply and save transfer logs').option('--include-untracked', 'Also transfer untracked new files from the source worktree').option('--continue', 'Continue with the target agent after successful apply').option('--review').option('--no-sync').option('--timeout <seconds>', 'Continuation execution timeout', '900').option('--extract', 'Extract structured continuation result (default)').option('--no-extract', 'Store raw continuation summary').action(async (id,o) => {
    if (o.continue && !o.apply) throw new Error('--continue requires --apply.');
    if (o.continue && (!Number.isFinite(Number(o.timeout)) || Number(o.timeout) <= 0 || Number(o.timeout) > 86400)) throw new Error('--timeout must be a positive number of seconds, at most 86400.');
    const h = await hub();
    const result = await switchTask(h,id,o);
    if (!o.continue) print(result);
    if (!result.dryRun && 'applied' in result) {
        if (!result.applied || result.error) { process.exitCode=1; console.error(`Switch needs attention. Inspect logs and target conflict state in ${result.folder} before continuing. Target agent was not started.`); }
        else if (o.continue) {
            console.error(`Switch applied. Diagnostics: ${result.folder}`);
            try {
                // switchTask has released its writer mutex; reuse the existing execution/postprocessing pipeline.
                const continued = await runTask(h,id,{agent:o.to,worktree:'existing',review:o.review,sync:o.sync,timeout:o.timeout,extract:o.extract},'continue');
                if ('classification' in continued) {
                    console.error(`Switch continuation: ${continued.classification}. Session: ${continued.sessionFolder}`);
                    if (continued.postprocessErrors.length) console.error(continued.postprocessErrors.join('\n'));
                    if (continued.classification !== 'success' || continued.postprocessErrors.length) process.exitCode = continued.timedOut ? 124 : 1;
                }
            } catch (error) {
                process.exitCode=1;
                console.error(`Patch remains applied; continuation did not complete: ${(error as Error).message}\nSwitch diagnostics: ${result.folder}\nRetry the continuation directly: ${result.nextCommand}`);
            }
        } else console.error(`Next: ${result.nextCommand}`);
    }
});
for (const mode of ['run','continue'] as const) {
    const command = program.command(`${mode} <task-id>`).description(mode === 'run' ? 'Execute a task using native CLI automation' : 'Switch agents using a compact local continuation prompt');
    if (mode === 'continue') command.requiredOption('--agent <agent>'); else command.option('--agent <agent>');
    command.option('--dry-run').option('--worktree <policy>', 'existing, auto, or none', 'existing').option('--extract', 'Extract structured result (default)').option('--no-extract', 'Store raw summary without extraction').option('--review').option('--no-sync').option('--timeout <seconds>', 'Execution timeout', '900').option('--require-clean').option('--ingest-on-failure').action(async (id,o) => {
        const result = await runTask(await hub(),id,o,mode);
        if (result.dryRun) print(result);
        else if ('classification' in result) {
            console.error(`\nAgentHub ${mode}: ${result.classification}. Session: ${result.sessionFolder}`);
            if (result.postprocessErrors.length) console.error(result.postprocessErrors.join('\n'));
            console.error(`Next: agenthub review ${result.agent} --save; inspect the summary before agenthub complete ${id}. Use agenthub continue ${id} --agent <agent> to switch.`);
            if (result.classification !== 'success' || result.postprocessErrors.length) process.exitCode = result.timedOut ? 124 : 1;
        }
    });
}
program.command('dashboard').alias('ui').description('Open a localhost dashboard with confirmed actions').option('--port <number>', 'Starting port; next available port is used', '3737').action(async o => {
    const dashboard=await startDashboard(await hub(),Number(o.port));
    print(`AgentHub dashboard: ${dashboard.url}\nLocal-only. Actions require confirmation. Press Ctrl+C to stop.`);
    const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);void dashboard.close().catch(e=>{console.error(e.message);process.exitCode=1;});};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
});
program.command('agents').description('Detect native CLI executables without launching agents').action(async () => print(await agents(await hub())));
const config = program.command('config').description('Project-level native agent configuration');
config.command('agent <agent>').option('--model <name>').option('--effort <level>').option('--permission-mode <mode>').option('--interactive-command <command>').option('--exec-command <command>').option('--print-command <command>').action(async (agent,o) => {
    const h = await hub(); print(Object.keys(o).length ? await configureAgent(h,agent,o) : await agentConfig(h,agent));
});
program.command('attach <agent>').description('Launch a native CLI with inherited terminal IO').option('--task <id>').option('--worktree <policy>', 'existing, auto, or none', 'existing').option('--dry-run').action(async (agent,o) => {
    const result = await attach(await hub(),agent,o);
    if (o.dryRun) print(result);
    else if ('exitCode' in result) process.exitCode = result.exitCode ?? (result.signal ? 130 : 1);
});
program.command('work [agent]').description('Start or continue an interactive session with the shared continuation context auto-submitted; with no agent, swaps to the one that did not work last').option('--task <id>', 'Focus on a task (reassigned to this agent if needed)').option('--worktree <policy>', 'existing, auto, or none', 'none').option('--auto', 'Submit the continuation prompt automatically instead of leaving it for you to send').option('--dry-run', 'Show the plan and save the prompt without launching').action(async (agentArg, o) => {
    const h = await hub(); const choice = await chooseAgent(h, agentArg);
    if (o.task && !o.dryRun) { const task = (await h.tasks()).find(t => t.id === o.task); if (task && task.assignedAgent && task.assignedAgent !== choice.agent) { await h.updateTask(o.task, { agent: choice.agent }); console.error(`Reassigned ${o.task} from ${task.assignedAgent} to ${choice.agent}.`); } }
    const plan = await prepareAttach(h, choice.agent, { task: o.task, worktree: o.worktree, dryRun: true });
    const prompt = await workPrompt(h, choice.agent, o.task, plan.workdir);
    const promptFile = h.p('handoffs', `${stamp()}-${choice.agent}-work.md`); await write(promptFile, prompt);
    if (o.dryRun) { print({ agent: choice.agent, reason: choice.reason, workdir: plan.workdir, command: plan.command, args: [...plan.args, '<continuation prompt>'], promptFile, wouldCreateWorktree: plan.wouldCreateWorktree }); return; }
    console.error(`Continuing with ${display(choice.agent)} (${choice.reason}).\nContext saved: ${promptFile}`);
    if (!o.auto) { const line = readyInstruction(promptFile); try { await copyToClipboard(line); console.error(`Copied to clipboard, paste it into the session when ready:\n  ${line}`); } catch { console.error(`Paste this into the session when ready:\n  ${line}`); } }
    const session = await beginWork(h, choice.agent, o.task, plan.workdir, 'work');
    try { const result = await attach(h, choice.agent, { task: o.task, worktree: o.worktree, prompt: o.auto ? prompt : undefined }); if ('exitCode' in result) process.exitCode = result.exitCode ?? (result.signal ? 130 : 1); }
    finally { await endWork(h, session.id); console.error(`\n${display(choice.agent)} session ended. When it is out of usage, continue with ${display(otherAgent(choice.agent))}:\n  agenthub work`); }
});
program.command('start').description('Open the simple interactive control room').action(async () => start(await hub()));
program.command('doctor').action(async () => { const result = await (await hub()).doctor(); print(result); if (!result.ok)
    process.exitCode = 1; });
try {
    // Always parse as a Node script: commander would otherwise assume Electron's packaged-app argv shape when the desktop app runs the CLI via ELECTRON_RUN_AS_NODE.
    await program.parseAsync(process.argv, { from: 'node' });
}
catch (error) {
    console.error(`AgentHub: ${(error as Error).message}`);
    process.exitCode = 1;
}
