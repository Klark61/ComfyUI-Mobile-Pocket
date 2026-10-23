// node tests/test_sections.mjs  -- pure logic of the Sections panel (web/pocket/sections-model.js)
import assert from 'node:assert/strict';
import { groupPatch, groupState, nodeRows, mergeValues, applyModesToUi, findGroup, isApiFormat } from '../web/pocket/sections-model.js';

const structure = {
  groups: [
    { id: 'g0', title: 'A', nodeIds: ['1', '2', '9'], mode: 0 },
    { id: 'g1', title: 'B', nodeIds: ['3', '4'], mode: 4 },
    { id: 'g2', title: 'C', nodeIds: ['5'], mode: 4 },
    { id: 'g3', title: 'B', nodeIds: ['6', '30', '30:7', '30:8:2'], mode: 4, subgraph: 'sg' },   // duplicate title, subgraph instance inside
  ],
  controllers: [{ id: '9', kind: 'bypass', groups: ['g0', 'g1', 'g2', 'g3'], restriction: 'default' }],
  nodes: [
    { id: '1', type: 'KSampler', mode: 0 }, { id: '2', type: 'Foo', mode: 0 }, { id: '3', type: 'Bar', mode: 4 },
    { id: '4', type: 'Bar', mode: 4 }, { id: '5', type: 'Baz', mode: 4 },
    { id: '9', type: 'Fast Groups Bypasser (rgthree)', mode: 0 },
    { id: '20', type: 'note', title: 'n', mode: 0 }, { id: '21', type: 'Note', mode: 0 },
    { id: '6', type: 'Bar', mode: 4 },
    { id: '30', type: 'sg-uuid', mode: 4, subgraph: [{ id: '30:7', type: 'Inner', mode: 4 }, { id: '30:8', type: 'sg2', mode: 4 }, { id: '30:8:2', type: 'Deep', mode: 4 }] },
  ],
  apiIds: { 1: ['1'], 2: ['2'], 30: ['30:7'], '30:7': ['30:7'] },
};

// group state and patches
assert.deepEqual(groupState(structure, {}, structure.groups[0]), { on: true, all: true, n: 2 }); // controller 9 is skipped
assert.equal(groupState(structure, {}, structure.groups[1]).on, false);
let r = groupPatch(structure, {}, 'g1', true, structure.controllers[0]);
assert.deepEqual(r.patch, { 3: 0, 4: 0 });
assert.equal(groupState(structure, r.patch, structure.groups[1]).on, true);
r = groupPatch(structure, {}, 'g0', false, { ...structure.controllers[0], kind: 'mute' });
assert.deepEqual(r.patch, { 1: 2, 2: 2 });
r = groupPatch(structure, { 3: 0, 4: 0 }, 'g2', true, { ...structure.controllers[0], restriction: 'max one' });
assert.deepEqual(r.patch, { 5: 0, 1: 4, 2: 4, 3: 4, 4: 4, 6: 4, 30: 4, '30:7': 4, '30:8:2': 4 });
assert.equal(groupPatch(structure, {}, 'g0', false, { ...structure.controllers[0], restriction: 'always one' }).blocked, 'always one');
assert.deepEqual(groupPatch(structure, {}, 'g0', false, null).patch, { 1: 4, 2: 4 });
assert.equal(groupPatch(structure, {}, 'nope', true, null), null);

// duplicate titles: the id picks the group; old structures/presets that referenced a title still resolve
assert.equal(findGroup(structure, 'g3').subgraph, 'sg');
assert.equal(findGroup(structure, 'B').id, 'g1');
assert.equal(findGroup({ groups: [{ title: 'X', nodeIds: [] }, { title: 'Y', nodeIds: [] }] }, 'Y').title, 'Y');   // no ids: title
// old snapshot (no ids) with a group literally titled "g1": the reference resolves by title, not position
assert.equal(findGroup({ groups: [{ title: 'g1', nodeIds: [] }, { title: 'Z', nodeIds: [] }] }, 'g1').title, 'g1');
assert.equal(findGroup({ groups: [{ title: 'Z', nodeIds: [] }, { title: 'g1', nodeIds: [] }] }, 'g1').title, 'g1');
// differential: bypassed subgraph instance, inner nodes still 0 -> group is off (rgthree looks at direct members only)
{
  const s = {
    groups: [{ id: 'g0', title: 'S', memberIds: ['30', '6'], nodeIds: ['30', '30:7', '6'], mode: 'mixed' }, { id: 'g1', title: 'T', memberIds: ['1'], nodeIds: ['1'], mode: 0 }],
    nodes: [{ id: '30', type: 'sg-uuid', mode: 4, subgraph: [{ id: '30:7', type: 'Inner', mode: 0 }] }, { id: '6', type: 'Bar', mode: 4 }, { id: '1', type: 'Foo', mode: 0 }],
  };
  assert.equal(groupState(s, {}, s.groups[0]).on, false);
  assert.equal(groupState(s, {}, s.groups[0]).n, 2);
  // old snapshot without memberIds falls back to nodeIds (inner node counted)
  const old = { ...s, groups: [{ id: 'g0', title: 'S', nodeIds: ['30', '30:7', '6'], mode: 0 }] };
  assert.equal(groupState(old, {}, old.groups[0]).on, true);
  // "always one": the only other group is off by direct state, so turning T off is blocked
  const ctl = { groups: ['g0', 'g1'], restriction: 'always one' };
  assert.equal(groupPatch(s, {}, 'g1', false, ctl).blocked, 'always one');
  // the patch still covers the expanded list
  assert.deepEqual(groupPatch(s, {}, 'g0', true, null).patch, { 30: 0, '30:7': 0, 6: 0 });
}
assert.deepEqual(groupPatch(structure, {}, 'g1', true, null).patch, { 3: 0, 4: 0 });
// turning a group with a subgraph instance on sets the instance and everything inside it, nested too
r = groupPatch(structure, {}, 'g3', true, structure.controllers[0]);
assert.deepEqual(r.patch, { 6: 0, 30: 0, '30:7': 0, '30:8:2': 0 });
assert.equal(groupState(structure, r.patch, structure.groups[3]).all, true);
assert.equal(groupState(structure, {}, structure.groups[3]).on, false);

// per-node rows: no virtual nodes, bypassed ones stay listed, subgraph inner nodes nested
assert.deepEqual(nodeRows(structure).map((x) => x.id), ['1', '2', '3', '4', '5', '6', '30', '30:7', '30:8', '30:8:2']);

// merge: literals carried over by node + input, links and new inputs from the fresh prompt
const fresh = { 1: { class_type: 'K', inputs: { seed: 1, text: 'a', m: ['2', 0] } }, 2: { class_type: 'X', inputs: { v: 1 } }, 3: { class_type: 'N', inputs: { t: 'new' } } };
const old = { 1: { class_type: 'K', inputs: { seed: 99, text: 'edited', m: ['5', 0] } }, 2: { class_type: 'Y', inputs: { v: 7 } } };
const m = mergeValues(fresh, old);
assert.deepEqual(m[1].inputs, { seed: 99, text: 'edited', m: ['2', 0] });
assert.equal(m[2].inputs.v, 1);          // class changed: take the fresh value
assert.equal(m[3].inputs.t, 'new');       // node new to the prompt keeps the workflow's own value
assert.equal(fresh[1].inputs.seed, 1);    // inputs are not mutated

// applying modes to a UI workflow (top-level and subgraph-inner)
const ui = { nodes: [{ id: 1, mode: 0 }, { id: 30, type: 'sg-uuid', mode: 0 }], definitions: { subgraphs: [{ id: 'sg-uuid', nodes: [{ id: 7, mode: 0 }, { id: 8, mode: 0 }] }] } };
const u2 = applyModesToUi(ui, { 1: 4, '30:7': 2 });
assert.equal(u2.nodes[0].mode, 4);
assert.deepEqual(u2.definitions.subgraphs[0].nodes.map((n) => n.mode), [2, 0]);
assert.equal(ui.nodes[0].mode, 0);        // original untouched
// nested instance path "30:8:2": instance 30 (def sg-uuid) -> node 8 (def sg2) -> node 2
const ui2 = { nodes: [{ id: 30, type: 'sg-uuid', mode: 0 }], definitions: { subgraphs: [
  { id: 'sg-uuid', nodes: [{ id: 7, type: 'x', mode: 0 }, { id: 8, type: 'sg2', mode: 0 }] }, { id: 'sg2', nodes: [{ id: 1, mode: 0 }, { id: 2, mode: 0 }] }] } };
const u3 = applyModesToUi(ui2, { '30:8:2': 4, '30:8': 4 });
assert.deepEqual(u3.definitions.subgraphs[1].nodes.map((n) => n.mode), [0, 4]);
assert.deepEqual(u3.definitions.subgraphs[0].nodes.map((n) => n.mode), [0, 4]);
assert.equal(ui2.definitions.subgraphs[1].nodes[1].mode, 0);
// API-format detection
assert.equal(isApiFormat({ 1: { class_type: 'A', inputs: { x: 1 } }, 2: { class_type: 'B', inputs: {} } }), true);
assert.equal(isApiFormat({ nodes: [], links: [] }), false);
assert.equal(isApiFormat({}), false);
assert.equal(isApiFormat([{ class_type: 'A', inputs: {} }]), false);
assert.equal(isApiFormat({ 1: { class_type: 'A', inputs: [] } }), false);   // malformed UI-style node
// Simple <-> Canvas switch helpers
import { canvasUrl, wfPathParam, canCanvas, writeMode, lastModeFor, readModes } from '../web/pocket/mode.js';
assert.equal(canvasUrl('a b/c&d.json'), '/pocket/canvas?path=a%20b%2Fc%26d.json');
assert.equal(wfPathParam({ wfpath: 'x/y.json' }), 'x/y.json');
assert.equal(wfPathParam({}), '');
assert.equal(wfPathParam(null), '');
assert.equal(canCanvas({ kind: 'workflow', path: 'a.json' }), true);
assert.equal(canCanvas({ kind: 'history', id: '1' }), false);
assert.equal(canCanvas({ kind: 'remix', path: 'img.png' }), false);
{
  const m = new Map(); const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  assert.deepEqual(readModes(store), {});
  writeMode('a.json', 'canvas', store);
  assert.equal(lastModeFor('a.json', store), 'canvas');
  assert.equal(lastModeFor('b.json', store), '');
  writeMode('a.json', 'simple', store);
  assert.equal(lastModeFor('a.json', store), 'simple');
  assert.equal(readModes(store).last, 'simple');
}
console.log('sections: all ok');
