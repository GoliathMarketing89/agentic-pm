// Shared by pointer interactions and the behavior tests; changes organization only.
export function moveOrganization(snapshot, item, destination = null) {
  const organization = structuredClone(snapshot.organization || { groups: [], assignments: {} });
  const groups = new Map(organization.groups.map(group => [group.id, group]));
  const projectDestination = destination && typeof destination === 'object' && destination.kind === 'project' ? destination.id : null;
  if (destination !== null && !projectDestination && !groups.has(destination)) throw new Error('That island is no longer available. Refresh the list.');
  if (item.kind === 'project') {
    if (!snapshot.projects.some(project => project.id === item.id)) throw new Error('That project is no longer available. Refresh the list.');
    const previous = Object.hasOwn(organization.assignments, item.id) ? organization.assignments[item.id] : null;
    const parents = organization.projectParents || {};
    if (projectDestination) {
      if (!snapshot.projects.some(project => project.id === projectDestination)) throw new Error('That parent project is no longer available.');
      if (parents[item.id] === projectDestination) throw new Error('This project is already inside that project.');
      organization.projectParents = { ...parents, [item.id]: projectDestination };
      delete organization.assignments[item.id];
    } else {
      if (!Object.hasOwn(parents, item.id) && previous === destination) throw new Error('This project is already in that island.');
      if (organization.projectParents) delete organization.projectParents[item.id];
      if (destination === null) delete organization.assignments[item.id];
      else organization.assignments = { ...organization.assignments, [item.id]: destination };
    }
    for (const project of snapshot.projects) {
      let id = project.id;
      const visited = new Set();
      while (id !== undefined) {
        if (visited.has(id)) throw new Error('A project cannot go inside itself or its descendants.');
        visited.add(id);
        if (visited.size > 8) throw new Error('Projects can be nested up to eight levels deep.');
        id = organization.projectParents?.[id];
      }
    }
  } else if (item.kind === 'island') {
    if (projectDestination) throw new Error('Islands cannot go inside projects.');
    const moving = groups.get(item.id);
    if (!moving) throw new Error('That island is no longer available. Refresh the list.');
    let parent = destination;
    const visited = new Set();
    while (parent !== null) {
      if (parent === item.id) throw new Error('An island cannot go inside itself or its children.');
      if (visited.has(parent) || !groups.has(parent)) throw new Error('This island structure needs to be refreshed.');
      visited.add(parent);
      parent = groups.get(parent).parentId;
    }
    if (moving.parentId === destination) throw new Error('This island is already in that location.');
    moving.parentId = destination;
    for (const group of organization.groups) {
      let current = group;
      let depth = 1;
      while (current.parentId !== null) {
        depth++;
        if (depth > 8) throw new Error('Islands can be nested up to eight levels deep.');
        current = groups.get(current.parentId);
        if (!current) throw new Error('This island structure needs to be refreshed.');
      }
    }
  } else throw new Error('Drag a project or an island from this list.');
  return organization;
}

export function removeProject(snapshot, id) {
  if (!snapshot.projects.some(project => project.id === id)) throw new Error('That project is no longer available. Refresh the list.');
  const organization = structuredClone(snapshot.organization);
  const parents = organization.projectParents || {};
  const parent = parents[id];
  const group = organization.assignments[id];
  for (const [child, owner] of Object.entries(parents)) if (owner === id) {
    if (parent) parents[child] = parent;
    else {
      delete parents[child];
      if (group) organization.assignments[child] = group;
      else delete organization.assignments[child];
    }
  }
  delete parents[id];
  delete organization.assignments[id];
  let root = id;
  for (let depth = 0; depth < 8 && snapshot.organization.projectParents?.[root]; depth++) root = snapshot.organization.projectParents[root];
  const groupId = snapshot.organization.assignments[root];
  const entry = { project: snapshot.projects.find(project => project.id === id), deletedAt: new Date().toISOString(), ...(parent ? { parentProjectId: parent } : {}), ...(groupId ? { groupId } : {}) };
  return { projects: snapshot.projects.filter(project => project.id !== id), organization, trash: [...(snapshot.trash || []), entry] };
}

export function restoreProject(snapshot, id) {
  const entry = snapshot.trash?.find(entry => entry.project.id === id);
  if (!entry || Date.parse(entry.deletedAt) <= Date.now() - 7 * 86400000) throw new Error('This project is no longer available to restore.');
  if (snapshot.projects.some(project => project.id === id)) throw new Error('This project is already active. Refresh the list.');
  const organization = structuredClone(snapshot.organization);
  if (entry.parentProjectId && snapshot.projects.some(project => project.id === entry.parentProjectId)) {
    organization.projectParents = { ...organization.projectParents, [id]: entry.parentProjectId };
  } else if (entry.groupId && organization.groups.some(group => group.id === entry.groupId)) organization.assignments[id] = entry.groupId;
  return { projects: [...snapshot.projects, entry.project], organization, trash: snapshot.trash.filter(entry => entry.project.id !== id) };
}
