'use strict';
import { moveOrganization, removeProject, restoreProject } from './moves.mjs';
import { archiveProject, restoreArchivedProject } from './archive-state.mjs';
import { createBoardView } from './board-view.mjs';
import { createViewPreferences } from './view-preferences.mjs';
const $ = id => document.getElementById(id);
let state = { revision: 0, projects: [], organization: { groups: [], assignments: {} }, pins: [], updatedAt: null };
let ready = false;
let saving = false;
let undoing = false;
let historySequence = 0;
let historyProjectId = null;
let historyCursor = null;
const preferences = createViewPreferences();
let activeScope = preferences.read().activeScope;
let filterNeeds = preferences.read().filterNeeds;
let suppressFilterExpansion = preferences.read().suppressFilterExpansion;
let board;
let restoreInitialScroll = true;
const revealedGroups = new Set();
const revealedProjects = new Set();
let layoutSaveScheduled = false;
let pendingArchive = null;
let editorId = null;
let editRevision = 0;
let initialDraft = '';
let latestConflict = null;
let pendingSave = null;
let loadSequence = 0;
let islandEditorId = null;
let islandWasExisting = false;
let islandEditRevision = 0;
let initialIslandDraft = '';
let islandConflict = null;
let dragging = null;
let dragHoverTimer = null;
let dragHoverTarget = null;
let collapsedIslands = new Set(preferences.read().collapsedIslands);
const collapsedProjects = new Set(preferences.read().collapsedProjects);
const inlineDrafts = new Map();
let openActionMenu = null;

function closeActionMenu({ restore = true } = {}) {
  if (!openActionMenu) return;
  const { popover, trigger } = openActionMenu;
  openActionMenu = null;
  if (typeof popover.hidePopover === 'function') { try { popover.hidePopover(); } catch { } }
  popover.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (restore && trigger.isConnected) trigger.focus();
}

function placeActionMenu(popover, trigger) {
  if (!popover.isConnected || !trigger.isConnected) return;
  const rect = trigger.getBoundingClientRect();
  const width = popover.offsetWidth || 220, height = popover.offsetHeight || 120;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  const top = rect.bottom + height + 8 <= window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
  popover.style.left = `${left}px`; popover.style.top = `${top}px`;
}

function attachActionMenu(trigger, label, entries) {
  trigger.type = 'button';
  trigger.classList.add('more-trigger');
  trigger.textContent = 'More';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-expanded', 'false');
  // Keep focus in an active inline field when a mouse opens More. The existing
  // delayed blur commit can otherwise repaint the card underneath the popover.
  trigger.addEventListener('pointerdown', event => event.preventDefault());
  trigger.addEventListener('click', event => {
    event.preventDefault(); event.stopPropagation();
    if (openActionMenu?.trigger === trigger) { closeActionMenu(); return; }
    closeActionMenu({ restore: false });
    const popover = element('div', 'action-popover');
    popover.setAttribute('popover', 'manual');
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', label);
    for (const entry of entries) {
      const button = element('button', entry.className || '', entry.label);
      button.type = 'button'; button.disabled = !!entry.disabled;
      button.addEventListener('click', async () => {
        closeActionMenu({ restore: false });
        if (entry.ownerProjectId) {
          const draftKey = [...inlineDrafts.keys()].find(key => key.startsWith(`${entry.ownerProjectId}:`));
          if (draftKey) await saveInlineDraft(draftKey);
        }
        entry.action();
      });
      popover.append(button);
    }
    document.body.append(popover);
    openActionMenu = { popover, trigger };
    trigger.setAttribute('aria-expanded', 'true');
    if (typeof popover.showPopover === 'function') popover.showPopover();
    else { popover.classList.add('action-popover-fallback'); popover.style.position = 'fixed'; popover.style.zIndex = '2147483647'; }
    placeActionMenu(popover, trigger);
    if (event.detail === 0) popover.querySelector('button:not(:disabled)')?.focus();
  });
}

document.addEventListener('pointerdown', event => {
  if (openActionMenu && !openActionMenu.popover.contains(event.target) && event.target !== openActionMenu.trigger) closeActionMenu({ restore: false });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openActionMenu) { event.preventDefault(); event.stopPropagation(); closeActionMenu(); }
});
window.addEventListener('resize', () => { if (openActionMenu) placeActionMenu(openActionMenu.popover, openActionMenu.trigger); });
window.addEventListener('scroll', event => {
  if (openActionMenu && !openActionMenu.popover.contains(event.target)) closeActionMenu({ restore: false });
}, true);
document.addEventListener('wheel', event => {
  if (openActionMenu && event.target.closest?.('#board-viewport') && !openActionMenu.popover.contains(event.target)) closeActionMenu({ restore: false });
}, true);

function organization() { return state.organization || { groups: [], assignments: {} }; }
function isArchived(project) { return !!organization().archives?.[typeof project === 'string' ? project : project.id]; }
function inScope(project) { return !!project && isArchived(project) === (activeScope === 'archive'); }
function scopedRoot(project) { return !inScope(state.projects.find(parent => parent.id === parentOf(project))); }
function persistView() { preferences.update({activeScope, search: $('search').value, filterNeeds, suppressFilterExpansion, collapsedIslands: [...collapsedIslands], collapsedProjects: [...collapsedProjects]}); }
function parentOf(project) { return organization().projectParents?.[project.id] || ''; }
function projectAncestors(project) {
  const path = []; let id = parentOf(project);
  while (id && path.length < 8) { const parent = state.projects.find(candidate => candidate.id === id); if (!parent) break; path.unshift(parent); id = parentOf(parent); }
  return path;
}
function parentOptions(select, value = '', excludedId = editorId) {
  select.replaceChildren(); const root = element('option', '', 'No parent project'); root.value = ''; select.append(root);
  for (const project of state.projects) {
    if (project.id === excludedId || projectAncestors(project).some(parent => parent.id === excludedId)) continue;
    const option = element('option', '', [...projectAncestors(project), project].map(item => item.name).join(' / ')); option.value = project.id; select.append(option);
  }
  select.value = [...select.options].some(option => option.value === value) ? value : '';
}
function groupOf(project) { project = projectAncestors(project)[0] || project; const assignments = organization().assignments; return Object.hasOwn(assignments, project.id) ? assignments[project.id] : ''; }
function groupPath(id) {
  const path = [];
  const groups = new Map(organization().groups.map(group => [group.id, group]));
  while (id && groups.has(id) && path.length < 8) { const group = groups.get(id); path.unshift(group); id = group.parentId; }
  return path;
}
function groupOptions(select, value = '', excludedId = null) {
  select.replaceChildren();
  const root = element('option', '', select.id === 'island-parent' ? 'Top level' : 'Unsorted');
  root.value = '';
  select.append(root);
  for (const group of organization().groups) {
    const path = groupPath(group.id);
    if (excludedId && path.some(parent => parent.id === excludedId)) continue;
    const option = element('option', '', path.map(parent => parent.name).join(' / '));
    option.value = group.id;
    select.append(option);
  }
  select.value = [...select.options].some(option => option.value === value) ? value : '';
}

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function savedLabel() {
  return state.updatedAt ? `Saved ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Ready when you are';
}
function hasChangedDrafts() {
  if ([...inlineDrafts.values()].some(edit => edit.committing || edit.conflict || edit.value !== edit.base)) return true;
  if ($('editor').open && JSON.stringify(draft()) !== initialDraft) return true;
  if ($('island-editor').open && JSON.stringify(islandDraft()) !== initialIslandDraft) return true;
  return false;
}
function updateUndoControl() {
  const undo = state.undo;
  const button = $('undo');
  const drafts = hasChangedDrafts();
  const label = undo ? `Undo ${undo.label} by ${undo.actor}` : 'Undo';
  const reason = undo?.blockedReason || (drafts ? 'Save or cancel your current draft before undoing.' : '');
  button.title = undo ? `${label}${reason ? `. ${reason}` : ''}` : 'There is nothing to undo.';
  button.setAttribute('aria-label', undo ? `${label}. ${undo.remaining} undo steps remaining.${reason ? ` ${reason}` : ''}` : 'Undo unavailable');
  button.disabled = saving || undoing || drafts || !undo || !!undo.blockedReason;
  $('undo-remaining').textContent = undo ? `${undo.remaining} left` : '';
}
let removedSavedView = null;
function savedViewSnapshot() {
  const current = preferences.read();
  const boardState = board?.getView() || current[activeScope === 'archive' ? 'archiveBoard' : 'board'];
  const boardCamera = { ...current.board }, archiveBoard = { ...current.archiveBoard };
  if (activeScope === 'archive') Object.assign(archiveBoard, boardState); else Object.assign(boardCamera, boardState);
  return {
    activeScope, board: boardCamera, archiveBoard, search: $('search').value, filterNeeds,
    suppressFilterExpansion, collapsedIslands: [...collapsedIslands], collapsedProjects: [...collapsedProjects],
    listScroll: { ...current.listScroll, [activeScope]: boardState.mode === 'list' ? window.scrollY : current.listScroll[activeScope] },
  };
}
function renderSavedViews() {
  const views = preferences.savedViews();
  const list = $('saved-view-list'); list.replaceChildren();
  $('saved-view-count').textContent = String(views.length);
  $('saved-view-name').disabled = saving || views.length >= 20;
  $('save-view').disabled = saving || views.length >= 20;
  $('saved-view-name').maxLength = 80;
  if (!views.length) list.append(element('li', 'saved-view-empty', 'No saved views yet.'));
  for (const view of views) {
    const row = element('li', 'saved-view-row'); row.dataset.viewId = view.id;
    const title = element('span', 'saved-view-title', view.name); title.title = view.name;
    const actions = element('div', 'saved-view-actions');
    for (const [action, label] of [['apply', 'Apply'], ['rename', 'Rename'], ['delete', 'Delete']]) {
      const button = element('button', action === 'delete' ? 'saved-view-delete' : '', label);
      button.type = 'button'; button.dataset.viewAction = action; button.dataset.viewId = view.id;
      button.disabled = saving; button.setAttribute('aria-label', `${label} ${view.name}`); actions.append(button);
    }
    row.append(title, actions); list.append(row);
  }
  if (removedSavedView) {
    const restore = element('button', 'saved-view-restore', `Undo delete “${removedSavedView.name}”`);
    restore.type = 'button'; restore.addEventListener('click', () => {
      if (preferences.restoreView(removedSavedView)) { removedSavedView = null; $('saved-view-status').textContent = 'Saved view restored.'; renderSavedViews(); }
    });
    const li = element('li', 'saved-view-undo'); li.append(restore); list.append(li);
  }
}
function applySavedView(view) {
  if (saving || hasChangedDrafts()) {
    notice(saving ? 'Wait for the current save to finish before applying a saved view.' : 'Save or cancel your project, island, or inline edits before applying a saved view. Your draft is still here.');
    return;
  }
  const snapshot = view.snapshot;
  activeScope = snapshot.activeScope;
  filterNeeds = snapshot.filterNeeds;
  suppressFilterExpansion = snapshot.suppressFilterExpansion;
  $('search').value = snapshot.search;
  collapsedIslands = new Set(snapshot.collapsedIslands);
  collapsedProjects.clear(); snapshot.collapsedProjects.forEach(id => collapsedProjects.add(id));
  revealedGroups.clear(); revealedProjects.clear();
  preferences.update({
    activeScope, filterNeeds, suppressFilterExpansion, search: snapshot.search,
    collapsedIslands: snapshot.collapsedIslands, collapsedProjects: snapshot.collapsedProjects,
    board: snapshot.board, archiveBoard: snapshot.archiveBoard, listScroll: snapshot.listScroll,
    focusedProjectId: null,
  });
  board?.restoreView(snapshot[activeScope === 'archive' ? 'archiveBoard' : 'board']);
  render();
  if (board?.getView().mode === 'list') requestAnimationFrame(() => window.scrollTo(0, snapshot.listScroll[activeScope]));
  notice(`Applied “${view.name}”.`);
}
async function request(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'Could not save. Please try again.');
    error.current = body.current;
    throw error;
  }
  return body;
}
function reconcileInlineDrafts(snapshot) {
  for (const [key, edit] of inlineDrafts) {
    const [id, field] = key.split(':');
    const latest = snapshot.projects.find(project => project.id === id)?.[field];
    if (latest === undefined) { edit.conflict = true; edit.latest = '(project no longer active)'; }
    else if (latest !== edit.base) { edit.conflict = true; edit.latest = latest; }
    else { edit.revision = snapshot.revision; edit.conflict = false; }
  }
}
async function undoLatest() {
  const target = state.undo;
  if (!target || target.blockedReason || saving || undoing || hasChangedDrafts()) return;
  const expectedRevision = state.revision;
  undoing = true; saving = true; ++loadSequence; render();
  for (const control of document.querySelectorAll('#project-form input, #project-form textarea, #project-form select, #project-form button, #island-form input, #island-form select, #island-form button')) control.disabled = true;
  try {
    const result = await request('/api/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: target.commandId, expectedRevision, requestId: crypto.randomUUID() }) });
    state = result;
    reconcileInlineDrafts(result);
    pendingSave = null;
    notice(`Undid ${target.label} by ${target.actor}.`);
  } catch (error) {
    if (error.current) {
      state = error.current;
      reconcileInlineDrafts(error.current);
      notice(`Undo was not applied because the list changed. The latest list is loaded; review any preserved drafts before trying again.`);
    } else notice(`Undo was not applied. ${error.message}`);
  } finally {
    saving = false; undoing = false;
    for (const control of document.querySelectorAll('#project-form input, #project-form textarea, #project-form select, #project-form button, #island-form input, #island-form select, #island-form button')) control.disabled = false;
    $('add-link').disabled = $('link-fields').children.length >= 20;
    render();
  }
}
function openHistory(project) {
  historyProjectId = project.id; historyCursor = null; const sequence = ++historySequence;
  $('history-project-name').textContent = project.name;
  $('history-events').replaceChildren(); $('history-earlier').hidden = true;
  $('history-status').textContent = 'Loading history…';
  $('history-dialog').showModal();
  loadHistoryPage(sequence, project.id, null, true);
}
function historyValue(value) {
  if (value === null || value === undefined || value === '') return '(blank)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function historyEventLabel(event) {
  const field = String(event.field || '').replaceAll('_', '').toLocaleLowerCase();
  const kind = String(event.kind || 'change').replaceAll('_', ' ').replaceAll('-', ' ');
  if (field === 'currenttask') return kind === 'undo' ? 'Undo: Current task changed' : 'Current task changed';
  if (field === 'notes') return kind === 'undo' ? 'Undo: Notes changed' : 'Notes changed';
  return kind.charAt(0).toLocaleUpperCase() + kind.slice(1);
}
function appendHistoryEvent(event) {
  const row = element('li', 'history-event');
  const header = element('div', 'history-event-head');
  header.append(element('strong', '', historyEventLabel(event)));
  const time = event.time ? new Date(event.time) : null;
  header.append(element('time', '', time && !Number.isNaN(time.valueOf()) ? time.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable'));
  row.append(header);
  if (['currenttask', 'notes'].includes(String(event.field || '').replaceAll('_', '').toLocaleLowerCase())) {
    const change = element('div', 'history-change');
    change.append(element('span', 'history-value old-value', historyValue(event.oldValue)), element('span', 'history-arrow', '→'), element('span', 'history-value', historyValue(event.newValue)));
    row.append(change);
  } else if (event.oldValue !== undefined || event.newValue !== undefined) {
    row.append(element('p', 'history-context', `${historyValue(event.oldValue)} → ${historyValue(event.newValue)}`));
  }
  row.append(element('div', 'history-actor', `by ${event.actor || 'Unknown'}`));
  $('history-events').append(row);
}
async function loadHistoryPage(sequence, projectId, beforeId, replace) {
  const status = $('history-status');
  const button = $('history-earlier');
  if (replace) status.textContent = 'Loading history…';
  button.disabled = true;
  try {
    const query = new URLSearchParams({ projectId, limit: '50' });
    if (beforeId) query.set('beforeId', beforeId);
    const result = await request(`/api/history?${query}`);
    if (sequence !== historySequence || projectId !== historyProjectId || !$('history-dialog').open) return;
    if (replace) $('history-events').replaceChildren();
    for (const event of result.events || []) appendHistoryEvent(event);
    historyCursor = result.nextCursor || null;
    button.hidden = !historyCursor;
    button.disabled = false;
    status.textContent = $('history-events').children.length ? '' : 'No history for this project yet.';
  } catch (error) {
    if (sequence !== historySequence || projectId !== historyProjectId) return;
    status.textContent = `Could not load history. ${error.message}`;
    button.hidden = !beforeId;
    button.disabled = false;
  }
}
function clearDrag(repaint = false) {
  clearTimeout(dragHoverTimer);
  dragHoverTimer = null;
  dragHoverTarget = null;
  dragging = null;
  document.body.classList.remove('drag-session');
  document.querySelectorAll('.drop-over, .drop-blocked, .is-dragging').forEach(node => node.classList.remove('drop-over', 'drop-blocked', 'is-dragging'));
  $('root-drop').hidden = true;
  if (repaint && ready && !saving) render();
}
function makeDraggable(node, item) {
  node.draggable = ready && !saving;
  node.dataset.dragKind = item.kind;
  node.dataset.dragId = item.id;
  node.addEventListener('dragstart', event => {
    if (event.target.closest('[data-drag-kind]') !== node) return;
    if (saving || !ready || event.target.closest('a,button,input,textarea,select')) { event.preventDefault(); return; }
    event.stopPropagation();
    dragging = { ...item, revision: state.revision };
    ++loadSequence;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-project-list-item', JSON.stringify(item));
    node.classList.add('is-dragging');
    document.body.classList.add('drag-session');
    $('root-drop').textContent = item.kind === 'island' ? 'Drop here to make this a top-level island' : 'Drop here to move this project to Unsorted';
    $('root-drop').hidden = false;
    $('drag-status').textContent = 'Drag onto a project to make a sub-project, or an island to move there.';
  });
  node.addEventListener('dragend', event => { event.stopPropagation(); clearDrag(true); });
}
function makeDropTarget(node, destination) {
  function ownsTarget(event) { return node.id === 'root-drop' || event.target.closest('[data-project-id], .island') === node; }
  const destinationProject = destination && typeof destination === 'object' ? state.projects.find(project => project.id === destination.id) : null;
  const destinationLabel = destinationProject ? destinationProject.name : groupPath(destination).map(group => group.name).join(' / ');
  function plannedMove() {
    if (!dragging || saving) throw new Error('Finish the current save before moving items.');
    if (dragging.revision !== state.revision) throw new Error('The list changed. Start the drag again.');
    return moveOrganization(state, dragging, destination);
  }
  function previewDrop(event) {
    if (!dragging || !ownsTarget(event)) return;
    event.stopPropagation();
    document.querySelectorAll('.drop-over, .drop-blocked').forEach(other => { if (other !== node) other.classList.remove('drop-over', 'drop-blocked'); });
    try {
      plannedMove();
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-over');
      node.classList.remove('drop-blocked');
      $('drag-status').textContent = destination === null ? $('root-drop').textContent : `Drop inside ${destinationLabel}.`;
      if (dragHoverTarget !== node) {
        clearTimeout(dragHoverTimer);
        dragHoverTarget = node;
        if (node.matches('details:not([open])')) dragHoverTimer = setTimeout(() => { if (dragging && dragHoverTarget === node) node.open = true; }, 700);
      }
    } catch (error) {
      event.dataTransfer.dropEffect = 'none';
      node.classList.remove('drop-over');
      node.classList.add('drop-blocked');
      $('drag-status').textContent = error.message;
      clearTimeout(dragHoverTimer);
      dragHoverTarget = null;
    }
  }
  node.addEventListener('dragenter', previewDrop);
  node.addEventListener('dragover', previewDrop);
  node.addEventListener('dragleave', event => {
    if (event.relatedTarget && node.contains(event.relatedTarget)) return;
    node.classList.remove('drop-over', 'drop-blocked');
    if (dragHoverTarget === node) { clearTimeout(dragHoverTimer); dragHoverTarget = null; }
  });
  node.addEventListener('drop', async event => {
    if (!dragging || !ownsTarget(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = dragging;
    let placement;
    try { placement = plannedMove(); }
    catch (error) { clearDrag(true); notice(error.message); return; }
    const destinationName = destination === null ? (item.kind === 'island' ? 'the top level' : 'Unsorted') : destinationLabel;
    clearDrag();
    try {
      await saveList(state.projects, item.revision, false, placement);
      if (destination !== null) { for (const group of groupPath(destinationProject ? groupOf(destinationProject) : destination)) collapsedIslands.delete(group.id); try { localStorage.setItem('collapsed-islands', JSON.stringify([...collapsedIslands])); } catch { } render(); }
      notice(`Moved ${item.kind === 'island' ? 'island' : 'project'} to ${destinationName}.`);
      $('drag-status').textContent = `Move saved: ${destinationName}.`;
    } catch (error) {
      notice(`Move not confirmed. ${error.message} Refresh the list before trying again.`);
      $('drag-status').textContent = 'Move not confirmed. Check the message above.';
    }
  });
}
async function load() {
  if (saving || dragging || $('editor').open || $('island-editor').open) return;
  const sequence = ++loadSequence;
  try {
    const result = await request('/api/projects');
    if (sequence !== loadSequence || saving || dragging || $('editor').open || $('island-editor').open) return;
    for (const [key, edit] of inlineDrafts) {
      const [id, field] = key.split(':');
      const latest = result.projects.find(project => project.id === id)?.[field];
      if (latest === undefined) { edit.conflict = true; edit.latest = '(project no longer active)'; }
      else if (latest !== edit.base) { edit.conflict = true; edit.latest = latest; }
      else { edit.revision = result.revision; }
    }
    state = result;
    for (const [key, edit] of inlineDrafts) {
      const [id, field] = key.split(':');
      if (state.projects.find(project => project.id === id)?.[field] === edit.base) edit.revision = state.revision;
    }
    ready = true;
    render();
    notice();
  } catch (error) {
    $('save-state').textContent = 'Not connected';
    notice(`${error.message} Keep the app running, then refresh this page to reconnect.`);
  }
}
function render() {
  closeActionMenu({ restore: false });
  $('open-all').disabled = $('close-all').disabled = !ready || saving;
  const focusedInline = document.activeElement?.dataset?.inlineKey;
  const selection = focusedInline && typeof document.activeElement.selectionStart === 'number' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  for (const [key, edit] of inlineDrafts) { const owner=state.projects.find(project=>project.id===key.split(':')[0]); if(owner&&!inScope(owner)){edit.conflict=true;edit.latest=owner[key.split(':')[1]];} }
  const query = $('search').value.trim().toLocaleLowerCase();
  const scopedProjects = state.projects.filter(inScope);
  const visible = scopedProjects.filter(project => (!filterNeeds || project.needsMichael) && `${project.name} ${project.currentTask} ${project.notes} ${projectAncestors(project).map(parent => parent.name).join(' ')} ${groupPath(groupOf(project)).map(group => group.name).join(' ')}`.toLocaleLowerCase().includes(query));
  const visibleIds = new Set(visible.flatMap(project => [...projectAncestors(project).filter(inScope), project].map(item => item.id)));
  const displayed = state.projects.filter(project => visibleIds.has(project.id));
  $('all-count').textContent = scopedProjects.length;
  $('active-count').textContent = state.projects.filter(project => !isArchived(project)).length;
  $('archive-count').textContent = state.projects.filter(isArchived).length;
  for (const scope of ['active', 'archive']) { $('scope-' + scope).classList.toggle('selected', scope === activeScope); $('scope-' + scope).setAttribute('aria-pressed', String(scope === activeScope)); }
  $('needs-count').textContent = scopedProjects.filter(project => project.needsMichael).length;
  $('save-state').textContent = saving ? 'Saving…' : savedLabel();
  updateUndoControl();
  $('filter-all').classList.toggle('selected', !filterNeeds);
  $('filter-all').setAttribute('aria-pressed', String(!filterNeeds));
  $('filter-needs').classList.toggle('selected', filterNeeds);
  $('filter-needs').setAttribute('aria-pressed', String(filterNeeds));
  $('empty').hidden = !ready || scopedProjects.length !== 0 || (activeScope === 'active' && organization().groups.length !== 0);
  $('no-results').hidden = true;
  $('add-project').disabled = !ready || saving;
  $('empty-add').hidden = activeScope === 'archive';
  $('empty').querySelector('h2').textContent = activeScope === 'archive' ? 'No archived projects.' : 'No projects yet.';
  $('add-island').disabled = !ready || saving;
  $('empty-add').disabled = !ready || saving;
  $('export').disabled = !ready || saving;
  $('import').disabled = !ready || saving;
  const list = $('projects');
  list.classList.toggle('islands-grid', organization().groups.length > 0);
  list.replaceChildren();
  function addProjectCard(project, container) {
    const index = state.projects.indexOf(project);
    const peers = scopedProjects.filter(peer => groupOf(peer) === groupOf(project) && parentOf(peer) === parentOf(project));
    const peerIndex = peers.indexOf(project);
    const card = element('article', `project${project.needsMichael ? ' attention' : ''}`);
    card.dataset.projectId = project.id;
    const grip = element('div', 'number drag-grip', '⠿');
    grip.title = 'Drag project onto another project or island';
    grip.setAttribute('aria-hidden', 'true');
    card.append(grip);
    if (activeScope === 'active') { makeDraggable(card, { kind: 'project', id: project.id }); makeDropTarget(card, { kind: 'project', id: project.id }); }
    const content = element('div', 'project-content');
    const title = element('div', 'project-title');
    const heading = element('h2');
    const name = element('button', 'title-button', project.name);
    name.title = project.name;
    name.disabled = saving;
    name.addEventListener('click', () => openEditorLatest(project.id));
    heading.append(name);
    title.append(heading);
    const attention = element('button', `attention-toggle-card${project.needsMichael ? ' active' : ''}`, project.needsMichael ? 'Needs you ✓' : 'Needs you');
    attention.type = 'button'; attention.disabled = saving; attention.setAttribute('aria-pressed', String(project.needsMichael)); attention.setAttribute('aria-label', `${project.needsMichael ? 'Remove Needs you from' : 'Mark as Needs you'} ${project.name}`); attention.addEventListener('click', () => changeNeedsMichael(project.id, !project.needsMichael));
    const pin = element('button', 'pin-button', (state.pins || []).includes(project.id) ? 'Pinned' : 'Pin');
    pin.type = 'button'; pin.setAttribute('aria-pressed', String((state.pins || []).includes(project.id))); pin.setAttribute('aria-label', `${(state.pins || []).includes(project.id) ? 'Unpin' : 'Pin'} ${project.name}`); pin.disabled = saving || isArchived(project);
    pin.addEventListener('click', () => changePin(project.id, !(state.pins || []).includes(project.id)));
    const more = element('button', '', 'More');
    const historyAction = () => openHistory(state.projects.find(candidate => candidate.id === project.id) || project);
    const addChildAction = () => { const latest = state.projects.find(candidate => candidate.id === project.id); if (latest) openEditor(undefined, groupOf(latest), latest.id); };
    const archiveAction = () => requestArchive(project.id);
    const moveUpAction = () => moveProjectBy(project.id, -1);
    const moveDownAction = () => moveProjectBy(project.id, 1);
    function moveProjectBy(projectId, offset) {
      if (saving || dragging || query || filterNeeds) return;
      const current = state.projects.find(candidate => candidate.id === projectId);
      if (!current) return;
      const currentScope = state.projects.filter(inScope);
      const latestPeers = currentScope.filter(candidate => groupOf(candidate) === groupOf(current) && parentOf(candidate) === parentOf(current));
      const latestIndex = latestPeers.indexOf(current), destinationProject = latestPeers[latestIndex + offset];
      if (latestIndex < 0 || !destinationProject) return;
      const next = [...state.projects];
      const currentPosition = next.findIndex(candidate => candidate.id === current.id);
      const destination = next.findIndex(candidate => candidate.id === destinationProject.id);
      if (currentPosition < 0 || destination < 0) return;
      [next[currentPosition], next[destination]] = [next[destination], next[currentPosition]];
      saveList(next, state.revision).catch(error => notice(`${error.message} Refresh to load the latest list.`));
    }
    attachActionMenu(more, `More actions for ${project.name}`, [
      { label: 'History', ownerProjectId: project.id, disabled: saving, action: historyAction },
      { label: 'Add sub-project', ownerProjectId: project.id, disabled: saving || isArchived(project) || projectAncestors(project).length >= 7, action: addChildAction },
      { label: isArchived(project) ? 'Restore' : 'Archive', ownerProjectId: project.id, className: 'danger', disabled: saving, action: archiveAction },
      { label: 'Move up', ownerProjectId: project.id, disabled: saving || dragging || peerIndex <= 0 || !!query || filterNeeds, action: moveUpAction },
      { label: 'Move down', ownerProjectId: project.id, disabled: saving || dragging || peerIndex < 0 || peerIndex >= peers.length - 1 || !!query || filterNeeds, action: moveDownAction },
    ]);
    title.append(more);
    content.append(title);
    const states = element('div', 'project-states'); states.append(attention, pin); content.append(states);
    if (isArchived(project)) content.append(element('span', 'archive-badge', 'Archived'));
    if (parentOf(project) && scopedRoot(project)) content.append(element('p', 'project-origin', [...groupPath(groupOf(project)).map(group => group.name), ...projectAncestors(project).map(parent => parent.name)].join(' / ')));
    const task = element('div', 'task');
    task.append(element('span', 'task-label', 'CURRENT TASK'));
    const taskKey = `${project.id}:currentTask`, taskDraft = inlineDrafts.get(taskKey);
    if (taskDraft) {
      const input = element('input', 'inline-field inline-task'); input.dataset.inlineKey = taskKey; input.dataset.inlineProject = project.id; input.dataset.inlineField = 'currentTask'; input.value = taskDraft.value; input.placeholder = 'Add what’s happening next…'; input.maxLength = 2000; input.disabled = saving || taskDraft.committing || !!taskDraft.conflict;
      task.append(input);
    } else task.append(element('button', `inline-display${project.currentTask ? '' : ' placeholder'}`, project.currentTask || 'Add what’s happening next…'));
    const taskDisplay = task.querySelector('.inline-display');
    if (taskDisplay) { taskDisplay.type = 'button'; taskDisplay.dataset.inlineProject = project.id; taskDisplay.dataset.inlineField = 'currentTask'; taskDisplay.addEventListener('click', () => beginInlineEdit(project, 'currentTask')); }
    content.append(task);
    const notes = element('div', 'project-notes');
    const notesKey = `${project.id}:notes`, notesDraft = inlineDrafts.get(notesKey);
    notes.append(element('span', 'notes-label', 'Notes'));
    if (notesDraft) {
      const area = element('textarea', 'inline-field inline-notes'); area.dataset.inlineKey = notesKey; area.dataset.inlineProject = project.id; area.dataset.inlineField = 'notes'; area.value = notesDraft.value; area.placeholder = 'Add project context…'; area.maxLength = 10000; area.rows = 2; area.disabled = saving || notesDraft.committing || !!notesDraft.conflict;
      notes.append(area);
    } else notes.append(element('button', `inline-display notes-display${project.notes ? '' : ' placeholder'}`, project.notes || 'Add notes…'));
    const notesDisplay = notes.querySelector('.notes-display');
    if (notesDisplay) { notesDisplay.type = 'button'; notesDisplay.dataset.inlineProject = project.id; notesDisplay.dataset.inlineField = 'notes'; notesDisplay.addEventListener('click', () => beginInlineEdit(project, 'notes')); }
    if (notesDraft?.conflict) {
      notes.append(element('div', 'inline-conflict', `Latest saved: ${notesDraft.latest || '(blank)'}\nYour draft is preserved. Review the latest value, then choose whether to apply your draft.`));
      const apply = element('button', 'inline-review', 'Apply my draft'); apply.type = 'button'; apply.addEventListener('click', () => reviewInlineConflict(notesKey)); notes.append(apply);
      const useLatest = element('button', 'inline-review', 'Use latest'); useLatest.type = 'button'; useLatest.addEventListener('click', () => discardInlineDraft(notesKey)); notes.append(useLatest);
    }
    if (notesDraft && !notesDraft.conflict) notes.append(element('span', 'inline-hint', 'Ctrl+Enter to save · Esc to cancel'));
    content.append(notes);
    if (taskDraft?.conflict) {
      const comparison = element('div', 'inline-conflict', `Latest saved: ${taskDraft.latest || '(blank)'}\nYour draft is preserved. Review the latest value, then choose whether to apply your draft.`);
      const apply = element('button', 'inline-review', 'Apply my draft'); apply.type = 'button'; apply.addEventListener('click', () => reviewInlineConflict(taskKey));
      const useLatest = element('button', 'inline-review', 'Use latest'); useLatest.type = 'button'; useLatest.addEventListener('click', () => discardInlineDraft(taskKey));
      task.append(comparison, apply, useLatest);
    }
    if (taskDraft && !taskDraft.conflict) task.append(element('span', 'inline-hint', 'Enter to save · Esc to cancel'));
    if (taskDraft?.error) appendInlineError(task, taskKey, taskDraft);
    if (notesDraft?.error) appendInlineError(notes, notesKey, notesDraft);
    if (project.links.length) {
      const links = element('div', 'project-links');
      for (const link of project.links) {
        const anchor = element('a', '', `${link.label || new URL(link.url).hostname} ↗`);
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        links.append(anchor);
      }
      content.append(links);
    }
    card.append(content);
    const children = displayed.filter(child => parentOf(child) === project.id);
    if (children.length) {
      const nested = element('details', 'subprojects'); nested.open = (!suppressFilterExpansion && (!!query || filterNeeds)) || revealedProjects.has(project.id) || !collapsedProjects.has(project.id);
      nested.addEventListener('toggle', () => { if ((!suppressFilterExpansion && (query || filterNeeds)) || dragging || revealedProjects.has(project.id)) return; if (nested.open) collapsedProjects.delete(project.id); else collapsedProjects.add(project.id); persistView(); });
      nested.append(element('summary', '', `Sub-projects (${children.length})`));
      const contents = element('div', 'subproject-list');
      for (const child of children) addProjectCard(child, contents);
      nested.append(contents); card.append(nested);
    }
    container.append(card);
  }
  function renderIsland(group, container) {
    const descendantIds = new Set(organization().groups.filter(candidate => groupPath(candidate.id).some(parent => parent.id === group.id)).map(candidate => candidate.id));
    const allInside = scopedProjects.filter(project => descendantIds.has(groupOf(project)));
    const visibleInside = displayed.filter(project => descendantIds.has(groupOf(project)));
    const matchingName = [...descendantIds].some(id => groupPath(id).map(parent => parent.name).join(' ').toLocaleLowerCase().includes(query));
    if (activeScope === 'archive' && !visibleInside.length) return false;
    if ((query || filterNeeds) && !visibleInside.length && !(query && !filterNeeds && matchingName)) return false;
    const island = element('details', 'island');
    island.dataset.islandId = group.id;
    island.open = (!suppressFilterExpansion && (!!query || filterNeeds)) || revealedGroups.has(group.id) || !collapsedIslands.has(group.id);
    const summary = element('summary', 'island-heading');
    const title = element('span', 'island-title');
    const grip = element('span', 'island-symbol drag-grip', '⠿');
    makeDraggable(grip, { kind: 'island', id: group.id });
    grip.title = 'Drag island inside another island';
    grip.setAttribute('aria-hidden', 'true');
    const islandName = element('strong', '', group.name); islandName.title = group.name;
    title.append(element('span', 'island-chevron', '›'), grip, islandName, element('span', 'island-count', `${allInside.length}`));
    summary.append(title);
    const attention = allInside.filter(project => project.needsMichael).length;
    if (attention) { const count = element('span', 'badge island-attention-count', `${attention} needs you`); count.setAttribute('aria-label', `${attention} projects need User`); summary.append(count); }
    const actions = element('span', 'island-actions');
    const add = element('button', 'island-add-project', '＋ Project');
    add.type = 'button'; add.title = `Add project to ${group.name}`; add.setAttribute('aria-label', add.title); add.disabled = saving;
    add.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openEditor(undefined, group.id); }); actions.append(add);
    const more = element('button', '', 'More');
    attachActionMenu(more, `More actions for ${group.name}`, [
      { label: 'Add island', disabled: saving, action: () => openIslandEditor(undefined, group.id) },
      { label: 'Edit island', disabled: saving, action: () => openIslandEditor(group) },
      { label: 'Focus island on board', disabled: saving, action: () => {
        if (!board?.focusIsland) { notice('Island focus is unavailable until the board is ready.'); return; }
        board.setMode?.('board');
        const node = [...$('projects').querySelectorAll('details.island[data-island-id]')].find(item => item.dataset.islandId === group.id);
        if (node) board.focusIsland(node); else notice('This island is not visible in the current filtered view.');
      } },
    ]); actions.append(more);
    summary.append(actions);
    island.append(summary);
    const contents = element('div', 'island-contents');
    for (const project of visibleInside.filter(project => groupOf(project) === group.id && scopedRoot(project))) addProjectCard(project, contents);
    for (const child of organization().groups.filter(child => child.parentId === group.id)) renderIsland(child, contents);
    if (!contents.children.length) contents.append(element('p', 'island-empty', query || filterNeeds ? 'No matching projects here.' : 'A quiet space for related projects. Add a project or another island.'));
    island.append(contents);
    makeDropTarget(island, group.id);
    island.addEventListener('toggle', () => {
      if ((!suppressFilterExpansion && (query || filterNeeds)) || dragging || revealedGroups.has(group.id)) return;
      if (island.open) collapsedIslands.delete(group.id); else collapsedIslands.add(group.id);
      persistView();
    });
    container.append(island);
    return true;
  }
  for (const group of organization().groups.filter(group => group.parentId === null)) renderIsland(group, list);
  const ungrouped = displayed.filter(project => !groupOf(project) && scopedRoot(project));
  if (organization().groups.length && ungrouped.length) {
    const section = element('section', 'unsorted-island');
    section.append(element('h2', '', 'Unsorted'));
    for (const project of ungrouped) addProjectCard(project, section);
    list.append(section);
  } else if (!organization().groups.length) for (const project of displayed.filter(scopedRoot)) addProjectCard(project, list);
  $('board-viewport').hidden = !list.children.length;
  board?.refresh();
  if (ready && activeScope === 'active' && !saving && !layoutSaveScheduled) {
    const positions = { ...(organization().boardPositions || {}) }; let missing = false;
    for (const tile of list.children) { const id = tile.dataset.islandId || (tile.classList.contains('unsorted-island') ? '__unsorted__' : null); if (id && !positions[id]) { positions[id] = {x:parseFloat(tile.style.left)||0,y:parseFloat(tile.style.top)||0}; missing = true; } }
    if (missing && board?.getView().mode === 'board') { layoutSaveScheduled = true; queueMicrotask(async () => { try { if (!saving && !dragging) { const placement=structuredClone(organization()); placement.boardPositions={...positions,...placement.boardPositions}; await saveList(state.projects,state.revision,false,placement); } } catch(error) { notice('Initial board layout not saved. '+error.message); } finally { layoutSaveScheduled=false; } }); }
  }
  persistView();
  if (restoreInitialScroll && ready) { restoreInitialScroll = false; requestAnimationFrame(() => { if (board?.getView().mode === 'list') window.scrollTo(0, preferences.read().listScroll[activeScope]); }); }
  renderPins();
  renderOrphanConflicts();
  const trashList = $('deleted-projects'); trashList.replaceChildren();
  const deleted = (state.trash || []).filter(entry => Date.parse(entry.deletedAt) > Date.now() - 7 * 86400000);
  $('trash-count').textContent = deleted.length;
  $('recently-deleted').hidden = deleted.length === 0;
  for (const entry of deleted) {
    const row = element('div', 'deleted-row');
    const expires = new Date(Date.parse(entry.deletedAt) + 7 * 86400000);
    const label = element('span', '', entry.project.name + ' — restore until ' + expires.toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}));
    const restore = element('button', 'secondary', 'Restore'); restore.disabled = saving;
    restore.setAttribute('aria-label', 'Restore ' + entry.project.name);
    restore.addEventListener('click', async () => {
      try { const next = restoreProject(state, entry.project.id); await saveList(next.projects, state.revision, false, next.organization, next.trash); notice('Project restored: ' + entry.project.name); }
      catch (error) { notice('Restore not confirmed. ' + error.message + ' Refresh before trying again.'); }
    });
    row.append(label, restore); trashList.append(row);
  }
  $('no-results').hidden = !ready || !(query || filterNeeds) || list.children.length > 0 || (state.projects.length === 0 && organization().groups.length === 0);
  if (focusedInline) {
    const replacement = [...document.querySelectorAll('[data-inline-key]')].find(node => node.dataset.inlineKey === focusedInline);
    if (replacement && !replacement.disabled) { replacement.focus(); if (selection) replacement.setSelectionRange(...selection); }
  }
}
function inlineKey(project, field) { return `${project.id}:${field}`; }
function beginInlineEdit(project, field) {
  if (saving) return;
  const key = inlineKey(project, field);
  if (!inlineDrafts.has(key)) inlineDrafts.set(key, { base: project[field], value: project[field], revision: state.revision, conflict: false, committing: false });
  render();
  document.querySelector(`[data-inline-key="${CSS.escape(key)}"]`)?.focus();
}
function reviewInlineConflict(key) {
  const edit = inlineDrafts.get(key);
  if (!edit || !edit.conflict) return;
  if (edit.latest === '(project no longer active)') return;
  edit.base = edit.latest;
  edit.revision = state.revision;
  edit.conflict = false;
  edit.committing = false;
  edit.reviewed = true;
  render();
  saveInlineDraft(key);
}
function discardInlineDraft(key) { inlineDrafts.delete(key); render(); }
function appendInlineError(container, key, edit) {
  container.append(element('div', 'inline-conflict', `Save failed: ${edit.error}. Your draft is still here.`));
  const retry = element('button', 'inline-review', 'Retry save'); retry.type = 'button'; retry.addEventListener('click', () => { edit.error = ''; saveInlineDraft(key); }); container.append(retry);
  const cancel = element('button', 'inline-review', 'Cancel draft'); cancel.type = 'button'; cancel.addEventListener('click', () => discardInlineDraft(key)); container.append(cancel);
}
function renderOrphanConflicts() {
  const section = $('inline-conflicts');
  section.replaceChildren();
  const missing = [...inlineDrafts].filter(([key, edit]) => edit.conflict && !state.projects.some(project => project.id === key.split(':')[0] && inScope(project)));
  section.hidden = !missing.length;
  for (const [key, edit] of missing) {
    const field = key.split(':')[1] === 'notes' ? 'Notes' : 'Current task';
    const row = element('div', 'inline-conflict');
    row.textContent = `${field} draft: ${edit.value || '(blank)'}\nLatest saved: ${edit.latest}. The project is outside this view; your draft is preserved here.`;
    const dismiss = element('button', 'inline-review', 'Dismiss draft'); dismiss.type = 'button'; dismiss.addEventListener('click', () => discardInlineDraft(key)); row.append(dismiss); section.append(row);
  }
}
async function saveInlineDraft(key) {
  const edit = inlineDrafts.get(key);
  if (!edit || edit.conflict) return;
  if (edit.committing) return edit.commitPromise;
  if (saving) { edit.pendingCommit = true; return; }
  edit.pendingCommit = false;
  if (edit.value === edit.base) { inlineDrafts.delete(key); render(); return; }
  const [id, field] = key.split(':');
  if (!state.projects.some(project => project.id === id)) return;
  edit.committing = true;
  edit.commitPromise = (async () => {
    try {
      const projects = state.projects.map(project => project.id === id ? { ...project, [field]: edit.value } : project);
      await saveList(projects, edit.revision);
      if (inlineDrafts.get(key) === edit) inlineDrafts.delete(key);
    } catch (error) {
      edit.committing = false;
      pendingSave = null;
      if (error.current) {
        const latest = error.current.projects.find(project => project.id === id);
        edit.latest = latest ? latest[field] : '(project no longer active)';
        edit.conflict = true;
        state = error.current;
      } else edit.error = error.message;
    }
    edit.commitPromise = null;
    render();
  })();
  return edit.commitPromise;
}
function renderPins() {
  const tray = $('pinned-tray');
  const active = (state.pins || []).map(id => state.projects.find(project => project.id === id)).filter(project => project && !isArchived(project));
  tray.replaceChildren();
  tray.hidden = activeScope === 'archive' || !active.length;
  if (!active.length) return;
  const header = element('div', 'pinned-heading');
  header.append(element('strong', '', 'Pinned'));
  const clear = element('button', 'text-button', 'Clear pins'); clear.type = 'button'; clear.disabled = saving;
  clear.addEventListener('click', async () => {
    if (!active.length) return;
    try { await saveList(state.projects, state.revision, false, organization(), state.trash || [], []); }
    catch (error) { notice(`Pins not cleared. ${error.message}`); }
  });
  header.append(clear); tray.append(header);
  for (const project of active) {
    const row = element('div', 'pinned-row');
    const title = element('button', 'pinned-title', project.name); title.type = 'button'; title.addEventListener('click', () => revealProject(project.id));
    const context = [...projectAncestors(project).map(parent => parent.name), ...groupPath(groupOf(project)).map(group => group.name)].join(' · ') || 'Unsorted';
    const where = element('span', 'pinned-context', context);
    const task = element('button', 'pinned-text', project.currentTask || 'Add current task…'); task.type = 'button'; task.addEventListener('click', () => { revealProject(project.id); setTimeout(() => beginInlineEdit(project, 'currentTask'), 0); });
    const notes = element('button', 'pinned-text', project.notes || 'Add notes…'); notes.type = 'button'; notes.addEventListener('click', () => { revealProject(project.id); setTimeout(() => beginInlineEdit(project, 'notes'), 0); });
    const unpin = element('button', 'pin-button', 'Unpin'); unpin.type = 'button'; unpin.disabled = saving; unpin.addEventListener('click', () => changePin(project.id, false));
    row.append(title, where, task, notes, unpin); tray.append(row);
  }
}
function revealProject(id) {
  const project = state.projects.find(project => project.id === id); if (!project) return;
  const scope = isArchived(project) ? 'archive' : 'active'; if (scope !== activeScope) setScope(scope);
  filterNeeds = false; $('search').value = '';
  for (const group of groupPath(groupOf(project))) revealedGroups.add(group.id);
  for (const parent of projectAncestors(project)) revealedProjects.add(parent.id);
  preferences.update({focusedProjectId:id}); render();
  const card = $('projects').querySelector('[data-project-id="' + CSS.escape(id) + '"]');
  if (card) { if (board?.getView().mode === 'board') board.reveal(card); else card.scrollIntoView({behavior:'smooth',block:'center'}); }
}
function setScope(scope) {
  if (scope === activeScope || saving) return;
  preferences.update({listScroll:{[activeScope]:window.scrollY}});
  activeScope = scope; revealedGroups.clear(); revealedProjects.clear();
  board?.restoreView(preferences.read()[scope === 'archive' ? 'archiveBoard' : 'board']);
  persistView(); render();
  if (board?.getView().mode === 'list') requestAnimationFrame(() => window.scrollTo(0, preferences.read().listScroll[activeScope]));
}
function requestArchive(id) {
  const project = state.projects.find(project => project.id === id); if (!project || saving) return;
  if ($('editor').open && JSON.stringify(draft()) !== initialDraft) { notice('Save or cancel your project edits before archiving.'); return; }
  if (isArchived(project)) { applyArchive(id, true, state.revision); return; }
  const count = state.projects.filter(candidate => !isArchived(candidate) && (candidate.id === id || projectAncestors(candidate).some(parent => parent.id === id))).length;
  pendingArchive = {id,revision:state.revision};
  $('archive-description').textContent = 'Archive “' + project.name + '”' + (count > 1 ? ' and ' + (count - 1) + ' active sub-project' + (count === 2 ? '' : 's') : '') + '? You can restore archived projects at any time.';
  $('archive-confirmation').showModal();
}
async function applyArchive(id, restoring, revision) {
  try {
    const next = restoring ? restoreArchivedProject(state,id) : archiveProject(state,id,new Date().toISOString(),crypto.randomUUID());
    await saveList(next.projects,revision,false,next.organization);
    $('archive-confirmation').close(); if ($('editor').open) $('editor').close();
    notice(restoring ? 'Archive batch restored.' : 'Project archived.');
  } catch (error) { $('archive-confirmation').close(); notice('Change not saved. ' + error.message); }
}
async function changePin(projectId, pinned) {
  const pins = pinned ? [...new Set([...(state.pins || []), projectId])] : (state.pins || []).filter(id => id !== projectId);
  if (JSON.stringify(pins) === JSON.stringify(state.pins || [])) return;
  try { await saveList(state.projects, state.revision, false, organization(), state.trash || [], pins); }
  catch (error) { notice(`Pin not saved. ${error.message}`); }
}
async function changeNeedsMichael(projectId, value) {
  const projects = state.projects.map(project => project.id === projectId ? { ...project, needsMichael: value } : project);
  try { await saveList(projects, state.revision); }
  catch (error) { notice(`Needs you change not saved. ${error.message}`); }
}
async function saveList(projects, revision, restore = false, placement = organization(), trash = state.trash || [], pins = state.pins || [], projectHistory) {
  if (saving) throw new Error('A save is already in progress.');
  const signature = JSON.stringify({ projects, revision, restore, organization: placement, trash, pins });
  if (pendingSave?.signature !== signature) pendingSave = { signature, requestId: crypto.randomUUID() };
  saving = true;
  ++loadSequence;
  render();
  for (const control of document.querySelectorAll('#project-form input, #project-form textarea, #project-form select, #project-form button, #island-form input, #island-form select, #island-form button')) control.disabled = true;
  $('save-project').disabled = true;
  $('save-project').textContent = 'Saving…';
  try {
    const payload = { projects, revision, requestId: pendingSave.requestId, restore, organization: placement, trash, pins };
    if (projectHistory !== undefined) payload.projectHistory = projectHistory;
    const result = await request('/api/projects', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    state = result;
    for (const [key, edit] of inlineDrafts) {
      const [id, field] = key.split(':');
      if (state.projects.find(project => project.id === id)?.[field] === edit.base) edit.revision = state.revision;
    }
    pendingSave = null;
    notice();
    return result;
  } finally {
    saving = false;
    for (const control of document.querySelectorAll('#project-form input, #project-form textarea, #project-form select, #project-form button, #island-form input, #island-form select, #island-form button')) control.disabled = false;
    $('add-link').disabled = $('link-fields').children.length >= 20;
    $('save-project').disabled = false;
    $('save-project').textContent = 'Save project';
    render();
    for (const [key, edit] of inlineDrafts) if (edit.pendingCommit) queueMicrotask(() => saveInlineDraft(key));
  }
}
function addLink(link = { label: '', url: '' }) {
  if ($('link-fields').children.length >= 20) return;
  const row = element('div', 'link-row');
  const label = element('input');
  label.value = link.label;
  label.placeholder = 'Label';
  label.maxLength = 160;
  label.setAttribute('aria-label', 'Link label');
  const url = element('input');
  url.value = link.url;
  url.placeholder = 'https://…';
  url.type = 'url';
  url.maxLength = 2048;
  url.setAttribute('aria-label', 'Link URL');
  const remove = element('button', '', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove link');
  remove.addEventListener('click', () => { row.remove(); $('add-link').disabled = false; });
  row.append(label, url, remove);
  $('link-fields').append(row);
  $('add-link').disabled = $('link-fields').children.length >= 20;
}
function draft() {
  return { id: editorId, name: $('name').value.trim(), islandId: $('project-island').value, parentProjectId: $('project-parent').value, currentTask: $('current-task').value, notes: $('notes').value, needsMichael: $('needs-michael').checked, links: [...$('link-fields').children].map(row => ({ label: row.children[0].value.trim(), url: row.children[1].value.trim() })).filter(link => link.url || link.label) };
}
function openEditor(project, groupId = '', parentId = '') {
  if (saving || !ready) return;
  const value = project || { id: crypto.randomUUID(), name: '', currentTask: '', notes: '', needsMichael: false, links: [] };
  editorId = value.id;
  editRevision = state.revision;
  $('delete-project').hidden = !project;
  $('archive-project').hidden = !project; $('archive-project').textContent = project && isArchived(project) ? 'Restore from archive' : 'Archive project';
  parentOptions($('project-parent'), project ? parentOf(project) : parentId);
  $('editor-title').textContent = project ? 'Project details' : 'New project';
  $('name').value = value.name;
  $('current-task').value = value.currentTask;
  $('notes').value = value.notes;
  $('needs-michael').checked = value.needsMichael;
  groupOptions($('project-island'), project ? groupOf(project) : groupId);
  $('link-fields').replaceChildren();
  $('add-link').disabled = false;
  value.links.forEach(addLink);
  initialDraft = JSON.stringify(draft());
  $('form-error').hidden = true;
  $('conflict').hidden = true;
  $('load-latest').hidden = false;
  latestConflict = null;
  $('editor').showModal();
  $('name').focus();
}
async function openEditorLatest(projectId) {
  if (saving) return;
  const key = [`${projectId}:currentTask`, `${projectId}:notes`].find(candidate => inlineDrafts.has(candidate));
  if (key) {
    await saveInlineDraft(key);
    if (inlineDrafts.get(key)?.conflict) return;
  }
  const latest = state.projects.find(project => project.id === projectId);
  if (latest) openEditor(latest);
}
function closeEditor() {
  if (saving) return;
  if (JSON.stringify(draft()) !== initialDraft && !confirm('Discard your unsaved changes?')) return;
  $('editor').close();
  load();
}
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (latestConflict) return;
  const { islandId, parentProjectId, ...value } = draft();
  if (state.projects.some(project => project.id !== value.id && project.name.toLocaleLowerCase() === value.name.toLocaleLowerCase()) && !confirm('A project with this name already exists. Add this as a separate project?')) return;
  const existing = state.projects.some(project => project.id === value.id);
  const next = existing ? state.projects.map(project => project.id === value.id ? value : project) : [...state.projects, value];
  const placement = structuredClone(organization());
  placement.projectParents ||= {};
  if (parentProjectId) { placement.projectParents[value.id] = parentProjectId; delete placement.assignments[value.id]; }
  else { delete placement.projectParents[value.id];
  if (islandId) placement.assignments = { ...placement.assignments, [value.id]: islandId }; else delete placement.assignments[value.id];
  }
  try {
    await saveList(next, editRevision, false, placement);
    $('editor').close();
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
    if (error.current) {
      latestConflict = error.current;
      const latest = latestConflict.projects.find(project => project.id === editorId);
      const latestGroupId = latestConflict.organization?.assignments?.[editorId];
      const latestGroup = latestConflict.organization?.groups.find(group => group.id === latestGroupId)?.name || 'Unsorted';
      $('latest-copy').textContent = latest ? `Latest saved project: ${latest.name}\nIsland: ${latestGroup}\nCurrent task: ${latest.currentTask || '(blank)'}\nNotes: ${latest.notes || '(blank)'}\nNeeds you: ${latest.needsMichael ? 'Yes' : 'No'}\nImportant links: ${latest.links.map(link => `${link.label || 'Link'}: ${link.url}`).join('\n') || '(none)'}\n\nYour unsaved draft remains in the fields above.` : 'The latest list no longer includes this entry. Your draft remains above; saving again will add it.';
      $('conflict').hidden = false;
    }
  }
});
$('load-latest').addEventListener('click', () => {
  const selectedGroup = $('project-island').value;
  const selectedParent = $('project-parent').value;
  state = latestConflict;
  editRevision = state.revision;
  latestConflict = null;
  pendingSave = null;
  $('form-error').textContent = 'Latest list loaded. Review your draft against the saved text below, then Save to apply your changes.';
  $('load-latest').hidden = true;
  groupOptions($('project-island'), selectedGroup);
  parentOptions($('project-parent'), selectedParent);
  if (selectedParent && $('project-parent').value !== selectedParent) { $('form-error').textContent += ' The parent project is no longer available. Choose a parent before saving.'; }
  if (selectedGroup && $('project-island').value !== selectedGroup) $('form-error').textContent += ' The draft’s island no longer exists; choose another destination before saving.';
  render();
});
$('delete-project').addEventListener('click', async () => {
  if (saving || latestConflict) return;
  const project = state.projects.find(project => project.id === editorId);
  if (!project) return;
  $('delete-description').textContent = 'Delete “' + project.name + '”? You can restore it for seven days. Its sub-projects will be kept and moved up one level.';
  $('delete-confirmation').showModal();
});
$('cancel-delete').addEventListener('click', () => $('delete-confirmation').close());
$('confirm-delete').addEventListener('click', async () => {
  if (saving || latestConflict) return;
  $('confirm-delete').disabled = true;
  try {
    const next = removeProject(state, editorId);
    await saveList(next.projects, editRevision, false, next.organization, next.trash);
    $('delete-confirmation').close(); $('editor').close(); notice('Project moved to Recently deleted for seven days. Its sub-projects were kept.');
  } catch (error) { $('delete-confirmation').close(); $('form-error').hidden = false; $('form-error').textContent = error.message + ' Close the editor and reload before trying again.'; }
  finally { $('confirm-delete').disabled = false; }
});
function islandDraft() { return { name: $('island-name').value.trim(), parentId: $('island-parent').value || null }; }
function openIslandEditor(group, parentId = '') {
  if (saving || !ready) return;
  islandEditorId = group?.id || crypto.randomUUID();
  islandWasExisting = !!group;
  islandEditRevision = state.revision;
  $('island-editor-title').textContent = group ? 'Island details' : 'New island';
  $('island-name').value = group?.name || '';
  groupOptions($('island-parent'), group?.parentId || parentId, islandEditorId);
  $('remove-island').hidden = !group;
  $('island-error').hidden = true;
  $('island-latest-copy').hidden = true;
  $('island-latest').hidden = true;
  islandConflict = null;
  initialIslandDraft = JSON.stringify(islandDraft());
  $('island-editor').showModal();
  $('island-name').focus();
}
function closeIslandEditor() {
  if (saving) return;
  if (JSON.stringify(islandDraft()) !== initialIslandDraft && !confirm('Discard your unsaved island changes?')) return;
  $('island-editor').close();
  load();
}
function islandError(error) {
  $('island-error').textContent = error.message;
  $('island-error').hidden = false;
  if (error.current) {
    islandConflict = error.current;
    const latest = islandConflict.organization?.groups.find(group => group.id === islandEditorId);
    const parentNames = [];
    let parent = latest?.parentId;
    while (parent && parentNames.length < 8) { const group = islandConflict.organization.groups.find(group => group.id === parent); if (!group) break; parentNames.unshift(group.name); parent = group.parentId; }
    $('island-latest-copy').textContent = latest ? `Latest saved island: ${latest.name}\nInside: ${parentNames.join(' / ') || 'Top level'}\n\nYour draft is still in the fields above. Compare both name and destination before saving again.` : 'This island is not present in the latest saved list. Your draft is still in the fields above.';
    $('island-latest-copy').hidden = false;
    $('island-latest').hidden = false;
  }
}
$('island-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (islandConflict || saving) return;
  const placement = structuredClone(organization());
  const value = islandDraft();
  const existing = placement.groups.some(group => group.id === islandEditorId);
  if (islandWasExisting && !existing) { islandError(new Error('This island was removed. Close this dialog and create a new island if needed.')); return; }
  const id = islandEditorId;
  placement.groups = existing ? placement.groups.map(group => group.id === id ? { id, ...value } : group) : [...placement.groups, { id, ...value }];
  try { await saveList(state.projects, islandEditRevision, false, placement); $('island-editor').close(); }
  catch (error) { islandError(error); }
});
$('island-latest').addEventListener('click', () => {
  const selected = $('island-parent').value;
  state = islandConflict;
  islandEditRevision = state.revision;
  islandConflict = null;
  pendingSave = null;
  groupOptions($('island-parent'), selected, islandEditorId);
  $('island-latest').hidden = true;
  $('island-error').textContent = 'Latest list loaded. Review the name and destination before saving your draft.';
  if (selected && $('island-parent').value !== selected) $('island-error').textContent += ' Your selected parent no longer exists; choose another destination.';
  render();
});
$('remove-island').addEventListener('click', async () => {
  if (saving || islandConflict) return;
  const placement = structuredClone(organization());
  const group = placement.groups.find(group => group.id === islandEditorId);
  if (!group || !confirm(`Remove “${group.name}”? Its projects and inner islands will move up one level. No projects will be deleted.`)) return;
  placement.groups = placement.groups.filter(item => item.id !== group.id).map(item => item.parentId === group.id ? { ...item, parentId: group.parentId } : item);
  for (const [id, destination] of Object.entries(placement.assignments)) if (destination === group.id) {
    if (group.parentId) placement.assignments[id] = group.parentId; else delete placement.assignments[id];
  }
  try { await saveList(state.projects, islandEditRevision, false, placement); $('island-editor').close(); }
  catch (error) { islandError(error); }
});
$('add-island').addEventListener('click', () => {if(activeScope!=='active')setScope('active');openIslandEditor()});
$('close-island').addEventListener('click', closeIslandEditor);
$('cancel-island').addEventListener('click', closeIslandEditor);
$('island-editor').addEventListener('cancel', event => { event.preventDefault(); closeIslandEditor(); });
$('island-editor').addEventListener('click', event => { if (event.target === $('island-editor')) { const rect = $('island-editor').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeIslandEditor(); } });
$('add-project').addEventListener('click', () => {if(activeScope!=='active')setScope('active');openEditor()});
$('empty-add').addEventListener('click', () => openEditor());
$('close-editor').addEventListener('click', closeEditor);
$('cancel').addEventListener('click', closeEditor);
$('editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('editor').addEventListener('click', event => { if (event.target === $('editor')) { const rect = $('editor').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeEditor(); } });
$('add-link').addEventListener('click', () => addLink());
$('search').addEventListener('input', () => { suppressFilterExpansion = false; revealedGroups.clear(); revealedProjects.clear(); render(); if ($('search').value.trim()) { const result = $('projects').querySelector('[data-project-id]'); if (result && board?.getView().mode === 'board') board.reveal(result); } });
$('projects').addEventListener('focusin', event => {
  const target = event.target.closest('[data-inline-project][data-inline-field]');
  if (!target || target.dataset.inlineKey) return;
  const project = state.projects.find(item => item.id === target.dataset.inlineProject);
  if (project) beginInlineEdit(project, target.dataset.inlineField);
});
$('projects').addEventListener('input', event => {
  const target = event.target.closest('[data-inline-key]');
  const edit = target && inlineDrafts.get(target.dataset.inlineKey);
  if (edit) { edit.value = target.value; edit.error = ''; }
});
$('projects').addEventListener('keydown', event => {
  const target = event.target.closest('[data-inline-key]');
  if (!target) return;
  const field = target.dataset.inlineField;
  const key = target.dataset.inlineKey;
  if (event.key === 'Escape' && openActionMenu) { event.preventDefault(); event.stopPropagation(); closeActionMenu(); return; }
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); inlineDrafts.delete(key); render(); }
  else if (field === 'currentTask' && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); saveInlineDraft(key); }
  else if (field === 'notes' && event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); saveInlineDraft(key); }
});
$('projects').addEventListener('focusout', event => {
  const target = event.target.closest('[data-inline-key]');
  // Let the pointer's click handler run first. If it starts another save, the
  // inline commit is queued and drained after that save instead of swallowing it.
  if (target) setTimeout(() => saveInlineDraft(target.dataset.inlineKey), 100);
});
function setAllExpanded(expanded) {
  if (!ready || saving) return;
  suppressFilterExpansion = !expanded;
  revealedGroups.clear(); revealedProjects.clear();
  for (const group of organization().groups) {
    if (expanded) collapsedIslands.delete(group.id); else collapsedIslands.add(group.id);
  }
  for (const id of Object.values(organization().projectParents || {})) {
    if (expanded) collapsedProjects.delete(id); else collapsedProjects.add(id);
  }
  // Update disclosures in place so an inline draft isn't recreated or discarded.
  for (const disclosure of $('projects').querySelectorAll('details.island,details.subprojects')) disclosure.open = expanded;
  persistView();
}
$('open-all').addEventListener('click', () => setAllExpanded(true));
$('close-all').addEventListener('click', () => setAllExpanded(false));
$('filter-all').addEventListener('click', () => { suppressFilterExpansion = false; filterNeeds = false; render(); });
$('filter-needs').addEventListener('click', () => { suppressFilterExpansion = false; filterNeeds = true; render(); });
$('clear-filters').addEventListener('click', () => { suppressFilterExpansion = false; filterNeeds = false; $('search').value = ''; render(); });
$('export').addEventListener('click', async () => {
  try {
    const data = await request('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const anchor = element('a');
    anchor.href = url;
    anchor.download = `projects-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('backup-state').textContent = 'Backup exported just now';
    notice('Backup downloaded. Import it on another computer to move your list.');
    document.querySelector('.backup-menu').open = false;
  } catch (error) { notice(error.message); }
});
$('import').addEventListener('click', () => { $('import-file').value = ''; $('import-file').click(); document.querySelector('.backup-menu').open = false; });
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 100_000_000) throw new Error('This backup exceeds the 100 MB import limit.');
    const data = JSON.parse(await file.text());
    if (![1, 2, 3, 4, 5, 6].includes(data.schemaVersion) || !Array.isArray(data.projects)) throw new Error('Choose a version 1–6 project-list JSON backup.');
    if (data.schemaVersion >= 2 && (!data.organization || !Array.isArray(data.organization.groups) || !data.organization.assignments || typeof data.organization.assignments !== 'object')) throw new Error('This backup is missing its island organization.');
    if (data.schemaVersion >= 3 && !Array.isArray(data.trash)) throw new Error('This backup is missing Recently deleted projects.');
    if (data.schemaVersion >= 4 && !Array.isArray(data.pins)) throw new Error('This backup is missing its pinned projects.');
    if (data.schemaVersion >= 6 && !Array.isArray(data.projectHistory)) throw new Error('This backup is missing project history.');
    if (!confirm(`Replace this computer’s ${state.projects.length} projects with the ${data.projects.length} projects in this backup? A local safety backup will be kept.`)) return;
    await saveList(data.projects, state.revision, true, data.schemaVersion >= 2 ? data.organization : { groups: [], assignments: {} }, data.schemaVersion >= 3 ? data.trash : [], data.schemaVersion >= 4 ? data.pins : [], data.schemaVersion >= 6 ? data.projectHistory : []);
    notice('Backup imported. This computer now has the restored list.');
  } catch (error) { notice(`${error.message} The import was not confirmed.`); }
});
window.addEventListener('focus', load);
makeDropTarget($('root-drop'), null);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && dragging) clearDrag(true); });
window.addEventListener('beforeunload', event => { if (saving || hasChangedDrafts()) { event.preventDefault(); event.returnValue = ''; } });
$('search').value = preferences.read().search;
$('saved-views').addEventListener('toggle', () => { if ($('saved-views').open) renderSavedViews(); });
$('saved-view-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('saved-view-name');
  const result = preferences.saveView(input.value, savedViewSnapshot());
  if (!result.ok) {
    $('saved-view-status').textContent = result.reason === 'limit' ? 'You can save up to 20 views. Delete one to make room.' : 'Enter a name for this view.';
    return;
  }
  input.value = ''; $('saved-view-status').textContent = `Saved “${result.view.name}”.`; renderSavedViews(); input.focus();
});
$('saved-view-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-view-action]');
  if (!button) return;
  const view = preferences.savedViews().find(item => item.id === button.dataset.viewId);
  if (!view) return;
  const row = button.closest('.saved-view-row');
  if (button.dataset.viewAction === 'apply') { applySavedView(view); return; }
  if (button.dataset.viewAction === 'rename') {
    row.replaceChildren();
    const form = element('form', 'saved-view-rename');
    const input = element('input'); input.type = 'text'; input.maxLength = 80; input.required = true; input.value = view.name; input.setAttribute('aria-label', `Rename ${view.name}`);
    const save = element('button', '', 'Save'); save.type = 'submit';
    const cancel = element('button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', renderSavedViews);
    form.append(input, save, cancel);
    form.addEventListener('submit', e => {
      e.preventDefault(); const result = preferences.saveView(input.value, view.snapshot, view.id);
      if (result.ok) { $('saved-view-status').textContent = `Renamed to “${result.view.name}”.`; renderSavedViews(); }
      else { input.setCustomValidity('Enter a name up to 80 characters.'); input.reportValidity(); }
    });
    row.append(form); input.focus(); input.select(); return;
  }
  if (button.dataset.viewAction === 'delete') {
    const actions = row.querySelector('.saved-view-actions'); actions.replaceChildren();
    const prompt = element('span', 'saved-view-confirm', `Delete “${view.name}”?`);
    const confirmDelete = element('button', 'saved-view-delete', 'Delete'); confirmDelete.type = 'button';
    const cancel = element('button', '', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', renderSavedViews);
    confirmDelete.addEventListener('click', () => {
      removedSavedView = preferences.deleteView(view.id);
      $('saved-view-status').textContent = removedSavedView ? `Deleted “${view.name}”.` : 'That saved view was already removed.';
      renderSavedViews();
    });
    actions.append(prompt, confirmDelete, cancel); confirmDelete.focus();
  }
});
$('scope-active').addEventListener('click',()=>setScope('active'));
$('scope-archive').addEventListener('click',()=>setScope('archive'));
$('undo').addEventListener('click', undoLatest);
document.addEventListener('input', updateUndoControl);
document.addEventListener('change', updateUndoControl);
$('close-history').addEventListener('click', () => $('history-dialog').close());
$('agent-skills-open').addEventListener('click', () => $('agent-skills-dialog').showModal());
$('agent-skills-close').addEventListener('click', () => $('agent-skills-dialog').close());
$('history-dialog').addEventListener('close', () => { ++historySequence; historyProjectId = null; historyCursor = null; });
$('history-earlier').addEventListener('click', () => { if (!historyCursor || !historyProjectId) return; loadHistoryPage(historySequence, historyProjectId, historyCursor, false); });
$('archive-project').addEventListener('click',()=>requestArchive(editorId));
$('cancel-archive').addEventListener('click',()=>{pendingArchive=null;$('archive-confirmation').close()});
$('confirm-archive').addEventListener('click',()=>{if(pendingArchive&&!saving)applyArchive(pendingArchive.id,false,pendingArchive.revision)});
board = createBoardView({
 viewport:$('board-viewport'),canvas:$('projects'),toolbar:$('board-controls'),modeToolbar:$('board-mode-controls'),
 initialView:preferences.read()[activeScope==='archive'?'archiveBoard':'board'],
 getPositions:()=>organization().boardPositions||{},
 onPositionsChange:async positions=>{const placement=structuredClone(organization());placement.boardPositions=positions;await saveList(state.projects,state.revision,false,placement)},
 onViewChange:view=>preferences.update({[activeScope==='archive'?'archiveBoard':'board']:view}),
 canMove:()=>!saving,
 onError:error=>{render();notice('Board change not saved. '+error.message)}
});
window.addEventListener('scroll',()=>{if(board.getView().mode==='list')preferences.update({listScroll:{[activeScope]:window.scrollY}})},{passive:true});
window.addEventListener('pagehide',()=>preferences.flush());
load();
