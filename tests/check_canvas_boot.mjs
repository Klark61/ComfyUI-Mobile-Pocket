// Checks for canvas mode (web/canvas/boot.js + GET /pocket/canvas).
//   node tests/check_canvas_boot.mjs [--wf a.json,b.json] [--inject] [--quiet]
// Own headless Chrome on port 9228 (temp profile, always cleaned up), phone emulation 412x915 DPR 2.625, no CPU throttle.
// Against the live ComfyUI (never restarted, no job queued, no workflow saved). Uses the real /pocket/canvas route when it answers 200;
// otherwise (route not loaded yet, or --inject) it loads "/?canvas=1" and injects web/canvas/boot.js + canvas.css through CDP.
// Checks:
//   1. no request that persists an overridden settings key reaches the server (all /settings* requests are logged), user attempts
//      to change them are dropped by the guard, other keys pass through;
//   2. sha256 of user/default/comfy.settings.json is identical before and after a canvas session (only the hash is read);
//   3. ?path=<wf> opens that saved workflow (persisted, same file, same node count);
//   4. app.graphToPrompt() output and the serialized widget values are equal with the denylist and with ?ext=all.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WF_DIR, SETTINGS_FILE, chromePath, workflowsFor } from './env.mjs';

const PORT = 9228;
const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CANVAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'canvas');
const CHROME = chromePath();
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes('--' + k);
// --wf names real workflows in WF_DIR; without it two synthetic fixtures are installed as temp copies (removed on exit)
const WFS = workflowsFor(opt('wf'), ['txt2img', 'group_bypass']);
const OVERRIDDEN = ['Comfy.RightSidePanel.IsOpen', 'Comfy.Graph.CanvasInfo', 'Comfy.Minimap.Visible', 'LiteGraph.Canvas.MaximumFps',
  'Comfy.LinkRenderMode', 'LiteGraph.Canvas.MinFontSizeForLOD', 'Comfy.Workflow.Persist'];

// ---- hard limits: 180 s overall, 45 s per wait; one progress line per step on stderr
const T0 = Date.now();
let STEP = 'start';
const live = new Set();   // chrome pids + profiles, killed by the watchdog
const step = (name) => { STEP = name; console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${name}`); };
const killAll = () => { for (const c of live) { try { spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } };
const wd = setTimeout(() => {
  console.error(`TIMEOUT at step ${STEP}`); killAll();
  setTimeout(() => { for (const c of live) { try { fs.rmSync(c.profile, { recursive: true, force: true }); } catch {} } process.exit(2); }, 1500);
}, 180000);
const within = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`timeout ${ms / 1000}s: ${what}`)), ms))]);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const sha = () => crypto.createHash('sha256').update(fs.readFileSync(SETTINGS_FILE)).digest('hex');

async function session(fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'check-canvas-'));
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  const entry = { pid: chrome.pid, profile }; live.add(entry);
  const cleanup = async () => {
    live.delete(entry);
    try { if (chrome.pid) spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(700);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  };
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
    const S = {
      send: (method, params = {}) => new Promise((r, j) => { const id = ++n; pend.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); }),
      on: (fn) => listeners.push(fn),
    };
    S.ev = async (expression) => {
      const r = await within(S.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), 45000, expression.slice(0, 60).replace(/\s+/g, ' '));
      if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
      return r.result.value;
    };
    await S.send('Runtime.enable'); await S.send('Page.enable'); await S.send('Network.enable');
    await S.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await S.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Linux armv8l' });
    return await fn(S);
  } finally { await cleanup(); }
}

// Opens canvas mode and waits for boot.ready. Returns the navigation mode used.
async function openCanvas(S, query, forceInject) {
  let route = false;
  if (!forceInject) { try { route = (await fetch(`${BASE}/pocket/canvas`)).status === 200; } catch {} }
  if (!route) {
    const boot = fs.readFileSync(path.join(CANVAS_DIR, 'boot.js'), 'utf8');
    const css = JSON.stringify(fs.readFileSync(path.join(CANVAS_DIR, 'canvas.css'), 'utf8'));
    // the route is missing: serve /pocket/static/canvas/* (gestures.js is imported from there) straight from disk
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
      S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: f.endsWith('.css') ? 'text/css' : 'text/javascript' }],
        body: fs.readFileSync(f).toString('base64') }).catch(() => {});
    });
    await S.send('Page.addScriptToEvaluateOnNewDocument', { source:
      `window.__COMFY_CANVAS__=1;if(/^https?:/.test(location.protocol)){document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${css};document.head.appendChild(s);});}\n` + boot });
  }
  await S.send('Page.navigate', { url: route ? `${BASE}/pocket/canvas${query}` : `${BASE}/${query}` });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(300);
    try { if (await S.ev(`!!(window.__canvasBoot&&window.__canvasBoot.readyAt)`)) break; } catch {}
  }
  if (!(await S.ev(`!!(window.__canvasBoot&&window.__canvasBoot.readyAt)`))) throw new Error('canvas boot never became ready');
  await sleep(1500);
  return route ? 'route' : 'inject';
}

// Stable, comparable snapshot of what a Save / Run would use.
const SNAPSHOT = `(async()=>{
  const sortKeys=(v)=>Array.isArray(v)?v.map(sortKeys):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])])):v);
  const p=await app.graphToPrompt();
  const ser=app.graph.serialize();
  return JSON.stringify({prompt:sortKeys(p.output),widgets:ser.nodes.map(n=>[n.id,n.type,sortKeys(n.widgets_values??null)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]),undefined,{numeric:true})),
    links:ser.links.length,nodes:ser.nodes.length,exts:app.extensions.length});
})()`;

async function main() {
  const hashBefore = sha();
  let mode = '';
  const settingsReqs = [];
  const snaps = {};   // wf -> {deny, all}
  const expectOf = (wf) => JSON.parse(fs.readFileSync(path.join(WF_DIR, wf), 'utf8'));
  const OTHER = ['Comfy.Graph.CanvasInfo', 'Comfy.LinkRenderMode', 'LiteGraph.Canvas.MaximumFps', 'Comfy.RightSidePanel.IsOpen', 'Comfy.Minimap.Visible'];

  // ---- session 1: a real canvas session on the first workflow (nothing intercepted) -> request log + settings file hash
  const firstWf = WFS[0];
  step(`session 1: canvas ?path=${firstWf}`);
  await session(async (S) => {
    S.on((m) => {
      if (m.method === 'Network.requestWillBeSent') {
        const r = m.params.request;
        if (/\/settings(\/|\?|$)|comfy\.settings\.json/i.test(r.url)) settingsReqs.push({ method: r.method, url: r.url.replace(BASE, ''), body: r.postData || '' });
      }
    });
    mode = await openCanvas(S, `?path=${encodeURIComponent(firstWf)}&canvas=1`, has('inject'));
    step(`session 1: ready (${mode})`);
    const st = JSON.parse(await S.ev(`(()=>{const B=window.__canvasBoot,s=app.extensionManager.setting;
      return JSON.stringify({errors:B.errors,path:B.pathState,mismatch:B.settingMismatch,pathname:location.pathname,dpr:devicePixelRatio,realDpr:B.realDpr(),canvasW:app.canvas.canvas.width,
        cssW:app.canvas.canvas.clientWidth,right:s.get('Comfy.RightSidePanel.IsOpen'),info:s.get('Comfy.Graph.CanvasInfo'),fps:s.get('LiteGraph.Canvas.MaximumFps'),link:s.get('Comfy.LinkRenderMode'),
        lod:s.get('LiteGraph.Canvas.MinFontSizeForLOD'),sidebar:app.extensionManager.sidebarTab.activeSidebarTabId,dropped:B.droppedExt.length})})()`));
    check('boot ran without errors, URL base fixed to "/"', st.errors.length === 0 && st.pathname === '/', JSON.stringify(st.errors));
    check('dpr capped (1.25) and canvas backing store follows it', st.dpr === Math.min(st.realDpr, 1.25) && Math.abs(st.canvasW - Math.round(st.cssW * st.dpr)) <= 1, `dpr=${st.dpr} real=${st.realDpr} canvasW=${st.canvasW}/${st.cssW}`);
    check('phone settings are active in memory', st.right === false && st.info === false && st.fps === 60 && st.link === 1 && st.lod === 10 && !st.sidebar && st.mismatch.length === 0, JSON.stringify({ r: st.right, i: st.info, f: st.fps, l: st.link, lod: st.lod, sb: st.sidebar, mm: st.mismatch }));
    check('denylist applied to the extension list', st.dropped > 0, `${st.dropped} scripts dropped`);
    const w = JSON.parse(await S.ev(`(()=>{const w=app.extensionManager.workflow.activeWorkflow;return JSON.stringify({path:w.path,persisted:w.isPersisted,temp:w.isTemporary,mod:w.isModified,nodes:app.graph._nodes.length})})()`));
    const expect = expectOf(firstWf);
    check(`?path=${firstWf} opens that saved workflow`, w.path === 'workflows/' + firstWf && w.persisted && !w.temp && w.nodes === expect.nodes.length,
      `${w.path} persisted=${w.persisted} modified=${w.mod} nodes=${w.nodes}/${expect.nodes.length}`);
    step('session 1: snapshot');
    await sleep(1000);
    snaps[firstWf] = { deny: JSON.parse(await S.ev(SNAPSHOT)) };
    // the user changing the overridden settings in the settings dialog: the frontend POSTs them, the guard must drop them
    step('session 1: gestures');
    check('gestures installed', (await S.ev(`window.__canvasBoot.gesturesState`)) === 'installed', await S.ev(`window.__canvasBoot.gesturesState`));
    const pt = JSON.parse(await S.ev(`(()=>{const c=app.canvas,r=c.canvas.getBoundingClientRect(),g=app.graph,sc=c.ds.scale;
      for(let y=120;y<760;y+=40)for(let x=40;x<372;x+=30){let ok=true;
        for(let dx=-90;dx<=30&&ok;dx+=30)for(let dy=-70;dy<=30;dy+=25){const q=[(x+dx-r.left)/sc-c.ds.offset[0],(y+dy-r.top)/sc-c.ds.offset[1]];if(g.getNodeOnPos(q[0],q[1])){ok=false;break}}
        if(ok&&document.elementFromPoint(x,y)===c.canvas&&document.elementFromPoint(x-60,y-40)===c.canvas)return JSON.stringify([x,y])}
      return 'null'})()`));
    if (!pt) check('one-finger pan on empty canvas', false, 'no empty canvas point found');
    else {
      const ds0 = JSON.parse(await S.ev(`JSON.stringify({s:app.canvas.ds.scale,x:app.canvas.ds.offset[0],y:app.canvas.ds.offset[1]})`));
      const tp = (type, x, y) => S.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
      // default pref (Nothing): a one-finger drag on empty canvas leaves the view alone; the pan below needs the Pan pref
      await tp('touchStart', pt[0], pt[1]); await sleep(60);
      for (let i = 1; i <= 20; i++) { await tp('touchMove', pt[0] - 3 * i, pt[1] - 2 * i); await sleep(16); }
      await tp('touchEnd'); await sleep(400);
      const dsN = JSON.parse(await S.ev(`JSON.stringify({s:app.canvas.ds.scale,x:app.canvas.ds.offset[0],y:app.canvas.ds.offset[1]})`));
      check('default pref (Nothing): one-finger drag on empty canvas does not move the view', dsN.s === ds0.s && dsN.x === ds0.x && dsN.y === ds0.y, JSON.stringify({ ds0, dsN }));
      await S.ev(`window.__canvasPrefs.set({emptyDrag:'pan'})`);
      await tp('touchStart', pt[0], pt[1]); await sleep(60);
      for (let i = 1; i <= 20; i++) { await tp('touchMove', pt[0] - 3 * i, pt[1] - 2 * i); await sleep(16); }
      await tp('touchEnd'); await sleep(500);
      await S.ev(`window.__canvasPrefs.set({emptyDrag:'none'})`);
      const ds1 = JSON.parse(await S.ev(`JSON.stringify({s:app.canvas.ds.scale,x:app.canvas.ds.offset[0],y:app.canvas.ds.offset[1]})`));
      const dx = (ds1.x - ds0.x) * ds0.s, dy = (ds1.y - ds0.y) * ds0.s;   // offset delta in screen px; finger moved (-60, -40)
      check('pref Pan: one-finger pan on empty canvas moves ds.offset by the finger delta', ds1.s === ds0.s && Math.abs(dx + 60) < 2 && Math.abs(dy + 40) < 2, `offset delta in px = (${dx.toFixed(1)}, ${dy.toFixed(1)}), expected (-60, -40)`);
    }
    step('session 1: settings write attempts');
    await S.ev(`(async()=>{const s=app.extensionManager.setting;
      await s.set('Comfy.Graph.CanvasInfo',true);await s.set('Comfy.LinkRenderMode',2);await s.set('LiteGraph.Canvas.MaximumFps',30);await s.set('Comfy.RightSidePanel.IsOpen',true);await s.set('Comfy.Minimap.Visible',true);return 1})()`);
    await sleep(1200);
    const dropped = await S.ev(`JSON.stringify(window.__canvasBoot.droppedWrites)`);
    check('guard dropped the attempted writes of overridden keys', OTHER.every((k) => dropped.includes(k)), dropped);
    // hash + request log are judged now, before anything is intercepted
    const leaked = settingsReqs.filter((r) => r.method !== 'GET' && OVERRIDDEN.some((k) => r.url.includes(encodeURIComponent(k)) || r.body.includes('"' + k + '"')));
    check('zero settings writes for the overridden keys reached the server', leaked.length === 0,
      `${settingsReqs.length} /settings* requests logged (${settingsReqs.filter((r) => r.method !== 'GET').map((r) => r.method + ' ' + r.url).join('; ') || 'no writes'})`);
    check('comfy.settings.json sha256 unchanged by a canvas session', sha() === hashBefore, sha() === hashBefore ? hashBefore.slice(0, 12) : 'changed');
    // pass-through of other keys, with settings POSTs answered locally by Fetch so the server file is never touched
    step('session 1: guard pass-through');
    const posts = [];
    await S.send('Fetch.enable', { patterns: [{ urlPattern: '*settings*', requestStage: 'Request' }] });
    S.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      const r = m.params.request; if (r.method !== 'GET') posts.push({ method: r.method, url: r.url.replace(BASE, ''), body: r.postData || '' });
      S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, body: Buffer.from('{}').toString('base64') }).catch(() => {});
    });
    await S.ev(`(async()=>{
      await fetch('/api/settings/Comfy.Graph.CanvasInfo',{method:'POST',body:'true'});
      await fetch('/api/settings',{method:'POST',body:JSON.stringify({'Comfy.Graph.CanvasInfo':true,'Comfy.LinkRenderMode':2})});
      await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({'Comfy.Graph.CanvasInfo':true,'Some.Other.Key':'x'})});
      await fetch('/api/settings/Some.Other.Single',{method:'POST',body:'"y"'});
      return 1})()`);
    await sleep(500);
    const wrote = posts.filter((p) => OVERRIDDEN.some((k) => p.url.includes(k) || p.body.includes('"' + k + '"')));
    const mixed = posts.find((p) => p.url.endsWith('/settings') && p.body.includes('Some.Other.Key'));
    check('guard: overridden-only writes never leave the page', wrote.length === 0, JSON.stringify(wrote));
    check('guard: mixed bulk write passes only the other key', !!mixed && Object.keys(JSON.parse(mixed.body)).join() === 'Some.Other.Key', mixed ? mixed.body : 'none');
    check('guard: other single-key write passes through', posts.some((p) => p.url.includes('/settings/Some.Other.Single')));
  });

  // ---- remaining sessions: ?ext=all for the first workflow, then deny + all for the others
  for (const wf of WFS) {
    for (const variant of ['deny', 'all']) {
      if (snaps[wf]?.[variant]) continue;
      step(`session: ${wf} (${variant})`);
      await session(async (S) => {
        await openCanvas(S, `?path=${encodeURIComponent(wf)}&canvas=1${variant === 'all' ? '&ext=all' : ''}`, has('inject'));
        const info = JSON.parse(await S.ev(`(()=>{const w=app.extensionManager.workflow.activeWorkflow;return JSON.stringify({path:w.path,pathState:__canvasBoot.pathState,nodes:app.graph._nodes.length})})()`));
        if (variant === 'deny') check(`?path=${wf} shows that workflow`, info.path === 'workflows/' + wf && info.pathState === 'open' && info.nodes === expectOf(wf).nodes.length, JSON.stringify(info));
        await sleep(1000);
        (snaps[wf] ||= {})[variant] = JSON.parse(await S.ev(SNAPSHOT));
      });
    }
    const a = snaps[wf].deny, b = snaps[wf].all;
    const diffKeys = Object.keys(b.prompt).filter((k) => JSON.stringify(a.prompt[k]) !== JSON.stringify(b.prompt[k]));
    check(`${wf}: converted prompt equal with and without denylist`, JSON.stringify(a.prompt) === JSON.stringify(b.prompt),
      `${Object.keys(a.prompt).length} prompt nodes, ${a.exts} vs ${b.exts} extensions${diffKeys.length ? ', differing nodes: ' + diffKeys.slice(0, 8).join(',') : ''}`);
    check(`${wf}: serialized widget values equal (Save would not lose data)`, JSON.stringify(a.widgets) === JSON.stringify(b.widgets) && a.links === b.links, `${a.nodes} nodes, ${a.links} links`);
  }
  check('comfy.settings.json sha256 still unchanged at the end', sha() === hashBefore);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (${mode}) in ${Math.round((Date.now() - T0) / 1000)}s`);
  process.exitCode = failed.length ? 1 : 0;
}
await main().catch((e) => { console.error(`ERROR at step ${STEP}:`, e.message || e); killAll(); process.exitCode = 1; });
clearTimeout(wd);
process.exit(process.exitCode || 0);
