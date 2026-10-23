// Simple <-> Canvas switch: pure URL helpers + the per-device "last mode per workflow" memory (localStorage 'comfypocket.mode').
export const MODE_KEY = 'comfypocket.mode';

/** URL of the canvas editor for a saved workflow path (relative to user/default/workflows). */
export const canvasUrl = (path) => `/pocket/canvas?path=${encodeURIComponent(path)}`;

/** Hash params of "#/generate?wfpath=..." -> the workflow path to reload fresh, or ''. */
export const wfPathParam = (params) => (params && typeof params.wfpath === 'string' ? params.wfpath.trim() : '');

/** Only saved workflows (a source with a path) can open in canvas; history / remix / API-format files cannot. */
export const canCanvas = (src) => !!(src && src.kind === 'workflow' && src.path);

export function readModes(store) {
  try {
    const j = JSON.parse((store || localStorage).getItem(MODE_KEY));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
/** mode: 'simple' | 'canvas'. Remembers the last mode overall and per workflow path. */
export function writeMode(path, mode, store) {
  try {
    const j = readModes(store);
    const paths = { ...(j.paths || {}) };
    if (path) paths[path] = mode;
    (store || localStorage).setItem(MODE_KEY, JSON.stringify({ last: mode, paths }));
  } catch { /* storage blocked: the chip just will not show */ }
}
export const lastModeFor = (path, store) => { const j = readModes(store); return (j.paths && j.paths[path]) || ''; };
