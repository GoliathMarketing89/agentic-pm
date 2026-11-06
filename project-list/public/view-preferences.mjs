const DEFAULT_KEY = 'project-list:view-preferences:v1';
const LEGACY_COLLAPSED_KEY = 'collapsed-islands';
const DEFAULT_DELAY_MS = 180;
const MAX_IDS = 500;
const MAX_SAVED_VIEWS = 20;
const MAX_VIEW_NAME = 80;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

function emptyState() {
  return {
    version: 1,
    activeScope: 'active',
    board: { mode: 'board', x: 0, y: 0, zoom: 1 },
    archiveBoard: { mode: 'board', x: 0, y: 0, zoom: 1 },
    search: '',
    filterNeeds: false,
    suppressFilterExpansion: false,
    collapsedIslands: [],
    collapsedProjects: [],
    listScroll: { active: 0, archive: 0 },
    focusedProjectId: null,
    savedViews: [],
  };
}

function finite(value, fallback, min = -1e7, max = 1e7) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const id of value) {
    if (validId(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
      if (result.length >= MAX_IDS) break;
    }
  }
  return result;
}

function camera(value, fallback) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  return {
    mode: value.mode === 'list' ? 'list' : value.mode === 'board' ? 'board' : fallback.mode,
    x: finite(value.x, fallback.x),
    y: finite(value.y, fallback.y),
    zoom: finite(value.zoom, fallback.zoom, 0.25, 2),
  };
}

function normalize(value, defaults = emptyState()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  return {
    version: 1,
    activeScope: value.activeScope === 'archive' ? 'archive' : 'active',
    board: camera(value.board, defaults.board),
    archiveBoard: camera(value.archiveBoard, defaults.archiveBoard),
    search: typeof value.search === 'string' ? value.search.slice(0, 500) : defaults.search,
    filterNeeds: typeof value.filterNeeds === 'boolean' ? value.filterNeeds : defaults.filterNeeds,
    suppressFilterExpansion: typeof value.suppressFilterExpansion === 'boolean' ? value.suppressFilterExpansion : defaults.suppressFilterExpansion,
    collapsedIslands: idList(value.collapsedIslands ?? defaults.collapsedIslands),
    collapsedProjects: idList(value.collapsedProjects ?? defaults.collapsedProjects),
    listScroll: {
      active: finite(value.listScroll?.active, defaults.listScroll.active, 0, 1e7),
      archive: finite(value.listScroll?.archive, defaults.listScroll.archive, 0, 1e7),
    },
    focusedProjectId: value.focusedProjectId === null || value.focusedProjectId === undefined
      ? defaults.focusedProjectId
      : validId(value.focusedProjectId) ? value.focusedProjectId : null,
    savedViews: normalizeSavedViews(value.savedViews ?? defaults.savedViews),
  };
}

function normalizeSavedViews(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id) || seen.has(item.id)) continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, MAX_VIEW_NAME) : '';
    if (!name) continue;
    const snapshot = normalize(item.snapshot, emptyState());
    result.push({ id: item.id, name, snapshot: {
      activeScope: snapshot.activeScope, board: snapshot.board, archiveBoard: snapshot.archiveBoard,
      search: snapshot.search, filterNeeds: snapshot.filterNeeds,
      collapsedIslands: snapshot.collapsedIslands, collapsedProjects: snapshot.collapsedProjects,
      listScroll: snapshot.listScroll,
      suppressFilterExpansion: item.snapshot?.suppressFilterExpansion === true,
    } });
    seen.add(item.id);
    if (result.length >= MAX_SAVED_VIEWS) break;
  }
  return result;
}

function freeze(value) {
  Object.freeze(value.board);
  Object.freeze(value.archiveBoard);
  Object.freeze(value.collapsedIslands);
  Object.freeze(value.collapsedProjects);
  Object.freeze(value.listScroll);
  for (const item of value.savedViews) {
    Object.freeze(item.snapshot.board); Object.freeze(item.snapshot.archiveBoard);
    Object.freeze(item.snapshot.collapsedIslands); Object.freeze(item.snapshot.collapsedProjects);
    Object.freeze(item.snapshot.listScroll); Object.freeze(item.snapshot);
    Object.freeze(item);
  }
  Object.freeze(value.savedViews);
  return Object.freeze(value);
}

/**
 * Browser-local, versioned preferences. Updates shallow-merge top-level fields;
 * board, archiveBoard, and listScroll additionally merge their own supplied keys.
 * Every read/update returns a fresh, deeply frozen normalized state.
 */
export function createViewPreferences({ storage, key = DEFAULT_KEY, delayMs = DEFAULT_DELAY_MS } = {}) {
  let store = storage;
  if (store === undefined) {
    try { store = globalThis.localStorage; } catch { store = undefined; }
  }
  const storageKey = typeof key === 'string' && key ? key : DEFAULT_KEY;
  const waitMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : DEFAULT_DELAY_MS;
  let timer = null;
  let destroyed = false;
  let loaded = false;
  let state = emptyState();

  function getItem(name) {
    try { return store?.getItem(name) ?? null; } catch { return null; }
  }
  function setItem(name, value) {
    try { store?.setItem(name, value); return !!store; } catch { return false; }
  }
  function immutable() { return freeze(normalize(state)); }

  function loadOnce() {
    if (loaded) return;
    loaded = true;
    const raw = getItem(storageKey);
    if (raw !== null) {
      try { state = normalize(JSON.parse(raw)); } catch { state = emptyState(); }
    } else {
      state = emptyState();
      const legacy = getItem(LEGACY_COLLAPSED_KEY);
      if (legacy !== null) {
        try { state.collapsedIslands = idList(JSON.parse(legacy)); } catch { /* malformed legacy state is ignored */ }
      }
    }
  }

  function read() {
    if (destroyed) return immutable();
    loadOnce();
    return immutable();
  }

  function schedule() {
    if (destroyed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, waitMs);
  }

  function update(patch = {}) {
    if (destroyed) return immutable();
    loadOnce();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return immutable();
    const merged = { ...state, ...patch };
    for (const field of ['board', 'archiveBoard', 'listScroll']) {
      if (patch[field] && typeof patch[field] === 'object' && !Array.isArray(patch[field])) {
        merged[field] = { ...state[field], ...patch[field] };
      }
    }
    state = normalize(merged, state);
    schedule();
    return immutable();
  }

  function flush() {
    loadOnce();
    if (timer !== null) { clearTimeout(timer); timer = null; }
    return setItem(storageKey, JSON.stringify(state));
  }

  function reset() {
    if (destroyed) return immutable();
    loadOnce();
    state = emptyState();
    schedule();
    return immutable();
  }

  function savedViews() { loadOnce(); return immutable().savedViews; }
  function saveView(name, snapshot, id) {
    if (destroyed) return { ok: false, reason: 'unavailable' };
    loadOnce();
    const cleanName = typeof name === 'string' ? name.trim().slice(0, MAX_VIEW_NAME) : '';
    if (!cleanName) return { ok: false, reason: 'name' };
    const views = normalizeSavedViews(state.savedViews);
    const existingIndex = id ? views.findIndex(view => view.id === id) : -1;
    if (existingIndex < 0 && views.length >= MAX_SAVED_VIEWS) return { ok: false, reason: 'limit' };
    const viewId = existingIndex >= 0 ? views[existingIndex].id : (validId(id) ? id : `view_${Math.random().toString(36).slice(2, 12)}`);
    const next = { id: viewId, name: cleanName, snapshot: normalizeSavedViews([{ id: viewId, name: cleanName, snapshot }])[0]?.snapshot };
    if (!next.snapshot) return { ok: false, reason: 'snapshot' };
    if (existingIndex >= 0) views[existingIndex] = next; else views.push(next);
    state = normalize({ ...state, savedViews: views }, state); schedule();
    return { ok: true, view: immutable().savedViews.find(view => view.id === viewId) };
  }
  function deleteView(id) {
    loadOnce(); const views = state.savedViews.filter(view => view.id !== id);
    if (views.length === state.savedViews.length) return null;
    const removed = state.savedViews.find(view => view.id === id);
    state = normalize({ ...state, savedViews: views }, state); schedule(); return removed;
  }
  function restoreView(item) {
    if (!item || !validId(item.id)) return false;
    loadOnce(); const views = normalizeSavedViews([...state.savedViews, item]);
    if (!views.some(view => view.id === item.id)) return false;
    state = normalize({ ...state, savedViews: views }, state); schedule(); return true;
  }

  function destroy() {
    if (destroyed) return;
    flush();
    destroyed = true;
  }

  return Object.freeze({ read, update, flush, reset, destroy, savedViews, saveView, deleteView, restoreView });
}

export const VIEW_PREFERENCES_KEY = DEFAULT_KEY;
export const SAVED_VIEW_LIMIT = MAX_SAVED_VIEWS;
export const SAVED_VIEW_NAME_LIMIT = MAX_VIEW_NAME;
