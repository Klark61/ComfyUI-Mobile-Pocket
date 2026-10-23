// Unit tests for the gesture compositor math (web/canvas/gestures.js). Plain node, no deps:  node tests/test_gestures.mjs
import assert from 'node:assert/strict';
import { identity, composeTransform, applyTransform, fingerFrame, gestureTransform, clampTransform, cssToDs,
  graphToScreen, screenToGraph, hitKind, install, isTap, movedBeyondTap, TAP_MAX_MOVE, TAP_MAX_MS } from '../web/canvas/gestures.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b}`);
const nearPt = (a, b, eps, msg) => { near(a[0], b[0], eps, msg); near(a[1], b[1], eps, msg); };

const ds0 = () => ({ scale: 0.7, offset: [-120.5, 340.25], min_scale: 0.1, max_scale: 10 });

// Simulate a whole touch gesture the way gestures.js does: frames of finger positions, re-baselined when the finger count changes.
function run(ds, segments, min = 0.1, max = 10) {
  let T0 = identity(), T = identity(), start = null;
  for (const seg of segments) {
    if (start) T0 = T;
    start = fingerFrame(seg.from);
    const now = fingerFrame(seg.to);
    T = clampTransform(ds, composeTransform(T0, gestureTransform(start, now)), [now.cx, now.cy], min, max);
  }
  return T;
}

test('identity transform leaves the view unchanged', () => {
  const v = cssToDs(ds0(), identity());
  assert.equal(v.scale, 0.7); assert.deepEqual(v.offset, [-120.5, 340.25]);
});

test('pure pan: view moves by dx/scale in graph units', () => {
  const ds = ds0(), T = run(ds, [{ from: [[100, 200]], to: [[160, 150]] }]);
  const v = cssToDs(ds, T);
  near(v.scale, 0.7, 1e-12);
  near(v.offset[0], ds.offset[0] + 60 / 0.7, 1e-9); near(v.offset[1], ds.offset[1] - 50 / 0.7, 1e-9);
});

test('focal-point pinch then pan: the graph point under the fingers is the same before and after', () => {
  const ds = ds0();
  const a0 = [150, 300], b0 = [250, 500];                       // two fingers down
  const a1 = [120, 260], b1 = [330, 610];                        // spread (pinch out) while drifting
  const a2 = [140, 200], b2 = [350, 550];                        // then pan (same distance as a1/b1 ... roughly)
  const T = run(ds, [{ from: [a0, b0], to: [a1, b1] }, { from: [a1, b1], to: [a2, b2] }]);
  const v = cssToDs(ds, T);
  // graph points under the starting fingers must end under the corresponding unclamped transform of those fingers:
  // check the centroid-anchored point: graph point at the start centroid ends under the final centroid
  const c0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], c2 = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
  const gBefore = screenToGraph(ds, c0);
  nearPt(graphToScreen(v, gBefore), c2, 1e-9, 'centroid point follows the centroid');
  // and the scale is the finger-distance ratio
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]), d2 = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
  near(v.scale, ds.scale * d2 / d0, 1e-9, 'scale = distance ratio');
});

test('pinch: the graph point under the focal point does not move (no pan)', () => {
  const ds = ds0(), f = [200, 400];
  const T = run(ds, [{ from: [[f[0] - 40, f[1]], [f[0] + 40, f[1]]], to: [[f[0] - 100, f[1]], [f[0] + 100, f[1]]] }]);
  const v = cssToDs(ds, T);
  const g = screenToGraph(ds, f);
  nearPt(graphToScreen(v, g), f, 1e-9);
  near(v.scale, 0.7 * 2.5, 1e-9);
});

test('finger count changes (2 -> 1 -> 2) keep the view continuous', () => {
  const ds = ds0();
  const a = [150, 300], b = [250, 500], b2 = [300, 520];
  const T = run(ds, [
    { from: [a, b], to: [a, b2] },                // pinch with finger b moving
    { from: [a], to: [[170, 330]] },              // second finger lifts, one finger pans
    { from: [[170, 330], [270, 530]], to: [[170, 330], [270, 530]] },   // second finger comes back, no change
  ]);
  const T2 = run(ds, [{ from: [a, b], to: [a, b2] }, { from: [a], to: [[170, 330]] }]);
  near(T.k, T2.k, 1e-12); near(T.tx, T2.tx, 1e-9); near(T.ty, T2.ty, 1e-9);
});

test('clamp to max: scale stops at max_scale and the focal point stays fixed', () => {
  const ds = { scale: 4, offset: [30, -10] }, f = [210, 330];
  const T = run(ds, [{ from: [[f[0] - 20, f[1]], [f[0] + 20, f[1]]], to: [[f[0] - 200, f[1]], [f[0] + 200, f[1]]] }], 0.1, 5);   // wants x10
  const v = cssToDs(ds, T);
  near(v.scale, 5, 1e-12, 'clamped');
  nearPt(graphToScreen(v, screenToGraph(ds, f)), f, 1e-9, 'focal fixed');
});

test('clamp to min with simultaneous pan: scale at min, centroid point follows the centroid', () => {
  const ds = { scale: 0.3, offset: [0, 0] };
  const from = [[100, 100], [300, 100]], to = [[150, 160], [190, 160]];   // pinch in hard and move
  const T = run(ds, [{ from, to }], 0.25, 10);
  const v = cssToDs(ds, T);
  near(v.scale, 0.25, 1e-12);
  const c0 = [200, 100], c1 = [170, 160];
  nearPt(graphToScreen(v, screenToGraph(ds, c0)), c1, 1e-9, 'the start centroid point follows the centroid');
});

test('clamp leaves an in-range transform untouched and is idempotent', () => {
  const ds = ds0(), T = { k: 1.5, tx: 12, ty: -7 };
  assert.deepEqual(clampTransform(ds, T, [10, 10], 0.1, 10), T);
  const c = clampTransform(ds, { k: 100, tx: 5, ty: 5 }, [50, 60], 0.1, 10);
  const c2 = clampTransform(ds, c, [50, 60], 0.1, 10);
  near(c2.k, c.k, 1e-12); near(c2.tx, c.tx, 1e-9); near(c2.ty, c.ty, 1e-9);
});

test('composeTransform is associative and applyTransform matches', () => {
  const A = { k: 1.3, tx: 4, ty: -2 }, B = { k: 0.8, tx: -9, ty: 5 }, C = { k: 2, tx: 1, ty: 1 };
  const l = composeTransform(composeTransform(A, B), C), r = composeTransform(A, composeTransform(B, C));
  near(l.k, r.k, 1e-12); near(l.tx, r.tx, 1e-9); near(l.ty, r.ty, 1e-9);
  nearPt(applyTransform(composeTransform(A, B), [7, 8]), applyTransform(B, applyTransform(A, [7, 8])), 1e-9);
});

test('tap threshold: < 8 px and < 250 ms is a tap, anything beyond is not', () => {
  assert.equal(TAP_MAX_MOVE, 8); assert.equal(TAP_MAX_MS, 250);
  assert.ok(isTap(0, 0)); assert.ok(isTap(7.9, 249)); assert.ok(!isTap(8, 100)); assert.ok(!isTap(2, 250)); assert.ok(!isTap(30, 500));
  assert.ok(!movedBeyondTap(5, 5)); assert.ok(movedBeyondTap(6, 6)); assert.ok(movedBeyondTap(0, 8));
});

test('one-finger frame has no distance, two-finger distance is guarded against 0', () => {
  assert.equal(fingerFrame([[3, 4]]).d, null);
  assert.ok(fingerFrame([[3, 4], [3, 4]]).d >= 1);
  const T = gestureTransform(fingerFrame([[3, 4]]), fingerFrame([[13, 4], [23, 4]]));
  assert.equal(T.k, 1);
});

test('hitKind: a slot inside the node box is a slot, the body is a node, outside is empty', () => {
  const node = { boundingRect: [0, 0, 100, 60] };
  const canvas = {
    graph: { _nodes: [node], getNodeOnPos: (x, y) => (x >= 0 && x <= 100 && y >= 0 && y <= 60 ? node : null) },
    isOverNodeInput: (n, x, y) => (Math.abs(x - 5) < 10 && Math.abs(y - 20) < 10 ? 0 : -1),
    isOverNodeOutput: () => -1,
  };
  assert.equal(hitKind(canvas, 5, 20), 'slot');
  assert.equal(hitKind(canvas, 60, 40), 'node');
  assert.equal(hitKind(canvas, 400, 400), 'empty');
});

test('stale pointers: a new primary pointerdown clears entries left by a lost up/cancel; blur clears too', () => {
  const L = {};
  globalThis.window = { addEventListener: (t, f) => { (L[t] ||= []).push(f); }, removeEventListener() {} };
  globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], visibilityState: 'visible' };
  const el = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const lg = { canvas: el, ds: { scale: 1, offset: [0, 0] }, graph: { _nodes: [], getNodeOnPos: () => null }, pointer: { reset() {} } };
  const h = install({ canvas: lg });
  const down = (id, primary) => { for (const f of L.pointerdown) f({ pointerType: 'touch', target: el, pointerId: id, isPrimary: primary, clientX: 10, clientY: 10, timeStamp: 0, stopImmediatePropagation() {}, preventDefault() {} }); };
  down(1, true);
  assert.equal(h.pointers.length, 1);
  down(2, true);                                  // the up of pointer 1 never arrived
  assert.deepEqual(h.pointers.map((p) => p.id), [2]);
  for (const f of L.blur) f();
  assert.equal(h.pointers.length, 0);
  h.uninstall();
});

console.log(`\n${n} tests passed`);
