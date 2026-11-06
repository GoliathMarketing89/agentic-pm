import test from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, fitBounds, focusBounds, screenToWorld, worldToScreen, zoomAt } from '../public/board-view.mjs';

test('world and screen coordinates round trip', () => {
  const view = { mode: 'board', x: -140, y: 75, zoom: 1.4 };
  const point = { x: 810, y: 250 };
  const restored = screenToWorld(worldToScreen(point, view), view);
  assert.ok(Math.abs(restored.x - point.x) < 1e-9);
  assert.ok(Math.abs(restored.y - point.y) < 1e-9);
});

test('pointer anchored zoom keeps the world point under the pointer', () => {
  const view = { mode: 'board', x: 25, y: -30, zoom: 0.8 };
  const pointer = { x: 420, y: 310 };
  const before = screenToWorld(pointer, view);
  const next = zoomAt(view, 1.5, pointer);
  const after = screenToWorld(pointer, next);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
});

test('zoom is clamped to the board limits', () => {
  assert.equal(clampZoom(0.01), 0.25);
  assert.equal(clampZoom(12), 2);
  assert.equal(clampZoom(Number.NaN), 1);
});

test('fit bounds centers content and respects zoom limits', () => {
  const fitted = fitBounds({ x: 100, y: 80, width: 900, height: 500 }, { width: 1200, height: 800 });
  assert.equal(fitted.mode, 'board');
  assert.ok(fitted.zoom >= 0.25 && fitted.zoom <= 2);
  assert.ok(Math.abs(fitted.x + (100 + 450) * fitted.zoom - 600) < 1e-9);
  assert.ok(Math.abs(fitted.y + (80 + 250) * fitted.zoom - 400) < 1e-9);
});

test('compact fit honors its presentation ceiling and recenters the measured summary bounds', () => {
  const bounds = { x: 36, y: 1720, width: 500, height: 180 };
  const fitted = fitBounds(bounds, { width: 600, height: 420 }, 48, 0.59);
  assert.equal(fitted.zoom, 0.59);
  assert.ok(Math.abs(fitted.x + (bounds.x + bounds.width / 2) * fitted.zoom - 300) < 1e-9);
  assert.ok(Math.abs(fitted.y + (bounds.y + bounds.height / 2) * fitted.zoom - 210) < 1e-9);
});

test('focus centers a short island at a readable scale', () => {
  const bounds = { x: 450, y: 600, width: 390, height: 300 };
  const view = focusBounds(bounds, { width: 800, height: 600 });
  assert.equal(view.zoom, 1);
  assert.equal(view.x + (bounds.x + bounds.width / 2) * view.zoom, 400);
  assert.equal(view.y + (bounds.y + bounds.height / 2) * view.zoom, 300);
});

test('focus preserves readable scale for tall islands and fits width on narrow screens', () => {
  const bounds = { x: 100, y: 200, width: 390, height: 2000 };
  const view = focusBounds(bounds, { width: 320, height: 400 });
  assert.ok(view.zoom >= 0.6 && view.zoom <= 1);
  assert.ok(Math.abs(bounds.width * view.zoom - 256) < 1e-9);
  assert.ok(Math.abs(view.y + bounds.y * view.zoom - 32) < 1e-9);
  assert.ok(view.y + (bounds.y + bounds.height) * view.zoom > 400);
});
