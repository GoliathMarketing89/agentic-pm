import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOrganization } from '../lib/projects.ts';

const projects = [{ id: 'omega' }];
const organization = { groups: [{ id: 'work', name: 'Work', parentId: null }, { id: 'clients', name: 'Client work', parentId: 'work' }], assignments: { omega: 'clients' } };

test('nested islands retain their relationships and project placement', () => {
  assert.deepEqual(validateOrganization(organization, projects), organization);
  assert.deepEqual(validateOrganization(undefined, projects), { groups: [], assignments: {} });
});
test('islands reject cycles, missing parents and invalid project destinations', () => {
  assert.throws(() => validateOrganization({ groups: [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }], assignments: {} }, projects), /cycle/i);
  assert.throws(() => validateOrganization({ groups: [{ id: 'a', name: 'A', parentId: 'missing' }], assignments: {} }, projects), /parent/i);
  assert.throws(() => validateOrganization({ ...organization, assignments: { omega: 'missing' } }, projects), /island/i);
});
