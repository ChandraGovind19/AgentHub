import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {git} from '../dist/core/git.js';
import {switchTask} from '../dist/core/switch.js';
const cli=path.resolve('dist/index.js');
async function commit(root,message){await git(root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m',message]);}
async function fixture(t){
 const parent=await mkdtemp(path.join(tmpdir(),'agenthub-switch-'));t.after(()=>rm(parent,{recursive:true,force:true}));const root=path.join(parent,'project');await mkdir(root);
 await git(root,['init']);await writeFile(path.join(root,'file.txt'),'original\n');await writeFile(path.join(root,'.gitignore'),'ignored.txt\n');await git(root,['add','.']);await commit(root,'initial');
 const hub=await Hub.init(root);await hub.createTask('Transfer changes');const source=await hub.worktreeCreate('claude'),target=await hub.worktreeCreate('codex');
 return {parent,root,hub,source:source.path,target:target.path,run:(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8'})};
}
const options={from:'claude',to:'codex'};
async function snapshot(dir){const result={};for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);result[entry.name]=entry.isDirectory()?await snapshot(file):createHash('sha256').update(await readFile(file)).digest('hex');}return result;}
test('switch defaults to dry-run and preserves coordinator, worktrees and Git indexes byte-for-byte',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.source,'file.txt'),'source edit\n');const before=await snapshot(f.parent);
 const r=f.run('switch','task_001','--from','claude','--to','codex');assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);assert.equal(p.dryRun,true);assert.deepEqual(p.files,['file.txt']);assert.match(p.continuationPrompt,/Continuation Prompt/);assert.deepEqual(await snapshot(f.parent),before);
 const r2=await switchTask(f.hub,'task_001',{...options,dryRun:true});assert.equal(r2.dryRun,true);assert.deepEqual(await snapshot(f.parent),before);
});
test('switch validates task, agents and source/target worktree registration',async t=>{
 const f=await fixture(t);await assert.rejects(switchTask(f.hub,'task_999',options),/Unknown task/);await assert.rejects(switchTask(f.hub,'task_001',{from:'../bad',to:'codex'}),/Agent names/);await assert.rejects(switchTask(f.hub,'task_001',{from:'claude',to:'claude'}),/must differ/);
 await assert.rejects(switchTask(f.hub,'task_001',{from:'generic',to:'codex'}),/Missing source/);await assert.rejects(switchTask(f.hub,'task_001',{from:'claude',to:'generic'}),/Missing target/);
 await assert.rejects(switchTask(f.hub,'task_001',{...options,apply:true,dryRun:true}),/Choose/);
});
test('no changes, untracked source and dirty target are refused before writing logs',async t=>{
 const f=await fixture(t);await assert.rejects(switchTask(f.hub,'task_001',options),/no tracked changes/);
 await writeFile(path.join(f.source,'new.txt'),'new');await assert.rejects(switchTask(f.hub,'task_001',options),/untracked files/);await git(f.source,['add','new.txt']);
 for(const file of ['file.txt','untracked.txt','ignored.txt']){await writeFile(path.join(f.target,file),'target edit');await assert.rejects(switchTask(f.hub,'task_001',{...options,apply:true}),/Target worktree is dirty/);if(file==='file.txt')await writeFile(path.join(f.target,file),'original\n');else await rm(path.join(f.target,file));}
 await assert.rejects(readdir(f.hub.p('switches')));
});
test('apply transfers combined staged/unstaged and binary changes while retaining source and HEADs',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.source,'file.txt'),'staged\n');await git(f.source,['add','file.txt']);await writeFile(path.join(f.source,'file.txt'),'final unstaged\n');const bytes=Buffer.from([0,1,2,255,0]);await writeFile(path.join(f.source,'new.bin'),bytes);await git(f.source,['add','new.bin']);
 const sourceDiff=await git(f.source,['diff','HEAD']);const sourceHead=await git(f.source,['rev-parse','HEAD']);const targetHead=await git(f.target,['rev-parse','HEAD']);
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply');assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.applied,true);assert.match(r.stderr,/agenthub continue task_001 --agent codex --worktree existing --review/);
 assert.equal(await readFile(path.join(f.target,'file.txt'),'utf8'),'final unstaged\n');assert.deepEqual(await readFile(path.join(f.target,'new.bin')),bytes);assert.equal(await git(f.source,['diff','HEAD']),sourceDiff);assert.equal(await git(f.source,['rev-parse','HEAD']),sourceHead);assert.equal(await git(f.target,['rev-parse','HEAD']),targetHead);
 for(const name of ['source-status.txt','target-status-before.txt','transfer.patch','apply-stdout.log','apply-stderr.log','target-status-after.txt','continuation-prompt.md','metadata.json'])assert.ok((await readdir(result.folder)).includes(name));
 assert.match(await readFile(path.join(result.folder,'transfer.patch'),'utf8'),/GIT binary patch/);assert.equal(await readFile(path.join(result.folder,'target-status-before.txt'),'utf8'),'');assert.match(await readFile(path.join(result.folder,'target-status-after.txt'),'utf8'),/file.txt/);assert.equal((await f.hub.tasks())[0].status,'todo');await assert.rejects(readdir(f.hub.p('sessions')));
});
test('failed three-way apply records diagnostics and leaves conflicts for explicit resolution',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.source,'file.txt'),'source edit\n');await writeFile(path.join(f.target,'file.txt'),'different target commit\n');await git(f.target,['add','file.txt']);await commit(f.target,'target change');
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply');assert.equal(r.status,1);const result=JSON.parse(r.stdout);assert.equal(result.applied,false);assert.ok(result.error);assert.ok(result.endedAt);assert.notEqual(await readFile(path.join(result.folder,'apply-stderr.log'),'utf8'),'');assert.match(await readFile(path.join(result.folder,'target-status-after.txt'),'utf8'),/UU/);assert.equal(await readFile(path.join(f.source,'file.txt'),'utf8'),'source edit\n');assert.match(await readFile(path.join(result.folder,'continuation-prompt.md'),'utf8'),/do not assume/);
});
async function fakeTarget(f, hang=false) {
 const executable=path.join(f.parent,'fake-target');const invocation=path.join(f.parent,'invoked.json');
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(invocation)},JSON.stringify({prompt,cwd:process.cwd(),file:fs.readFileSync('file.txt','utf8')}));${hang ? "console.log('partial');setInterval(()=>{},1000);" : "const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'## Summary of Changes\\n- Continued transferred changes\\n');"}});\n`);
 const {chmod}=await import('node:fs/promises');await chmod(executable,0o755);
 const config=f.run('config','agent','codex','--exec-command',`"${executable}" exec`);assert.equal(config.status,0,config.stderr);
 return invocation;
}
async function continuationSession(f) {
 const folders=await readdir(f.hub.p('sessions'));assert.equal(folders.length,1);
 return JSON.parse(await readFile(f.hub.p('sessions',folders[0],'metadata.json'),'utf8'));
}
test('switch --continue requires --apply before any writes or model execution',async t=>{
 const f=await fixture(t);const invoked=await fakeTarget(f);await writeFile(path.join(f.source,'file.txt'),'source edit\n');const before=await snapshot(f.parent);
 const r=f.run('switch','task_001','--from','claude','--to','codex','--continue');assert.equal(r.status,1);assert.match(r.stderr,/--continue requires --apply/);assert.deepEqual(await snapshot(f.parent),before);await assert.rejects(readFile(invoked));
});
test('switch apply then continue sees transferred code and forwards review/extraction/sync flags',async t=>{
 const f=await fixture(t);const invoked=await fakeTarget(f);await writeFile(path.join(f.source,'file.txt'),'source edit\n');
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply','--continue','--review','--no-sync','--no-extract','--timeout','10');assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Switch continuation: success/);
 const call=JSON.parse(await readFile(invoked,'utf8'));assert.equal(call.file,'source edit\n');assert.equal(call.cwd,f.target);assert.match(call.prompt,/# AgentHub Continuation Prompt/);
 const session=await continuationSession(f);assert.equal(session.mode,'continue');assert.equal(session.agent,'codex');assert.equal(session.reviewed,true);assert.equal(session.synced,false);assert.equal(session.extracted,false);assert.equal(session.ingested,true);assert.equal(session.classification,'success');assert.equal(await readFile(path.join(f.source,'file.txt'),'utf8'),'source edit\n');
 const switches=await readdir(f.hub.p('switches'));assert.equal(switches.length,1);assert.equal(JSON.parse(await readFile(f.hub.p('switches',switches[0],'metadata.json'),'utf8')).applied,true);
});
test('failed switch apply never invokes target continuation',async t=>{
 const f=await fixture(t);const invoked=await fakeTarget(f);await writeFile(path.join(f.source,'file.txt'),'source edit\n');await writeFile(path.join(f.target,'file.txt'),'conflicting commit\n');await git(f.target,['add','file.txt']);await commit(f.target,'conflict');
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply','--continue');assert.equal(r.status,1);assert.match(r.stderr,/Target agent was not started/);await assert.rejects(readFile(invoked));await assert.rejects(readdir(f.hub.p('sessions')));assert.equal((await readdir(f.hub.p('switches'))).length,1);
});
test('switch continuation forwards timeout and preserves applied patch after timeout',async t=>{
 const f=await fixture(t);await fakeTarget(f,true);await writeFile(path.join(f.source,'file.txt'),'source edit\n');
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply','--continue','--timeout','0.3','--no-sync');assert.equal(r.status,124,r.stderr);
 const session=await continuationSession(f);assert.equal(session.classification,'timed_out');assert.equal(session.synced,false);assert.equal(session.ingested,false);assert.equal(await readFile(path.join(f.target,'file.txt'),'utf8'),'source edit\n');
});
test('switch --include-untracked transfers new files without staging them in the source',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.source,'file.txt'),'source edit\n');await mkdir(path.join(f.source,'lib'));await writeFile(path.join(f.source,'lib','new.txt'),'brand new\n');await writeFile(path.join(f.source,'empty.txt'),'');
 await assert.rejects(switchTask(f.hub,'task_001',options),/--include-untracked/);
 const preview=await switchTask(f.hub,'task_001',{...options,includeUntracked:true});assert.deepEqual(preview.files.sort(),['empty.txt','file.txt','lib/new.txt']);assert.match(preview.diffStat,/lib\/new.txt \(untracked; new file\)/);
 const r=f.run('switch','task_001','--from','claude','--to','codex','--apply','--include-untracked');assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.applied,true,result.error);
 assert.equal(await readFile(path.join(f.target,'lib','new.txt'),'utf8'),'brand new\n');assert.equal(await readFile(path.join(f.target,'empty.txt'),'utf8'),'');assert.equal(await readFile(path.join(f.target,'file.txt'),'utf8'),'source edit\n');
 assert.match(await readFile(path.join(result.folder,'transfer.patch'),'utf8'),/new file mode/);
 assert.equal(await readFile(path.join(f.source,'lib','new.txt'),'utf8'),'brand new\n');assert.equal((await git(f.source,['ls-files','--others','--exclude-standard'])).trim().split('\n').sort().join(','),'empty.txt,lib/new.txt');
});
