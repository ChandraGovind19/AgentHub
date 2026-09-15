import {promises as fs} from 'node:fs';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Hub} from './hub.js';
import {prepareAttach} from './attach.js';
import {json,now,write,stamp} from './storage.js';
import {createWriteStream} from 'node:fs';
import {beginWork,endWork,workPrompt} from './work.js';
// Keep the native dependency optional and lazy: a missing PTY must not break other dashboard features.
interface Pty {write(data:string):void;resize(cols:number,rows:number):void;kill(signal?:string):void;onData(cb:(data:string)=>void):unknown;onExit(cb:(event:{exitCode:number;signal?:number})=>void):unknown}
type PtyModule={spawn(command:string,args:string[],options:Record<string,unknown>):Pty};
export interface TerminalRecord {sessionId:string;paneId:string;agent:string;mode:string;taskId:string|null;workdir:string;command:string;args:string[];cols:number;rows:number;startedAt:string;endedAt:string|null;exitCode:number|null;signal?:number;handoffPath:string|null;promptPath:string|null;promptMode:string;workId:string|null;error?:string;folder:string}
export const readyInstruction=(promptPath:string)=>`Read ${promptPath} and continue from where the previous session left off.`;
function dimensions(fields:URLSearchParams){
    const cols=fields.has('cols')?Number(fields.get('cols')):80;
    const rows=fields.has('rows')?Number(fields.get('rows')):24;
    if(!Number.isInteger(cols)||cols<2||cols>500||!Number.isInteger(rows)||rows<2||rows>200)throw new Error('Invalid terminal dimensions.');
    return {cols,rows};
}
function terminalPane(hub:Hub,paneId:string){
    let busy=false, closing=false;let pty:Pty|undefined;let record:TerminalRecord|undefined;
    let backlog='';const events=new EventEmitter();let completion=Promise.resolve();let resolveCompletion=()=>{};let prepared=Promise.resolve();let resolvePrepared=()=>{};
    const emit=(data:unknown)=>events.emit('event',data);
    async function finish(exitCode:number|null,signal?:number,error?:string){
        if(!record||record.endedAt)return;
        record.endedAt=now();record.exitCode=exitCode;if(signal)record.signal=signal;if(error)record.error=error;
        pty=undefined;
        if(record.workId)try{await endWork(hub,record.workId);}catch(e){record.error=`Work bookkeeping failed: ${(e as Error).message}`;}
        try{await json(`${record.folder}/metadata.json`,record);}catch(e){record.error=`Unable to save final metadata: ${(e as Error).message}`;}
        busy=false;emit({type:'status',record});resolveCompletion();
    }
    async function launch(fields:URLSearchParams){
        if(busy||closing)throw new Error('A terminal session is already running or stopping.');
        const allowed=['token','pane','agent','task','worktree','confirmed','cols','rows','prompt'];
        for(const k of fields.keys())if(!allowed.includes(k)||fields.getAll(k).length!==1)throw new Error('Unexpected terminal parameter.');
        const agent=fields.get('agent')||'';if(!['codex','claude'].includes(agent))throw new Error('Choose codex or claude.');
        const worktree=fields.get('worktree')||'existing';if(!['existing','auto','none'].includes(worktree))throw new Error('Invalid worktree mode.');
        const task=fields.get('task')||undefined;if(task&&!/^task_[a-zA-Z0-9_-]+$/.test(task))throw new Error('Invalid task.');
        if(fields.get('confirmed')!=='yes')throw new Error('Explicit launch confirmation is required.');
        const promptMode=fields.get('prompt')||'none';if(!['ready','auto','none'].includes(promptMode))throw new Error('Prompt mode must be ready, auto or none.');
        const size=dimensions(fields);
        // Recheck after validation awaits; reserve before importing or preparing the worktree.
        if(busy||closing)throw new Error('A terminal session is already running or stopping.');
        busy=true;backlog='';record=undefined;
        prepared=new Promise<void>(r=>{resolvePrepared=r;});
        completion=new Promise<void>(r=>{resolveCompletion=r;});
        try{
            if(!(await hub.config()).agents.includes(agent))throw new Error('Agent is not configured.');
            let native:PtyModule;
            try {const moduleName='node-pty';native=await import(moduleName);}catch{throw new Error('PTY unavailable. Install/rebuild optional node-pty for your Node version. Dashboard actions and terminal attach remain available.');}
            if((await fs.lstat(hub.p())).isSymbolicLink())throw new Error('Symlinked project state refused.');
            await fs.mkdir(hub.p('sessions'),{recursive:true});if((await fs.lstat(hub.p('sessions'))).isSymbolicLink())throw new Error('Symlinked sessions directory refused.');
            const plan=await prepareAttach(hub,agent,{task,worktree});
            let promptPath:string|null=null,workId:string|null=null;
            if(promptMode!=='none'){const prompt=await workPrompt(hub,agent,task,plan.workdir);promptPath=hub.p('handoffs',`${stamp()}-${agent}-work.md`);await write(promptPath,prompt);if(promptMode==='auto')plan.args.push(prompt);workId=(await beginWork(hub,agent,task,plan.workdir,'dashboard-terminal')).id;}
            const sessionId=`session_${Date.now()}_${agent}_${task||'none'}_${randomUUID().slice(0,8)}`;
            record={sessionId,paneId,agent,mode:'dashboard-terminal',taskId:task||null,workdir:plan.workdir,command:plan.command,args:plan.args,cols:size.cols,rows:size.rows,startedAt:now(),endedAt:null,exitCode:null,handoffPath:plan.handoffPath,promptPath,promptMode,workId,folder:hub.p('sessions',sessionId)};
            await json(`${record.folder}/metadata.json`,record);
            const environment={...process.env};delete environment.NO_COLOR;
            pty=native.spawn(plan.command,plan.args,{name:'xterm-256color',cols:size.cols,rows:size.rows,cwd:plan.workdir,env:{...environment,TERM:'xterm-256color',COLORTERM:'truecolor',FORCE_COLOR:'1',TERM_PROGRAM:'AgentHub'}});
            // Raw output is kept per session so the next agent can be told what happened even if this one ran out mid-task.
            const transcript=createWriteStream(`${record.folder}/transcript.log`,{flags:'a',mode:0o600});let transcriptBytes=0;
            pty.onData(data=>{backlog=(backlog+data).slice(-131072);if(transcriptBytes<4*1024*1024){transcriptBytes+=Buffer.byteLength(data);transcript.write(data);}emit({type:'output',data});});
            pty.onExit(()=>transcript.end());
            pty.onExit(e=>{void finish(e.exitCode,e.signal);});
            // "ready": once the native UI has drawn and gone quiet, type one line into its input box without pressing Enter. The user decides when to start.
            if(promptMode==='ready'&&promptPath){const child=pty;let timer:NodeJS.Timeout|undefined,sent=false;const line=readyInstruction(promptPath);
                child.onData(()=>{if(sent)return;clearTimeout(timer);timer=setTimeout(()=>{if(!sent&&pty===child){sent=true;try{child.write(line);}catch{/* Process exited. */}}},1500);});}
            emit({type:'status',record});return record;
        }catch(e){if(record)await finish(1,undefined,(e as Error).message);else{busy=false;resolveCompletion();}throw e;}finally{resolvePrepared();}
    }
    function current(id:string){if(!pty||!record||record.sessionId!==id||record.endedAt)throw new Error('Terminal session is no longer active.');return pty;}
    async function stop(id?:string){
        if(id&&id!==record?.sessionId)throw new Error('Terminal session changed. Refresh first.');
        closing=true;
        try{
            if(busy&&!pty)await prepared;
            const process=pty;if(!process)return;
            process.kill('SIGTERM');
            const timer=setTimeout(()=>{if(pty===process){try{process.kill('SIGKILL');}catch{/* Process may already have exited. */}}},1500);
            try{await completion;}finally{clearTimeout(timer);}
        }finally{closing=false;}
    }
    return {launch,stop,get busy(){return busy||closing;},get record(){return record;},input:(id:string,data:string)=>current(id).write(data),resize:(id:string,cols:number,rows:number)=>{const size=dimensions(new URLSearchParams({cols:String(cols),rows:String(rows)}));current(id).resize(size.cols,size.rows);if(record){record.cols=size.cols;record.rows=size.rows;}},subscribe:(cb:(event:unknown)=>void)=>{events.on('event',cb);cb({type:'status',record:record||null});if(backlog)cb({type:'output',data:backlog});return ()=>{events.off('event',cb);};}};
}

export function dashboardTerminal(hub:Hub){
    const terminalSessions=new Map(['left','right'].map(id=>[id,terminalPane(hub,id)]));
    let closing=false;
    return {
        forPane(id='left'){
            const pane=terminalSessions.get(id);
            if(!pane)throw new Error('Invalid terminal pane. Only left and right are supported (maximum two sessions).');
            if(closing)throw new Error('Dashboard is stopping.');
            return pane;
        },
        get busy(){return closing||[...terminalSessions.values()].some(pane=>pane.busy);},
        async stop(){closing=true;await Promise.all([...terminalSessions.values()].map(pane=>pane.stop()));}
    };
}
