// Builds build/icon.icns from the Electron-rendered PNG using macOS sips + iconutil.
import {spawnSync} from 'node:child_process';
import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const here = path.dirname(new URL(import.meta.url).pathname), build = path.join(here, 'build'), set = path.join(build, 'icon.iconset');
mkdirSync(build, {recursive: true}); rmSync(set, {recursive: true, force: true}); mkdirSync(set);
const png = path.join(build, 'icon-1024.png');
const run = (cmd, args) => { const r = spawnSync(cmd, args, {stdio: 'inherit'}); if (r.status !== 0) { console.error(`${cmd} failed`); process.exit(1); } };
run(createRequire(import.meta.url)('electron'), [path.join(here, 'icon-main.cjs'), png]);
for (const [size, name] of [[16, '16x16'], [32, '16x16@2x'], [32, '32x32'], [64, '32x32@2x'], [128, '128x128'], [256, '128x128@2x'], [256, '256x256'], [512, '256x256@2x'], [512, '512x512'], [1024, '512x512@2x']]) run('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${name}.png`)]);
run('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
rmSync(set, {recursive: true, force: true});
console.log('icon written to', path.join(build, 'icon.icns'));
