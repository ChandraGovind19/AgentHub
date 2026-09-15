// End-to-end smoke test for the desktop shell: temp project -> Electron opens it -> dashboard renders inside the window -> exit 0.
import {mkdtemp, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
// AGENTHUB_APP=/Applications/AgentHub.app/Contents/MacOS/AgentHub smoke-tests a packaged build instead of the dev shell.
const electron = process.env.AGENTHUB_APP || createRequire(import.meta.url)('electron');
const root = await mkdtemp(path.join(tmpdir(), 'agenthub-desktop-smoke-'));
const child = spawn(electron, process.env.AGENTHUB_APP ? [] : [path.dirname(new URL(import.meta.url).pathname)], {env: {...process.env, AGENTHUB_DESKTOP_SMOKE: root, ELECTRON_ENABLE_LOGGING: '0'}, stdio: 'inherit'});
const code = await new Promise(resolve => child.on('exit', resolve));
await rm(root, {recursive: true, force: true});
process.exit(code ?? 1);
