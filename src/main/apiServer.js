// apiServer.js - HTTP API Server + Web Dashboard for Kyrion Kronou
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

class ApiServer {
  constructor(taskManager, config, logger, serviceManager, wrapperGenerator) {
    this.taskManager = taskManager;
    this.config = config;
    this.logger = logger;
    this.serviceManager = serviceManager;
    this.wrapperGenerator = wrapperGenerator;
    this.app = express();
    this.server = null;
    this.port = config.getSetting('ApiPort', 7600);
    this.apiKey = config.getSetting('ApiKey', '');
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // API key auth (optional)
    this.app.use('/api', (req, res, next) => {
      if (this.apiKey && req.headers['x-api-key'] !== this.apiKey) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Provide X-API-Key header' });
      }
      next();
    });

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        this.logger.log('API', `${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
      });
      next();
    });
  }

  setupRoutes() {
    // ─── Health ───
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        version: require('../../package.json').version,
        uptime: process.uptime(),
        tasks: this.taskManager.getAllTasks().length,
        timestamp: new Date().toISOString()
      });
    });

    // ─── Tasks CRUD ───
    this.app.get('/api/tasks', (req, res) => {
      let tasks = this.taskManager.getAllTasks();
      // Filter by query params
      if (req.query.enabled !== undefined) {
        const enabled = req.query.enabled === 'true';
        tasks = tasks.filter(t => t.Enabled === enabled);
      }
      if (req.query.search) {
        const q = req.query.search.toLowerCase();
        tasks = tasks.filter(t =>
          (t.Name || '').toLowerCase().includes(q) ||
          (t.CronExpression || '').toLowerCase().includes(q) ||
          (t.ScriptPath || '').toLowerCase().includes(q)
        );
      }
      res.json({ success: true, data: tasks, count: tasks.length });
    });

    this.app.get('/api/tasks/:id', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ success: true, data: task });
    });

    this.app.post('/api/tasks', (req, res) => {
      const { Name, CronExpression, ScriptPath, Arguments, WorkingDirectory, Description, Enabled } = req.body;
      if (!Name || !CronExpression || !ScriptPath) {
        return res.status(400).json({ error: 'Missing required fields: Name, CronExpression, ScriptPath' });
      }
      // Validate cron
      const validation = this.config._cronParser ? this.config._cronParser.validate(CronExpression) : { valid: true };
      // Try to use the cronParser from taskManager
      const result = this.taskManager.addTask({
        Name, CronExpression, ScriptPath,
        Arguments: Arguments || '',
        WorkingDirectory: WorkingDirectory || '',
        Description: Description || '',
        Enabled: Enabled !== false
      });
      if (result.success === false) {
        return res.status(400).json({ error: result.message || 'Failed to create task' });
      }
      this.logger.audit('TASK_CREATED_API', { targetType: 'task', target: result.Id, before: null, after: { Name, CronExpression } });
      res.status(201).json({ success: true, data: result });
    });

    this.app.put('/api/tasks/:id', (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const data = { ...existing, ...req.body, Id: req.params.id };
      const result = this.taskManager.updateTask(data);
      if (result.success === false) {
        return res.status(400).json({ error: result.message || 'Failed to update task' });
      }
      this.logger.audit('TASK_UPDATED_API', { targetType: 'task', target: req.params.id, before: { Name: existing.Name }, after: { Name: data.Name } });
      res.json({ success: true, data: result });
    });

    this.app.delete('/api/tasks/:id', (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const result = this.taskManager.deleteTask(req.params.id);
      this.logger.audit('TASK_DELETED_API', { targetType: 'task', target: req.params.id, before: { Name: existing.Name }, after: null });
      res.json({ success: true, message: `Task "${existing.Name}" deleted` });
    });

    // ─── Execute Task ───
    this.app.post('/api/tasks/:id/run', async (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      try {
        const result = await this.taskManager.executeTask(task);
        this.logger.audit('TASK_EXECUTED_API', { targetType: 'task', target: req.params.id, after: result });
        res.json({ success: true, data: result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ─── History ───
    this.app.get('/api/history', (req, res) => {
      let history = this.taskManager.history || [];
      if (req.query.taskId) {
        history = history.filter(h => h.TaskId === req.query.taskId);
      }
      if (req.query.limit) {
        history = history.slice(-parseInt(req.query.limit));
      }
      res.json({ success: true, data: history, count: history.length });
    });

    // ─── Script Attach/Detach ───
    this.app.post('/api/tasks/:id/attach', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const { ScriptPath, Arguments, WorkingDirectory } = req.body;
      if (!ScriptPath) return res.status(400).json({ error: 'ScriptPath is required' });
      const update = {
        ...task,
        ScriptPath,
        Arguments: Arguments || task.Arguments,
        WorkingDirectory: WorkingDirectory || task.WorkingDirectory
      };
      const result = this.taskManager.updateTask(update);
      this.logger.audit('SCRIPT_ATTACHED_API', { targetType: 'task', target: task.Id, before: { ScriptPath: task.ScriptPath }, after: { ScriptPath } });
      res.json({ success: true, data: result, message: `Script attached: ${ScriptPath}` });
    });

    this.app.delete('/api/tasks/:id/attach', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const update = { ...task, ScriptPath: '', Arguments: '', WorkingDirectory: '' };
      const result = this.taskManager.updateTask(update);
      this.logger.audit('SCRIPT_DETACHED_API', { targetType: 'task', target: task.Id, before: { ScriptPath: task.ScriptPath }, after: { ScriptPath: '' } });
      res.json({ success: true, message: `Script detached from "${task.Name}"` });
    });

    this.app.get('/api/tasks/:id/script', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({
        success: true,
        data: {
          taskId: task.Id,
          taskName: task.Name,
          scriptPath: task.ScriptPath,
          arguments: task.Arguments,
          workingDirectory: task.WorkingDirectory,
          exists: task.ScriptPath ? fs.existsSync(task.ScriptPath) : false
        }
      });
    });

    // ─── Services ───
    this.app.get('/api/services', (req, res) => {
      const services = this.serviceManager.getAllServices();
      res.json({ success: true, data: services, count: services.length });
    });

    // ─── Config ───
    this.app.get('/api/config', (req, res) => {
      res.json({
        success: true,
        data: {
          profiles: this.config.getProfileList(),
          activeProfile: this.config.getSetting('_activeProfile', 'default'),
          settings: {
            notifications: this.config.getSetting('Notifications', true),
            apiPort: this.port
          }
        }
      });
    });

    // ─── Cron Validation ───
    this.app.post('/api/validate-cron', (req, res) => {
      const { expression } = req.body;
      if (!expression) return res.status(400).json({ error: 'expression is required' });
      try {
        const cronParser = this.taskManager.cronParser;
        const result = cronParser.validate(expression);
        const desc = cronParser.getDescription(expression);
        const nextRun = cronParser.getNextRunTime(expression);
        res.json({ success: true, valid: result.valid, description: desc, nextRun: nextRun ? nextRun.toISOString() : null, errors: result.errors || [] });
      } catch (e) {
        res.json({ success: true, valid: false, description: 'Invalid', errors: [e.message] });
      }
    });

    // ─── API Documentation ───
    this.app.get('/docs', (req, res) => {
      res.type('html').send(this.getDocsHTML());
    });

    // ─── Web Dashboard ───
    this.app.get('/', (req, res) => {
      res.type('html').send(this.getDashboardHTML());
    });

    this.app.get('/dashboard', (req, res) => {
      res.type('html').send(this.getDashboardHTML());
    });
  }

  start(port) {
    return new Promise((resolve, reject) => {
      try {
        this.port = port || this.port;
        this.server = this.app.listen(this.port, '0.0.0.0', () => {
          this.logger.log('API', `API Server started on http://localhost:${this.port}`);
          this.logger.log('API', `Web Dashboard: http://localhost:${this.port}/`);
          this.logger.log('API', `API Docs: http://localhost:${this.port}/docs`);
          resolve({ success: true, port: this.port, url: `http://localhost:${this.port}` });
        });
        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.port} is already in use`));
          } else {
            reject(err);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.log('API', 'API Server stopped');
          this.server = null;
          resolve({ success: true });
        });
      } else {
        resolve({ success: true });
      }
    });
  }

  isRunning() {
    return this.server && this.server.listening;
  }

  // ─── Web Dashboard HTML ───
  getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kyrion Kronou Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08080c;--card:#0f0f14;--border:rgba(255,255,255,.06);--text:#c0c0d0;--text2:#808094;--primary:#6a5acd;--green:#6a8a6e;--red:#8a5a5a;--amber:#8a7a5a}
body{font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.container{max-width:1000px;margin:0 auto;padding:24px}
h1{font-size:22px;font-weight:600;margin-bottom:20px;background:linear-gradient(135deg,var(--primary),#8a7acd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
.stat-num{font-size:28px;font-weight:700;margin:4px 0}
.stat-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text2)}
.toolbar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
input,select{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none}
input:focus{border-color:var(--primary)}
button{background:var(--primary);color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .2s}
button:hover{opacity:.85}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-danger{background:var(--red)}
.btn-success{background:var(--green)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
th{text-align:left;padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text2);background:rgba(255,255,255,.02);border-bottom:1px solid var(--border)}
td{padding:10px 16px;border-bottom:1px solid var(--border);font-size:13px}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.badge-green{background:rgba(106,138,110,.15);color:var(--green)}
.badge-red{background:rgba(138,90,90,.15);color:var(--red)}
.badge-gray{background:rgba(255,255,255,.05);color:var(--text2)}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;justify-content:center;align-items:center}
.modal-overlay.active{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;width:90%;max-width:500px}
.modal h2{font-size:16px;margin-bottom:16px}
.form-group{margin-bottom:12px}
.form-group label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text2);margin-bottom:4px}
.form-group input,.form-group select{width:100%}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
pre{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;color:var(--text);margin:12px 0}
code{background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:12px}
.toast{position:fixed;bottom:20px;right:20px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 20px;font-size:13px;z-index:200;animation:slideIn .3s}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
</style>
</head>
<body>
<div class="container">
  <h1>⚙ Kyrion Kronou Dashboard</h1>
  <div class="stats">
    <div class="stat"><div class="stat-label">Total Tasks</div><div class="stat-num" id="stat-total">-</div></div>
    <div class="stat"><div class="stat-label">Active</div><div class="stat-num" id="stat-active" style="color:var(--green)">-</div></div>
    <div class="stat"><div class="stat-label">Disabled</div><div class="stat-num" id="stat-disabled" style="color:var(--red)">-</div></div>
    <div class="stat"><div class="stat-label">Services</div><div class="stat-num" id="stat-services" style="color:var(--amber)">-</div></div>
  </div>
  <div class="toolbar">
    <button onclick="showCreateModal()">+ New Task</button>
    <button class="btn-outline" onclick="loadTasks()">↻ Refresh</button>
    <input type="text" id="search" placeholder="Search tasks..." oninput="filterTasks()" style="flex:1">
    <a href="/docs" class="btn-outline" style="padding:8px 16px;text-decoration:none;display:inline-flex;align-items:center;border-radius:8px">API Docs</a>
  </div>
  <table>
    <thead><tr><th>Name</th><th>Cron</th><th>Script</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody id="tasks-body"></tbody>
  </table>
</div>
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2 id="modal-title">New Task</h2>
    <div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="My Task"></div>
    <div class="form-group"><label>Cron Expression *</label><input type="text" id="f-cron" placeholder="0 5 * * *" oninput="validateCronLive()"><small id="f-cron-desc" style="color:var(--text2);font-size:11px"></small></div>
    <div class="form-group"><label>Script Path *</label><input type="text" id="f-script" placeholder="C:\\Scripts\\task.ps1"></div>
    <div class="form-group"><label>Arguments</label><input type="text" id="f-args" placeholder="-Param1 value"></div>
    <div class="form-group"><label>Working Directory</label><input type="text" id="f-workdir" placeholder="C:\\Scripts"></div>
    <div class="form-group"><label>Description</label><input type="text" id="f-desc" placeholder="Optional description"></div>
    <div class="modal-actions">
      <button class="btn-outline" onclick="hideModal()">Cancel</button>
      <button id="btn-save" onclick="saveTask()">Save</button>
    </div>
  </div>
</div>
<script>
let tasks=[],editingId=null;
const API=window.location.origin+'/api';
async function loadTasks(){
  try{
    const r=await fetch(API+'/tasks');const d=await r.json();
    tasks=d.data||[];
    renderTasks();
    document.getElementById('stat-total').textContent=tasks.length;
    document.getElementById('stat-active').textContent=tasks.filter(t=>t.Enabled).length;
    document.getElementById('stat-disabled').textContent=tasks.filter(t=>!t.Enabled).length;
    const sr=await fetch(API+'/services');const sd=await sr.json();
    document.getElementById('stat-services').textContent=sd.count||0;
  }catch(e){toast('Failed to load: '+e.message)}
}
function renderTasks(filter=''){
  const q=(filter||document.getElementById('search').value).toLowerCase();
  let list=tasks;
  if(q)list=list.filter(t=>(t.Name||'').toLowerCase().includes(q)||(t.CronExpression||'').toLowerCase().includes(q)||(t.ScriptPath||'').toLowerCase().includes(q));
  const tbody=document.getElementById('tasks-body');
  if(!list.length){tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:40px">No tasks found</td></tr>';return}
  tbody.innerHTML=list.map(t=>'<tr>'+
    '<td><strong>'+esc(t.Name)+'</strong></td>'+
    '<td><code>'+esc(t.CronExpression)+'</code></td>'+
    '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+esc(t.ScriptPath||'—')+'</td>'+
    '<td><span class="badge '+(t.Enabled?'badge-green':'badge-red')+'">'+(t.Enabled?'Active':'Disabled')+'</span></td>'+
    '<td style="white-space:nowrap">'+
      '<button class="btn-outline" style="padding:4px 8px;font-size:11px" onclick="runTask(\''+t.Id+'\')">▶ Run</button> '+
      '<button class="btn-outline" style="padding:4px 8px;font-size:11px" onclick="editTask(\''+t.Id+'\')">✎ Edit</button> '+
      '<button class="btn-danger" style="padding:4px 8px;font-size:11px" onclick="deleteTask(\''+t.Id+'\\',\\''+esc(t.Name)+'\')">✕</button>'+
    '</td></tr>').join('');
}
function filterTasks(){renderTasks()}
function showCreateModal(){
  editingId=null;
  document.getElementById('modal-title').textContent='New Task';
  ['f-name','f-cron','f-script','f-args','f-workdir','f-desc'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('f-cron-desc').textContent='';
  document.getElementById('modal').classList.add('active');
  document.getElementById('f-name').focus();
}
function editTask(id){
  const t=tasks.find(x=>x.Id===id);if(!t)return;
  editingId=id;
  document.getElementById('modal-title').textContent='Edit Task';
  document.getElementById('f-name').value=t.Name||'';
  document.getElementById('f-cron').value=t.CronExpression||'';
  document.getElementById('f-script').value=t.ScriptPath||'';
  document.getElementById('f-args').value=t.Arguments||'';
  document.getElementById('f-workdir').value=t.WorkingDirectory||'';
  document.getElementById('f-desc').value=t.Description||'';
  validateCronLive();
  document.getElementById('modal').classList.add('active');
}
function hideModal(){document.getElementById('modal').classList.remove('active')}
async function saveTask(){
  const data={
    Name:document.getElementById('f-name').value.trim(),
    CronExpression:document.getElementById('f-cron').value.trim(),
    ScriptPath:document.getElementById('f-script').value.trim(),
    Arguments:document.getElementById('f-args').value.trim(),
    WorkingDirectory:document.getElementById('f-workdir').value.trim(),
    Description:document.getElementById('f-desc').value.trim()
  };
  if(!data.Name||!data.CronExpression||!data.ScriptPath){toast('Name, Cron, and Script are required','error');return}
  try{
    const url=editingId?API+'/tasks/'+editingId:API+'/tasks';
    const method=editingId?'PUT':'POST';
    const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const d=await r.json();
    if(d.error){toast(d.error,'error');return}
    toast(editingId?'Task updated':'Task created');
    hideModal();loadTasks();
  }catch(e){toast('Error: '+e.message,'error')}
}
async function deleteTask(id,name){
  if(!confirm('Delete "'+name+'"?'))return;
  try{await fetch(API+'/tasks/'+id,{method:'DELETE'});toast('Task deleted');loadTasks()}catch(e){toast(e.message,'error')}
}
async function runTask(id){
  try{toast('Running...');const r=await fetch(API+'/tasks/'+id+'/run',{method:'POST'});const d=await r.json();
    toast(d.data?(d.data.Status+' ('+d.data.Duration+')'):'Done',d.data&&d.data.Status==='Success'?'success':'error');
    loadTasks();}catch(e){toast(e.message,'error')}
}
let cronTimer=null;
function validateCronLive(){
  clearTimeout(cronTimer);
  const v=document.getElementById('f-cron').value;
  const desc=document.getElementById('f-cron-desc');
  if(!v){desc.textContent='';return}
  cronTimer=setTimeout(async()=>{
    try{const r=await fetch(API+'/validate-cron',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expression:v})});
      const d=await r.json();desc.textContent=d.valid?'✓ '+d.description:'✕ '+((d.errors||[]).join(', ')||'Invalid');desc.style.color=d.valid?'var(--green)':'var(--red)';
    }catch(e){desc.textContent=''}
  },300);
}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function toast(msg,type){
  const t=document.createElement('div');t.className='toast';
  t.style.borderColor=type==='error'?'var(--red)':type==='success'?'var(--green)':'var(--border)';
  t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),3000);
}
document.getElementById('modal').addEventListener('click',e=>{if(e.target===e.currentTarget)hideModal()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideModal();if(e.key==='Enter'&&document.getElementById('modal').classList.contains('active'))saveTask()});
loadTasks();
</script>
</body></html>`;
  }

  // ─── API Documentation HTML ───
  getDocsHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kyrion Kronou API Docs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08080c;--card:#0f0f14;--border:rgba(255,255,255,.06);--text:#c0c0d0;--text2:#808094;--primary:#6a5acd;--green:#6a8a6e;--red:#8a5a5a;--amber:#8a7a5a}
body{font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:24px}
h1{font-size:22px;font-weight:600;margin-bottom:8px;background:linear-gradient(135deg,var(--primary),#8a7acd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:var(--text2);margin-bottom:24px;font-size:14px}
h2{font-size:16px;font-weight:600;margin:24px 0 12px;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:8px}
h3{font-size:13px;font-weight:600;margin:12px 0 6px}
.method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;margin-right:6px}
.get{background:rgba(106,138,110,.15);color:var(--green)}
.post{background:rgba(106,90,173,.15);color:var(--primary)}
.put{background:rgba(138,122,90,.15);color:var(--amber)}
.delete{background:rgba(138,90,90,.15);color:var(--red)}
.endpoint{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.endpoint-header{display:flex;align-items:center;margin-bottom:8px}
.endpoint-path{font-family:monospace;font-size:13px;color:var(--text)}
.endpoint-desc{font-size:13px;color:var(--text2);margin-bottom:8px}
pre{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;color:var(--text);margin:8px 0}
code{background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:12px}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px}
th{color:var(--text2);text-transform:uppercase;font-size:10px;letter-spacing:.5px}
.note{background:rgba(106,90,173,.08);border:1px solid rgba(106,90,173,.15);border-radius:8px;padding:12px;font-size:13px;margin:12px 0}
.nav{position:sticky;top:0;background:var(--bg);padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:16px;z-index:10}
.nav a{color:var(--primary);text-decoration:none;font-size:12px;margin-right:12px}
.nav a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
  <h1>Kyrion Kronou API</h1>
  <p class="subtitle">REST API for managing scheduled tasks, services, and scripts</p>
  <div class="nav">
    <a href="#auth">Auth</a><a href="#tasks">Tasks</a><a href="#scripts">Scripts</a>
    <a href="#services">Services</a><a href="#history">History</a><a href="#utils">Utilities</a>
    <a href="/">Dashboard</a>
  </div>

  <div class="note">
    <strong>Base URL:</strong> <code>http://localhost:${this.port}/api</code><br>
    <strong>Auth:</strong> Optional API key via <code>X-API-Key</code> header (configure in Settings)
  </div>

  <h2 id="auth">Authentication</h2>
  <p style="font-size:13px;color:var(--text2)">If an API key is configured in the desktop app (Settings → API Key), include it in every request:</p>
  <pre>curl -H "X-API-Key: YOUR_KEY" http://localhost:${this.port}/api/tasks</pre>

  <h2 id="tasks">Tasks</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks</span></div>
    <div class="endpoint-desc">List all tasks. Optional: <code>?enabled=true</code> <code>?search=keyword</code></div>
    <pre>curl http://localhost:${this.port}/api/tasks</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Get a single task by ID</div>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks</span></div>
    <div class="endpoint-desc">Create a new task</div>
    <h3>Body</h3>
    <table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>
    <tr><td><code>Name</code></td><td>string</td><td>✓</td><td>Task name</td></tr>
    <tr><td><code>CronExpression</code></td><td>string</td><td>✓</td><td>Cron expression (e.g. <code>0 5 * * *</code>)</td></tr>
    <tr><td><code>ScriptPath</code></td><td>string</td><td>✓</td><td>Full path to script/executable</td></tr>
    <tr><td><code>Arguments</code></td><td>string</td><td></td><td>Script arguments</td></tr>
    <tr><td><code>WorkingDirectory</code></td><td>string</td><td></td><td>Working directory</td></tr>
    <tr><td><code>Description</code></td><td>string</td><td></td><td>Task description</td></tr>
    <tr><td><code>Enabled</code></td><td>boolean</td><td></td><td>Default: true</td></tr>
    </tbody></table>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"Name":"Daily Backup","CronExpression":"0 2 * * *","ScriptPath":"C:\\\\Scripts\\\\backup.ps1"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method put">PUT</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Update an existing task (partial update supported)</div>
    <pre>curl -X PUT http://localhost:${this.port}/api/tasks/TASK_ID \\
  -H "Content-Type: application/json" \\
  -d '{"CronExpression":"0 3 * * *"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method delete">DELETE</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Delete a task</div>
    <pre>curl -X DELETE http://localhost:${this.port}/api/tasks/TASK_ID</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks/:id/run</span></div>
    <div class="endpoint-desc">Execute a task immediately</div>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/run</pre>
  </div>

  <h2 id="scripts">Scripts</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks/:id/attach</span></div>
    <div class="endpoint-desc">Attach (or re-attach) a script to a task</div>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/attach \\
  -H "Content-Type: application/json" \\
  -d '{"ScriptPath":"C:\\\\NewScript.ps1","Arguments":"-Verbose"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method delete">DELETE</span><span class="endpoint-path">/api/tasks/:id/attach</span></div>
    <div class="endpoint-desc">Detach the script from a task (keeps the task, removes script reference)</div>
    <pre>curl -X DELETE http://localhost:${this.port}/api/tasks/TASK_ID/attach</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks/:id/script</span></div>
    <div class="endpoint-desc">Get script info for a task (path, args, exists check)</div>
  </div>

  <h2 id="services">Services</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/services</span></div>
    <div class="endpoint-desc">List all NSSM-managed services</div>
  </div>

  <h2 id="history">History</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/history</span></div>
    <div class="endpoint-desc">Execution history. Optional: <code>?taskId=ID</code> <code>?limit=50</code></div>
  </div>

  <h2 id="utils">Utilities</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/health</span></div>
    <div class="endpoint-desc">Server health check</div>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/validate-cron</span></div>
    <div class="endpoint-desc">Validate a cron expression</div>
    <pre>curl -X POST http://localhost:${this.port}/api/validate-cron \\
  -H "Content-Type: application/json" \\
  -d '{"expression":"0 5 * * *"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/config</span></div>
    <div class="endpoint-desc">Current configuration (profiles, settings)</div>
  </div>

  <h2>Quick Examples</h2>
  <h3>Create + Attach + Run</h3>
  <pre># 1. Create task
curl -X POST http://localhost:${this.port}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"Name":"Ping Test","CronExpression":"*/5 * * * *","ScriptPath":"ping.exe"}'

# 2. Attach a different script
curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/attach \\
  -H "Content-Type: application/json" \\
  -d '{"ScriptPath":"C:\\\\Scripts\\\\ping-test.bat","Arguments":"-n 10 google.com"}'

# 3. Run it now
curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/run

# 4. Check history
curl http://localhost:${this.port}/api/history?taskId=TASK_ID&limit=5</pre>
</div>
</body></html>`;
  }
}

module.exports = ApiServer;
