// Pure archive transitions shared by the local app and storage tests.
export function archiveProject(snapshot, id, now = new Date().toISOString(), batchId = `archive-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`) {
  if (!snapshot.projects.some(project => project.id === id)) throw new Error('That project is no longer available. Refresh the list.');
  const organization = structuredClone(snapshot.organization || { groups: [], assignments: {} });
  const archives = { ...(organization.archives || {}) };
  if (archives[id]) throw new Error('That project is already archived.');
  const parents = organization.projectParents || {};
  const subtree = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of Object.entries(parents)) if (subtree.has(parent) && !subtree.has(child)) { subtree.add(child); grew = true; }
  }
  for (const projectId of subtree) if (!archives[projectId]) archives[projectId] = { archivedAt: now, batchId };
  organization.archives = archives;
  return { projects: snapshot.projects, organization, archivedProjectIds: [...subtree].filter(projectId => !snapshot.organization?.archives?.[projectId]) };
}

export function restoreArchivedProject(snapshot, id) {
  const organization = structuredClone(snapshot.organization || { groups: [], assignments: {} });
  const archives = { ...(organization.archives || {}) };
  const entry = archives[id];
  if (!entry) throw new Error('That project is not archived.');
  const restoredProjectIds = [];
  for (const [projectId, metadata] of Object.entries(archives)) if (metadata.batchId === entry.batchId) { delete archives[projectId]; restoredProjectIds.push(projectId); }
  organization.archives = archives;
  return { projects: snapshot.projects, organization, restoredProjectIds };
}
