const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('agenthub',{
  list:()=>ipcRenderer.invoke('projects:list'),
  add:()=>ipcRenderer.invoke('projects:add'),
  select:(root)=>ipcRenderer.invoke('projects:select',root),
  remove:(root)=>ipcRenderer.invoke('projects:remove',root),
  restart:(root)=>ipcRenderer.invoke('projects:restart',root),
  onProjects:(cb)=>{ipcRenderer.on('projects',(_e,projects)=>cb(projects));}
});
