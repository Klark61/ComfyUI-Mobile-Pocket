// node tests/check_nodes_live.mjs  -- plan #6 "done when", against the live ComfyUI (127.0.0.1:8188, not restarted).
// Converts the synthetic fixtures (tests/fixtures, installed as temp copies) and, with --user, also the 10 newest saved workflows through the real converter in a headless Chrome (CDP, port 9225, temp profile) and asserts:
//   - editable inputs in the All-nodes model == literal inputs of the converted prompt (with and without the converter structure)
//   - no card that owns API nodes with literal inputs shows zero inputs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WF_DIR as DIR, chromePath, installFixture } from './env.mjs';

const PORT = 9225;
const BASE = process.env.COMFY || 'http://127.0.0.1:8188';
const CHROME = chromePath();

const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + '/') : e.name.endsWith('.json') ? [{ rel: rel + e.name, mtime: fs.statSync(path.join(d, e.name)).mtimeMs }] : []);
const newest = process.argv.includes('--user') ? walk(DIR).sort((a, b) => b.mtime - a.mtime).slice(0, 10) : [];
const fixtureNames = ['txt2img', 'group_bypass', 'switch', 'load_image'].map(installFixture);
for (const f of fixtureNames) newest.push({ rel: f, mtime: 0 });
// two special files are always checked: an API-format file (used directly as the prompt) and a malformed one (a clear error, no "empty prompt")
const API_FILE = installFixture('txt2img_api');
const MALFORMED_FILE = installFixture('malformed');
for (const f of [API_FILE, MALFORMED_FILE]) if (fs.existsSync(path.join(DIR, f)) && !newest.some((x) => x.rel === f)) newest.push({ rel: f, mtime: 0 });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nodes-live-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 1;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/pocket/#/generate` });
  await sleep(2500);
  const expr = `(async()=>{
    const F=await import('/pocket/static/fields.js'), M=await import('/pocket/static/nodes-model.js'), C=await import('/pocket/static/converter.js'), S=await import('/pocket/static/sections-model.js');
    const files=${JSON.stringify(newest.map((f) => f.rel))};
    const out=[];
    for(const rel of files){
      try{
        const listed=(await (await fetch('/pocket/api/workflows')).json()).workflows;
        const w=listed.find((x)=>x.path===rel||x.path.split(String.fromCharCode(92)).join('/')===rel||x.path.endsWith('/'+rel))||{path:rel,name:rel};
        const ui=await (await fetch('/pocket/api/workflows/file?path='+encodeURIComponent(w.path))).json();
        const api=S.isApiFormat(ui);
        const {prompt,structure}=api?{prompt:ui,structure:null}:await C.convertWorkflowFull(ui,w.path,{});
        await F.ensureInfo(Object.values(prompt).map((n)=>n.class_type));
        let lit=0; for(const n of Object.values(prompt)) for(const v of Object.values(n.inputs||{})) if(!F.isLink(v)) lit++;
        const r={w:rel,api,nodes:Object.keys(prompt).length,lit,modes:[]};
        for(const st of [structure,null]){
          let ed=0; const empty=[];
          for(const s of M.nodeSections(prompt,st,{})) for(const n of s.nodes){
            ed+=n.fields.length;
            const own=n.apiIds.reduce((a,id)=>a+Object.values(prompt[id].inputs||{}).filter((v)=>!F.isLink(v)).length,0);
            if(own>0&&!n.fields.length) empty.push(n.key);
          }
          r.modes.push({structure:!!st,editable:ed,emptyCards:empty});
        }
        out.push(r);
      }catch(e){out.push({w:rel,err:String(e&&e.message||e).slice(0,200)});}
    }
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  const res = JSON.parse(r.result.result.value);
  let bad = 0;
  for (const x of res) {
    if (x.w === MALFORMED_FILE) {
      const ok = !!x.err && /Malformed workflow file/.test(x.err);
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${x.w} [malformed] ${x.err || 'converted?!'}`);
      continue;
    }
    if (x.err) { bad++; console.log(`FAIL ${x.w}: ${x.err}`); continue; }
    if (x.w === API_FILE && (!x.api || !x.nodes)) { bad++; console.log(`FAIL ${x.w}: not used directly as an API prompt`); continue; }
    for (const m of x.modes) {
      const ok = m.editable === x.lit && !m.emptyCards.length;
      if (!ok) bad++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${x.w} [${x.api ? 'api' : m.structure ? 'structure' : 'flat'}] nodes=${x.nodes} literal=${x.lit} editable=${m.editable}${m.emptyCards.length ? ' empty cards: ' + m.emptyCards.join(',') : ''}`);
    }
  }
  console.log(bad ? `${bad} problem(s)` : `all ${res.length} workflows ok`);
  code = bad || !res.length ? 1 : 0;
} catch (e) { console.log('ERROR ' + (e && e.message || e)); } finally {
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(code);
