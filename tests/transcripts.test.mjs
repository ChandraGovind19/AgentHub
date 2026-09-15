import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {nativeTranscript,cleanTerminalOutput,renderTranscript,claudeEntries,codexEntries} from '../dist/core/transcripts.js';
import {Hub} from '../dist/core/hub.js';
import {beginWork,endWork,workPrompt} from '../dist/core/work.js';
const line=o=>JSON.stringify(o)+'\n';
async function fakeHome(t,workdir,start){
 const home=await mkdtemp(path.join(tmpdir(),'agenthub-home-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const claudeDir=path.join(home,'.claude','projects',workdir.replace(/[^a-zA-Z0-9]/g,'-'));await mkdir(claudeDir,{recursive:true});
 const ts=n=>new Date(start+n*1000).toISOString();
 await writeFile(path.join(claudeDir,'abc.jsonl'),line({type:'user',cwd:workdir,timestamp:ts(1),message:{role:'user',content:'Fix the unicode edge case in the tokenizer'}})+line({type:'assistant',cwd:workdir,timestamp:ts(2),message:{content:[{type:'thinking',thinking:'secret reasoning'},{type:'text',text:'Looking at the tokenizer now.'},{type:'tool_use',name:'Edit',input:{file_path:'src/tokenizer.ts',old_string:'a'}}]}})+line({type:'user',cwd:workdir,timestamp:ts(3),message:{content:[{type:'tool_result',content:'ok'}]}})+line({type:'assistant',cwd:workdir,isSidechain:true,timestamp:ts(4),message:{content:[{type:'text',text:'subagent chatter'}]}})+line({type:'assistant',cwd:workdir,timestamp:ts(5),message:{content:[{type:'text',text:'Edited the tokenizer; tests still fail on emoji.'}]}})+'{"type":"attachment"\n');
 const codexDir=path.join(home,'.codex','sessions','2026','09','15');await mkdir(codexDir,{recursive:true});
 await writeFile(path.join(codexDir,'rollout-2026-09-15T10-00-00-x.jsonl'),line({timestamp:ts(1),type:'session_meta',payload:{cwd:workdir}})+line({timestamp:ts(2),type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'<skills_instructions>'}]}})+line({timestamp:ts(3),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Wire the CLI flag'}]}})+line({timestamp:ts(4),type:'response_item',payload:{type:'custom_tool_call',name:'shell',input:'npm test'}})+line({timestamp:ts(5),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Flag wired; 3 tests failing.'}]}}));
 return home;
}
test('native transcripts are recovered for the right directory and window, skipping thinking, sidechains and system prompts',async t=>{
 const workdir=await mkdtemp(path.join(tmpdir(),'agenthub-proj-'));t.after(()=>rm(workdir,{recursive:true,force:true}));const start=Date.now()-60000;const home=await fakeHome(t,workdir,start);
 const claude=await nativeTranscript('claude',workdir,new Date(start).toISOString(),null,home);assert.ok(claude);assert.deepEqual(claude.entries.map(e=>e.role),['user','assistant','tool','assistant']);assert.match(claude.entries[2].text,/Edit src\/tokenizer.ts/);
 const text=renderTranscript(claude,'Claude Code');assert.match(text,/\[you\] Fix the unicode/);assert.match(text,/\[Claude Code\] Edited the tokenizer/);assert.ok(!text.includes('secret reasoning')&&!text.includes('subagent chatter'));
 const codex=await nativeTranscript('codex',workdir,new Date(start).toISOString(),null,home);assert.ok(codex);assert.deepEqual(codex.entries.map(e=>e.text),['Wire the CLI flag','shell npm test','Flag wired; 3 tests failing.']);
 assert.equal(await nativeTranscript('claude','/nonexistent/other',new Date(start).toISOString(),null,home),null);
 assert.equal(await nativeTranscript('claude',workdir,new Date(start+3600000).toISOString(),new Date(start+7200000).toISOString(),home),null);
 assert.deepEqual(claudeEntries([{type:'user',message:{content:'<local-command-stdout>x'}}],0,Infinity),[]);assert.deepEqual(codexEntries([{type:'event_msg',payload:{type:'token_count'}}],0,Infinity),[]);
});
test('terminal output is cleaned of escape sequences and redraw repeats',()=>{
 const out=cleanTerminalOutput('\x1b[2J\x1b[H\x1b[31mwelcome>\x1b[0m thinking…\r\n\x1b]0;title\x07thinking…\r\nthinking…\r\n\r\n\r\nDone: edited 2 files\x1b[?1049l');
 assert.equal(out,'welcome> thinking…\nthinking…\n\nDone: edited 2 files');
});
test('the work prompt tells the next agent what the previous one did without asking it',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'agenthub-recover-'));t.after(()=>rm(root,{recursive:true,force:true}));const hub=await Hub.init(root);
 const session=await beginWork(hub,'claude',null,root,'work');const home=await fakeHome(t,root,Date.parse(session.startedAt));await endWork(hub,session.id);
 const previousHome=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=previousHome;});
 const prompt=await workPrompt(hub,'codex');assert.match(prompt,/What Claude Code did last session \(recovered from its session log/);assert.match(prompt,/\[Claude Code\] Edited the tokenizer; tests still fail on emoji\./);assert.match(prompt,/hands your session log and the diff to Claude Code automatically/);
});
