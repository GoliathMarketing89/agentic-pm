import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-journal-'));
  let time = new Date();
  let app = createApp({ dataDir, now: () => time, ...options });
  t.after(async () => { if (app) await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, get app() { return app; }, set app(value) { app = value; }, advance(ms) { time = new Date(time.getTime() + ms); } };
}
const rev = app => app.readProjects().revision;

test('journal retains ten actions across restart and each exact undo consumes the top', async t => {
  const f = await fixture(t);
  let state = f.app.readProjects();
  for (let i = 0; i < 11; i++) {
    const result = f.app.createProject({ name: `Project ${i}`, expectedRevision: state.revision, requestId: `create-${i}` });
    state = f.app.readProjects();
    assert.equal(result.revision, state.revision);
  }
  assert.equal(state.undo.remaining, 10);
  await f.app.close();
  f.app = createApp({ dataDir: f.dataDir, now: () => new Date('2026-11-05T00:00:00.000Z') });
  for (let i = 0; i < 10; i++) {
    const current = f.app.readProjects();
    f.app.undoLastChange({ commandId: current.undo.commandId, expectedRevision: current.revision, requestId: `undo-${i}` });
  }
  assert.equal(f.app.readProjects().projects.length, 1);
  assert.equal(f.app.readProjects().undo, null);
});

test('text changes make project history, noops do not, and identical retries stay idempotent', async t => {
  const f = await fixture(t);
  let created = f.app.createProject({ name: 'Alpha', expectedRevision: 0, requestId: 'create' });
  let result = f.app.updateProject({ projectId: created.project.id, currentTask: 'First', expectedRevision: rev(f.app), requestId: 'edit-a' });
  assert.equal(result.project.currentTask, 'First');
  const beforeNoop = rev(f.app);
  f.app.updateProject({ projectId: created.project.id, currentTask: 'First', expectedRevision: beforeNoop, requestId: 'edit-noop' });
  assert.equal(rev(f.app), beforeNoop);
  const history = f.app.readProjectHistory({ projectId: created.project.id });
  assert.equal(history.events.length, 2);
  assert.equal(history.events[0].oldValue, '');
  assert.equal(history.events[0].newValue, 'First');
  const undo = f.app.readProjects().undo;
  const expectedRevision = rev(f.app);
  f.app.undoLastChange({ commandId: undo.commandId, expectedRevision, requestId: 'undo-once' }, 'agent:Researcher');
  const revisionAfterUndo = rev(f.app);
  f.app.undoLastChange({ commandId: undo.commandId, expectedRevision, requestId: 'undo-once' });
  assert.equal(rev(f.app), revisionAfterUndo);
  assert.equal(f.app.readProjectHistory({ projectId: created.project.id }).events[0].kind, 'undo');
  assert.equal(f.app.readProjectHistory({ projectId: created.project.id }).events[0].actor, 'agent:Researcher');
});

test('stale targets fail and a normal action after undo starts a fresh branch', async t => {
  const f = await fixture(t);
  f.app.createProject({ name: 'A', expectedRevision: 0, requestId: 'a' });
  const old = f.app.readProjects().undo;
  f.app.createProject({ name: 'B', expectedRevision: rev(f.app), requestId: 'b' });
  assert.throws(() => f.app.undoLastChange({ commandId: old.commandId, expectedRevision: rev(f.app), requestId: 'stale' }), /no longer the latest/);
  let state = f.app.readProjects();
  f.app.undoLastChange({ commandId: state.undo.commandId, expectedRevision: state.revision, requestId: 'undo-b' });
  state = f.app.readProjects();
  assert.equal(state.projects.length, 1);
  f.app.updateProject({ projectId: state.projects[0].id, currentTask: 'fresh branch', expectedRevision: state.revision, requestId: 'new-branch' });
  assert.equal(f.app.readProjects().undo.label, 'Update project');
});

test('expired deletion undo is blocked without reviving or resetting the original timestamp', async t => {
  const f = await fixture(t);
  const made = f.app.createProject({ name: 'A', expectedRevision: 0, requestId: 'a' });
  const deleted = f.app.deleteProject({ projectId: made.project.id, expectedRevision: rev(f.app), requestId: 'del' });
  const deletedAt = deleted.trash[0].deletedAt;
  f.advance(7 * 86400000 + 1000);
  const undo = f.app.readProjects().undo;
  assert.match(undo.blockedReason, /seven-day/);
  assert.throws(() => f.app.undoLastChange({ commandId: undo.commandId, expectedRevision: rev(f.app), requestId: 'late-undo' }), /expired/);
  assert.equal(f.app.readProjects().projects.length, 0);
  assert.equal(f.app.readProjects().trash.length, 0);
  assert.equal(deletedAt, new Date(deletedAt).toISOString());
});

test('undo of a restoration is blocked when the original deletion window expires and keeps actor', async t => {
  const f = await fixture(t);
  const made = f.app.createProject({ name: 'A', expectedRevision: 0, requestId: 'a' });
  f.app.deleteProject({ projectId: made.project.id, expectedRevision: rev(f.app), requestId: 'del' });
  f.app.restoreProject({ projectId: made.project.id, expectedRevision: rev(f.app), requestId: 'restore' });
  f.advance(7 * 86400000 + 1000);
  const state = f.app.readProjects();
  assert.match(state.undo.blockedReason, /original seven-day/);
  assert.throws(() => f.app.undoLastChange({ commandId: state.undo.commandId, expectedRevision: state.revision, requestId: 'undo-restore' }, 'agent:Researcher'), /original seven-day/);
  assert.equal(f.app.readProjects().projects.length, 1);
  assert.equal(rev(f.app), state.revision);
});

test('history pagination is newest first with stable cursor', async t => {
  const f = await fixture(t);
  const made = f.app.createProject({ name: 'A', expectedRevision: 0, requestId: 'a' });
  f.app.updateProject({ projectId: made.project.id, currentTask: 'one', expectedRevision: rev(f.app), requestId: 'e1' });
  f.app.updateProject({ projectId: made.project.id, currentTask: 'two', expectedRevision: rev(f.app), requestId: 'e2' });
  const first = f.app.readProjectHistory({ projectId: made.project.id, limit: 1 });
  const second = f.app.readProjectHistory({ projectId: made.project.id, limit: 1, beforeId: first.nextCursor });
  assert.equal(first.events[0].newValue, 'two');
  assert.equal(second.events[0].newValue, 'one');
  assert.notEqual(first.events[0].id, second.events[0].id);
});

test('a current export with creation, text and delete history imports without losing events', async t => {
  const f = await fixture(t);
  const made = f.app.createProject({name:'History backup',expectedRevision:0,requestId:'backup-create'});
  f.app.updateProject({projectId:made.project.id,notes:'Saved context',expectedRevision:rev(f.app),requestId:'backup-edit'});
  f.app.deleteProject({projectId:made.project.id,expectedRevision:rev(f.app),requestId:'backup-delete'});
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${f.app.server.address().port}`;
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  const backup=await (await fetch(origin+'/api/export',{headers})).json();
  assert.ok(backup.projectHistory.some(event=>event.kind==='create'));
  assert.ok(backup.projectHistory.some(event=>event.kind==='delete'));
  const response=await fetch(origin+'/api/projects',{method:'PUT',headers,body:JSON.stringify({revision:rev(f.app),requestId:'backup-import',restore:true,projects:backup.projects,organization:backup.organization,pins:backup.pins,trash:backup.trash,projectHistory:backup.projectHistory})});
  assert.equal(response.status,200,await response.text());
  const events=f.app.readProjectHistory({projectId:made.project.id}).events;
  assert.equal(events.length,backup.projectHistory.length);
  assert.deepEqual(new Set(events.map(event=>event.kind)),new Set(backup.projectHistory.map(event=>event.kind)));
});

test('an export after replacing projects can reimport its removal history', async t => {
  const f = await fixture(t);
  f.app.createProject({name:'Previous workspace',expectedRevision:0,requestId:'previous-project'});
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${f.app.server.address().port}`;
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
  const empty={projects:[],organization:{groups:[],assignments:{}},pins:[],trash:[],projectHistory:[]};
  const replace=await fetch(origin+'/api/projects',{method:'PUT',headers,body:JSON.stringify({...empty,revision:rev(f.app),requestId:'replace-workspace',restore:true})});
  assert.equal(replace.status,200,await replace.text());
  const backup=await (await fetch(origin+'/api/export',{headers})).json();
  assert.ok(backup.projectHistory.some(event=>event.kind==='remove'));
  const response=await fetch(origin+'/api/projects',{method:'PUT',headers,body:JSON.stringify({revision:rev(f.app),requestId:'reimport-removal',restore:true,projects:backup.projects,organization:backup.organization,pins:backup.pins,trash:backup.trash,projectHistory:backup.projectHistory})});
  assert.equal(response.status,200,await response.text());
});

test('history backups larger than the old one-megabyte limit remain importable', async t => {
  const f = await fixture(t);
  const made=f.app.createProject({name:'Long history',expectedRevision:0,requestId:'long-project'});
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${f.app.server.address().port}`;
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const snapshot=f.app.readProjects();
  const projectHistory=Array.from({length:60},()=>({projectId:made.project.id,kind:'update',field:'notes',oldValue:'a'.repeat(10000),newValue:'b'.repeat(10000),time:new Date().toISOString(),actor:'User'}));
  const body=JSON.stringify({...snapshot,requestId:'long-import',restore:true,projectHistory});
  assert.ok(Buffer.byteLength(body)>1_000_000);
  const response=await fetch(origin+'/api/projects',{method:'PUT',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body});
  assert.equal(response.status,200,await response.text());
  assert.equal(f.app.readProjectHistory({projectId:made.project.id,limit:100}).events.length,60);
});

test('retry result storage is bounded to the documented fifty-change window', async t => {
  const f=await fixture(t);
  const made=f.app.createProject({name:'Retention',expectedRevision:0,requestId:'retention-create'});
  for(let i=0;i<60;i++) f.app.updateProject({projectId:made.project.id,currentTask:`Task ${i}`,expectedRevision:rev(f.app),requestId:`retention-${i}`});
  const database=new DatabaseSync(join(f.dataDir,'projects.sqlite'),{readOnly:true});
  try { assert.ok(database.prepare('SELECT COUNT(*) AS count FROM command_results').get().count<=50); }
  finally {database.close();}
});

test('undo restores exact shared data across connector edits, hierarchy, archive, pins and placement', async t => {
  const f=await fixture(t);
  const group=(await f.app.agentAction('create-island',{name:'Work',expectedRevision:0,requestId:'roundtrip-island'})).island;
  const parent=(await f.app.agentAction('create-project',{name:'Parent',groupId:group.id,expectedRevision:rev(f.app),requestId:'roundtrip-parent'})).project;
  const child=(await f.app.agentAction('create-project',{name:'Child',parentProjectId:parent.id,expectedRevision:rev(f.app),requestId:'roundtrip-child'})).project;
  const shared=state=>({projects:state.projects,organization:state.organization,pins:state.pins,trash:state.trash});
  const changes=[
    (revision,requestId)=>f.app.agentAction('update-project',{projectId:child.id,name:'New name',links:[{label:'Reference',url:'https://example.com'}],expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.updateProject({projectId:child.id,notes:'New notes',currentTask:'Next step',expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.pinProject({projectId:child.id,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.archiveProject({projectId:parent.id,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.moveProject({projectId:child.id,groupId:null,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.setIslandPosition({islandId:group.id,x:200,y:500,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.agentAction('update-island',{islandId:group.id,name:'Renamed work',expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.agentAction('remove-island',{islandId:group.id,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.deleteProject({projectId:child.id,expectedRevision:revision,requestId}),
    (revision,requestId)=>f.app.agentAction('create-project',{name:'Temporary',expectedRevision:revision,requestId}),
  ];
  for(let i=0;i<changes.length;i++){
    const before=f.app.readProjects();
    await changes[i](before.revision,`roundtrip-change-${i}`);
    const after=f.app.readProjects();
    assert.ok(after.revision>before.revision);
    f.app.undoLastChange({commandId:after.undo.commandId,expectedRevision:after.revision,requestId:`roundtrip-undo-${i}`});
    assert.deepEqual(shared(f.app.readProjects()),shared(before),`Shared state differs after undoing action ${i}`);
  }
});

test('unchanged requests have bounded receipts without consuming undo or losing stale-write protection', async t => {
  const f=await fixture(t);
  const made=f.app.createProject({name:'No-op retention',expectedRevision:0,requestId:'noop-base'});
  const revision=rev(f.app);
  for(let i=0;i<520;i++) await f.app.agentAction('update-project',{projectId:made.project.id,currentTask:'',expectedRevision:revision,requestId:`noop-${i}`});
  for(let i=0;i<520;i++) f.app.unpinProject({projectId:made.project.id,expectedRevision:revision,requestId:`noop-unpin-${i}`});
  const database=new DatabaseSync(join(f.dataDir,'projects.sqlite'),{readOnly:true});
  try {
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM command_results WHERE command_id IS NULL').get().count<=500);
    assert.ok(database.prepare('SELECT COUNT(*) AS count FROM agent_operations').get().count<=500);
  } finally {database.close();}
  assert.equal(rev(f.app),revision);
  assert.equal(f.app.readProjects().undo.remaining,1);
  f.app.updateProject({projectId:made.project.id,notes:'Newer content',expectedRevision:revision,requestId:'after-noops'});
  await assert.rejects(f.app.agentAction('update-project',{projectId:made.project.id,currentTask:'',expectedRevision:revision,requestId:'noop-0'}),/changed/);
  assert.equal(f.app.readProjects().projects[0].notes,'Newer content');
});

test('undoing an import restores the prior project history as well as project data', async t => {
  const f=await fixture(t);
  const made=f.app.createProject({name:'History before import',expectedRevision:0,requestId:'before-import-create'});
  f.app.updateProject({projectId:made.project.id,notes:'Original saved context',expectedRevision:rev(f.app),requestId:'before-import-edit'});
  const previousHistory=f.app.readProjectHistory({projectId:made.project.id}).events;
  await new Promise(resolve=>f.app.server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${f.app.server.address().port}`;
  const cookie=(await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const snapshot=f.app.readProjects();
  const projectHistory=[{projectId:made.project.id,kind:'update',field:'notes',oldValue:'Imported old',newValue:'Imported new',time:new Date().toISOString(),actor:'Imported actor'}];
  const response=await fetch(origin+'/api/projects',{method:'PUT',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...snapshot,restore:true,requestId:'replace-history',projectHistory})});
  assert.equal(response.status,200,await response.text());
  const imported=f.app.readProjects();
  f.app.undoLastChange({commandId:imported.undo.commandId,expectedRevision:imported.revision,requestId:'undo-history-import'});
  const restored=f.app.readProjectHistory({projectId:made.project.id}).events;
  for(const event of previousHistory) assert.ok(restored.some(item=>item.id===event.id&&item.kind===event.kind&&item.newValue===event.newValue&&item.actor===event.actor));
  assert.ok(!restored.some(event=>event.actor==='Imported actor'));
});
