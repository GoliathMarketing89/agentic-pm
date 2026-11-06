import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentChange } from '../lib/agent-actions.mjs';

const project = (id, name = id) => ({ id, name, currentTask: '', notes: '', needsMichael: false, links: [] });
const base = {
  revision: 3,
  projects: [project('alpha'), project('beta'), project('child'), project('archived')],
  organization: {
    groups: [{ id: 'parent', name: 'Parent', parentId: null }, { id: 'child-island', name: 'Child island', parentId: 'parent' }],
    assignments: { alpha: 'parent', beta: 'parent', archived: 'child-island' },
    projectParents: { child: 'alpha' },
    archives: { archived: { archivedAt: '2026-11-04T00:00:00.000Z', batchId: 'batch-1' } },
    boardPositions: { parent: { x: 1, y: 2 }, 'child-island': { x: 3, y: 4 } },
  },
  pins: ['alpha'],
  trash: [],
  updatedAt: null,
};

test('project updates preserve unrelated fields and validate names, links, and unknown arguments', () => {
  const changed = buildAgentChange(base, 'update-project', { projectId: 'archived', name: 'Archive name', links: [{ label: 'Docs', url: 'https://example.com/docs' }] });
  assert.equal(changed.projects[3].name, 'Archive name');
  assert.deepEqual(changed.projects[3].links, [{ label: 'Docs', url: 'https://example.com/docs' }]);
  assert.deepEqual(changed.organization, base.organization);
  assert.deepEqual(changed.pins, base.pins);
  assert.throws(() => buildAgentChange(base, 'update-project', { projectId: 'alpha', name: '   ' }), /project name is required/);
  assert.throws(() => buildAgentChange(base, 'update-project', { projectId: 'alpha', links: [{ label: 'bad', url: 'javascript:alert(1)' }] }), /http\/https/);
  assert.throws(() => buildAgentChange(base, 'update-project', { projectId: 'alpha', projects: [] }), /Unknown action field/);
});

test('project creation supports direct island or parent placement and enforces nesting limits', () => {
  const child = buildAgentChange(base, 'create-project', { id: 'new', name: 'New', parentProjectId: 'alpha' });
  assert.equal(child.organization.projectParents.new, 'alpha');
  assert.equal(child.organization.assignments.new, undefined);
  const grouped = buildAgentChange(base, 'create-project', { id: 'new', name: 'New', groupId: 'parent' });
  assert.equal(grouped.organization.assignments.new, 'parent');
  assert.throws(() => buildAgentChange(base, 'create-project', { id: 'new', name: 'New', parentProjectId: 'alpha', groupId: 'parent' }), /either parentProjectId or groupId/);
  assert.throws(() => buildAgentChange(base, 'create-project', { id: 'new', name: 'New', parentProjectId: 'missing' }), /existing parent/);
});

test('reordering is limited to the complete sibling list in the requested scope', () => {
  const reordered = buildAgentChange(base, 'reorder-project', { scope: 'active', groupId: 'parent', orderedIds: ['beta', 'alpha'] });
  assert.deepEqual(reordered.projects.map(item => item.id), ['beta', 'alpha', 'child', 'archived']);
  const archive = buildAgentChange(base, 'reorder-project', { scope: 'archive', groupId: 'child-island', orderedIds: ['archived'] });
  assert.deepEqual(archive.projects.map(item => item.id), base.projects.map(item => item.id));
  assert.throws(() => buildAgentChange(base, 'reorder-project', { scope: 'active', groupId: 'parent', orderedIds: ['alpha'] }), /exact siblings/);
  assert.throws(() => buildAgentChange(base, 'reorder-project', { scope: 'active', groupId: 'parent', orderedIds: ['alpha', 'alpha'] }), /not be repeated/);
});

test('island actions validate parents and remove an island by promoting its direct content', () => {
  const made = buildAgentChange(base, 'create-island', { id: 'new-island', name: 'New island', parentId: 'parent' });
  assert.equal(made.organization.groups.at(-1).parentId, 'parent');
  const renamed = buildAgentChange(base, 'update-island', { islandId: 'child-island', name: 'Renamed' });
  assert.equal(renamed.organization.groups[1].name, 'Renamed');
  assert.throws(() => buildAgentChange(base, 'update-island', { islandId: 'parent', parentId: 'child-island' }), /cycle/);
  const removed = buildAgentChange(base, 'remove-island', { islandId: 'child-island' });
  assert.equal(removed.organization.groups.some(item => item.id === 'child-island'), false);
  assert.equal(removed.organization.assignments.archived, 'parent');
  assert.equal(removed.organization.boardPositions['child-island'], undefined);
  assert.deepEqual(removed.organization.boardPositions.parent, { x: 1, y: 2 });
  assert.deepEqual(removed.projects, base.projects);
  assert.deepEqual(removed.pins, base.pins);
});
