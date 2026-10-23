// Unit tests for the canvas touch prefs + long-press timer (web/canvas/prefs.js). Plain node:  node tests/test_canvas_prefs.mjs
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, PREFS_KEY, parsePrefs, createPrefsStore, LongPress } from '../web/canvas/prefs.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

// fake clock
const clock = () => {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimer: (f, ms) => { timers.set(++id, { at: now + ms, f }); return id; },
    clearTimer: (t) => timers.delete(t),
    advance(ms) { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].f(); } now = end; },
    count: () => timers.size,
  };
};
const mk = (prefs) => { const c = clock(), fired = []; const lp = new LongPress({ getPrefs: () => prefs, fire: (x, y) => fired.push([x, y]), setTimer: c.setTimer, clearTimer: c.clearTimer }); return { c, fired, lp }; };

test('defaults: one finger on empty canvas does nothing, long-press off, 500 ms', () => {
  assert.deepEqual(parsePrefs(null), { emptyDrag: 'none', longPress: 'off', longPressMs: 500 });
  assert.deepEqual(parsePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs(''), DEFAULT_PREFS);
});
test('parse: garbage and invalid fields fall back field by field', () => {
  assert.deepEqual(parsePrefs('{nope'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs('[1,2]'), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs({ emptyDrag: 'fling', longPress: 'on', longPressMs: 123 }), { emptyDrag: 'none', longPress: 'on', longPressMs: 500 });
  assert.deepEqual(parsePrefs('{"emptyDrag":"box","longPress":"on","longPressMs":"1000"}'), { emptyDrag: 'box', longPress: 'on', longPressMs: 1000 });
});
test('store: set persists to localStorage under comfypocket.canvas.prefs, notifies, and a new store reads it back', () => {
  const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const s = createPrefsStore(storage); const seen = [];
  s.subscribe((p) => seen.push(p.emptyDrag));
  assert.equal(s.get().emptyDrag, 'none');
  s.set({ emptyDrag: 'pan' }); s.set({ longPress: 'on', longPressMs: 700 });
  assert.deepEqual(seen, ['pan', 'pan']);
  assert.equal(PREFS_KEY, 'comfypocket.canvas.prefs');
  assert.deepEqual(Object.keys(mem), [PREFS_KEY]);
  assert.deepEqual(createPrefsStore(storage).get(), { emptyDrag: 'pan', longPress: 'on', longPressMs: 700 });
  assert.equal(s.set({ emptyDrag: 'bogus' }).emptyDrag, 'none');
});
test('store: works without / with a throwing storage', () => {
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('y'); } };
  const s = createPrefsStore(bad); assert.deepEqual(s.get(), DEFAULT_PREFS); s.set({ emptyDrag: 'box' }); assert.equal(s.get().emptyDrag, 'box');
  assert.equal(createPrefsStore(null).set({ emptyDrag: 'pan' }).emptyDrag, 'pan');
});
test('long-press off (default): holding for 5 s never fires and arms no timer', () => {
  const { c, fired, lp } = mk(DEFAULT_PREFS);
  lp.down(1, 100, 100); assert.equal(c.count(), 0); c.advance(5000); assert.equal(fired.length, 0);
});
test('long-press on: a still finger fires once after the delay', () => {
  const { c, fired, lp } = mk({ longPress: 'on', longPressMs: 700 });
  lp.down(1, 50, 60); c.advance(699); assert.equal(fired.length, 0); c.advance(2); assert.deepEqual(fired, [[50, 60]]);
  c.advance(3000); assert.equal(fired.length, 1);
});
test('long-press on: small jitter (< 8 px) still fires, a move of 8 px does not', () => {
  let t = mk({ longPress: 'on', longPressMs: 500 });
  t.lp.down(1, 0, 0); t.lp.move(1, 3, 4); t.c.advance(500); assert.equal(t.fired.length, 1);
  t = mk({ longPress: 'on', longPressMs: 500 });
  t.lp.down(1, 0, 0); t.c.advance(300); t.lp.move(1, 8, 0); assert.equal(t.c.count(), 0); t.c.advance(2000); assert.equal(t.fired.length, 0);
});
test('moved finger -> no menu, even if it comes back to the start', () => {
  const { c, fired, lp } = mk({ longPress: 'on', longPressMs: 500 });
  lp.down(1, 10, 10); lp.move(1, 60, 10); lp.move(1, 10, 10); c.advance(2000); assert.equal(fired.length, 0);
});
test('lifting before the delay cancels; a second finger cancels and blocks the whole touch', () => {
  let t = mk({ longPress: 'on', longPressMs: 500 });
  t.lp.down(1, 0, 0); t.c.advance(400); t.lp.up(1); t.c.advance(1000); assert.equal(t.fired.length, 0);
  t = mk({ longPress: 'on', longPressMs: 500 });
  t.lp.down(1, 0, 0); t.c.advance(200); t.lp.down(2, 50, 50); t.c.advance(2000); assert.equal(t.fired.length, 0);
  t.lp.up(2); t.lp.down(3, 5, 5); t.c.advance(100); assert.equal(t.fired.length, 0);   // finger 1 is still down: still blocked
  t.lp.up(1); t.lp.up(3); t.lp.down(4, 1, 1); t.c.advance(500); assert.equal(t.fired.length, 1);   // a fresh single touch works again
});
test('prefs are read at touch start: switching long-press on applies to the next touch', () => {
  const prefs = { longPress: 'off', longPressMs: 500 }; const { c, fired, lp } = mk(prefs);
  lp.down(1, 0, 0); c.advance(600); lp.up(1); assert.equal(fired.length, 0);
  prefs.longPress = 'on'; lp.down(1, 0, 0); c.advance(500); assert.equal(fired.length, 1);
});
console.log(`${n} tests passed`);
