// Gesture compositor for the real ComfyUI canvas on a phone.
//
// Problem: every pan/pinch frame makes LiteGraph redraw the whole graph (~100 ms on a throttled phone CPU) and blit a
// multi-megapixel backing store, so gestures run at ~16 fps. Fix: while two fingers pan/pinch (or one finger drags on
// EMPTY canvas) we do not redraw at all. We CSS-transform the canvas element that already shows the graph (GPU
// compositing), hide the DOM widgets, and when the last finger lifts we convert the accumulated transform exactly into
// ds.offset / ds.scale, remove the transform and draw once.
//
// One-finger drags that start on a node, slot, widget, group title, reroute... are never touched, so moving nodes and
// connecting links stay LiteGraph's job. A tap (< 8 px, < 250 ms) passes through as a normal click.
// ONE finger dragging on EMPTY canvas follows the pref `emptyDrag`: 'none' (default, nothing happens, a tap still deselects),
// 'pan' (the compositor), 'box' (our own selection rectangle). TWO fingers always pan / pinch.
// Menus: the canvas must never open a context menu by itself on touch. We block (a) the native `contextmenu` event Android Chrome
// fires on a long press and (b) the synthetic right-button pointerdown/up the frontend's SimpleTouchSupport dispatches when a single
// touch lasted > 600 ms (that one fired after EVERY slow drag). Menus come from the toolbar (Menu button / opt-in long-press).
//
// Coordinate model (canvas-element CSS px, origin = canvas top-left):  screen = (graph + offset) * scale
//   CSS transform T = {k, tx, ty}:  p' = k * p + tx/ty        (transform-origin 0 0)
//   cssToDs:  scale' = k * scale,  offset' = offset + t / (k * scale)       -> the graph point under any finger is kept.
//
// The pure math below has no DOM dependency (tests/test_gestures.mjs).

export const TAP_MAX_MOVE = 8;     // px: a pointer that stays within this is a tap, beyond it a drag
export const TAP_MAX_MS = 250;     // ms
export const MIN_PINCH_DIST = 1;   // px: guards a divide by ~0 when both fingers start on the same spot

// ---------------------------------------------------------------- pure math
export const identity = () => ({ k: 1, tx: 0, ty: 0 });

/** Apply `a` first, then `b`:  p -> b(a(p)). */
export function composeTransform(a, b) {
  return { k: a.k * b.k, tx: b.k * a.tx + b.tx, ty: b.k * a.ty + b.ty };
}

export function applyTransform(T, p) { return [T.k * p[0] + T.tx, T.k * p[1] + T.ty]; }

/** Summary of the fingers: centroid + distance (distance is null for one finger). pts = [[x,y],...] (1 or 2 used). */
export function fingerFrame(pts) {
  if (pts.length >= 2) {
    const [a, b] = pts;
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, d: Math.max(MIN_PINCH_DIST, Math.hypot(a[0] - b[0], a[1] - b[1])) };
  }
  return { cx: pts[0][0], cy: pts[0][1], d: null };
}

/** The transform that moves the start frame onto the current frame: the point under the start centroid ends under the current one. */
export function gestureTransform(start, now) {
  const k = start.d && now.d ? now.d / start.d : 1;
  return { k, tx: now.cx - k * start.cx, ty: now.cy - k * start.cy };
}

/** ds = {scale, offset:[x,y]}; screen position (canvas-element css px) of a graph point, and back. */
export const graphToScreen = (ds, g) => [(g[0] + ds.offset[0]) * ds.scale, (g[1] + ds.offset[1]) * ds.scale];
export const screenToGraph = (ds, p) => [p[0] / ds.scale - ds.offset[0], p[1] / ds.scale - ds.offset[1]];

/**
 * Clamp the transform so the resulting scale stays within [min, max]. The focal point (screen position `focal`, canvas
 * css px) keeps showing the same old-bitmap point it showed before clamping, so the view does not jump.
 */
export function clampTransform(ds, T, focal, min, max) {
  const wanted = T.k * ds.scale;
  const clamped = Math.min(max, Math.max(min, wanted));
  if (clamped === wanted) return T;
  const k = clamped / ds.scale;
  // old-bitmap point under the focal point with the unclamped transform, pinned to the same screen spot with the new k
  const px = (focal[0] - T.tx) / T.k, py = (focal[1] - T.ty) / T.k;
  return { k, tx: focal[0] - k * px, ty: focal[1] - k * py };
}

/** Exact conversion of a CSS transform on the drawn canvas into the view LiteGraph must have so a redraw looks the same. */
export function cssToDs(ds, T) {
  const scale = T.k * ds.scale;
  return { scale, offset: [ds.offset[0] + T.tx / scale, ds.offset[1] + T.ty / scale] };
}

export const movedBeyondTap = (dx, dy) => Math.hypot(dx, dy) >= TAP_MAX_MOVE;
/** A tap: the pointer barely moved and was released quickly. */
export const isTap = (dist, ms) => dist < TAP_MAX_MOVE && ms < TAP_MAX_MS;

// ---------------------------------------------------------------- hit test (LiteGraph API)
const SLOT_PAD = 40;   // graph units: only nodes whose bounds (inflated) contain the point get the slot test

function overSlot(canvas, node, x, y) {
  const pos = [0, 0];
  try {
    if (canvas.isOverNodeInput && canvas.isOverNodeInput(node, x, y, pos) !== -1) return true;
    if (canvas.isOverNodeOutput && canvas.isOverNodeOutput(node, x, y, pos) !== -1) return true;
  } catch { /* fall through to the geometric test */ }
  // geometric fallback, same 30x20 box LiteGraph uses for slot clicks
  for (const [list, getPos] of [[node.inputs, (i) => node.getInputPos(i)], [node.outputs, (i) => node.getOutputPos(i)]]) {
    if (!list) continue;
    for (let i = 0; i < list.length; i++) {
      const p = getPos(i);
      if (p && x >= p[0] - 15 && x <= p[0] + 15 && y >= p[1] - 10 && y <= p[1] + 10) return true;
    }
  }
  return false;
}

/**
 * What is under the graph point (x, y)?  'empty' = a drag may pan.  Everything else belongs to LiteGraph:
 *   'node' (body/title/widget), 'slot', 'other' (group title/resize handle, reroute, subgraph IO node).
 */
export function hitKind(canvas, x, y) {
  const graph = canvas.graph;
  if (!graph) return 'other';
  // slots first: an input/output dot can sit inside the node box, and LiteGraph starts a link drag there
  for (const n of graph._nodes || []) {
    const b = n.boundingRect || n.getBounding?.();
    if (!b) continue;
    if (x < b[0] - SLOT_PAD || y < b[1] - SLOT_PAD || x > b[0] + b[2] + SLOT_PAD || y > b[1] + b[3] + SLOT_PAD) continue;
    if (overSlot(canvas, n, x, y)) return 'slot';
  }
  if (graph.getNodeOnPos(x, y)) return 'node';
  if (graph.getGroupTitlebarOnPos?.(x, y)) return 'other';
  for (const g of graph._groups || []) if (g.isInResize?.(x, y)) return 'other';
  for (const r of canvas._visibleReroutes || []) if (r.containsPoint?.([x, y])) return 'other';
  const sg = canvas.subgraph;
  if (sg && (sg.inputNode?.containsPoint?.([x, y]) || sg.outputNode?.containsPoint?.([x, y]))) return 'other';
  return 'empty';
}

// ---------------------------------------------------------------- the compositor
/**
 * Install the compositor on the ComfyUI app (app.canvas is the LGraphCanvas). Returns a handle:
 *   { enabled, uninstall(), gesturing }   — `enabled=false` lets all touches through to LiteGraph (used for A/B measurements).
 * Options: { widgets: 'hide' | 'move' } how DOM widgets (textareas...) follow the gesture.
 */
export function install(app, opts = {}) {
  if (app.__pocketGestures) return app.__pocketGestures;
  const lg = app.canvas;
  const el = lg.canvas;                                   // the canvas element that shows the graph
  const widgetsMode = opts.widgets || 'hide';
  const ptrs = new Map();                                 // pointerId -> {id,x0,y0,x,y,t0,kind,mode}
  let g = null;                                           // active gesture
  let suppressClickUntil = 0;
  let raf = 0;
  let prefs = { emptyDrag: 'none', ...(opts.prefs && opts.prefs.get ? opts.prefs.get() : {}) };   // live: setPrefs() / the shared store
  const unsub = opts.prefs && opts.prefs.subscribe ? opts.prefs.subscribe((p) => { prefs = { ...prefs, ...p }; }) : null;
  const hooks = [];                                       // fn(pointerEvent): see every touch/pen pointer event before we swallow it

  const handle = { enabled: true, hooks, get prefs() { return prefs; }, setPrefs(p) { prefs = { ...prefs, ...p }; }, get gesturing() { return !!g; },
    get pointers() { return [...ptrs.values()].map((p) => ({ id: p.id, kind: p.kind, mode: p.mode })); }, uninstall };

  const linkDragging = () => !!lg.linkConnector?.isConnecting;   // a link drag owns the gesture: never take it over
  const widgetEls = () => [...document.querySelectorAll('.dom-widget')];

  function beginGesture(first) {
    const rect = el.getBoundingClientRect();
    // LiteGraph already saw this pointer go down (it may have armed a click / a canvas drag): cancel that cleanly.
    // pointer.finally holds LiteGraph's cleanup (e.g. linkConnector.reset); reset() would drop it unrun.
    try { lg.pointer.finally?.(); } catch { /* ignore */ }
    try { lg.pointer.reset(); } catch { /* ignore */ }
    try { if (linkDragging()) lg.linkConnector.reset(true); } catch { /* ignore */ }
    const ds = lg.ds;
    g = {
      rect,
      base: { scale: ds.scale, offset: [ds.offset[0], ds.offset[1]] },   // view when the gesture started
      T0: identity(),                                    // transform accumulated before the current finger set
      T: identity(), start: null, focal: [0, 0],
      prevPause: lg.pause_rendering, hadOwnDraw: Object.prototype.hasOwnProperty.call(lg, 'draw'), ownDraw: lg.draw,
      widgets: widgetEls(),
      minScale: ds.min_scale ?? 0.1, maxScale: ds.max_scale ?? 10,
    };
    // 1. no redraws while the gesture runs
    lg.pause_rendering = true;
    lg.draw = () => {};
    // 2. DOM widgets: hide (or later move) so they do not sit at stale positions over the transformed bitmap
    for (const w of g.widgets) {
      if (!w.hasAttribute('data-mg-vis')) w.setAttribute('data-mg-vis', w.style.visibility);   // original, only if not already ours
      if (widgetsMode === 'hide') w.style.visibility = 'hidden';
    }
    el.style.transformOrigin = '0 0';
    el.style.willChange = 'transform';
    rebase(first);
  }

  const active = () => [...ptrs.values()].filter((p) => p.mode === 'gesture').sort((a, b) => a.id - b.id).slice(0, 2);
  const rel = (p) => [p.x - g.rect.left, p.y - g.rect.top];

  // (Re)start the finger frame from the fingers that are down now; what was accumulated so far is kept in T0.
  function rebase(first) {
    if (g.start) g.T0 = g.T;
    const fs = active();
    const pts = fs.map((p) => (p === first && fs.length === 1 ? [p.x0 - g.rect.left, p.y0 - g.rect.top] : rel(p)));
    g.start = fingerFrame(pts);
    update();
  }

  function update() {
    const fs = active();
    if (!fs.length) return;
    const now = fingerFrame(fs.map(rel));
    g.focal = [now.cx, now.cy];
    let T = composeTransform(g.T0, gestureTransform(g.start, now));
    g.T = clampTransform(g.base, T, g.focal, g.minScale, g.maxScale);
  }

  function paint() {
    raf = 0;
    if (!g) return;
    const { k, tx, ty } = g.T;
    el.style.transform = `matrix(${k},0,0,${k},${tx},${ty})`;
  }
  const schedulePaint = () => { if (!raf) raf = requestAnimationFrame(paint); };

  function endGesture() {
    if (!g) return;
    const s = g;
    g = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const ds = lg.ds;
    const v = cssToDs(s.base, s.T);
    ds.scale = v.scale;
    ds.offset[0] = v.offset[0];
    ds.offset[1] = v.offset[1];
    if (s.hadOwnDraw) lg.draw = s.ownDraw; else delete lg.draw;
    lg.pause_rendering = s.prevPause;
    try {
      // draw once, and only then drop the transform so bitmap swap and transform removal share a frame
      lg.setDirty(true, true);
      lg.draw(true, true);
    } finally {
      el.style.transform = '';
      el.style.willChange = '';
      el.style.transformOrigin = '';
      for (const w of s.widgets) {
        if (!w.hasAttribute('data-mg-vis')) continue;
        w.style.visibility = w.getAttribute('data-mg-vis');
        w.removeAttribute('data-mg-vis');
      }
    }
    // the browser may still emit a synthetic click for the last finger: it must not select/deselect anything
    suppressClickUntil = performance.now() + 400;
  }

  const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
  const isTouchOnCanvas = (e) => e.pointerType === 'touch' && e.target === el;

  // ---- touch recency (the synthetic menu events are only blocked around real touches, never for a real mouse)
  const touchIds = new Set();
  let lastTouchEnd = 0;
  const touchy = () => touchIds.size > 0 || performance.now() - lastTouchEnd < 800;
  const runHooks = (e) => { for (const h of hooks) { try { h(e); } catch (err) { console.warn('[gestures hook]', err); } } };
  function track(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      if (e.type === 'pointerdown') touchIds.add(e.pointerId); else { touchIds.delete(e.pointerId); lastTouchEnd = performance.now(); }
      runHooks(e);
    } else if (e.pointerType === 'mouse' && e.isTrusted && e.type === 'pointerdown') { touchIds.clear(); lastTouchEnd = 0; }
  }
  function trackMove(e) { if (e.pointerType === 'touch' || e.pointerType === 'pen') runHooks(e); }
  // (a) Android's native long-press `contextmenu` (and any other contextmenu that arrives while a finger is on the glass)
  function onContextMenu(e) {
    if (e.target !== el) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen' || touchy()) { e.preventDefault(); e.stopImmediatePropagation(); handle.blockedMenus = (handle.blockedMenus || 0) + 1; }
  }
  // (b) SimpleTouchSupport: a single touch > 600 ms ending on the canvas dispatches pointerdown/up {button:2} (no pointerType) = right click
  function onFakeRightClick(e) {
    if (e.target === el && e.button === 2 && !e.isTrusted && e.pointerType !== 'mouse' && touchy()) {
      e.preventDefault(); e.stopImmediatePropagation(); handle.blockedMenus = (handle.blockedMenus || 0) + 1;
    }
  }

  // ---- one-finger box select (pref emptyDrag = 'box')
  let box = null;
  function cancelLiteGraphPointer() {
    try { lg.pointer.finally?.(); } catch { /* ignore */ }
    try { lg.pointer.reset(); } catch { /* ignore */ }
  }
  function boxStart(p) {
    cancelLiteGraphPointer();
    const d = document.createElement('div');
    d.setAttribute('data-mg-box', '1');
    d.style.cssText = 'position:fixed;z-index:999;pointer-events:none;border:1px dashed #4da3ff;background:rgba(77,163,255,.16);box-sizing:border-box;';
    document.body.appendChild(d);
    box = { el: d };
    boxMove(p);
  }
  function boxMove(p) {
    if (!box) return;
    const s = box.el.style;
    s.left = Math.min(p.x0, p.x) + 'px'; s.top = Math.min(p.y0, p.y) + 'px';
    s.width = Math.abs(p.x - p.x0) + 'px'; s.height = Math.abs(p.y - p.y0) + 'px';
  }
  function boxEnd(p, apply) {
    if (!box) return;
    box.el.remove(); box = null;
    if (!apply || !p) return;
    const r = el.getBoundingClientRect();
    const a = screenToGraph(lg.ds, [p.x0 - r.left, p.y0 - r.top]), b = screenToGraph(lg.ds, [p.x - r.left, p.y - r.top]);
    const x1 = Math.min(a[0], b[0]), y1 = Math.min(a[1], b[1]), x2 = Math.max(a[0], b[0]), y2 = Math.max(a[1], b[1]);
    const items = [];
    for (const n of lg.graph?._nodes || []) {
      const bb = n.boundingRect || n.getBounding?.();
      if (bb && bb[0] < x2 && bb[0] + bb[2] > x1 && bb[1] < y2 && bb[1] + bb[3] > y1) items.push(n);
    }
    for (const gr of lg.graph?._groups || []) {          // a group is picked only when the rectangle holds it completely
      const bb = gr.boundingRect;
      if (bb && bb[0] >= x1 && bb[1] >= y1 && bb[0] + bb[2] <= x2 && bb[1] + bb[3] <= y2) items.push(gr);
    }
    try { lg.deselectAll(); } catch { /* ignore */ }
    try { if (items.length) lg.selectItems ? lg.selectItems(items) : items.forEach((n) => lg.select?.(n)); } catch (err) { console.warn('[gestures] box select', err); }
    try { lg.setDirty(true, true); } catch { /* ignore */ }
  }

  function onDown(e) {
    if (!handle.enabled || !isTouchOnCanvas(e)) return;
    const p = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: e.timeStamp, kind: 'empty', mode: 'passthrough' };
    if (e.isPrimary && (ptrs.size || g)) reset();         // a new first finger: whatever we still hold is stale (lost up/cancel)
    if (g) {                                              // another finger joins a running gesture
      ptrs.set(p.id, p);
      swallow(e);
      if (active().length < 2) { p.mode = 'gesture'; rebase(p); schedulePaint(); } else p.mode = 'ignored';
      return;
    }
    if (ptrs.size === 0) {                                // first finger: decide who owns it
      const r = el.getBoundingClientRect();
      const gp = screenToGraph(lg.ds, [e.clientX - r.left, e.clientY - r.top]);
      p.kind = hitKind(lg, gp[0], gp[1]);
      p.mode = p.kind === 'empty' ? 'pending' : 'passthrough';   // pending: down goes through, moves held back until it is a drag
      ptrs.set(p.id, p);
      return;                                             // LiteGraph sees the down (a tap on a node/empty canvas works as usual)
    }
    // second finger while the first has not turned into a LiteGraph drag: pan/pinch takes over
    const first = [...ptrs.values()][0];
    ptrs.set(p.id, p);
    swallow(e);
    if (first.mode === 'noop' || first.mode === 'box') {  // a one-finger empty-canvas drag that does nothing / box-selects: two fingers always pan + pinch
      boxEnd(first, false);
      first.x0 = first.x; first.y0 = first.y;
      first.mode = 'gesture'; p.mode = 'gesture';
      beginGesture(first);
      schedulePaint();
      return;
    }
    const firstStill = !movedBeyondTap(first.x - first.x0, first.y - first.y0);
    if ((first.kind === 'empty' || first.kind === 'node') && first.mode !== 'ignored' && firstStill && !linkDragging()) {
      first.mode = 'gesture'; p.mode = 'gesture';
      beginGesture(first);
      schedulePaint();
    } else p.mode = 'ignored';                            // first finger is linking/dragging something: leave it alone
  }

  function onMove(e) {
    const p = ptrs.get(e.pointerId);
    if (!p || e.pointerType !== 'touch') return;
    p.x = e.clientX; p.y = e.clientY;
    if (p.mode === 'passthrough') return;
    swallow(e);
    if (p.mode === 'pending') {
      if (!movedBeyondTap(p.x - p.x0, p.y - p.y0)) return;
      if (linkDragging()) { p.mode = 'passthrough'; return; }
      const act = prefs.emptyDrag;
      if (act === 'pan') { p.mode = 'gesture'; beginGesture(p); }
      else if (act === 'box') { p.mode = 'box'; boxStart(p); }
      else { p.mode = 'noop'; cancelLiteGraphPointer(); }   // 'none': the drag is ours and does nothing (LiteGraph must not pan / box-select)
    }
    if (p.mode === 'box') boxMove(p);
    if (p.mode === 'gesture' && g) { update(); schedulePaint(); }
  }

  function onUp(e) {
    const p = ptrs.get(e.pointerId);
    if (!p || e.pointerType !== 'touch') return;
    p.x = e.clientX; p.y = e.clientY;
    if (p.mode === 'passthrough' || p.mode === 'pending') { ptrs.delete(p.id); return; }   // tap / untouched drag: LiteGraph handles it
    swallow(e);
    if (p.mode === 'noop' || p.mode === 'box') {            // drag ended: LiteGraph never saw it, so no click / deselect either
      if (p.mode === 'box') boxEnd(p, e.type !== 'pointercancel');
      ptrs.delete(p.id);
      suppressClickUntil = performance.now() + 400;
      return;
    }
    if (p.mode === 'ignored' || !g) { ptrs.delete(p.id); return; }
    update();                                              // include the final finger position while this finger still counts
    ptrs.delete(p.id);
    if (e.type === 'pointercancel') {                      // system took the touch away: apply what we have, leave the rest alone
      for (const q of ptrs.values()) if (q.mode === 'gesture') q.mode = 'ignored';
      endGesture();
      return;
    }
    if (active().length) { rebase(); schedulePaint(); } else endGesture();
  }

  // lost up/cancel (app switch, system gesture): end cleanly and forget every pointer
  function reset() {
    try { boxEnd(null, false); } catch { /* ignore */ }
    try { if (g) { for (const q of ptrs.values()) q.mode = 'ignored'; endGesture(); } } finally { ptrs.clear(); }
  }
  const onHide = () => { if (document.visibilityState === 'hidden') reset(); };
  // the frontend's simpleTouchSupport would also change ds on our 2-finger touchmoves: stop it
  const onTouchMove = (e) => { if (g && e.target === el) e.stopImmediatePropagation(); };

  function onClick(e) {
    if (e.target === el && performance.now() < suppressClickUntil) swallow(e);
  }

  const opt = { capture: true, passive: false };
  // order matters: all of these are on window (capture), and a swallow() further down stops every later listener
  window.addEventListener('contextmenu', onContextMenu, opt);
  window.addEventListener('pointerdown', onFakeRightClick, opt);
  window.addEventListener('pointerup', onFakeRightClick, opt);
  window.addEventListener('pointerdown', track, opt);
  window.addEventListener('pointerup', track, opt);
  window.addEventListener('pointercancel', track, opt);
  window.addEventListener('pointermove', trackMove, opt);
  window.addEventListener('pointerdown', onDown, opt);
  window.addEventListener('pointermove', onMove, opt);
  window.addEventListener('pointerup', onUp, opt);
  window.addEventListener('pointercancel', onUp, opt);
  window.addEventListener('click', onClick, opt);
  window.addEventListener('touchmove', onTouchMove, opt);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', reset);
  window.addEventListener('blur', reset);

  function uninstall() {
    reset();
    window.removeEventListener('touchmove', onTouchMove, opt);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', reset);
    window.removeEventListener('blur', reset);
    window.removeEventListener('contextmenu', onContextMenu, opt);
    window.removeEventListener('pointerdown', onFakeRightClick, opt);
    window.removeEventListener('pointerup', onFakeRightClick, opt);
    window.removeEventListener('pointerdown', track, opt);
    window.removeEventListener('pointerup', track, opt);
    window.removeEventListener('pointercancel', track, opt);
    window.removeEventListener('pointermove', trackMove, opt);
    unsub?.();
    window.removeEventListener('pointerdown', onDown, opt);
    window.removeEventListener('pointermove', onMove, opt);
    window.removeEventListener('pointerup', onUp, opt);
    window.removeEventListener('pointercancel', onUp, opt);
    window.removeEventListener('click', onClick, opt);
    ptrs.clear();
    delete app.__pocketGestures;
  }

  app.__pocketGestures = handle;
  return handle;
}
