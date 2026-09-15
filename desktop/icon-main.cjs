// Renders the app icon with Electron itself (no image libraries needed): electron icon-main.cjs <out.png>
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const svg = fs.readFileSync(require('node:path').join(__dirname, 'build', 'logo.svg'), 'utf8');
// macOS icons sit inside a ~10% transparent margin; the mark itself is the rounded square from logo.svg.
const html = `<html><body style="margin:0;background:transparent"><div style="width:1024px;height:1024px;display:grid;place-items:center"><div style="width:830px;height:830px;border-radius:200px;overflow:hidden;box-shadow:0 30px 60px rgba(0,0,0,.35)">${svg.replace('width="512" height="512"', 'width="830" height="830"')}</div></div></body></html>`;
app.whenReady().then(async () => {
    const win = new BrowserWindow({show: false, width: 1024, height: 1024, transparent: true, frame: false, webPreferences: {offscreen: true}});
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 500));
    fs.writeFileSync(process.argv[2], (await win.webContents.capturePage()).toPNG());
    app.exit(0);
});
