import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

test('stdio connector exposes parity actions, scoped reads, history, and revision checked undo', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'projects-parity-'));
  const app = createApp({ dataDir });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { env: { ...process.env, PROJECT_LIST_DATA_DIR: dataDir, PROJECT_LIST_AGENT_NAME: 'parity-test' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  lines.on('line', line => {
    const message = JSON.parse(line); const request = pending.get(message.id);
    if (request) { clearTimeout(request.timeout); pending.delete(message.id); request.resolve(message); }
  });
  function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${errors}`)); }, 5000);
      pending.set(id, { resolve, timeout });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  const invoke = async (name, args) => (await call('tools/call', { name, arguments: args })).result;
  try {
    const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity-client', version: '1' } });
    assert.equal(initialized.result.serverInfo.version, '1.4.0');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const catalog = (await call('tools/list')).result.tools;
    const names = new Set(catalog.map(tool => tool.name));
    for (const name of ['create_project', 'update_project', 'reorder_projects', 'create_island', 'update_island', 'remove_island', 'read_project_history', 'undo_last_change']) assert.ok(names.has(name), `${name} is discoverable`);
    const listed = await invoke('list_projects', {});
    assert.equal(listed.isError, false);
    const island = await invoke('create_island', { name: 'Connector island', expectedRevision: listed.structuredContent.revision, requestId: 'create-island' });
    assert.equal(island.isError, false);
    const islandId = island.structuredContent.island.id;
    const created = await invoke('create_project', { name: 'Connector project', links: [{ label: 'Brief', url: 'https://example.com/brief' }], groupId: islandId, expectedRevision: island.structuredContent.revision, requestId: 'create-project' });
    assert.equal(created.isError, false);
    assert.ok(created.structuredContent.project.id);
    assert.equal(created.structuredContent.project.links[0].url, 'https://example.com/brief');
    const id = created.structuredContent.project.id;
    const update = await invoke('update_project', { projectId: id, expectedRevision: created.structuredContent.revision, requestId: 'rename', name: 'Renamed connector project' });
    assert.equal(update.isError, false);
    assert.equal(update.structuredContent.project.name, 'Renamed connector project');
    assert.deepEqual(update.structuredContent.islandPath, ['Connector island']);
    const directCreate = await invoke('create_project', { name: 'Child project', parentProjectId: id, expectedRevision: update.structuredContent.revision, requestId: 'create-child' });
    assert.equal(directCreate.isError, false);
    const sibling = await invoke('create_project', { name: 'Sibling project', groupId: islandId, expectedRevision: directCreate.structuredContent.revision, requestId: 'create-sibling' });
    assert.equal(sibling.isError, false);
    const reordered = await invoke('reorder_projects', { scope: 'active', groupId: islandId, orderedIds: [sibling.structuredContent.project.id, id], expectedRevision: sibling.structuredContent.revision, requestId: 'reorder-siblings' });
    assert.equal(reordered.isError, false);
    assert.equal(reordered.structuredContent.projects[0].id, sibling.structuredContent.project.id);
    const scoped = await invoke('list_projects', { scope: 'active' });
    assert.equal(scoped.structuredContent.scopedProjects.length, 3);
    const changedIsland = await invoke('update_island', { islandId, name: 'Renamed island', expectedRevision: reordered.structuredContent.revision, requestId: 'rename-island' });
    assert.equal(changedIsland.isError, false);
    const removedIsland = await invoke('remove_island', { islandId, expectedRevision: changedIsland.structuredContent.revision, requestId: 'remove-island' });
    assert.equal(removedIsland.isError, false);
    assert.equal(removedIsland.structuredContent.organization.groups.some(group => group.id === islandId), false);
    const history = await invoke('read_project_history', { projectId: id });
    assert.equal(history.isError, false);
    assert.ok(history.structuredContent.events.length > 0);
    const latest = await invoke('list_projects', {});
    assert.ok(latest.structuredContent.undo?.commandId);
    const undone = await invoke('undo_last_change', { commandId: latest.structuredContent.undo.commandId, expectedRevision: latest.structuredContent.revision, requestId: 'undo-remove-island' });
    assert.equal(undone.isError, false);
    assert.equal((await invoke('list_projects', {})).structuredContent.organization.groups.some(group => group.id === islandId), true);
  } finally {
    child.stdin.end();
    await new Promise(resolve => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    lines.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
