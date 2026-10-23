// Unit tests for web/canvas/storage-migrate.js. Plain node:  node tests/test_storage_migrate.mjs
import assert from 'node:assert/strict';
import { migrateStorage } from '../web/canvas/storage-migrate.js';

const fake = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
};
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

test('copies old keys and removes them', () => {
  const s = fake({ 'comfymobile.mode': 'a', 'comfymobile.canvas.draft:x.json': 'd', other: 'o' });
  assert.equal(migrateStorage(s), 2);
  assert.equal(s.getItem('comfypocket.mode'), 'a');
  assert.equal(s.getItem('comfypocket.canvas.draft:x.json'), 'd');
  assert.equal(s.getItem('comfymobile.mode'), null);
  assert.equal(s.getItem('other'), 'o');
});
test('does not overwrite an existing new key', () => {
  const s = fake({ 'comfymobile.desktop': '1', 'comfypocket.desktop': '0' });
  assert.equal(migrateStorage(s), 0);
  assert.equal(s.getItem('comfypocket.desktop'), '0');
  assert.equal(s.getItem('comfymobile.desktop'), null);
});
test('idempotent and tolerant of missing storage', () => {
  const s = fake({ 'comfymobile.a': '1' });
  migrateStorage(s); assert.equal(migrateStorage(s), 0);
  assert.equal(migrateStorage(null), 0);
});
console.log(n + ' passed');
