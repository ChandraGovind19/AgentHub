import {request} from 'node:http';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {startDashboard} from '../dist/core/dashboard.js';
async function fixture(t) {
 const root=await mkdtemp(path.join(tmpdir(),'agenthub-dashboard-'));
 const hub=await Hub.init(root);await hub.createTask('Build local dashboard');await hub.updateTask('task_001',{agent:'codex'});
 const dashboard=await startDashboard(hub,0);
 t.after(async()=>{await dashboard.close();await rm(root,{recursive:true,force:true});});
 return {hub,...dashboard};
}
async function snapshot(root){const result={};for(const e of await readdir(root,{withFileTypes:true})){const p=path.join(root,e.name);result[e.name]=e.isDirectory()?await snapshot(p):await readFile(p,'utf8');}return result;}
test('dashboard help documents local read-only server and ui alias',()=>{
 for(const command of ['dashboard','ui']){const output=execFileSync(process.execPath,['dist/index.js',command,'--help'],{encoding:'utf8'});assert.match(output,/127.0.0.1|local/i);assert.match(output,/--port/);}
});
test('dashboard binds only IPv4 loopback and renders non-Git project without writes',async t=>{
 const f=await fixture(t);const before=await snapshot(f.hub.root);
 assert.equal(f.server.address().address,'127.0.0.1');assert.match(f.url,/^http:\/\/127\.0\.0\.1:/);
 const res=await fetch(f.url);assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/html/);
 const html=await res.text();for(const text of ['No Git repository','Build local dashboard','task_001','codex','claude','Local-only','Recent sessions','Patch transfers','Saved reviews','Worktrees','Unknown','/status'])assert.ok(html.includes(text),text);
 assert.match(html,/agenthub run task_001 --agent codex --worktree auto --review/);
 assert.match(html,/class="topbar"/);assert.match(html,/class="relay"/);assert.match(html,/Local-only/);assert.match(html,/Usage is unknown here/);assert.match(html,/button--costly/);assert.match(html,/button--danger/);
 assert.deepEqual(await snapshot(f.hub.root),before);
});
test('dashboard chooses a following available port when requested port is occupied',async t=>{
 const f=await fixture(t);const port=f.server.address().port;const other=await startDashboard(f.hub,port);t.after(()=>other.close());assert.ok(other.server.address().port>port);assert.equal(other.server.address().address,'127.0.0.1');assert.equal((await fetch(other.url)).status,200);
});
test('dashboard serves only recognized artifacts as text and rejects arbitrary reads and writes',async t=>{
 const f=await fixture(t);await mkdir(f.hub.p('sessions','session_test'),{recursive:true});
 await writeFile(f.hub.p('sessions','session_test','metadata.json'),JSON.stringify({agent:'codex',taskId:'task_001',mode:'continue',classification:'success'}));
 await writeFile(f.hub.p('sessions','session_test','prompt.md'),'<script>secret()</script>');
 let html=await (await fetch(f.url)).text();const href=html.match(/href="(\/artifact\/[a-f0-9]+)"[^>]*>prompt.md/)[1];
 const artifact=await fetch(f.url+href);assert.match(artifact.headers.get('content-type'),/^text\/plain/);assert.equal(await artifact.text(),'<script>secret()</script>');
 for(const suffix of ['/?file=/etc/passwd','/artifact/'+ 'a'.repeat(64),'/config.json','/artifact/../../etc/passwd'])assert.equal((await fetch(f.url+suffix)).status,404);
 assert.equal((await fetch(f.url,{method:'POST'})).status,405);
 assert.equal(await new Promise((resolve,reject)=>{const req=request(f.url,{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();}),403);
 assert.equal((await fetch(f.url,{headers:{Origin:'https://evil.example'}})).status,403);
 const outside=path.join(f.hub.root,'outside.txt');await writeFile(outside,'outside secret');await rm(f.hub.p('sessions','session_test','prompt.md'));await symlink(outside,f.hub.p('sessions','session_test','prompt.md'));
 assert.equal((await fetch(f.url+href)).status,404);
 html=await (await fetch(f.url)).text();assert.ok(!html.includes('>prompt.md</a>'));
});
test('dashboard escapes imported text and tolerates malformed historical records',async t=>{
 const f=await fixture(t);await f.hub.createTask('<script>alert("x")</script>');await mkdir(f.hub.p('sessions'),{recursive:true});await writeFile(f.hub.p('sessions','broken.json'),'{');
 const res=await fetch(f.url);const html=await res.text();assert.equal(res.status,200);assert.ok(!html.includes('<script>alert'));assert.match(html,/&lt;script&gt;/);assert.match(html,/Could not read sessions\/broken.json/);assert.match(res.headers.get('content-security-policy'),/default-src 'none'/);
});
test('dashboard reads Git changes without refreshing index and shows saved histories',async t=>{
 const f=await fixture(t);const {git}=await import('../dist/core/git.js');await git(f.hub.root,['init']);await writeFile(path.join(f.hub.root,'file.txt'),'base\n');await git(f.hub.root,['add','file.txt']);await git(f.hub.root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','base']);await writeFile(path.join(f.hub.root,'file.txt'),'edit\n');
 await mkdir(f.hub.p('switches','sample'),{recursive:true});await writeFile(f.hub.p('switches','sample','metadata.json'),JSON.stringify({taskId:'task_001',from:'claude',to:'codex',applied:true,continued:true}));await mkdir(f.hub.p('reviews'),{recursive:true});await writeFile(f.hub.p('reviews','sample.md'),'# AgentHub Review: claude\nReview body');
 const before=await readFile(path.join(f.hub.root,'.git','index'));const html=await (await fetch(f.url)).text();assert.deepEqual(await readFile(path.join(f.hub.root,'.git','index')),before);assert.match(html,/1 changed files/);assert.match(html,/claude → codex/);assert.match(html,/agenthub continue task_001 --agent codex --worktree existing --review/);assert.match(html,/>sample.md<\/a>/);
});
test('the stage has two lane tabs and only the first lane is visible initially',async t=>{
 const f=await fixture(t);const html=await (await fetch(f.url)).text();
 assert.match(html,/data-lane-tab="left"[^>]*aria-selected="true"/);assert.match(html,/data-lane-tab="right"[^>]*aria-selected="false"/);
 assert.match(html,/data-terminal-pane="left">/);assert.match(html,/data-terminal-pane="right" hidden>/);assert.match(html,/id="terminal-handoff-request-left"/);
});
test('opening the dashboard at localhost redirects to the canonical 127.0.0.1 URL but never accepts actions there',async t=>{
 const f=await fixture(t);const port=new URL(f.url).port;
 const send=(options)=>new Promise((resolve,reject)=>{const req=request(f.url,options,res=>{res.resume();resolve(res);});req.on('error',reject);req.end();});
 const redirect=await send({headers:{Host:`localhost:${port}`}});assert.equal(redirect.statusCode,302);assert.equal(redirect.headers.location,`http://127.0.0.1:${port}/`);
 assert.equal((await send({headers:{Host:`localhost:${port}`,Origin:`http://localhost:${port}`}})).statusCode,403);
 assert.equal((await send({method:'POST',path:'/actions/prepare',headers:{Host:`localhost:${port}`}})).statusCode,403);
 assert.equal((await send({headers:{Host:`localhost.evil.example:${port}`}})).statusCode,403);
});
test('/api/state gives the desktop shell a read-only summary under the same protections',async t=>{
 const f=await fixture(t);const r=await fetch(f.url+'/api/state');assert.match(r.headers.get('content-type'),/json/);const s=await r.json();
 assert.equal(s.projectName,path.basename(f.hub.root));assert.deepEqual(s.panes.map(p=>p.pane),['left','right']);assert.equal(s.work.next,'claude');assert.equal(s.action,null);assert.equal(typeof s.changedFiles,'number');
 assert.equal((await fetch(f.url+'/api/state',{method:'POST'})).status,405);assert.equal((await fetch(f.url+'/api/state',{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await fetch(f.url+'/api/state?x=1')).status,404);
});
