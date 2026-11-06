import { arrangeItems, snapIsland } from './board-alignment.mjs';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const DEFAULT_VIEW = Object.freeze({ mode: 'board', x: 32, y: 32, zoom: 1 });
const UNSORTED_KEY = '__unsorted__';

export function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(zoom) ? zoom : 1));
}

export function worldToScreen(point, view) {
  return { x: view.x + point.x * view.zoom, y: view.y + point.y * view.zoom };
}

export function screenToWorld(point, view) {
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

export function zoomAt(view, nextZoom, point) {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(point, view);
  return { ...view, zoom, x: point.x - world.x * zoom, y: point.y - world.y * zoom };
}

export function fitBounds(bounds, viewport, padding = 48, maxZoom = MAX_ZOOM) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { ...DEFAULT_VIEW };
  const zoom = clampZoom(Math.min(maxZoom, (viewport.width - padding * 2) / bounds.width, (viewport.height - padding * 2) / bounds.height));
  return { mode: 'board', zoom, x: (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (viewport.height - bounds.height * zoom) / 2 - bounds.y * zoom };
}

// Keep the header and initial contents visible even when an island is taller
// than the viewport; the user can pan to the rest without shrinking the text.
export function focusBounds(bounds, viewport, padding = 32) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { ...DEFAULT_VIEW };
  const zoom = Math.max(0.6, Math.min(1, (viewport.width - padding * 2) / bounds.width));
  const height = bounds.height * zoom;
  const top = height <= viewport.height - padding * 2 ? (viewport.height - height) / 2 : padding;
  return { mode: 'board', zoom, x: (viewport.width - bounds.width * zoom) / 2 - bounds.x * zoom, y: top - bounds.y * zoom };
}

function isEditable(target) {
  return !!target?.closest?.('input,textarea,select,button,a,summary,[contenteditable="true"],[data-drag-kind]');
}

function screenPoint(event, viewport) {
  const rect = viewport.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function createBoardView({ viewport, canvas, toolbar, modeToolbar = toolbar, initialView = DEFAULT_VIEW, getPositions = () => ({}), onPositionsChange = () => {}, onViewChange = () => {}, onError = () => {}, canMove = () => true }) {
  const abort = new AbortController();
  const { signal } = abort;
  let view = normalizeView(initialView);
  let spaceDown = false;
  let pan = null;
  let islandMove = null;
  let suppressClick = false;
  let destroyed = false;
  let focus = null;
  const guides = document.createElement('div');
  guides.className = 'board-alignment-guides';
  Object.assign(guides.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  viewport.append(guides);

  function clearGuides() { guides.replaceChildren(); }

  function showGuides(lines) {
    clearGuides();
    for (const line of lines) {
      const guide = document.createElement('div');
      guide.className = 'alignment-guide';
      const position = line.axis === 'x' ? view.x + line.position * view.zoom : view.y + line.position * view.zoom;
      const start = line.axis === 'x' ? view.y + line.start * view.zoom : view.x + line.start * view.zoom;
      const length = Math.max(0, (line.end - line.start) * view.zoom);
      Object.assign(guide.style, line.axis === 'x'
        ? { left: `${position}px`, top: `${start}px`, width: '1px', height: `${length}px` }
        : { left: `${start}px`, top: `${position}px`, width: `${length}px`, height: '1px' });
      guides.append(guide);
    }
  }

  function normalizeView(value) {
    const candidate = value && typeof value === 'object' ? value : DEFAULT_VIEW;
    return { mode: candidate.mode === 'list' ? 'list' : 'board', x: Number.isFinite(candidate.x) ? candidate.x : DEFAULT_VIEW.x, y: Number.isFinite(candidate.y) ? candidate.y : DEFAULT_VIEW.y, zoom: clampZoom(candidate.zoom) };
  }

  function topLevelItems() {
    return [...canvas.children].filter(node => node.matches('details.island[data-island-id], .unsorted-island'));
  }

  function keyFor(node) { return node.classList.contains('unsorted-island') ? UNSORTED_KEY : node.dataset.islandId; }

  function normalizeBoardScroll() {
    if (view.mode !== 'board') return;
    if (viewport.scrollTop !== 0) viewport.scrollTop = 0;
    if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
  }

  function applyCamera() {
    viewport.style.setProperty('--board-zoom', String(view.zoom));
    viewport.classList.toggle('board-zoom-compact', view.zoom < 0.6);
    viewport.classList.toggle('board-mode-active', view.mode === 'board');
    viewport.classList.toggle('list-mode-active', view.mode === 'list');
    viewport.classList.toggle('board-focus-active', !!focus);
    toolbar.classList.toggle('board-focus-active', !!focus);
    const back = toolbar.querySelector('.board-focus-back');
    if (back) back.hidden = !focus;
    normalizeBoardScroll();
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    for (const button of [...toolbar.querySelectorAll('[data-board-mode]'), ...modeToolbar.querySelectorAll('[data-board-mode]')]) {
      const selected = button.dataset.boardMode === view.mode;
      button.setAttribute('aria-pressed', String(selected));
    }
    const label = toolbar.querySelector('.board-zoom-label');
    if (label) label.textContent = `${Math.round(view.zoom * 100)}%`;
  }

  function setView(next, settled = true) {
    clearGuides();
    view = normalizeView(next);
    applyCamera();
    if (settled) onViewChange(getView());
  }

  function setMode(mode) {
    const base = focus?.overview || view;
    focus = null;
    setView({ ...base, mode: mode === 'list' ? 'list' : 'board' });
  }

  function fallbackPositions(items) {
    const positions = {};
    let rowY = 36;
    for (let row = 0; row < Math.ceil(items.length / 3); row += 1) {
      const rowItems = items.slice(row * 3, row * 3 + 3);
      let rowHeight = 110;
      for (const node of rowItems) {
        node.classList.add('board-positioned');
        rowHeight = Math.max(rowHeight, node.offsetHeight);
      }
      rowItems.forEach((node, column) => {
        positions[keyFor(node)] = { x: 36 + column * 430, y: rowY };
      });
      rowY += rowHeight + 36;
    }
    return positions;
  }

  function refresh() {
    if (destroyed) return;
    const items = topLevelItems();
    for (const node of items) node.classList.add('board-positioned');
    const saved = getPositions() || {};
    const fallback = fallbackPositions(items);
    for (const node of items) {
      const point = saved[keyFor(node)] || fallback[keyFor(node)];
      node.classList.add('board-positioned');
      node.style.left = `${point.x}px`;
      node.style.top = `${point.y}px`;
    }
    const moveSelect = toolbar.querySelector('.board-move-select');
    if (moveSelect) {
      const selected = moveSelect.value;
      moveSelect.replaceChildren();
      for (const node of items) {
        const option = document.createElement('option'); option.value = keyFor(node);
        option.textContent = node.classList.contains('unsorted-island') ? 'Unsorted' : node.querySelector(':scope > summary .island-title strong')?.textContent?.trim() || 'Island';
        moveSelect.append(option);
      }
      if (items.some(node => keyFor(node) === selected)) moveSelect.value = selected;
    }
    applyCamera();
  }

  function getView() { return { ...view }; }

  function restoreView(next) { focus = null; setView(next); }

  function focusIsland(value) {
    if (view.mode !== 'board') return false;
    const node = typeof value === 'string' ? [...canvas.querySelectorAll('details.island[data-island-id]')].find(item => item.dataset.islandId === value) : value;
    if (!node || !canvas.contains(node) || !node.matches('details.island[data-island-id]')) return false;
    if (!focus) focus = { overview: getView() };
    node.open = true;
    for (let ancestor = node.parentElement?.closest('details.island'); ancestor && canvas.contains(ancestor); ancestor = ancestor.parentElement?.closest('details.island')) ancestor.open = true;
    // Clear compact layout before measuring the now-expanded island.
    setView({ ...view, zoom: 1 }, false);
    const rect = viewport.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const bounds = { x: (nodeRect.left - canvasRect.left) / view.zoom, y: (nodeRect.top - canvasRect.top) / view.zoom, width: nodeRect.width / view.zoom, height: nodeRect.height / view.zoom };
    setView(focusBounds(bounds, { width: rect.width, height: rect.height }));
    return true;
  }

  function exitFocus() {
    if (!focus) return false;
    const overview = focus.overview;
    focus = null;
    setView(overview);
    return true;
  }

  function emitPositions() {
    const positions = { ...(getPositions() || {}) };
    for (const node of topLevelItems()) positions[keyFor(node)] = { x: Number.parseFloat(node.style.left) || 0, y: Number.parseFloat(node.style.top) || 0 };
    Promise.resolve(onPositionsChange(positions)).catch(onError);
  }

  function itemRects() {
    return topLevelItems().map(node => ({ id: keyFor(node), x: Number.parseFloat(node.style.left) || 0, y: Number.parseFloat(node.style.top) || 0, width: node.offsetWidth, height: node.offsetHeight }));
  }

  function tidy(action) {
    if (view.mode !== 'board' || !canMove()) return;
    const nodes = topLevelItems();
    const positions = arrangeItems(itemRects(), action);
    for (const node of nodes) {
      const point = positions[keyFor(node)];
      if (!point) continue;
      node.style.left = `${point.x}px`; node.style.top = `${point.y}px`;
    }
    clearGuides();
    emitPositions();
  }

  function boardBounds() {
    const items = topLevelItems();
    if (!items.length) return null;
    const rects = items.map(node => ({ x: Number.parseFloat(node.style.left) || 0, y: Number.parseFloat(node.style.top) || 0, width: Math.max(320, node.offsetWidth), height: Math.max(110, node.offsetHeight) }));
    const x = Math.min(...rects.map(rect => rect.x));
    const y = Math.min(...rects.map(rect => rect.y));
    const right = Math.max(...rects.map(rect => rect.x + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  function fit() {
    focus = null;
    const rect = viewport.getBoundingClientRect();
    const viewportSize = { width: rect.width, height: rect.height };
    // Measure expanded islands first so Fit makes the same compact/full choice
    // regardless of the zoom state the user had before pressing it.
    setView({ ...view, mode: 'board', zoom: 1 }, false);
    const expandedFit = fitBounds(boardBounds(), viewportSize);
    if (expandedFit.zoom >= 0.6) {
      setView(expandedFit);
      return;
    }
    // Apply summary layout before measuring. Cap the final fit below the compact
    // threshold so measuring the full layout and summary layout cannot oscillate.
    setView({ ...view, mode: 'board', zoom: 0.59 }, false);
    const summaryFit = fitBounds(boardBounds(), viewportSize, 48, 0.59);
    setView(summaryFit);
  }

  function reveal(element) {
    if (!element || !canvas.contains(element)) return false;
    normalizeBoardScroll();
    const targetRect = element.getBoundingClientRect();
    const viewRect = viewport.getBoundingClientRect();
    const width = Math.max(1, targetRect.width / Math.max(view.zoom, MIN_ZOOM));
    const height = Math.max(1, targetRect.height / Math.max(view.zoom, MIN_ZOOM));
    const zoom = clampZoom(Math.min(1, (viewRect.width - 72) / width, (viewRect.height - 72) / height));
    const p = { x: targetRect.left + targetRect.width / 2 - viewRect.left, y: targetRect.top + targetRect.height / 2 - viewRect.top };
    const world = screenToWorld(p, view);
    setView({ mode: 'board', zoom, x: viewRect.width / 2 - world.x * zoom, y: viewRect.height / 2 - world.y * zoom });
    return true;
  }

  function installToolbar() {
    toolbar.classList.add('board-toolbar');
    toolbar.replaceChildren();
    const modes = document.createElement('div'); modes.className = 'board-mode-switch'; modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Workspace layout');
    for (const [mode, label] of [['board', 'Board'], ['list', 'List']]) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.boardMode = mode; button.textContent = label;
      button.addEventListener('click', () => setMode(mode), { signal }); modes.append(button);
    }
    const zoomGroup = document.createElement('div'); zoomGroup.className = 'board-zoom-controls'; zoomGroup.setAttribute('role', 'group'); zoomGroup.setAttribute('aria-label', 'Board zoom');
    const back = document.createElement('button'); back.type = 'button'; back.className = 'board-focus-back'; back.textContent = 'Back to overview'; back.hidden = true;
    back.addEventListener('click', exitFocus, { signal });
    const addButton = (label, title, action) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', action, { signal }); zoomGroup.append(button); };
    addButton('−', 'Zoom out', () => setView(zoomAt(view, view.zoom / 1.2, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 })));
    const percent = document.createElement('span'); percent.className = 'board-zoom-label'; percent.setAttribute('aria-live', 'polite'); zoomGroup.append(percent);
    addButton('+', 'Zoom in', () => setView(zoomAt(view, view.zoom * 1.2, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 })));
    addButton('Fit', 'Fit all islands', fit);
    addButton('Reset', 'Reset zoom and position', () => { focus = null; setView(DEFAULT_VIEW); });
    const arrange = document.createElement('details'); arrange.className = 'board-arrange';
    const arrangeSummary = document.createElement('summary'); arrangeSummary.className = 'board-arrange-toggle'; arrangeSummary.textContent = 'Arrange'; arrange.append(arrangeSummary);
    const moveGroup = document.createElement('div'); moveGroup.className = 'board-arrange-popover board-move-controls'; moveGroup.setAttribute('role', 'group'); moveGroup.setAttribute('aria-label', 'Keyboard accessible island positioning');
    const moveSelect = document.createElement('select'); moveSelect.className = 'board-move-select'; moveSelect.setAttribute('aria-label', 'Choose island to move'); moveGroup.append(moveSelect);
    for (const [dx, dy, label, title] of [[-1, 0, '←', 'Move selected island left'], [0, -1, '↑', 'Move selected island up'], [0, 1, '↓', 'Move selected island down'], [1, 0, '→', 'Move selected island right']]) {
      addNudgeButton(moveGroup, label, title, dx, dy);
    }
    arrange.append(moveGroup);
    const tidyMenu = document.createElement('details'); tidyMenu.className = 'board-tidy-disclosure';
    const tidySummary = document.createElement('summary'); tidySummary.textContent = 'Tidy up'; tidyMenu.append(tidySummary);
    const tidyOptions = document.createElement('div'); tidyOptions.className = 'board-tidy-options';
    for (const [action, label] of [['grid', 'Grid'], ['row', 'Row'], ['column', 'Column'], ['align-left', 'Align left'], ['align-top', 'Align top'], ['space-horizontal', 'Distribute horizontally'], ['space-vertical', 'Distribute vertically']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => { tidy(action); tidyMenu.open = false; }, { signal }); tidyOptions.append(button);
    }
    tidyMenu.append(tidyOptions);
    modeToolbar.replaceChildren(modes);
    toolbar.append(back, zoomGroup, arrange, tidyMenu);
  }

  function addNudgeButton(group, label, title, dx, dy) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = title; button.setAttribute('aria-label', title);
    button.addEventListener('click', () => {
      if (!canMove()) return;
      const key = toolbar.querySelector('.board-move-select')?.value;
      const node = topLevelItems().find(item => keyFor(item) === key);
      if (!node) return;
      const x = Math.max(0, (Number.parseFloat(node.style.left) || 0) + dx * 40);
      const y = Math.max(0, (Number.parseFloat(node.style.top) || 0) + dy * 40);
      node.style.left = `${x}px`; node.style.top = `${y}px`;
      emitPositions();
    }, { signal });
    group.append(button);
  }

  installToolbar();
  viewport.tabIndex = viewport.tabIndex >= 0 ? viewport.tabIndex : 0;
  viewport.setAttribute('aria-label', 'Project whiteboard. Drag empty space to pan; use arrow keys to pan and plus or minus to zoom.');
  viewport.addEventListener('scroll', normalizeBoardScroll, { passive: true, signal });

  viewport.addEventListener('wheel', event => {
    if (view.mode !== 'board') return;
    event.preventDefault();
    if (event.ctrlKey) setView(zoomAt(view, view.zoom * Math.exp(-event.deltaY * 0.002), screenPoint(event, viewport)));
    else setView({ ...view, x: view.x - event.deltaX, y: view.y - event.deltaY });
  }, { passive: false, signal });

  viewport.addEventListener('pointerdown', event => {
    if (view.mode !== 'board' || event.button !== 0) return;
    const heading = event.target.closest?.('.island-heading');
    const island = heading?.closest('details.island[data-island-id]');
    // Summary is both a click-to-expand control and the island's board handle.
    // Only controls inside it are excluded; the title and grip remain draggable.
    if (island && island.parentElement === canvas && canMove() && !event.target.closest('input,textarea,select,button,a,[contenteditable="true"]')) {
      islandMove = { node: island, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { x: Number.parseFloat(island.style.left) || 0, y: Number.parseFloat(island.style.top) || 0 }, moved: false };
      heading.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.target === viewport || event.target === canvas || spaceDown && !isEditable(event.target)) {
      pan = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { x: view.x, y: view.y } };
      viewport.setPointerCapture?.(event.pointerId);
    }
  }, { signal });

  canvas.addEventListener('dragstart', event => {
    // The grip uses native drag/drop for nesting in List mode. On the board,
    // outer headers belong to pointer positioning instead of native nesting.
    if (islandMove) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, signal });

  viewport.addEventListener('pointermove', event => {
    if (islandMove?.pointerId === event.pointerId) {
      const dx = event.clientX - islandMove.start.x, dy = event.clientY - islandMove.start.y;
      if (!islandMove.moved && Math.hypot(dx, dy) > 5) { islandMove.moved = true; islandMove.node.classList.add('board-moving'); }
      if (islandMove.moved) {
        event.preventDefault();
        const x = Math.max(0, islandMove.origin.x + dx / view.zoom), y = Math.max(0, islandMove.origin.y + dy / view.zoom);
        const rects = itemRects();
        const current = rects.find(rect => rect.id === keyFor(islandMove.node));
        const snapped = snapIsland({ ...current, x, y }, rects, view.zoom);
        islandMove.node.style.left = `${Math.max(0, snapped.x)}px`;
        islandMove.node.style.top = `${Math.max(0, snapped.y)}px`;
        showGuides(snapped.guides);
      }
      return;
    }
    if (pan?.pointerId === event.pointerId) {
      setView({ ...view, x: pan.origin.x + event.clientX - pan.start.x, y: pan.origin.y + event.clientY - pan.start.y }, false);
      event.preventDefault();
    }
  }, { signal });

  function endPointer(event) {
    if (islandMove?.pointerId === event.pointerId) {
      const current = islandMove;
      islandMove = null;
      clearGuides();
      current.node.classList.remove('board-moving');
      if (event.type === 'pointercancel') {
        current.node.style.left = `${current.origin.x}px`; current.node.style.top = `${current.origin.y}px`;
      } else if (current.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); emitPositions(); onViewChange(getView()); }
    }
    if (pan?.pointerId === event.pointerId) { pan = null; onViewChange(getView()); }
  }
  viewport.addEventListener('pointerup', endPointer, { signal });
  viewport.addEventListener('pointercancel', endPointer, { signal });
  canvas.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; } }, { capture: true, signal });
  canvas.addEventListener('dblclick', event => {
    if (view.mode !== 'board' || event.target.closest?.('button,a,input,textarea,select,[contenteditable="true"],.drag-grip')) return;
    const heading = event.target.closest?.('.island-heading');
    const island = heading?.closest('details.island[data-island-id]');
    if (!island || !canvas.contains(island) || heading.parentElement !== island) return;
    event.preventDefault();
    focusIsland(island);
  }, { signal });

  window.addEventListener('keydown', event => {
    if (event.code === 'Space' && !isEditable(event.target)) { spaceDown = true; if (view.mode === 'board') event.preventDefault(); }
    if (view.mode !== 'board' || isEditable(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 120 : 48;
    if (event.key === 'ArrowLeft') setView({ ...view, x: view.x + step });
    else if (event.key === 'ArrowRight') setView({ ...view, x: view.x - step });
    else if (event.key === 'ArrowUp') setView({ ...view, y: view.y + step });
    else if (event.key === 'ArrowDown') setView({ ...view, y: view.y - step });
    else if (event.key === '+' || event.key === '=') setView(zoomAt(view, view.zoom * 1.15, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }));
    else if (event.key === '-') setView(zoomAt(view, view.zoom / 1.15, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }));
    else return;
    event.preventDefault();
  }, { signal });
  window.addEventListener('keyup', event => { if (event.code === 'Space') spaceDown = false; }, { signal });

  const observer = new MutationObserver(() => refresh());
  observer.observe(canvas, { childList: true, subtree: true });
  refresh();
  applyCamera();

  return {
    setMode,
    restoreView,
    getView,
    refresh,
    reveal,
    focusIsland,
    exitFocus,
    destroy() {
      destroyed = true;
      observer.disconnect(); abort.abort();
      guides.remove();
      viewport.classList.remove('board-mode-active', 'list-mode-active', 'board-zoom-compact', 'board-focus-active');
      canvas.style.removeProperty('transform');
      for (const node of topLevelItems()) { node.classList.remove('board-positioned', 'board-moving'); node.style.removeProperty('left'); node.style.removeProperty('top'); }
      toolbar.replaceChildren(); toolbar.classList.remove('board-toolbar', 'board-focus-active');
      if (modeToolbar !== toolbar) modeToolbar.replaceChildren();
    },
  };
}
