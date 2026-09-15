import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Hub } from './hub.js';
import { agents } from './agent-config.js';
import { readWork, readJournal, otherAgent } from './work.js';
export interface DashboardRecord { name:string; data:Record<string,unknown>; time:string; links:{label:string;id:string}[] }
export async function safeDashboardPath(root:string, relative:string) {
    const base=await fs.realpath(root);
    const resolved=await fs.realpath(path.join(root,relative));
    const rel=path.relative(base,resolved);
    if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Artifact outside project state.');
    return resolved;
}
export async function dashboardState(hub:Hub) {
    if ((await fs.lstat(hub.p())).isSymbolicLink()) throw new Error('Dashboard does not serve symlinked project state.');
    const artifacts=new Map<string,string>();const warnings:string[]=[];
    async function link(relative:string,label:string) {
        try {const full=await safeDashboardPath(hub.p(),relative);if (!(await fs.stat(full)).isFile())return null;const id=createHash('sha256').update(relative).digest('hex');artifacts.set(id,relative);return {label,id};} catch{return null;}
    }
    async function records(kind:'sessions'|'switches'|'reviews'):Promise<DashboardRecord[]> {
        let directory:string;
        try {directory=await safeDashboardPath(hub.p(),kind);}catch{return [];}
        const entries=await fs.readdir(directory,{withFileTypes:true});
        const candidates=await Promise.all(entries.filter(e=>!e.isSymbolicLink()&&(e.isDirectory()||e.name.endsWith(kind==='reviews'?'.md':'.json'))).map(async e=>({e,time:(await fs.stat(path.join(directory,e.name))).mtimeMs})));
        candidates.sort((a,b)=>b.time-a.time);
        const results:DashboardRecord[]=[];
        for(const {e,time} of candidates.slice(0,25)) {
            const relative=path.join(kind,e.name);
            const meta=e.isDirectory()?path.join(relative,'metadata.json'):relative;
            try {
                const file=await safeDashboardPath(hub.p(),meta);
                if ((await fs.stat(file)).size>1024*1024)throw new Error('Record too large');
                let data:Record<string,unknown>;
                if(kind==='reviews') {
                    const text=await fs.readFile(file,'utf8');
                    data={agent:text.match(/^# AgentHub Review: (.+)$/m)?.[1]||'unknown',taskId:'not recorded',path:hub.p(relative)};
                } else {const parsed=JSON.parse(await fs.readFile(file,'utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid metadata');data=parsed;}
                const choices=e.isDirectory()?['metadata.json',...(kind==='sessions'?['prompt.md','result.md']:['continuation-prompt.md','transfer.patch','apply-stderr.log'])]:[e.name];
                const links=(await Promise.all(choices.map(label=>link(e.isDirectory()?path.join(relative,label):relative,label)))).filter((l):l is {label:string;id:string}=>!!l);
                results.push({name:e.name,data,time:new Date(time).toISOString(),links});
            } catch {warnings.push(`Could not read ${kind}/${e.name}.`);}
        }
        return results;
    }
    const [state,available,trees,sessions,switches,reviews,questions]=await Promise.all([
        hub.state(),agents(hub).catch(e=>{warnings.push(`Agents: ${e.message}`);return [];}),hub.worktreeStatus().catch(e=>{warnings.push(`Worktrees: ${e.message}`);return [];}),
        records('sessions'),records('switches'),records('reviews'),fs.readFile(hub.p('memory/open-questions.md'),'utf8').catch(()=> '')
    ]);
    const workState=await readWork(hub).catch(e=>{warnings.push(`Work: ${e.message}`);return {sessions:[]};});
    const last=workState.sessions.at(-1);
    const work={last,next:last?otherAgent(last.agent):'claude',journalTail:(await readJournal(hub).catch(()=> '')).slice(-2500)};
    return {...state,work,available,trees,sessions,switches,reviews,artifacts,warnings,openQuestions:(questions.match(/^\s*- \[ \]/gm)||[]).length};
}
export type DashboardState=Awaited<ReturnType<typeof dashboardState>>;
