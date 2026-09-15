import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Hub} from '../dist/core/hub.js';
import {configureAgent} from '../dist/core/agent-config.js';
import {startDashboard} from '../dist/core/dashboard.js';
async function fixture(t,resist=false){
 const root=await mkdtemp(path.join(tmpdir(),'agenthub-pty-'));const hub=await Hub.init(root);await hub.createTask('PTY test');await hub.updateTask('task_001',{agent:'codex'});
 const executable=path.join(root,'fake-agent');await writeFile(executable,`#!${process.execPath}\nconsole.log('READY tty='+Boolean(process.stdin.isTTY)+' TERM='+process.env.TERM+' COLORTERM='+process.env.COLORTERM+' FORCE_COLOR='+process.env.FORCE_COLOR+' SIZE='+process.stdout.columns+'x'+process.stdout.rows);process.stdout.write('\\x1b[31mANSI-COLOR\\x1b[0m\\n');process.stdin.on('data',data=>console.log('RAW:'+JSON.stringify(data.toString())));${resist?"process.on('SIGTERM',()=>{});":''}require('node:readline').createInterface({input:process.stdin}).on('line',line=>{console.log('NATIVE:'+line);if(line==='size')console.log('SIZE-NOW:'+process.stdout.columns+'x'+process.stdout.rows);if(line==='exit')process.exit(0);});`);await chmod(executable,0o755);await configureAgent(hub,'codex',{interactiveCommand:JSON.stringify(executable)});
 await configureAgent(hub,'claude',{interactiveCommand:JSON.stringify(executable)});
 const dashboard=await startDashboard(hub,0);t.after(async()=>{if(dashboard.server.listening)await dashboard.close();await rm(root,{recursive:true,force:true});});
 const page=await (await fetch(dashboard.url)).text();const token=page.match(/name="token" value="([a-f0-9]+)"/)[1];
 const post=(endpoint,fields={},auth=true)=>fetch(dashboard.url+'/terminal/'+endpoint,{method:'POST',body:new URLSearchParams({...auth?{token}:{},...fields})});
 async function launch(){const r=await post('launch',{agent:'codex',task:'task_001',worktree:'none',confirmed:'yes'});assert.equal(r.status,200,await r.clone().text());return r.json();}
 async function metadata(session){for(let i=0;i<120;i++){const m=JSON.parse(await readFile(path.join(session.folder,'metadata.json'),'utf8'));if(m.endedAt)return m;await new Promise(r=>setTimeout(r,40));}throw new Error('PTY did not exit');}
 return {hub,...dashboard,token,post,launch,metadata};
}
test('terminal endpoints enforce POST, token, allowlist and explicit confirmation',async t=>{
 const f=await fixture(t);assert.equal(f.server.address().address,'127.0.0.1');
 const html=await (await fetch(f.url)).text();for(const marker of ['terminal-state--idle','terminal-session','terminal-agent','terminal-task','terminal-worktree','terminal-elapsed'])assert.match(html,new RegExp(marker));
 for(const pane of ['left','right']){assert.match(html,new RegExp(`data-terminal-pane="${pane}"`));for(const control of ['launch','screen','stop','elapsed'])assert.match(html,new RegExp(`id="terminal-${control}-${pane}"`));}
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'Pane controls must have unique IDs.');
 for(const route of ['launch','input','stop','resize','events']){assert.equal((await fetch(f.url+'/terminal/'+route)).status,405);assert.equal((await f.post(route,{},false)).status,403);}
 for(const fields of [{agent:'shell',confirmed:'yes'},{agent:'codex',command:'touch hacked',confirmed:'yes'},{agent:'codex',worktree:'../../outside',confirmed:'yes'},{agent:'codex',worktree:'none'}])assert.equal((await f.post('launch',fields)).status,400);
 assert.equal((await fetch(f.url+'/terminal/launch?command=sh')).status,405);
 await assert.rejects(readdir(f.hub.p('sessions')));
});
test('real fake-agent PTY streams native input and saves session metadata and handoff',async t=>{
 const f=await fixture(t);const session=await f.launch();
 assert.equal(session.mode,'dashboard-terminal');assert.equal(session.workdir,f.hub.root);assert.ok(session.handoffPath);
 const response=await f.post('events');assert.match(response.headers.get('content-type'),/text\/event-stream/);const reader=response.body.getReader();t.after(()=>reader.cancel().catch(()=>{}));let output='';
 async function until(text){while(!output.includes(text)){const chunk=await reader.read();assert.equal(chunk.done,false);output+=new TextDecoder().decode(chunk.value);}}
 await until('READY tty=true');assert.equal((await f.post('resize',{session:session.sessionId,cols:'90',rows:'24'})).status,200);
 assert.equal((await f.post('input',{session:session.sessionId,data:'/status\r'})).status,200);await until('NATIVE:/status');
 await f.post('input',{session:session.sessionId,data:'exit\r'});const meta=await f.metadata(session);assert.equal(meta.exitCode,0);assert.ok(meta.endedAt);assert.equal(meta.taskId,'task_001');assert.ok(!('env' in meta));await assert.rejects(readFile(path.join(session.folder,'terminal.log')));await reader.cancel();
});
test('PTY preserves ANSI output, terminal environment, dimensions, resize and special input',async t=>{
 const f=await fixture(t);const launch=await f.post('launch',{agent:'codex',worktree:'none',confirmed:'yes',cols:'95',rows:'31'});assert.equal(launch.status,200,await launch.clone().text());const session=await launch.json();
 const response=await f.post('events');const reader=response.body.getReader();t.after(()=>reader.cancel().catch(()=>{}));let output='';
 async function until(text){while(!output.includes(text)){const chunk=await reader.read();assert.equal(chunk.done,false);output+=new TextDecoder().decode(chunk.value);}}
 await until('TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 SIZE=95x31');await until('ANSI-COLOR');assert.match(output,/\\u001b\[31mANSI-COLOR\\u001b\[0m/);
 assert.equal((await f.post('resize',{session:session.sessionId,cols:'88',rows:'27'})).status,200);await f.post('input',{session:session.sessionId,data:'size\r'});await until('SIZE-NOW:88x27');
 assert.equal((await f.post('input',{session:session.sessionId,data:'\x1b[A'})).status,200);await until('RAW:');
 await f.post('stop',{session:session.sessionId});assert.ok((await f.metadata(session)).endedAt);await reader.cancel();
});
test('concurrent terminal and dashboard actions are rejected; stale session input fails',async t=>{
 const f=await fixture(t);const s=await f.launch();assert.equal((await f.post('launch',{agent:'codex',worktree:'none',confirmed:'yes'})).status,409);
 const r=await fetch(f.url+'/actions/prepare',{method:'POST',body:new URLSearchParams({token:f.token,kind:'sync'})});assert.equal(r.status,409);
 assert.equal((await f.post('input',{session:'stale',data:'exit\r'})).status,400);
 assert.equal((await f.post('resize',{session:s.sessionId,cols:'NaN',rows:'24'})).status,400);
 await f.post('stop',{session:s.sessionId});assert.ok((await f.metadata(s)).endedAt);
 assert.equal((await f.post('input',{session:s.sessionId,data:'ignored'})).status,400);
});
test('stop forcibly terminates a resistant native session and frees slot',async t=>{
 const f=await fixture(t,true);const session=await f.launch();await new Promise(r=>setTimeout(r,150));const result=await f.post('stop',{session:session.sessionId});assert.equal(result.status,200);const meta=await f.metadata(session);assert.ok(meta.signal||meta.exitCode!==0);const next=await f.launch();await f.post('stop',{session:next.sessionId});
});
test('PTY preparation failure preserves dashboard and allows subsequent launch',async t=>{
 const f=await fixture(t);const r=await f.post('launch',{agent:'codex',worktree:'existing',confirmed:'yes'});assert.equal(r.status,400);assert.match(await r.text(),/No worktree/);assert.equal((await fetch(f.url)).status,200);
 const action=await fetch(f.url+'/actions/prepare',{method:'POST',body:new URLSearchParams({token:f.token,kind:'sync'})});assert.equal(action.status,200);const s=await f.launch();await f.post('stop',{session:s.sessionId});
});
test('terminal assets are local allowlisted files and private origin requests fail',async t=>{
 const f=await fixture(t);for(const name of ['xterm.js','fit.js','client.js','xterm.css'])assert.equal((await fetch(f.url+'/terminal-assets/'+name)).status,200);
 const client=await (await fetch(f.url+'/terminal-assets/client.js')).text();assert.doesNotThrow(()=>new Function(client),'Terminal client must parse before it can prevent form navigation.');
 assert.equal((await fetch(f.url+'/terminal-assets/package.json')).status,404);
 assert.equal((await fetch(f.url+'/terminal/events',{method:'POST',headers:{Origin:'https://other.example'},body:new URLSearchParams({token:f.token})})).status,403);
});
test('native execution failure saves diagnostics and leaves dashboard actions usable',async t=>{
 const f=await fixture(t);const broken=path.join(f.hub.root,'broken-agent');await writeFile(broken,'#!/definitely/missing/interpreter\n');await chmod(broken,0o755);await configureAgent(f.hub,'codex',{interactiveCommand:JSON.stringify(broken)});
 const r=await f.post('launch',{agent:'codex',worktree:'none',confirmed:'yes'});assert.ok([200,400].includes(r.status));
 const folders=await readdir(f.hub.p('sessions'));assert.equal(folders.length,1);const m=await f.metadata({folder:f.hub.p('sessions',folders[0])});assert.ok(m.endedAt);assert.notEqual(m.exitCode,0);
 const action=await fetch(f.url+'/actions/prepare',{method:'POST',body:new URLSearchParams({token:f.token,kind:'sync'})});assert.equal(action.status,200);
});

test('dual panes route input/output independently, preserve both records and block actions until both stop',{timeout:20000},async t=>{
 const f=await fixture(t);
 const launchPane=async(pane,agent)=>{const r=await f.post('launch',{pane,agent,worktree:'none',confirmed:'yes'});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const [left,right]=await Promise.all([launchPane('left','claude'),launchPane('right','codex')]);
 assert.equal(left.paneId,'left');assert.equal(right.paneId,'right');assert.notEqual(left.sessionId,right.sessionId);
 for(const pane of ['left','right'])assert.equal((await f.post('launch',{pane,agent:'codex',worktree:'none',confirmed:'yes'})).status,409);
 assert.equal((await f.post('launch',{pane:'third',agent:'codex',worktree:'none',confirmed:'yes'})).status,400);
 const events=async pane=>{const response=await f.post('events',{pane});assert.equal(response.status,200);const reader=response.body.getReader();t.after(()=>reader.cancel().catch(()=>{}));let text='';return {reader,until:async expected=>{while(!text.includes(expected)){const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value);}return text;}};};
 const a=await events('left'),b=await events('right');
 await Promise.all([a.until('READY tty=true'),b.until('READY tty=true')]);
 assert.equal((await f.post('input',{pane:'right',session:left.sessionId,data:'wrong\r'})).status,400);
 await Promise.all([f.post('input',{pane:'left',session:left.sessionId,data:'left-only\r'}),f.post('input',{pane:'right',session:right.sessionId,data:'right-only\r'})]);
 const [aText,bText]=await Promise.all([a.until('NATIVE:left-only'),b.until('NATIVE:right-only')]);
 assert.ok(!aText.includes('right-only'));assert.ok(!bText.includes('left-only'));
 for(const [pane,s,cols] of [['left',left,'83'],['right',right,'101']])assert.equal((await f.post('resize',{pane,session:s.sessionId,cols,rows:'25'})).status,200);
 const action=()=>fetch(f.url+'/actions/prepare',{method:'POST',body:new URLSearchParams({token:f.token,kind:'sync'})});
 assert.equal((await action()).status,409);
 await f.post('stop',{pane:'left',session:left.sessionId});assert.ok((await f.metadata(left)).endedAt);
 assert.equal(JSON.parse(await readFile(path.join(right.folder,'metadata.json'),'utf8')).endedAt,null);
 assert.equal((await action()).status,409);
 await f.post('input',{pane:'right',session:right.sessionId,data:'still-running\r'});await b.until('NATIVE:still-running');
 await f.post('input',{pane:'right',session:right.sessionId,data:'exit\r'});assert.equal((await f.metadata(right)).exitCode,0);
 assert.equal((await action()).status,200);assert.equal((await readdir(f.hub.p('sessions'))).length,2);
 await Promise.all([a.reader.cancel(),b.reader.cancel()]);
});

test('pane validation and failure recovery preserve the other pane',async t=>{
 const f=await fixture(t);const left=await f.launch();
 for(const endpoint of ['launch','events','input','resize','stop'])assert.equal((await f.post(endpoint,{pane:'unknown'})).status,400);
 assert.equal((await f.post('launch',{pane:'right',agent:'shell',worktree:'none',confirmed:'yes'})).status,400);
 assert.equal((await f.post('launch',{pane:'right',agent:'claude',worktree:'existing',confirmed:'yes'})).status,400);
 assert.equal((await f.post('input',{pane:'left',session:left.sessionId,data:'live\r'})).status,200);
 const r=await f.post('launch',{pane:'right',agent:'claude',worktree:'none',confirmed:'yes'});assert.equal(r.status,200);const right=await r.json();
 await f.close();assert.ok((await f.metadata(left)).endedAt);assert.ok((await f.metadata(right)).endedAt);
});
