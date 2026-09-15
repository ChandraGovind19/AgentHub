import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Hub } from '../dist/core/hub.js';
import { git } from '../dist/core/git.js';
import { clipboardCommands, copyToClipboard } from '../dist/core/clipboard.js';
import { parseSummary } from '../dist/core/ingest.js';
const cli = path.resolve('dist/index.js');
const run = (root, ...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function fixture(t, repository = false) {
    const parent = await mkdtemp(path.join(tmpdir(), 'agenthub-v02-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'project'); await mkdir(root);
    if (repository) {
        await git(root, ['init']); await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await writeFile(path.join(root, '.gitignore'), '.agenthub/\n');
        await writeFile(path.join(root, 'base.txt'), 'base\n'); await git(root, ['add', '.']); await commit(root, 'initial');
    }
    return { hub: await Hub.init(root), root, parent };
}
async function commit(root, message) { await git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]); }
async function tree(dir) {
    const data = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) { const name = path.join(dir, entry.name); data[entry.name] = entry.isDirectory() ? await tree(name) : await readFile(name, 'utf8'); }
    return data;
}
const summary = `## Summary of Changes
- Implemented authentication.

## Files Modified
- \`src/../src/auth.ts\`
- src/auth.ts
- ../../outside.txt
- /absolute.txt
- C:\\outside.txt
- src/*.ts
- \`src/file with spaces.ts\`

## Important Decisions
- Use local sessions.
- Keep storage replaceable.

## Follow-up Tasks
- Add session expiry tests
- Document login flow

## AgentHub Memory Updates
- Sessions expire after one hour.
`;
test('clipboard commands, fallback, and failure are deterministic', async () => {
    assert.equal(clipboardCommands('darwin')[0].command, 'pbcopy');
    assert.equal(clipboardCommands('win32')[0].command, 'clip');
    const calls = [];
    await copyToClipboard('markdown', 'linux', async (c, text) => { calls.push(c.command); assert.equal(text, 'markdown'); if(c.command === 'wl-copy') throw new Error('no Wayland session'); });
    assert.deepEqual(calls, ['wl-copy', 'xclip']);
    await assert.rejects(copyToClipboard('markdown','darwin',async()=>{throw new Error('missing');}), /Clipboard copy failed/);
});
test('handoff --copy --quiet invokes mock clipboard and preserves saved Markdown', async t => {
    const { root, parent } = await fixture(t); const bin = path.join(parent,'bin'); await mkdir(bin);
    const output = path.join(parent,'clipboard.md');
    for (const name of ['pbcopy','wl-copy','xclip','xsel','clip']) { const file = path.join(bin,name); await writeFile(file, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.env.TEST_CLIPBOARD, fs.readFileSync(0));\n`); await chmod(file,0o755); }
    const result = spawnSync(process.execPath,[cli,'handoff','codex','--copy','--quiet'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,TEST_CLIPBOARD:output}});
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,''); assert.match(result.stderr,/copied to clipboard/);
    const files = await readdir(path.join(root,'.agenthub','handoffs')); assert.equal(files.length,1); assert.equal(await readFile(output,'utf8'),await readFile(path.join(root,'.agenthub','handoffs',files[0]),'utf8'));
    const copiedReview = spawnSync(process.execPath,[cli,'review','codex','--save','--copy'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,TEST_CLIPBOARD:output}});
    assert.equal(copiedReview.status,0,copiedReview.stderr); assert.match(copiedReview.stderr,/Review copied to clipboard/);
    const reviewFiles = await readdir(path.join(root,'.agenthub','reviews'));
    assert.equal(await readFile(output,'utf8'),await readFile(path.join(root,'.agenthub','reviews',reviewFiles[0]),'utf8'));
    const failure = spawnSync(process.execPath,[cli,'handoff','codex','--copy'],{cwd:root,encoding:'utf8',env:{...process.env,PATH:bin,TEST_CLIPBOARD:path.join(parent,'missing','file')}});
    assert.equal(failure.status,1); assert.match(failure.stdout,/AgentHub Handoff/); assert.match(failure.stderr,/Handoff was still saved/); assert.equal((await readdir(path.join(root,'.agenthub','handoffs'))).length,2);
});
test('complete keeps locks by default, records note, explicitly releases only task locks', async t => {
    const { hub, root } = await fixture(t);
    const a = (await hub.createTask('A')).task; const b = (await hub.createTask('B')).task;
    await hub.lock('a.ts','codex',a.id); await hub.lock('b.ts','claude',b.id);
    assert.match(run(root,'complete',a.id,'--note','Tested'),/1 related locks remain/);
    assert.equal((await hub.tasks())[0].status,'done'); assert.ok((await hub.tasks())[0].notes.includes('Tested'));
    assert.equal(Object.keys(await hub.locks()).length,2);
    run(root,'complete',a.id,'--keep-locks'); assert.equal(Object.keys(await hub.locks()).length,2);
    run(root,'complete',a.id,'--unlock'); assert.deepEqual(Object.keys(await hub.locks()),['b.ts']);
    await assert.rejects(hub.complete('task_999'),/Unknown task/);
    await assert.rejects(hub.complete(a.id,{unlock:true,keepLocks:true}),/either/);
    assert.match(await readFile(hub.p('activity.jsonl'),'utf8'),/task_completed/);
});
test('parser recognizes headings, merges repeated sections and ignores code fences/unknown headings', () => {
    const parsed = parseSummary('## Summary of Changes\r\n- First\r\n## Unknown\r\n- no\r\n```md\n## Important Decisions\n- fake\n```\n## Summary of Changes\n- Second\n## Important Decisions\n- Real');
    assert.equal(parsed['Summary of Changes'],'- First\n- Second'); assert.equal(parsed['Important Decisions'],'- Real');
});
test('ingest extraction preview has zero writes, applies files/decisions/followups/durable notes', async t => {
    const { hub, root } = await fixture(t); const task = (await hub.createTask('Auth')).task;
    await hub.addMemory('decisions','Existing decision'); const source = path.join(root,'summary.md'); await writeFile(source,summary);
    const before = await tree(hub.p());
    const plan = JSON.parse(run(root,'ingest',source,'--agent','codex','--task',task.id,'--extract','--dry-run'));
    assert.equal(plan.dryRun,true); assert.equal(plan.plan.decisions.length,2); assert.equal(plan.plan.ignoredFiles.length,4); assert.deepEqual(await tree(hub.p()),before);
    const applied = JSON.parse(run(root,'ingest',source,'--agent','codex','--task',task.id,'--extract'));
    assert.equal(applied.createdTasks.length,2); const tasks = await hub.tasks();
    assert.deepEqual(tasks[0].files,['src/auth.ts','src/file with spaces.ts']); assert.match(tasks[0].notes[0],/Implemented authentication/);
    assert.ok(tasks.slice(1).every(t=>t.status==='todo' && t.assignedAgent===null && t.notes[0].includes('Follow-up from ingest')));
    const decisions = await readFile(hub.p('memory/decisions.md'),'utf8'); assert.match(decisions,/DEC-002: Use local sessions/); assert.match(decisions,/Agent: codex; task: task_001/);
    await hub.sync(); assert.match(await hub.memory(),/Sessions expire after one hour/); assert.match((await hub.handoff('codex')).text,/Sessions expire after one hour/); assert.match(await hub.resume(),/Sessions expire after one hour/);
    assert.equal((await hub.doctor()).ok,true);
});
test('text extraction, invalid task, symlink escape and no-extract compatibility', async t => {
    const { hub, root, parent } = await fixture(t); const task = (await hub.createTask('A')).task;
    await symlink(parent,path.join(root,'escape'));
    const plan = await hub.ingestExtract('## Files Modified\n- escape/outside.ts','generic',task.id,true); assert.equal(plan.plan.files.length,0);
    const before = await tree(hub.p()); await assert.rejects(hub.ingestExtract(summary,'generic','task_999'),/Unknown task/); assert.deepEqual(await tree(hub.p()),before);
    run(root,'ingest','--text','## Important Decisions\n- Keep simple','--extract','--agent','claude'); assert.match(await readFile(hub.p('memory/decisions.md'),'utf8'),/Keep simple/);
    const count = (await hub.tasks()).length; run(root,'ingest','--text',summary); assert.equal((await hub.tasks()).length,count);
});
test('v0.1 state upgrades lazily and retains doctor compatibility', async t => {
    const { hub } = await fixture(t); await rm(hub.p('worktrees.json')); await rm(hub.p('memory/notes.md')); await rm(hub.p('reviews'),{recursive:true});
    assert.equal((await hub.doctor()).ok,true); assert.deepEqual(await hub.worktreeList(),[]);
    await hub.ingestExtract('## AgentHub Memory Updates\n- Durable imported note'); await hub.sync(); assert.match(await hub.memory(),/Durable imported note/);
});
test('worktree CLI creates isolated branch, lists status, handoff mentions location, clean removal retains branch', async t => {
    const { hub, root } = await fixture(t,true);
    const wt = JSON.parse(run(root,'worktree','create','codex'));
    assert.equal(wt.branch,'agenthub/codex'); assert.equal(JSON.parse(run(root,'worktree','list')).length,1);
    const status = JSON.parse(run(root,'worktree','status'))[0]; assert.equal(status.exists,true); assert.equal(status.git.branch,'agenthub/codex');
    assert.match(run(root,'handoff','codex'),/Recommended Working Directory/); assert.ok(run(root,'handoff','codex').includes(wt.path));
    assert.equal((await hub.doctor()).ok,true);
    run(root,'worktree','remove','codex'); assert.equal((await hub.worktreeList()).length,0); assert.match(await git(root,['branch','--list','agenthub/codex']),/agenthub\/codex/);
});
test('worktree remove refuses dirty and ignored files; force is explicit', async t => {
    const { hub } = await fixture(t,true); const wt = await hub.worktreeCreate('codex');
    await writeFile(path.join(wt.path,'new.txt'),'uncommitted'); await assert.rejects(hub.worktreeRemove('codex'),/uncommitted/);
    assert.ok((await hub.worktreeStatus())[0].git.changes.some(c=>c.file==='new.txt')); await rm(path.join(wt.path,'new.txt'));
    await mkdir(path.join(wt.path,'.agenthub')); await writeFile(path.join(wt.path,'.agenthub','local-note'),'do not discard'); await assert.rejects(hub.worktreeRemove('codex'),/ignored/);
    await hub.worktreeRemove('codex',true); assert.deepEqual(await hub.worktreeList(),[]);
});
test('worktree validates target, agent, branch, duplicate, and existing nonempty folder', async t => {
    const { hub, parent } = await fixture(t,true);
    await assert.rejects(hub.worktreeCreate('../bad'),/Agent names/);
    await assert.rejects(hub.worktreeCreate('codex',{path:'.agenthub/work'}),/outside/);
    await assert.rejects(hub.worktreeCreate('codex',{path:'inside'}),/outside/);
    await assert.rejects(hub.worktreeCreate('codex',{branch:'-bad'}),/Invalid/);
    const nonempty = path.join(parent,'nonempty'); await mkdir(nonempty); await writeFile(path.join(nonempty,'keep'),'preserve');
    await assert.rejects(hub.worktreeCreate('codex',{path:nonempty}),/empty directory/);
    const wt = await hub.worktreeCreate('codex',{path:'../custom path',branch:'agenthub/custom'}); assert.equal(wt.branch,'agenthub/custom');
    await assert.rejects(hub.worktreeCreate('codex'),/already has/); await hub.worktreeRemove('codex');
});
test('worktree can reuse existing branch and refuses unborn/non-Git repositories', async t => {
    const { hub, root } = await fixture(t,true); await git(root,['branch','agenthub/codex']); await hub.worktreeCreate('codex'); await hub.worktreeRemove('codex');
    const other = await fixture(t); await assert.rejects(other.hub.worktreeCreate('codex'),/Git repository/);
    await git(other.root,['init']); await assert.rejects(other.hub.worktreeCreate('codex'),/initial Git commit/);
});
test('removal refuses forged registry paths and changed worktree branches', async t => {
    const { hub, root, parent } = await fixture(t,true); const wt = await hub.worktreeCreate('codex');
    await git(wt.path,['checkout','-b','different']); await assert.rejects(hub.worktreeRemove('codex',true),/branch differs/); await git(wt.path,['checkout',wt.branch]);
    const arbitrary = path.join(parent,'unmanaged'); await git(root,['worktree','add','-b','unmanaged',arbitrary]);
    await writeFile(hub.p('worktrees.json'),JSON.stringify([{...wt,path:await realpath(arbitrary),branch:'unmanaged'}]));
    await assert.rejects(hub.worktreeRemove('codex',true),/agenthub-owner/); assert.equal(await readFile(path.join(arbitrary,'base.txt'),'utf8'),'base\n');
    await writeFile(hub.p('worktrees.json'),JSON.stringify([wt])); await hub.worktreeRemove('codex'); await git(root,['worktree','remove',arbitrary]);
});
test('review combines committed work, dirty changes, lock conflicts, and saves Markdown', async t => {
    const { hub, root } = await fixture(t,true); const wt = await hub.worktreeCreate('codex');
    const task = (await hub.createTask('Claude task')).task; await hub.lock('base.txt','claude',task.id);
    await writeFile(path.join(wt.path,'base.txt'),'changed\n'); await git(wt.path,['add','base.txt']); await commit(wt.path,'Codex change');
    await writeFile(path.join(wt.path,'dirty.txt'),'pending');
    const result = await hub.review('codex',true); assert.ok(result.file); assert.match(result.text,/Codex change/); assert.match(result.text,/base.txt/); assert.match(result.text,/dirty.txt/); assert.match(result.text,/locked by claude/); assert.match(result.text,/Base: main/);
    assert.equal(await readFile(result.file,'utf8'),result.text); assert.match(run(root,'review','codex','--save'),/AgentHub Review/);
    const fallback = await hub.review('generic'); assert.match(fallback.text,/cannot be reliably attributed/);
    await hub.worktreeRemove('codex',true);
});
test('doctor flags malformed/missing worktree registrations', async t => {
    const { hub } = await fixture(t,true); await writeFile(hub.p('worktrees.json'), '{}'); assert.equal((await hub.doctor()).ok,false);
    await writeFile(hub.p('worktrees.json'),'[]'); const wt = await hub.worktreeCreate('codex'); await rm(wt.path,{recursive:true,force:true}); assert.equal((await hub.doctor()).ok,false);
});
test('review excludes base-only commits and detects locks on renamed source files', async t => {
    const { hub, root } = await fixture(t,true); const wt = await hub.worktreeCreate('codex');
    await writeFile(path.join(root,'main-only.txt'),'main addition'); await git(root,['add','main-only.txt']); await commit(root,'Main only');
    await git(wt.path,['mv','base.txt','renamed.txt']); await commit(wt.path,'Rename base');
    const task = (await hub.createTask('Review source')).task; await hub.lock('base.txt','claude',task.id);
    const report = (await hub.review('codex')).text; const changed = report.split('## Changed Files')[1].split('## Diff Stat')[0];
    assert.ok(!changed.includes('main-only.txt')); assert.match(changed,/base.txt/); assert.match(report,/locked by claude/);
    await hub.worktreeRemove('codex');
});
test('ingest keeps examples fenced until a valid closing fence', () => {
    for (const fence of ['```', '~~~']) {
        const parsed = parseSummary(`${fence}md\n${fence}not-a-closing-fence\n## Important Decisions\n- Example only\n${fence}\n## Important Decisions\n- Actual decision`);
        assert.equal(parsed['Important Decisions'], '- Actual decision');
    }
});
test('ingest ignores bracket and brace patterns without mutating preview state', async t => {
    const { hub } = await fixture(t);
    const before = await tree(hub.p());
    const result = await hub.ingestExtract('## Files Modified\n- src/[ab].ts\n- src/{a,b}.ts\n- src/valid.ts', 'generic', undefined, true);
    assert.deepEqual(result.plan.files, ['src/valid.ts']);
    assert.deepEqual(result.plan.ignoredFiles, ['src/[ab].ts', 'src/{a,b}.ts']);
    assert.deepEqual(await tree(hub.p()), before);
});
