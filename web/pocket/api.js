// Thin client for /pocket/api/* and ComfyUI's /view.
const BASE = '/pocket/api';

async function request(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const getJSON = (url, opts) => request(url, opts);
export const postJSON = (url, data) => request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, v === true ? '1' : v);
  return p.toString();
};

export const api = {
  /** {offset, limit, folder, kind:'image'|'video'|'all', fav:bool, q} -> {items,total,folders} */
  outputs: (params = {}, signal) => getJSON(`${BASE}/outputs?${qs(params)}`, { signal }),
  meta: (path) => getJSON(`${BASE}/meta?${qs({ path })}`),
  del: (paths) => postJSON(`${BASE}/delete`, { paths }),
  favorite: (path, fav) => postJSON(`${BASE}/favorite`, { path, fav }),
};

/** Thumbnail URL (webp, immutable). Bust with mtime. */
export const thumbUrl = (item, s = 384) =>
  item.thumb || `${BASE}/thumb?${qs({ path: item.path, s, m: item.mtime })}`;

/** Full-size URL via ComfyUI /view. Items may carry `url` (overrides) or {name, folder, type}. */
export const viewUrl = (item) => {
  if (item.url) return item.url;
  const p = new URLSearchParams({ filename: item.name, subfolder: item.folder || '', type: item.type || 'output' });
  return `/view?${p}`;
};

export const itemKey = (item) => item.path || item.url || `${item.folder || ''}/${item.name}`;
export const isVideo = (item) => item.kind === 'video';

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
