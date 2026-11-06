import test from 'node:test';
import assert from 'node:assert/strict';
import { moveOrganization, removeProject } from '../public/moves.mjs';
import { validateOrganization, islandPath } from '../lib/projects.ts';
import { archiveProject, restoreArchivedProject } from '../public/archive-state.mjs';

const snapshot = { projects: [{ id: 'website', name: 'Website', currentTask: 'Review', notes: 'Keep context', needsMichael: true, links: [] }], organization: { groups: [{ id: 'work', name: 'Work', parentId: null }, { id: 'clients', name: 'Clients', parentId: 'work' }, { id: 'side', name: 'Side projects', parentId: null }], assignments: { website: 'clients' } } };

test('moving a project between islands preserves its fields and the source snapshot', () => {
  const moved = moveOrganization(snapshot, { kind: 'project', id: 'website' }, 'side');
  assert.equal(moved.assignments.website, 'side');
  assert.equal(snapshot.organization.assignments.website, 'clients');
  assert.equal(snapshot.projects[0].notes, 'Keep context');
  assert.deepEqual(moved.groups, snapshot.organization.groups);
  assert.deepEqual(moveOrganization({ ...snapshot, organization: moved }, { kind: 'project', id: 'website' }, null).assignments, {});
});

const family = { projects: ['parent', 'child', 'grandchild', 'other'].map(id => ({ ...snapshot.projects[0], id, name: id })), organization: { ...snapshot.organization, assignments: { parent: 'clients', other: 'side' }, projectParents: { child: 'parent', grandchild: 'child' } } };

test('project nesting moves the whole subtree, inherits islands and prevents cycles', () => {
  const nested = moveOrganization(family, { kind: 'project', id: 'parent' }, { kind: 'project', id: 'other' });
  assert.equal(nested.projectParents.parent, 'other');
  assert.equal(nested.projectParents.grandchild, 'child');
  assert.deepEqual(islandPath(nested, 'grandchild'), ['Side projects']);
  assert.throws(() => moveOrganization(family, { kind: 'project', id: 'parent' }, { kind: 'project', id: 'grandchild' }), /descendants/);
  assert.throws(() => moveOrganization(family, { kind: 'project', id: 'parent' }, { kind: 'project', id: 'parent' }), /itself/);
  assert.throws(() => moveOrganization(family, { kind: 'island', id: 'work' }, { kind: 'project', id: 'parent' }), /Islands/);
  const detached = moveOrganization(family, { kind: 'project', id: 'child' }, 'side');
  assert.equal(detached.projectParents.child, undefined);
  assert.equal(detached.projectParents.grandchild, 'child');
  assert.deepEqual(islandPath(detached, 'grandchild'), ['Side projects']);
  assert.deepEqual(validateOrganization(nested, family.projects), nested);
  assert.throws(() => validateOrganization({ ...nested, projectParents: { parent: 'child', child: 'parent' } }, family.projects), /descendants/);
  assert.throws(() => validateOrganization({ ...nested, projectParents: { parent: 'missing' } }, family.projects), /does not exist/);
  const deep = { projects: Array.from({length: 9}, (_, i) => ({ id: `p${i}` })), organization: { groups: [], assignments: {}, projectParents: Object.fromEntries(Array.from({length: 7}, (_, i) => [`p${i+1}`, `p${i}`])) } };
  assert.throws(() => moveOrganization(deep, {kind:'project', id:'p8'}, {kind:'project', id:'p7'}), /eight/);
  assert.throws(() => validateOrganization({ ...deep.organization, projectParents: {...deep.organization.projectParents, p8:'p7'} }, deep.projects), /eight/);
});

test('deleting a parent keeps children and promotes them without losing their placement', () => {
  const deletedRoot = removeProject(family, 'parent');
  assert.equal(deletedRoot.projects.length, 3);
  assert.equal(deletedRoot.organization.assignments.child, 'clients');
  assert.equal(deletedRoot.organization.projectParents.child, undefined);
  assert.equal(deletedRoot.organization.projectParents.grandchild, 'child');
  const deletedChild = removeProject(family, 'child');
  assert.equal(deletedChild.organization.projectParents.grandchild, 'parent');
  assert.deepEqual(deletedChild.projects.find(project => project.id === 'grandchild'), family.projects[2]);
  assert.equal(family.organization.projectParents.child, 'parent');
  assert.deepEqual(validateOrganization(deletedRoot.organization, deletedRoot.projects), deletedRoot.organization);
});
test('moving an island carries its projects and nested structure intact', () => {
  const moved = moveOrganization(snapshot, { kind: 'island', id: 'work' }, 'side');
  assert.equal(moved.groups.find(group => group.id === 'work').parentId, 'side');
  assert.equal(moved.groups.find(group => group.id === 'clients').parentId, 'work');
  assert.equal(moved.assignments.website, 'clients');
  const root = moveOrganization({ ...snapshot, organization: moved }, { kind: 'island', id: 'work' }, null);
  assert.equal(root.groups.find(group => group.id === 'work').parentId, null);
});
test('invalid drops cannot create cycles, missing references or excessive nesting', () => {
  assert.throws(() => moveOrganization(snapshot, { kind: 'island', id: 'work' }, 'work'), /itself|inside/i);
  assert.throws(() => moveOrganization(snapshot, { kind: 'island', id: 'work' }, 'clients'), /children|descendant|itself/i);
  assert.throws(() => moveOrganization(snapshot, { kind: 'project', id: 'missing' }, 'side'), /project/i);
  assert.throws(() => moveOrganization(snapshot, { kind: 'project', id: 'website' }, 'missing'), /island/i);
  const deep = { projects: [], organization: { groups: Array.from({ length: 8 }, (_, i) => ({ id: `level-${i}`, name: `Level ${i}`, parentId: i ? `level-${i-1}` : null })).concat({ id: 'extra', name: 'Extra', parentId: null }), assignments: {} } };
  assert.throws(() => moveOrganization(deep, { kind: 'island', id: 'extra' }, 'level-7'), /eight/i);
});

test('archive batches active descendants, preserves independent archives and restores only the selected batch', () => {
  const before = { ...family, organization: { ...family.organization, archives: { grandchild: { archivedAt: '2026-11-01T00:00:00.000Z', batchId: 'old-batch' } }, boardPositions: { clients: { x: 120, y: 240 } } } };
  const archived = archiveProject(before, 'parent', '2026-11-05T00:00:00.000Z', 'new-batch');
  assert.deepEqual(archived.archivedProjectIds.sort(), ['child', 'parent']);
  assert.equal(archived.organization.archives.parent.batchId, 'new-batch');
  assert.equal(archived.organization.archives.child.batchId, 'new-batch');
  assert.equal(archived.organization.archives.grandchild.batchId, 'old-batch');
  assert.deepEqual(archived.organization.boardPositions, before.organization.boardPositions);
  const restored = restoreArchivedProject({ ...before, organization: archived.organization }, 'child');
  assert.deepEqual(restored.restoredProjectIds, ['parent', 'child']);
  assert.deepEqual(restored.organization.archives, { grandchild: before.organization.archives.grandchild });
  assert.deepEqual(before.organization.archives, { grandchild: { archivedAt: '2026-11-01T00:00:00.000Z', batchId: 'old-batch' } });
  assert.throws(() => archiveProject(archived, 'parent'), /already archived/);
  assert.throws(() => restoreArchivedProject(restored, 'parent'), /not archived/);
});

test('organization validates board coordinates and archive metadata without losing known groups', () => {
  const org = { ...snapshot.organization, boardPositions: { work: { x: -1_000_000, y: 42 }, __unsorted__: { x: 2, y: 3 }, unknown: { x: 4, y: 5 } }, archives: { website: { archivedAt: '2026-11-05T00:00:00.000Z', batchId: 'batch-1' }, deleted: { archivedAt: '2026-11-05T00:00:00.000Z', batchId: 'batch-2' } } };
  const validated = validateOrganization(org, snapshot.projects, ['deleted']);
  assert.deepEqual(validated.boardPositions, { work: { x: -1_000_000, y: 42 }, __unsorted__: { x: 2, y: 3 } });
  assert.deepEqual(validated.archives, { website: org.archives.website, deleted: org.archives.deleted });
  for (const point of [{ x: Infinity, y: 0 }, { x: 1_000_001, y: 0 }, { x: 0, y: NaN }]) assert.throws(() => validateOrganization({ ...org, boardPositions: { work: point } }, snapshot.projects), /finite coordinates/);
});
