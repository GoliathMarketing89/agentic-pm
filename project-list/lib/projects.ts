export type Project = {
  id: string;
  name: string;
  currentTask: string;
  notes: string;
  needsMichael: boolean;
  links: { label: string; url: string }[];
};

export type Organization = { groups: { id: string; name: string; parentId: string | null }[]; assignments: Record<string, string>; projectParents?: Record<string, string>; archives?: Record<string, { archivedAt: string; batchId: string }>; boardPositions?: Record<string, { x: number; y: number }> };
export type DeletedProject = { project: Project; deletedAt: string; parentProjectId?: string; groupId?: string };
export type Snapshot = { revision: number; projects: Project[]; organization: Organization; trash?: DeletedProject[]; updatedAt: string | null };

export class InputError extends Error {}
export class ConflictError extends Error {}

export function validateOrganization(value: unknown, projects: { id: string }[], retainedProjectIds: string[] = []): Organization {
  if (value === undefined) return { groups: [], assignments: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid island organization.');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.groups) || raw.groups.length > 100) throw new InputError('Use up to 100 islands.');
  const ids = new Set<string>();
  const groups = raw.groups.map(group => {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(group.id) || ids.has(group.id)) throw new InputError('Island ids must be unique.');
    ids.add(group.id);
    if (typeof group.name !== 'string' || !group.name.trim() || group.name.length > 100) throw new InputError('An island name is required, up to 100 characters.');
    if (group.parentId !== null && typeof group.parentId !== 'string') throw new InputError('Invalid island parent.');
    return { id: group.id, name: group.name.trim(), parentId: group.parentId };
  });
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) {
    const visited = new Set<string>([group.id]);
    let parent = group.parentId;
    while (parent !== null) {
      if (visited.has(parent)) throw new InputError('Islands cannot form a cycle.');
      if (!byId.has(parent)) throw new InputError('An island parent does not exist.');
      visited.add(parent);
      if (visited.size > 8) throw new InputError('Use up to eight levels of nested islands.');
      parent = byId.get(parent)!.parentId;
    }
  }
  if (!raw.assignments || typeof raw.assignments !== 'object' || Array.isArray(raw.assignments)) throw new InputError('Invalid project island assignments.');
  const projectIds = new Set(projects.map(project => project.id));
  const entries = Object.entries(raw.assignments).filter(([id]) => projectIds.has(id));
  for (const [, groupId] of entries) if (typeof groupId !== 'string' || !byId.has(groupId)) throw new InputError('A project points to an island that does not exist.');
  const result = { groups, assignments: Object.fromEntries(entries) } as Organization;
  const knownProjectIds = new Set([...projectIds, ...retainedProjectIds]);
  if (raw.archives !== undefined) {
    if (!raw.archives || typeof raw.archives !== 'object' || Array.isArray(raw.archives)) throw new InputError('Invalid archived project metadata.');
    const archives: Organization['archives'] = {};
    for (const [id, metadata] of Object.entries(raw.archives)) {
      if (!knownProjectIds.has(id)) continue;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.archivedAt !== 'string' || !Number.isFinite(Date.parse(metadata.archivedAt)) || typeof metadata.batchId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(metadata.batchId)) throw new InputError('Invalid archived project metadata.');
      archives[id] = { archivedAt: metadata.archivedAt, batchId: metadata.batchId };
    }
    result.archives = archives;
  }
  if (raw.boardPositions !== undefined) {
    if (!raw.boardPositions || typeof raw.boardPositions !== 'object' || Array.isArray(raw.boardPositions)) throw new InputError('Invalid board positions.');
    const positions: NonNullable<Organization['boardPositions']> = {};
    for (const [id, point] of Object.entries(raw.boardPositions)) {
      if (id !== '__unsorted__' && !ids.has(id)) continue;
      if (!point || typeof point !== 'object' || Array.isArray(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) throw new InputError('Board positions must contain finite coordinates within ±1,000,000.');
      positions[id] = { x: point.x, y: point.y };
    }
    result.boardPositions = positions;
  }
  if (raw.projectParents !== undefined) {
    if (!raw.projectParents || typeof raw.projectParents !== 'object' || Array.isArray(raw.projectParents)) throw new InputError('Invalid sub-project relationships.');
    const parents = Object.fromEntries(Object.entries(raw.projectParents).filter(([id]) => projectIds.has(id)));
    for (const [id, parentId] of Object.entries(parents)) {
      if (typeof parentId !== 'string' || !projectIds.has(parentId)) throw new InputError('A parent project does not exist.');
      const visited = new Set([id]);
      let parent: string | undefined = parentId;
      while (parent !== undefined) {
        if (visited.has(parent)) throw new InputError('Projects cannot go inside themselves or their descendants.');
        visited.add(parent);
        if (visited.size > 8) throw new InputError('Use up to eight levels of sub-projects.');
        parent = Object.hasOwn(parents, parent) ? parents[parent] as string : undefined;
      }
      // Children inherit placement from their top-level project.
      delete result.assignments[id];
    }
    result.projectParents = parents as Record<string, string>;
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 100_000) throw new InputError('Island organization is too large.');
  return result;
}

export function islandPath(organization: Organization, projectId: string): string[] {
  const groups = new Map(organization.groups.map(group => [group.id, group]));
  for (let depth = 0; depth < 8 && Object.hasOwn(organization.projectParents || {}, projectId); depth++) projectId = organization.projectParents![projectId];
  let id = Object.hasOwn(organization.assignments, projectId) ? organization.assignments[projectId] : null;
  const names: string[] = [];
  while (id && groups.has(id) && names.length < 8) { const group = groups.get(id)!; names.unshift(group.name); id = group.parentId; }
  return names;
}

export function validateProjects(value: unknown): Project[] {
  if (!Array.isArray(value) || value.length > 300) throw new InputError('Keep the list to 300 projects or fewer.');
  const ids = new Set<string>();
  function text(value: unknown, limit: number, label: string) {
    if (typeof value !== 'string' || value.length > limit) throw new InputError(`${label} must be text, up to ${limit} characters.`);
    return value;
  }
  const projects = value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new InputError('Invalid project.');
    const id = text(raw.id, 100, 'Project id');
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new InputError('Project ids must be unique.');
    ids.add(id);
    const name = text(raw.name, 160, 'Project name').trim();
    if (!name) throw new InputError('A project name is required.');
    if (typeof raw.needsMichael !== 'boolean') throw new InputError('Invalid Needs you flag.');
    if (!Array.isArray(raw.links) || raw.links.length > 20) throw new InputError('Use up to 20 important links.');
    const links = raw.links.map((link: unknown) => {
      if (!link || typeof link !== 'object') throw new InputError('Invalid link.');
      const record = link as Record<string, unknown>;
      const label = text(record.label, 160, 'Link label').trim();
      const url = text(record.url, 2048, 'Link URL').trim();
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new InputError('Links need a full https:// or http:// address.'); }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new InputError('Links need http/https addresses without credentials.');
      return { label, url };
    });
    return { id, name, currentTask: text(raw.currentTask, 2000, 'Current task'), notes: text(raw.notes, 10000, 'Notes'), needsMichael: raw.needsMichael, links };
  });
  if (new TextEncoder().encode(JSON.stringify(projects)).length > 800_000) throw new InputError('The list is too large. Shorten notes before saving.');
  return projects;
}
