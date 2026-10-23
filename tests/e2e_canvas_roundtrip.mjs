// node tests/e2e_canvas_roundtrip.mjs
// Round trip Simple -> Canvas -> Simple on a temp copy of the synthetic fixture tests/fixtures/txt2img.json (_pocket_test_*, deleted at the end):
// Generate loads the copy, Canvas opens it in the real frontend, the KSampler (node 5) steps are changed through the widget,
// Save, "Simple mode" in the overflow menu, Generate reloads the file fresh and shows the new steps, and the queued prompt
// (POST /prompt intercepted, never reaches ComfyUI) carries them. Uses the shared harness tests/e2e_phone.mjs (Chrome port 9226).
import fs from 'node:fs';
import path from 'node:path';
import * as H from './e2e_phone.mjs';

const { check, scenario } = H;
const COPY = H.installFixture('txt2img'), NODE = '5';
const copy = path.join(H.WF_DIR, COPY);
const watchdog = setTimeout(async () => { console.error('TIMEOUT 180 s'); try { fs.rmSync(copy, { force: true }); } catch {} try { await H.stop(); } catch {} process.exit(2); }, 180000);

let ok = false;
try {
  await H.start();
  ok = await scenario('canvas round trip (steps)', async (note) => {
    await H.loadWorkflow(COPY);
    await H.openAllNodes(); await H.openNodeCard(NODE);
    const s0 = (await H.getField('Steps', { node: NODE })).value;
    await H.closeSheet();
    const NEW = String(+s0 + 5);
    check(s0 !== NEW, 'Generate shows the original steps', s0);
    // Canvas
    H.log('canvas button', await H.ev(`(()=>{const b=document.querySelector('[data-act="canvas"]');return b?'disabled='+b.disabled:'missing'})()`));
    await H.ev(`document.querySelector('[data-act="canvas"]').click(); true`);
    await H.waitFor(`!!window.__canvasBoot`, { timeout: 30000, what: 'canvas page' })
      .catch(async (e) => { H.log('state', await H.ev(`location.href`).catch((x) => String(x))); throw e; });
    const boot = await H.waitFor(`(async()=>{const B=window.__canvasBoot;await B.ready;return B.pathState==='open'?JSON.stringify({p:B.pathState,n:app.graph._nodes.length}):null})()`, { timeout: 90000, what: 'canvas workflow open' });
    check(!!boot, 'canvas mode opened the copy', boot);
    await H.sleep(1500);
    // change the steps through the widget (value + callback, what a user edit does)
    const set = await H.ev(`(()=>{const n=app.graph.getNodeById(${NODE});const w=n.widgets.find((x)=>x.name==='steps');const old=w.value;w.value=${NEW};if(w.callback)w.callback(${NEW},app.canvas,n,[0,0],null);n.graph.change&&n.graph.change();app.canvas.setDirty(true,true);return JSON.stringify({old,now:w.value})})()`);
    check(JSON.parse(set).now === +NEW, 'steps widget changed in canvas', set);
    await H.sleep(800);
    // Save
    await H.ev(`document.querySelector('.cvt-bar [data-act="save"], [data-act="save"]').click(); true`);
    const diskSteps = () => { try { return JSON.parse(fs.readFileSync(copy, 'utf8')).nodes.find((n) => String(n.id) === NODE).widgets_values[2]; } catch { return null; } };
    let saved = false;
    for (let i = 0; i < 80 && !saved; i++) { await H.sleep(500); saved = diskSteps() === +NEW; }
    check(saved, 'Save wrote the new steps to the file', { onDisk: diskSteps(), want: +NEW });
    // Simple
    await H.ev(`document.querySelector('[data-act="more"]').click(); true`);
    await H.sleep(300);
    await H.ev(`document.querySelector('.cvt-menu [data-act="simple"]').click(); true`);
    await H.waitFor(`location.pathname==='/pocket/'||location.pathname==='/pocket'`, { timeout: 30000, what: 'back in the Pocket app' });
    await H.waitFor(`!!document.querySelector('.tabs')&&!!window.__e2e`, { timeout: 30000, what: 'app shell' });
    await H.settle(120000);
    await H.openAllNodes(); await H.openNodeCard(NODE);
    const s1 = (await H.getField('Steps', { node: NODE })).value;
    await H.closeSheet();
    check(s1 === NEW, 'Generate shows the new steps after a fresh load', { before: s0, after: s1, want: NEW });
    const q = await H.queueRun({ intercept: true });
    check(q.prompt && q.prompt[NODE] && q.prompt[NODE].inputs.steps === +NEW, 'queued prompt carries the new steps', q.prompt && q.prompt[NODE] && q.prompt[NODE].inputs);
    note(`steps ${s0} -> ${NEW}`);
  });
} catch (e) { console.error('ERROR', e); }
finally {
  try { await H.stop(); } catch {}
  fs.rmSync(copy, { force: true });
  clearTimeout(watchdog);
}
console.log(ok ? 'round trip: PASS' : 'round trip: FAIL');
process.exit(ok ? 0 : 1);
