// Phone touch preferences for canvas mode (web/canvas/gestures.js and toolbar.js read them live).
// Stored ONLY in localStorage ('comfypocket.canvas.prefs'); never written to the ComfyUI server settings.
//
//   emptyDrag   : what ONE finger does on EMPTY canvas.  'none' (default) = nothing, 'pan', 'box' (box select).
//                 A tap on empty canvas still deselects. TWO fingers always pan / pinch, whatever this says.
//   longPress   : 'off' (default) | 'on'.  A finger held still opens the context menu. One finger never opens a menu otherwise.
//   longPressMs : 500 | 700 | 1000.
//
// Pure module: no DOM access at import time (tests/test_canvas_prefs.mjs runs it in plain node).

export const PREFS_KEY = 'comfypocket.canvas.prefs';
export const EMPTY_DRAG = ['none', 'pan', 'box'];
export const LONG_PRESS = ['off', 'on'];
export const LONG_PRESS_MS = [500, 700, 1000];
export const DEFAULT_PREFS = Object.freeze({ emptyDrag: 'none', longPress: 'off', longPressMs: 500 });

/** Any stored value (string, object or garbage) -> a complete, valid prefs object. Unknown / invalid fields fall back to the default. */
export function parsePrefs(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { o = null; } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
  const ms = Number(o.longPressMs);
  return {
    emptyDrag: EMPTY_DRAG.includes(o.emptyDrag) ? o.emptyDrag : DEFAULT_PREFS.emptyDrag,
    longPress: LONG_PRESS.includes(o.longPress) ? o.longPress : DEFAULT_PREFS.longPress,
    longPressMs: LONG_PRESS_MS.includes(ms) ? ms : DEFAULT_PREFS.longPressMs,
  };
}

/** Live store over a Storage-like object ({getItem,setItem}); a missing / throwing storage just keeps the values in memory. */
export function createPrefsStore(storage) {
  const read = () => { try { return parsePrefs(storage && storage.getItem(PREFS_KEY)); } catch { return parsePrefs(null); } };
  let cur = read();
  const subs = new Set();
  return {
    get: () => cur,
    set(patch) {
      cur = parsePrefs(Object.assign({}, cur, patch));
      try { storage && storage.setItem(PREFS_KEY, JSON.stringify(cur)); } catch { /* quota / private mode: keep in memory */ }
      for (const f of [...subs]) { try { f(cur); } catch { /* a bad subscriber must not break the others */ } }
      return cur;
    },
    reload() { cur = read(); for (const f of [...subs]) { try { f(cur); } catch { /* ignore */ } } return cur; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

/** The page-wide store (shared by gestures.js, toolbar.js and the settings sheet). */
export function sharedPrefs() {
  const w = typeof window !== 'undefined' ? window : globalThis;
  if (!w.__canvasPrefs) {
    let st = null; try { st = w.localStorage; } catch { /* blocked */ }
    w.__canvasPrefs = createPrefsStore(st);
  }
  return w.__canvasPrefs;
}

/**
 * Long-press detector. Fires `fire(x, y)` once when ONE finger stays within `maxMove` px for the whole delay.
 * The timer is cancelled the moment the finger moves that far, when a second finger lands, or when it lifts.
 * Only when prefs.longPress === 'on'. Timers are injectable (tests use a fake clock).
 */
export class LongPress {
  constructor({ getPrefs, fire, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t), maxMove = 8 }) {
    Object.assign(this, { getPrefs, fire, setTimer, clearTimer, maxMove });
    this.ids = new Set(); this.timer = null; this.start = null; this.fired = false; this.blocked = false;
  }
  get pending() { return this.timer !== null; }
  down(id, x, y) {
    if (this.ids.size) { this.ids.add(id); this.blocked = true; this.cancel(); return; }   // a second finger: never a long-press
    this.ids.add(id); this.blocked = false; this.fired = false;
    const p = this.getPrefs();
    if (!p || p.longPress !== 'on') return;
    this.start = { id, x, y };
    this.timer = this.setTimer(() => { this.timer = null; if (this.blocked || !this.start) return; this.fired = true; this.fire(this.start.x, this.start.y); }, p.longPressMs);
  }
  move(id, x, y) {
    if (!this.start || this.start.id !== id || this.timer === null) return;
    if (Math.hypot(x - this.start.x, y - this.start.y) >= this.maxMove) this.cancel();
  }
  up(id) {
    this.ids.delete(id);
    this.cancel();
    if (!this.ids.size) { this.blocked = false; this.start = null; }
  }
  cancel() { if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; } }
}
