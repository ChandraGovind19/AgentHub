const list=document.getElementById('list'),count=document.getElementById('count');
const AGENT={claude:'Claude Code',codex:'Codex'};
const elapsed=iso=>{const s=Math.max(0,Math.floor((Date.now()-Date.parse(iso))/1000));return s<3600?String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'):Math.floor(s/3600)+'h'+String(Math.floor(s%3600/60)).padStart(2,'0');};
let current=[];
function row(p,i){
 const b=document.createElement('button');b.className='project'+(p.active?' active':'');b.title=p.root;b.type='button';
 const running=(p.state?.panes||[]).filter(x=>x.sessionId&&!x.endedAt);const agent=running[0]?.agent;if(agent)b.classList.add('agent-'+agent);
 const name=document.createElement('div');name.className='name';const n=document.createElement('b');n.textContent=p.name;name.append(n);if(i<9){const k=document.createElement('kbd');k.textContent='⌘'+(i+1);name.append(k);}
 const line=document.createElement('div');line.className='line';const dot=document.createElement('span');dot.className='dot';const text=document.createElement('span');
 if(p.error){line.classList.add('bad');dot.classList.add('bad');text.textContent=p.error;}
 else if(!p.state){text.textContent='starting…';}
 else if(running.length){line.classList.add(agent);dot.classList.add(agent,'live');text.textContent=running.map(r=>AGENT[r.agent]+' '+elapsed(r.startedAt)).join(' · ');}
 else{const next=p.state.work.next;dot.classList.add(next);text.textContent='next: '+AGENT[next]+(p.state.branch&&p.state.branch!=='(no repository)'?' · '+p.state.branch:'')+(p.state.changedFiles?' · '+p.state.changedFiles+' changed':'');}
 line.append(dot,text);
 const close=document.createElement('button');close.className='close';close.type='button';close.title='Close project';close.setAttribute('aria-label','Close '+p.name);close.textContent='×';
 b.append(name,line,close);
 b.addEventListener('click',e=>{if(e.target===close){agenthub.remove(p.root);return;}agenthub.select(p.root);});
 b.addEventListener('contextmenu',e=>{e.preventDefault();agenthub.menu(p.root);});
 return b;
}
function render(projects){current=projects;count.textContent=projects.length?String(projects.length):'';list.replaceChildren();
 if(!projects.length){const e=document.createElement('div');e.className='empty';e.innerHTML='<b>No projects open</b>Open a folder to start a Claude Code or Codex session in it. AgentHub keeps its notes in a small .agenthub folder inside the project.';list.append(e);return;}
 projects.forEach((p,i)=>list.append(row(p,i)));}
document.getElementById('add').addEventListener('click',()=>agenthub.add());
agenthub.onProjects(render);agenthub.list().then(render);agenthub.version().then(v=>{document.getElementById('version').textContent='v'+v;});
setInterval(()=>{if(current.some(p=>(p.state?.panes||[]).some(x=>x.sessionId&&!x.endedAt)))render(current);},1000);
