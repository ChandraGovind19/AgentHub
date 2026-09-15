const list=document.getElementById('list');
const elapsed=iso=>{const s=Math.max(0,Math.floor((Date.now()-Date.parse(iso))/1000));return s<3600?String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'):Math.floor(s/3600)+'h '+String(Math.floor(s%3600/60)).padStart(2,'0')+'m';};
const label=a=>a==='claude'?'Claude Code':a==='codex'?'Codex':a;
let current=[];
function render(projects){current=projects;list.replaceChildren();if(!projects.length){list.innerHTML='<div class="empty">No projects yet. Add a folder to start a session.</div>';return;}
projects.forEach((p,i)=>{const b=document.createElement('button');b.className='project'+(p.active?' active':'');b.title=p.root;
const running=(p.state?.panes||[]).filter(x=>x.sessionId&&!x.endedAt);const name=document.createElement('div');name.className='name';
name.innerHTML='<span></span><small>⌘'+(i+1)+' <button class="remove" title="Close project">×</button></small>';name.firstChild.textContent=p.name;
const meta=document.createElement('div');meta.className='meta';
if(p.error)meta.innerHTML='<span class="badge error"><i></i>'+esc(p.error)+'</span>';
else if(!p.state)meta.innerHTML='<span class="badge starting"><i></i>starting</span>';
else{meta.innerHTML=running.map(r=>'<span class="badge running"><i></i>'+esc(label(r.agent))+' '+elapsed(r.startedAt)+'</span>').join('')+(running.length?'':'<span class="badge next"><i></i>next: '+esc(label(p.state.work.next))+'</span>')+(p.state.action?.status==='running'?'<span class="badge starting"><i></i>action</span>':'')+'<span>'+esc(p.state.branch||'')+(p.state.changedFiles?' · '+p.state.changedFiles+' changed':'')+'</span>';}
b.append(name,meta);b.addEventListener('click',e=>{if(e.target.classList.contains('remove')){agenthub.remove(p.root);return;}agenthub.select(p.root);});list.append(b);});}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
document.getElementById('add').addEventListener('click',()=>agenthub.add());
agenthub.onProjects(render);agenthub.list().then(render);setInterval(()=>render(current),1000);
