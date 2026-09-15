import {createRequire} from 'node:module';
import path from 'node:path';
import {dashboardTerminal} from './dashboard-terminal.js';
import {terminalClient} from './dashboard-terminal-view.js';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Hub } from './hub.js';
import { dashboardState, safeDashboardPath } from './dashboard-state.js';
import { dashboardActions, planAction, confirmationHtml, escapeHtml } from './dashboard-actions.js';
import { dashboardHtml } from './dashboard-view.js';
import { readWork, otherAgent } from './work.js';
export async function startDashboard(hub:Hub, port=3737) {
    if (!Number.isInteger(port)||port<0||port>65535)throw new Error('Dashboard port must be an integer from 0 to 65535.');
    await hub.config();
    const actions=dashboardActions(hub);
    const terminal=dashboardTerminal(hub);const streams=new Set<import('node:http').ServerResponse>();
    const require=createRequire(import.meta.url);
    let artifacts=new Map<string,string>();let host='';
    const server=createServer(async(req,res)=>{
        const nonce=randomBytes(16).toString('base64');
        // Scripts are nonce-locked. Styles allow inline because xterm.js injects <style> elements for cell dimensions, theme and scrollbar at runtime; blocking them breaks terminal layout.
        res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
        res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');// 'same-origin', not 'no-referrer': per the Fetch spec browsers send `Origin: null` on non-GET
        // navigations (form posts) under no-referrer, even same-origin, so the local-only check below rejected every dashboard action in Chrome.
        res.setHeader('Referrer-Policy','same-origin');
        // The server only listens on the loopback interface, so a Host of exactly localhost:<port> can only come from this machine; send it to the canonical URL instead of a 403.
        if(req.headers.host===`localhost:${host.split(':')[1]}`&&!req.headers.origin&&(req.method==='GET'||req.method==='HEAD')){res.writeHead(302,{Location:`http://${host}/`});res.end();return;}
        if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==`http://${host}`)){res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'});res.end(`Local requests only. Open the dashboard at http://${host} (not localhost or another host name).`);return;}
        if(req.url?.startsWith('/terminal/')){
            if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end('Use POST.');return;}
            try{
                const endpoint=req.url.slice(10);if(!['launch','input','resize','stop','events'].includes(endpoint))throw new Error('Unknown terminal action.');
                if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new Error('Expected form data.');
                let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>65536)throw new Error('Request too large.');}
                const fields=new URLSearchParams(body);
                if(fields.getAll('token').length!==1||fields.get('token')!==actions.token){res.writeHead(403);res.end('Invalid session token.');return;}
                const keys=endpoint==='launch'?['token','pane','agent','task','worktree','confirmed','cols','rows','prompt']:endpoint==='input'?['token','pane','session','data']:endpoint==='resize'?['token','pane','session','cols','rows']:endpoint==='stop'?['token','pane','session']:['token','pane'];
                if([...fields.keys()].some(k=>!keys.includes(k)||fields.getAll(k).length!==1))throw new Error('Unexpected terminal parameter.');
                // Omitted pane retains compatibility with the original single-terminal endpoints.
                const pane=terminal.forPane(fields.get('pane')??'left');
                if(endpoint==='events'){
                    if(streams.size>=4){res.writeHead(409);res.end('Too many terminal displays. Close an existing tab.');return;}
                    res.writeHead(200,{'Content-Type':'text/event-stream','X-Accel-Buffering':'no'});res.flushHeaders();streams.add(res);
                    const unsubscribe=pane.subscribe(event=>{if(!res.destroyed){res.write(`data: ${JSON.stringify(event)}\n\n`);if(res.writableLength>262144)res.destroy();}});
                    const heartbeat=setInterval(()=>res.write(': keepalive\n\n'),15000);
                    res.on('close',()=>{clearInterval(heartbeat);unsubscribe();streams.delete(res);});return;
                }
                let result:unknown={ok:true};
                if(endpoint==='launch'){
                    if(actions.busy||pane.busy){res.writeHead(409);res.end('An action or a session in this pane is already running.');return;}
                    result=await pane.launch(fields);
                }else{const id=fields.get('session')||'';if(!id)throw new Error('Session required.');
                    if(endpoint==='input')pane.input(id,fields.get('data')||'');
                    if(endpoint==='resize')pane.resize(id,Number(fields.get('cols')),Number(fields.get('rows')));
                    if(endpoint==='stop')await pane.stop(id);
                }
                res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
            }catch(e){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end((e as Error).message);}return;
        }
        if(req.url==='/actions/prepare'||req.url==='/actions/execute'){
            if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end('Use POST.');return;}
            try{
                if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new Error('Expected form data.');
                let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>8192)throw new Error('Request too large.');}
                const fields=new URLSearchParams(body);
                if(fields.getAll('token').length!==1||fields.get('token')!==actions.token){res.writeHead(403);res.end('Invalid session token.');return;}
                if(actions.busy||terminal.busy){res.writeHead(409);res.end('An action or terminal session is already running. Stop it before starting another action.');return;}
                if(req.url==='/actions/prepare'){
                    const plan=await planAction(hub,fields);const id=actions.prepare(plan);
                    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(confirmationHtml(actions.token,id,plan));
                }else{
                    if([...fields.keys()].some(k=>!['token','confirmation'].includes(k))||fields.getAll('confirmation').length!==1)throw new Error('Invalid confirmation.');
                    actions.execute(fields.get('confirmation')||'');res.writeHead(303,{Location:'/#dashboard-actions'});res.end();
                }
            }catch(e){res.writeHead(400,{'Content-Type':'text/html; charset=utf-8'});res.end(`<p>${escapeHtml((e as Error).message)}</p><a href="/">Back</a>`);}
            return;
        }
        if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'});res.end('Read-only dashboard.');return;}
        try {
            const url=new URL(req.url||'/','http://'+host);
            if(url.search){res.writeHead(404);res.end('Not found.');return;}
            if(url.pathname.startsWith('/terminal-assets/')){
                const assets:Record<string,()=>string>={'/terminal-assets/xterm.js':()=>require.resolve('@xterm/xterm'),'/terminal-assets/fit.js':()=>require.resolve('@xterm/addon-fit'),'/terminal-assets/xterm.css':()=>path.join(path.dirname(require.resolve('@xterm/xterm')),'../css/xterm.css')};
                if(url.pathname!=='/terminal-assets/client.js'&&!Object.hasOwn(assets,url.pathname)){res.writeHead(404);res.end();return;}
                res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'application/javascript');res.end(req.method==='HEAD'?undefined:url.pathname==='/terminal-assets/client.js'?terminalClient:await fs.readFile(assets[url.pathname]()));
            }else if(url.pathname==='/api/state'){
                // Read-only summary for the desktop shell's sidebar and notifications. Same local-only, GET-only protections as the page.
                const [s,work]=await Promise.all([hub.state(),readWork(hub).catch(()=>({sessions:[]}))]);const last=work.sessions.at(-1)||null;
                const panes=['left','right'].map(id=>{try{const r=terminal.forPane(id).record;return r?{pane:id,sessionId:r.sessionId,agent:r.agent,taskId:r.taskId,startedAt:r.startedAt,endedAt:r.endedAt,exitCode:r.exitCode}:{pane:id};}catch{return {pane:id};}});
                res.setHeader('Content-Type','application/json');
                res.end(req.method==='HEAD'?undefined:JSON.stringify({projectName:s.config.projectName,root:hub.root,branch:s.git.branch,changedFiles:s.git.changes.length,work:{last,next:last?otherAgent(last.agent):'claude'},panes,action:actions.latest?{status:actions.latest.status,command:actions.latest.command}:null}));
            }else if(url.pathname==='/'){
                const state=await dashboardState(hub);artifacts=state.artifacts;
                res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.method==='HEAD'?undefined:dashboardHtml(state,nonce,actions.token,actions.latest));
            }else if(/^\/artifact\/[a-f0-9]{64}$/.test(url.pathname)){
                const relative=artifacts.get(url.pathname.slice(10));
                if(!relative)throw new Error('Unknown artifact');
                if((await fs.lstat(hub.p())).isSymbolicLink())throw new Error('Unsafe state root');
                const full=await safeDashboardPath(hub.p(),relative);
                const stat=await fs.stat(full);if(!stat.isFile()||stat.size>2*1024*1024){res.writeHead(413);res.end('Artifact too large; open it locally.');return;}
                res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(req.method==='HEAD'?undefined:await fs.readFile(full));
            }else{res.writeHead(404);res.end('Not found.');}
        }catch {res.writeHead(req.url==='/'?500:404,{'Content-Type':'text/plain; charset=utf-8'});res.end(req.url==='/'?'Unable to read project state. Run agenthub doctor.':'Artifact unavailable.');}
    });
    server.requestTimeout=10000;server.headersTimeout=10000;
    for(let attempt=0;;attempt++){
        try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});break;}
        catch(e){if((e as NodeJS.ErrnoException).code!=='EADDRINUSE'||port===0||port===65535||attempt>=99)throw e;port++;}
    }
    const address=server.address();if(!address||typeof address==='string')throw new Error('Unexpected server address.');
    host=`127.0.0.1:${address.port}`;
    return {server,url:`http://${host}`,close:async()=>{await terminal.stop();for(const stream of streams)stream.end();await actions.wait();return new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();});}};
}
