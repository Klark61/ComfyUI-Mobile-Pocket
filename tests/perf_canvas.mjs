// Measurement spike: why does the real ComfyUI desktop frontend lag on a Galaxy A54, and what does each mitigation buy?
//   node tests/perf_canvas.mjs [--only name,name] [--wf a.json,b.json] [--short] [--gpu] [--list] [--json out.json]
// Launches its own headless Chrome (port 9227, temp profile, always cleaned up) against the live ComfyUI (not restarted),
// emulates a Galaxy A54 (412x915 css px, DPR 2.625, mobile, touch, Android UA, 4x CPU throttle) and loads /?desktop=1.
// No product code is touched; settings are changed only at runtime in the page (never POSTed to the server).
// --only canvas runs the canvas-mode page (GET /pocket/canvas?path=<wf>, or boot.js injected through CDP when the route is not loaded yet):
//   node tests/perf_canvas.mjs --gpu --only canvas --wf <file in WF_DIR>   (done when: app ready <= 16 s, canvas visible >= 85%)
// For the canvas config 'canvas visible' does not count the graph's own DOM widgets (textareas etc.) as covering, only UI overlays.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WF_DIR, chromePath, workflowsFor } from './env.mjs';

const PORT = 9227;
const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CHROME = chromePath();
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const W = 412, H = 915;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes('--' + k);
const SHORT = has('short');          // 3 s gestures instead of 5 s (used for the per-pack bisect)
const GPU = has('gpu');
const PROFILE = has('profile');   // CPU-profile the pan and print top self-time functions (adds overhead; use for attribution, not for fps)              // let headless Chrome use the real GPU instead of software raster
// hard limit (default 180 s, --limit <s> to raise it for the full matrix) + one progress line per phase on stderr
const T0 = Date.now(), LIVE = new Set(); let STEP = 'start';
const step = (n) => { STEP = n; console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${n}`); };
setTimeout(() => {
  console.error(`TIMEOUT at step ${STEP}`);
  for (const pid of LIVE) { try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  setTimeout(() => process.exit(2), 1000);
}, 1000 * Number(opt('limit') || 180)).unref?.();
const GESTURE_MS = SHORT ? 3000 : 5000;
const IDLE_MS = SHORT ? 3000 : 5000;

// ---------------------------------------------------------------- Chrome / CDP
async function launch({ dpr = 2.625, throttle = 4 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-canvas-'));
  const flags = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-precise-memory-info', '--js-flags=--expose-gc'];
  if (!GPU) flags.push('--disable-gpu');
  flags.push('about:blank');
  const chrome = spawn(CHROME, flags, { stdio: 'ignore' });
  LIVE.add(chrome.pid);
  const kill = () => { try { LIVE.delete(chrome.pid); if (chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
  const cleanup = async () => { kill(); await sleep(700); for (let i = 0; i < 5; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); } } };
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let n = 0; const pend = new Map(); const listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const { r, j } = pend.get(m.id); pend.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); }
      else if (m.method) for (const l of listeners) l(m);
    };
    const send = (method, params = {}) => new Promise((r, j) => { const id = ++n; pend.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
    const on = (fn) => listeners.push(fn);
    const ev = async (expression, awaitPromise = true) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
      return r.result.value;
    };
    await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: true,
      screenOrientation: { type: 'portraitPrimary', angle: 0 } });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l',
      userAgentMetadata: { brands: [{ brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }], fullVersion: '130.0.0.0', platform: 'Android', platformVersion: '14', architecture: '', model: 'SM-A546B', mobile: true } });
    if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });
    return { send, on, ev, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

// ---------------------------------------------------------------- in-page instrumentation (installed before any page script)
const INSTRUMENT = `(()=>{
  const P=window.__perf={t0:performance.now(),readyAt:null,frames:null,long:[],errors:0,extLoaded:0};
  try{new PerformanceObserver((l)=>{for(const e of l.getEntries())P.long.push([e.startTime,e.duration])}).observe({type:'longtask',buffered:true})}catch{}
  const poll=()=>{ if(P.readyAt===null&&window.app&&app.graph&&app.canvas&&app.canvas.canvas)P.readyAt=performance.now(); if(P.readyAt===null)setTimeout(poll,10)};
  poll();
  P.startFrames=()=>{P.frames=[];P.fl0=P.long.length;const f=(t)=>{if(P.frames)P.frames.push(t);if(P.frames)requestAnimationFrame(f)};requestAnimationFrame(f)};
  P.stopFrames=()=>{const fr=P.frames;P.frames=null;const lt=P.long.slice(P.fl0);
    const d=[];for(let i=1;i<fr.length;i++)d.push(fr[i]-fr[i-1]);d.sort((a,b)=>a-b);
    const dur=fr.length>1?fr[fr.length-1]-fr[0]:0;
    return {fps:dur?+((fr.length-1)*1000/dur).toFixed(1):0,p50:+(d[d.length>>1]||0).toFixed(1),p95:+(d[Math.floor(d.length*0.95)]||0).toFixed(1),max:+(d[d.length-1]||0).toFixed(0),
      jank:d.filter((x)=>x>50).length,longTasks:lt.length,longMs:Math.round(lt.reduce((a,x)=>a+x[1],0))}};
})()`;

// ---------------------------------------------------------------- touch synthesis
async function touch(S, type, pts) { await S.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i + 1, radiusX: 4, radiusY: 4, force: 1 })) }); }
const state = (S) => S.ev(`(()=>{const c=app.canvas,d=c.ds;return JSON.stringify({s:+d.scale.toFixed(4),x:+d.offset[0].toFixed(1),y:+d.offset[1].toFixed(1),links:Object.keys(app.graph.links||{}).length||app.graph.links?.size||0,lowq:!!c.low_quality,sel:Object.keys(c.selected_nodes||{}).length})})()`).then(JSON.parse);
// 60 Hz timed gesture: fn(progress 0..1) -> touch point list. Returns once finished.
async function gesture(S, ms, fn) {
  const pts0 = fn(0);
  await touch(S, 'touchStart', pts0);
  const t0 = Date.now(); let last = pts0;
  while (true) {
    const p = (Date.now() - t0) / ms; if (p >= 1) break;
    last = fn(p); await touch(S, 'touchMove', last);
    await sleep(Math.max(0, 16 - ((Date.now() - t0) % 16)));
  }
  await touch(S, 'touchEnd', []);
}
// find a screen point (css px) that is on empty canvas (no node) so that a drag pans instead of dragging a node
const EMPTY_POINT = `(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),g=app.graph;
  const cands=[];for(let y=90;y<${H}-60;y+=45)for(let x=30;x<${W}-30;x+=45)cands.push([x,y]);
  const sc=c.ds.scale;let best=null,bd=-1;
  for(const [x,y] of cands){const gp=[(x-r.left)/sc-c.ds.offset[0],(y-r.top)/sc-c.ds.offset[1]];
    let ok=true;for(let dx=-150;dx<=150&&ok;dx+=50)for(let dy=-150;dy<=150;dy+=50){const q=[(x+dx-r.left)/sc-c.ds.offset[0],(y+dy-r.top)/sc-c.ds.offset[1]];if(g.getNodeOnPos(q[0],q[1])){ok=false;break}}
    if(ok){for(const [dx,dy] of [[0,0],[-100,0],[100,0],[0,-80],[0,80]])if(document.elementFromPoint(x+dx,y+dy)!==c.canvas){ok=false;break}}
    if(ok){best=[x,y];break}}
  return JSON.stringify(best||[${W / 2},${H / 2}])})()`;

function summarizeProfile(pr) {
  const self = new Map(); const dt = pr.timeDeltas; const byId = new Map(pr.nodes.map((n) => [n.id, n]));
  pr.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (dt[i] || 0)); });
  const fn = new Map(), file = new Map(); let total = 0;
  for (const [id, t] of self) { const n = byId.get(id), cf = n.callFrame; total += t;
    const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop() + ':' + cf.lineNumber; fn.set(k, (fn.get(k) || 0) + t);
    const f = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, '') : '(' + (cf.functionName || 'native') + ')'; file.set(f, (file.get(f) || 0) + t); }
  const parent = new Map(); for (const n of pr.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const incl = new Map();
  for (const [id, t] of self) { const seen = new Set(); for (let cur = id; cur !== undefined; cur = parent.get(cur)) { const cf = byId.get(cur).callFrame; const k = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').pop() + ':' + cf.lineNumber; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + t); } } }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v / 1000)]);
  return { totalMs: Math.round(total / 1000), topFunctions: top(fn, 14), topFiles: top(file, 10), topInclusive: top(incl, 40) };
}
async function measureGestures(S) {
  const out = {};
  const [cx, cy] = JSON.parse(await S.ev(EMPTY_POINT));
  // two-finger pan (one-finger drag on empty canvas does not pan in the desktop frontend, see touch probe), triangle wave so the view stays on screen
  const tri = (p) => { const q = (p * 2) % 1, v = p < 0.5 ? q : 1 - q; return v; };
  const s0 = await state(S);
  const pm = async () => Object.fromEntries((await S.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await S.send('Performance.enable'); const m0 = await pm();
  if (PROFILE) { await S.send('Profiler.enable'); await S.send('Profiler.setSamplingInterval', { interval: 500 }); await S.send('Profiler.start'); }
  await S.ev('__perf.startFrames()'); await gesture(S, GESTURE_MS, (p) => { const dx = -50 + 100 * tri(p * 2), dy = -40 + 80 * tri(p * 2 + 0.3); return [[cx - 35 + dx, cy + dy, 1], [cx + 35 + dx, cy + dy, 2]]; });
  out.pan = await S.ev('__perf.stopFrames()'); const s1 = await state(S);
  const m1 = await pm(); const d = (k) => Math.round((m1[k] - m0[k]) * 1000);
  out.pan.breakdownMs = { script: d('ScriptDuration'), layout: d('LayoutDuration'), style: d('RecalcStyleDuration'), task: d('TaskDuration'), layouts: Math.round(m1.LayoutCount - m0.LayoutCount), styleRecalcs: Math.round(m1.RecalcStyleCount - m0.RecalcStyleCount) };
  if (PROFILE) out.profile = summarizeProfile((await S.send('Profiler.stop')).profile);
  out.pan.moved = Math.round(Math.hypot(s1.x - s0.x, s1.y - s0.y)); out.pan.scaleChanged = s1.s !== s0.s;
  await sleep(400);
  // pinch: two fingers spread 50 -> 220 -> 50 px
  const a = await state(S);
  await S.ev('__perf.startFrames()'); await gesture(S, GESTURE_MS, (p) => { const d = 30 + 40 * (1 - Math.cos(p * 2 * Math.PI)) / 2; return [[cx - d, cy, 1], [cx + d, cy, 2]]; });
  out.pinch = await S.ev('__perf.stopFrames()'); const b = await state(S);
  out.pinch.scaleBefore = a.s; out.pinch.scaleAfterPeak = null; out.pinch.scaleEnd = b.s; out.pinch.scaleChanged = Math.abs(b.s - a.s) > 1e-3;
  return out;
}


// ---------------------------------------------------------------- canvas mode page
const CANVAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'canvas');
async function canvasEntry(S, wfName) {
  let route = false;
  try { route = (await fetch(`${BASE}/pocket/canvas`)).status === 200; } catch {}
  if (!route) {   // route not loaded in the running ComfyUI yet: inject the same layer through CDP and serve /pocket/static/canvas/* from disk
    await S.send('Fetch.enable', { patterns: [{ urlPattern: '*/pocket/static/canvas/*', requestStage: 'Request' }, { urlPattern: '*/pocket/api/canvas/node-packs*', requestStage: 'Request' }] });
    S.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      if (/\/pocket\/api\/canvas\/node-packs/.test(m.params.request.url)) {   // route missing: CANVAS_FAKE_MAP=<json file> stands in for it (else 404)
        const fm = process.env.CANVAS_FAKE_MAP;
        S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: fm ? 200 : 404, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: fm ? fs.readFileSync(fm).toString('base64') : '' }).catch(() => {});
        return;
      }
      if (!/\/pocket\/static\/canvas\//.test(m.params.request.url)) return;
      const f = path.join(CANVAS_DIR, new URL(m.params.request.url).pathname.split('/').pop());
      if (!fs.existsSync(f)) { S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 404, body: '' }).catch(() => {}); return; }
      S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: f.endsWith('.css') ? 'text/css' : 'text/javascript' }], body: fs.readFileSync(f).toString('base64') }).catch(() => {});
    });
    const boot = fs.readFileSync(path.join(CANVAS_DIR, 'boot.js'), 'utf8'), css = JSON.stringify(fs.readFileSync(path.join(CANVAS_DIR, 'canvas.css'), 'utf8'));
    await S.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__COMFY_CANVAS__=1;if(/^https?:/.test(location.protocol)){document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${css};document.head.appendChild(s);});}
` + boot });
  }
  const q = `?path=${encodeURIComponent(wfName)}${opt('cq') || ''}`;   // --cq "&prune=all" / "&prune=0" / "&ext=all" / "&dpr=1" for experiments
  return { route, url: route ? `${BASE}/pocket/canvas${q}` : `${BASE}/${q}&canvas=1` };
}

// ---------------------------------------------------------------- one measured session
function blockPlan(block) {
  // block: null | {all:true, keep:[pack]} | {packs:[...]}
  if (!block) return null;
  return block;
}
async function runConfig(cfg, wfName) {
  const S = await launch({ dpr: cfg.dpr ?? 2.625, throttle: cfg.throttle ?? 4 });
  const res = { name: cfg.name, wf: wfName, dpr: cfg.dpr ?? 2.625 };
  try {
    const errs = { total: 0, idle: 0, samples: [] }; let counting = 'load';
    const noteErr = (txt) => { errs.total++; if (counting === 'idle') errs.idle++; if (errs.samples.length < 4) errs.samples.push(String(txt).slice(0, 140)); };
    S.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') noteErr(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') noteErr((m.params.args[0]?.value ?? m.params.args[0]?.description) || 'console.error');
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') noteErr(m.params.entry.text + ' ' + (m.params.entry.url || ''));
    });
    const blocked = new Set();
    const b = blockPlan(cfg.block);
    if (b) {
      await S.send('Fetch.enable', { patterns: [{ urlPattern: '*/extensions/*', requestStage: 'Request' }] });
      S.on((m) => {
        if (m.method !== 'Fetch.requestPaused') return;
        const u = m.params.request.url; const mm = u.match(/\/extensions\/([^/]+)\/.*?\.(?:js|mjs)(?:\?|$)/);
        const pack = mm && mm[1];
        const hit = pack && pack !== 'core' && (b.all ? !(b.keep || []).includes(pack) : (b.packs || []).includes(pack));
        if (hit) { blocked.add(pack); S.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
        else S.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      });
    }
    await S.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    step(`${cfg.name} ${wfName}: loading`);
    const t0 = Date.now();
    let navUrl = `${BASE}/?desktop=1`;
    if (cfg.canvas) { const ce = await canvasEntry(S, wfName); navUrl = ce.url; res.canvasRoute = ce.route; }
    await S.send('Page.navigate', { url: navUrl });
    const deadline = Date.now() + 45000; let readyMs = null;
    while (Date.now() < deadline) {
      await sleep(100);
      try { const r = await S.ev('__perf.readyAt', false); if (r) { readyMs = Math.round(r); break; } } catch {}
    }
    if (readyMs === null) throw new Error('app never became ready');
    step(`${cfg.name} ${wfName}: app ready ${readyMs} ms`);
    res.readyMs = readyMs; res.blockedPacks = blocked.size;
    await sleep(1500);                       // let extension setup()/node-def registration finish
    // clean up UI that would distract a graph measurement but is not part of the test: nothing is changed on the server.
    if (cfg.canvas) {   // the workflow is opened by ?path inside boot.js
      const t = await S.ev(`(async()=>{const B=window.__canvasBoot;await B.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return JSON.stringify({at:Math.round(B.readyAt),state:B.pathState,nodes:app.graph._nodes.length,errors:B.errors})})()`);
      const c = JSON.parse(t); res.graphReadyMs = c.at; res.loadMs = c.at - res.readyMs; res.nodes = c.nodes; res.pathState = c.state; if (c.errors.length) res.bootErrors = c.errors;
    } else {
      const wfJson = fs.readFileSync(path.join(WF_DIR, wfName), 'utf8');
      await S.ev(`window.__wf=${wfJson}; 0`, false);
      const lt0 = Date.now();
      const loadRes = await S.ev(`(async()=>{const t=performance.now();await app.loadGraphData(window.__wf,true,true,${JSON.stringify(wfName)});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return JSON.stringify({ms:Math.round(performance.now()-t),nodes:app.graph._nodes.length})})()`);
      const lr = JSON.parse(loadRes); res.loadMs = lr.ms; res.nodes = lr.nodes; res.graphReadyMs = res.readyMs + 1500 + lr.ms;
    }
    // a usable phone zoom (0.7, above the 0.6 low-quality threshold), centred on the densest window of the graph so every config sees the same nodes
    res.view = JSON.parse(await S.ev(`(()=>{const c=app.canvas,sc=0.7,vw=${W}/sc,vh=${H}/sc,ns=app.graph._nodes;let best=null,bn=-1;
      for(const a of ns){const x=a.pos[0]-20,y=a.pos[1]-60;let n=0;for(const b of ns)if(b.pos[0]>=x&&b.pos[0]<x+vw&&b.pos[1]>=y&&b.pos[1]<y+vh)n++;if(n>bn){bn=n;best=[x,y]}}
      if(!best)best=[0,0];c.ds.scale=sc;c.ds.offset=[-best[0],-best[1]];c.setDirty(true,true);return JSON.stringify({nodesInView:bn,at:best.map(Math.round)})})()`));
    // low-quality rendering: 'lowq' forces it always on (what zooming out below the LOD threshold does); 'lodFont' raises the MinFontSizeForLOD setting
    // (the real user knob: threshold = fontSize / (NODE_TEXT_SIZE * sqrt(dpr)), 0.35 at DPR 2.625 with the default 8) so LOD kicks in at the working zoom.
    if (cfg.lowq) await S.ev(`(()=>{const c=app.canvas;c._lowQualityZoomThreshold=1e9;c._isLowQuality=true;c.setDirty(true,true);return 1})()`, false);
    if (cfg.lodFont) await S.ev(`(()=>{const c=app.canvas;c.min_font_size_for_lod=${cfg.lodFont};c.ds.onChanged(c.ds.scale,c.ds.offset);return 1})()`, false);
    await sleep(1200);
    if (opt('probe')) res.probe = await S.ev(fs.readFileSync(opt('probe'), 'utf8'));
    // is the low-quality override effective?
    res.lowQualityActive = (await state(S)).lowq;
    if (cfg.dpr === undefined && cfg.name === 'baseline') res.dprActual = await S.ev('devicePixelRatio', false);
    // static metrics
    await S.send('HeapProfiler.collectGarbage').catch(() => {}); await sleep(300);
    const st = JSON.parse(await S.ev(`JSON.stringify({heapMB:+(performance.memory.usedJSHeapSize/1048576).toFixed(1),
      dom:document.getElementsByTagName('*').length,
      domWidgets:document.querySelectorAll('.dom-widget, .comfy-multiline-input, .comfy-markdown, textarea').length,
      textareas:document.querySelectorAll('textarea').length,
      canvasPx:app.canvas.canvas.width+'x'+app.canvas.canvas.height,
      exts:(app.extensions||[]).length, nodes:app.graph._nodes.length, links:app.graph.links instanceof Map?app.graph.links.size:Object.keys(app.graph.links).length,
      canvasVisiblePct:(()=>{let t=0,k=0;for(let y=10;y<${H};y+=25)for(let x=6;x<${W};x+=25){t++;{const e=document.elementFromPoint(x,y);if(e===app.canvas.canvas||(${cfg.canvas?'true':'false'}&&e&&e.closest&&e.closest('.dom-widget,.comfy-multiline-input,.comfy-markdown')))k++}}return Math.round(100*k/t)})(),
      dpr:devicePixelRatio,lowq:!!app.canvas.low_quality,scale:app.canvas.ds.scale})`));
    Object.assign(res, st);
    // idle errors + idle frame cost
    counting = 'idle'; await S.ev('__perf.startFrames()'); await sleep(IDLE_MS);
    const idle = await S.ev('__perf.stopFrames()'); counting = 'after';
    res.idleErrPerSec = +(errs.idle / (IDLE_MS / 1000)).toFixed(2); res.errTotal = errs.total; res.errSamples = errs.samples; res.idle = idle;
    if (cfg.previews === 'on') res.previewTarget = await startPreviews(S);
    if (!has('nogesture')) {
      const g = await measureGestures(S); res.pan = g.pan; res.pinch = g.pinch; if (g.profile) res.profile = g.profile;
      res.heapAfterMB = +(await S.ev('performance.memory.usedJSHeapSize/1048576', false)).toFixed(1);
    }
    res.longTasksTotal = await S.ev('__perf.long.length', false);
  } finally { await S.cleanup(); }
  return res;
}

// Synthetic latent-preview load: dispatches what the websocket handler dispatches while a sampler runs (a 512x512 jpeg every 250 ms,
// ~4 Hz like TAESD previews) on a KSampler in the graph, while the normal pan/pinch gestures run. "Previews off" is simply the baseline
// (no preview events). Caveat: no real job is queued, so execution-state redraws (progress bar, executing-node highlight) are not simulated.
async function startPreviews(S) {
  return S.ev(`(async()=>{const api=(await import('/scripts/api.js')).api;
    const c=document.createElement('canvas');c.width=c.height=512;const x=c.getContext('2d');
    const mk=async(i)=>{x.fillStyle='hsl('+(i*37%360)+',70%,50%)';x.fillRect(0,0,512,512);for(let k=0;k<400;k++){x.fillStyle='hsl('+((k*7+i*13)%360)+',60%,'+(20+k%60)+'%)';x.fillRect((k*53+i*5)%512,(k*29)%512,40,40)}return await new Promise(r=>c.toBlob(r,'image/jpeg',0.8))};
    const target=app.graph._nodes.find(n=>/sampler/i.test(n.type))||app.graph._nodes[0];
    window.__pv={n:0,id:target.id};
    window.__pvTimer=setInterval(async()=>{const b=await mk(window.__pv.n++);const id=String(target.id);
      api.dispatchEvent(new CustomEvent('b_preview_with_metadata',{detail:{blob:b,displayNodeId:id,parentNodeId:id,realNodeId:id,nodeId:id,jobId:'perf'}}));api.dispatchEvent(new CustomEvent('b_preview',{detail:b}))},250);
    return JSON.stringify({node:target.type,id:target.id})})()`);
}

// ---------------------------------------------------------------- touch capability probe (separate, small graph)
async function touchProbe() {
  const S = await launch({ dpr: 2.625, throttle: 1 });
  const out = {};
  try {
    await S.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    await S.send('Page.navigate', { url: `${BASE}/?desktop=1` });
    for (let i = 0; i < 400; i++) { await sleep(100); if (await S.ev('__perf.readyAt', false).catch(() => 0)) break; }
    await sleep(2500);
    out.navigationMode = await S.ev(`(()=>{try{return app.extensionManager.setting.get('Comfy.Canvas.NavigationMode')}catch(e){return 'n/a '+e.message}})()`);
    out.canvasTouchAction = await S.ev(`getComputedStyle(app.canvas.canvas).touchAction`, false);
    out.settings = await S.ev(`(()=>{const g=(k)=>{try{return app.extensionManager.setting.get(k)}catch{return 'n/a'}};return JSON.stringify({leftClick:g('Comfy.Canvas.LeftMouseClickBehavior'),nav:g('Comfy.Canvas.NavigationMode'),lowqThreshold:g('LiteGraph.Canvas.LowQualityRenderingZoomThreshold'),minFontLOD:g('LiteGraph.Canvas.MinFontSizeForLOD'),linkRender:g('Comfy.LinkRenderMode'),rightPanel:g('Comfy.RightSidePanel.IsOpen'),minimap:g('Comfy.Minimap.Visible'),vueNodes:g('Comfy.VueNodes.Enabled'),canvasInfo:g('Comfy.Graph.CanvasInfo')})})()`);
    out.touchEvents = await S.ev(`'ontouchstart' in window`, false);
    out.dialogsAtStart = await S.ev(`JSON.stringify([...document.querySelectorAll('[role=dialog]')].map(d=>d.innerText.slice(0,120)))`);
    // fresh two-node graph
    await S.ev(`(async()=>{app.graph.clear();
      const a=LiteGraph.createNode('EmptyLatentImage'),b=LiteGraph.createNode('KSampler');
      a.pos=[110,205];b.pos=[110,420];app.graph.add(a);app.graph.add(b);
      app.canvas.ds.scale=0.75;app.canvas.ds.offset=[0,0];app.canvas.setDirty(true,true);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()`);
    // screen coordinates of A.LATENT output and B.latent_image input
    const pos = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),g=app.graph._nodes;const a=g.find(n=>n.type==='EmptyLatentImage'),b=g.find(n=>n.type==='KSampler');
      const oi=a.outputs.findIndex(o=>o.type==='LATENT'),ii=b.inputs.findIndex(i=>i.name==='latent_image');
      const o=a.getConnectionPos(false,oi),i=b.getConnectionPos(true,ii);
      const sc=c.ds.scale,f=(p)=>[(p[0]+c.ds.offset[0])*sc+r.left,(p[1]+c.ds.offset[1])*sc+r.top];
      return JSON.stringify({o:f(o),i:f(i),aId:a.id,bId:b.id,rect:[r.left,r.top,r.width,r.height]})})()`));
    if (process.env.SHOT) { const r = await S.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.SHOT, Buffer.from(r.data, 'base64')); }
    out.slotPositions = pos; out.nodeBottom = await S.ev(`(()=>{const b=app.graph._nodes.find(n=>n.type==='KSampler');return b.pos[1]+b.size[1]+16})()`);
    await S.ev(`window.__pe=[];for(const t of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchmove','touchend'])document.addEventListener(t,(e)=>{if(__pe.length<400)__pe.push((e.target.id||e.target.className||e.target.tagName).toString().slice(0,30)+'>'+e.type+':'+(e.pointerType||'')+':'+(e.defaultPrevented?'P':''))},{capture:true,passive:true});0`, false);
    const drag = async (from, to, steps = 25, tag = 'd') => {
      out['top_' + tag] = await S.ev(`(()=>{const e=document.elementFromPoint(${from[0]},${from[1]});return e.tagName+'#'+e.id+'.'+String(e.className).slice(0,40)})()`);
      await touch(S, 'touchStart', [[from[0], from[1], 1]]); await sleep(60);
      for (let i = 1; i <= steps; i++) {
        await touch(S, 'touchMove', [[from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps, 1]]); await sleep(16);
        if (i === (steps >> 1)) out['mid_' + tag] = await S.ev(`JSON.stringify({connecting:!!(app.canvas.linkConnector&&app.canvas.linkConnector.isConnecting),dragging:!!app.canvas.dragging_canvas,node:!!app.canvas.node_dragged,links:app.canvas.connecting_links&&app.canvas.connecting_links.length})`);
      }
      await sleep(60); await touch(S, 'touchEnd', []); await sleep(400);
      out['ev_' + tag] = (await S.ev(`(()=>{const c={};for(const e of __pe)c[e]=(c[e]||0)+1;__pe.length=0;return JSON.stringify(c)})()`));
    };
    const reset = () => S.ev(`(()=>{app.canvas.ds.scale=0.75;app.canvas.ds.offset=[0,0];app.canvas.setDirty(true,true);return 1})()`, false);
    // 1. link drag output -> input with one finger
    let s0 = await state(S);
    await drag(pos.o, pos.i, 25, 'link');
    let s1 = await state(S);
    out.afterLinkEls = await S.ev(`JSON.stringify({search:!!document.querySelector('.node-search-box, .comfy-vue-node-search-container, [class*=search-box]'),dialogs:document.querySelectorAll('[role=dialog]').length,dlg:[...document.querySelectorAll('[role=dialog]')].map(d=>d.innerText.slice(0,120)),ctx:!!document.querySelector('.litecontextmenu'),a:app.graph._nodes.map(n=>[n.type,n.pos[0]|0,n.pos[1]|0])})`);
    out.linkDrag = { linksBefore: s0.links, linksAfter: s1.links, connected: s1.links > s0.links, viewPannedInstead: Math.abs(s1.x - s0.x) + Math.abs(s1.y - s0.y) > 5 };
    // 1b/1c. controls: same drag with a mouse, and with touch dropped on the node body (not exactly on the slot)
    const clearLinks = async () => {
      await S.ev(`(()=>{for(const n of app.graph._nodes)for(const i of n.inputs||[])if(i.link!=null)n.disconnectInput(n.inputs.indexOf(i));app.canvas.setDirty(true,true);return 1})()`, false);
      for (let k = 0; k < 3 && await S.ev(`document.querySelectorAll('[role=dialog]').length`, false); k++) {
        for (const type of ['keyDown', 'keyUp']) await S.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300);
      }
    };
    await clearLinks(); await sleep(300);
    const mouse = async (type, x, y, extra = {}) => S.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    s0 = await state(S); await mouse('mouseMoved', pos.o[0], pos.o[1], { button: 'none', buttons: 0 }); await mouse('mousePressed', pos.o[0], pos.o[1]);
    for (let i = 1; i <= 25; i++) { await mouse('mouseMoved', pos.o[0] + (pos.i[0] - pos.o[0]) * i / 25, pos.o[1] + (pos.i[1] - pos.o[1]) * i / 25); await sleep(16); }
    await mouse('mouseReleased', pos.i[0], pos.i[1]); await sleep(400); s1 = await state(S);
    out.linkDragMouseControl = { connected: s1.links > s0.links };
    await clearLinks(); await sleep(300); s0 = await state(S);
    await drag(pos.o, [pos.i[0] + 120, pos.i[1] - 10], 25, 'linkBody'); s1 = await state(S);
    out.linkDragTouchToNodeBody = { connected: s1.links > s0.links };
    await clearLinks(); await sleep(300); s0 = await state(S);
    await drag([pos.o[0] - 6, pos.o[1]], [pos.i[0] + 4, pos.i[1]], 25, 'linkSlot2'); s1 = await state(S);
    out.linkDragTouchSlotNudged = { connected: s1.links > s0.links };
    await clearLinks(); await sleep(300); await reset();
    // 2. one-finger drag on empty canvas
    await reset(); const [ex, ey] = JSON.parse(await S.ev(EMPTY_POINT)); out.emptyPoint = [ex, ey]; s0 = await state(S); await drag([ex + 60, ey + 40], [ex - 60, ey - 40], 25, 'empty'); s1 = await state(S);
    out.oneFingerEmptyDrag = { dx: s1.x - s0.x, dy: s1.y - s0.y, panned: Math.abs(s1.x - s0.x) + Math.abs(s1.y - s0.y) > 5 };
    // 3. two-finger pan
    await reset(); s0 = await state(S);
    await touch(S, 'touchStart', [[ex - 30, ey, 1], [ex + 30, ey, 2]]); await sleep(50);
    for (let i = 1; i <= 25; i++) { await touch(S, 'touchMove', [[ex - 30 - 2 * i, ey - 2 * i, 1], [ex + 30 - 2 * i, ey - 2 * i, 2]]); await sleep(16); }
    await touch(S, 'touchEnd', []); await sleep(300); s1 = await state(S);
    out.twoFingerPan = { dx: +(s1.x - s0.x).toFixed(1), dy: +(s1.y - s0.y).toFixed(1), scaleChange: +(s1.s - s0.s).toFixed(4), panned: Math.abs(s1.x - s0.x) + Math.abs(s1.y - s0.y) > 5 };
    // 4. pinch zoom out/in
    await reset(); s0 = await state(S);
    await touch(S, 'touchStart', [[ex - 60, ey, 1], [ex + 60, ey, 2]]); await sleep(50);
    for (let i = 1; i <= 25; i++) { await touch(S, 'touchMove', [[ex - 60 + 2 * i, ey, 1], [ex + 60 - 2 * i, ey, 2]]); await sleep(16); }
    await touch(S, 'touchEnd', []); await sleep(300); s1 = await state(S);
    out.pinchIn = { scaleBefore: s0.s, scaleAfter: s1.s, zoomed: Math.abs(s1.s - s0.s) > 0.01 };
    await reset(); s0 = await state(S);
    await touch(S, 'touchStart', [[ex - 20, ey, 1], [ex + 20, ey, 2]]); await sleep(50);
    for (let i = 1; i <= 25; i++) { await touch(S, 'touchMove', [[ex - 20 - 2 * i, ey, 1], [ex + 20 + 2 * i, ey, 2]]); await sleep(16); }
    await touch(S, 'touchEnd', []); await sleep(300); s1 = await state(S);
    out.pinchOut = { scaleBefore: s0.s, scaleAfter: s1.s, zoomed: Math.abs(s1.s - s0.s) > 0.01 };
    // 5. tap on a node selects it? (hit-testing sanity)
    await reset(); s0 = await state(S);
    await touch(S, 'touchStart', [[160, 172, 1]]); await sleep(60); await touch(S, 'touchEnd', []); await sleep(300); s1 = await state(S);
    out.tapNodeTitleSelects = s1.sel > 0;
  } finally { await S.cleanup(); }
  return out;
}

// ---------------------------------------------------------------- configuration matrix
const packsWithJs = async () => {
  const exts = await (await fetch(`${BASE}/extensions`)).json();
  const c = {}; for (const u of exts) { const m = u.match(/^\/extensions\/([^/]+)\//); if (m && m[1] !== 'core') c[m[1]] = (c[m[1]] || 0) + 1; }
  return c;
};
const CONFIGS = {
  baseline: { name: 'baseline' },
  dpr15: { name: 'dpr1.5', dpr: 1.5 },
  dpr1: { name: 'dpr1', dpr: 1 },
  lowq: { name: 'lowquality-forced', lowq: true },
  lod: { name: 'lod-font-20', lodFont: 20 },
  noext: { name: 'no-ext', block: { all: true } },
  previews_on: { name: 'previews-on(synthetic)', previews: 'on' },
  canvas: { name: 'canvas', canvas: true, dpr: 2.625 },
};

async function main() {
  if (has('list')) { console.log(JSON.stringify(await packsWithJs(), null, 1)); return; }
  // Perf numbers only mean something on a heavy real workflow: pass --wf. Without it a tiny synthetic fixture is used (smoke run only).
  const wfs = workflowsFor(opt('wf'), ['group_bypass']);
  const outFile = opt('json');
  const results = [];
  const push = (r) => { results.push(r); console.log(JSON.stringify(r)); if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1)); };
  if (has('touch')) { const t = await touchProbe(); console.log(JSON.stringify(t, null, 1)); if (outFile) fs.writeFileSync(outFile, JSON.stringify(t, null, 1)); return; }
  if (has('bisect')) {
    // each pack alone (everything else blocked) vs the no-ext floor, on the first workflow
    const packs = Object.keys(await packsWithJs()); const only = opt('packs') ? opt('packs').split(',') : packs;
    for (const p of only) { try { push({ ...(await runConfig({ name: 'only:' + p, block: { all: true, keep: [p] } }, wfs[0])), pack: p }); } catch (e) { push({ name: 'only:' + p, pack: p, error: String(e.message || e) }); } }
    return;
  }
  const names = (opt('only') ? opt('only').split(',') : Object.keys(CONFIGS));
  for (const wf of wfs) for (const n of names) {
    const parts = n.split('+'); if (parts.some((x) => !CONFIGS[x])) { console.log('unknown config ' + n); continue; }
    const cfg = parts.length === 1 ? CONFIGS[n] : { ...Object.assign({}, ...parts.map((x) => CONFIGS[x])), name: parts.map((x) => CONFIGS[x].name).join('+') };
    try { push(await runConfig(cfg, wf)); } catch (e) { push({ name: cfg.name, wf, error: String(e.message || e) }); }
  }
}
await main().catch((e) => { console.error('ERROR', e); process.exitCode = 1; });
