import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewPreferences, VIEW_PREFERENCES_KEY } from '../public/view-preferences.mjs';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  let writes = 0;
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { writes++; values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    value(key) { return values.get(key); },
    get writes() { return writes; },
  };
}

test('persists and restores scope, separate cameras, filters, expansion, and per-scope scroll', () => {
  const storage = memoryStorage();
  const preferences = createViewPreferences({ storage, delayMs: 10_000 });
  preferences.update({
    activeScope: 'archive',
    board: { x: -42, y: 80, zoom: 1.25, mode: 'board' },
    archiveBoard: { mode: 'list', x: 13, y: -9, zoom: 0.75 },
    search: 'launch', filterNeeds: true,
    collapsedIslands: ['island_a'], collapsedProjects: ['project-2'],
    listScroll: { active: 30, archive: 420 }, focusedProjectId: 'project-2',
  });
  assert.equal(preferences.flush(), true);
  const restarted = createViewPreferences({ storage });
  const state = restarted.read();
  assert.equal(state.activeScope, 'archive');
  assert.deepEqual(state.board, { mode: 'board', x: -42, y: 80, zoom: 1.25 });
  assert.deepEqual(state.archiveBoard, { mode: 'list', x: 13, y: -9, zoom: 0.75 });
  assert.deepEqual(state.listScroll, { active: 30, archive: 420 });
  assert.equal(state.search, 'launch');
  assert.equal(state.filterNeeds, true);
  assert.deepEqual(state.collapsedIslands, ['island_a']);
  assert.deepEqual(state.collapsedProjects, ['project-2']);
  assert.equal(state.focusedProjectId, 'project-2');
  assert.equal(storage.value(VIEW_PREFERENCES_KEY) !== undefined, true);
  preferences.destroy();
  restarted.destroy();
});

test('ignores corrupt JSON and gracefully handles storage that throws', () => {
  const corrupt = createViewPreferences({ storage: memoryStorage({ [VIEW_PREFERENCES_KEY]: '{nope' }) });
  assert.equal(corrupt.read().activeScope, 'active');
  corrupt.destroy();

  const disabled = createViewPreferences({
    storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
  });
  assert.equal(disabled.read().board.zoom, 1);
  assert.equal(disabled.update({ search: 'ok' }).search, 'ok');
  assert.equal(disabled.flush(), false);
  disabled.destroy();
});

test('debounces a burst of updates into one write and flushes latest state', async () => {
  const storage = memoryStorage();
  const preferences = createViewPreferences({ storage, delayMs: 25 });
  preferences.update({ board: { x: 1 } });
  preferences.update({ board: { y: 2 } });
  preferences.update({ board: { zoom: 1.5 } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(storage.writes, 1);
  assert.deepEqual(JSON.parse(storage.value(VIEW_PREFERENCES_KEY)).board, { mode: 'board', x: 1, y: 2, zoom: 1.5 });
  preferences.destroy();
  assert.equal(storage.writes, 2); // destroy flushes the settled state too
});

test('active and archive camera and list scroll updates stay independent', () => {
  const preferences = createViewPreferences({ storage: memoryStorage(), delayMs: 10_000 });
  preferences.update({ board: { x: 17 }, listScroll: { active: 100 } });
  preferences.update({ archiveBoard: { x: -20 }, listScroll: { archive: 900 } });
  const state = preferences.read();
  assert.equal(state.board.x, 17);
  assert.equal(state.archiveBoard.x, -20);
  assert.deepEqual(state.listScroll, { active: 100, archive: 900 });
  preferences.destroy();
});

test('validates values, caps identifiers, and migrates the legacy collapsed island key', () => {
  const ids = ['valid_1', 'bad id', 'x'.repeat(101), 'valid_1', ...Array.from({ length: 520 }, (_, i) => `i${i}`)];
  const storage = memoryStorage({ 'collapsed-islands': JSON.stringify(['legacy', 'bad id']) });
  const preferences = createViewPreferences({ storage, delayMs: 10_000 });
  const migrated = preferences.read();
  assert.deepEqual(migrated.collapsedIslands, ['legacy']);
  const result = preferences.update({
    board: { mode: 'wat', x: Infinity, y: -1e99, zoom: 9 },
    archiveBoard: { mode: 'list', x: 3.25, zoom: 0.1 },
    listScroll: { active: -10, archive: 1e99 },
    collapsedProjects: ids,
    focusedProjectId: 'invalid id',
  });
  assert.deepEqual(result.board, { mode: 'board', x: 0, y: -1e7, zoom: 2 });
  assert.deepEqual(result.archiveBoard, { mode: 'list', x: 3.25, y: 0, zoom: 0.25 });
  assert.deepEqual(result.listScroll, { active: 0, archive: 1e7 });
  assert.equal(result.collapsedProjects.length, 500);
  assert.equal(result.focusedProjectId, null);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.board), true);
  assert.equal(Object.isFrozen(result.collapsedProjects), true);
  preferences.destroy();
});

test('flush writes immediately; destroy flushes pending data and stops future updates', () => {
  const storage = memoryStorage();
  const preferences = createViewPreferences({ storage, delayMs: 10_000 });
  preferences.update({ search: 'pending' });
  assert.equal(preferences.flush(), true);
  assert.equal(JSON.parse(storage.value(VIEW_PREFERENCES_KEY)).search, 'pending');
  preferences.update({ search: 'on destroy' });
  preferences.destroy();
  const count = storage.writes;
  assert.equal(JSON.parse(storage.value(VIEW_PREFERENCES_KEY)).search, 'on destroy');
  preferences.update({ search: 'ignored' });
  assert.equal(storage.writes, count);
  assert.equal(preferences.read().search, 'on destroy');
});

test('saved views validate names and snapshots, stay browser-local, and remain deeply frozen', () => {
  const storage = memoryStorage();
  const preferences = createViewPreferences({ storage, delayMs: 10_000 });
  const snapshot = {
    activeScope: 'archive', board: { mode: 'board', x: 24, y: 8, zoom: 1.4 },
    archiveBoard: { mode: 'list', x: 2, y: 3, zoom: 0.75 }, search: 'q4', filterNeeds: true,
    suppressFilterExpansion: true, collapsedIslands: ['island_1'], collapsedProjects: ['project_2'],
    listScroll: { active: 10, archive: 500 },
    // Project organization is shared app data and must never enter a saved view.
    boardPositions: { island_1: { x: 500, y: 500 } },
  };
  assert.equal(preferences.saveView('   ', snapshot).reason, 'name');
  const saved = preferences.saveView(`  ${'A'.repeat(100)}  `, snapshot);
  assert.equal(saved.ok, true);
  assert.equal(saved.view.name.length, 80);
  assert.equal(saved.view.snapshot.activeScope, 'archive');
  assert.equal(saved.view.snapshot.suppressFilterExpansion, true);
  assert.equal('boardPositions' in saved.view.snapshot, false);
  assert.equal(Object.isFrozen(saved.view), true);
  assert.equal(Object.isFrozen(saved.view.snapshot), true);
  assert.equal(Object.isFrozen(saved.view.snapshot.board), true);
  assert.equal(Object.isFrozen(preferences.read().savedViews), true);
  assert.equal(preferences.flush(), true);

  const restarted = createViewPreferences({ storage });
  assert.equal(restarted.savedViews()[0].name.length, 80);
  assert.deepEqual(restarted.savedViews()[0].snapshot.listScroll, { active: 10, archive: 500 });
  const renamed = restarted.saveView('Sprint review', restarted.savedViews()[0].snapshot, saved.view.id);
  assert.equal(renamed.view.name, 'Sprint review');
  assert.equal(restarted.savedViews().length, 1);
  const removed = restarted.deleteView(saved.view.id);
  assert.equal(removed.name, 'Sprint review');
  assert.equal(restarted.savedViews().length, 0);
  assert.equal(restarted.restoreView(removed), true);
  assert.equal(restarted.savedViews()[0].name, 'Sprint review');
  preferences.destroy(); restarted.destroy();
});

test('saved views are bounded to 20 and malformed persisted entries are discarded', () => {
  const entries = [
    { id: 'bad id', name: 'Invalid ID', snapshot: {} },
    { id: 'view_1', name: '   ', snapshot: {} },
    ...Array.from({ length: 25 }, (_, index) => ({ id: `view_${index + 2}`, name: `View ${index}`, snapshot: {
      activeScope: index % 2 ? 'archive' : 'active', search: 'x'.repeat(600), filterNeeds: false,
      collapsedIslands: ['island_1', 'bad id'], suppressFilterExpansion: index % 2 === 1,
    } })),
  ];
  const storage = memoryStorage({ [VIEW_PREFERENCES_KEY]: JSON.stringify({ savedViews: entries }) });
  const preferences = createViewPreferences({ storage, delayMs: 10_000 });
  assert.equal(preferences.savedViews().length, 20);
  assert.equal(preferences.savedViews()[0].snapshot.search.length, 500);
  assert.deepEqual(preferences.savedViews()[0].snapshot.collapsedIslands, ['island_1']);
  assert.equal(preferences.saveView('At capacity', {}).reason, 'limit');
  preferences.destroy();
});
