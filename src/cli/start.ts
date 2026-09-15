import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Hub } from '../core/hub.js';
import { agents, configureAgent } from '../core/agent-config.js';
import { attach } from '../core/attach.js';
export const menu = `AgentHub Control Room
1. Show status
2. Show agents
3. Configure agent
4. Attach to Codex
5. Attach to Claude
6. Generate handoff
7. Review worktree
8. Resume project
9. Exit`;
async function ask(question: string) {
    const rl = createInterface({input:stdin,output:stdout});
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
export async function start(hub: Hub) {
    if (!stdin.isTTY || !stdout.isTTY) { console.log(menu+'\nUse agenthub start in an interactive terminal to select an option.'); return; }
    try { while (true) {
        console.log(menu);
        try {
            const choice = await ask('Choose 1–9: ');
            if (choice === '9' || choice.toLowerCase() === 'exit') return;
            if (choice === '1') console.log(await hub.status());
            else if (choice === '2') console.log(JSON.stringify(await agents(hub),null,2));
            else if (choice === '3') {
                const agent = await ask('Agent (codex/claude): '); const model = await ask('Model (blank to keep): ');
                const setting = await ask(agent === 'codex' ? 'Effort (blank to keep): ' : 'Permission mode (blank to keep): ');
                console.log(await configureAgent(hub,agent,{...(model ? {model} : {}), ...(setting ? agent === 'codex' ? {effort:setting} : {permissionMode:setting} : {})}));
            } else if (choice === '4' || choice === '5') {
                const worktree = await ask('Worktree (existing/auto/none): '); const task = await ask('Task ID (blank for none): ');
                await attach(hub,choice === '4' ? 'codex' : 'claude',{worktree:worktree || 'existing',task:task || undefined});
            } else if (choice === '6') { const h = await hub.handoff(await ask('Agent: ')); console.log(h.text+'\nSaved: '+h.file); }
            else if (choice === '7') console.log((await hub.review(await ask('Agent: '),true)).text);
            else if (choice === '8') console.log(await hub.resume());
            else console.log('Choose a number from 1 to 9.');
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') return; console.error((error as Error).message); }
    } } finally {
        // Native attach can leave stdin flowing after readline closes.
        stdin.pause();
    }
}
