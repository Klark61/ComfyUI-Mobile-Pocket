// Shared end-to-end harness for the phone UI (import it from a scenario file; see e2e_scenarios.mjs).
// Starts its own headless Chrome (CDP port 9226, temp profile, always killed + removed), emulates a phone (390x844, mobile UA, touch),
// opens the live /pocket/ app and drives it through the DOM. Selectors live in SEL below, nowhere else.
//   start() / stop()                      lifecycle
//   loadWorkflow(file)                    Generate > Change > Workflows > re-convert (fresh from the saved file, no stored sections)
//   toggleGroup(title) / toggleSwitch(label) / toggleNode(apiId) / setField(label, value, opts) / getField(label, opts)
//   openAllNodes() / closeSheet() / uploadImage(label, filePath)
//   queueRun({intercept: true|false|'validate'})  true = recorded, never reaches ComfyUI; false = real run; 'validate' = real POST /prompt, then cancelled
//   waitForRun(promptId)  readTextOutputs()  consoleErrors()
// Output: only failures + one summary line per scenario go to stdout; everything goes to tests/e2e-last.log.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WF_DIR, INPUT_DIR, chromePath, installFixture } from './env.mjs';

export { WF_DIR, INPUT_DIR, installFixture };

export const PORT = 9226;
export const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CHROME = chromePath();
const LOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-last.log');
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

// ------------------------------------------------------------------ selectors (the only place that knows the DOM)
export const SEL = {
  gen: '.gen', genReady: '.gen.has', prep: '.qcard.prep', genErr: '.qerr.big',
  hero: '.hero .start', change: '.srcard .btn', tab: '.gsheet [role=tab]',
  wfRow: '.gsheet li.srow.wf', wfTitle: 'strong', wfOpen: '.srow-main', wfReconvert: 'button[aria-label^="Re-convert"]',
  sections: '.fgroup.sections', sectionsHead: '.fgroup.sections .fgroup-h', secRow: '.secrow', secTitle: '.secrow-t', secDisc: '.sec-disc', secCtl: '.sec-ctl', secErr: '.sec-err',
  group: '.fgroup', groupHead: '.fgroup-h',
  row: '.frow', rowLabel: '.flabel-t', textarea: 'textarea.ta', numInput: 'input.num-i', seedInput: 'input.seed-i', textInput: 'input.txt', select: 'select', sw: 'button[role=switch]',
  generate: '.gen-go', chip: '.gentools .chip',
  sheet: '.gsheet', nodesSheet: '.gsheet[aria-label="All nodes"]', nnode: '.nnode', nnodeHead: '.nnode-t', nnodeSwitch: '.nnode-h button[role=switch]', ngroupHead: '.ngroup h3 button',
  result: '.resultcard', tout: '.resultcard .tout', toutTitle: '.tout-t', toutNode: '.tout-h em', toutBody: '.tout-b', toutMore: '.tout .linkbtn',
  fileInput: (label) => `input[type=file][aria-label="Upload ${label}"]`,
};

// ------------------------------------------------------------------ logging / scenario runner
fs.writeFileSync(LOG, `e2e run ${new Date().toISOString()}\n`);
export const log = (...a) => fs.appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const results = [];
let cur = null;
export function check(cond, msg, detail) {
  log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`, detail === undefined ? '' : detail);
  if (cur) cur.checks++;
  if (!cond) { if (cur) cur.fails.push(msg + (detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300))); }
  return !!cond;
}
export async function scenario(name, fn) {
  cur = { name, checks: 0, fails: [], t0: Date.now(), note: '' };
  log(`\n=== ${name}`);
  try { await fn((n) => { cur.note = n; }); } catch (e) { cur.fails.push('EXCEPTION ' + String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); log('EXCEPTION', String((e && e.stack) || e)); }
  const r = cur; cur = null; results.push(r);
  const secs = ((Date.now() - r.t0) / 1000).toFixed(0);
  for (const f of r.fails) console.log(`  FAIL ${r.name}: ${f}`);
  console.log(`${r.fails.length ? 'FAIL' : 'PASS'} ${r.name} (${r.checks} checks, ${secs}s)${r.note ? ' ' + r.note : ''}`);
  return !r.fails.length;
}
export const failed = () => results.filter((r) => r.fails.length).length;

// ------------------------------------------------------------------ CDP session
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chrome = null, profile = null, ws = null, seq = 0, tabId = null;
const pend = new Map();
const errors = [];
let cleaned = false;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pend.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function onEvent(m) {
  const p = m.params || {};
  if (m.method === 'Log.entryAdded' && /navigator\.vibrate/.test((p.entry && p.entry.text) || '')) return;   // headless has no user gesture: harness noise
  const where = (url) => (!url || /\/pocket\//.test(url) ? 'phone' : 'desktop-iframe');
  if (m.method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    const t = (d.exception && (d.exception.description || d.exception.value)) || d.text;
    errors.push({ src: where(d.url), kind: 'exception', text: String(t).slice(0, 400), url: d.url || '' });
  } else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
    const f = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
    errors.push({ src: where(f && f.url), kind: 'console.error', text: (p.args || []).map((a) => a.value !== undefined ? a.value : a.description || a.type).join(' ').slice(0, 400), url: (f && f.url) || '' });
  } else if (m.method === 'Log.entryAdded' && p.entry && p.entry.level === 'error') {
    errors.push({ src: where(p.entry.url), kind: 'log:' + p.entry.source, text: String(p.entry.text).slice(0, 300), url: p.entry.url || '' });
  }
}

/** Evaluate in the page; returns the (JSON) value. Throws on page exceptions. */
export async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 400));
  return r.result.value;
}
/** Poll a page expression until it is truthy. */
export async function waitFor(expr, { timeout = 15000, every = 150, what = expr } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await ev(expr); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout (${timeout}ms) waiting for ${what.slice(0, 160)}`);
    await sleep(every);
  }
}

const HOOK = `(() => {
  if (window !== window.top || window.__e2e) return;
  const st = window.__e2e = { mode: 'real', posts: [] };
  const orig = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    let p = ''; try { p = new URL(url, location.href).pathname; } catch {}
    if (method === 'POST' && p === '/prompt') {
      const rec = { t: Date.now(), body: null, mode: st.mode, status: 0, resp: null };
      try { rec.body = JSON.parse(init.body); } catch {}
      st.posts.push(rec);
      if (st.mode === 'fake') {
        rec.status = 200; rec.resp = { prompt_id: 'e2e-fake-' + st.posts.length, number: st.posts.length, node_errors: {} };
        return new Response(JSON.stringify(rec.resp), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const res = await orig(input, init);
      rec.status = res.status;
      try { rec.resp = await res.clone().json(); } catch {}
      return res;
    }
    return orig(input, init);
  };
})();`;

export async function start() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-phone-'));
  chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop().finally(() => process.exit(130)); });
  process.on('exit', cleanupSync);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; } catch { await sleep(250); } }
  if (!up) throw new Error('Chrome did not start');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  tabId = tab.id;
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) onEvent(m); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await openApp();
}
async function openApp() {
  await send('Page.navigate', { url: `${BASE}/pocket/#/generate` });
  await waitFor(`!!document.querySelector('.tabs') && !!document.querySelector(${JSON.stringify(SEL.gen)}) && !!window.__e2e`, { timeout: 20000, what: 'app shell' });
}
function cleanupSync() {
  if (cleaned) return; cleaned = true;
  try { if (chrome && chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
export async function stop() {
  try { if (ws) ws.close(); } catch {}
  try { if (chrome && chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(800);
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { log('profile cleanup failed', String(e)); }
  cleaned = true;
}
/** Reload the app with a clean phone state (localStorage cleared). */
export async function resetApp() {
  await ev(`localStorage.clear(); sessionStorage.clear(); true`);
  await openApp();
  await ev(`window.__e2e.mode='real'; window.__e2e.posts.length=0; true`);
}

// ------------------------------------------------------------------ page helpers (DOM driving)
const S = JSON.stringify(SEL);
const norm = `const norm=(s)=>String(s||'').replace(/\\s+/g,' ').trim().toLowerCase();`;
const settledExpr = `(()=>{const S=${S};return !!document.querySelector(S.genReady)&&!document.querySelector(S.prep)&&!document.querySelector(S.sections+'[aria-busy="true"]')&&!(document.querySelector(S.generate)||{}).disabled;})()`;
/** Wait for Generate to be idle (loaded, not preparing, Sections not re-converting). */
export const settle = (timeout = 60000) => waitFor(settledExpr, { timeout, what: 'Generate settled' });

/** Open a saved workflow by file name (e.g. "X.json" or "sub/X.json") through the UI. force=true re-converts from the saved file. */
export async function loadWorkflow(file, { force = true, timeout = 120000 } = {}) {
  await resetApp();
  const stem = file.replace(/^.*[\\/]/, '').replace(/\.json$/i, '');
  const t0 = Date.now();
  await ev(`(()=>{const S=${S};const b=document.querySelector(S.hero)||document.querySelector(S.change);b.click();return true})()`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(SEL.tab)}).length>0`, { what: 'source sheet' });
  await ev(`(()=>{const S=${S};[...document.querySelectorAll(S.tab)].find((b)=>/workflows/i.test(b.textContent)).click();return true})()`);
  await waitFor(`document.querySelectorAll(${JSON.stringify(SEL.wfRow)}).length>0`, { what: 'workflow list' });
  const hit = await ev(`(()=>{${norm}const S=${S};const rows=[...document.querySelectorAll(S.wfRow)];
    const r=rows.find((x)=>norm(x.querySelector(S.wfTitle).textContent)===${JSON.stringify(stem.toLowerCase())});
    if(!r) return {err:'not listed: '+${JSON.stringify(stem)}};
    (${force} ? r.querySelector(S.wfReconvert) : r.querySelector(S.wfOpen)).click(); return {ok:1};})()`);
  if (hit.err) throw new Error(hit.err);
  await waitFor(`!!document.querySelector(${JSON.stringify(SEL.prep)})||${settledExpr}||!!document.querySelector(${JSON.stringify(SEL.genErr)})`, { timeout: 10000, what: 'load start' }).catch(() => {});
  await sleep(300);
  const t = Date.now();
  for (;;) {
    const s = await ev(`(()=>{const S=${S};return {ok:${settledExpr},err:(document.querySelector(S.genErr)||{}).textContent||''}})()`);
    if (s.err) throw new Error('load error: ' + s.err.slice(0, 300));
    if (s.ok) break;
    if (Date.now() - t > timeout) throw new Error('timeout loading ' + file);
    await sleep(250);
  }
  // wait for field metadata (object_info) to render fields
  await sleep(600);
  log(`loaded ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { secs: (Date.now() - t0) / 1000 };
}

/** Section group rows currently listed: [{title, on, ctl}] (opens "All groups" when asked). */
export async function listGroups({ all = false } = {}) {
  if (all) await ev(`(()=>{const S=${S};const d=[...document.querySelectorAll(S.secDisc)].find((b)=>/all groups/i.test(b.textContent));if(d&&d.getAttribute('aria-expanded')!=='true')d.click();return true})()`);
  await sleep(150);
  return ev(`(()=>{const S=${S};const out=[];const sec=document.querySelector(S.sections);if(!sec)return out;
    for(const r of sec.querySelectorAll(S.secRow)){const ctl=r.closest(S.secCtl);const h=ctl&&ctl.querySelector('.fnode span');
      out.push({title:r.querySelector(S.secTitle).textContent.trim(),on:r.querySelector(S.sw).getAttribute('aria-checked')==='true',ctl:h?h.textContent.trim():null,sub:r.classList.contains('sub')});}
    return out;})()`);
}
/** Controllers shown in Sections: [{title, kind('mutes'|'bypasses'), groups:[titles]}] */
export async function listControllers() {
  return ev(`(()=>{const S=${S};return [...document.querySelectorAll(S.sections+' '+S.secCtl)].map((c)=>({title:c.querySelector('.fnode span').textContent.trim(),kind:c.querySelector('.fnode em').textContent.trim(),groups:[...c.querySelectorAll(S.secTitle)].map((x)=>x.textContent.trim())}))})()`);
}

/** Flip a Sections group switch by (partial, case-insensitive) title; waits for the re-convert. Returns {before, after}. */
export async function toggleGroup(title, { index = 0 } = {}) {
  const r = await ev(`(()=>{${norm}const S=${S};const t=norm(${JSON.stringify(title)});
    let rows=()=>[...document.querySelectorAll(S.sections+' '+S.secRow)];
    let m=rows().filter((x)=>norm(x.querySelector(S.secTitle).textContent)===t); if(!m.length) m=rows().filter((x)=>norm(x.querySelector(S.secTitle).textContent).includes(t));
    if(!m.length){const d=[...document.querySelectorAll(S.secDisc)].find((b)=>/all groups/i.test(b.textContent)); if(d&&d.getAttribute('aria-expanded')!=='true'){d.click();return {retry:1};}}
    if(!m.length) return {err:'no section group matching '+${JSON.stringify(title)}};
    const b=m[${index}].querySelector(S.sw); const before=b.getAttribute('aria-checked')==='true'; b.click(); return {before};})()`);
  if (r.retry) { await sleep(250); return toggleGroup(title, { index }); }
  if (r.err) throw new Error(r.err);
  await sleep(600);   // debounce (350ms) + render
  await settle();
  const after = (await listGroups({ all: true })).filter((g) => g.title.toLowerCase().includes(title.toLowerCase()))[index];
  return { before: r.before, after: after ? after.on : null };
}

function fieldFinder(opts) {
  return `${norm}const S=${S};const o=${JSON.stringify(opts || {})};
    const scope=document.querySelector(S.sheet)||document.querySelector(S.gen);
    const rows=[...scope.querySelectorAll(S.row)];
    const lab=norm(LABEL);
    let m=rows.filter((r)=>norm((r.querySelector(S.rowLabel)||{}).textContent)===lab);
    if(!m.length) m=rows.filter((r)=>norm((r.querySelector(S.rowLabel)||{}).textContent).includes(lab));
    if(o.node!==undefined) m=m.filter((r)=>String(r.dataset.key).startsWith(o.node+':'));
    if(o.input) m=m.filter((r)=>String(r.dataset.key).endsWith(':'+o.input));
    if(o.kind) m=m.filter((r)=>r.classList.contains('k-'+o.kind));
    if(!m.length) return {err:'no field matching '+LABEL+(o.node!==undefined?' node '+o.node:'')+' (rows: '+rows.map((r)=>(r.querySelector(S.rowLabel)||{}).textContent+'['+r.dataset.key+']').slice(0,40).join(', ')+')'};
    if(m.length>1&&o.index===undefined) return {err:'ambiguous '+LABEL+': '+m.map((r)=>r.dataset.key).join(', ')};
    const row=m[o.index||0];`;
}
/** Current value of a field row: {key, kind, value}. opts: {node, input, kind, index}. */
export async function getField(label, opts = {}) {
  const r = await ev(`(()=>{${fieldFinder(opts).replace(/LABEL/g, JSON.stringify(label))}
    const k=row.className.match(/k-(\\w+)/)[1];let v;
    if(k==='text')v=row.querySelector(S.textarea).value;else if(k==='bool'||k==='switch')v=row.querySelector(S.sw).getAttribute('aria-checked')==='true';
    else if(k==='combo')v=row.querySelector(S.select).value;else if(k==='seed')v=row.querySelector(S.seedInput).value;
    else if(k==='int'||k==='float')v=row.querySelector(S.numInput).value;else if(k==='string')v=row.querySelector(S.textInput).value;else v=null;
    return {key:row.dataset.key,kind:k,value:v};})()`);
  if (r.err) throw new Error(r.err);
  return r;
}
/** Set a field row's value like a user would (input/change events). opts: {node, input, kind, index}. Returns {key, kind}. */
export async function setField(label, value, opts = {}) {
  const r = await ev(`(async()=>{${fieldFinder(opts).replace(/LABEL/g, JSON.stringify(label))}
    const V=${JSON.stringify(value)};const k=row.className.match(/k-(\\w+)/)[1];
    const put=(el,v,ev2)=>{const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,String(v));el.dispatchEvent(new Event(ev2,{bubbles:true}));};
    if(k==='text')put(row.querySelector(S.textarea),V,'input');
    else if(k==='string')put(row.querySelector(S.textInput),V,'input');
    else if(k==='seed')put(row.querySelector(S.seedInput),V,'input');
    else if(k==='int'||k==='float'){const el=row.querySelector(S.numInput);put(el,V,'input');await new Promise((r)=>setTimeout(r,120));el.dispatchEvent(new Event('blur'));}
    else if(k==='combo')put(row.querySelector(S.select),V,'change');
    else if(k==='bool'){const b=row.querySelector(S.sw);if((b.getAttribute('aria-checked')==='true')!==!!V)b.click();}
    else return {err:'unsupported field kind '+k};
    return {key:row.dataset.key,kind:k};})()`);
  if (r.err) throw new Error(r.err);
  await sleep(250);
  return r;
}
/** Flip a Switches-group toggle by its label (e.g. "Enhance prompt?"). Returns the new state. */
export async function toggleSwitch(label, opts = {}) {
  const cur = await getField(label, { ...opts, kind: 'bool' });
  await setField(label, !cur.value, { ...opts, kind: 'bool' });
  const now = await getField(label, { ...opts, kind: 'bool' });
  if (now.value === cur.value) throw new Error(`switch ${label} did not change`);
  return now.value;
}

export async function openAllNodes() {
  await ev(`(()=>{const S=${S};const c=[...document.querySelectorAll(S.chip)].find((b)=>/all nodes/i.test(b.textContent));c.click();return true})()`);
  await waitFor(`!!document.querySelector(${JSON.stringify(SEL.nodesSheet)})&&document.querySelectorAll(${JSON.stringify(SEL.nnode)}).length>0`, { what: 'All nodes sheet' });
  await sleep(300);
}
export async function closeSheet() {
  await ev(`(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return true})()`);
  await sleep(250);
}
/** Inside the open All-nodes sheet: expand the node card (API id) so its fields can be set with setField(label, v, {node}). */
export async function openNodeCard(apiId) {
  const r = await ev(`(()=>{const S=${S};const n=document.querySelector(S.nnode+'[data-node="'+${JSON.stringify(String(apiId))}+'"]');if(!n)return {err:'no node card '+${JSON.stringify(String(apiId))}};
    const h=n.querySelector(S.nnodeHead);if(h.getAttribute('aria-expanded')!=='true')h.click();return {ok:1}})()`);
  if (r.err) throw new Error(r.err);
  await sleep(250);
}
/** Inside the open All-nodes sheet: set a node's bypass switch (on = enabled). Waits for the re-convert. */
export async function toggleNode(apiId, on) {
  const r = await ev(`(()=>{const S=${S};const n=document.querySelector(S.nnode+'[data-node="'+${JSON.stringify(String(apiId))}+'"]');if(!n)return {err:'no node card '+${JSON.stringify(String(apiId))}};
    const b=n.querySelector(S.nnodeSwitch);if(!b)return {err:'node has no bypass switch'};const was=b.getAttribute('aria-checked')==='true';if(was!==${!!on})b.click();return {was};})()`);
  if (r.err) throw new Error(r.err);
  await sleep(700);
  await settle();
  return r;
}
/** Does the open All-nodes sheet list this API node id? */
export const hasNodeCard = (apiId) => ev(`!!document.querySelector(${JSON.stringify(SEL.nnode)}+'[data-node="'+${JSON.stringify(String(apiId))}+'"]')`);
/** Expand/collapse state is per sheet; list node card keys currently rendered. */
export const nodeCards = () => ev(`[...document.querySelectorAll(${JSON.stringify(SEL.nnode)})].map((n)=>n.dataset.node)`);

/** Upload a local file through an Images field's hidden <input type=file> (CDP DOM.setFileInputFiles). Returns the new field value text. */
export async function uploadImage(label, filePath) {
  const { root } = await send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: SEL.fileInput(label) });
  if (!nodeId) throw new Error('no file input for ' + label);
  const before = (await ev(`[...document.querySelectorAll('.imgf-name')].map((e)=>e.textContent)`)).join('|');
  await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(filePath)] });
  await waitFor(`[...document.querySelectorAll('.imgf-name')].map((e)=>e.textContent).join('|')!==${JSON.stringify(before)}`, { timeout: 20000, what: 'upload applied' });
  await sleep(300);
  return ev(`[...document.querySelectorAll('.imgf-name')].map((e)=>e.textContent)`);
}

// ------------------------------------------------------------------ ComfyUI API (from node, not the page)
export const api = async (p, opts) => { const r = await fetch(BASE + p, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
export const postJson = (p, data) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
export const queueState = async () => { const q = (await api('/queue')).body || {}; return { running: (q.queue_running || []).map((x) => x[1]), pending: (q.queue_pending || []).map((x) => x[1]) }; };
export async function ensureIdle() { const q = await queueState(); if (q.running.length || q.pending.length) throw new Error('ComfyUI queue is busy: ' + JSON.stringify(q)); }

/**
 * Press Generate. intercept=true: the POST /prompt is recorded and answered locally (nothing reaches ComfyUI).
 * intercept=false: real run. intercept='validate': the real POST /prompt (real validation), then cancelled at once (interrupt + queue delete).
 * Returns {prompt, body, status, resp, promptId, t0}; `error` is the explained error card text when the queue was refused.
 */
export async function queueRun({ intercept = true } = {}) {
  const mode = intercept === true ? 'fake' : 'real';
  if (mode === 'real') await ensureIdle();
  await settle();
  const n0 = await ev(`window.__e2e.mode=${JSON.stringify(mode)};window.__e2e.posts.length`);
  const t0 = Date.now();
  await ev(`(()=>{document.querySelector(${JSON.stringify(SEL.generate)}).click();return true})()`);
  await waitFor(`window.__e2e.posts.length>${n0}&&!(document.querySelector(${JSON.stringify(SEL.generate)})||{disabled:true}).disabled`, { timeout: 30000, what: 'POST /prompt' });
  const rec = await ev(`window.__e2e.posts[window.__e2e.posts.length-1]`);
  const error = await ev(`(document.querySelector(${JSON.stringify(SEL.genErr)})||{}).textContent||''`);
  const out = { prompt: rec.body && rec.body.prompt, body: rec.body, status: rec.status, resp: rec.resp, promptId: rec.resp && rec.resp.prompt_id, t0, error };
  log(`queueRun ${intercept} -> HTTP ${rec.status} ${out.promptId || ''} ${error ? 'error card: ' + error.slice(0, 200) : ''}`);
  if (intercept === 'validate' && out.promptId) await cancel(out.promptId);
  await ev(`window.__e2e.mode='real';true`);
  return out;
}
/** Cancel a just-queued prompt and make sure nothing is left running or pending. */
export async function cancel(promptId) {
  await postJson('/queue', { delete: [promptId] });
  let q = await queueState();
  if (q.running.includes(promptId)) { await postJson('/interrupt', {}); }
  for (let i = 0; i < 40; i++) { q = await queueState(); if (!q.running.length && !q.pending.length) break; await sleep(250); }
  await postJson('/history', { delete: [promptId] });
  await sleep(300);
  return queueState();
}

/** Wait for a real run to reach history. Returns {ok, status, error, secs (wall, from queueRun t0), execSecs, outputs, history}. */
export async function waitForRun(promptId, { timeout = 240000, t0 = Date.now() } = {}) {
  const t = Date.now();
  for (;;) {
    const h = (await api('/history/' + promptId)).body;
    const e = h && h[promptId];
    if (e && e.status && (e.status.completed || e.status.status_str === 'error')) {
      const msgs = e.status.messages || [];
      const stamp = (name) => { const m = msgs.find((x) => x[0] === name); return m && m[1] && m[1].timestamp; };
      const s0 = stamp('execution_start'), s1 = stamp('execution_success') || stamp('execution_error');
      const err = msgs.find((x) => x[0] === 'execution_error');
      const outputs = Object.values(e.outputs || {}).flatMap((o) => o.images || []);
      return { ok: e.status.status_str === 'success' && !err, status: e.status.status_str, error: err ? `${err[1].node_type} #${err[1].node_id}: ${err[1].exception_message}` : '', secs: (Date.now() - t0) / 1000, execSecs: s0 && s1 ? (s1 - s0) / 1000 : null, outputs, history: e };
    }
    if (Date.now() - t > timeout) { await postJson('/interrupt', {}).catch(() => {}); throw new Error(`run ${promptId} not finished after ${timeout / 1000}s (interrupted)`); }
    await sleep(1000);
  }
}

/** Text outputs on the Generate "Text output" card: [{title, node, text}]. */
export async function readTextOutputs() {
  return ev(`(()=>{const S=${S};return [...document.querySelectorAll(S.tout)].map((t)=>({title:t.querySelector(S.toutTitle).textContent,node:t.querySelector(S.toutNode).textContent.replace('#',''),text:t.querySelector(S.toutBody).textContent}))})()`);
}
/** Wait until the Generate card shows at least `n` text outputs. */
export const waitForTextOutputs = async (n = 1, timeout = 60000) => { await waitFor(`document.querySelectorAll(${JSON.stringify(SEL.tout)}).length>=${n}`, { timeout, what: 'text output card' }); return readTextOutputs(); };

/** Console/page errors seen so far: [{src:'phone'|'desktop-iframe', kind, text, url}]. */
export const consoleErrors = ({ phoneOnly = false } = {}) => errors.filter((e) => !phoneOnly || e.src === 'phone');
export const clearConsoleErrors = () => { errors.length = 0; };
