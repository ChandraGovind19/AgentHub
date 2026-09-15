import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
export type Classification = 'success'|'failed'|'timed_out'|'rate_limited'|'auth_error'|'unknown_error';
export async function tail(file: string, limit = 12000): Promise<string> {
    const handle = await fs.open(file,'r');
    try { const size = (await handle.stat()).size; const buffer = Buffer.alloc(Math.min(size,limit)); await handle.read(buffer,0,buffer.length,Math.max(0,size-limit)); return buffer.toString('utf8'); } finally { await handle.close(); }
}
export function classify(exitCode: number|null, timedOut: boolean, text: string, launchError = false): Classification {
    if (timedOut) return 'timed_out';
    if (launchError) return 'unknown_error';
    if (exitCode === 0) return 'success';
    if (/rate.?limit|usage limit|quota exceeded|too many requests|\b429\b/i.test(text)) return 'rate_limited';
    if (/authentication|unauthorized|not logged in|invalid api key|login required|\b401\b/i.test(text)) return 'auth_error';
    return exitCode === null ? 'unknown_error' : 'failed';
}
export async function execute(command: string, args: string[], cwd: string, prompt: string, folder: string, timeoutSeconds: number) {
    const stdout = createWriteStream(path.join(folder,'stdout.log'),{mode:0o600});
    const stderr = createWriteStream(path.join(folder,'stderr.log'),{mode:0o600});
    // Attach rejection handlers before launching so disk errors cannot escape as unhandled events.
    const saved = Promise.allSettled([finished(stdout),finished(stderr)]);
    let timedOut = false; let launchError: string | undefined; let ioError: string | undefined;
    const result = await new Promise<{exitCode:number|null;signal:string|null}>(resolve => {
        const child = spawn(command,args,{cwd,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform !== 'win32'});
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const kill = (signal: NodeJS.Signals) => {
            try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid,signal); else child.kill(signal); } catch { /* Process may already have exited. */ }
        };
        const stop = (signal: NodeJS.Signals) => { kill(signal); if (!escalation) escalation = setTimeout(()=>kill('SIGKILL'),1000); };
        const timer = setTimeout(()=>{timedOut=true;stop('SIGTERM');},timeoutSeconds*1000);
        const interrupt = () => stop('SIGINT'); const terminate = () => stop('SIGTERM');
        process.on('SIGINT',interrupt); process.on('SIGTERM',terminate);
        stdout.on('error',e=>{ioError=e.message;stop('SIGTERM');}); stderr.on('error',e=>{ioError=e.message;stop('SIGTERM');});
        child.stdout.pipe(stdout); child.stderr.pipe(stderr);
        child.stdout.on('data',chunk=>process.stdout.write(chunk)); child.stderr.on('data',chunk=>process.stderr.write(chunk));
        child.stdin.on('error',()=>{ /* Early exit can close stdin before the prompt is consumed. */ });
        child.once('error',e=>{launchError=e.message;});
        child.once('close',(exitCode,signal)=>{
            clearTimeout(timer); if (escalation) { kill('SIGKILL'); clearTimeout(escalation); }
            process.off('SIGINT',interrupt); process.off('SIGTERM',terminate);
            resolve({exitCode,signal});
        });
        child.stdin.end(prompt);
    });
    for (const outcome of await saved) if (outcome.status === 'rejected') ioError = String(outcome.reason);
    return {...result,timedOut,launchError,ioError};
}
