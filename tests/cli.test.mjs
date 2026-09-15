import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Hub} from '../dist/core/hub.js';
import {parseStatus} from '../dist/core/git.js';
const cli = path.resolve('dist/index.js');
async function fixture(t, git = false) { const dir = await mkdtemp(path.join(tmpdir(), 'agenthub-test-')); t.after(() => rm(dir, {recursive:true, force:true})); if (git) { execFileSync('git', ['init', dir]); execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main']); } return dir; }
function run(dir, ...args) { return execFileSync(process.execPath, [cli, ...args], {cwd: dir, encoding: 'utf8', stdio: ['ignore','pipe','pipe']}); }
function fails(dir, args, pattern) { assert.throws(() => run(dir, ...args), e => { assert.match(e.stderr, pattern); return e.status === 1; }); }
test('complete installed-style CLI loop with both agents and Git', async t => {
 const dir = await fixture(t, true); assert.match(run(dir, 'init'), /initialized/);
 assert.match(run(dir, 'task', 'create', 'Build auth', '--files', 'src/auth.ts'), /task_001/);
 run(dir, 'task', 'assign', 'task_001', 'codex'); run(dir, 'task', 'update', 'task_001', '--status', 'in_progress');
 run(dir, 'task', 'create', 'Build UI', '--files', 'src/login.ts'); run(dir, 'task', 'assign', 'task_002', 'claude');
 run(dir, 'lock', 'src/auth.ts', '--agent', 'codex', '--task', 'task_001');
 await mkdir(path.join(dir,'src')); await writeFile(path.join(dir,'src/auth.ts'), 'export const auth = true;\n');
 const handoff = run(dir, 'handoff', 'claude'); assert.match(handoff, /Files You Should Avoid\n\n- src\/auth.ts/); assert.match(handoff, /When You Finish/); assert.match(handoff, /Build UI/);
 execFileSync('git', ['-C',dir,'add','src/auth.ts']); assert.match(run(dir, 'changes'), /src\/auth.ts/);
 run(dir, 'ingest', '--text', 'Auth implemented; tests pass.', '--agent', 'codex', '--task', 'task_001');
 assert.match(run(dir, 'sync'), /Snapshot:/); assert.match(run(dir, 'resume'), /Auth implemented/); assert.match(run(dir,'status'), /codex/);
 assert.equal(JSON.parse(run(dir,'doctor')).ok, true);
 await mkdir(path.join(dir,'nested')); assert.match(run(path.join(dir,'nested'), 'status'), /AgentHub Status/);
 fails(dir, ['init'], /already exists/);
});
test('lock conflicts, task overlap, safe paths, and reassignment', async t => {
 const h = await Hub.init(await fixture(t)); const a = (await h.createTask('A', '', ['src/a.ts'])).task; const b = (await h.createTask('B', '', ['src/a.ts'])).task;
 await h.updateTask(a.id,{agent:'codex'}); await h.updateTask(b.id,{agent:'claude'}); await h.lock('src/../src/a.ts','codex',a.id);
 await assert.rejects(h.lock('src/a.ts','claude',b.id), /Lock conflict/);
 assert.match((await h.warnings([b])).join(''), /overlaps/);
 await assert.rejects(h.updateTask(a.id,{agent:'claude'}), /Unlock/);
 await assert.rejects(h.lock('../outside','codex',a.id), /inside/);
 await symlink(tmpdir(), path.join(h.root,'escape')); await assert.rejects(h.lock('escape/secret','codex',a.id), /outside/);
 await h.unlock('src/a.ts'); await h.updateTask(a.id,{agent:'reviewbot'}); assert.ok((await h.config()).agents.includes('reviewbot'));
 await assert.rejects(h.handoff('../evil'), /Agent names/);
});
test('non-Git project supports handoff, memory and resume', async t => {
 const dir = await fixture(t); run(dir,'init'); run(dir,'memory','add-decision','Use JSON','--reason','Local and inspectable'); run(dir,'memory','add-question','Which test runner?');
 assert.match(run(dir,'memory'), /Use JSON/); assert.match(run(dir,'status'), /Open questions: 1/);
 assert.match(run(dir,'handoff','codex'), /No Git repository/); run(dir,'sync'); assert.match(run(dir,'resume'), /Suggested Next Task/);
 assert.equal(JSON.parse(run(dir,'doctor')).ok,true);
});
test('doctor reports malformed JSON, dangling locks and missing files', async t => {
 const h = await Hub.init(await fixture(t)); await writeFile(h.p('locks.json'), JSON.stringify({'a.ts':{owner:'codex',taskId:'task_999',createdAt:''}}));
 assert.equal((await h.doctor()).ok,false); await writeFile(h.p('tasks/tasks.json'), '{broken'); assert.ok((await h.doctor()).errors.some(e => e.startsWith('tasks:')));
 await rm(h.p('project.md')); assert.ok((await h.doctor()).errors.includes('Missing project.md'));
});
test('CLI errors are actionable and preserve state', async t => {
 const dir = await fixture(t); fails(dir,['status'], /agenthub init/); run(dir,'init'); fails(dir,['task','update','task_999','--status','done'], /Unknown task/);
 run(dir,'task','create','A'); fails(dir,['task','update','task_001','--status','invalid'], /Status must/); assert.equal(JSON.parse(run(dir,'task','list'))[0].status,'todo');
 fails(dir,['ingest','--text',''], /empty/); fails(dir,['memory','edit','../../foo'], /Memory name/);
});
test('Git parser preserves whitespace, renames and staged status', () => {
 assert.deepEqual(parseStatus('R  new name.ts\0old name.ts\0 M tab\tfile.ts\0?? line\nfile\0?? .agenthub/config.json\0'), [
 {status:'R ',file:'new name.ts',original:'old name.ts'}, {status:' M',file:'tab\tfile.ts'}, {status:'??',file:'line\nfile'}]);
});
test('Git summaries include staged, unstaged, untracked, deleted, renamed files', async t => {
 const dir = await fixture(t,true); await writeFile(path.join(dir,'old.txt'),'first\n'); await writeFile(path.join(dir,'deleted.txt'),'delete me');
 execFileSync('git',['-C',dir,'add','.']); execFileSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@example.com','commit','-m','initial']);
 execFileSync('git',['-C',dir,'mv','old.txt','new name.txt']); await rm(path.join(dir,'deleted.txt')); await writeFile(path.join(dir,'untracked\nname.txt'),'new');
 const h = await Hub.init(dir); const s = await h.state(); assert.ok(s.git.changes.some(c => c.original === 'old.txt')); assert.ok(s.git.changes.some(c => c.status === ' D')); assert.ok(s.git.changes.some(c => c.file === 'untracked\nname.txt')); assert.ok(s.git.changes.every(c => !c.file.startsWith('.agenthub')));
});
test('simultaneous writers never silently overwrite task state', async t => {
 const h = await Hub.init(await fixture(t)); const results = await Promise.allSettled([h.createTask('one'),h.createTask('two')]);
 assert.ok(results.some(r=>r.status==='fulfilled')); const tasks = await h.tasks(); assert.equal(tasks.length,results.filter(r=>r.status==='fulfilled').length);
 for(const r of results) if(r.status==='rejected') assert.match(r.reason.message,/being updated/);
});
test('initialized project nested inside a Git repository uses project-relative paths', async t => {
 const dir = await fixture(t,true); const nested = path.join(dir,'packages','app'); await mkdir(nested,{recursive:true});
 const h = await Hub.init(nested); await writeFile(path.join(nested,'hello.ts'),'hello'); await writeFile(path.join(dir,'outside.txt'),'outside');
 const s = await h.state(); assert.deepEqual(s.git.changes.map(c => c.file),['hello.ts']);
});
test('doctor handles structurally invalid JSON without crashing', async t => {
 const h = await Hub.init(await fixture(t)); for (const value of [null, {agents:{}}, {agents:['../escape']}]) { await writeFile(h.p('config.json'),JSON.stringify(value)); const result = await h.doctor(); assert.equal(result.ok,false); assert.ok(result.errors.some(e=>e.startsWith('config:'))); }
});
