import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeItems, snapIsland } from '../public/board-alignment.mjs';

const box = (id, x, y, width = 100, height = 60) => ({ id, x, y, width, height });

test('grid places items in input order without overlaps and uses measured dimensions', () => {
  const items = [box('a', 30, 80, 100, 80), box('b', 500, 2, 180, 60), box('c', 0, 20, 75, 110), box('d', 2, 4, 90, 50)];
  const result = arrangeItems(items, 'grid');
  assert.deepEqual(result, {
    a: { x: 0, y: 2 }, b: { x: 140, y: 2 }, c: { x: 360, y: 2 }, d: { x: 0, y: 152 },
  });
  assert.ok(result.a.x + items[0].width <= result.b.x);
  assert.ok(result.a.y + items[0].height <= result.d.y);
});

test('row and column preserve deterministic order and avoid overlap with variable sizes', () => {
  const items = [box('a', 40, 30, 120, 70), box('b', 10, 80, 50, 90), box('c', 70, 5, 80, 20)];
  assert.deepEqual(arrangeItems(items, 'row'), {
    a: { x: 10, y: 5 }, b: { x: 170, y: 5 }, c: { x: 260, y: 5 },
  });
  assert.deepEqual(arrangeItems(items, 'column'), {
    a: { x: 10, y: 5 }, b: { x: 10, y: 115 }, c: { x: 10, y: 245 },
  });
});

test('align actions use minimum board coordinate and preserve the other axis', () => {
  const items = [box('a', 30, 80), box('b', 12, 20), box('c', 45, 55)];
  assert.deepEqual(arrangeItems(items, 'align-left'), {
    a: { x: 12, y: 80 }, b: { x: 12, y: 20 }, c: { x: 12, y: 55 },
  });
  assert.deepEqual(arrangeItems(items, 'align-top'), {
    a: { x: 30, y: 20 }, b: { x: 12, y: 20 }, c: { x: 45, y: 20 },
  });
});

test('distribution spaces three or more items evenly and is a no-op for fewer', () => {
  const items = [box('a', 10, 20, 100), box('b', 180, 20, 50), box('c', 400, 20, 80)];
  assert.deepEqual(arrangeItems(items, 'space-horizontal'), {
    a: { x: 10, y: 20 }, b: { x: 230, y: 20 }, c: { x: 400, y: 20 },
  });
  const vertical = [box('a', 8, 10, 20, 50), box('b', 8, 100, 20, 20), box('c', 8, 230, 20, 40)];
  assert.deepEqual(arrangeItems(vertical, 'space-vertical'), {
    a: { x: 8, y: 10 }, b: { x: 8, y: 135 }, c: { x: 8, y: 230 },
  });
  assert.deepEqual(arrangeItems(items.slice(0, 2), 'space-horizontal'), {
    a: { x: 10, y: 20 }, b: { x: 180, y: 20 },
  });
  assert.deepEqual(arrangeItems(items.slice(0, 1), 'space-horizontal'), {
    a: { x: 10, y: 20 },
  });
});

test('distribution keeps existing positions if available span would force overlap', () => {
  const items = [box('a', 10, 0, 100), box('b', 40, 0, 100), box('c', 130, 0, 100)];
  assert.deepEqual(arrangeItems(items, 'space-horizontal'), {
    a: { x: 10, y: 0 }, b: { x: 40, y: 0 }, c: { x: 130, y: 0 },
  });
});

test('layout positions are finite, nonnegative and bounded', () => {
  const result = arrangeItems([box('a', Number.NaN, -20), box('b', 200_000, Infinity)], 'column');
  assert.deepEqual(result, { a: { x: 0, y: 0 }, b: { x: 0, y: 80 } });
  assert.deepEqual(arrangeItems([box('edge', 200_000, 0)], 'align-left'), { edge: { x: 100_000, y: 0 } });
  for (const point of Object.values(result)) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= 0 && point.y >= 0 && point.x <= 100_000 && point.y <= 100_000);
  }
});

test('snaps nearest x and y alignment within screen-space threshold at 25% and 200% zoom', () => {
  const moving = box('moving', 101, 103, 100, 60);
  const targets = [box('target', 100, 100, 100, 60)];
  const at25 = snapIsland(moving, targets, 0.25, 8);
  assert.deepEqual(at25, {
    x: 100, y: 100,
    guides: [
      { axis: 'x', position: 100, start: 100, end: 163 },
      { axis: 'y', position: 100, start: 100, end: 201 },
    ],
  });
  const at200 = snapIsland(moving, targets, 2, 8);
  assert.deepEqual(at200, {
    x: 100, y: 100,
    guides: [
      { axis: 'x', position: 100, start: 100, end: 163 },
      { axis: 'y', position: 100, start: 100, end: 201 },
    ],
  });
});

test('snaps edges and centers, and omits matches outside threshold', () => {
  const centerMoving = box('moving', 104, 106, 100, 60);
  const centerTarget = box('other', 100, 100, 112, 70);
  const snapped = snapIsland(centerMoving, [centerTarget], 1, 8);
  assert.deepEqual(snapped.guides.map(({ axis, position }) => [axis, position]), [['x', 156], ['y', 135]]);
  assert.equal(snapped.x, 106);
  assert.equal(snapped.y, 105);
  assert.deepEqual(snapIsland(box('m', 0, 0, 17, 13), [box('t', 30, 40, 11, 29)], 1, 8).guides, []);
});

test('snap excludes the moving id, chooses one deterministic nearest guide per axis, and clamps positions', () => {
  const moving = box('same', 2, 2, 40, 40);
  const targets = [box('same', 0, 0, 40, 40), box('b', 3, 0, 40, 40), box('a', 1, 0, 40, 40)];
  const result = snapIsland(moving, targets, 1, 8);
  assert.equal(result.guides.length, 2);
  assert.equal(result.guides[0].position, 1);
  assert.equal(result.guides[1].position, 0);
  assert.ok(result.x >= 0 && result.y >= 0);
});
