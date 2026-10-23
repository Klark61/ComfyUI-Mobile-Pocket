// ComfyUI websocket client: persisted clientId, auto-reconnect with backoff, JSON + binary preview frames.
//
//   ws.on('<message type>', data)   any JSON message ("status", "progress", "executing", ...)
//   ws.on('preview', {url, blob, meta})   binary frame type 1 (PREVIEW_IMAGE) or 4 (PREVIEW_IMAGE_WITH_METADATA)
//   ws.on('state', 'connecting'|'open'|'closed')
//   ws.state, ws.clientId
// Binary layout (server.py): u32 BE event type, then
//   type 1: u32 image type (1 jpeg, 2 png) + bytes
//   type 4: u32 metadata length + metadata JSON (node_id, prompt_id, image_type "image/png"|"image/jpeg", ...) + bytes
import { makeBus } from './bus.js';

const KEY = 'comfypocket.clientId';
const PREFIX = 'cpocket-'; // the backend mirrors desktop job progress/previews to sockets with this clientId prefix

function uuid() {
  const b = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function loadClientId() {
  try {
    // sessionStorage, not localStorage: the server keeps one socket per clientId, so two tabs sharing an id would
    // silently steal each other's progress. Each tab (and reload of it) keeps its own id.
    let v = sessionStorage.getItem(KEY);
    if (!v) v = PREFIX + uuid();
    else if (!v.startsWith(PREFIX)) v = PREFIX + v;
    sessionStorage.setItem(KEY, v);
    return v;
  } catch { return PREFIX + uuid(); }
}

export const ws = Object.assign(makeBus(), { state: 'closed', clientId: loadClientId() });

let sock = null;
let attempt = 0;
let timer = 0;
let started = false;
const urls = []; // recent preview blob URLs; older ones are revoked

function setState(s) {
  if (ws.state === s) return;
  ws.state = s;
  ws.emit('state', s);
}

export function parsePreview(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 8) return null;
  const type = dv.getUint32(0);
  let meta = null; let mime; let body;
  if (type === 1) {
    mime = dv.getUint32(4) === 2 ? 'image/png' : 'image/jpeg';
    body = buf.slice(8);
  } else if (type === 4) {
    const len = dv.getUint32(4);
    try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, len))); } catch { meta = {}; }
    mime = (meta && meta.image_type) || 'image/jpeg';
    body = buf.slice(8 + len);
  } else return null;
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  urls.push(url);
  while (urls.length > 3) URL.revokeObjectURL(urls.shift());
  return { url, blob, meta };
}

function connect() {
  clearTimeout(timer);
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
  setState('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let s;
  try { s = new WebSocket(`${proto}://${location.host}/ws?clientId=${encodeURIComponent(ws.clientId)}`); }
  catch { schedule(); return; }
  sock = s;
  s.binaryType = 'arraybuffer';
  s.onopen = () => {
    attempt = 0;
    try { s.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })); } catch { /* ignore */ }
    setState('open');
  };
  s.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.type) { ws.emit(m.type, m.data); ws.emit('*', m); }
    } else {
      const p = parsePreview(e.data);
      if (p) ws.emit('preview', p);
    }
  };
  s.onclose = () => { if (sock === s) { sock = null; setState('closed'); schedule(); } };
  s.onerror = () => { try { s.close(); } catch { /* ignore */ } };
}

function schedule() {
  clearTimeout(timer);
  const delay = Math.min(8000, 400 * 2 ** attempt++) + Math.random() * 250;
  timer = setTimeout(connect, delay);
}

export function startWs() {
  if (started) return;
  started = true;
  connect();
  const wake = () => {
    if (document.hidden) return;
    if (!sock || sock.readyState === WebSocket.CLOSED) { attempt = 0; connect(); }
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
}
