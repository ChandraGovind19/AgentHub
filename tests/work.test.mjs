import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,appendFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {configureAgent} from '../dist/core/agent-config.js';
import {startDashboard} from '../dist/core/dashboard.js';
import {chooseAgent,workPrompt,beginWork,endWork,readWork,journalFile} from '../dist/core/work.js';
const cli=path.resolve('dist/index.js');
const g=(dir,...a)=>execFileSync('git',['-C',dir,'-c','user.name=T','-c','user.email=t@example.com',...a],{encoding:'utf8'});
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'agenthub-work-'));t.after(()=>rm(root,{recursive:true,force:true}));
 g(root,'init');await writeFile(path.join(root,'app.js'),'v1\n');g(root,'add','.');g(root,'commit','-m','initial');
 const hub=await Hub.init(root);await hub.createTask('Ship feature');
 return {root,hub,run:(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8'})};
}
test('work alternates agents and the prompt carries the journal, the task and the diff since the previous session',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await chooseAgent(f.hub),{agent:'claude',reason:'first work session'});
 const first=await beginWork(f.hub,'claude','task_001',f.root,'work');
 await appendFile(journalFile(f.hub),'\n## Handoff — Claude Code — now\n\nImplemented the parser. Next: write tests for edge cases.\n');
 await writeFile(path.join(f.root,'app.js'),'v2\n');g(f.root,'commit','-am','parser');await writeFile(path.join(f.root,'new.js'),'wip\n');
 await endWork(f.hub,first.id);assert.ok((await readWork(f.hub)).sessions[0].endedAt);
 assert.equal((await chooseAgent(f.hub)).agent,'codex');
 const prompt=await workPrompt(f.hub,'codex','task_001');
 for(const marker of ['you are Codex','previous session was Claude Code','Next: write tests for edge cases','task_001: Ship feature','Commits:','parser','app.js','?? new.js','## Handoff — Codex'])assert.ok(prompt.includes(marker),'missing: '+marker);
 await assert.rejects(workPrompt(f.hub,'codex','task_999'),/Unknown task/);await assert.rejects(chooseAgent(f.hub,'generic'),/codex and claude/);
});
test('agenthub work --dry-run reports the swap and saves the prompt without launching or reassigning',async t=>{
 const f=await fixture(t);await f.hub.updateTask('task_001',{agent:'claude'});
 const r=f.run('work','--task','task_001','--dry-run');assert.equal(r.status,0,r.stderr);const plan=JSON.parse(r.stdout);
 assert.equal(plan.agent,'claude');assert.equal(path.basename(plan.workdir),path.basename(f.root));assert.equal(plan.args.at(-1),'<continuation prompt>');assert.match(await readFile(plan.promptFile,'utf8'),/you are Claude Code/);
 assert.equal((await f.hub.tasks())[0].assignedAgent,'claude');assert.deepEqual((await readWork(f.hub)).sessions,[]);
 assert.match(f.run('init').stderr+f.run('work','shell','--dry-run').stderr,/codex and claude/);
});
test('dashboard Continue button launches a pane with the continuation prompt auto-submitted and records the work session',async t=>{
 const f=await fixture(t);
 const executable=path.join(f.root,'fake-agent');await writeFile(executable,`#!${process.execPath}\nconsole.log('ARGS:'+JSON.stringify(process.argv.slice(2)));process.exit(0);\n`,{mode:0o755});
 await configureAgent(f.hub,'codex',{interactiveCommand:JSON.stringify(executable)});
 const dashboard=await startDashboard(f.hub,0);t.after(()=>dashboard.close());
 let html=await (await fetch(dashboard.url)).text();const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
 assert.match(html,/id="work"/);assert.match(html,/data-work-agent="claude"[^>]*>▶ Continue with Claude Code <small>\(recommended\)/);assert.match(html,/<option value="auto">Auto-continue/);assert.match(html,/href="#work"/);
 const r=await fetch(dashboard.url+'/terminal/launch',{method:'POST',body:new URLSearchParams({token,pane:'left',agent:'codex',task:'task_001',worktree:'none',prompt:'auto',confirmed:'yes'})});
 assert.equal(r.status,200,await r.clone().text());const record=await r.json();assert.ok(record.promptPath&&record.workId);
 let meta;for(let i=0;i<150&&!meta?.endedAt;i++){await new Promise(r=>setTimeout(r,40));meta=JSON.parse(await readFile(path.join(record.folder,'metadata.json'),'utf8'));}
 assert.equal(meta.exitCode,0);assert.match(meta.args.at(-1),/you are Codex/);
 const work=await readWork(f.hub);assert.equal(work.sessions.length,1);assert.equal(work.sessions[0].mode,'dashboard-terminal');assert.ok(work.sessions[0].endedAt);
 html=await (await fetch(dashboard.url)).text();assert.match(html,/Codex<\/strong> worked last on task_001/);assert.match(html,/data-work-agent="claude"[^>]*>▶ Continue with Claude Code <small>\(recommended\)/);
 assert.equal((await fetch(dashboard.url+'/terminal/launch',{method:'POST',body:new URLSearchParams({token,pane:'left',agent:'codex',worktree:'none',prompt:'shell',confirmed:'yes'})})).status,400);
});
test('ready mode launches the agent bare and types one instruction line without submitting it',async t=>{
 const f=await fixture(t);const seen=path.join(f.root,'seen.txt');
 const executable=path.join(f.root,'fake-agent');await writeFile(executable,`#!${process.execPath}\nconsole.log('ARGS:'+JSON.stringify(process.argv.slice(2)));process.stdout.write('welcome> ');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',d=>{require('node:fs').writeFileSync(${JSON.stringify(seen)},d.toString());process.exit(0);});setTimeout(()=>process.exit(3),25000);\n`,{mode:0o755});
 await configureAgent(f.hub,'claude',{interactiveCommand:JSON.stringify(executable)});
 const dashboard=await startDashboard(f.hub,0);t.after(()=>dashboard.close());
 const html=await (await fetch(dashboard.url)).text();const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];assert.match(html,/<option value="ready">Context ready/);
 const client=await (await fetch(dashboard.url+'/terminal-assets/client.js')).text();assert.ok(client.includes("free.elements.prompt.value='ready'"),'Continue buttons must use ready mode');
 const r=await fetch(dashboard.url+'/terminal/launch',{method:'POST',body:new URLSearchParams({token,pane:'left',agent:'claude',worktree:'none',prompt:'ready',confirmed:'yes'})});
 assert.equal(r.status,200,await r.clone().text());const record=await r.json();assert.equal(record.promptMode,'ready');assert.ok(record.promptPath);assert.ok(!record.args.some(a=>a.includes('AgentHub work session')),'prompt must not be passed as an argument');
 let typed='';for(let i=0;i<400&&!typed;i++){await new Promise(r=>setTimeout(r,50));typed=await readFile(seen,'utf8').catch(()=> '');}
 assert.equal(typed,`Read ${record.promptPath} and continue from where the previous session left off.`);assert.ok(!typed.includes('\r')&&!typed.includes('\n'),'must not press Enter');
 let log='';for(let i=0;i<100&&!log.includes('welcome>');i++){await new Promise(r=>setTimeout(r,50));log=await readFile(path.join(record.folder,'transcript.log'),'utf8').catch(()=> '');}assert.match(log,/welcome>/,'lane must keep a transcript for recovery');
});
test('agenthub work defaults to a bare launch and --auto opts into submission',async t=>{
 const f=await fixture(t);const r=f.run('work','claude','--dry-run');assert.equal(r.status,0,r.stderr);assert.match(f.run('work','--help').stdout,/--auto/);
});
test('a lane flips to out-of-usage when the CLI prints its limit message, and the state API reports it',async t=>{
 const f=await fixture(t);const executable=path.join(f.root,'limited-agent');
 await writeFile(executable,`#!${process.execPath}\nprocess.stdout.write('welcome> working...\\n');setTimeout(()=>process.stdout.write("\\x1b[33m│ You've hit your limit · resets 3pm (America/New_York) │\\x1b[0m\\n"),300);setTimeout(()=>process.exit(0),4000);\n`,{mode:0o755});
 await configureAgent(f.hub,'claude',{interactiveCommand:JSON.stringify(executable)});const dashboard=await startDashboard(f.hub,0);t.after(()=>dashboard.close());
 const html=await (await fetch(dashboard.url)).text();const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];assert.match(html,/id="auto-handoff"/);assert.match(html,/data-board-agent="claude"/);
 const r=await fetch(dashboard.url+'/terminal/launch',{method:'POST',body:new URLSearchParams({token,pane:'left',agent:'claude',worktree:'none',prompt:'none',confirmed:'yes'})});assert.equal(r.status,200,await r.clone().text());
 let pane;for(let i=0;i<100&&!pane?.limit;i++){await new Promise(r=>setTimeout(r,50));pane=(await (await fetch(dashboard.url+'/api/state')).json()).panes[0];}
 assert.ok(pane.limit,'limit not detected');assert.equal(pane.limit.resetsAt,'3pm (America/New_York)');assert.match(pane.limit.message,/hit your limit/);
 const state=await (await fetch(dashboard.url+'/api/state')).json();assert.deepEqual(state.agents.map(a=>a.agent),['codex','claude']);
});
