// Checks for the canvas touch toolbar + editing UX (web/canvas/toolbar.js, boot.js reload support).
//   node tests/check_canvas_toolbar.mjs
// Own headless Chrome on port 9230, phone emulation 412x915, against the live ComfyUI (never restarted).
// Works on temp copies of the synthetic fixtures tests/fixtures/canvas_playground.json (or --wf <file in WF_DIR>) + group_bypass.json (installed into user/default/workflows under a
// unique _pocket_test_* name, deleted at the end); /prompt is intercepted (no GPU).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WF_DIR, chromePath, installFixture, workflowsFor } from './env.mjs';

const PORT = 9230;
const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CANVAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'canvas');
const CHROME = chromePath();
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes('--' + k);

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


const WF = workflowsFor(opt('wf'), ['canvas_playground'])[0], OTHER_WF = installFixture('group_bypass'), DST = `${WF_DIR}/${WF}`;
const TARGET = 5;   // KSampler in the fixture (canvas_playground.json): selected, bypassed, dragged
const click = (S, act) => S.ev(`(()=>{const b=document.querySelector('[data-act="${act}"]');if(!b)return 'nobtn';if(b.disabled)return 'disabled';b.click();return 'ok'})()`);
const until = async (S, expr, ms = 20000, what = expr) => {
  const t0 = Date.now();
  while (Date.now() - t0 < Math.min(ms, 45000)) { try { const v = await S.ev(expr); if (v) return v; } catch {} await sleep(200); }
  throw new Error('wait failed: ' + what.slice(0, 80));
};
async function touch(S, pts, kind) {   // pts [[x,y]...]
  await S.send('Input.dispatchTouchEvent', { type: kind, touchPoints: kind === 'touchEnd' || kind === 'touchCancel' ? [] : pts.map(([x, y], i) => ({ x, y, id: i })) });
}
const tap = async (S, x, y) => { await touch(S, [[x, y]], 'touchStart'); await sleep(60); await touch(S, [], 'touchEnd'); };
async function drag(S, a, b, steps = 12) {
  await touch(S, [a], 'touchStart'); await sleep(80);
  for (let i = 1; i <= steps; i++) { await touch(S, [[a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps]], 'touchMove'); await sleep(25); }
  await sleep(80); await touch(S, [], 'touchEnd');
}
async function key(S, k, code, vk) {
  await S.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk });
  await S.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}
// An already-running server may not return "__widget_providers__" yet (needs a restart); add it so pruning is exercised like on the new server.
async function fakeProviders(S) {
  await S.send('Fetch.enable', { patterns: [{ urlPattern: '*/pocket/api/canvas/node-packs*', requestStage: 'Request' }] });
  S.on((m) => {
    if (m.method !== 'Fetch.requestPaused' || !/node-packs/.test(m.params.request.url)) return;
    fetch(`${BASE}/pocket/api/canvas/node-packs`).then((r) => r.json()).then((j) => {
      if (!j.__widget_providers__) j.__widget_providers__ = ['comfy-mtb', 'comfyui-rmbg', 'comfyui_layerstyle', 'ausboss-nodes'];
      return S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(j)).toString('base64') });
    }).catch(() => S.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {}));
  });
}
async function openCanvas(S, query) {
  await fakeProviders(S);
  await S.send('Page.navigate', { url: `${BASE}/pocket/canvas${query}` });
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) { await sleep(400); try { if (await S.ev(`!!(window.__canvasBoot&&window.__canvasBoot.readyAt&&window.__canvasBoot.toolbarState)`)) break; } catch {} }
  if (!(await S.ev(`!!(window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed')`))) throw new Error('toolbar not installed: ' + await S.ev(`JSON.stringify(window.__canvasBoot&&window.__canvasBoot.errors)`));
  await sleep(1200);
}
const nodeCount = (S) => S.ev(`app.graph._nodes.length`);

async function main() {
  try {
    step('session: toolbar');
    await session(async (S) => {
      await openCanvas(S, `?path=${WF}`);
      const base = await nodeCount(S);
      const tb = JSON.parse(await S.ev(`(()=>{const b=document.querySelector('#canvas-toolbar');const bs=[...b.querySelectorAll('button')];
        return JSON.stringify({pos:getComputedStyle(b).position,labels:bs.map(x=>x.textContent.trim()),fits:b.scrollWidth<=b.clientWidth+1,minH:Math.min(...bs.map(x=>x.getBoundingClientRect().height)),minW:Math.min(...bs.map(x=>x.getBoundingClientRect().width)),
        dis:['delete','bypass','mute'].map(a=>document.querySelector('[data-act='+a+']').disabled)})})()`));
      check('toolbar fits 412 px without horizontal scroll', tb.fits, JSON.stringify(tb));
      check('toolbar present: fixed, >=48px targets, all buttons, selection buttons disabled', tb.pos === 'fixed' && tb.minH >= 48 && tb.minW >= 48 && tb.labels.join() === 'Add,Delete,Bypass,Menu,Undo,Run,Save,More' && tb.dis.every(Boolean), JSON.stringify(tb));
      check('Delete with empty selection is disabled', (await click(S, 'delete')) === 'disabled');

      const addNode = async (term, type) => {
        await click(S, 'add');
        await until(S, `!!document.querySelector('[role=search] input[role=combobox]')`, 15000, 'search box');
        await sleep(300);
        const geo = JSON.parse(await S.ev(`(()=>{const i=document.querySelector('[role=search] input[role=combobox]');const r=i.getBoundingClientRect();return JSON.stringify({w:r.width,focused:document.activeElement===i,vw:innerWidth})})()`));
        await S.send('Input.insertText', { text: term });
        await until(S, `!!document.querySelector('#results-list [role=option]')`, 15000, 'search results');
        await sleep(400);
        await key(S, 'Enter', 'Enter', 13);
        await until(S, `app.graph._nodes.some(n=>n.type==='${type}'&&!n.__seen)`, 10000, 'node added ' + type);
        await S.ev(`app.graph._nodes.forEach(n=>n.__seen=true)`);
        return geo;
      };
      step('add PrimitiveInt');
      await S.ev(`app.graph._nodes.forEach(n=>n.__seen=true)`);
      const geo = await addNode('PrimitiveInt', 'PrimitiveInt');
      check('search box opens full width with focused input', geo.w >= geo.vw * 0.8 && geo.focused, JSON.stringify(geo));
      check('node added via toolbar search', (await nodeCount(S)) === base + 1);
      await until(S, `!document.querySelector('[role=search]')`, 10000, 'search closed');

      step('touch link drag');
      const prim = await S.ev(`app.graph._nodes.filter(n=>n.type==='PrimitiveInt').pop().id`);   // the one just added (the fixture may have its own)
      const place = (set) => S.ev(`(()=>{
        const c=app.canvas, p=app.graph.getNodeById(${prim}), t=app.graph._nodes.find(n=>n.type==='EmptyLatentImage');
        if (${set}) { p.pos=[t.pos[0]-380,t.pos[1]]; c.ds.scale=0.9; c.ds.offset=[-(t.pos[0]-400)+10,-(t.pos[1]-480)];   // ~y 430 px on screen: below the top-right queue/actions panel (it covers y 82..223 on a phone) and above the bottom toolbar
         c.setDirty(true,true); }
        const rect=c.canvas.getBoundingClientRect();
        const idx=t.inputs.findIndex(i=>i.name==='width');
        const o=p.getOutputPos(0), ip=t.inputs[idx].pos, i=[t.pos[0]+ip[0], t.pos[1]+ip[1]];
        const scr=(g)=>[rect.left+(g[0]+c.ds.offset[0])*c.ds.scale, rect.top+(g[1]+c.ds.offset[1])*c.ds.scale];
        return JSON.stringify({from:scr(o),to:scr(i),idx,tid:t.id,links:Object.keys(app.graph.links).length});
      })()`);
      await place(true); await sleep(500);   // let the canvas draw (hit-testing uses the visible-node list)
      const info = JSON.parse(await place(false));
      await drag(S, info.from, info.to);
      await sleep(600);
      const lk = JSON.parse(await S.ev(`(()=>{const t=app.graph.getNodeById(${info.tid});const i=t.inputs[${info.idx}];const l=i.link!=null?app.graph.links[i.link]:null;return JSON.stringify({links:Object.keys(app.graph.links).length,origin:l&&l.origin_id})})()`));
      check('touch link drag connects PrimitiveInt -> width', lk.origin === prim && lk.links === info.links + 1, JSON.stringify({ lk, info }));

      step('delete/undo/redo');
      await S.ev(`(()=>{const c=app.canvas;c.deselectAll();c.select(app.graph.getNodeById(${prim}));})()`);
      await until(S, `!document.querySelector('#canvas-toolbar [data-act=delete]').disabled`, 5000, 'delete enabled');
      check('Delete enabled once a node is selected', true);
      await sleep(600);
      await click(S, 'delete');
      await until(S, `!app.graph.getNodeById(${prim})`, 8000, 'node deleted');
      check('Delete removes the selected node', true);
      await sleep(800);
      await click(S, 'undo');
      await until(S, `!!app.graph.getNodeById(${prim})`, 8000, 'undo restores');
      check('Undo brings the node back', true);
      await sleep(600);
      await click(S, 'redo');
      await until(S, `!app.graph.getNodeById(${prim})`, 8000, 'redo');
      check('Redo deletes it again', true);

      step('bypass');
      await S.ev(`(()=>{const c=app.canvas;c.deselectAll();c.select(app.graph.getNodeById(${TARGET}));})()`);
      await sleep(500);
      await click(S, 'bypass');
      const mode = await until(S, `app.graph.getNodeById(${TARGET}).mode===4?'4':''`, 8000, 'bypass mode');
      check('Bypass sets mode 4 on the selected node', mode === '4');

      step('text sheet');
      await addNode('Note', 'Note');
      await until(S, `!document.querySelector('[role=search]')`, 10000, 'search closed');
      const noteId = await S.ev(`app.graph._nodes.filter(n=>n.type==='Note').pop().id`);
      await S.ev(`(()=>{const c=app.canvas,n=app.graph.getNodeById(${noteId});c.deselectAll();c.ds.scale=1;c.ds.offset=[-n.pos[0]+40,-n.pos[1]+120];c.setDirty(true,true)})()`);
      await sleep(900);
      const ta = JSON.parse(await S.ev(`(()=>{const n=app.graph.getNodeById(${noteId});const w=n.widgets[0];const e=w.element||w.inputEl;const r=e&&e.getBoundingClientRect();return JSON.stringify(r?{x:r.left+r.width/2,y:r.top+r.height/2,vis:r.width>10&&r.height>10}:null)})()`));
      if (!ta || !ta.vis) throw new Error('note textarea not visible: ' + JSON.stringify(ta));
      await tap(S, ta.x, ta.y);
      await until(S, `!!document.querySelector('#canvas-text-sheet textarea')`, 8000, 'sheet opened');
      const full = await S.ev(`(()=>{const r=document.querySelector('#canvas-text-sheet').getBoundingClientRect();return r.width>=innerWidth-1&&r.height>=innerHeight*0.5})()`);
      check('tap on a multiline widget opens the full-screen sheet', full);
      await S.ev(`(()=>{const a=document.querySelector('#canvas-text-sheet textarea');a.focus();a.select()})()`);
      await S.send('Input.insertText', { text: 'hello from the phone sheet' });
      await S.ev(`[...document.querySelectorAll('#canvas-text-sheet button')].find(b=>b.textContent==='Done').click()`);
      await until(S, `!document.querySelector('#canvas-text-sheet')`, 5000, 'sheet closed');
      const val = await S.ev(`app.graph.getNodeById(${noteId}).widgets[0].value`);
      check('sheet Done writes the value back to the widget', val === 'hello from the phone sheet', JSON.stringify(val));
      await sleep(500);
      await tap(S, ta.x, ta.y);
      await until(S, `!!document.querySelector('#canvas-text-sheet textarea')`, 8000, 'sheet reopened');
      await S.send('Input.insertText', { text: 'zzz' });
      await S.ev(`[...document.querySelectorAll('#canvas-text-sheet button')].find(b=>b.textContent==='Cancel').click()`);
      check('sheet Cancel keeps the old value', (await S.ev(`app.graph.getNodeById(${noteId}).widgets[0].value`)) === 'hello from the phone sheet');

      step('menus: hold does not open one');
      const pt = JSON.parse(await S.ev(`(async()=>{const c=app.canvas,n=app.graph.getNodeById(${TARGET});c.ds.scale=1;c.ds.offset=[-n.pos[0]+80,-n.pos[1]+200];c.setDirty(true,true);
        await new Promise(r=>setTimeout(r,500));
        const r=c.canvas.getBoundingClientRect();return JSON.stringify({x:r.left+(n.pos[0]+c.ds.offset[0]+30)*c.ds.scale,y:r.top+(n.pos[1]+c.ds.offset[1]-15)*c.ds.scale,e:(()=>{for(let y=r.height-120;y>60;y-=25)for(let x=r.width-20;x>20;x-=25){const g=c.convertEventToCanvasOffset?c.convertEventToCanvasOffset({clientX:r.left+x,clientY:r.top+y}):[(x/c.ds.scale)-c.ds.offset[0],(y/c.ds.scale)-c.ds.offset[1]];if(!c.graph.getNodeOnPos(g[0],g[1])&&!c.graph.getGroupOnPos(g[0],g[1]))return [r.left+x,r.top+y]}return null})()})})()`));
      const menusNow = () => S.ev(`document.querySelectorAll('.litecontextmenu').length`);
      const fakeCtx = (x, y) => S.ev(`document.querySelector('#graph-canvas').dispatchEvent(new MouseEvent('contextmenu',{clientX:${x},clientY:${y},bubbles:true,cancelable:true,button:2}))`);
      const dflt = JSON.parse(await S.ev(`JSON.stringify({ls:localStorage.getItem('comfypocket.canvas.prefs'),p:window.__canvasPrefs.get(),g:window.__canvasBoot.gestures&&window.__canvasBoot.gestures.prefs})`));
      check('default prefs: one finger on empty canvas = Nothing, long-press Off, nothing stored in localStorage yet', dflt.p.emptyDrag === 'none' && dflt.p.longPress === 'off' && dflt.ls === null && dflt.g && dflt.g.emptyDrag === 'none', JSON.stringify(dflt));
      // (a) real boot path (toolbar long-press armed but Off): rest 700 ms on a node title, then drag: moves, no menu
      const pos0 = JSON.parse(await S.ev(`JSON.stringify(app.graph.getNodeById(${TARGET}).pos)`));
      await touch(S, [[pt.x, pt.y]], 'touchStart'); await sleep(500); await fakeCtx(pt.x, pt.y); await sleep(250);
      for (let i = 1; i <= 8; i++) { await touch(S, [[pt.x + 8 * i, pt.y + 4 * i]], 'touchMove'); await sleep(25); }
      await sleep(80); await touch(S, [], 'touchEnd'); await sleep(500);
      const pos1 = JSON.parse(await S.ev(`JSON.stringify(app.graph.getNodeById(${TARGET}).pos)`));
      check('hold 700 ms on a node title then drag (+ native contextmenu at 500 ms): the node moves, no context menu', Math.abs(pos1[0] - pos0[0] - 64) < 14 && (await menusNow()) === 0, JSON.stringify({ pos0, pos1, menus: await menusNow() }));
      await S.ev(`(()=>{app.graph.getNodeById(${TARGET}).pos=${JSON.stringify(pos0)};app.canvas.setDirty(true,true)})()`);
      // hold still on a node / on empty canvas for 1.2 s, release: still no menu (the frontend's own 600 ms fake right-click is blocked)
      await touch(S, [[pt.x, pt.y]], 'touchStart'); await sleep(1200); await touch(S, [], 'touchEnd'); await sleep(500);
      check('hold still 1.2 s on a node title: no context menu', (await menusNow()) === 0);
      await touch(S, [pt.e], 'touchStart'); await sleep(1200); await touch(S, [], 'touchEnd'); await sleep(500);
      check('hold still 1.2 s on empty canvas: no context menu', (await menusNow()) === 0);

      // (e) Menu button
      step('menu button');
      await S.ev(`(()=>{const c=app.canvas;c.deselectAll();c.select(app.graph.getNodeById(${TARGET}));})()`);
      await sleep(400);
      check('Menu button is a primary button', (await S.ev(`!!document.querySelector('#canvas-toolbar [data-act=menu]')`)));
      await click(S, 'menu');
      const mm = await until(S, `document.querySelector('.litecontextmenu')?.textContent.slice(0,300)`, 5000, 'node menu via Menu button');
      const mr = JSON.parse(await S.ev(`(()=>{const r=document.querySelector('.litecontextmenu').getBoundingClientRect();return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,vw:innerWidth,vh:innerHeight})})()`));
      check('Menu button with a node selected opens that node\'s context menu on screen', /Properties|Title|Mode|Bypass|Colors/i.test(mm) && !/Add Group/.test(mm) && mr.l >= 0 && mr.t >= 0 && mr.r <= mr.vw + 1, mm.slice(0, 80) + ' ' + JSON.stringify(mr));
      await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(m=>m.remove())`);
      await S.ev(`app.canvas.deselectAll()`); await sleep(300);
      await click(S, 'menu');
      const m0 = await until(S, `document.querySelector('.litecontextmenu')?.textContent.slice(0,300)`, 5000, 'canvas menu via Menu button');
      check('Menu button with nothing selected opens the canvas menu', /Add Node|Add Group|Search/i.test(m0), m0.slice(0, 80));
      await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(m=>m.remove())`);
      await S.ev(`(()=>{const g=new LiteGraph.LGraphGroup('T');g.pos=[app.graph.getNodeById(${TARGET}).pos[0]-30,app.graph.getNodeById(${TARGET}).pos[1]-120];g.size=[400,300];app.graph.add(g);window.__tg=g;app.canvas.deselectAll();app.canvas.select(g);app.canvas.setDirty(true,true)})()`);
      await sleep(400);
      await click(S, 'menu');
      const mg = await until(S, `document.querySelector('.litecontextmenu')?.textContent`, 5000, 'group menu via Menu button');
      check('Menu button with a group selected opens the menu with the group entry (Edit Group)', /Edit Group/i.test(mg), mg.slice(-80));
      await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(m=>m.remove());app.graph.remove(window.__tg);app.canvas.deselectAll();1`);

      // (f) settings sheet: applies live, stored in localStorage only
      step('settings sheet');
      const posts = [];
      await S.send('Network.enable');
      S.on((m) => { if (m.method === 'Network.requestWillBeSent' && /^(POST|PUT)$/.test(m.params.request.method) && /settings/.test(m.params.request.url)) posts.push(m.params.request.url + ' ' + (m.params.request.postData || '').slice(0, 120)); });
      await click(S, 'more'); await click(S, 'settings');
      await until(S, `!!document.querySelector('#canvas-settings-sheet')`, 5000, 'settings sheet');
      const segs = await S.ev(`JSON.stringify([...document.querySelectorAll('#canvas-settings-sheet .cvt-seg-btn')].map(b=>b.dataset.pref+'='+b.dataset.val+(b.classList.contains('on')?'*':'')))`);
      const sheetBtn = (pref, val) => S.ev(`(()=>{const b=document.querySelector('#canvas-settings-sheet [data-pref="${pref}"][data-val="${val}"]');if(!b)return 'none';b.click();return 'ok'})()`);
      check('settings sheet lists the options with the defaults marked', /emptyDrag=none\*/.test(segs) && /longPress=off\*/.test(segs) && /longPressMs=500\*/.test(segs) && /emptyDrag=box/.test(segs) && /longPressMs=1000/.test(segs), segs);
      await sheetBtn('emptyDrag', 'pan'); await sheetBtn('longPress', 'on'); await sheetBtn('longPressMs', '700');
      const live = JSON.parse(await S.ev(`JSON.stringify({ls:JSON.parse(localStorage.getItem('comfypocket.canvas.prefs')),g:window.__canvasBoot.gestures.prefs,on:[...document.querySelectorAll('#canvas-settings-sheet .cvt-seg-btn.on')].map(b=>b.dataset.val)})`));
      check('settings changes apply live (gestures see Pan without a reload) and are stored in localStorage', live.ls.emptyDrag === 'pan' && live.ls.longPress === 'on' && live.ls.longPressMs === 700 && live.g.emptyDrag === 'pan' && live.on.includes('pan') && live.on.includes('700'), JSON.stringify(live));
      // live effect: one finger on empty canvas now pans (Pan), with no reload
      await S.ev(`document.querySelector('#canvas-settings-sheet .cvt-sheet-btn').click()`);
      await sleep(200);
      const v0 = JSON.parse(await S.ev(`JSON.stringify({x:app.canvas.ds.offset[0],y:app.canvas.ds.offset[1],s:app.canvas.ds.scale})`));
      await drag(S, pt.e, [pt.e[0] - 50, pt.e[1] - 30]);
      await sleep(400);
      const v1 = JSON.parse(await S.ev(`JSON.stringify({x:app.canvas.ds.offset[0],y:app.canvas.ds.offset[1],s:app.canvas.ds.scale})`));
      check('after choosing Pan in the sheet a one-finger drag on empty canvas pans (live, no reload)', Math.abs((v1.x - v0.x) * v0.s + 50) < 2 && Math.abs((v1.y - v0.y) * v0.s + 30) < 2 && (await menusNow()) === 0, JSON.stringify({ v0, v1 }));

      // long-press On (700 ms): a still finger opens the menu, a moving one does not
      step('long press (opt-in)');
      await S.ev(`(()=>{const c=app.canvas,n=app.graph.getNodeById(${TARGET});c.ds.scale=1;c.ds.offset=[-n.pos[0]+80,-n.pos[1]+200];c.setDirty(true,true);c.deselectAll()})()`); await sleep(600);
      await touch(S, [[pt.x, pt.y]], 'touchStart'); await sleep(500);
      check('long-press On / 700 ms: nothing yet at 500 ms', (await menusNow()) === 0);
      await sleep(450);
      const m1 = await until(S, `document.querySelector('.litecontextmenu')?.textContent.slice(0,300)`, 5000, 'node menu');
      await touch(S, [], 'touchEnd');
      check('long-press (On) on a node opens its context menu', /Properties|Title|Mode|Bypass|Colors/i.test(m1), m1.slice(0, 80));
      await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(m=>m.remove())`);
      await sleep(300);
      await touch(S, [pt.e], 'touchStart'); await sleep(950); await touch(S, [], 'touchEnd');
      const m2 = await until(S, `document.querySelector('.litecontextmenu')?.textContent.slice(0,300)`, 5000, 'canvas menu');
      check('long-press (On) on empty canvas opens the canvas menu', /Add Node|Add Group|Search/i.test(m2), m2.slice(0, 80));
      await S.ev(`document.querySelectorAll('.litecontextmenu').forEach(m=>m.remove())`);
      await sleep(300);
      await touch(S, [[pt.x, pt.y]], 'touchStart'); await sleep(400);
      await touch(S, [[pt.x + 20, pt.y + 5]], 'touchMove'); await sleep(900);   // moved 20 px at 400 ms: the 700 ms timer must be gone
      await touch(S, [], 'touchEnd'); await sleep(400);
      check('long-press (On): a finger that moved before the delay opens no menu', (await menusNow()) === 0);
      await S.ev(`(()=>{const n=app.graph.getNodeById(${TARGET});n.pos=${JSON.stringify(pos0)};app.canvas.setDirty(true,true)})()`);
      check('settings never reach the server settings (no POST/PUT to /settings)', posts.length === 0, posts.join(' | '));

      step('save');
      const wantNodes = await nodeCount(S);
      await click(S, 'save');
      const noteSaved = () => { try { return JSON.parse(fs.readFileSync(DST, 'utf8')).nodes.some((n) => String(n.id) === String(noteId)); } catch { return false; } };
      for (let i = 0; i < 40 && !noteSaved(); i++) await sleep(250);
      const disk = JSON.parse(fs.readFileSync(DST, 'utf8'));
      const note = disk.nodes.find((n) => String(n.id) === String(noteId));
      check('Save writes the edit to the same file', disk.nodes.length === wantNodes && note && note.widgets_values[0] === 'hello from the phone sheet' && disk.nodes.find((n) => n.id === TARGET).mode === 4,
        `${disk.nodes.length}/${wantNodes} nodes, note=${JSON.stringify(note && note.widgets_values)}`);

      step('pill');
      await S.ev(`(()=>{const a=app.api;a.dispatchEvent(new CustomEvent('execution_start',{detail:{}}));a.dispatchEvent(new CustomEvent('progress',{detail:{value:5,max:10,node:'${TARGET}'}}))})()`);
      const pill = await S.ev(`(()=>{const p=document.querySelector('#canvas-run-pill');return p.hidden?'':p.textContent})()`);
      check('progress pill shows node and percent', /50%/.test(pill), pill);
      await S.ev(`app.api.dispatchEvent(new CustomEvent('execution_success',{detail:{}}))`);
      check('progress pill hides when done', await S.ev(`document.querySelector('#canvas-run-pill').hidden`));

      // (f, persistence) the settings survive a reload (localStorage) and the sheet shows them
      step('prefs persist across a reload');
      await S.send('Page.reload');
      await sleep(1000);
      const tr = Date.now();
      while (Date.now() - tr < 45000) { await sleep(500); try { if (await S.ev(`window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed'&&window.__canvasBoot.readyAt`)) break; } catch {} }
      await sleep(1000);
      const keep = JSON.parse(await S.ev(`JSON.stringify({p:window.__canvasPrefs.get(),g:window.__canvasBoot.gestures.prefs,ls:localStorage.getItem('comfypocket.canvas.prefs')})`));
      await click(S, 'more'); await click(S, 'settings');
      await until(S, `!!document.querySelector('#canvas-settings-sheet')`, 5000, 'settings sheet after reload');
      const onAfter = await S.ev(`JSON.stringify([...document.querySelectorAll('#canvas-settings-sheet .cvt-seg-btn.on')].map(b=>b.dataset.pref+'='+b.dataset.val))`);
      check('settings persist across a reload (store, gestures and the sheet agree)', keep.p.emptyDrag === 'pan' && keep.p.longPress === 'on' && keep.p.longPressMs === 700 && keep.g.emptyDrag === 'pan'
        && /emptyDrag=pan/.test(onAfter) && /longPress=on/.test(onAfter) && /longPressMs=700/.test(onAfter), JSON.stringify(keep) + ' ' + onAfter);
      await S.ev(`document.querySelector('#canvas-settings-sheet .cvt-sheet-btn').click()`);
    });

    step('session: reload + run');
    await session(async (S) => {
      await openCanvas(S, `?path=${WF}`);
      const posts = [];
      await S.send('Fetch.enable', { patterns: [{ urlPattern: '*/prompt', requestStage: 'Request' }, { urlPattern: '*/pocket/api/canvas/node-packs*', requestStage: 'Request' }] });
      S.on((m) => {
        if (m.method !== 'Fetch.requestPaused') return;
        const r = m.params.request;
        if (!/\/prompt(\?|$)/.test(r.url)) return;
        if (r.method === 'POST') {
          posts.push(r.postData || '');
          S.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ prompt_id: 'test-intercepted', number: 0, node_errors: {} })).toString('base64') }).catch(() => {});
        } else S.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
      });
      step('reload');
      await S.send('Page.reload');
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) { await sleep(500); try { if (await S.ev(`window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed'`)) break; } catch {} }
      await sleep(1500);
      const after = JSON.parse(await S.ev(`JSON.stringify({tb:!!document.querySelector('#canvas-toolbar'),path:app.extensionManager.workflow.activeWorkflow&&app.extensionManager.workflow.activeWorkflow.path,
        pathState:window.__canvasBoot&&window.__canvasBoot.pathState,note:app.graph._nodes.some(n=>n.type==='Note'&&n.widgets[0].value==='hello from the phone sheet')})`));
      check('reload stays in canvas mode with the saved edit', after.tb && after.path === 'workflows/' + WF && after.pathState === 'open' && after.note, JSON.stringify(after));

      step('run');
      await sleep(500);
      const res = await click(S, 'run');
      const t1 = Date.now(); while (!posts.length && Date.now() - t1 < 20000) await sleep(200);
      let body = null; try { body = JSON.parse(posts[0]); } catch {}
      const ok = body && body.prompt && Object.keys(body.prompt).length > 5 && Object.values(body.prompt).every((n) => n.class_type && n.inputs) && body.extra_data && body.extra_data.extra_pnginfo && body.extra_data.extra_pnginfo.workflow;
      check('Run posts a valid /prompt body (intercepted)', !!ok, `click=${res}, ${body && body.prompt ? Object.keys(body.prompt).length + ' prompt nodes' : 'no body'}`);
      check('pruning was active during the session', (await S.ev(`window.__canvasBoot.prune.state`)) === 'active', await S.ev(`window.__canvasBoot.prune.state`));
      check('canvas page recorded the canvas mode for the mobile chip', await S.ev(`(()=>{try{return JSON.parse(localStorage.getItem('comfypocket.mode')||'{}').paths[${JSON.stringify(WF)}]==='canvas'}catch{return false}})()`));

      // ---- draft survives a reload
      step('draft');
      await S.ev(`(()=>{const n=app.graph._nodes.find(n=>n.type==='Note');window.__origNote=n.widgets[0].value;n.widgets[0].value='unsaved draft text';n.widgets[0].callback&&n.widgets[0].callback('unsaved draft text');app.extensionManager.workflow.activeWorkflow.changeTracker.checkState();})()`);
      await until(S, `Object.keys(localStorage).some(k=>k.startsWith('comfypocket.canvas.draft:'))`, 12000, 'draft written');
      const origNote = await S.ev(`window.__origNote`);
      await S.send('Page.reload');
      await sleep(1000);
      const t2 = Date.now();
      while (Date.now() - t2 < 45000) { await sleep(500); try { if (await S.ev(`window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed'&&window.__canvasBoot.readyAt`)) break; } catch {} }
      await sleep(1500);
      const dr = JSON.parse(await S.ev(`JSON.stringify({v:app.graph._nodes.find(n=>n.type==='Note').widgets[0].value,chip:document.querySelector('#canvas-draft-chip')?.textContent||'',mod:app.extensionManager.workflow.activeWorkflow.isModified})`));
      check('draft survives a reload with the Restored chip', dr.v === 'unsaved draft text' && /Restored unsaved changes/.test(dr.chip), JSON.stringify(dr));
      await sleep(3500);   // the draft must not be wiped by the restore itself
      check('draft is still stored after the restore settles', await S.ev(`Object.keys(localStorage).some(k=>k.startsWith('comfypocket.canvas.draft:'))`), JSON.stringify(dr));
      await S.ev(`document.querySelector('#canvas-draft-chip .cvt-chip-btn').click()`);
      await until(S, `app.graph._nodes.find(n=>n.type==='Note').widgets[0].value===${JSON.stringify(origNote)}`, 10000, 'discard reopens saved');
      check('Discard goes back to the saved file', true);
      await sleep(3000);
      check('Discard clears the draft', await S.ev(`!Object.keys(localStorage).some(k=>k.startsWith('comfypocket.canvas.draft:'))`));

      // ---- opening another workflow reloads with its own ?path
      step('second workflow');
      const other = OTHER_WF;
      await S.ev(`(async()=>{const st=app.extensionManager.workflow;const w=st.getWorkflowByPath('workflows/${other}');window.__opening=true;await st.openWorkflow(w);app.loadGraphData(JSON.parse(JSON.stringify(w.activeState)),true,true,w);})()`);
      const t3 = Date.now();
      while (Date.now() - t3 < 45000) { await sleep(500); try { if (await S.ev(`window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed'&&window.__canvasBoot.readyAt&&!window.__opening`)) break; } catch {} }
      const sw = JSON.parse(await S.ev(`JSON.stringify({q:location.search,path:app.extensionManager.workflow.activeWorkflow.path,state:window.__canvasBoot.prune.state,fresh:window.__opening===undefined,ss:sessionStorage.getItem('comfypocket.canvas')})`));
      check('opening a second workflow reloads canvas mode with its ?path', sw.fresh && sw.ss.includes('path=' + encodeURIComponent(other)) && sw.path === 'workflows/' + other, JSON.stringify(sw));
    });
  } finally { try { fs.rmSync(DST, { force: true }); } catch {} }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - T0) / 1000)}s`);
  process.exitCode = failed.length ? 1 : 0;
}
await main().catch((e) => { console.error(`ERROR at step ${STEP}:`, e.message || e); killAll(); process.exitCode = 1; });
clearTimeout(wd);
process.exit(process.exitCode || 0);
