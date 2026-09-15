// node-pty 1.1.0's macOS prebuilt spawn-helper can arrive without its executable bit.
// Repair only the packaged helper for this platform; absence leaves PTY optional.
import {createRequire} from 'node:module';
import {chmod,stat} from 'node:fs/promises';
import path from 'node:path';
if(process.platform==='darwin'){
 try{
  const root=path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const helper=path.join(root,'prebuilds',`darwin-${process.arch}`,'spawn-helper');
  const info=await stat(helper);if(info.isFile())await chmod(helper,info.mode|0o111);
 }catch(e){if(e.code!=='MODULE_NOT_FOUND'&&e.code!=='ENOENT')console.warn('Optional PTY helper setup failed:',e.message);}
}
