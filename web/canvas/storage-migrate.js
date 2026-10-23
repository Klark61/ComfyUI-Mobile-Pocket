// One-time storage key migration for the rename comfymobile.* -> comfypocket.*.
// Copies each old key to its new name unless the new one already exists, then removes the old key. Pure: takes any Storage-like object.
export const OLD_PREFIX = 'comfymobile';
export const NEW_PREFIX = 'comfypocket';

export function migrateStorage(storage) {
  let moved = 0;
  try {
    if (!storage) return 0;
    const old = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k === 'string' && k.startsWith(OLD_PREFIX)) old.push(k);
    }
    for (const k of old) {
      const nk = NEW_PREFIX + k.slice(OLD_PREFIX.length);
      if (storage.getItem(nk) === null) { storage.setItem(nk, storage.getItem(k)); moved++; }
      storage.removeItem(k);
    }
  } catch { /* storage unavailable or full: best effort */ }
  return moved;
}

export function migrateAll() {
  let n = 0;
  try { n += migrateStorage(window.localStorage); } catch {}
  try { n += migrateStorage(window.sessionStorage); } catch {}
  return n;
}
