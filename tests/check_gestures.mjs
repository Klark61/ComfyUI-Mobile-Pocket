// Browser check of the gesture compositor (web/canvas/gestures.js) on the live ComfyUI, A54 emulation, 4x CPU throttle.
//   node tests/check_gestures.mjs [--wf <file in WF_DIR>] [--ms 5000] [--no-gpu] [--widgets hide|move] [--json out.json]
// Own headless Chrome on port 9229 (temp profile, always cleaned up). ComfyUI is not restarted; nothing is saved or POSTed
// (the workflow is only loaded into the page via app.loadGraphData). Helpers are copied from tests/perf_canvas.mjs (it runs
// its own main() on import, so it cannot be imported).
// Reports: rAF fps for a scripted 2-finger pan and pinch without / with the compositor, one-finger pan on empty canvas,
// view accuracy after gestures (graph point under the focal point), scale clamping, a one-finger link drag (links +1),
// a node drag and taps, and the touch model (no menu from a held finger; one-finger empty-canvas Nothing/Pan/Box; two-finger pinch; wire drag
// after a rest). Exit code 1 when a check fails.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WF_DIR, chromePath, workflowsFor } from './env.mjs';

const PORT = 9229;
const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CHROME = chromePath();
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const W = 412, H = 915;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);
const WF = workflowsFor(opt('wf'), ['canvas_playground'])[0];
const GESTURE_MS = +opt('ms', 5000);
const WIDGETS = opt('widgets', 'hide');
const GPU = !has('no-gpu');

// ---- watchdog + progress (a hang must be visible and must never leave Chrome behind)
const T0 = Date.now();
let STEP = 'start';
let CLEANUP = null;
const step = (name) => { STEP = name; console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${name}`); };
const OVERALL_MS = +opt('timeout', 180) * 1000;
let watchdog = null;
const startWatchdog = () => {      // started after the wait for the other builder's Chrome, so waiting does not eat the budget
  clearTimeout(watchdog);
  watchdog = setTimeout(async () => {
    console.error(`TIMEOUT at step ${STEP}`);
    try { await Promise.race([CLEANUP?.(), sleep(4000)]); } catch {}
    process.exit(2);
  }, OVERALL_MS);
};
// per-step wait cap (45 s)
const withCap = (p, what, ms = 45000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`step cap ${ms / 1000}s exceeded: ${what}`)), ms))]);
// the other builder's Chrome (port 9228) shares CPU and ComfyUI: wait until it is gone
async function waitFor9228() {
  const t = Date.now();
  while (Date.now() - t < 120000) {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*remote-debugging-port=9228*' }).Count"], { encoding: 'utf8' });
    if (parseInt((r.stdout || '0').trim(), 10) === 0) return;
    step('waiting for chrome on 9228 to exit');
    await sleep(5000);
  }
  console.error('chrome on 9228 still running after 120 s, continuing anyway');
}

// ---------------------------------------------------------------- Chrome / CDP (from perf_canvas.mjs)
async function launch({ dpr = 2.625, throttle = 4 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gestures-'));
  const flags = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
  if (!GPU) flags.push('--disable-gpu');
  flags.push('about:blank');
  const chrome = spawn(CHROME, flags, { stdio: 'ignore' });
  CLEANUP = async () => { try { if (chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
  const kill = () => { try { if (chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };
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
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600));
      return r.result.value;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l',
      userAgentMetadata: { brands: [{ brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }], fullVersion: '130.0.0.0', platform: 'Android', platformVersion: '14', architecture: '', model: 'SM-A546B', mobile: true } });
    if (throttle > 1) await send('Emulation.setCPUThrottlingRate', { rate: throttle });
    CLEANUP = cleanup;
    return { send, on, ev, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

const INSTRUMENT = `(()=>{
  const P=window.__perf={readyAt:null,frames:null,long:[]};
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

async function touch(S, type, pts) { await S.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i + 1, radiusX: 4, radiusY: 4, force: 1 })) }); }
const state = (S) => S.ev(`(()=>{const c=app.canvas,d=c.ds,r=c.canvas.getBoundingClientRect(),g=app.graph;return JSON.stringify({s:d.scale,x:d.offset[0],y:d.offset[1],left:r.left,top:r.top,
  links:Object.keys(g.links||{}).length||g.links?.size||0,sel:Object.keys(c.selected_nodes||{}).length,transform:c.canvas.style.transform,paused:!!c.pause_rendering,min:d.min_scale,max:d.max_scale})})()`).then(JSON.parse);
// 60 Hz timed gesture: fn(progress 0..1) -> touch point list; a last move at p=1 is sent before the release so the end position is exact.
async function gesture(S, ms, fn, { hold = 0 } = {}) {
  await touch(S, 'touchStart', fn(0));
  const t0 = Date.now();
  while (true) {
    const p = (Date.now() - t0) / ms; if (p >= 1) break;
    await touch(S, 'touchMove', fn(p));
    await sleep(Math.max(0, 16 - ((Date.now() - t0) % 16)));
  }
  await touch(S, 'touchMove', fn(1));
  if (hold) await sleep(hold);
  await touch(S, 'touchEnd', []);
}
const EMPTY_POINT = `(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),g=app.graph;
  const cands=[];for(let y=90;y<${H}-60;y+=45)for(let x=30;x<${W}-30;x+=45)cands.push([x,y]);
  const sc=c.ds.scale;let best=null;
  for(const [x,y] of cands){let ok=true;for(let dx=-150;dx<=150&&ok;dx+=50)for(let dy=-150;dy<=150;dy+=50){const q=[(x+dx-r.left)/sc-c.ds.offset[0],(y+dy-r.top)/sc-c.ds.offset[1]];if(g.getNodeOnPos(q[0],q[1])){ok=false;break}}
    if(ok){for(const [dx,dy] of [[0,0],[-100,0],[100,0],[0,-80],[0,80]])if(document.elementFromPoint(x+dx,y+dy)!==c.canvas){ok=false;break}}
    if(ok){best=[x,y];break}}
  return JSON.stringify(best||[${W / 2},${H / 2}])})()`;
// an empty-canvas point whose surroundings (+-60 css px, 8 directions) are also empty, on the canvas element (not under an overlay)
const EMPTY_POINT2 = (x0 = 40, x1 = W - 40) => `(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,m=window.__gm;
  const kind=(x,y)=>m.hitKind(c,(x-r.left)/d.scale-d.offset[0],(y-r.top)/d.scale-d.offset[1]);
  const offs=[[0,0],[60,0],[-60,0],[0,60],[0,-60],[42,42],[-42,42],[42,-42],[-42,-42]];
  for(let y=130;y<${H}-100;y+=30)for(let x=${x0};x<=${x1};x+=30){
    if(offs.every(([dx,dy])=>kind(x+dx,y+dy)==='empty'&&document.elementFromPoint(x+dx,y+dy)===c.canvas))return JSON.stringify([x,y])}
  return JSON.stringify(null)})()`;
const SET_VIEW = (sc) => `(()=>{const c=app.canvas,vw=${W}/${sc},vh=${H}/${sc},ns=app.graph._nodes;let best=null,bn=-1;
  for(const a of ns){const x=a.pos[0]-20,y=a.pos[1]-60;let n=0;for(const b of ns)if(b.pos[0]>=x&&b.pos[0]<x+vw&&b.pos[1]>=y&&b.pos[1]<y+vh)n++;if(n>bn){bn=n;best=[x,y]}}
  if(!best)best=[0,0];c.ds.scale=${sc};c.ds.offset=[-best[0],-best[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`;

// ---------------------------------------------------------------- the checks
const results = { wf: WF, fps: {}, checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); };

const gx = (st, p) => [(p[0] - st.left) / st.s - st.x, (p[1] - st.top) / st.s - st.y];           // screen -> graph
const sx = (st, g) => [(g[0] + st.x) * st.s + st.left, (g[1] + st.y) * st.s + st.top];           // graph -> screen
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

async function measureFps(S, label, cx, cy) {
  const tri = (p) => { const q = (p * 2) % 1; return p < 0.5 ? q : 1 - q; };
  await S.ev('__perf.startFrames()');
  await gesture(S, GESTURE_MS, (p) => { const dx = -50 + 100 * tri(p * 2), dy = -40 + 80 * tri(p * 2 + 0.3); return [[cx - 35 + dx, cy + dy, 1], [cx + 35 + dx, cy + dy, 2]]; });
  const pan = await S.ev('__perf.stopFrames()');
  await sleep(500);
  await S.ev('__perf.startFrames()');
  await gesture(S, GESTURE_MS, (p) => { const d = 30 + 40 * (1 - Math.cos(p * 2 * Math.PI)) / 2; return [[cx - d, cy, 1], [cx + d, cy, 2]]; });
  const pinch = await S.ev('__perf.stopFrames()');
  results.fps[label] = { pan, pinch };
  console.log(`fps ${label}: pan ${pan.fps} (p95 ${pan.p95} ms, jank ${pan.jank}, long ${pan.longMs} ms)  pinch ${pinch.fps} (p95 ${pinch.p95} ms, jank ${pinch.jank}, long ${pinch.longMs} ms)`);
}

async function main() {
  await waitFor9228();
  startWatchdog();
  step('launching chrome');
  const S = await launch();
  step('chrome up');
  try {
    const errs = [];
    S.on((m) => { if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200)); });
    await S.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    step('navigating');
    await S.send('Page.navigate', { url: `${BASE}/?desktop=1` });
    const deadline = Date.now() + 45000; let ready = false;
    while (Date.now() < deadline) { await sleep(150); try { if (await S.ev('__perf.readyAt', false)) { ready = true; break; } } catch {} }
    if (!ready) throw new Error('app never became ready within 45 s');
    step('app ready');
    await sleep(1500);
    await S.ev(`window.__wf=${fs.readFileSync(path.join(WF_DIR, WF), 'utf8')}; 0`, false);
    const lr = JSON.parse(await withCap(S.ev(`(async()=>{await app.loadGraphData(window.__wf,true,true,${JSON.stringify(WF)});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return JSON.stringify({nodes:app.graph._nodes.length})})()`), 'loadGraphData'));
    step('graph loaded');
    console.log('loaded', WF, lr);
    await S.ev(SET_VIEW(0.7)); await sleep(1200);
    // load the module (not installed yet) so its hit test can find a truly empty point; same Blob-URL import used for install below
    const src = fs.readFileSync(process.env.GESTURES_SRC || new URL('../web/canvas/gestures.js', import.meta.url), 'utf8');   // GESTURES_SRC: A/B against another version
    await S.ev(`(async()=>{window.__gm=await import(URL.createObjectURL(new Blob([${JSON.stringify(src)}],{type:'text/javascript'})));return 1})()`);
    // close any dialog the workflow opened (missing-model/node dialogs cover the canvas); page-only hygiene
    console.log('dialogs', await S.ev(`(async()=>{for(let i=0;i<3;i++){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));await new Promise(r=>setTimeout(r,200))}
      const ds=[...document.querySelectorAll('[role=dialog],.p-dialog-mask')];const info=ds.map(e=>e.className.slice(0,60));ds.forEach(e=>e.remove());return JSON.stringify(info)})()`));
    let cx = 0, cy = 0;
    const refreshEmpty = async (x0, x1) => { const r = JSON.parse(await S.ev(EMPTY_POINT2(x0, x1))); if (!r) throw new Error('no empty canvas point found'); [cx, cy] = r; return r; };
    await refreshEmpty();
    console.log('empty point', cx, cy);

    // ---- 1. fps without the compositor
    step('fps without compositor');
    await measureFps(S, 'without', cx, cy);
    await S.ev(SET_VIEW(0.7)); await sleep(1000); await refreshEmpty();

    // ---- 2. inject + install the compositor (imported exactly like boot.js will)
    // NOTE: the live server's /pocket/static root is web/pocket (web/canvas is not routed until the boot stream adds it), so the
    // module source is loaded through a Blob URL: the same code, the same ES-module import.
    const inst = await S.ev(`(async()=>{const m=window.__gm;window.__g=m.install(app,{widgets:${JSON.stringify(WIDGETS)}});
      window.__clicks=0;app.canvas.canvas.addEventListener('click',()=>window.__clicks++);
      return JSON.stringify({domWidgets:document.querySelectorAll('.dom-widget').length,widgetParent:(document.querySelector('.dom-widget')||{}).parentElement?.id||null})})()`);
    console.log('installed', inst);
    await S.ev(`(window.__g.setPrefs&&window.__g.setPrefs({emptyDrag:'pan'}),1)`);   // the pan/pinch measurements below use one-finger pan; the touch-model section goes back to the default
    step('fps with compositor');
    await measureFps(S, 'with', cx, cy);
    const w = results.fps.without, c = results.fps.with;
    check('compositor pan fps >= 50', c.pan.fps >= 50, { with: c.pan.fps, without: w.pan.fps });
    check('compositor pinch fps >= 50', c.pinch.fps >= 50, { with: c.pinch.fps, without: w.pinch.fps });
    let st = await state(S);
    check('after fps runs: no transform left, rendering resumed', st.transform === '' && !st.paused, { transform: st.transform, paused: st.paused });

    step('view accuracy');
    // ---- 3. view accuracy: two-finger pinch + pan, expect the graph point under the start centroid under the end centroid
    await S.ev(SET_VIEW(0.7)); await sleep(800); await refreshEmpty();
    const s0 = await state(S);
    const A0 = [cx - 40, cy], B0 = [cx + 40, cy], A1 = [cx - 60 + 30, cy - 50 + 20], B1 = [cx + 100 + 30, cy + 10 + 20];
    await gesture(S, 1200, (p) => { const e = p * p * (3 - 2 * p), l = (a, b) => [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]; return [[...l(A0, A1), 1], [...l(B0, B1), 2]]; });
    await sleep(500);
    let s1 = await state(S);
    const c0 = [(A0[0] + B0[0]) / 2, (A0[1] + B0[1]) / 2], c1 = [(A1[0] + B1[0]) / 2, (A1[1] + B1[1]) / 2];
    const wantScale = s0.s * dist(A1, B1) / dist(A0, B0);
    const gp = gx(s0, c0), got = sx(s1, gp);
    check('pinch+pan view exact (focal graph point within 1 px of centroid)', dist(got, c1) <= 1, { errPx: +dist(got, c1).toFixed(3), scale: s1.s, wantScale });
    check('pinch scale = finger distance ratio', Math.abs(s1.s / wantScale - 1) < 1e-3, { got: s1.s, want: wantScale });
    check('transform removed, rendering resumed', s1.transform === '' && !s1.paused, { transform: s1.transform, paused: s1.paused });

    step('one-finger pan');
    // ---- 4. one-finger drag on empty canvas pans by exactly the finger delta
    await S.ev(SET_VIEW(0.7)); await sleep(800); await refreshEmpty();
    const s2 = await state(S);
    const dbg = await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,gp=[(${cx}-r.left)/d.scale-d.offset[0],(${cy}-r.top)/d.scale-d.offset[1]];return JSON.stringify({kind:__gm.hitKind(c,gp[0],gp[1]),ptrs:__g.pointers,gesturing:__g.gesturing,top:document.elementFromPoint(${cx},${cy}).tagName})})()`);
    console.log('one-finger start', dbg);
    console.log('debug', await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,gp=[(${cx}-r.left)/d.scale-d.offset[0],(${cy}-r.top)/d.scale-d.offset[1]],n=app.graph.getNodeOnPos(gp[0],gp[1]);
      return JSON.stringify({ds:[d.scale,d.offset],rect:[r.left,r.top,r.width,r.height],node:n&&[n.id,n.type,n.pos,n.size,n.flags],empty2:${EMPTY_POINT.replace(/`/g, '')},stack:document.elementsFromPoint(${cx},${cy}).slice(0,4).map(e=>e.tagName+'.'+e.className)})})()`));
    await gesture(S, 800, (p) => [[cx + 70 * p, cy + 45 * p, 1]]);
    await sleep(400);
    const s3 = await state(S);
    const moved = [(s3.x - s2.x) * s2.s, (s3.y - s2.y) * s2.s];
    check('one-finger drag on empty canvas pans by the finger delta (<= 1 px)', dist(moved, [70, 45]) <= 1 && s3.s === s2.s, { movedPx: moved.map((v) => +v.toFixed(2)), scaleSame: s3.s === s2.s });

    step('clamp');
    // ---- 5. clamp at max scale with the focal point fixed
    await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(e=>e.remove());1`); await S.ev(SET_VIEW(0.7)); await sleep(600); await refreshEmpty(230, 262);       // one-finger pan moved the view: pick an empty point again (right of centre: the min-scale pinch spreads the fingers +-150 px around it, clear of the left sidebar and inside the screen)
    await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,gp=[(${cx}-r.left)/d.scale-d.offset[0],(${cy}-r.top)/d.scale-d.offset[1]];d.scale=2;d.offset=[(${cx}-r.left)/2-gp[0],(${cy}-r.top)/2-gp[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`); await sleep(600);
    const s4 = await state(S);
    const F = [cx, cy];
    await gesture(S, 1500, (p) => { const d = 20 + 300 * p; return [[F[0] - d, F[1], 1], [F[0] + d, F[1], 2]]; });
    await sleep(500);
    const s5 = await state(S);
    check('scale clamped to max_scale', Math.abs(s5.s - s5.max) < 1e-9, { scale: s5.s, max: s5.max });
    const gF = gx(s4, F);
    check('clamped pinch keeps the focal point fixed (<= 1 px)', dist(sx(s5, gF), F) <= 1, { errPx: +dist(sx(s5, gF), F).toFixed(3) });
    await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,gp=[(${cx}-r.left)/d.scale-d.offset[0],(${cy}-r.top)/d.scale-d.offset[1]];d.scale=0.3;d.offset=[(${cx}-r.left)/0.3-gp[0],(${cy}-r.top)/0.3-gp[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`); await sleep(500);
    await gesture(S, 1200, (p) => { const d = 150 - 145 * p; return [[F[0] - d, F[1], 1], [F[0] + d, F[1], 2]]; });   // ratio 1/30 -> wants 0.01
    await sleep(500);
    const s6 = await state(S);
    check('scale clamped to min_scale', Math.abs(s6.s - s6.min) < 1e-9, { scale: s6.s, min: s6.min });

    step('node + link drag');
    // ---- 6. node drag and link drag through the compositor (pass-through)
    await S.ev(SET_VIEW(0.7)); await sleep(800);
    const nd = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds;
      for(const n of app.graph._nodes){const p=[(n.pos[0]+Math.min(60,n.size[0]/3)+d.offset[0])*d.scale+r.left,(n.pos[1]-10+d.offset[1])*d.scale+r.top];   // title bar
        if(p[0]>20&&p[0]<${W - 20}&&p[1]>110&&p[1]<${H - 120}&&document.elementFromPoint(p[0],p[1])===c.canvas)return JSON.stringify({id:n.id,p,pos:[n.pos[0],n.pos[1]]})}return 'null'})()`));
    if (!nd) check('node drag', false, 'no visible node title found');
    else {
      const before = await state(S);
      await gesture(S, 700, (p) => [[nd.p[0] + 60 * p, nd.p[1] + 40 * p, 1]]);
      await sleep(400);
      const after = await state(S);
      const np = JSON.parse(await S.ev(`JSON.stringify(app.graph.getNodeById(${nd.id}).pos)`));
      const dm = [(np[0] - nd.pos[0]) * before.s, (np[1] - nd.pos[1]) * before.s];
      check('one-finger drag on a node moves the node, not the view', dist(dm, [60, 40]) <= 14 && after.x === before.x && after.y === before.y, { nodeMovedPx: dm.map((v) => +v.toFixed(1)), viewSame: after.x === before.x && after.y === before.y });
      await S.ev(`app.graph.getNodeById(${nd.id}).pos=[${nd.pos[0]},${nd.pos[1]}];app.canvas.setDirty(true,true);1`, false);
    }

    const connecting = () => S.ev('!!app.canvas.linkConnector?.isConnecting');
    // link drag: find an output and a compatible free input that fit on the screen together
    const cand = JSON.parse(await S.ev(`(()=>{const g=app.graph,out=[];const ns=g._nodes;
      for(const a of ns)for(let i=0;i<(a.outputs||[]).length;i++){const o=a.outputs[i];if(!o||o.type==='*')continue;
        for(const b of ns){if(b===a)continue;for(let j=0;j<(b.inputs||[]).length;j++){const inp=b.inputs[j];if(!inp||inp.link!=null||inp.type!==o.type)continue;
          const pa=a.getOutputPos(i),pb=b.getInputPos(j);const d=Math.hypot(pa[0]-pb[0],pa[1]-pb[1]);out.push({a:a.id,i,b:b.id,j,pa,pb,d,type:o.type})}}}
      out.sort((x,y)=>x.d-y.d);return JSON.stringify(out.slice(0,8))})()`));
    console.log('link candidates', cand.length);
    let linked = false, tries = [];
    for (const k of cand) {
      // centre both slots on screen at scale 0.7 (or smaller if needed)
      const sc = Math.min(0.7, (W - 100) / Math.max(1, Math.abs(k.pa[0] - k.pb[0])), (H - 400) / Math.max(1, Math.abs(k.pa[1] - k.pb[1])));
      if (sc < 0.3) continue;
      await S.ev(`(()=>{const c=app.canvas,sc=${sc},m=[${(k.pa[0] + k.pb[0]) / 2},${(k.pa[1] + k.pb[1]) / 2}];c.ds.scale=sc;c.ds.offset=[${W / 2}/sc-m[0],${H / 2}/sc-m[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`);
      await sleep(500);
      const st0 = await state(S);
      const pa = sx(st0, k.pa), pb = sx(st0, k.pb);
      const ok = JSON.parse(await S.ev(`JSON.stringify([document.elementFromPoint(${pa[0]},${pa[1]})===app.canvas.canvas,document.elementFromPoint(${pb[0]},${pb[1]})===app.canvas.canvas])`));
      if (!ok[0] || !ok[1]) { tries.push({ k: k.a + '.' + k.i + '->' + k.b + '.' + k.j, covered: true }); continue; }
      await gesture(S, 900, (p) => [[pa[0] + (pb[0] - pa[0]) * p, pa[1] + (pb[1] - pa[1]) * p, 1]]);
      await sleep(500);
      const st1 = await state(S);
      tries.push({ k: `${k.a}.${k.i}->${k.b}.${k.j} (${k.type})`, pair: k, linksBefore: st0.links, linksAfter: st1.links, viewSame: st0.x === st1.x && st0.y === st1.y && st0.s === st1.s, connecting: await connecting() });
      if (st1.links === st0.links + 1) { linked = true; break; }
    }
    check('one-finger link drag from an output slot to a compatible input connects (links +1, view unchanged)', linked && tries[tries.length - 1].viewSame, tries);

    step('linked-slot + second finger');
    // ---- 6b. finger on an already-linked input slot (LiteGraph starts a link drag), second finger lands within 8 px, release both:
    // the compositor must not take over; no link may be lost and the linkConnector must not stay "connecting".
    const li = JSON.parse(await S.ev(`(()=>{const g=app.graph;for(const b of g._nodes)for(let j=0;j<(b.inputs||[]).length;j++){if(b.inputs[j]?.link==null)continue;
      const p=b.getInputPos(j);return JSON.stringify({b:b.id,j,p})}return 'null'})()`));
    if (!li) check('linked input slot + second finger', false, 'no linked input found');
    else {
      const sc = 0.7;
      await S.ev(`(()=>{const c=app.canvas,sc=${sc};c.ds.scale=sc;c.ds.offset=[${W / 2}/sc-(${li.p[0]}),${H / 2}/sc-(${li.p[1]})];c.setDirty(true,true);c.draw(true,true);return 1})()`);
      await sleep(500);
      const s0l = await state(S);
      const pa = sx(s0l, li.p);
      const topOk = await S.ev(`document.elementFromPoint(${pa[0]},${pa[1]})===app.canvas.canvas`);
      await touch(S, 'touchStart', [[pa[0], pa[1], 1]]); await sleep(80);
      await touch(S, 'touchMove', [[pa[0] + 2, pa[1] + 1, 1]]); await sleep(40);
      await touch(S, 'touchStart', [[pa[0] + 2, pa[1] + 1, 1], [pa[0] + 6, pa[1] + 3, 2]]); await sleep(120);
      await touch(S, 'touchMove', [[pa[0] + 3, pa[1] + 2, 1], [pa[0] + 12, pa[1] + 6, 2]]); await sleep(120);
      await touch(S, 'touchEnd', []); await sleep(500);
      const s1l = await state(S);
      const conn = await connecting();
      check('linked input slot + second finger: links unchanged, linkConnector not connecting, no transform', topOk && s1l.links === s0l.links && !conn && s1l.transform === '' && !s1l.paused,
        { topOk, before: s0l.links, after: s1l.links, connecting: conn, transform: s1l.transform, paused: s1l.paused });
    }

    // ---- 6c. the pair used by the loop above (the first one that connected): the connector must be idle again afterwards.
    // (On a real workflow with a dynamic-input switch node such a drag used to end with the connector stuck "connecting"; a link-count change
    // there is node behaviour, step 8 below repeats the identical drag on the plain desktop page as the reference.)
    const t314 = tries.find((t) => t.linksAfter === t.linksBefore + 1) || tries[tries.length - 1];
    check('link drag ' + (t314 ? t314.k : 'n/a') + ': connector idle afterwards (links ' + (t314 ? `${t314.linksBefore}->${t314.linksAfter}` : 'n/a') + ')', !!t314 && t314.connecting === false, t314);

    step('visibilitychange mid-gesture');
    await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(e=>e.remove());1`);
    // ---- 6d. a pinch whose up/cancel is lost (app switch): visibilitychange hidden must end it cleanly
    await S.ev(SET_VIEW(0.7)); await sleep(600); await refreshEmpty();
    await touch(S, 'touchStart', [[cx - 40, cy, 1], [cx + 40, cy, 2]]);
    for (let i = 1; i <= 8; i++) { await touch(S, 'touchMove', [[cx - 40 - 6 * i, cy, 1], [cx + 40 + 6 * i, cy, 2]]); await sleep(16); }
    const mid = await state(S);
    const midG = await S.ev('__g.gesturing');
    await S.ev(`(()=>{Object.defineProperty(document,'visibilityState',{get:()=>'hidden',configurable:true});document.dispatchEvent(new Event('visibilitychange'));delete document.visibilityState;return 1})()`);
    await sleep(300);
    const aft = await state(S);
    const wv = JSON.parse(await S.ev(`JSON.stringify([...document.querySelectorAll('.dom-widget')].map(w=>[w.style.visibility,w.hasAttribute('data-mg-vis')]))`));
    check('visibilitychange hidden ends a running pinch: rendering resumed, no transform, widgets visible', midG && mid.paused && !aft.paused && aft.transform === '' && !(await S.ev('__g.gesturing')) && (await S.ev('__g.pointers.length')) === 0 && wv.every(([v, a]) => v !== 'hidden' && !a),
      { midGesturing: midG, midPaused: mid.paused, afterPaused: aft.paused, transform: aft.transform, widgets: wv.length });
    await touch(S, 'touchEnd', []); await sleep(300);

    step('taps');
    // ---- 7. taps pass through
    await S.ev(SET_VIEW(0.7)); await sleep(600); await refreshEmpty();
    const c0n = await S.ev('window.__clicks');
    await touch(S, 'touchStart', [[cx, cy, 1]]); await sleep(60); await touch(S, 'touchEnd', []);
    await sleep(300);
    check('tap on empty canvas passes through as a click', (await S.ev('window.__clicks')) === c0n + 1, { clicks: await S.ev('window.__clicks') });
    if (nd) {
      const pt = JSON.parse(await S.ev(`(()=>{const n=app.graph.getNodeById(${nd.id}),c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds;c.deselectAll();return JSON.stringify([(n.pos[0]+Math.min(60,n.size[0]/3)+d.offset[0])*d.scale+r.left,(n.pos[1]-10+d.offset[1])*d.scale+r.top])})()`));
      await touch(S, 'touchStart', [[pt[0], pt[1], 1]]); await sleep(60); await touch(S, 'touchEnd', []);
      await sleep(300);
      check('tap on a node title selects it', (await state(S)).sel === 1, { sel: (await state(S)).sel });
    }
    // ================================================================ touch model (real-device bug: a held finger opened the context menu)
    // Android Chrome fires `contextmenu` ~500 ms into a hold, and the frontend's SimpleTouchSupport dispatches a right-button pointerdown when a
    // single touch lasted > 600 ms and ended on the canvas: BOTH used to open LiteGraph's menu over every slow drag.
    step('touch model');
    const menus = () => S.ev(`document.querySelectorAll('.litecontextmenu').length`);
    const clearMenus = () => S.ev(`document.querySelectorAll('.litecontextmenu').forEach(e=>e.remove());1`);
    const setPref = (p) => S.ev(`(window.__g.setPrefs&&window.__g.setPrefs(${JSON.stringify(p)}),window.__g.prefs?JSON.stringify(window.__g.prefs):'old')`);
    const fakeCtx = (x, y) => S.ev(`(()=>{const c=app.canvas.canvas;c.dispatchEvent(new MouseEvent('contextmenu',{clientX:${x},clientY:${y},bubbles:true,cancelable:true,button:2}));return 1})()`);
    // finger down, rest `rest` ms (a synthetic contextmenu at 500 ms, like Android), then move by `d` in `steps` steps, then up
    async function holdDrag(a, d, { rest = 700, ctx = true, steps = 10 } = {}) {
      await touch(S, 'touchStart', [[a[0], a[1], 1]]);
      await sleep(Math.min(500, rest)); if (ctx) await fakeCtx(a[0], a[1]); await sleep(Math.max(0, rest - 500));
      for (let i = 1; i <= steps; i++) { await touch(S, 'touchMove', [[a[0] + d[0] * i / steps, a[1] + d[1] * i / steps, 1]]); await sleep(25); }
      await sleep(80);
      await touch(S, 'touchEnd', []); await sleep(450);
    }
    const viewKey = async () => { const s = await state(S); return `${s.s}|${s.x}|${s.y}`; };

    await setPref({ emptyDrag: 'none' });
    await S.ev(SET_VIEW(0.7)); await sleep(900); await clearMenus();

    // ---- (a) one finger on a node title: rest 700 ms, then 80 px
    const tp = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds;
      for(const n of app.graph._nodes){const p=[(n.pos[0]+Math.min(60,n.size[0]/3)+d.offset[0])*d.scale+r.left,(n.pos[1]-10+d.offset[1])*d.scale+r.top];
        if(p[0]>20&&p[0]<${W - 120}&&p[1]>110&&p[1]<${H - 200}&&document.elementFromPoint(p[0],p[1])===c.canvas&&__gm.hitKind(c,(p[0]-r.left)/d.scale-d.offset[0],(p[1]-r.top)/d.scale-d.offset[1])==='node')return JSON.stringify({id:n.id,p,pos:[n.pos[0],n.pos[1]],s:d.scale})}return 'null'})()`));
    if (!tp) check('(a) node title hold+drag', false, 'no visible node title');
    else {
      const v0 = await viewKey();
      await holdDrag(tp.p, [80, 0]);
      const np = JSON.parse(await S.ev(`JSON.stringify(app.graph.getNodeById(${tp.id}).pos)`));
      const dm = (np[0] - tp.pos[0]) * tp.s;
      check('(a) one finger on a node title, rest 700 ms (+ contextmenu at 500 ms), move 80 px: node moved, no menu, view unchanged',
        Math.abs(dm - 80) <= 14 && (await menus()) === 0 && (await viewKey()) === v0, { movedPx: +dm.toFixed(1), menus: await menus(), blocked: await S.ev('window.__g.blockedMenus||0') });
      await clearMenus();
      await S.ev(`app.graph.getNodeById(${tp.id}).pos=[${tp.pos[0]},${tp.pos[1]}];app.canvas.setDirty(true,true);1`);
    }

    // ---- (b) one finger on a group title: the group and its nodes move
    const grp = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),g=app.graph;
      for(const gr of g._groups){c.ds.scale=0.7;c.ds.offset=[100/0.7-(gr.pos[0]+60),300/0.7-(gr.pos[1]+12)];c.setDirty(true,true);c.draw(true,true);
        const d=c.ds,gx=gr.pos[0]+60,gy=gr.pos[1]+12,p=[(gx+d.offset[0])*d.scale+r.left,(gy+d.offset[1])*d.scale+r.top];
        gr.recomputeInsideNodes();const kids=[...gr._children].filter(k=>k.pos&&typeof k.getInputPos==='function');
        if(kids.length&&document.elementFromPoint(p[0],p[1])===c.canvas&&__gm.hitKind(c,gx,gy)==='other')return JSON.stringify({id:gr.id,p,pos:[gr.pos[0],gr.pos[1]],kid:kids[0].id,kpos:[kids[0].pos[0],kids[0].pos[1]],n:kids.length,s:d.scale})}return 'null'})()`));
    await sleep(900);
    if (!grp) check('(b) group title hold+drag', false, 'no group title found');
    else {
      await holdDrag(grp.p, [80, 40]);
      const after = JSON.parse(await S.ev(`(()=>{const g=app.graph._groups.find(x=>x.id===${grp.id}),k=app.graph.getNodeById(${grp.kid});return JSON.stringify({g:[g.pos[0],g.pos[1]],k:[k.pos[0],k.pos[1]]})})()`));
      const dg = [(after.g[0] - grp.pos[0]) * grp.s, (after.g[1] - grp.pos[1]) * grp.s], dk = [(after.k[0] - grp.kpos[0]) * grp.s, (after.k[1] - grp.kpos[1]) * grp.s];
      check('(b) one finger on a group title, rest 700 ms, move: the group and its nodes moved, no menu',
        dist(dg, [80, 40]) <= 14 && dist(dk, [80, 40]) <= 14 && (await menus()) === 0, { group: dg.map((v) => +v.toFixed(1)), node: dk.map((v) => +v.toFixed(1)), kids: grp.n, menus: await menus() });
      await clearMenus();
    }

    // ---- (c) one finger on EMPTY canvas: Nothing (default) / Pan / Box select
    await S.ev(SET_VIEW(0.7)); await sleep(900); await refreshEmpty(); await clearMenus();
    await S.ev('app.canvas.deselectAll();1');
    {
      const v0 = await viewKey();
      await holdDrag([cx, cy], [70, 45]);
      const o = JSON.parse(await S.ev(`JSON.stringify({sel:app.canvas.selectedItems.size,box:!!document.querySelector('[data-mg-box]'),rect:!!app.canvas.dragging_rectangle,menus:document.querySelectorAll('.litecontextmenu').length})`));
      check('(c1) default prefs (Nothing): one-finger drag on empty canvas (rest 700 ms): view unchanged, no menu, no selection box, nothing selected',
        (await viewKey()) === v0 && !o.box && !o.rect && o.menus === 0 && o.sel === 0, { viewSame: (await viewKey()) === v0, ...o });
      // a tap still deselects
      await S.ev(`(()=>{const c=app.canvas;c.select(app.graph._nodes[0]);return 1})()`); await sleep(100);
      await touch(S, 'touchStart', [[cx, cy, 1]]); await sleep(60); await touch(S, 'touchEnd', []); await sleep(350);
      check('(c1) tap on empty canvas (Nothing) deselects', (await S.ev('app.canvas.selectedItems.size')) === 0);
      // ... but a drag does not deselect
      await S.ev(`(()=>{const c=app.canvas;c.select(app.graph._nodes[0]);return 1})()`); await sleep(100);
      await holdDrag([cx, cy], [40, 30], { rest: 100, ctx: false });
      check('(c1) a drag on empty canvas (Nothing) neither pans nor deselects', (await S.ev('app.canvas.selectedItems.size')) === 1 && (await viewKey()) === v0);
      await S.ev('app.canvas.deselectAll();1');

      // (d) a second finger joins a one-finger "Nothing" drag: pinch zoom still works
      const sA = await state(S);
      await touch(S, 'touchStart', [[cx, cy, 1]]); await sleep(60);
      for (let i = 1; i <= 4; i++) { await touch(S, 'touchMove', [[cx + 8 * i, cy, 1]]); await sleep(20); }
      await touch(S, 'touchStart', [[cx + 32, cy, 1], [cx + 32 + 60, cy, 2]]); await sleep(60);
      for (let i = 1; i <= 12; i++) { await touch(S, 'touchMove', [[cx + 32 - 6 * i, cy, 1], [cx + 92 + 6 * i, cy, 2]]); await sleep(20); }
      await touch(S, 'touchEnd', []); await sleep(400);
      const sB = await state(S);
      check('(d) two fingers always pinch-zoom (also when the first finger had started a Nothing drag), no menu', sB.s > sA.s * 1.8 && sB.transform === '' && !sB.paused && (await menus()) === 0, { from: sA.s, to: sB.s, menus: await menus() });
      await S.ev(SET_VIEW(0.7)); await sleep(900); await refreshEmpty();

      // Pan
      console.log('prefs', await setPref({ emptyDrag: 'pan' }));
      const p0 = await state(S);
      await holdDrag([cx, cy], [70, 45], { rest: 700 });
      const p1 = await state(S), mv = [(p1.x - p0.x) * p0.s, (p1.y - p0.y) * p0.s];
      check('(c2) pref Pan: one-finger drag on empty canvas pans by the finger delta, no menu', dist(mv, [70, 45]) <= 1.5 && (await menus()) === 0 && p1.s === p0.s, { movedPx: mv.map((v) => +v.toFixed(2)), menus: await menus() });
      await S.ev(SET_VIEW(0.7)); await sleep(900); await refreshEmpty(); await clearMenus();

      // Box select: a rectangle around one visible node, started on empty canvas
      await setPref({ emptyDrag: 'box' });
      const bx = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),d=c.ds,g=app.graph;
        const scr=(x,y)=>[(x+d.offset[0])*d.scale+r.left,(y+d.offset[1])*d.scale+r.top];
        const gx=(p)=>[(p[0]-r.left)/d.scale-d.offset[0],(p[1]-r.top)/d.scale-d.offset[1]];
        const empty=(p)=>p[0]>6&&p[0]<${W - 6}&&p[1]>100&&p[1]<${H - 130}&&document.elementFromPoint(p[0],p[1])===c.canvas&&__gm.hitKind(c,gx(p)[0],gx(p)[1])==='empty';
        for(const n of g._nodes){const b=n.boundingRect;const a=scr(b[0],b[1]),z=scr(b[0]+b[2],b[1]+b[3]);
          if(a[0]<12||a[1]<112||z[1]>${H - 142}||z[0]>${W - 12})continue;
          for(const [sa,sb,ea,eb] of [[a[0]-14,a[1]-14,z[0]+14,z[1]+14],[z[0]+14,a[1]-14,a[0]-14,z[1]+14],[a[0]-14,z[1]+14,z[0]+14,a[1]-14],[z[0]+14,z[1]+14,a[0]-14,a[1]-14]]){
            const s0=[sa,sb],e0=[Math.min(${W - 4},Math.max(4,ea)),Math.min(${H - 130},Math.max(100,eb))];if(!empty(s0))continue;
            const g0=gx([Math.min(s0[0],e0[0]),Math.min(s0[1],e0[1])]),g1=gx([Math.max(s0[0],e0[0]),Math.max(s0[1],e0[1])]);
            const want=g._nodes.filter(m=>{const q=m.boundingRect;return q[0]<g1[0]&&q[0]+q[2]>g0[0]&&q[1]<g1[1]&&q[1]+q[3]>g0[1]}).map(m=>m.id).sort((p,q)=>p-q);
            return JSON.stringify({s0,e0,want,id:n.id})}}return 'null'})()`));
      if (!bx) check('(c3) box select', false, 'no node with an empty start point found');
      else {
        const v0b = await viewKey();
        await touch(S, 'touchStart', [[bx.s0[0], bx.s0[1], 1]]); await sleep(700);
        let sawBox = false;
        for (let i = 1; i <= 10; i++) { await touch(S, 'touchMove', [[bx.s0[0] + (bx.e0[0] - bx.s0[0]) * i / 10, bx.s0[1] + (bx.e0[1] - bx.s0[1]) * i / 10, 1]]); await sleep(25); if (i === 6) sawBox = await S.ev(`!!document.querySelector('[data-mg-box]')`); }
        await touch(S, 'touchEnd', []); await sleep(450);
        const got = JSON.parse(await S.ev(`JSON.stringify([...app.canvas.selectedItems].filter(i=>typeof i.getInputPos==='function').map(i=>i.id).sort((p,q)=>p-q))`));
        check('(c3) pref Box select: a one-finger rectangle selects the nodes inside it (box shown while dragging, removed after), no menu, view unchanged',
          got.length >= 1 && JSON.stringify(got) === JSON.stringify(bx.want) && sawBox && !(await S.ev(`!!document.querySelector('[data-mg-box]')`)) && (await menus()) === 0 && (await viewKey()) === v0b,
          { want: bx.want, got, sawBox, menus: await menus() });
      }
      await S.ev('app.canvas.deselectAll();1'); await clearMenus();
      await setPref({ emptyDrag: 'none' });
    }

    // ---- (g) one-finger wire drag from an output to an input with a 600 ms rest at the start
    {
      const cand2 = JSON.parse(await S.ev(`(()=>{const g=app.graph,out=[];const ns=g._nodes;
        for(const a of ns)for(let i=0;i<(a.outputs||[]).length;i++){const o=a.outputs[i];if(!o||o.type==='*')continue;
          for(const b of ns){if(b===a)continue;for(let j=0;j<(b.inputs||[]).length;j++){const inp=b.inputs[j];if(!inp||inp.link!=null||inp.type!==o.type)continue;
            const pa=a.getOutputPos(i),pb=b.getInputPos(j);out.push({a:a.id,i,b:b.id,j,pa,pb,d:Math.hypot(pa[0]-pb[0],pa[1]-pb[1])})}}}
        out.sort((x,y)=>x.d-y.d);return JSON.stringify(out.slice(0,60))})()`));
      let wired = null; const wtries = [];
      for (const k of cand2) {
        const sc = Math.min(0.7, (W - 100) / Math.max(1, Math.abs(k.pa[0] - k.pb[0])), (H - 400) / Math.max(1, Math.abs(k.pa[1] - k.pb[1])));
        if (sc < 0.3) continue;
        await S.ev(`(()=>{const c=app.canvas,sc=${sc},m=[${(k.pa[0] + k.pb[0]) / 2},${(k.pa[1] + k.pb[1]) / 2}];c.ds.scale=sc;c.ds.offset=[${W / 2}/sc-m[0],${H / 2}/sc-m[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`);
        await sleep(600);
        const st0 = await state(S), pa = sx(st0, k.pa), pb = sx(st0, k.pb);
        const ok = JSON.parse(await S.ev(`JSON.stringify([document.elementFromPoint(${pa[0]},${pa[1]})===app.canvas.canvas,document.elementFromPoint(${pb[0]},${pb[1]})===app.canvas.canvas])`));
        if (!ok[0] || !ok[1]) { wtries.push({ k: `${k.a}.${k.i}->${k.b}.${k.j}`, covered: true }); continue; }
        await clearMenus();
        await touch(S, 'touchStart', [[pa[0], pa[1], 1]]); await sleep(600);
        await fakeCtx(pa[0], pa[1]);
        for (let i = 1; i <= 14; i++) { await touch(S, 'touchMove', [[pa[0] + (pb[0] - pa[0]) * i / 14, pa[1] + (pb[1] - pa[1]) * i / 14, 1]]); await sleep(30); }
        await sleep(80); await touch(S, 'touchEnd', []); await sleep(550);
        const st1 = await state(S);
        wtries.push({ k: `${k.a}.${k.i}->${k.b}.${k.j}`, before: st0.links, after: st1.links, menus: await menus(), viewSame: st0.x === st1.x && st0.y === st1.y && st0.s === st1.s });
        if (st1.links === st0.links + 1) { wired = wtries[wtries.length - 1]; break; }
      }
      check('(g) one-finger wire drag output -> input after a 600 ms rest at the start: connects (links +1), no menu, view unchanged', !!wired && wired.menus === 0 && wired.viewSame, wtries);
    }

    check('no page exceptions', errs.length === 0, errs.slice(0, 3));

    // ---- 8. same link drag (the pair from 6c) on the plain desktop page (fresh navigation: no compositor installed), same emulation.
    // Verdict (2026-10-23): see the comment at 6c. If the desktop page ends with the same links N -> N-1 the change is the node's own behaviour.
    step('desktop control: link drag without compositor');
    S.on((m) => { if (m.method === 'Page.javascriptDialogOpening') S.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });   // beforeunload ("unsaved changes") would block the navigation
    await withCap(S.send('Page.navigate', { url: `${BASE}/?desktop=1` }), 'navigate (desktop control)');
    step('desktop control: navigated');
    for (let i = 0, ok = false; i < 300 && !ok; i++) { await sleep(150); try { ok = !!(await withCap(S.ev('__perf.readyAt', false), 'readyAt poll', 3000)); } catch {} }
    step('desktop control: app ready');
    await sleep(1500);
    await S.ev(`window.__wf=${fs.readFileSync(path.join(WF_DIR, WF), 'utf8')}; 0`, false);
    await withCap(S.ev(`(async()=>{await app.loadGraphData(window.__wf,true,true,${JSON.stringify(WF)});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()`), 'loadGraphData (desktop control)');
    step('desktop control: graph loaded');
    await sleep(1000);
    await S.ev(`(()=>{for(let i=0;i<3;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));document.querySelectorAll('[role=dialog],.p-dialog-mask').forEach(e=>e.remove());return 1})()`);
    const pr = t314 && t314.pair;
    const dk = pr && JSON.parse(await S.ev(`(()=>{const a=app.graph.getNodeById(${pr.a}),b=app.graph.getNodeById(${pr.b});if(!a||!b)return 'null';return JSON.stringify({pa:a.getOutputPos(${pr.i}),pb:b.getInputPos(${pr.j})})})()`));
    if (!dk) check('desktop control: link drag', false, 'no pair from 6c / nodes not found');
    else {
      const sc = Math.min(0.7, (W - 100) / Math.max(1, Math.abs(dk.pa[0] - dk.pb[0])), (H - 400) / Math.max(1, Math.abs(dk.pa[1] - dk.pb[1])));
      await S.ev(`(()=>{const c=app.canvas,sc=${sc},m=[${(dk.pa[0] + dk.pb[0]) / 2},${(dk.pa[1] + dk.pb[1]) / 2}];c.ds.scale=sc;c.ds.offset=[${W / 2}/sc-m[0],${H / 2}/sc-m[1]];c.setDirty(true,true);c.draw(true,true);return 1})()`);
      await sleep(500);
      const d0 = await state(S), pa = sx(d0, dk.pa), pb = sx(d0, dk.pb);
      const top = await S.ev(`document.elementFromPoint(${pa[0]},${pa[1]})===app.canvas.canvas&&document.elementFromPoint(${pb[0]},${pb[1]})===app.canvas.canvas`);
      await gesture(S, 900, (p) => [[pa[0] + (pb[0] - pa[0]) * p, pa[1] + (pb[1] - pa[1]) * p, 1]]);
      await sleep(500);
      const d1 = await state(S);
      console.log(`desktop control ${t314.k}: links ${d0.links} -> ${d1.links} (slots on canvas: ${top}); compositor run: ${t314 ? `${t314.linksBefore} -> ${t314.linksAfter}` : 'n/a'}`);
      check('desktop control (no compositor) ' + t314.k + ': same link-count change as with the compositor', top && (d1.links - d0.links) === (t314.linksAfter - t314.linksBefore), { desktop: [d0.links, d1.links], compositor: t314 && [t314.linksBefore, t314.linksAfter] });
    }
  } finally {
    await S.cleanup();
  }
}

try { await main(); } catch (e) { console.error('ERROR at step', STEP, e); process.exitCode = 1; }
clearTimeout(watchdog);
const failed = results.checks.filter((c) => !c.ok);
console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(results, null, 2));
if (failed.length) process.exitCode = 1;
