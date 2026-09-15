import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hub} from '../dist/core/hub.js';
import {git} from '../dist/core/git.js';
import {configureAgent} from '../dist/core/agent-config.js';
import {startDashboard} from '../dist/core/dashboard.js';
async function fixture(t){
 const parent=await mkdtemp(path.join(tmpdir(),'agenthub-actions-'));const root=path.join(parent,'project');await mkdir(root);await git(root,['init']);await writeFile(path.join(root,'file.txt'),'base');await git(root,['add','file.txt']);await git(root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','base']);
 const hub=await Hub.init(root);await hub.createTask('Dashboard test');await hub.updateTask('task_001',{agent:'codex'});
 const server=await startDashboard(hub,0);t.after(async()=>{await server.close();await rm(parent,{recursive:true,force:true});});
 const html=await (await fetch(server.url)).text();const token=html.match(/name="token" value="([a-f0-9]+)"/)[1];
 const post=(endpoint,fields)=>fetch(server.url+'/actions/'+endpoint,{method:'POST',body:new URLSearchParams(fields),redirect:'manual'});
 async function prepare(fields){const r=await post('prepare',{token,...fields});assert.equal(r.status,200,await r.clone().text());const html=await r.text();return html.match(/name="confirmation" value="([a-f0-9]+)"/)[1];}
 async function done(){for(let n=0;n<150;n++){const entries=await readdir(hub.p('dashboard-actions')).catch(()=>[]);if(entries.length){const m=await readFile(hub.p('dashboard-actions',entries.sort().at(-1),'metadata.json'),'utf8').then(s=>{try{return JSON.parse(s);}catch{return {};}}).catch(()=>({}));if(m.endedAt)return m;}await new Promise(r=>setTimeout(r,50));}throw new Error('Action did not finish');}
 return {hub,...server,token,post,prepare,done};
}
test('actions require POST, session token, allowlist and one-use confirmation',async t=>{
 const f=await fixture(t);for(const e of ['prepare','execute'])assert.equal((await fetch(f.url+'/actions/'+e)).status,405);
 assert.equal((await f.post('prepare',{kind:'sync'})).status,403);
 assert.equal((await f.post('prepare',{token:f.token,kind:'exec',command:'touch hacked'})).status,400);
 assert.equal((await f.post('prepare',{token:f.token,kind:'sync',command:'whoami'})).status,400);
 assert.equal((await f.post('prepare',{token:f.token,kind:'run',task:'task_001',agent:'--help'})).status,400);
 assert.equal((await f.post('execute',{token:f.token,confirmation:'invented'})).status,400);
 const id=await f.prepare({kind:'sync'});await assert.rejects(readdir(f.hub.p('dashboard-actions')));
 assert.equal((await f.post('execute',{token:f.token,confirmation:id})).status,303);const m=await f.done();assert.equal(m.status,'success');assert.match(await readFile(path.join(m.folder,'stdout.log'),'utf8'),/Snapshot:/);assert.ok((await f.hub.config()).lastSync);
 assert.equal((await f.post('execute',{token:f.token,confirmation:id})).status,400);
});
test('confirmed saved review reuses core CLI',async t=>{
 const f=await fixture(t);await f.hub.worktreeCreate('codex',{path:path.join(f.hub.root,'..','tree')});const id=await f.prepare({kind:'review',agent:'codex'});await f.post('execute',{token:f.token,confirmation:id});const m=await f.done();assert.equal(m.status,'success',m.output);assert.match(m.output,/Saved review:/);assert.ok((await readdir(f.hub.p('reviews'))).length);
});
test('fake agent run captures output, artifacts and rejects concurrent actions',async t=>{
 const f=await fixture(t);const fake=path.join(f.hub.root,'fake.cjs');await writeFile(fake,`#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>setTimeout(()=>{const fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'## Summary of Changes\\n- Dashboard run verified\\n');console.log('fake agent completed');},500));`);await chmod(fake,0o755);await configureAgent(f.hub,'codex',{execCommand:JSON.stringify(fake)+' exec'});
 const id=await f.prepare({kind:'run',task:'task_001',agent:'codex'});const other=await f.prepare({kind:'sync'});
 assert.equal((await f.post('execute',{token:f.token,confirmation:id})).status,303);
 assert.equal((await f.post('execute',{token:f.token,confirmation:other})).status,409);
 const m=await f.done();assert.equal(m.status,'success',m.output);assert.match(m.output,/fake agent completed/);assert.match(m.output,/Session:/);assert.ok((await readdir(f.hub.p('sessions'))).length);const html=await (await fetch(f.url)).text();assert.match(html,/fake agent completed/);assert.match(html,/success: agenthub run/);
});
test('failed action retains diagnostics and releases the action slot',async t=>{
 const f=await fixture(t);const id=await f.prepare({kind:'continue',task:'task_001',agent:'codex'});await f.post('execute',{token:f.token,confirmation:id});const m=await f.done();assert.equal(m.status,'failure');assert.ok(await readFile(path.join(m.folder,'stderr.log'),'utf8'));assert.ok(await f.prepare({kind:'resume'}));
});
test('browser form posts survive the local-only check (Chrome sends Origin: null under Referrer-Policy: no-referrer)',async t=>{
 const f=await fixture(t);
 // Per the Fetch spec a non-GET navigation under "no-referrer" carries `Origin: null` even when same-origin,
 // which made every dashboard action form fail with "Local requests only." in Chrome. Pin the policy that keeps Origin intact.
 for(const r of [await fetch(f.url),await f.post('prepare',{token:f.token,kind:'sync'})])assert.equal(r.headers.get('referrer-policy'),'same-origin');
 const origin=new URL(f.url).origin;
 const browser=await fetch(f.url+'/actions/prepare',{method:'POST',headers:{Origin:origin,Referer:f.url+'/'},body:new URLSearchParams({token:f.token,kind:'sync'})});
 assert.equal(browser.status,200);assert.match(await browser.text(),/name="confirmation"/);
 const nullOrigin=await fetch(f.url+'/actions/prepare',{method:'POST',headers:{Origin:'null'},body:new URLSearchParams({token:f.token,kind:'sync'})});
 assert.equal(nullOrigin.status,403);assert.match(await nullOrigin.text(),/Local requests only/);
 assert.equal((await fetch(f.url+'/actions/prepare',{method:'POST',headers:{Origin:'http://localhost:'+new URL(f.url).port},body:new URLSearchParams({token:f.token,kind:'sync'})})).status,403);
});
test('a running action auto-refreshes the page and lands on the action section',async t=>{
 const f=await fixture(t);
 let html=await (await fetch(f.url)).text();assert.ok(!html.includes('http-equiv="refresh"'));assert.ok(!html.includes('class="top-chip top-chip--running"'));
 const id=await f.prepare({kind:'sync'});const r=await f.post('execute',{token:f.token,confirmation:id});
 assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/#dashboard-actions');
 html=await (await fetch(f.url)).text();
 if(html.includes('action-result--running')){assert.match(html,/<meta http-equiv="refresh" content="3;url=\/#dashboard-actions">/);assert.match(html,/class="top-chip top-chip--running"/);}
 await f.done();html=await (await fetch(f.url)).text();assert.ok(!html.includes('http-equiv="refresh"'));assert.ok(!html.includes('class="top-chip top-chip--running"'));
});
