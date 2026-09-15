import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {git} from '../dist/core/git.js';
const cli=path.resolve('dist/index.js');
async function fixture(t) {
 const parent=await mkdtemp(path.join(tmpdir(),'agenthub-v03-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),bin=path.join(parent,'bin');await mkdir(root);await mkdir(bin);const hub=await Hub.init(root);
 const output=path.join(parent,'calls.jsonl');
 for(const name of ['codex','claude']) {const file=path.join(bin,name);await writeFile(file,`#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');process.exit(Number(process.env.TEST_EXIT||0));`);await chmod(file,0o755);}
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,TEST_CALLS:output,TEST_SECRET:'not-to-be-recorded'};
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8'});
 return {parent,root,bin,hub,output,env,run};
}
function ok(r){assert.equal(r.status,0,r.stderr);return r.stdout;}
test('agents finds fake executables without running them; missing stays unknown',async t=>{
 const f=await fixture(t);const rows=JSON.parse(ok(f.run('agents')));assert.ok(rows.every(r=>r.availability==='found'&&r.auth==='unknown'&&r.limits.includes('/status')));assert.equal(rows[0].executable,path.join(f.bin,'codex'));await assert.rejects(readFile(f.output));
 ok(f.run('config','agent','codex','--interactive-command','agenthub-nonexistent-cli'));const missing=JSON.parse(ok(f.run('agents')))[0];assert.equal(missing.availability,'missing');
});
test('config round-trips and rejects invalid settings and command credentials without changes',async t=>{
 const f=await fixture(t);ok(f.run('config','agent','codex','--model','custom-model','--effort','xhigh','--exec-command','codex exec'));
 assert.equal(JSON.parse(ok(f.run('config','agent','codex'))).effort,'xhigh');const before=await readFile(f.hub.p('agent-config.json'),'utf8');
 for(const args of [['--effort','extreme'],['--permission-mode','plan'],['--interactive-command','codex --api-key secret'],['--interactive-command','codex; echo bad']]) assert.equal(f.run('config','agent','codex',...args).status,1);
 assert.equal(await readFile(f.hub.p('agent-config.json'),'utf8'),before);
 ok(f.run('config','agent','claude','--model','custom','--permission-mode','plan','--print-command','claude -p'));
 assert.equal(f.run('config','agent','claude','--permission-mode','bad').status,1);
});
test('dry-run saves task handoff, shows flags and never launches or records a session',async t=>{
 const f=await fixture(t);await f.hub.createTask('Focus');ok(f.run('config','agent','codex','--model','test-model','--effort','high'));
 const plan=JSON.parse(ok(f.run('attach','codex','--task','task_001','--worktree','none','--dry-run')));
 assert.equal(plan.workdir,await realpath(f.root));assert.deepEqual(plan.args,['--model','test-model','-c','model_reasoning_effort="high"']);assert.equal(plan.task,'task_001');assert.match(await readFile(plan.handoffPath,'utf8'),/Attach Focus/);
 await assert.rejects(readFile(f.output));await assert.rejects(readdir(f.hub.p('sessions')));
 assert.equal(f.run('attach','codex','--task','task_999','--worktree','none','--dry-run').status,1);
 await f.hub.updateTask('task_001',{agent:'claude'});assert.equal(f.run('attach','codex','--task','task_001','--worktree','none','--dry-run').status,1);
});
test('attach inherits process IO, passes Claude config, records exit without credentials',async t=>{
 const f=await fixture(t);ok(f.run('config','agent','claude','--model','local-model','--permission-mode','plan'));
 f.env.TEST_EXIT='7';const result=f.run('attach','claude','--worktree','none');assert.equal(result.status,7,result.stderr);
 const call=JSON.parse((await readFile(f.output,'utf8')).trim());assert.deepEqual(call.args,['--model','local-model','--permission-mode','plan']);assert.equal(call.cwd,await realpath(f.root));
 const files=await readdir(f.hub.p('sessions'));const raw=await readFile(f.hub.p('sessions',files[0]),'utf8');const session=JSON.parse(raw);assert.equal(session.exitCode,7);assert.equal(session.agent,'claude');assert.ok(session.startedAt&&session.endedAt);assert.equal(session.mode,'attach');assert.ok(!raw.includes('not-to-be-recorded'));assert.ok(!raw.includes('TEST_SECRET'));
});
test('auto creates worktree; existing reuses it; dry-run does not create it',async t=>{
 const f=await fixture(t);await git(f.root,['init']);await writeFile(path.join(f.root,'file.txt'),'committed');await git(f.root,['add','file.txt']);await git(f.root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','initial']);
 const preview=JSON.parse(ok(f.run('attach','codex','--worktree','auto','--dry-run')));assert.equal(preview.wouldCreateWorktree,true);assert.deepEqual(await f.hub.worktreeList(),[]);
 ok(f.run('attach','codex','--worktree','auto'));const wt=(await f.hub.worktreeList())[0];assert.equal(JSON.parse((await readFile(f.output,'utf8')).trim()).cwd,wt.path);
 const existing=JSON.parse(ok(f.run('attach','codex','--dry-run')));assert.equal(existing.workdir,wt.path);
 assert.equal(f.run('attach','claude','--worktree','existing','--dry-run').status,1);
 await f.hub.worktreeRemove('codex');
});
test('start renders menu without launching models on noninteractive input',async t=>{
 const f=await fixture(t);assert.match(ok(f.run('start')),/AgentHub Control Room/);assert.match(ok(f.run('start','--help')),/control room/);await assert.rejects(readFile(f.output));
});

test('launch failure finalizes metadata and Claude default omits permission override',async t=>{
 const f=await fixture(t);ok(f.run('config','agent','claude','--permission-mode','default'));
 const plan=JSON.parse(ok(f.run('attach','claude','--worktree','none','--dry-run')));assert.deepEqual(plan.args,[]);
 await writeFile(path.join(f.bin,'codex'),'#!/nonexistent-agenthub-interpreter\n');
 const failed=f.run('attach','codex','--worktree','none');assert.equal(failed.status,1);assert.match(failed.stderr,/session metadata saved/);
 const record=JSON.parse(await readFile(f.hub.p('sessions',(await readdir(f.hub.p('sessions')))[0]),'utf8'));assert.equal(record.exitCode,1);assert.ok(record.endedAt);
 await writeFile(f.hub.p('agent-config.json'),'{broken');assert.equal((await f.hub.doctor()).ok,false);
});
