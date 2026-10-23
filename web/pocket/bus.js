// Tiny event bus. `bus` is the app-wide instance shared by every view; makeBus() builds private ones (ws.js).
//
// Well-known events on the global bus:
//   outputs:new      ()                   new image/video produced -> gallery merges the newest page (emitted by queue-store.js)
//   outputs:deleted  ({paths})            files moved to trash
//   outputs:fav      ({path, fav})        favourite toggled
//   progress         ({value,max,label,indeterminate?}|null)  header mini progress (null clears; emitted by queue-store.js)
//   queue:count      (n)                  badge on the Queue tab (running + pending)
//   toast            ({msg, kind, ms})    use ui.toast() instead of emitting directly
export function makeBus() {
  const map = new Map();
  const b = {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => b.off(evt, fn);
    },
    off(evt, fn) {
      map.get(evt)?.delete(fn);
    },
    once(evt, fn) {
      const off = b.on(evt, (d) => { off(); fn(d); });
      return off;
    },
    emit(evt, data) {
      for (const fn of [...(map.get(evt) || [])]) {
        try { fn(data); } catch (e) { console.error(`[bus] handler for "${evt}" failed`, e); }
      }
    },
  };
  return b;
}

export const bus = makeBus();
