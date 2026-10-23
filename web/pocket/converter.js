// UI-workflow -> API-prompt converter. Talks to the desktop frontend running in a hidden same-origin iframe
// (/?pocketconvert=1, handled by web/ext/pocket_ext.js).
//
// Protocol: iframe posts {type:'ready'}; we post {type:'convert', id, workflow, path};
//           iframe replies {type:'converted', id, prompt, structure} or {type:'convert_error', id, message}.
// The convert request may carry modes: {uiNodeId: 0|2|4} (0 on, 2 mute, 4 bypass; subgraph-inner ids are
// "instanceId:innerId"), applied after the workflow is loaded and before it is converted.
// structure = {groups:[{title,nodeIds,mode:0|2|4|'mixed'}], controllers:[{id,title,kind:'bypass'|'mute',groups:[title],
// restriction,mode}], nodes:[{id,title,type,mode,subgraph?:[{id,title,type,mode}]}], apiIds:{uiId:[apiPromptId]}}
// (structure reflects the modes after overrides; it can be null if the frontend failed to build it).
// After a real conversion timeout the iframe reports convert_error and reloads itself: we then wait for a fresh 'ready'.
//
// The iframe is created lazily (it loads the full desktop frontend, which is heavy) and kept for the session.
// Public: convertWorkflow(workflow, path, {signal, onPhase, modes}) -> Promise<prompt>;
//         convertWorkflowFull(...same) -> Promise<{prompt, structure}>;  converterState() ; disposeConverter()
// Phases passed to onPhase: 'starting' (iframe booting) | 'converting'.

const SRC = '/?pocketconvert=1';
const READY_TIMEOUT_MS = 90000;

let frame = null;
let ready = false;
let readyTimer = 0;
let seq = 0;
const jobs = new Map();       // id -> {id, workflow, path, modes, sent, resolve, reject, listeners:Set}
const phaseListeners = new Set();

const phase = () => (ready ? 'converting' : 'starting');
const emitPhase = () => { for (const fn of [...phaseListeners]) { try { fn(phase()); } catch { /* ignore */ } } };

function failAll(message) {
  for (const j of [...jobs.values()]) { jobs.delete(j.id); j.reject(new Error(message)); }
}

function post(msg) {
  try { frame.contentWindow.postMessage(msg, location.origin); } catch { /* frame gone */ }
}

function flush() {
  if (!ready || !frame) return;
  for (const j of jobs.values()) {
    if (j.sent) continue;
    j.sent = true;
    post({ type: 'convert', id: j.id, workflow: j.workflow, path: j.path, modes: j.modes });
  }
}

function armReadyTimer() {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (ready) return;
    failAll('The workflow converter did not start. Is the desktop UI reachable and the Pocket extension loaded?');
    disposeConverter();
  }, READY_TIMEOUT_MS);
}

function onMessage(ev) {
  if (!frame || ev.source !== frame.contentWindow || ev.origin !== location.origin) return;
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'ready') {
    if (ready) {
      // the iframe restarted by itself while we thought it was up: anything in flight is lost
      for (const j of [...jobs.values()]) if (j.sent) { jobs.delete(j.id); j.reject(new Error('Converter restarted, try again')); }
    }
    ready = true;
    clearTimeout(readyTimer);
    emitPhase();
    flush();
  } else if (m.type === 'converted') {
    const j = jobs.get(m.id);
    if (!j) return;
    jobs.delete(m.id);
    if (m.prompt && typeof m.prompt === 'object' && Object.keys(m.prompt).length) j.resolve({ prompt: m.prompt, structure: m.structure || null });
    else j.reject(new Error('Conversion produced an empty prompt'));
  } else if (m.type === 'convert_error') {
    const j = jobs.get(m.id);
    const msg = String(m.message || 'Conversion failed');
    if (/timed out|reloading/i.test(msg)) {
      // iframe reloads itself after a timeout: do not send anything until it announces 'ready' again
      ready = false;
      for (const x of jobs.values()) x.sent = false;
      armReadyTimer();
      emitPhase();
    }
    if (j) { jobs.delete(m.id); j.reject(new Error(msg)); }
  }
}

function ensureFrame() {
  if (frame) return;
  window.addEventListener('message', onMessage);
  frame = document.createElement('iframe');
  frame.src = SRC;
  frame.title = 'ComfyUI workflow converter';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // offscreen but laid out (display:none can break canvas layout in the frontend)
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none;';
  ready = false;
  document.body.appendChild(frame);
  armReadyTimer();
}

export function disposeConverter() {
  clearTimeout(readyTimer);
  window.removeEventListener('message', onMessage);
  if (frame) frame.remove();
  frame = null;
  ready = false;
  failAll('Converter stopped');
  emitPhase();
}

export const converterState = () => ({ exists: !!frame, ready });

/** Convert a UI-format workflow to an API prompt. Rejects with Error(message) on failure / abort. */
export function convertWorkflow(workflow, path, opts) {
  return convertWorkflowFull(workflow, path, opts).then((r) => r.prompt);
}

/** Like convertWorkflow but resolves {prompt, structure}; opts.modes = {uiNodeId: 0|2|4} overrides. */
export function convertWorkflowFull(workflow, path, { signal, onPhase, modes } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    ensureFrame();
    const id = `c${++seq}-${Date.now().toString(36)}`;
    const job = { id, workflow, path, modes: modes || undefined, sent: false, resolve, reject };
    let onAbort = null;
    let unsub = null;
    const cleanup = () => { if (onAbort && signal) signal.removeEventListener('abort', onAbort); if (unsub) unsub(); };
    job.resolve = (v) => { cleanup(); resolve(v); };
    job.reject = (e) => { cleanup(); reject(e); };
    if (onPhase) {
      phaseListeners.add(onPhase);
      unsub = () => phaseListeners.delete(onPhase);
      onPhase(phase());
    }
    if (signal) {
      onAbort = () => { jobs.delete(id); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort);
    }
    jobs.set(id, job);
    flush();
  });
}
