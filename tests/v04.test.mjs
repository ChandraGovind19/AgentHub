import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {git} from '../dist/core/git.js';
import {classify} from '../dist/core/runner-process.js';
const cli=path.resolve('dist/index.js');
const summary='## Summary of Changes\n- Implemented feature\n## Files Modified\n- feature.ts\n## Important Decisions\n- Use local storage\n## Follow-up Tasks\n- Add integration tests\n## AgentHub Memory Updates\n- Feature has been implemented\n';
async function fixture(t){
 const parent=await mkdtemp(path.join(tmpdir(),'agenthub-v04-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project'),bin=path.join(parent,'bin');await mkdir(root);await mkdir(bin);const hub=await Hub.init(root);await hub.createTask('Implement feature');await hub.updateTask('task_001',{agent:'codex'});
 const output=path.join(parent,'calls.jsonl');
 for(const name of ['codex','claude']){const file=path.join(bin,name);await writeFile(file,`#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_CALLS,JSON.stringify({args,input,cwd:process.cwd()})+'\\n');const summary=${JSON.stringify(summary)};if(process.env.TEST_TIMEOUT){console.log('partial output');console.error('partial diagnostic');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}console.error(process.env.TEST_DIAGNOSTIC||'native stderr');const index=args.indexOf('--output-last-message');if(index>=0){fs.writeFileSync(args[index+1],summary);console.log('codex progress chatter');}else console.log(summary);process.exit(Number(process.env.TEST_EXIT||0));});\n`);await chmod(file,0o755);}
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,TEST_CALLS:output};
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:root,env,encoding:'utf8',timeout:15000});
 async function sessions(){const rows=await readdir(hub.p('sessions'),{withFileTypes:true});return Promise.all(rows.filter(r=>r.isDirectory()).map(async r=>({folder:hub.p('sessions',r.name),...JSON.parse(await readFile(hub.p('sessions',r.name,'metadata.json'),'utf8'))})));}
 return {parent,root,hub,bin,output,env,run,sessions};
}
function ok(r){assert.equal(r.status,0,r.stderr);return r.stdout;}
test('run dry-run saves deterministic prompt without invoking CLI or making sessions',async t=>{
 const f=await fixture(t);const p=JSON.parse(ok(f.run('run','task_001','--worktree','none','--dry-run')));assert.equal(p.agent,'codex');assert.match(await readFile(p.promptPath,'utf8'),/Automation Task Focus/);assert.equal(p.args[0],'exec');assert.ok(p.args.includes('--output-last-message'));await assert.rejects(readFile(f.output));await assert.rejects(readdir(f.hub.p('sessions')));
});
test('run validates assignment, executable, task and timeout before execution',async t=>{
 const f=await fixture(t);await f.hub.createTask('Unassigned');assert.match(f.run('run','task_002').stderr,/no assigned agent/);assert.match(f.run('run','task_999').stderr,/Unknown task/);assert.match(f.run('run','task_001','--timeout','NaN').stderr,/timeout/);
 ok(f.run('config','agent','codex','--exec-command','missing-agenthub-cli exec'));assert.match(f.run('run','task_001','--worktree','none').stderr,/executable not found/);
});
test('Codex run streams, saves final response and extracts/reviews/syncs',async t=>{
 const f=await fixture(t);const r=f.run('run','task_001','--worktree','none','--extract','--review');ok(r);assert.match(r.stdout,/progress chatter/);assert.match(r.stderr,/native stderr/);
 const [s]=await f.sessions();assert.equal(s.classification,'success');assert.ok(s.extracted&&s.reviewed&&s.synced);assert.ok(s.endedAt&&s.durationMs>=0);assert.equal(await readFile(path.join(s.folder,'result.md'),'utf8'),summary);assert.match(await readFile(path.join(s.folder,'stdout.log'),'utf8'),/progress chatter/);assert.match(await readFile(path.join(s.folder,'stderr.log'),'utf8'),/native stderr/);
 assert.deepEqual((await f.hub.tasks())[0].files,['feature.ts']);assert.equal((await f.hub.tasks()).length,2);assert.equal((await f.hub.tasks())[0].status,'todo');assert.equal((await f.hub.doctor()).ok,true);
});
test('Claude automation uses print config and supports no-extract/no-sync',async t=>{
 const f=await fixture(t);ok(f.run('config','agent','claude','--model','custom','--permission-mode','plan'));ok(f.run('run','task_001','--agent','claude','--worktree','none','--no-extract','--no-sync'));
 const call=JSON.parse((await readFile(f.output,'utf8')).trim());assert.deepEqual(call.args,['-p','--model','custom','--output-format','text','--permission-mode','plan']);assert.match(call.input,/task_001/);
 const [s]=await f.sessions();assert.ok(s.ingested);assert.equal(s.extracted,false);assert.equal(s.synced,false);assert.equal((await f.hub.tasks()).length,1);
});
test('nonzero exits do not ingest; rate-limit and auth diagnostics remain heuristic',async t=>{
 const f=await fixture(t);f.env.TEST_EXIT='2';f.env.TEST_DIAGNOSTIC='429 rate limit exceeded';const r=f.run('run','task_001','--worktree','none');assert.equal(r.status,1);
 const [s]=await f.sessions();assert.equal(s.classification,'rate_limited');assert.equal(s.ingested,false);assert.equal((await f.hub.tasks()).length,1);assert.ok(s.synced);
 f.env.TEST_DIAGNOSTIC='not logged in';const retry=f.run('run','task_001','--worktree','none','--ingest-on-failure');assert.equal(retry.status,1);assert.ok((await f.sessions()).some(s=>s.classification==='auth_error'&&s.extracted));
 assert.equal(classify(1,false,'ordinary failure'),'failed');assert.equal(classify(0,false,'discussion of rate limits'),'success');assert.equal(classify(null,false,'',true),'unknown_error');
});
test('timeout terminates resistant fake process and saves partial output without ingest',async t=>{
 const f=await fixture(t);f.env.TEST_TIMEOUT='1';const r=f.run('run','task_001','--worktree','none','--timeout','0.3');assert.equal(r.status,124,r.stderr);
 const [s]=await f.sessions();assert.equal(s.classification,'timed_out');assert.equal(s.timedOut,true);assert.equal(s.ingested,false);assert.match(await readFile(path.join(s.folder,'stdout.log'),'utf8'),/partial output/);assert.match(await readFile(path.join(s.folder,'result.md'),'utf8'),/partial output/);assert.ok(s.endedAt);
});
test('continue preview is compact and records previous source work without another model call',async t=>{
 const f=await fixture(t);ok(f.run('run','task_001','--worktree','none'));const before=await readFile(f.output,'utf8');const p=JSON.parse(ok(f.run('continue','task_001','--agent','claude','--worktree','none','--dry-run')));
 const prompt=await readFile(p.promptPath,'utf8');assert.match(prompt,/# AgentHub Continuation Prompt/);assert.match(prompt,/Implemented feature/);assert.match(prompt,/NOT copied/);assert.ok(prompt.length<15000);assert.equal(await readFile(f.output,'utf8'),before);assert.equal((await f.sessions()).length,1);
 ok(f.run('continue','task_001','--agent','claude','--worktree','none','--no-extract'));assert.ok((await f.sessions()).some(s=>s.mode==='continue'&&s.agent==='claude'));
});
test('auto/existing isolate work; require-clean refuses source edits',async t=>{
 const f=await fixture(t);await git(f.root,['init']);await writeFile(path.join(f.root,'base.txt'),'base');await git(f.root,['add','base.txt']);await git(f.root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','initial']);
 await writeFile(path.join(f.root,'base.txt'),'dirty');assert.match(f.run('run','task_001','--worktree','none','--require-clean').stderr,/dirty/);
 ok(f.run('run','task_001','--worktree','auto','--require-clean','--no-extract'));const wt=(await f.hub.worktreeList())[0];const call=JSON.parse((await readFile(f.output,'utf8')).trim());assert.equal(call.cwd,wt.path);assert.equal(await readFile(path.join(wt.path,'base.txt'),'utf8'),'base');
 ok(f.run('run','task_001','--worktree','existing','--no-extract'));await f.hub.worktreeRemove('codex');
});
