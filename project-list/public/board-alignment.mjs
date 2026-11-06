const DEFAULT_GAP = 40;
const DEFAULT_COLUMNS = 3;
const DEFAULT_MAX_POSITION = 100_000;

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function limitPosition(value, maxPosition) {
  return Math.min(maxPosition, Math.max(0, finite(value)));
}

function normalizeItem(item) {
  return {
    ...item,
    id: item?.id,
    x: finite(item?.x),
    y: finite(item?.y),
    width: Math.max(0, finite(item?.width)),
    height: Math.max(0, finite(item?.height)),
  };
}

/**
 * Calculate positions for all supplied top-level board items.
 * Actions: grid, row, column, align-left, align-top,
 * space-horizontal, and space-vertical.
 */
export function arrangeItems(items, action, options = {}) {
  const source = Array.isArray(items) ? items : [];
  const maxPosition = Math.max(0, finite(options.maxPosition, DEFAULT_MAX_POSITION));
  const gap = Math.max(0, finite(options.gap, DEFAULT_GAP));
  const normalized = source.map(normalizeItem);
  const positions = new Map(normalized.map(item => [item.id, { x: limitPosition(item.x, maxPosition), y: limitPosition(item.y, maxPosition) }]));
  if (normalized.length === 0) return Object.fromEntries(positions);

  const minX = Math.min(...normalized.map(item => item.x));
  const minY = Math.min(...normalized.map(item => item.y));
  const assign = (item, x, y) => positions.set(item.id, {
    x: limitPosition(x, maxPosition),
    y: limitPosition(y, maxPosition),
  });

  if (action === 'align-left') {
    for (const item of normalized) assign(item, minX, item.y);
  } else if (action === 'align-top') {
    for (const item of normalized) assign(item, item.x, minY);
  } else if (action === 'row') {
    let x = minX;
    for (const item of normalized) {
      assign(item, x, minY);
      x += item.width + gap;
    }
  } else if (action === 'column') {
    let y = minY;
    for (const item of normalized) {
      assign(item, minX, y);
      y += item.height + gap;
    }
  } else if (action === 'grid') {
    const requestedColumns = Math.floor(finite(options.columns, DEFAULT_COLUMNS));
    const columns = Math.max(1, Math.min(normalized.length, requestedColumns || DEFAULT_COLUMNS));
    const rowHeights = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const row = Math.floor(index / columns);
      rowHeights[row] = Math.max(rowHeights[row] ?? 0, normalized[index].height);
    }
    const columnWidths = [];
    for (let index = 0; index < normalized.length; index += 1) {
      const column = index % columns;
      columnWidths[column] = Math.max(columnWidths[column] ?? 0, normalized[index].width);
    }
    const columnOffsets = [];
    for (let column = 0; column < columns; column += 1) {
      columnOffsets[column] = column === 0
        ? 0
        : columnOffsets[column - 1] + columnWidths[column - 1] + gap;
    }
    const rowOffsets = [];
    for (let row = 0; row < rowHeights.length; row += 1) {
      rowOffsets[row] = row === 0 ? 0 : rowOffsets[row - 1] + rowHeights[row - 1] + gap;
    }
    normalized.forEach((item, index) => {
      assign(item, minX + columnOffsets[index % columns], minY + rowOffsets[Math.floor(index / columns)]);
    });
  } else if (action === 'space-horizontal' || action === 'space-vertical') {
    const horizontal = action === 'space-horizontal';
    const axis = horizontal ? 'x' : 'y';
    const size = horizontal ? 'width' : 'height';
    const ordered = normalized.map((item, index) => ({ item, index }))
      .sort((a, b) => a.item[axis] - b.item[axis] || a.index - b.index);
    if (ordered.length >= 3) {
      const first = ordered[0].item;
      const last = ordered.at(-1).item;
      const available = last[axis] + last[size] - first[axis];
      const totalSize = ordered.reduce((sum, entry) => sum + entry.item[size], 0);
      const gapBetween = (available - totalSize) / (ordered.length - 1);
      // Keep the outer edges fixed when there's room; if there's not, do not
      // create overlapping items as a side effect of distribution.
      if (gapBetween >= 0) {
        let cursor = first[axis];
        for (const { item } of ordered) {
          assign(item, horizontal ? cursor : item.x, horizontal ? item.y : cursor);
          cursor += item[size] + gapBetween;
        }
      }
    }
  }

  return Object.fromEntries(positions);
}

function rect(item) {
  const normalized = normalizeItem(item);
  return { ...normalized, right: normalized.x + normalized.width, bottom: normalized.y + normalized.height };
}

/** Snap a dragged rectangle to the nearest board edge or center alignment. */
export function snapIsland(movingRect, otherRects, zoom, thresholdPx = 8) {
  const moving = rect(movingRect);
  const scale = Math.max(Number.EPSILON, finite(zoom, 1));
  const threshold = Math.max(0, finite(thresholdPx, 8)) / scale;
  const others = (Array.isArray(otherRects) ? otherRects : [])
    .filter(item => item?.id !== moving.id)
    .map(rect);
  const result = { x: limitPosition(moving.x, DEFAULT_MAX_POSITION), y: limitPosition(moving.y, DEFAULT_MAX_POSITION), guides: [] };

  for (const axis of ['x', 'y']) {
    const horizontal = axis === 'x';
    const movingStart = horizontal ? moving.x : moving.y;
    const movingSize = horizontal ? moving.width : moving.height;
    const movingEnd = movingStart + movingSize;
    const movingFeatures = [movingStart, movingStart + movingSize / 2, movingEnd];
    let best = null;
    for (const target of others) {
      const targetStart = horizontal ? target.x : target.y;
      const targetSize = horizontal ? target.width : target.height;
      const targetEnd = targetStart + targetSize;
      const targetFeatures = [targetStart, targetStart + targetSize / 2, targetEnd];
      for (let movingFeature = 0; movingFeature < movingFeatures.length; movingFeature += 1) {
        for (let targetFeature = 0; targetFeature < targetFeatures.length; targetFeature += 1) {
          const delta = targetFeatures[targetFeature] - movingFeatures[movingFeature];
          const distance = Math.abs(delta);
          const snappedStart = movingStart + delta;
          if (distance > threshold || snappedStart < 0 || snappedStart > DEFAULT_MAX_POSITION) continue;
          const candidate = {
            delta,
            distance,
            id: String(target.id ?? ''),
            movingFeature,
            targetFeature,
            position: targetFeatures[targetFeature],
            target,
          };
          if (!best || candidate.distance < best.distance || (
            candidate.distance === best.distance && (
              candidate.id.localeCompare(best.id) < 0 || (
                candidate.id === best.id && (candidate.movingFeature < best.movingFeature || (
                  candidate.movingFeature === best.movingFeature && candidate.targetFeature < best.targetFeature
                ))
              )
            )
          )) best = candidate;
        }
      }
    }
    if (!best) continue;
    if (horizontal) result.x = limitPosition(moving.x + best.delta, DEFAULT_MAX_POSITION);
    else result.y = limitPosition(moving.y + best.delta, DEFAULT_MAX_POSITION);
    const start = horizontal ? Math.min(moving.y, best.target.y) : Math.min(moving.x, best.target.x);
    const end = horizontal ? Math.max(moving.bottom, best.target.bottom) : Math.max(moving.right, best.target.right);
    result.guides.push({ axis, position: best.position, start, end });
  }
  return result;
}
