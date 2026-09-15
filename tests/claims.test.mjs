import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,utimes,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {Hub} from '../dist/core/hub.js';
import {claimStatus} from '../dist/core/storage.js';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'agenthub-claims-'));t.after(()=>rm(dir,{recursive:true,force:true}));return Hub.init(dir);}
const gone=async f=>{try{await access(f);return false;}catch{return true;}};
test('a writer lock left by a dead process is reclaimed automatically',async t=>{
 const h=await fixture(t);const lock=h.p('.write-lock');
 await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483646,startedAt:'2026-01-01T00:00:00.000Z'}));
 assert.equal(await claimStatus(lock),'stale');assert.match(JSON.stringify(await h.doctor()),/Stale writer lock/);
 await h.createTask('after crash');assert.ok(await gone(lock));assert.equal((await h.tasks()).length,1);
});
test('a writer lock held by a live process still blocks and doctor reports it',async t=>{
 const h=await fixture(t);const lock=h.p('.write-lock');
 await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 assert.equal(await claimStatus(lock),'active');await assert.rejects(h.createTask('blocked'),/being updated/);
 assert.match(JSON.stringify(await h.doctor()),/held by a running command/);await rm(lock,{recursive:true});
});
test('legacy owner-less locks are reclaimed only once they are clearly abandoned',async t=>{
 const h=await fixture(t);const lock=h.p('.write-lock');
 await mkdir(lock);assert.equal(await claimStatus(lock),'active');await assert.rejects(h.createTask('fresh'),/being updated/);
 const old=new Date(Date.now()-120000);await utimes(lock,old,old);assert.equal(await claimStatus(lock),'stale');
 await h.createTask('abandoned');assert.ok(await gone(lock));
});
test('stale run claims are reported by doctor and no longer block patch transfer',async t=>{
 const h=await fixture(t);const claim=h.p('.run-task_001');
 await mkdir(claim);await writeFile(path.join(claim,'owner.json'),JSON.stringify({pid:2147483646}));
 assert.match(JSON.stringify(await h.doctor()),/task_001: stale run claim/);assert.equal(await claimStatus(h.p('.run-none')),'free');
});
