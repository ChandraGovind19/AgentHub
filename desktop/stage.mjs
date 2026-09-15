// Stage the AgentHub CLI (dist + production dependencies) into desktop/stage/agenthub so electron-builder can bundle it.
// The packaged app runs the CLI with Electron's own Node, so end users need no Node.js install; node-pty ships N-API prebuilds.
import {cp, mkdir, readFile, rm, chmod, stat} from 'node:fs/promises';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, '..'), stage = path.join(here, 'stage', 'agenthub');
await rm(path.join(here, 'stage'), {recursive: true, force: true});
await mkdir(path.join(stage, 'node_modules'), {recursive: true});
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), {recursive: true});
await cp(path.join(root, 'package.json'), path.join(stage, 'package.json'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const queue = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})], done = new Set();
while (queue.length) {
    const name = queue.shift(); if (done.has(name)) continue; done.add(name);
    const source = path.join(root, 'node_modules', name);
    try { await stat(source); } catch { console.warn(`skip missing ${name}`); continue; }
    await cp(source, path.join(stage, 'node_modules', name), {recursive: true, dereference: true});
    const sub = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    queue.push(...Object.keys(sub.dependencies || {}), ...Object.keys(sub.optionalDependencies || {}));
}
for (const arch of ['darwin-arm64', 'darwin-x64']) { try { const helper = path.join(stage, 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper'); await chmod(helper, (await stat(helper)).mode | 0o111); } catch { /* Not present. */ } }
console.log(`staged ${[...done].join(', ')} into ${stage}`);
