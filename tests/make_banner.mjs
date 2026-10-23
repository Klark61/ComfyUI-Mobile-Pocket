// Builds docs/screenshots/banner.png (1280x640) from the existing README screenshots (demo content only).
//   node tests/make_banner.mjs     (env PYTHON = python with Pillow; default "python")
// Flat charcoal HTML rendered in headless Chrome over CDP at 2x, then downscaled/optimised by Pillow.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_DIR, chromePath } from './env.mjs';

const PY = process.env.PYTHON || 'python';
const CDP = 9232;
const SH = path.join(REPO_DIR, 'docs', 'screenshots');
const OUT = path.join(SH, 'banner.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (f) => 'data:image/png;base64,' + fs.readFileSync(path.join(SH, f)).toString('base64');

const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1280px;height:640px;background:#131313;overflow:hidden;
  font-family:Inter,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif;color:#ededed;-webkit-font-smoothing:antialiased}
.txt{position:absolute;left:64px;top:0;bottom:0;width:410px;display:flex;flex-direction:column;justify-content:center}
.lab{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#b89968;font-weight:600;margin-bottom:22px}
h1{font-size:60px;line-height:1.02;letter-spacing:-.035em;font-weight:650}
h1 span{display:block;color:#8d8d8d}
.rule{width:44px;height:2px;background:#b89968;margin:30px 0 22px}
p{font-size:21px;color:#9a9a9a;letter-spacing:-.01em}
.ph{position:absolute;top:64px;width:230px;height:512px;border-radius:26px;border:1px solid #2e2e2e;overflow:hidden;background:#0b0b0d}
.ph img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
</style>
<div class="txt"><div class="lab">Open source</div><h1>ComfyUI<span>Pocket</span></h1><div class="rule"></div><p>ComfyUI on your phone.</p></div>
<div class="ph" style="left:498px"><img src="${uri('01-gallery.png')}"></div>
<div class="ph" style="left:746px"><img src="${uri('04-generate.png')}"></div>
<div class="ph" style="left:994px"><img src="${uri('06-canvas.png')}"></div>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'banner-'));
const page = path.join(tmp, 'banner.html'); fs.writeFileSync(page, html);
const chrome = spawn(chromePath(), [`--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'p')}`, '--headless=new', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} try { chrome.kill(); } catch {} for (let i = 0; i < 5; i++) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']); } } };
process.on('exit', cleanup);
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
try {
  for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${CDP}/json/version`); break; } catch { await sleep(250); } }
  const tab = await (await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: pathToFileURL(page).href });
  await sleep(1500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const raw = path.join(tmp, 'banner@2x.png'); fs.writeFileSync(raw, Buffer.from(r.data, 'base64'));
  const code = `import sys,os\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB').resize((1280,640),Image.LANCZOS)\nim.save(sys.argv[2],optimize=True)\nif os.path.getsize(sys.argv[2])>600*1024: im.quantize(256,method=Image.Quantize.MEDIANCUT,dither=Image.Dither.FLOYDSTEINBERG).save(sys.argv[2],optimize=True)\n`;
  const p = spawnSync(PY, ['-c', code, raw, OUT], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(p.stderr);
  console.error('wrote', OUT, Math.round(fs.statSync(OUT).size / 1024) + ' KB');
} catch (e) { console.error(e); process.exitCode = 1; }
process.exit(process.exitCode || 0);
