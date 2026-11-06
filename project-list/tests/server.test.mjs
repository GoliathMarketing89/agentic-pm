import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { removeProject, restoreProject } from '../public/moves.mjs';

const project = { id: 'project-1', name: 'Example project', currentTask: 'Waiting for a new draft', notes: 'Keep this context', needsMichael: true, links: [{ label: 'Draft', url: 'https://example.com' }] };

test('board geometry and downloadable agent skills are served as public assets', async () => {
  const f = await fixture();
  try {
    const geometry = await fetch(`${f.origin}/board-alignment.mjs`);
    assert.equal(geometry.status, 200);
    assert.match(geometry.headers.get('content-type'), /text\/javascript/);
    const module = await import(`data:text/javascript;base64,${Buffer.from(await geometry.text()).toString('base64')}`);
    assert.equal(typeof module.arrangeItems, 'function');
    assert.equal(typeof module.snapIsland, 'function');
    const bundle = await fetch(`${f.origin}/agent-skills.zip`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get('content-type'), 'application/zip');
    const bytes = Buffer.from(await bundle.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    for (const skill of ['board-update', 'project-capture', 'daily-focus']) {
      assert.ok(bytes.includes(Buffer.from(`${skill}/SKILL.md`)) || bytes.includes(Buffer.from(`${skill}\\SKILL.md`)));
    }
    const guide = await fetch(`${f.origin}/agent-skills-guide.md`);
    assert.equal(guide.status, 200);
    assert.match(await guide.text(), /project_list/);
    assert.equal((await fetch(`${f.origin}/agent-skills/private.md`)).status, 404);
  } finally { await f.close(); }
});

test('nested projects and seven-day trash survive agent edits and backup restore', async () => {
  const f = await fixture();
  try {
    const child = { ...project, id: 'child', name: 'Sub-project' };
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }], assignments: { 'project-1': 'work' }, projectParents: { child: 'project-1' } };
    let response = await f.api('PUT', {revision:0, requestId:'family', projects:[project, child], organization});
    assert.equal(response.status, 200);
    let snapshot = await response.json();
    assert.deepEqual(snapshot.organization, organization);
    const deleted = removeProject(snapshot, project.id);
    response = await f.api('PUT', {revision:snapshot.revision, requestId:'delete-parent', ...deleted});
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.equal(snapshot.projects.length, 1);
    assert.deepEqual(snapshot.trash[0].project, project);
    assert.equal(snapshot.organization.assignments.child, 'work');
    f.app.updateProject({projectId:'child', expectedRevision:snapshot.revision, requestId:'edit-child', notes:'New child notes'});
    const cookie = (await fetch(f.origin)).headers.get('set-cookie').split(';')[0];
    const backup = await (await fetch(`${f.origin}/api/export`, {headers:{Cookie:cookie}})).json();
    assert.equal(backup.schemaVersion, 6);
    assert.deepEqual(backup.trash[0].project, project);
    const restored = restoreProject(backup, project.id);
    response = await f.api('PUT', {revision:backup.revision, requestId:'undelete', ...restored});
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.deepEqual(snapshot.projects.find(p => p.id === project.id), project);
    assert.equal(snapshot.projects.find(p => p.id === 'child').notes, 'New child notes');
    assert.equal(snapshot.trash.length, 0);
    response = await f.api('PUT', {revision:snapshot.revision, requestId:'old-delete', ...deleted, trash:[{...deleted.trash[0], deletedAt:new Date(Date.now()-8*86400000).toISOString()}]});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).trash.length, 0);
    assert.throws(() => restoreProject({...deleted, trash:[{...deleted.trash[0], deletedAt:new Date(Date.now()-8*86400000).toISOString()}]}, project.id), /no longer/);
    snapshot = await (await f.api()).json();
    response = await f.api('PUT', {revision:snapshot.revision, requestId:'backup-import', restore:true, projects:backup.projects, organization:backup.organization, trash:backup.trash});
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).trash, backup.trash);
    response = await f.api('PUT', {revision:snapshot.revision, requestId:'stale-delete', ...deleted});
    assert.equal(response.status, 409);
  } finally { await f.close(); }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'project-list-test-'));
  const app = createApp({ dataDir: dir });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const home = await fetch(origin);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const api = (method = 'GET', body, headers = {}) => fetch(`${origin}/api/projects`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const close = async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, app, origin, api, close };
}

test('saves all five fields, rejects stale edits and retries without duplication', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.origin}/api/projects`)).status, 401);
    assert.deepEqual((await (await f.api()).json()).projects, []);
    const request = { revision: 0, requestId: 'save-1', projects: [project] };
    const saved = await (await f.api('PUT', request)).json();
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.projects, [project]);
    assert.equal((await f.api('PUT', request)).status, 200);
    assert.equal((await (await f.api()).json()).revision, 1);
    assert.equal((await f.api('PUT', { ...request, requestId: 'stale-1', projects: [{ ...project, notes: 'stale edit' }] })).status, 409);
    assert.equal((await f.api('PUT', { ...request, requestId: 'evil-1' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.api('PUT', { revision: 1, requestId: 'unsafe-link', projects: [{ ...project, links: [{ label: 'Bad', url: 'javascript:alert(1)' }] }] })).status, 400);
    assert.deepEqual((await (await f.api()).json()).projects, [project]);
    const exported = await (await fetch(`${f.origin}/api/export`, { headers: { Cookie: (await fetch(f.origin)).headers.get('set-cookie').split(';')[0] } })).json();
    assert.equal(exported.schemaVersion, 6);
    assert.deepEqual(exported.projects, [project]);
  } finally { await f.close(); }
});

test('survives restart and keeps a local backup before replacing existing data', async () => {
  const f = await fixture();
  try {
    await f.api('PUT', { revision: 0, requestId: 'create', projects: [project] });
    await f.api('PUT', { revision: 1, requestId: 'update', projects: [{ ...project, currentTask: 'Another arbitrary task' }] });
    assert.ok(readdirSync(join(f.dir, 'backups')).length >= 1);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dir });
    await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${restarted.server.address().port}`;
    const cookie = (await fetch(origin)).headers.get('set-cookie').split(';')[0];
    const result = await (await fetch(`${origin}/api/projects`, { headers: { Cookie: cookie } })).json();
    assert.equal(result.revision, 2);
    assert.equal(result.projects[0].currentTask, 'Another arbitrary task');
    await restarted.close();
  } finally { await f.close(); }
});

test('restores exported text without duplicating entries and rejects malformed restores', async () => {
  const f = await fixture();
  try {
    await f.api('PUT', { revision: 0, requestId: 'initial', projects: [project] });
    const exported = await (await f.api()).json();
    await f.api('PUT', { revision: 1, requestId: 'other', projects: [{ ...project, notes: 'Changed on this computer' }] });
    const restored = await f.api('PUT', { revision: 2, requestId: 'restore', restore: true, projects: exported.projects });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).projects, [project]);
    assert.ok(readdirSync(join(f.dir, 'backups')).some(file => file.startsWith('before-import-')));
    assert.equal((await f.api('PUT', { revision: 3, requestId: 'bad-restore', restore: true, projects: [{ name: 'missing fields' }] })).status, 400);
    assert.deepEqual((await (await f.api()).json()).projects, [project]);
  } finally { await f.close(); }
});

test('a large supported list exports below the import limit and restores in full', async () => {
  const f = await fixture();
  try {
    const projects = Array.from({ length: 300 }, (_, index) => ({ ...project, id: `large-${index}`, name: `Project ${index}`, notes: 'n'.repeat(1400), links: Array.from({ length: 20 }, () => ({ label: 'Ref', url: 'https://x.co' })) }));
    assert.equal((await f.api('PUT', { revision: 0, requestId: 'large-list', projects })).status, 200);
    const cookie = (await fetch(f.origin)).headers.get('set-cookie').split(';')[0];
    const exported = await (await fetch(`${f.origin}/api/export`, { headers: { Cookie: cookie } })).text();
    assert.ok(Buffer.byteLength(exported) < 1_000_000);
    const restored = await f.api('PUT', { revision: 1, requestId: 'large-restore', restore: true, projects: JSON.parse(exported).projects });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).projects, projects);
  } finally { await f.close(); }
});

test('nested islands survive saves, agent updates, export and restore; legacy backups remain readable', async () => {
  const f = await fixture();
  try {
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }, { id: 'clients', name: 'Client work', parentId: 'work' }], assignments: { 'project-1': 'clients' } };
    const create = await f.api('PUT', { revision: 0, requestId: 'organized', projects: [project], organization });
    assert.equal(create.status, 200);
    assert.deepEqual((await create.json()).organization, organization);
    const agent = f.app.updateProject({ projectId: 'project-1', expectedRevision: 1, requestId: 'agent-organized', currentTask: 'Review the new draft' });
    assert.deepEqual(agent.islandPath, ['Work', 'Client work']);
    assert.deepEqual((await (await f.api()).json()).organization, organization);
    // Older browser/MCP clients omit organization. Their text edits must retain it.
    assert.equal((await f.api('PUT', { revision: 2, requestId: 'legacy-save', projects: [{ ...project, notes: 'More context' }] })).status, 200);
    assert.deepEqual((await (await f.api()).json()).organization, organization);
    const cookie = (await fetch(f.origin)).headers.get('set-cookie').split(';')[0];
    const exported = await (await fetch(`${f.origin}/api/export`, { headers: { Cookie: cookie } })).json();
    assert.equal(exported.schemaVersion, 6);
    assert.deepEqual(exported.organization, organization);
    const invalid = { groups: [{ id: 'work', name: 'Work', parentId: 'work' }], assignments: {} };
    assert.equal((await f.api('PUT', { revision: 3, requestId: 'cycle', projects: [project], organization: invalid })).status, 400);
    assert.equal((await (await f.api()).json()).revision, 3);
    const stale = await f.api('PUT', { revision: 0, requestId: 'stale-islands', projects: [project], organization: { groups: [], assignments: {} } });
    assert.equal(stale.status, 409);
    await f.api('PUT', { revision: 3, requestId: 'old-import', restore: true, projects: [project] });
    assert.deepEqual((await (await f.api()).json()).organization, { groups: [], assignments: {} });
    const restored = await f.api('PUT', { revision: 4, requestId: 'organized-import', restore: true, projects: exported.projects, organization: exported.organization });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).organization, organization);
  } finally { await f.close(); }
});

test('pins survive SQLite restart, preserve nested placement, hide on delete, return on restore, and export compatibly', async () => {
  const f = await fixture();
  try {
    const child = { ...project, id: 'child', name: 'Sub-project' };
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }], assignments: { 'project-1': 'work' }, projectParents: { child: 'project-1' } };
    let response = await f.api('PUT', { revision: 0, requestId: 'pin-setup', projects: [project, child], organization });
    let snapshot = await response.json();
    assert.deepEqual(snapshot.pins, []);
    const pinned = f.app.pinProject({ projectId: 'child', expectedRevision: 1, requestId: 'pin-child' });
    assert.deepEqual(pinned.pins, ['child']);
    assert.deepEqual(pinned.organization, organization);
    assert.equal(pinned.projects.length, 2);
    response = await f.api('PUT', { revision: 2, requestId: 'text-save', projects: [{ ...project, notes: 'Updated while pinned' }, child], organization });
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, ['child']);
    assert.equal(snapshot.projects[0].notes, 'Updated while pinned');
    const exportedResponse = await fetch(`${f.origin}/api/export`, { headers: { Cookie: (await fetch(f.origin)).headers.get('set-cookie').split(';')[0] } });
    const backup = await exportedResponse.json();
    assert.equal(backup.schemaVersion, 6);
    assert.deepEqual(backup.pins, ['child']);

    const deleted = removeProject(snapshot, 'child');
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'delete-pinned', ...deleted });
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, ['child']);
    assert.equal(snapshot.trash[0].project.id, 'child');
    const restored = restoreProject(snapshot, 'child');
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'restore-pinned', ...restored });
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, ['child']);
    assert.equal(snapshot.organization.projectParents.child, 'project-1');

    // Version 3 imports have no pin field; replacement clears pin preferences.
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'legacy-import', restore: true, projects: backup.projects, organization: backup.organization, trash: backup.trash });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, []);
    const expiredTrash = [{ project: child, deletedAt: new Date(Date.now() - 8 * 86400000).toISOString(), parentProjectId: 'project-1', groupId: 'work' }];
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'expire-pinned', projects: [project], organization, trash: expiredTrash, pins: ['child'] });
    assert.equal(response.status, 400);
    assert.deepEqual((await (await f.api()).json()).pins, []);
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'expire-pinned-clean', projects: [project], organization, trash: expiredTrash, pins: [] });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, []);
    // A current export/import keeps pins and nesting, then survives a cold reopen.
    response = await f.api('PUT', { revision: snapshot.revision, requestId: 'v4-import', restore: true, projects: backup.projects, organization: backup.organization, trash: backup.trash, pins: backup.pins });
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.deepEqual(snapshot.pins, ['child']);
    assert.deepEqual(snapshot.organization, organization);
    await f.app.close();
    const restarted = createApp({ dataDir: f.dir });
    assert.deepEqual(restarted.readProjects().pins, ['child']);
    await restarted.close();
  } finally { await f.close(); }
});

test('archive metadata and board positions persist through text edits, pin changes, deletion recovery and backup export', async () => {
  const f = await fixture();
  try {
    const child = { ...project, id: 'child', name: 'Child' };
    const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }, { id: 'side', name: 'Side', parentId: null }], assignments: { 'project-1': 'work' }, projectParents: { child: 'project-1' }, boardPositions: { work: { x: 300, y: 140 }, __unsorted__: { x: -30, y: 40 } } };
    assert.equal((await f.api('PUT', { revision: 0, requestId: 'archive-board-setup', projects: [project, child], organization })).status, 200);
    f.app.pinProject({ projectId: 'child', expectedRevision: 1, requestId: 'archive-pin' });
    f.app.archiveProject({ projectId: 'project-1', expectedRevision: 2, requestId: 'archive-family' });
    let snapshot = f.app.readProjects();
    assert.equal(snapshot.organization.archives['project-1'].batchId, snapshot.organization.archives.child.batchId);
    assert.deepEqual(snapshot.organization.boardPositions, organization.boardPositions);
    f.app.setIslandPosition({ islandId: 'work', x: 345.5, y: 275, expectedRevision: 3, requestId: 'move-work-board' });
    f.app.updateProject({ projectId: 'project-1', expectedRevision: 4, requestId: 'edit-archived-project', notes: 'Agent edit while archived' });
    snapshot = f.app.readProjects();
    assert.ok(snapshot.organization.archives['project-1']);
    assert.deepEqual(snapshot.organization.boardPositions.work, { x: 345.5, y: 275 });
    assert.deepEqual(snapshot.pins, ['child']);
    const deleted = removeProject(snapshot, 'child');
    assert.equal((await f.api('PUT', { revision: snapshot.revision, requestId: 'delete-archived-child', ...deleted })).status, 200);
    snapshot = f.app.readProjects();
    assert.ok(snapshot.organization.archives.child);
    assert.deepEqual(snapshot.pins, ['child']);
    const restored = restoreProject(snapshot, 'child');
    assert.equal((await f.api('PUT', { revision: snapshot.revision, requestId: 'restore-archived-child', ...restored })).status, 200);
    snapshot = f.app.readProjects();
    assert.ok(snapshot.organization.archives.child);
    assert.equal(snapshot.organization.projectParents.child, 'project-1');
    const cookie = (await fetch(f.origin)).headers.get('set-cookie').split(';')[0];
    const backup = await (await fetch(`${f.origin}/api/export`, { headers: { Cookie: cookie } })).json();
    assert.equal(backup.schemaVersion, 6);
    assert.deepEqual(backup.organization.archives, snapshot.organization.archives);
    assert.deepEqual(backup.organization.boardPositions, snapshot.organization.boardPositions);
    await f.app.restoreArchivedProject({ projectId: 'child', expectedRevision: snapshot.revision, requestId: 'restore-archive-family' });
    snapshot = f.app.readProjects();
    assert.deepEqual(snapshot.organization.archives, {});
    assert.deepEqual(snapshot.organization.projectParents.child, 'project-1');
    assert.deepEqual(snapshot.organization.boardPositions, backup.organization.boardPositions);
  } finally { await f.close(); }
});
