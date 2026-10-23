// node tests/e2e_scenarios.mjs [a b c d e f g] [--wf <file in WF_DIR>]   (default: the intercepted ones a c d e f g; the real GPU run b only when named)
// End-to-end pass with the shared harness (tests/e2e_phone.mjs) over the synthetic fixtures in tests/fixtures (core ComfyUI nodes only), installed into
// WF_DIR as temp copies and removed on exit. Full log: tests/e2e-last.log.
// Scenario b is a real GPU run: it takes your own workflow from --wf (or env E2E_WF); without it it runs the txt2img fixture, which needs a checkpoint
// named example_checkpoint.safetensors (so it will fail validation on a machine that does not have one).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import * as H from './e2e_phone.mjs';

const { check, scenario } = H;
const IDEA = 'a red bicycle leaning against a brick wall on a quiet street, early morning';
const argv = process.argv.slice(2);
const wfIdx = argv.indexOf('--wf');
const userWf = (wfIdx >= 0 ? argv[wfIdx + 1] : null) || process.env.E2E_WF || null;
const FX = { txt2img: H.installFixture('txt2img'), group: H.installFixture('group_bypass'), 'switch': H.installFixture('switch'), load: H.installFixture('load_image'), api: H.installFixture('txt2img_api') };
const REAL_WF = userWf || FX.txt2img, REAL_WF_NAME = userWf || 'the txt2img fixture';
if (!userWf) console.error('note: scenario b uses the synthetic txt2img fixture; pass --wf <file in ' + H.WF_DIR + '> (or env E2E_WF) to run your own workflow on the GPU');
const letters = argv.filter((a, i) => !a.startsWith('--') && (wfIdx < 0 || i !== wfIdx + 1));
const want = new Set(letters.length ? letters : ['a', 'c', 'd', 'e', 'f', 'g']);
const classes = (p) => Object.values(p || {}).map((n) => n.class_type);
const idsOf = (p, cls) => Object.entries(p || {}).filter(([, n]) => n.class_type === cls).map(([k]) => k);
const galleryHas = async (name) => ((await H.api('/pocket/api/outputs?limit=12')).body.items || []).some((i) => i.name === name);
const galleryTotal = async () => (await H.api('/pocket/api/outputs?limit=1')).body.total;

async function realRun(label, { cap = 600000 } = {}) {
  const gal0 = await galleryTotal();
  const r = await H.queueRun({ intercept: false });
  H.check(r.status === 200 && !!r.promptId, `${label}: POST /prompt accepted`, r.error || r.resp);
  H.check(!r.resp || !Object.keys(r.resp.node_errors || {}).length, `${label}: no node_errors at validation`, r.resp && r.resp.node_errors);
  const run = await H.waitForRun(r.promptId, { timeout: cap, t0: r.t0 });
  H.check(run.ok && run.status === 'success', `${label}: history status success, no node errors`, run.error || run.status);
  const imgs = run.outputs.filter((o) => o.type === 'output');
  H.check(imgs.length >= 1, `${label}: output image(s) in history`, run.outputs);
  H.log(`${label}: wall ${run.secs.toFixed(0)}s, exec ${run.execSecs}s`);
  await H.sleep(1500);
  const last = imgs[imgs.length - 1];
  H.check(!!last && await galleryHas(last.filename), `${label}: new image listed in the gallery`, last && last.filename);
  H.check((await galleryTotal()) > gal0, `${label}: gallery total grew`);
  return { r, run, secs: run.secs };
}

/**
 * Real POST /prompt validation, cancelled at once. A saved workflow can name model files this machine no longer has (value_not_in_list);
 * that is the workflow's own problem (the desktop refuses it too). Like a user would, pick an installed option in All nodes and validate again,
 * so the rest of the prompt is still proven valid. Returns {q, swapped:[...], errors:[...non-model errors]}.
 */
async function validateFixing(label) {
  const swapped = [];
  for (let i = 0; i < 8; i++) {
    const q = await H.queueRun({ intercept: 'validate' });
    const ne = (q.resp && q.resp.node_errors) || {};
    const errs = Object.entries(ne).flatMap(([id, n]) => n.errors.map((e) => ({ id, cls: n.class_type, type: e.type, details: e.details || e.message })));
    if (q.status === 200 && !errs.length) return { q, swapped, errors: [] };
    const missing = errs.filter((e) => e.type === 'value_not_in_list');
    if (!missing.length || missing.length !== errs.length) return { q, swapped, errors: errs };
    await H.openAllNodes();
    for (const e of missing) {
      const m = /^(\w+): '(.*?)' not in \[(.*)\]$/s.exec(e.details);
      const first = m && /'([^']+)'/.exec(m[3]);
      if (!first) return { q, swapped, errors: errs };
      await H.openNodeCard(e.id);
      await H.setField('', first[1], { node: e.id, input: m[1] });
      swapped.push(`${e.id}.${m[1]}: ${m[2]} -> ${first[1]}`);
    }
    await H.closeSheet();
  }
  return { q: null, swapped, errors: [{ type: 'loop', details: 'too many rounds' }] };
}
const validOk = (label, v) => {
  // a model file the workflow names but this machine lacks (value_not_in_list, nothing to swap in) is not a Pocket problem
  v.missing = v.errors.length > 0 && v.errors.every((e) => e.type === 'value_not_in_list');
  check(v.missing || (!!v.q && v.q.status === 200 && !!v.q.promptId && !v.errors.length), `${label}: POST /prompt validates (cancelled at once)`, v.errors.length ? v.errors : (v.q && v.q.error));
  if (v.swapped.length) H.log(`${label}: workflow names missing model files; swapped in the UI to validate:`, v.swapped);
};

try {
  await H.start();

  // ---------------------------------------------------------------- a. switch fixture, intercepted
  if (want.has('a')) await scenario('a. Switch fixture intercepted (Enhance prompt? toggle reaches the prompt)', async () => {
    await H.loadWorkflow(FX.switch);
    const sw0 = await H.getField('Enhance prompt?');
    check(sw0.value === false, 'switch is OFF by default', sw0);
    let q = await H.queueRun({ intercept: true });
    check(q.prompt['12'] && q.prompt['12'].inputs.value === false, 'queued prompt has the boolean false', q.prompt['12'] && q.prompt['12'].inputs);
    check(idsOf(q.prompt, 'ComfySwitchNode').join() === '15', 'the switch node is in the prompt', classes(q.prompt));
    check(await H.toggleSwitch('Enhance prompt?') === true, 'switch is now ON');
    q = await H.queueRun({ intercept: true });
    check(q.prompt['12'] && q.prompt['12'].inputs.value === true, 'queued prompt has the boolean true', q.prompt['12'] && q.prompt['12'].inputs);
    await H.setField('Positive prompt', IDEA, { node: '13' });
    q = await H.queueRun({ intercept: true });
    check(q.prompt['13'].inputs.value === IDEA, 'queued prompt carries the edited idea', q.prompt['13'] && q.prompt['13'].inputs);
  });

  // ---------------------------------------------------------------- b. real GPU run (opt-in, needs models)
  if (want.has('b')) await scenario(`b. real run of ${REAL_WF_NAME}`, async (note) => {
    await H.loadWorkflow(REAL_WF);
    const { secs } = await realRun('b');
    note(`real ${secs.toFixed(0)}s`);
  });

  // ---------------------------------------------------------------- c. group + muted nodes, intercepted
  if (want.has('c')) await scenario('c. Group fixture intercepted (group on/off, edits survive, All nodes steps)', async () => {
    await H.loadWorkflow(FX.group);
    const modesOf = (body) => Object.fromEntries(body.extra_data.extra_pnginfo.workflow.nodes.map((n) => [String(n.id), n.mode]));
    let q = await H.queueRun({ intercept: true });
    check(!idsOf(q.prompt, 'ImageScaleBy').length, 'baseline: no ImageScaleBy', idsOf(q.prompt, 'ImageScaleBy'));
    let m = modesOf(q.body);
    check(m['8'] === 2 && m['10'] === 2, 'fixture: the Upscale nodes are muted (2) at load', [m['8'], m['10']]);
    let t = await H.toggleGroup('Upscale');
    check(t.before === false && t.after === true, 'Upscale toggled on', t);
    q = await H.queueRun({ intercept: true });
    m = modesOf(q.body);
    check(m['8'] === 0 && m['10'] === 0, 'Upscale nodes active (mode 0) when on', [m['8'], m['10']]);
    check(idsOf(q.prompt, 'ImageScaleBy').join() === '8' && idsOf(q.prompt, 'PreviewImage').join() === '10', 'prompt has ImageScaleBy 8 and PreviewImage 10 with the group on', classes(q.prompt));
    t = await H.toggleGroup('Upscale');
    check(t.after === false, 'Upscale toggled off', t);
    q = await H.queueRun({ intercept: true });
    m = modesOf(q.body);
    // a plain group (no Fast Groups Muter controller) switches off by bypassing (4); only the group's nodes and the already bypassed node 9 are 4
    check(m['8'] === 4 && m['10'] === 4, 'off again -> mode 4 (a plain group bypasses)', [m['8'], m['10']]);
    check(Object.entries(m).filter(([, md]) => md === 4).map(([id]) => id).sort().join() === '10,8,9', 'nothing else got bypassed', Object.entries(m).filter(([, md]) => md === 4));
    check(!idsOf(q.prompt, 'ImageScaleBy').length, 'ImageScaleBy gone with the group off');
    // an edit survives a group toggle (re-convert) in both directions
    const EDIT = 'EDIT-SURVIVES: a lighthouse at dusk';
    await H.setField('Positive prompt', EDIT, { node: '2' });
    await H.toggleGroup('Upscale');
    check((await H.getField('Positive prompt', { node: '2' })).value === EDIT, 'edited prompt still shown after toggling on');
    q = await H.queueRun({ intercept: true });
    check(q.prompt['2'].inputs.text === EDIT, 'queued prompt carries the edited text', q.prompt['2'] && q.prompt['2'].inputs);
    check(idsOf(q.prompt, 'ImageScaleBy').length === 1, 'ImageScaleBy present again');
    await H.toggleGroup('Upscale');
    check((await H.getField('Positive prompt', { node: '2' })).value === EDIT, 'edited prompt still shown after toggling off');
    // steps in All nodes
    await H.openAllNodes();
    await H.openNodeCard('5');
    await H.setField('Steps', 21, { node: '5' });
    check((await H.getField('Steps', { node: '5' })).value === '21', 'All nodes shows steps 21');
    await H.closeSheet();
    q = await H.queueRun({ intercept: true });
    check(q.prompt['5'].inputs.steps === 21, 'queued prompt carries steps=21', q.prompt['5'] && q.prompt['5'].inputs);
    check(q.prompt['2'].inputs.text === EDIT, 'edited prompt still in the prompt');
  });

  // ---------------------------------------------------------------- d. bypassed node enabled from All nodes
  if (want.has('d')) await scenario('d. Group fixture: enable a bypassed node from All nodes', async () => {
    await H.loadWorkflow(FX.group);
    let q = await H.queueRun({ intercept: true });
    check(!idsOf(q.prompt, 'ImageInvert').length, 'default prompt has no ImageInvert (node 9 bypassed)', idsOf(q.prompt, 'ImageInvert'));
    await H.openAllNodes();
    check(await H.hasNodeCard('9'), 'All nodes lists the bypassed node 9', await H.nodeCards());
    await H.toggleNode('9', true);
    await H.closeSheet();
    q = await H.queueRun({ intercept: true });
    check(idsOf(q.prompt, 'ImageInvert').join() === '9', 'intercepted prompt contains ImageInvert 9', idsOf(q.prompt, 'ImageInvert'));
    check(JSON.stringify(q.prompt).includes('["9"'), 'ImageInvert 9 is wired into the graph (referenced as a link)');
  });

  // ---------------------------------------------------------------- e. LoadImage fixture: upload
  if (want.has('e')) await scenario('e. LoadImage fixture (upload reaches the prompt)', async () => {
    const png = path.join(os.tmpdir(), `e2e_gradient_${Date.now()}.png`);
    const py = spawnSync('python', ['-I', '-c', `
import zlib, struct, sys
w, h = 64, 96
rows = b''.join(b'\\x00' + bytes(v for x in range(w) for v in (int(90 + 80 * x / w), int(90 + 80 * y / h), 150)) for y in range(h))
def chunk(t, d): c = struct.pack('>I', len(d)) + t + d; return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
`, png]);
    check(py.status === 0 && fs.existsSync(png), 'gradient PNG generated with python', String(py.stderr));
    try {
      await H.loadWorkflow(FX.load);
      const labels = await H.ev(`[...document.querySelectorAll('input[type=file]')].map((i)=>i.getAttribute('aria-label').replace(/^Upload /,''))`);
      check(labels.length >= 1, 'Image field with upload present', labels);
      const vals = await H.uploadImage(labels[0], png);
      H.log('image field values', vals);
      const uploaded = vals.find((v) => v.includes('e2e_gradient'));
      check(!!uploaded, 'Image field shows the uploaded file', vals);
      const q = await H.queueRun({ intercept: true });
      const loads = Object.values(q.prompt).filter((n) => n.class_type === 'LoadImage').map((n) => n.inputs.image);
      check(loads.some((v) => v === uploaded), 'intercepted prompt carries the uploaded filename', { uploaded, loads });
      check(fs.existsSync(path.join(H.INPUT_DIR, uploaded)), 'uploaded file exists in ComfyUI input');
    } finally {
      for (const f of fs.readdirSync(H.INPUT_DIR)) if (f.startsWith('e2e_gradient_')) fs.rmSync(path.join(H.INPUT_DIR, f), { force: true });
      fs.rmSync(png, { force: true });
      check(!fs.readdirSync(H.INPUT_DIR).some((f) => f.startsWith('e2e_gradient_')), 'test uploads removed from ComfyUI input');
    }
  });

  // ---------------------------------------------------------------- f. validation only
  if (want.has('f')) await scenario('f. txt2img fixture (intercept + validate)', async (note) => {
    await H.loadWorkflow(FX.txt2img);
    const q = await H.queueRun({ intercept: true });
    check(!!q.prompt && Object.keys(q.prompt).length === 7, 'intercepted prompt has the 7 nodes', Object.keys(q.prompt || {}).length);
    const v = await validateFixing('f'); validOk('f', v);
    note(v.swapped.length ? `${v.swapped.length} missing model file(s) swapped to validate` : (v.missing ? 'model files missing here (expected for the synthetic fixture)' : ''));
    check(!(await H.queueState()).running.length && !(await H.queueState()).pending.length, 'queue empty after cancel');
  });

  // ---------------------------------------------------------------- g. API-format workflow
  if (want.has('g')) await scenario('g. API-format fixture', async (note) => {
    await H.loadWorkflow(FX.api);
    check(await H.ev(`!document.querySelector(${JSON.stringify(H.SEL.sections)})`), 'API file: no Sections card (nothing to convert)');
    const file = JSON.parse(fs.readFileSync(path.join(H.WF_DIR, FX.api), 'utf8'));
    const q = await H.queueRun({ intercept: true });
    check(Object.keys(q.prompt).length === Object.keys(file).length, 'intercepted prompt has all API nodes', [Object.keys(q.prompt).length, Object.keys(file).length]);
    const v = await validateFixing('g'); validOk('g', v); note(v.swapped.length ? `${v.swapped.length} missing model file(s) swapped to validate` : '');
    check(!(await H.queueState()).running.length && !(await H.queueState()).pending.length, 'queue empty after cancel');
  });
} catch (e) {
  console.log('HARNESS ERROR ' + ((e && e.stack) || e));
  H.log('HARNESS ERROR', String((e && e.stack) || e));
} finally {
  const errs = H.consoleErrors();
  H.log('console errors', errs);
  const byText = new Map();
  for (const e of errs) { const k = `[${e.src}] ${e.kind}: ${e.text.slice(0, 160)}`; byText.set(k, (byText.get(k) || 0) + 1); }
  console.log(`console errors: ${errs.length} (${errs.filter((e) => e.src === 'phone').length} from the phone app)`);
  for (const [k, n] of byText) console.log(`  x${n} ${k}`);
  await H.stop();
}
process.exit(H.failed() ? 1 : 0);
