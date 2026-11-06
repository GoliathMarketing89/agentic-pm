import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { validateProjects } from '../lib/projects.ts';

const entry = { id: 'project-one', name: 'Example project', currentTask: 'Review draft', notes: 'Context', needsMichael: true, links: [{ label: 'Website', url: 'https://example.com' }] };

test('keeps arbitrary current task text and rejects executable links', () => {
  assert.deepEqual(validateProjects([entry]), [entry]);
  assert.throws(() => validateProjects([{ ...entry, links: [{ label: 'Bad', url: 'javascript:alert(1)' }] }]), /http/i);
  assert.throws(() => validateProjects([{ ...entry, name: ' ' }]), /name/i);
});
