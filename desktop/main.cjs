// AgentHub Desktop: a thin macOS shell around the local-only AgentHub dashboard.
// One dashboard server process per project (system Node, so node-pty stays compatible), a projects sidebar,
// native notifications when an agent session ends, and keyboard switching. No cloud, no telemetry, no automation of native UIs.
const {app, BrowserWindow, WebContentsView, dialog, ipcMain, Menu, Notification, shell, session} = require('electron');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIDEBAR = 250;
const AGENTHUB_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'agenthub') : path.join(__dirname, '..');
const CLI = path.join(AGENTHUB_ROOT, 'dist', 'index.js');
const SMOKE = process.env.AGENTHUB_DESKTOP_SMOKE || '';
const settingsFile = () => path.join(app.getPath('userData'), 'projects.json');

function readSettings() { try { const v = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); return {projects: Array.isArray(v.projects) ? v.projects.filter(p => typeof p === 'string') : [], bounds: v.bounds}; } catch { return {projects: []}; } }
function writeSettings(value) { try { fs.mkdirSync(path.dirname(settingsFile()), {recursive: true}); fs.writeFileSync(settingsFile(), JSON.stringify(value, null, 2)); } catch (e) { console.error('Cannot save settings:', e.message); } }

// GUI apps launched from Finder get a minimal PATH; look in the usual places for the Node that runs the CLI (and built node-pty).
function findNode() {
    const home = os.homedir();
    const candidates = [process.env.AGENTHUB_NODE, ...(process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'node')), '/usr/local/bin/node', '/opt/homebrew/bin/node'];
    for (const base of [path.join(home, '.nvm', 'versions', 'node'), path.join(home, '.volta', 'tools', 'image', 'node'), path.join(home, '.fnm', 'node-versions')]) {
        try { for (const v of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, v, 'bin', 'node'), path.join(base, v, 'installation', 'bin', 'node')); } catch { /* Not installed. */ }
    }
    for (const file of candidates) { if (!file) continue; try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* Next. */ } }
    return null;
}

// Finder-launched apps get a minimal PATH; extend it so the dashboard can find claude/codex installed via npm, Homebrew, nvm or volta.
function cliEnv() {
    const home = os.homedir();
    const extra = ['/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.local', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.codex', 'bin')];
    try { for (const v of fs.readdirSync(path.join(home, '.nvm', 'versions', 'node')).sort().reverse()) extra.push(path.join(home, '.nvm', 'versions', 'node', v, 'bin')); } catch { /* No nvm. */ }
    const PATH = [...new Set([...(process.env.PATH || '').split(path.delimiter), ...extra])].filter(Boolean).join(path.delimiter);
    const env = {...process.env, PATH, NO_COLOR: '1'};
    if (app.isPackaged) env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE;
    return env;
}
const projects = new Map(); // root -> {root,name,child,url,state,error,starting}
let win, view, activeRoot = null, node = null, poller;

function summary() { return [...projects.values()].map(p => ({root: p.root, name: p.name, url: p.url || null, state: p.state || null, error: p.error || null, active: p.root === activeRoot})); }
function broadcast() { if (win && !win.isDestroyed()) win.webContents.send('projects', summary()); Menu.setApplicationMenu(buildMenu()); }

function startProject(root) {
    const project = projects.get(root) || {root, name: path.basename(root)};
    projects.set(root, project);
    project.error = null; project.state = null; project.url = null;
    if (!node) { project.error = 'Node.js 22+ not found. Set AGENTHUB_NODE to its path.'; broadcast(); return project; }
    if (!fs.existsSync(path.join(root, '.agenthub'))) {
        const init = spawnSync(node, [CLI, 'init'], {cwd: root, encoding: 'utf8', env: cliEnv()});
        if (init.status !== 0) { project.error = 'init failed: ' + (init.stderr || init.stdout || '').trim().split('\n')[0]; broadcast(); return project; }
    }
    const child = spawn(node, [CLI, 'dashboard', '--port', '0'], {cwd: root, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe']});
    project.child = child;
    let buffer = '', stderr = '';
    child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        const match = buffer.match(/AgentHub dashboard: (http:\/\/127\.0\.0\.1:\d+)/);
        if (match && !project.url) { project.url = match[1]; broadcast(); if (project.root === activeRoot) showProject(project.root); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.on('exit', code => {
        if (project.child !== child) return;
        project.child = null; project.url = null; project.state = null;
        project.error = code === 0 ? 'dashboard stopped' : 'dashboard exited (' + code + '): ' + (stderr.trim().split('\n').pop() || 'see logs');
        broadcast();
    });
    child.on('error', e => { project.child = null; project.error = e.message; broadcast(); });
    broadcast();
    return project;
}
function stopProject(root) { const p = projects.get(root); if (p?.child) { const child = p.child; p.child = null; child.kill('SIGTERM'); setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Gone. */ } }, 4000).unref(); } }

function showProject(root) {
    activeRoot = root;
    const p = projects.get(root);
    if (view && p?.url && view.webContents.getURL().split('#')[0] !== p.url + '/') view.webContents.loadURL(p.url + '/');
    else if (view && !p?.url) view.webContents.loadURL('about:blank');
    if (win) win.setTitle(p ? 'AgentHub · ' + p.name : 'AgentHub');
    broadcast();
}

async function pollAll() {
    for (const p of projects.values()) {
        if (!p.url) continue;
        try {
            const response = await fetch(p.url + '/api/state', {signal: AbortSignal.timeout(2500)});
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const next = await response.json();
            notifyTransitions(p, p.state, next);
            p.state = next;
        } catch (e) { if (!p.error) p.error = 'unreachable: ' + e.message; }
    }
    broadcast();
}
function notifyTransitions(project, before, after) {
    if (!before || !Notification.isSupported()) return;
    for (const pane of after.panes) {
        const previous = before.panes.find(x => x.pane === pane.pane);
        if (previous?.sessionId && !previous.endedAt && pane.sessionId === previous.sessionId && pane.endedAt) {
            const agent = pane.agent === 'claude' ? 'Claude Code' : 'Codex', other = pane.agent === 'claude' ? 'Codex' : 'Claude Code';
            const n = new Notification({title: `${agent} session ended · ${project.name}`, body: pane.exitCode === 0 ? `Out of usage or done? Continue with ${other} from the shared journal.` : `Exited with code ${pane.exitCode}. Open the project to review.`});
            n.on('click', () => { if (win) { win.show(); win.focus(); } showProject(project.root); });
            n.show();
        }
    }
    for (const pane of after.panes) {
        const previous = before.panes.find(x => x.pane === pane.pane);
        if (pane.limit && pane.sessionId && !pane.endedAt && !(previous?.limit && previous.sessionId === pane.sessionId)) {
            const agent = pane.agent === 'claude' ? 'Claude Code' : 'Codex', other = pane.agent === 'claude' ? 'Codex' : 'Claude Code';
            const n = new Notification({title: `${agent} hit its usage limit · ${project.name}`, body: `${pane.limit.resetsAt ? `Resets ${pane.limit.resetsAt}. ` : ''}Continue with ${other}: the context is ready.`});
            n.on('click', () => { if (win) { win.show(); win.focus(); } showProject(project.root); }); n.show();
        }
    }
    if (before.action?.status === 'running' && after.action && after.action.status !== 'running') {
        const n = new Notification({title: `Action ${after.action.status} · ${project.name}`, body: after.action.command});
        n.on('click', () => { if (win) { win.show(); win.focus(); } showProject(project.root); }); n.show();
    }
}

async function addProject() {
    const result = await dialog.showOpenDialog(win, {title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'], message: 'AgentHub initializes .agenthub/ in the folder if needed.'});
    if (result.canceled || !result.filePaths[0]) return;
    openProject(result.filePaths[0]);
}
function openProject(root) {
    root = path.resolve(root);
    try { root = fs.realpathSync(root); } catch { /* Keep the resolved path. */ }
    if (!projects.has(root)) startProject(root);
    const settings = readSettings();
    if (!settings.projects.includes(root)) { settings.projects.push(root); writeSettings(settings); }
    showProject(root);
}
function removeProject(root) {
    stopProject(root); projects.delete(root);
    const settings = readSettings(); settings.projects = settings.projects.filter(p => p !== root); writeSettings(settings);
    if (activeRoot === root) showProject([...projects.keys()][0] || null); else broadcast();
}

// User-triggered only: the app makes no network requests on its own. Unsigned builds cannot self-update on macOS, so this points at the download page.
async function checkForUpdates() {
    try {
        const response = await fetch('https://api.github.com/repos/ChandraGovind19/AgentHub/releases/latest', {headers: {Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(8000)});
        if (response.status === 404) { dialog.showMessageBox(win, {message: 'No releases published yet.', detail: `You are running ${app.getVersion()}.`}); return; }
        if (!response.ok) throw new Error('GitHub returned ' + response.status);
        const release = await response.json(); const latest = String(release.tag_name || '').replace(/^v/, '');
        const newer = latest.localeCompare(app.getVersion(), undefined, {numeric: true}) > 0;
        const {response: choice} = await dialog.showMessageBox(win, {message: newer ? `AgentHub ${latest} is available` : 'You are up to date', detail: `Installed: ${app.getVersion()}. Latest: ${latest || 'unknown'}.`, buttons: newer ? ['Open download page', 'Later'] : ['OK'], defaultId: 0});
        if (newer && choice === 0) shell.openExternal(release.html_url);
    } catch (e) { dialog.showMessageBox(win, {type: 'warning', message: 'Could not check for updates', detail: e.message}); }
}
function buildMenu() {
    const roots = [...projects.keys()];
    return Menu.buildFromTemplate([
        {label: app.name, submenu: [{role: 'about'}, {type: 'separator'}, {role: 'hide'}, {role: 'hideOthers'}, {role: 'unhide'}, {type: 'separator'}, {role: 'quit'}]},
        {label: 'File', submenu: [
            {label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: addProject},
            {label: 'Close Project', accelerator: 'CmdOrCtrl+W', enabled: !!activeRoot, click: () => activeRoot && removeProject(activeRoot)},
            {label: 'Restart Dashboard', accelerator: 'CmdOrCtrl+Shift+R', enabled: !!activeRoot, click: () => activeRoot && (stopProject(activeRoot), setTimeout(() => startProject(activeRoot), 500))},
            {type: 'separator'},
            {label: 'Reveal Project in Finder', enabled: !!activeRoot, click: () => activeRoot && shell.showItemInFolder(activeRoot)},
            {type: 'separator'},
            {label: 'Check for Updates…', click: checkForUpdates},
        ]},
        {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
        {label: 'View', submenu: [
            {label: 'Reload Dashboard', accelerator: 'CmdOrCtrl+R', click: () => view?.webContents.reload()},
            {label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => view?.webContents.toggleDevTools()},
            {type: 'separator'}, {role: 'togglefullscreen'},
        ]},
        {label: 'Projects', submenu: roots.length ? roots.map((root, i) => ({label: path.basename(root), accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined, type: 'checkbox', checked: root === activeRoot, click: () => showProject(root)})) : [{label: 'No projects open', enabled: false}]},
        {role: 'window', submenu: [{role: 'minimize'}, {role: 'zoom'}, {role: 'front'}]},
    ]);
}

function layout() { if (!win || !view) return; const b = win.getContentBounds(); view.setBounds({x: SIDEBAR, y: 0, width: Math.max(0, b.width - SIDEBAR), height: b.height}); }

function createWindow() {
    const settings = readSettings();
    win = new BrowserWindow({...(settings.bounds || {width: 1440, height: 900}), minWidth: 980, minHeight: 600, title: 'AgentHub', titleBarStyle: 'hiddenInset', trafficLightPosition: {x: 14, y: 18}, backgroundColor: '#0b0d12', webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    win.loadFile(path.join(__dirname, 'shell.html'));
    view = new WebContentsView({webPreferences: {contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundColor: '#0b0d12'}});
    win.contentView.addChildView(view);
    // The dashboard view may only ever show a local AgentHub dashboard; everything else is refused.
    const local = url => { try { const u = new URL(url); return u.hostname === '127.0.0.1' && [...projects.values()].some(p => p.url && url.startsWith(p.url + '/')); } catch { return url === 'about:blank'; } };
    view.webContents.on('will-navigate', (event, url) => { if (!local(url)) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    view.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    win.on('resize', layout); layout();
    win.on('close', () => { const s = readSettings(); s.bounds = win.getBounds(); writeSettings(s); });
    win.on('closed', () => { win = null; view = null; });
}

ipcMain.handle('projects:list', () => summary());
ipcMain.handle('projects:add', () => addProject());
ipcMain.handle('projects:select', (_e, root) => { if (typeof root === 'string' && projects.has(root)) showProject(root); });
ipcMain.handle('projects:remove', (_e, root) => { if (typeof root === 'string' && projects.has(root)) removeProject(root); });
ipcMain.handle('projects:menu', (_e, root) => {
    if (typeof root !== 'string' || !projects.has(root) || !win) return;
    Menu.buildFromTemplate([
        {label: 'Open', click: () => showProject(root)},
        {label: 'Reveal in Finder', click: () => shell.showItemInFolder(root)},
        {label: 'Restart Dashboard', click: () => { stopProject(root); setTimeout(() => startProject(root), 500); }},
        {type: 'separator'},
        {label: 'Close Project', click: () => removeProject(root)},
    ]).popup({window: win});
});
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('projects:restart', (_e, root) => { if (typeof root === 'string' && projects.has(root)) { stopProject(root); setTimeout(() => startProject(root), 500); } });

app.whenReady().then(async () => {
    // Packaged builds run the CLI with Electron's bundled Node (ELECTRON_RUN_AS_NODE), so users need no Node.js install.
    node = app.isPackaged ? process.execPath : findNode();
    if (!node) dialog.showErrorBox('Node.js not found', 'AgentHub Desktop runs the AgentHub CLI with your installed Node.js 22+. Install Node (or set AGENTHUB_NODE) and relaunch.');
    if (!fs.existsSync(CLI)) dialog.showErrorBox('AgentHub build missing', `Expected ${CLI}. Run npm run build in the AgentHub directory.`);
    createWindow();
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(false));
    const roots = SMOKE ? [SMOKE] : readSettings().projects.filter(r => fs.existsSync(r));
    for (const root of roots) startProject(root);
    showProject(roots[0] || null);
    poller = setInterval(pollAll, 3000);
    if (SMOKE) runSmoke();
});
app.on('window-all-closed', () => app.quit());
function shutdown() { clearInterval(poller); for (const root of projects.keys()) stopProject(root); }
app.on('before-quit', shutdown);
app.on('will-quit', shutdown);

// Smoke mode (AGENTHUB_DESKTOP_SMOKE=<project dir>): open the project, verify the dashboard renders inside the shell and the
// state API answers, print SMOKE OK, and exit. Used by desktop/smoke.mjs so the end-to-end path is testable without a human.
function runSmoke() {
    const started = Date.now();
    const fail = message => { console.error('SMOKE FAIL: ' + message); shutdown(); setTimeout(() => app.exit(1), 300); };
    const timer = setInterval(async () => {
        const p = projects.get(path.resolve(SMOKE));
        if (Date.now() - started > 30000) { clearInterval(timer); return fail('timeout; error=' + (p?.error || 'none')); }
        if (p?.error) { clearInterval(timer); return fail(p.error); }
        if (!p?.url || !p.state || view.webContents.isLoading() || view.webContents.getURL() !== p.url + '/') return;
        clearInterval(timer);
        try {
            const title = await view.webContents.executeJavaScript('document.title');
            const hasWork = await view.webContents.executeJavaScript('!!document.getElementById("work") && !!document.getElementById("terminal-screen-left")');
            if (!/^AgentHub · /.test(title) || !hasWork) return fail(`unexpected page: ${title} work=${hasWork}`);
            if (p.state.panes.length !== 2) return fail('state API panes=' + p.state.panes.length);
            if (process.env.AGENTHUB_DESKTOP_SHOT) { await new Promise(r => setTimeout(r, 800)); fs.writeFileSync(process.env.AGENTHUB_DESKTOP_SHOT, (await win.capturePage()).toPNG()); fs.writeFileSync(process.env.AGENTHUB_DESKTOP_SHOT.replace(/\.png$/, '-dashboard.png'), (await view.webContents.capturePage()).toPNG()); console.log('SMOKE layout: window', JSON.stringify(win.getContentBounds()), 'view', JSON.stringify(view.getBounds())); }
            console.log(`SMOKE OK: ${title} at ${p.url} via ${node}`);
            shutdown(); setTimeout(() => app.exit(0), 300);
        } catch (e) { fail(e.message); }
    }, 250);
}
