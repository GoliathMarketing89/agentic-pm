import { InputError, validateOrganization, validateProjects } from './projects.ts';

export const AGENT_ACTION_KINDS = Object.freeze(['update-project', 'create-project', 'reorder-project', 'create-island', 'update-island', 'remove-island']);
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
function only(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new InputError('Action arguments must be an object.');
  const unknown = Object.keys(args).find(key => !allowed.includes(key));
  if (unknown) throw new InputError(`Unknown action field: ${unknown}.`);
}
function exactId(value, label) { if (typeof value !== 'string' || !idPattern.test(value)) throw new InputError(`Use an exact ${label} id.`); }
function checked(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.projects)) throw new InputError('A project snapshot is required.');
  const projects = validateProjects(snapshot.projects);
  const trash = snapshot.trash ?? [];
  if (!Array.isArray(trash)) throw new InputError('Invalid deleted project list.');
  const retainedIds = trash.map(entry => entry?.project?.id).filter(id => typeof id === 'string');
  const organization = validateOrganization(snapshot.organization ?? { groups: [], assignments: {} }, projects, retainedIds);
  const pins = snapshot.pins ?? [];
  if (!Array.isArray(pins)) throw new InputError('Invalid pinned project list.');
  return { projects, organization, trash: structuredClone(trash), pins: [...pins] };
}
function finish(next) {
  next.projects = validateProjects(next.projects);
  next.organization = validateOrganization(next.organization, next.projects, next.trash.map(entry => entry.project.id));
  return next;
}
function parentOf(organization, id) { return organization.projectParents?.[id] ?? null; }
function rootOf(organization, id) { const parents = organization.projectParents || {}; for (let depth = 0; depth < 8 && parents[id]; depth++) id = parents[id]; return id; }
function islandOf(organization, id) { return organization.assignments?.[rootOf(organization, id)] ?? null; }

/** Apply one validated semantic connector action without mutating the input snapshot. */
export function buildAgentChange(snapshot, kind, args) {
  if (!AGENT_ACTION_KINDS.includes(kind)) throw new InputError('Unknown agent action.');
  const next = checked(snapshot);
  const { projects, organization, trash } = next;
  if (kind === 'update-project') {
    only(args, ['projectId', 'name', 'currentTask', 'notes', 'needsMichael', 'links']); exactId(args.projectId, 'project');
    const fields = ['name', 'currentTask', 'notes', 'needsMichael', 'links'].filter(key => Object.hasOwn(args, key));
    if (!fields.length) throw new InputError('Provide at least one project field to update.');
    const index = projects.findIndex(project => project.id === args.projectId);
    if (index < 0) throw new InputError('Project not found. Read the list and use an exact project id.');
    next.projects[index] = { ...projects[index], ...Object.fromEntries(fields.map(key => [key, args[key]])) };
    return finish(next);
  }
  if (kind === 'create-project') {
    only(args, ['id', 'name', 'currentTask', 'notes', 'needsMichael', 'links', 'parentProjectId', 'groupId']); exactId(args.id, 'new project');
    if (projects.some(project => project.id === args.id) || trash.some(entry => entry.project.id === args.id)) throw new InputError('That project id is already in use.');
    if (Object.hasOwn(args, 'parentProjectId') && Object.hasOwn(args, 'groupId')) throw new InputError('Choose either parentProjectId or groupId.');
    const project = { id: args.id, name: args.name, currentTask: args.currentTask ?? '', notes: args.notes ?? '', needsMichael: args.needsMichael ?? false, links: args.links ?? [] };
    next.projects.push(project);
    if (args.parentProjectId !== undefined) {
      exactId(args.parentProjectId, 'parent project');
      if (!projects.some(item => item.id === args.parentProjectId)) throw new InputError('Use an existing parent project id.');
      next.organization.projectParents = { ...(organization.projectParents || {}), [args.id]: args.parentProjectId }; delete next.organization.assignments[args.id];
    } else if (args.groupId !== undefined) {
      exactId(args.groupId, 'island'); if (!organization.groups.some(group => group.id === args.groupId)) throw new InputError('Use an existing island id.'); next.organization.assignments[args.id] = args.groupId;
    }
    return finish(next);
  }
  if (kind === 'reorder-project') {
    only(args, ['scope', 'orderedIds', 'parentProjectId', 'groupId']);
    const scope = args.scope ?? 'active';
    if (!['active', 'archive', 'deleted'].includes(scope)) throw new InputError('Choose active, archive, or deleted ordering scope.');
    if (Object.hasOwn(args, 'parentProjectId') && Object.hasOwn(args, 'groupId')) throw new InputError('Choose either parentProjectId or groupId.');
    if (args.parentProjectId !== undefined) exactId(args.parentProjectId, 'parent project'); if (args.groupId !== undefined) exactId(args.groupId, 'island');
    if (!Array.isArray(args.orderedIds) || args.orderedIds.length > 300) throw new InputError('Provide the exact sibling ids in their new order.');
    args.orderedIds.forEach(id => exactId(id, 'project')); if (new Set(args.orderedIds).size !== args.orderedIds.length) throw new InputError('Project ids must not be repeated.');
    if (scope === 'deleted') {
      const entries = trash.filter(entry => (entry.parentProjectId ?? null) === (args.parentProjectId ?? null) && (entry.groupId ?? null) === (args.groupId ?? null));
      const ids = entries.map(entry => entry.project.id);
      if (ids.length !== args.orderedIds.length || ids.some(id => !args.orderedIds.includes(id))) throw new InputError('Reorder only the exact deleted siblings in the selected location.');
      const byId = new Map(entries.map(entry => [entry.project.id, entry])); const selected = new Set(ids); let cursor = 0;
      next.trash = trash.map(entry => selected.has(entry.project.id) ? byId.get(args.orderedIds[cursor++]) : entry); return finish(next);
    }
    const candidates = projects.filter(project => {
      const archived = Boolean(organization.archives?.[project.id]); if ((scope === 'archive') !== archived) return false;
      if (parentOf(organization, project.id) !== (args.parentProjectId ?? null)) return false;
      return args.parentProjectId !== undefined || islandOf(organization, project.id) === (args.groupId ?? null);
    });
    const ids = candidates.map(project => project.id);
    if (ids.length !== args.orderedIds.length || ids.some(id => !args.orderedIds.includes(id))) throw new InputError('Reorder only the exact siblings in the selected location and scope.');
    const byId = new Map(projects.map(project => [project.id, project])); const selected = new Set(ids); let cursor = 0;
    next.projects = projects.map(project => selected.has(project.id) ? byId.get(args.orderedIds[cursor++]) : project); return finish(next);
  }
  if (kind === 'create-island') {
    only(args, ['id', 'name', 'parentId']); exactId(args.id, 'new island');
    if (organization.groups.some(group => group.id === args.id)) throw new InputError('That island id is already in use.');
    if (args.parentId !== undefined && args.parentId !== null) exactId(args.parentId, 'parent island');
    next.organization.groups.push({ id: args.id, name: args.name, parentId: args.parentId ?? null }); return finish(next);
  }
  if (kind === 'update-island') {
    only(args, ['islandId', 'name', 'parentId']); exactId(args.islandId, 'island');
    const group = organization.groups.find(item => item.id === args.islandId); if (!group) throw new InputError('Island not found. Read the list and use an exact island id.');
    if (!Object.hasOwn(args, 'name') && !Object.hasOwn(args, 'parentId')) throw new InputError('Provide an island name or parentId to update.');
    if (args.parentId !== undefined && args.parentId !== null) exactId(args.parentId, 'parent island');
    next.organization.groups = organization.groups.map(item => item.id === args.islandId ? { ...item, ...(Object.hasOwn(args, 'name') ? { name: args.name } : {}), ...(Object.hasOwn(args, 'parentId') ? { parentId: args.parentId } : {}) } : item); return finish(next);
  }
  only(args, ['islandId']); exactId(args.islandId, 'island');
  const removed = organization.groups.find(item => item.id === args.islandId); if (!removed) throw new InputError('Island not found. Read the list and use an exact island id.');
  const parentId = removed.parentId;
  next.organization.groups = organization.groups.filter(item => item.id !== args.islandId).map(item => item.parentId === args.islandId ? { ...item, parentId } : item);
  const assignments = { ...organization.assignments };
  for (const [id, groupId] of Object.entries(assignments)) if (groupId === args.islandId) { if (parentId) assignments[id] = parentId; else delete assignments[id]; }
  next.organization.assignments = assignments;
  if (organization.boardPositions) { next.organization.boardPositions = { ...organization.boardPositions }; delete next.organization.boardPositions[args.islandId]; }
  return finish(next);
}
