// node tests/test_nodes.mjs  -- pure logic of the All-nodes sheet (web/pocket/nodes-model.js)
import assert from 'node:assert/strict';
import { nodeSections, numCmp } from '../web/pocket/nodes-model.js';
import { nodeRows } from '../web/pocket/sections-model.js';

const P = {
  '30:5': { class_type: 'KSampler', inputs: { seed: 1, steps: 9 } },
  '30:6': { class_type: 'CLIPTextEncode', inputs: { text: 'hi' } },
  '4': { class_type: 'Foo', inputs: { a: 1 } }, '10': { class_type: 'Foo', inputs: { a: 2 } },
  '7': { class_type: 'Foo', inputs: { a: 3 } },
};
const mk = (sgMode = 0, n7 = 0) => ({
  groups: [
    { title: 'Outer', nodeIds: [30, 4, 10, 7], mode: 0 },   // listed first, contains the inner group
    { title: 'Inner', nodeIds: [7], mode: 0 },
  ],
  nodes: [
    { id: 30, title: 'SG', type: 'uuid', mode: sgMode, subgraph: [{ id: '30:5', title: 'KS', type: 'KSampler', mode: 0 }, { id: '30:6', title: 'Enc', type: 'CLIPTextEncode', mode: 0 }] },
    { id: 4, title: 'n4', type: 'Foo', mode: 0 }, { id: 10, title: 'n10', type: 'Foo', mode: 0 }, { id: 7, title: 'n7', type: 'Foo', mode: n7 },
  ],
  apiIds: { 30: ['30:5', '30:6'], '30:5': ['30:5'], '30:6': ['30:6'], 4: ['4'], 10: ['10'], 7: ['7'] },
});
const cards = (secs) => Object.fromEntries(secs.flatMap((s) => s.nodes.map((n) => [n.uiId || n.key, n])));

// 1. children claim first, the instance keeps only unclaimed ids
{
  const c = cards(nodeSections(P, mk(), {}));
  assert.ok(c['30:5'].fields.length >= 1, 'KSampler card has inputs');
  assert.ok(c['30:6'].fields.length >= 1, 'CLIPTextEncode card has inputs');
  assert.deepEqual(c['30'].apiIds, []);
  assert.equal(c['30'].fields.length, 0);
  assert.deepEqual(c['30:5'].apiIds, ['30:5']);
}
// 2. nested groups: the inner group keeps its node
{
  const s = nodeSections(P, mk(), {});
  const g = Object.fromEntries(s.map((x) => [x.title, x.nodes.map((n) => n.uiId)]));
  assert.deepEqual(g.Inner, ['7']);
  assert.ok(!g.Outer.includes('7'));
  assert.ok(g.Outer.includes('4') && g.Outer.includes('30'));
}
// 5. modes
{
  const c = cards(nodeSections(P, mk(0, 2), {}));
  assert.equal(c['7'].on, false);
  assert.equal(c['7'].mode, 2);               // shown as muted
  assert.equal(c['7'].offMode, 2);            // turning it off again restores mute
  assert.equal(cards(nodeSections(P, mk(0, 4), {}))['7'].offMode, 4);
  // inherited-off inner nodes
  const b = cards(nodeSections(P, mk(4), {}));
  assert.equal(b['30:5'].on, false); assert.equal(b['30:5'].inherited, true); assert.equal(b['30:5'].mode, 4);
  const m = cards(nodeSections(P, mk(2), {}));
  assert.equal(m['30:6'].inherited, true); assert.equal(m['30:6'].mode, 2);
  // pending override re-enables the instance
  assert.equal(cards(nodeSections(P, mk(4), { 30: 0 }))['30:5'].on, true);
  // key stability: API id key with and without structure
  const keysS = Object.values(cards(nodeSections(P, mk(), {}))).map((n) => n.key).sort(numCmp);
  const keysN = nodeSections(P, null, {})[0].nodes.map((n) => n.key).sort(numCmp);
  for (const k of keysN) assert.ok(keysS.includes(k), 'key ' + k);
}
// duplicate title across root and subgraph: two separate sections
{
  const s = mk();
  s.groups = [{ id: 'g0', title: 'Same', nodeIds: [4], mode: 0 }, { id: 'g1', title: 'Same', nodeIds: [10], mode: 0, subgraph: 'sg' }];
  const secs = nodeSections(P, s, {}).filter((x) => x.title === 'Same');
  assert.equal(secs.length, 2);
  assert.notEqual(secs[0].id, secs[1].id);
  assert.deepEqual(secs.map((x) => x.nodes.map((n) => n.uiId)), [['4'], ['10']]);
}
// old snapshot (no ids) still groups by position
{
  const s = mk();
  s.groups = [{ title: 'g1', nodeIds: [4], mode: 0 }, { title: 'X', nodeIds: [10], mode: 0 }];
  const secs = nodeSections(P, s, {});
  assert.deepEqual(secs.filter((x) => x.id !== 'other').map((x) => x.title), ['g1', 'X']);
}
// nested 30 -> 30:8 -> 30:8:2: true depth and immediate parent; deepest claims first, inherited-off from the immediate parent
{
  const NP = { '30:8:2': { class_type: 'Deep', inputs: { a: 1 } } };
  const ns = (mid) => ({
    groups: [],
    nodes: [{ id: 30, title: 'SG', type: 'uuid', mode: 0, subgraph: [
      { id: '30:8', title: 'SG2', type: 'uuid2', mode: mid }, { id: '30:8:2', title: 'Deep', type: 'Deep', mode: 0 }] }],
    apiIds: { 30: ['30:8:2'], '30:8': ['30:8:2'], '30:8:2': ['30:8:2'] },
  });
  const rows = nodeRows(ns(0));
  const deep = rows.find((r) => r.id === '30:8:2');
  assert.equal(deep.depth, 2); assert.equal(deep.parent, '30:8');
  const c = cards(nodeSections(NP, ns(4), {}));
  assert.equal(c['30:8:2'].apiIds.length, 1);
  assert.deepEqual(c['30:8'].apiIds, []);
  assert.equal(c['30:8:2'].inherited, true); assert.equal(c['30:8:2'].on, false);
  assert.equal(cards(nodeSections(NP, ns(0), {}))['30:8:2'].inherited, false);
}
// natural sort
assert.deepEqual(['30:5', '10', '4', '30:12', '30', '30:6'].sort(numCmp), ['4', '10', '30', '30:5', '30:6', '30:12']);
assert.deepEqual(nodeSections(P, null, {})[0].nodes.map((n) => n.key), ['4', '7', '10', '30:5', '30:6']);
console.log('test_nodes ok');
