// Regenerates the README screenshots in docs/screenshots/ (01-gallery ... 06-canvas, hero).
//   node tests/make_screenshots.mjs            (env PYTHON = python with Pillow + aiohttp; default "python")
// Privacy: everything except Canvas runs on tests/dev_server.py with synthetic demo images (tests/make_demo_images.py) and a temp user dir.
// Canvas needs the real ComfyUI frontend (127.0.0.1:8188, never restarted): /view, thumbs, history, queue and jobs are intercepted
// (empty answers, image loads failed) so no real output can show. Own headless Chrome on port 9231, phone emulation 412x915 @2x.
// 180 s watchdog; temp dirs, the dev server, Chrome and fixture copies are always removed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_DIR, FIXTURE_DIR, WF_DIR, chromePath } from './env.mjs';

const PY = process.env.PYTHON || 'python';
const LIVE = process.env.COMFY || 'http://127.0.0.1:8188';
const CDP = 9231;
const OUT = path.join(REPO_DIR, 'docs', 'screenshots');
const TESTS = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
let STEP = 'start';
const step = (n) => { STEP = n; console.error(`[${Math.round((Date.now() - T0) / 1000)}s] ${n}`); };
const procs = new Set(); const dirs = new Set();
const killAll = () => { for (const p of procs) { try { spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } procs.clear(); };
const rmDirs = () => { for (const d of dirs) { for (let i = 0; i < 5; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']); } } } };
process.on('exit', () => { killAll(); rmDirs(); });
setTimeout(() => { console.error(`TIMEOUT at step ${STEP}`); killAll(); setTimeout(() => process.exit(2), 1500); }, 180000);
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.add(d); return d; };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---- CDP
let ws, seq = 0; const pend = new Map(); const listeners = [];
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
};
const waitFor = async (expr, ms = 30000) => { const t = Date.now(); for (;;) { try { const v = await ev(expr); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error('timeout: ' + expr.slice(0, 100)); await sleep(150); } };
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  for (let i = 0; ; i++) { try { fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64')); break; } catch (e) { if (i > 6) throw e; await sleep(500); } }   // Windows can briefly lock a PNG (viewers, AV)
  console.error('captured', name);
};
const click = (sel, text) => ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find((b)=>!${JSON.stringify(text || '')}||new RegExp(${JSON.stringify(text || '')},'i').test(b.textContent));if(!e)return false;e.click();return true})()`);

// ---- privacy intercepts for the live (Canvas) session: no real output, history, queue or image load can reach the page
const JH = [{ name: 'Content-Type', value: 'application/json' }];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
async function privacyGuard() {
  const pats = ['*/view*', '*/api/view*', '*/pocket/api/thumb*', '*/pocket/api/outputs*', '*/history*', '*/api/history*', '*/queue*', '*/api/queue*', '*/api/jobs*', '*/pocket/api/trash*'];
  await send('Fetch.enable', { patterns: pats.map((urlPattern) => ({ urlPattern, requestStage: 'Request' })) });
  listeners.push(async (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params; const p = new URL(request.url).pathname; const get = request.method === 'GET';
    const ok = (o) => send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: JH, body: b64(o) });
    try {
      if (/^(\/api)?\/view$/.test(p) || p === '/pocket/api/thumb') return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      if (p === '/pocket/api/outputs') return await ok({ items: [], folders: [], total: 0, more: false });
      if (p === '/pocket/api/trash') return await ok({ items: [] });
      if (/^(\/pocket)?(\/api)?\/history/.test(p) && get) return await ok(p.startsWith('/pocket') ? { history: [] } : {});
      if (/^(\/api)?\/queue$/.test(p) && get) return await ok({ queue_running: [], queue_pending: [] });
      if (p === '/api/jobs') return await ok({ jobs: [], pagination: { offset: 0, limit: 40, total: 0, has_more: false } });
      await send('Fetch.continueRequest', { requestId });
    } catch {}
  });
}

async function startChrome() {
  const profile = mkTmp('shots-chrome-');
  const c = spawn(chromePath(), [`--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  procs.add(c);
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(250); } }
}
async function newTab() {
  if (ws) try { ws.close(); } catch {}
  const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  listeners.length = 0;
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
}

const py = (args) => { const r = spawnSync(PY, args, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`python ${args[0]} failed: ${r.stderr || r.stdout}`); return r.stdout; };
const nav = async (url) => { await send('Page.navigate', { url }); await sleep(600); };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  step('demo images');
  const outDir = mkTmp('shots-out-'), userDir = mkTmp('shots-user-'), cacheDir = mkTmp('shots-cache-');
  py([path.join(TESTS, 'make_demo_images.py'), outDir]);
  const wfDir = path.join(userDir, 'default', 'workflows'); fs.mkdirSync(wfDir, { recursive: true });
  const api = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'txt2img_api.json'), 'utf8'));
  const wf = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'group_bypass.json'), 'utf8'));
  wf.extra = { ...(wf.extra || {}), stub_prompt: api };
  fs.writeFileSync(path.join(wfDir, 'Demo text to image.json'), JSON.stringify(wf));
  const port = await freePort();
  step('dev server :' + port);
  const dev = spawn(PY, [path.join(TESTS, 'dev_server.py'), '--port', String(port), '--output', outDir, '--user', userDir, '--cache', cacheDir, '--fake-comfy', '--fake-step-ms', '900'], { stdio: 'ignore' });
  procs.add(dev);
  const DEV = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(DEV + '/pocket/')).ok) break; } catch {} await sleep(250); }

  await startChrome(); await newTab();

  step('gallery');
  await nav(`${DEV}/pocket/#/gallery`);
  await waitFor(`document.querySelectorAll('.tile.loaded').length>=12`);
  await sleep(1200);
  await shot('01-gallery.png');

  step('viewer');
  await ev(`document.querySelector('.tile[aria-label^="ComfyUI_00001_"]').click(); true`);
  await waitFor(`!!document.querySelector('[aria-label="Media viewer"] img.hi.in')`);
  await click('[aria-label="Details"]');
  await waitFor(`document.querySelector('.details .mchips')`);
  await sleep(1200);
  await shot('02-viewer.png');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); true`);

  step('queue');
  for (const n of ['Sunset study', 'Mountain lake', 'Paper boat']) await fetch(`${DEV}/fake/enqueue?n=1&steps=2&name=${encodeURIComponent(n)}`, { method: 'POST' });
  await sleep(4500);
  await nav(`${DEV}/pocket/#/queue`);
  await ev(`location.reload(); true`).catch(() => {});
  await waitFor(`document.querySelectorAll('.rrow').length>=3`);
  await fetch(`${DEV}/fake/enqueue?n=1&steps=40&name=${encodeURIComponent('Lighthouse at dusk')}`, { method: 'POST' });
  await waitFor(`!!document.querySelector('.qcard.running .qbar-track')`);
  await sleep(9000);
  await ev(`document.querySelector('.qname').scrollIntoView({block:'start'}); true`);
  await sleep(600);
  await shot('03-queue.png');
  await fetch(`${DEV}/interrupt`, { method: 'POST' });
  await sleep(1500);

  step('generate');
  await nav(`${DEV}/pocket/#/generate`);
  await ev(`localStorage.clear(); location.reload(); true`).catch(() => {});
  await waitFor(`!!document.querySelector('.gen')`);
  await sleep(500);
  await ev(`(document.querySelector('.hero .start')||document.querySelector('.srcard .btn')).click(); true`);
  await waitFor(`document.querySelectorAll('.gsheet [role=tab]').length>0`);
  await ev(`[...document.querySelectorAll('.gsheet [role=tab]')].find((b)=>/workflows/i.test(b.textContent)).click(); true`);
  await waitFor(`document.querySelectorAll('.gsheet li.srow.wf').length>0`);
  await ev(`document.querySelector('.gsheet li.srow.wf .srow-main').click(); true`);
  await waitFor(`!!document.querySelector('.gen.has')&&!document.querySelector('.qcard.prep')&&!document.querySelector('.fgroup.sections[aria-busy="true"]')&&!document.querySelector('.gen-go').disabled`, 60000);
  await sleep(1500);
  step('all nodes');
  await click('.gentools .chip', 'all nodes');
  await waitFor(`!!document.querySelector('.gsheet[aria-label="All nodes"]')&&document.querySelectorAll('.nnode').length>0`);
  await ev(`document.querySelector('.nnode[data-node="5"] .nnode-t').click(); true`);
  await sleep(900);
  await shot('05-all-nodes.png');
  killAll();

  step('live: generate');
  // Generate (with a real Sections card) and Canvas need the real desktop frontend, so they run on the live server behind the privacy guard.
  const mk = (src, name) => { const dst = path.join(WF_DIR, name); if (fs.existsSync(dst)) throw new Error('refusing to overwrite ' + dst); process.on('exit', () => { try { fs.rmSync(dst, { force: true }); } catch {} }); fs.copyFileSync(path.join(FIXTURE_DIR, src), dst); return name; };
  const genWf = mk('group_bypass.json', 'Demo text to image.json'), file = mk('canvas_playground.json', 'Demo playground.json');
  await startChrome(); await newTab();
  await privacyGuard();
  await send('Page.navigate', { url: `${LIVE}/pocket/#/generate` });
  await waitFor(`!!document.querySelector('.gen')`, 30000);
  await sleep(500);
  await ev(`(document.querySelector('.hero .start')||document.querySelector('.srcard .btn')).click(); true`);
  await waitFor(`document.querySelectorAll('.gsheet [role=tab]').length>0`);
  await ev(`[...document.querySelectorAll('.gsheet [role=tab]')].find((b)=>/workflows/i.test(b.textContent)).click(); true`);
  await waitFor(`[...document.querySelectorAll('.gsheet li.srow.wf strong')].some((e)=>e.textContent.trim()==='Demo text to image')`);
  await ev(`[...document.querySelectorAll('.gsheet li.srow.wf')].find((r)=>r.querySelector('strong').textContent.trim()==='Demo text to image').querySelector('.srow-main').click(); true`);   // never screenshot while this list is open
  await waitFor(`!!document.querySelector('.gen.has')&&!document.querySelector('.qcard.prep')&&!document.querySelector('.fgroup.sections[aria-busy="true"]')&&!document.querySelector('.gen-go').disabled`, 60000);
  await waitFor(`!!document.querySelector('.fgroup.sections .sec-disc')`, 60000);   // live frontend loads the structure on its own
  await ev(`[...document.querySelectorAll('.fgroup.sections .sec-disc')].filter((b)=>/all groups/i.test(b.textContent)&&b.getAttribute('aria-expanded')!=='true').forEach((b)=>b.click()); true`);
  await waitFor(`document.querySelectorAll('.fgroup.sections .secrow').length>0&&!document.querySelector('.fgroup.sections[aria-busy="true"]')`, 60000);
  await sleep(1000);
  await ev(`const e=document.querySelector('.fgroup.sections');e.style.scrollMarginTop='125px';e.scrollIntoView({block:'start'}); true`);
  await sleep(600);
  await shot('04-generate.png');
  step('canvas');
  await newTab();
  await privacyGuard();
  await send('Page.navigate', { url: `${LIVE}/pocket/canvas?path=${encodeURIComponent(file)}` });
  await waitFor(`!!(window.__canvasBoot&&window.__canvasBoot.toolbarState==='installed')`, 60000);
  await waitFor(`!!(window.app&&app.canvas&&app.graph&&app.graph._nodes.length)`, 30000);
  await sleep(1500);
  await ev(`document.querySelectorAll('button[aria-label=Close]').forEach((b)=>{if(b.closest('[role=alert],[role=status]'))b.click()}); true`);
  // compact, in-memory layout of the first nodes (never saved) so the graph fills the screen at a readable zoom
  await ev(`(()=>{const c=app.canvas,g=app.graph;
    const L={1:[15,70,285,100],2:[15,215,285,170],3:[310,70,285,150],4:[310,250,285,130],5:[15,455,285,300],10:[310,455,285,82],7:[310,570,285,270],6:[15,790,200,60]};
    for(const n of g._nodes){const l=L[n.id];if(l){n.pos=[l[0],l[1]];n.size=[l[2],l[3]];}else n.pos=[6000+n.id*50,0];n.has_errors=false;}
    const gr=g._groups;if(gr[0]){gr[0].pos=[0,0];gr[0].size=[610,405];}if(gr[1]){gr[1].pos=[0,405];gr[1].size=[610,470];}
    app.lastNodeErrors=null;if(app.canvas.selected_nodes)app.canvas.deselectAll&&app.canvas.deselectAll();
    const s=0.66;c.ds.scale=s;c.ds.offset=[4/s,150/s];c.setDirty(true,true);return true})()`);
  await sleep(1200);
  await shot('06-canvas.png');
  killAll();

  step('optimise');
  for (const f of fs.readdirSync(OUT).filter((f) => /^0\d-.*\.png$/.test(f))) py([path.join(TESTS, 'make_demo_images.py'), 'optimize', path.join(OUT, f), '350']);
  py([path.join(TESTS, 'make_demo_images.py'), 'hero', path.join(OUT, 'hero.png'), ...['01-gallery.png', '04-generate.png', '06-canvas.png'].map((f) => path.join(OUT, f))]);
  step('done');
}
main().then(() => process.exit(0), (e) => { console.error('FAILED at ' + STEP + ': ' + ((e && e.stack) || e)); process.exit(1); });
