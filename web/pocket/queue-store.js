// Queue store: live job tracking that runs for the whole app lifetime (header progress + tab badge work on every tab).
//
// Sources
//   - WebSocket (ws.js): full detail (step progress, node, preview frames) ONLY for jobs queued with this page's clientId.
//     ComfyUI sends progress/preview/start/success frames to the queuing client only; every other client just gets
//     broadcast "status" (queue_remaining) and "execution_interrupted".
//   - Polling /queue (triggered by "status" events, plus a 2.5 s timer while jobs exist or the socket is down) so jobs queued
//     from the desktop UI or curl still show up (without step progress).
//   - /pocket/api/history + /api/jobs for the "Recent" list.
//
// Emits on the global bus: progress, queue:count, outputs:new.
// Public: queueStore.{get, subscribe, start, sync, loadRecent, interrupt, cancelPending, clearPending, nameJob, setVibrate}
//         useQueue() hook, jobOutputsToItems(rows) -> viewer items.
import { useState, useEffect } from 'preact/hooks';
import { bus } from './bus.js';
import { ws, startWs } from './ws.js';
import { getJSON, postJSON } from './api.js';

const VIB_KEY = 'comfypocket.vibrate';
const names = new Map(); // job id -> display name (Generate view registers names of jobs it queues)

function readVibrate() {
  try { return localStorage.getItem(VIB_KEY) !== '0'; } catch { return true; }
}

let state = {
  conn: ws.state,
  running: null,
  pending: [],
  recent: [],
  recentLoaded: false,
  errors: {},           // prompt_id -> {nodeId, nodeTitle, nodeType, message, type}
  liveTexts: {},        // prompt_id -> [{node, title, text}] text outputs seen on the websocket `executed` event (history has them later)
  vibrate: readVibrate(),
  serverReachable: true,
};
const subs = new Set();
let notifyQueued = false;

function set(patch) {
  state = { ...state, ...patch };
  if (!notifyQueued) {
    notifyQueued = true;
    queueMicrotask(() => { notifyQueued = false; for (const fn of [...subs]) fn(state); publish(); });
  }
}

// ---- helpers
export function nodeTitle(prompt, id) {
  const n = prompt && prompt[id];
  return (n && n._meta && n._meta.title) || (n && n.class_type) || (id !== undefined && id !== null ? `Node ${id}` : '');
}

function guessName(prompt, extra) {
  const wf = extra && extra.extra_pnginfo && extra.extra_pnginfo.workflow;
  if (wf && wf.name) return wf.name;
  if (prompt) {
    for (const n of Object.values(prompt)) {
      const p = n && n.inputs && n.inputs.filename_prefix;
      if (typeof p === 'string' && p) return p.split(/[\\/]/).filter(Boolean).pop();
    }
  }
  return null;
}

function freshLive() {
  return { cached: new Set(), finished: new Set(), current: null, live: false, preview: null, stopping: false };
}

function fromQueueItem(item) {
  const [number, id, prompt, extra] = item;
  const guessed = guessName(prompt, extra);
  if (guessed && !names.has(id)) names.set(id, guessed); // remembered so Recent can label failed jobs (no output files)
  return {
    id, number, prompt,
    name: names.get(id) || `Job ${String(id).slice(0, 8)}`,
    nodeCount: prompt ? Object.keys(prompt).length : 0,
    createTime: extra && extra.create_time,
    own: !!(extra && extra.client_id === ws.clientId),
  };
}

function placeholder(id) {
  return { id, number: 0, prompt: null, name: names.get(id) || `Job ${String(id).slice(0, 8)}`, nodeCount: 0, createTime: Date.now(), own: true, startedAt: Date.now(), ...freshLive(), live: true };
}

export function runProgress(run) {
  if (!run) return null;
  const total = run.nodeCount || 0;
  // only count ids that exist in the submitted prompt (ephemeral/expansion node ids are not part of the total)
  const ids = new Set([...run.cached, ...run.finished].filter((id) => !run.prompt || id in run.prompt));
  const done = total ? Math.min(total, ids.size) : ids.size;
  const cur = run.current;
  const step = cur && cur.max > 0 ? Math.min(1, cur.value / cur.max) : 0;
  const overall = total ? Math.min(0.99, (done + step) / total) : step;
  return { total, done, step, overall, cur };
}

let lastPublished = '';
let lastCount = -1;
function publish() {
  const run = state.running;
  let msg = null;
  if (run) {
    if (run.live) {
      const p = runProgress(run);
      msg = { value: Math.round(p.overall * 1000), max: 1000, label: (p.cur && nodeTitle(run.prompt, p.cur.nodeId)) || run.name };
    } else msg = { indeterminate: true, label: run.name };
  }
  const key = JSON.stringify(msg);
  if (key !== lastPublished) { lastPublished = key; bus.emit('progress', msg); }
  const count = state.pending.length + (run ? 1 : 0);
  if (count !== lastCount) { lastCount = count; bus.emit('queue:count', count); }
}

// ---- ended jobs: an in-flight /queue response (or a late WS frame) must not resurrect a job that already finished
const ended = new Map(); // id -> ms
function markEnded(id) {
  if (!id) return;
  const now = Date.now();
  ended.set(id, now);
  for (const [k, t] of ended) if (now - t > 30000) ended.delete(k);
}
const isEnded = (id) => ended.has(id) && Date.now() - ended.get(id) < 30000;

// ---- queue sync
let syncing = false;
let syncAgain = false;
let syncTimer = 0;

export function scheduleSync(ms = 150) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}

export async function sync() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const q = await getJSON('/queue');
    const prevIds = new Set([...(state.running ? [state.running.id] : []), ...state.pending.map((p) => p.id)]);
    const pending = (q.queue_pending || []).filter((it) => !isEnded(it[1])).sort((a, b) => a[0] - b[0]).map(fromQueueItem);
    let running = null;
    const r = (q.queue_running || []).find((it) => !isEnded(it[1]));
    if (r) {
      const j = fromQueueItem(r);
      const old = state.running;
      running = old && old.id === j.id
        ? { ...old, prompt: j.prompt, name: j.name, nodeCount: j.nodeCount, number: j.number, own: j.own }
        : { ...j, startedAt: Date.now(), ...freshLive() };
    }
    set({ running, pending, serverReachable: true });
    const now = new Set([...(running ? [running.id] : []), ...pending.map((p) => p.id)]);
    const gone = [...prevIds].filter((id) => !now.has(id));
    if (gone.length) loadRecent(gone);
  } catch {
    if (state.serverReachable) set({ serverReachable: false });
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(100); }
  }
}

// ---- recent
let seen = null;
let recentTimer = 0;
let recentSeq = 0;
const expected = new Map(); // prompt_id -> remaining retries; history lags the end of a job, so retry only while these are missing

/** loadRecent(ids?) - ids: prompt id(s) expected to show up in history (retried a few times while missing) */
export function loadRecent(expectIds) {
  const list = expectIds === undefined || expectIds === true ? [] : [].concat(expectIds);
  for (const id of list) if (id && !expected.has(id)) expected.set(id, 4);
  clearTimeout(recentTimer);
  recentTimer = setTimeout(doLoadRecent, 120);
}

function baseName(file) {
  return String(file || '').replace(/\.[^.]+$/, '').replace(/_?\d{3,}_?$/, '').replace(/_$/, '') || null;
}

async function doLoadRecent() {
  const my = ++recentSeq;
  const [h, j] = await Promise.allSettled([
    getJSON('/pocket/api/history?limit=24'),
    getJSON('/api/jobs?status=completed,failed,cancelled&limit=40'),
  ]);
  if (my !== recentSeq) return; // a newer request superseded this one: drop the stale response
  if (h.status !== 'fulfilled') { set({ recentLoaded: true }); return; }
  const jobs = new Map(((j.status === 'fulfilled' && j.value.jobs) || []).map((x) => [x.id, x]));
  const rows = (h.value.history || []).map((r) => {
    const job = jobs.get(r.prompt_id);
    let status = job ? job.status : (r.status === 'success' ? 'completed' : 'failed');
    if (status === 'in_progress' || status === 'pending') status = 'completed';
    return {
      id: r.prompt_id,
      ts: r.ts || (job && job.execution_end_time) || null,
      name: r.workflow_name || names.get(r.prompt_id) || baseName(r.outputs[0] && r.outputs[0].filename) || `Job ${String(r.prompt_id).slice(0, 8)}`,
      outputs: r.outputs || [],
      texts: (r.texts && r.texts.length ? r.texts : state.liveTexts[r.prompt_id]) || [],
      status,
      error: (job && job.execution_error) || null,
      duration: job && job.execution_start_time && job.execution_end_time ? job.execution_end_time - job.execution_start_time : null,
    };
  });
  const fresh = seen ? rows.filter((r) => !seen.has(r.id)) : [];
  seen = new Set(rows.map((r) => r.id));
  set({ recent: rows, recentLoaded: true });
  if (fresh.length) {
    if (fresh.some((r) => r.outputs.length)) bus.emit('outputs:new');
    const ok = fresh.some((r) => r.status === 'completed');
    if (state.vibrate && ok && navigator.vibrate) { try { navigator.vibrate([40, 70, 40]); } catch { /* ignore */ } }
  }
  for (const r of rows) expected.delete(r.id);
  let retry = false;
  for (const [id, left] of [...expected]) {
    if (left <= 0) expected.delete(id); else { expected.set(id, left - 1); retry = true; }
  }
  if (retry) { clearTimeout(recentTimer); recentTimer = setTimeout(doLoadRecent, 700); }
}

// ---- websocket events
function updateRun(id, fn) {
  const run = state.running;
  if (!run || run.id !== id) return;
  set({ running: fn(run) });
}

function ensureRun(id) {
  if (!id || isEnded(id)) return false;
  if (!state.running || state.running.id !== id) {
    set({ running: placeholder(id) });
    scheduleSync(0);
  }
  return true;
}

function wire() {
  ws.on('state', (s) => { set({ conn: s }); if (s === 'open') { sync(); loadRecent(); } });
  ws.on('status', () => scheduleSync(120));

  ws.on('execution_start', (d) => {
    if (!ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => ({ ...r, live: true, startedAt: d.timestamp || Date.now() }));
  });
  ws.on('execution_cached', (d) => {
    if (!ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => ({ ...r, live: true, cached: new Set([...r.cached, ...(d.nodes || [])]) }));
  });
  ws.on('executing', (d) => {
    if (!d || !d.node || !ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => ({ ...r, live: true, current: { nodeId: d.display_node || d.node, value: 0, max: 0 } }));
  });
  ws.on('progress', (d) => {
    if (!ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => ({ ...r, live: true, current: { nodeId: d.node || (r.current && r.current.nodeId), value: d.value, max: d.max } }));
  });
  ws.on('progress_state', (d) => {
    if (!ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => {
      const finished = new Set(r.finished);
      let current = r.current;
      for (const [id, n] of Object.entries(d.nodes || {})) {
        if (n.state === 'finished') finished.add(id);
        else if (n.state === 'running') current = { nodeId: n.display_node_id || id, value: n.value, max: n.max };
      }
      return { ...r, live: true, finished, current };
    });
  });
  ws.on('executed', (d) => {
    const t = d && d.output && d.output.text;
    const vals = (Array.isArray(t) ? t : [t]).filter((v) => typeof v === 'string' && v.trim());
    if (d && d.prompt_id && vals.length) {
      const run = state.running;
      const id = d.display_node || d.node;
      const entry = { node: String(id), title: nodeTitle(run && run.id === d.prompt_id ? run.prompt : null, id), text: vals.join('\n\n') };
      const cur = (state.liveTexts[d.prompt_id] || []).filter((x) => x.node !== entry.node);
      const keep = Object.entries({ ...state.liveTexts, [d.prompt_id]: [...cur, entry] }).slice(-12);
      set({ liveTexts: Object.fromEntries(keep) });
    }
    if (!d || !d.node || !ensureRun(d.prompt_id)) return;
    updateRun(d.prompt_id, (r) => ({ ...r, live: true, finished: new Set([...r.finished, d.node]) }));
  });
  ws.on('preview', (p) => {
    const run = state.running;
    if (!run) return;
    if (p.meta && p.meta.prompt_id && p.meta.prompt_id !== run.id) return;
    set({ running: { ...run, preview: p.url } });
  });
  ws.on('execution_success', (d) => {
    markEnded(d.prompt_id);
    if (state.running && state.running.id === d.prompt_id) set({ running: null });
    loadRecent(d.prompt_id);
    scheduleSync(200);
  });
  ws.on('execution_interrupted', (d) => {
    markEnded(d.prompt_id);
    if (state.running && state.running.id === d.prompt_id) set({ running: null });
    loadRecent(d.prompt_id);
    scheduleSync(200);
  });
  ws.on('execution_error', (d) => {
    const run = state.running;
    const title = nodeTitle(run && run.id === d.prompt_id ? run.prompt : null, d.node_id);
    const err = { nodeId: d.node_id, nodeTitle: title, nodeType: d.node_type, message: d.exception_message || 'Execution failed', type: d.exception_type };
    set({ errors: { ...state.errors, [d.prompt_id]: err } });
    markEnded(d.prompt_id);
    if (run && run.id === d.prompt_id) set({ running: null });
    bus.emit('toast', { msg: `${title || d.node_type}: ${err.message}`.slice(0, 140), kind: 'error', ms: 5000 });
    loadRecent(d.prompt_id);
    scheduleSync(200);
  });
}

// ---- actions
async function post(url, body) {
  try { return await postJSON(url, body); } catch (e) { return { error: e }; }
}

export async function interrupt(id) {
  updateRun(id, (r) => ({ ...r, stopping: true }));
  await post('/interrupt', { prompt_id: id });
  scheduleSync(500);
  loadRecent(id);
}

export async function cancelPending(id) {
  set({ pending: state.pending.filter((p) => p.id !== id) });
  const r = await post(`/api/jobs/${id}/cancel`, {});
  if (r.error) await post('/queue', { delete: [id] });
  scheduleSync(150);
}

export async function clearPending() {
  set({ pending: [] });
  await post('/queue', { clear: true });
  scheduleSync(150);
}

export function setVibrate(v) {
  try { localStorage.setItem(VIB_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  set({ vibrate: v });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  wire();
  startWs();
  sync();
  loadRecent();
  let tick = 0;
  setInterval(() => {
    if (document.hidden) return;
    tick++;
    const busy = state.running || state.pending.length || state.conn !== 'open';
    if (busy || tick % 8 === 0) sync();
  }, 2500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); loadRecent(); } });
}

export const queueStore = {
  get: () => state,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  start, sync, loadRecent, interrupt, cancelPending, clearPending, setVibrate,
  nameJob(id, name) { names.set(id, name); },
};

export function useQueue() {
  const [s, setS] = useState(state);
  useEffect(() => { setS(state); return queueStore.subscribe(setS); }, []);
  return s;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;
/** history rows -> viewer items (output files carry `path`; temp/other types use /view urls) */
export function jobOutputsToItems(rows) {
  const items = [];
  for (const r of rows) {
    for (const o of r.outputs) {
      const kind = VIDEO_EXT.test(o.filename) ? 'video' : 'image';
      const mtime = r.ts ? r.ts / 1000 : undefined;
      if ((o.type || 'output') === 'output') {
        items.push({ path: (o.subfolder ? o.subfolder + '/' : '') + o.filename, name: o.filename, folder: o.subfolder || '', kind, mtime, job: r.id });
      } else {
        const url = `/view?${new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type })}`;
        items.push({ name: o.filename, folder: o.subfolder || '', kind, mtime, url, thumb: kind === 'image' ? url : undefined, job: r.id });
      }
    }
  }
  return items;
}
