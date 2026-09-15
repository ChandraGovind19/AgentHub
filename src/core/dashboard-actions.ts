import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {promises as fs, createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import type {Hub} from './hub.js';
export const escapeHtml=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export type ActionPlan={args:string[];command:string;costly:boolean};
export async function planAction(hub:Hub, fields:URLSearchParams):Promise<ActionPlan>{
    const action=fields.get('kind')||'';
    if(!['sync','resume','review','run','continue','switch','complete'].includes(action))throw new Error('Unknown action.');
    for(const key of fields.keys())if(!['kind','task','agent','from','to','token'].includes(key)||fields.getAll(key).length!==1)throw new Error('Unexpected action parameter.');
    const config=await hub.config();
    const agent=(key:string)=>{const v=fields.get(key)||'';if(!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(v)||!config.agents.includes(v))throw new Error('Unknown agent.');return v;};
    let task='';if(['run','continue','switch','complete'].includes(action)){task=fields.get('task')||'';if(!/^task_[a-zA-Z0-9_-]+$/.test(task)||!(await hub.tasks()).some(t=>t.id===task))throw new Error('Unknown task.');}
    let args:string[];
    switch(action){
        case 'sync':case 'resume':args=[action];break;
        case 'review':args=[action,agent('agent'),'--save'];break;
        case 'complete':args=[action,task,'--unlock'];break;
        case 'switch':{const from=agent('from'),to=agent('to');if(from===to)throw new Error('Choose different agents.');args=[action,task,'--from',from,'--to',to,'--apply','--continue','--review'];break;}
        default:args=[action,task,'--agent',agent('agent'),'--worktree',action==='run'?'auto':'existing','--review'];
    }
    return {args,command:['agenthub',...args].join(' '),costly:['run','continue','switch'].includes(action)};
}
export function dashboardActions(hub:Hub){
    const token=randomBytes(32).toString('hex');
    const pending=new Map<string,{plan:ActionPlan;expires:number}>();
    let busy=false;
    let latest:{id:string;command:string;status:string;output:string;folder:string;startedAt:string;endedAt?:string;exitCode?:number|null}|undefined;
    let active:Promise<void>=Promise.resolve();
    function prepare(plan:ActionPlan){for(const [id,p] of pending)if(p.expires<Date.now())pending.delete(id);if(pending.size>=100)pending.clear();const id=randomBytes(24).toString('hex');pending.set(id,{plan,expires:Date.now()+5*60*1000});return id;}
    function execute(id:string){
        if(busy)throw new Error('An action is already running. Refresh to see its status.');
        const p=pending.get(id);pending.delete(id);if(!p||p.expires<Date.now())throw new Error('Confirmation expired or already used. Preview the action again.');
        busy=true;
        const actionId=`action_${Date.now()}_${randomBytes(6).toString('hex')}`;
        const folder=hub.p('dashboard-actions',actionId);
        const record={id:actionId,command:p.plan.command,status:'running',output:'',folder,startedAt:new Date().toISOString()} as NonNullable<typeof latest>;
        latest=record;
        let created=false;
        active=(async()=>{
            try{
                if((await fs.lstat(hub.p())).isSymbolicLink())throw new Error('Symlinked project state refused.');
                await fs.mkdir(hub.p('dashboard-actions'),{recursive:true});
                if((await fs.lstat(hub.p('dashboard-actions'))).isSymbolicLink())throw new Error('Symlinked action log directory refused.');
                await fs.mkdir(folder);created=true;
                await fs.writeFile(`${folder}/metadata.json`,JSON.stringify(record,null,2));
                const stdout=createWriteStream(`${folder}/stdout.log`),stderr=createWriteStream(`${folder}/stderr.log`);
                // Fixed executable and validated argument array reuse the existing CLI and its safety checks.
                const child=spawn(process.execPath,[fileURLToPath(new URL('../index.js',import.meta.url)),...p.plan.args],{cwd:hub.root,stdio:['ignore','pipe','pipe'],shell:false});
                const capture=(chunk:Buffer)=>{record.output=(record.output+chunk.toString()).slice(-65536);};
                child.stdout.on('data',capture);child.stderr.on('data',capture);
                child.stdout.pipe(stdout);child.stderr.pipe(stderr);
                const drains=Promise.all([finished(stdout),finished(stderr)]);
                // Consume stream failures immediately, even while the child is running.
                void drains.catch(()=>{});
                record.exitCode=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
                await drains;record.status=record.exitCode===0?'success':'failure';
            }catch(e){record.status='failure';record.output+=`\n${(e as Error).message}`;}
            finally{
                record.endedAt=new Date().toISOString();
                try{if(created)await fs.writeFile(`${folder}/metadata.json`,JSON.stringify(record,null,2));}catch(e){record.output+=`\nCould not save diagnostics: ${(e as Error).message}`;}
                busy=false;
            }
        })();
    }
    return {token,prepare,execute,get busy(){return busy;},get latest(){return latest;},wait:()=>active};
}
export function confirmationHtml(token:string,id:string,plan:ActionPlan){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Confirm AgentHub action</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e8ecf4;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif}main{width:min(560px,92vw);padding:26px 28px;border:1px solid #222a3a;border-radius:14px;background:#131824}h1{margin:0 0 6px;font-size:20px;letter-spacing:-.02em}p{color:#94a0b8;margin:8px 0}pre{margin:14px 0;padding:12px 14px;border-radius:10px;background:#0f131b;border:1px solid #222a3a;color:#dde3ee;font:13px ui-monospace,Menlo,monospace;white-space:pre-wrap}.row{display:flex;gap:10px;align-items:center;margin-top:18px}button{border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:650;color:#0b0e14;background:${plan.costly?'#f5a54a':'#3dd6c4'};cursor:pointer}a{color:#94a0b8}</style></head><body><main><h1>${plan.costly?'Start an agent?':'Run this command?'}</h1><p>Local-only. Review the exact command before it runs.</p><pre>${escapeHtml(plan.command)}</pre><p>${plan.costly?'This starts an AI agent using your native configuration and subscription. It can modify files.':'This reads or updates project state. Complete + Unlock marks the task done and releases its locks.'}</p><form class="row" method="post" action="/actions/execute"><input type="hidden" name="token" value="${token}"><input type="hidden" name="confirmation" value="${id}"><button type="submit">${plan.costly?'Start agent':'Run'}</button><a href="/">Cancel</a></form></main></body></html>`;}
