import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const project = { id: 'omega', name: 'Example project', currentTask: 'Read the brief', notes: 'Keep this context.', needsMichael: false, links: [{ label: 'Work', url: 'https://example.com' }] };

test('connector nests, deletes and restores with seven-day recovery and safe retries', async () => {
  const f = await fixture();
  const invoke = async (name, args) => (await f.call('tools/call', {name, arguments:args})).result;
  try {
    const child = {...project, id:'child', name:'Child'};
    const grandchild = {...project, id:'grandchild', name:'Grandchild'};
    const organization = {groups:[{id:'work',name:'Work',parentId:null}], assignments:{omega:'work',child:'work'}, projectParents:{grandchild:'child'}};
    await f.api('PUT', {revision:1,requestId:'family',projects:[project,child,grandchild],organization});
    const move = {projectId:'child',parentProjectId:'omega',expectedRevision:2,requestId:'nest'};
    assert.equal((await invoke('move_project',move)).isError,false);
    assert.equal((await invoke('move_project',move)).structuredContent.revision,3);
    let browser = await (await f.api()).json();
    assert.equal(browser.organization.projectParents.child,'omega');
    assert.equal(browser.organization.projectParents.grandchild,'child');
    const read = await invoke('get_project',{projectId:'child'});
    assert.equal(read.structuredContent.parentProjectId,'omega');
    assert.deepEqual(read.structuredContent.islandPath,['Work']);
    for (const invalid of [
      {...move,projectId:'omega',parentProjectId:'grandchild',expectedRevision:3,requestId:'cycle'},
      {...move,parentProjectId:'missing',expectedRevision:3,requestId:'missing'},
      {...move,groupId:null,expectedRevision:3,requestId:'both'},
      {...move,expectedRevision:3,requestId:'nest'},
      {...move,requestId:'stale'},
    ]) assert.equal((await invoke('move_project',invalid)).isError,true);
    const deletion = {projectId:'omega',expectedRevision:3,requestId:'delete-parent'};
    assert.equal((await invoke('delete_project',deletion)).isError,false);
    browser = await (await f.api()).json();
    assert.equal(browser.projects.length,2);
    assert.deepEqual(browser.trash[0].project,project);
    assert.equal(browser.organization.assignments.child,'work');
    assert.equal(browser.organization.projectParents.grandchild,'child');
    const deletedAt = browser.trash[0].deletedAt;
    assert.equal((await invoke('delete_project',deletion)).structuredContent.revision,4);
    assert.equal((await invoke('list_projects',{})).structuredContent.trash[0].deletedAt,deletedAt);
    const restoration = {projectId:'omega',expectedRevision:4,requestId:'restore-parent'};
    assert.equal((await invoke('restore_project',restoration)).isError,false);
    assert.equal((await invoke('restore_project',restoration)).structuredContent.revision,5);
    // Retrying an old successful deletion after restoration must not delete again.
    assert.equal((await invoke('delete_project',deletion)).structuredContent.projects.length,3);
    browser = await (await f.api()).json();
    assert.equal(browser.trash.length,0);
    assert.deepEqual(browser.projects.find(p=>p.id==='omega'),project);
    assert.equal((await invoke('move_project',{projectId:'child',groupId:null,expectedRevision:5,requestId:'unnest'})).isError,false);
    browser = await (await f.api()).json();
    assert.equal(browser.organization.projectParents.child,undefined);
    assert.equal(browser.organization.assignments.child,undefined);
    const old = {project:{...project,id:'expired'},deletedAt:new Date(Date.now()-8*86400000).toISOString()};
    await f.api('PUT',{revision:6,requestId:'expired-fixture',projects:browser.projects,organization:browser.organization,trash:[old]});
    const expiredRevision = (await invoke('list_projects',{})).structuredContent.revision;
    const expired = await invoke('restore_project',{projectId:'expired',expectedRevision:expiredRevision,requestId:'expired-restore'});
    assert.equal(expired.isError,true);
    assert.equal(expired.structuredContent.code,'invalid_input');
    assert.equal((await invoke('list_projects',{})).structuredContent.revision,expiredRevision);
  } finally { await f.close(); }
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'projects-mcp-'));
  const app = createApp({ dataDir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0];
  const api = (method = 'GET', body) => fetch(`${origin}/api/projects`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  await api('PUT', { revision: 0, requestId: 'setup', projects: [project] });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { env: { ...process.env, PROJECT_LIST_DATA_DIR: dataDir, PROJECT_LIST_AGENT_NAME: 'test-agent' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const pending = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const message = JSON.parse(line); const request = pending.get(message.id); if (request) { clearTimeout(request.timeout); pending.delete(message.id); request.resolve(message); } });
  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${errors}`)); }, 5000);
      pending.set(id, { resolve, timeout });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  let init;
  try { init = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } }); }
  catch (error) { child.kill(); lines.close(); await app.close(); throw error; }
  assert.equal(init.result.protocolVersion, '2025-11-25');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { app, api, call, async close() { child.stdin.end(); await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); }); lines.close(); await app.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('real stdio client discovers scoped tools and agent writes appear in the browser data', async () => {
  const f = await fixture();
  try {
    const tools = await f.call('tools/list', {});
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ['pin_project', 'unpin_project', 'clear_pins', 'move_project', 'delete_project', 'restore_project', 'archive_project', 'restore_archived_project', 'set_island_position', 'create_project', 'list_projects', 'get_project', 'update_project', 'reorder_projects', 'create_island', 'update_island', 'remove_island', 'read_project_history', 'undo_last_change']);
    const read = await f.call('tools/call', { name: 'get_project', arguments: { projectId: 'omega' } });
    assert.equal(read.result.structuredContent.project.notes, 'Keep this context.');
    assert.equal(read.result.structuredContent.pinned, false);
    const update = { projectId: 'omega', expectedRevision: 1, requestId: 'update-1', currentTask: 'Review the draft', notes: 'Keep this context. Draft ready.', needsMichael: true };
    const result = await f.call('tools/call', { name: 'update_project', arguments: update });
    assert.equal(result.result.isError, false);
    const browser = await (await f.api()).json();
    assert.equal(browser.revision, 2);
    assert.deepEqual(browser.projects, [{ ...project, currentTask: update.currentTask, notes: update.notes, needsMichael: true }]);
    await f.call('tools/call', { name: 'update_project', arguments: update });
    assert.equal((await (await f.api()).json()).revision, 2);
    const stale = await f.call('tools/call', { name: 'update_project', arguments: { ...update, requestId: 'stale', notes: 'Old state' } });
    assert.equal(stale.result.isError, true);
    assert.equal(stale.result.structuredContent.code, 'conflict');
    for (const forbidden of [{ projects: [] }, { organization: {groups:[],assignments:{}} }]) {
      const rejected = await f.call('tools/call', { name: 'update_project', arguments: { ...update, expectedRevision: 2, requestId: 'forbidden', ...forbidden } });
      assert.equal(rejected.result.isError, true);
    }
    assert.equal((await (await f.api()).json()).projects[0].name, 'Example project');
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }], assignments: { omega: 'work' } };
    assert.equal((await f.api('PUT', { revision: 2, requestId: 'place', projects: browser.projects, organization })).status, 200);
    const located = await f.call('tools/call', { name: 'get_project', arguments: { projectId: 'omega' } });
    assert.deepEqual(located.result.structuredContent.islandPath, ['Work']);
    const change = await f.call('tools/call', { name: 'update_project', arguments: { projectId: 'omega', expectedRevision: 3, requestId: 'after-place', currentTask: 'New task inside Work' } });
    assert.equal(change.result.isError, false);
    assert.deepEqual((await (await f.api()).json()).organization, organization);
    const move = await f.call('tools/call', { name: 'update_project', arguments: { projectId: 'omega', expectedRevision: 4, requestId: 'agent-move', organization: { groups: [], assignments: {} } } });
    assert.equal(move.result.isError, true);
  } finally { await f.close(); }
});

test('connector pins are revision checked, idempotent, readable, and clear atomically', async () => {
  const f = await fixture();
  const invoke = async (name, args) => (await f.call('tools/call', { name, arguments: args })).result;
  try {
    const pin = { projectId: 'omega', expectedRevision: 1, requestId: 'pin-omega' };
    let result = await invoke('pin_project', pin);
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.pins, ['omega']);
    assert.equal((await invoke('pin_project', pin)).structuredContent.revision, 2);
    const read = await invoke('get_project', { projectId: 'omega' });
    assert.equal(read.structuredContent.pinned, true);
    const stale = await invoke('unpin_project', { ...pin, requestId: 'stale-unpin' });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.code, 'conflict');
    const changedRetry = await invoke('pin_project', { ...pin, projectId: 'missing' });
    assert.equal(changedRetry.isError, true);
    result = await invoke('clear_pins', { expectedRevision: 2, requestId: 'clear-all' });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.pins, []);
    assert.equal((await invoke('clear_pins', { expectedRevision: 2, requestId: 'clear-all' })).structuredContent.revision, 3);
    result = await invoke('unpin_project', { projectId: 'omega', expectedRevision: 3, requestId: 'unpin-empty' });
    assert.equal(result.isError, false);
    assert.deepEqual((await invoke('list_projects', {})).structuredContent.pins, []);
  } finally { await f.close(); }
});

test('creation appends in an existing island with retry and conflict protection', async () => {
  const f = await fixture();
  try {
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }], assignments: { omega: 'work' } };
    await f.api('PUT', { revision: 1, requestId: 'organize', projects: [project], organization });
    const create = { name: 'Example client', groupId: 'work', currentTask: 'Review work', expectedRevision: 2, requestId: 'create-blue' };
    const result = await f.call('tools/call', { name: 'create_project', arguments: create });
    assert.equal(result.result.isError, false);
    assert.deepEqual(result.result.structuredContent.islandPath, ['Work']);
    const browser = await (await f.api()).json();
    assert.equal(browser.revision, 3);
    assert.equal(browser.projects.length, 2);
    assert.deepEqual(browser.projects[0], project);
    await f.call('tools/call', { name: 'create_project', arguments: create });
    assert.equal((await (await f.api()).json()).revision, 3);
    for (const invalid of [
      { ...create, requestId: 'stale' },
      { ...create, expectedRevision: 3, requestId: 'invalid-group', groupId: 'missing' },
      { ...create, expectedRevision: 3, requestId: 'blank', name: ' ' },
      { ...create, expectedRevision: 3, requestId: 'forbidden', projects: [] },
    ]) {
      const rejected = await f.call('tools/call', { name: 'create_project', arguments: invalid });
      assert.equal(rejected.result.isError, true);
    }
    assert.equal((await (await f.api()).json()).projects.length, 2);
  } finally { await f.close(); }
});

test('connector archive batches active descendants and board positions survive edits and retries', async () => {
  const f = await fixture();
  const invoke = async (name, args) => (await f.call('tools/call', { name, arguments: args })).result;
  try {
    const child = { ...project, id: 'child', name: 'Child' };
    const grandchild = { ...project, id: 'grandchild', name: 'Grandchild' };
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }], assignments: { omega: 'work' }, projectParents: { child: 'omega', grandchild: 'child' }, archives: { grandchild: { archivedAt: '2026-11-04T00:00:00.000Z', batchId: 'independent' } }, boardPositions: { work: { x: 95, y: -40 } } };
    assert.equal((await f.api('PUT', { revision: 1, requestId: 'archive-setup', projects: [project, child, grandchild], organization })).status, 200);
    const archive = { projectId: 'omega', expectedRevision: 2, requestId: 'archive-parent' };
    let result = await invoke('archive_project', archive);
    assert.equal(result.isError, false);
    assert.equal((await invoke('archive_project', archive)).structuredContent.revision, 3);
    let browser = await (await f.api()).json();
    assert.equal(browser.organization.archives.omega.batchId, browser.organization.archives.child.batchId);
    assert.equal(browser.organization.archives.grandchild.batchId, 'independent');
    assert.deepEqual(browser.organization.boardPositions, organization.boardPositions);
    const edit = await invoke('update_project', { projectId: 'omega', expectedRevision: 3, requestId: 'edit-archived', notes: 'Edited while archived' });
    assert.equal(edit.isError, false);
    browser = await (await f.api()).json();
    assert.ok(browser.organization.archives.omega);
    assert.equal(browser.projects.find(item => item.id === 'omega').notes, 'Edited while archived');
    result = await invoke('restore_archived_project', { projectId: 'child', expectedRevision: 4, requestId: 'restore-parent-batch' });
    assert.equal(result.isError, false);
    browser = await (await f.api()).json();
    assert.equal(browser.organization.archives.omega, undefined);
    assert.equal(browser.organization.archives.child, undefined);
    assert.equal(browser.organization.archives.grandchild.batchId, 'independent');
    assert.deepEqual(browser.organization.projectParents, organization.projectParents);
    assert.deepEqual(browser.organization.boardPositions, organization.boardPositions);
    const position = { islandId: 'work', x: 120.5, y: -88, expectedRevision: 5, requestId: 'position-1' };
    result = await invoke('set_island_position', position);
    assert.equal(result.isError, false);
    assert.equal((await invoke('set_island_position', position)).structuredContent.revision, 6);
    browser = await (await f.api()).json();
    assert.deepEqual(browser.organization.boardPositions.work, { x: 120.5, y: -88 });
    const invalid = await invoke('set_island_position', { ...position, x: Infinity, expectedRevision: 6, requestId: 'bad-position' });
    assert.equal(invalid.isError, true);
    assert.equal((await (await f.api()).json()).revision, 6);
  } finally { await f.close(); }
});
