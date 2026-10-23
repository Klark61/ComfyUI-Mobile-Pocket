// Unit tests for web/pocket/fields.js (pure logic). Run: node tests/test_fields.mjs
import assert from 'node:assert/strict';
import { detect, promptRoles, listInputs, setInput, reseed, specOf, ensureInfo, applyAspect, numberCfg, isLink, loraOptions, infoKnown, randomSeed, fixSeeds, classesToFetch, seedFields, seedDefaults } from '../web/pocket/fields.js';

const P = {
  '1': { class_type: 'CheckpointLoaderSimple', _meta: { title: 'Load Checkpoint' }, inputs: { ckpt_name: 'a.safetensors' } },
  '3': { class_type: 'CLIPTextEncode', _meta: { title: 'Neg' }, inputs: { text: 'ugly', clip: ['1', 1] } },
  '2': { class_type: 'CLIPTextEncode', _meta: { title: 'Pos' }, inputs: { text: 'a cat', clip: ['1', 1] } },
  '9': { class_type: 'FluxGuidance', _meta: { title: 'Guidance' }, inputs: { conditioning: ['2', 0], guidance: 3.5 } },
  '4': { class_type: 'EmptyLatentImage', _meta: { title: 'Latent' }, inputs: { width: 1024, height: 768, batch_size: 2 } },
  '5': { class_type: 'KSampler', _meta: { title: 'KSampler' }, inputs: { seed: 5, steps: 20, cfg: 4.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['1', 0], positive: ['9', 0], negative: ['3', 0], latent_image: ['4', 0] } },
  '7': { class_type: 'SaveImage', _meta: { title: 'Save' }, inputs: { filename_prefix: 'out', images: ['5', 0] } },
  '8': { class_type: 'Power Lora Loader (rgthree)', _meta: { title: 'LoRAs' }, inputs: { PowerLoraLoaderHeaderWidget: { type: 'x' }, lora_1: { on: true, lora: 'x.safetensors', strength: 0.8 }, model: ['1', 0] } },
};

// links are never fields; roles traced through FluxGuidance
assert.ok(isLink(['1', 0]) && !isLink([1, 2, 3]) && !isLink('x'));
const roles = promptRoles(P);
assert.equal(roles.get('2:text'), 'positive');
assert.equal(roles.get('3:text'), 'negative');

const groups = detect(P, []);
const ids = groups.map((g) => g.id);
assert.deepEqual(ids, ['prompt', 'seed', 'sampling', 'size', 'model', 'batch']);
const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
assert.deepEqual(byId.prompt.fields.map((f) => f.key), ['2:text', '3:text'], 'positive before negative although id 3 < ... sorted by role');
assert.equal(byId.prompt.fields[0].label, 'Positive prompt');
assert.deepEqual(byId.seed.fields.map((f) => f.key), ['5:seed']);
assert.deepEqual(byId.sampling.fields.map((f) => f.input), ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'guidance'], 'grouped by node id (sampler 5, then FluxGuidance 9)');
assert.equal(byId.size.fields[0].kind, 'size');
assert.deepEqual(byId.size.fields[0].value, { w: 1024, h: 768 });
assert.deepEqual(byId.model.fields.map((f) => f.kind), ['combo', 'lora'], 'checkpoint combo placeholder + rgthree dict as lora group');
assert.deepEqual(byId.batch.fields.map((f) => f.key), ['4:batch_size']);
assert.ok(!groups.some((g) => g.fields.some((f) => f.input === 'filename_prefix')), 'prefix is not auto-shown');

// pins
const pinned = detect(P, [{ node: '7', input: 'filename_prefix' }, { node: '5', input: 'steps' }, { node: '99', input: 'nope' }]);
const pg = pinned.find((g) => g.id === 'pinned');
assert.deepEqual(pg.fields.map((f) => f.key), ['7:filename_prefix'], 'already-shown and missing pins are skipped');

// add-field listing excludes links, keeps dict loras
const all = listInputs(P);
const n8 = all.find((n) => n.node === '8');
assert.deepEqual(n8.items.map((i) => i.input), ['lora_1']);
assert.ok(all.find((n) => n.node === '5').items.every((i) => !['model', 'positive'].includes(i.input)));

// immutability + reseed
const P2 = setInput(P, '2', 'text', 'dog');
assert.equal(P['2'].inputs.text, 'a cat');
assert.equal(P2['2'].inputs.text, 'dog');
const P3 = reseed(P, groups, {});
assert.notEqual(P3['5'].inputs.seed, 5);
assert.equal(reseed(P, groups, { '5:seed': false })['5'].inputs.seed, 5, 'randomize off keeps the seed');

// object_info: both combo formats + numeric cfg (fetch stubbed)
const info = {
  KSampler: { input: { required: { steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 100, step: 0.1 }], sampler_name: [['euler', 'ddim']] } } },
  LoraLoader: { input: { required: { lora_name: ['COMBO', { options: ['l1', 'l2'] }] } } },
};
globalThis.fetch = async (url) => {
  const cls = decodeURIComponent(String(url).split('/object_info/')[1]);
  return { ok: true, status: 200, json: async () => (info[cls] ? { [cls]: info[cls] } : {}) };
};
assert.equal(await ensureInfo(['KSampler', 'LoraLoader', 'Missing']), true);
assert.deepEqual(specOf('KSampler', 'sampler_name').options, ['euler', 'ddim']);
assert.deepEqual(specOf('LoraLoader', 'lora_name').options, ['l1', 'l2']);
assert.deepEqual(loraOptions(), ['l1', 'l2']);
assert.equal(specOf('Missing', 'x'), null);
const g2 = detect(P, []);
const cfg = g2.find((g) => g.id === 'sampling').fields.find((f) => f.input === 'cfg');
const nc = numberCfg(cfg);
assert.equal(nc.step, 0.1);
assert.equal(nc.max, 100);
assert.equal(g2.find((g) => g.id === 'sampling').fields.find((f) => f.input === 'sampler_name').spec.options.length, 2);

// seeds: out-of-range values are replaced, random seeds stay in range
for (let i = 0; i < 200; i++) assert.ok(randomSeed(1000) <= 1000 && randomSeed() <= 2 ** 50 && randomSeed(2 ** 64) <= 2 ** 50);
const SP = { '5': { class_type: 'KSampler', inputs: { seed: 18446744073709552000, steps: 20 } }, '6': { class_type: 'KSampler', inputs: { seed: 7 } } };
const sg = detect(SP, []);
const SF = fixSeeds(SP, sg);
assert.ok(SF['5'].inputs.seed <= Number.MAX_SAFE_INTEGER, 'unsafe seed replaced');
assert.equal(SF['6'].inputs.seed, 7, 'safe seed kept');
assert.equal(SP['5'].inputs.seed, 18446744073709552000, 'input not mutated');
const spm = { '5': { class_type: 'KSampler', inputs: { seed: 5000 } } };
const sg2 = detect(spm, []);
sg2[0].fields[0].spec = { max: 100 };
assert.ok(fixSeeds(spm, sg2)['5'].inputs.seed <= 100, 'seed above spec.max replaced');
assert.ok(reseed(spm, sg2, {})['5'].inputs.seed <= 100, 'reseed respects spec.max');

// every class with a string literal is fetched (so an empty multiline primitive can be recognised)
const PS = { '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: '' } }, '2': { class_type: 'VAEDecode', inputs: { samples: ['1', 0] } } };
assert.deepEqual(classesToFetch(detect(PS, []), [], PS), ['PrimitiveStringMultiline']);

// text-link following through a switch (both branches), generic names, ranking
const W = {
  '4': { class_type: 'CLIPTextEncode', _meta: { title: 'Positive' }, inputs: { text: ['113', 0], clip: ['22', 0] } },
  '5': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative' }, inputs: { text: 'bad', clip: ['22', 0] } },
  '22': { class_type: 'CLIPLoader', inputs: { clip_name: 'q.safetensors', type: 'x', device: 'default' } },
  '110': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'Your idea' }, inputs: { value: '' } },
  '111': { class_type: 'PrimitiveStringMultiline', _meta: { title: 'Writer instructions' }, inputs: { value: 'You write captions.' } },
  '112': { class_type: 'TextGenerate', inputs: { prompt: ['110', 0], clip: ['22', 0], system_prompt: ['111', 0] } },
  '113': { class_type: 'ComfySwitchNode', inputs: { switch: false, on_false: ['110', 0], on_true: ['112', 0] } },
  '16': { class_type: 'SamplerCustom', inputs: { positive: ['4', 0], negative: ['5', 0], cfg: 4 } },
  '117': { class_type: 'Note', _meta: { title: 'Free' }, inputs: { string: 'a free text note that has no role at all' } },
};
info.PrimitiveStringMultiline = { input: { required: { value: ['STRING', { multiline: true }] } } };
info.Note = { input: { required: { string: ['STRING', { multiline: true }] } } };
await ensureInfo(classesToFetch(detect(W, []), [], W));
assert.ok(infoKnown('PrimitiveStringMultiline') && infoKnown('Note'));
const wr = promptRoles(W);
assert.equal(wr.get('110:value'), 'positive');
assert.equal(wr.get('5:text'), 'negative');
assert.ok(!wr.has('111:value') && !wr.has('22:device'), 'instructions and clip loader are not prompts');
const wp = detect(W, []).find((g) => g.id === 'prompt').fields;
assert.deepEqual(wp.map((f) => f.key), ['110:value', '111:value', '117:string', '5:text'], 'positive, unknown, negative');
assert.equal(wp[1].label, 'Writer instructions', 'generic input name -> node title');
assert.equal(wp[2].label, 'Free');

// pass-through nodes with both positive/negative outputs keep the roles apart (ids deliberately out of order)
const CN = {
  '3': { class_type: 'KSampler', inputs: { positive: ['9', 0], negative: ['9', 1], seed: 1 } },
  '9': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['4', 0], negative: ['5', 0], control_net: ['8', 0], image: ['7', 0] } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry' } },
  '8': { class_type: 'ControlNetLoader', inputs: { control_net_name: 'c.safetensors' } },
  '7': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
};
const cr = promptRoles(CN);
assert.equal(cr.get('4:text'), 'positive');
assert.equal(cr.get('5:text'), 'negative');

// image/mask branches are not prompt paths: a literal prompt on a segmenter is not the Positive prompt
const GD = {
  '3': { class_type: 'KSampler', inputs: { positive: ['4', 0], negative: ['5', 0], seed: 1 } },
  '4': { class_type: 'ConditioningSetMask', inputs: { mask: ['12', 0], conditioning: ['6', 0] } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'real prompt', clip: ['22', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'bad', clip: ['22', 0] } },
  '12': { class_type: 'GroundingDinoSAMSegment', inputs: { prompt: 'person', image: ['10', 0] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
  '22': { class_type: 'CLIPLoader', inputs: { clip_name: 'q.safetensors' } },
};
const gr = promptRoles(GD);
assert.ok(!gr.has('12:prompt'), 'mask/image branch must not yield a prompt');
assert.equal(gr.get('6:text'), 'positive');

// Flux-style encoder fed by a primitive through clip_l / t5xxl
const FX = {
  '3': { class_type: 'KSampler', inputs: { positive: ['4', 0], seed: 1 } },
  '4': { class_type: 'CLIPTextEncodeFlux', inputs: { clip_l: ['30', 0], t5xxl: ['31', 0], guidance: 3.5, clip: ['22', 0] } },
  '30': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'short' } },
  '31': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'long prompt' } },
  '22': { class_type: 'CLIPLoader', inputs: { clip_name: 'q.safetensors' } },
};
const fr = promptRoles(FX);
assert.equal(fr.get('30:value'), 'positive');
assert.equal(fr.get('31:value'), 'positive');
// a node reached first without text, then through a text link, is still traced
const SN = {
  '3': { class_type: 'KSampler', inputs: { positive: ['4', 0], seed: 1 } },
  '4': { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['5', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: ['6', 0] } },
  '6': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'hi' } },
};
assert.equal(promptRoles(SN).get('6:value'), 'positive');

// switches group (first) + LoRA stacks
const SW = {
  '113': { class_type: 'ComfySwitchNode', _meta: { title: 'Enhance prompt? (switch ON = use writer)' }, inputs: { switch: false, on_false: ['110', 0], on_true: ['112', 0] } },
  '120': { class_type: 'PrimitiveBoolean', _meta: { title: 'Upscale' }, inputs: { value: true } },
  '121': { class_type: 'ImpactSwitch', _meta: { title: 'Pick' }, inputs: { select: 1, sel_mode: true, input1: ['1', 0] } },
  '122': { class_type: 'SomethingElse', inputs: { flag: true } },
  '130': { class_type: 'Power Lora Loader (rgthree)', _meta: { title: 'Power LoRAs' }, inputs: { lora_1: { on: false, lora: 'a.safetensors', strength: 0.5 }, lora_2: { on: true, lora: 'b.safetensors', strength: 1 } } },
  '131': { class_type: 'Lora Loader Stack (rgthree)', _meta: { title: 'Stack' }, inputs: { model: ['1', 0], lora_01: 'None', strength_01: 1, lora_02: 'l1', strength_02: 0.6 } },
  '132': { class_type: 'easy loraStack', _meta: { title: 'EZ' }, inputs: { toggle: true, mode: 'simple', num_loras: 1, lora_1_name: 'l2', lora_1_strength: 0.7 } },
};
const swg = detect(SW, []);
assert.equal(swg[0].id, 'switches', 'switches shown first');
assert.deepEqual(swg[0].fields.map((f) => f.key), ['113:switch', '120:value', '121:select']);
assert.equal(swg[0].fields[0].label, 'Enhance prompt? (switch ON = use writer)');
assert.equal(swg[0].fields[0].kind, 'bool');
const swm = swg.find((g) => g.id === 'model').fields;
assert.deepEqual(swm.filter((f) => f.kind === 'lora').map((f) => f.key), ['130:lora_1', '130:lora_2']);
assert.deepEqual(swm.filter((f) => f.node === '131').map((f) => f.key), ['131:lora_01', '131:strength_01', '131:lora_02', '131:strength_02']);
assert.deepEqual(swm.filter((f) => f.node === '132').map((f) => f.key), ['132:toggle', '132:lora_1_name', '132:lora_1_strength']);
assert.equal(swg[0].fields[2].label, 'Pick');
assert.ok(!swg.some((g) => g.fields.some((f) => f.input === 'sel_mode')));
const two = detect({ '1': { class_type: 'ImpactSwitch', _meta: { title: 'T' }, inputs: { select: 1 } }, '2': { class_type: 'ComfySwitchNode', _meta: { title: 'Dual' }, inputs: { switch: true } }, '3': { class_type: 'X', _meta: { title: 'Dual' }, inputs: { a: true } } }, []);
assert.equal(two[0].fields[1].label, 'Dual', 'single bool -> title');
const multi = detect({ '5': { class_type: 'MySwitch', _meta: { title: 'M' }, inputs: { a: true, b: false } } }, []);
assert.deepEqual(multi[0].fields.map((f) => f.label), ['M · a', 'M · b']);
const EZ = { class_type: 'easy loraStack', _meta: { title: 'EZ' }, inputs: { toggle: true, mode: 'simple', num_loras: 2 } };
for (let i = 1; i <= 10; i++) Object.assign(EZ.inputs, { [`lora_${i}_name`]: 'None', [`lora_${i}_strength`]: 1, [`lora_${i}_model_strength`]: 1, [`lora_${i}_clip_strength`]: 1 });
const ezs = detect({ '9': EZ }, []).find((g) => g.id === 'model').fields.map((f) => f.input);
assert.deepEqual(ezs, ['toggle', 'lora_1_name', 'lora_1_strength', 'lora_2_name', 'lora_2_strength']);
const ezA = detect({ '9': { ...EZ, inputs: { ...EZ.inputs, mode: 'advanced' } } }, []).find((g) => g.id === 'model').fields.map((f) => f.input);
assert.deepEqual(ezA, ['toggle', 'lora_1_name', 'lora_1_model_strength', 'lora_1_clip_strength', 'lora_2_name', 'lora_2_model_strength', 'lora_2_clip_strength']);
assert.equal(swm.find((f) => f.key === '131:lora_01').kind, 'combo', 'name placeholder until object_info');
assert.equal(swm.find((f) => f.key === '131:strength_02').kind, 'float');

// aspect presets keep ~area and snap
const a = applyAspect({ w: 1024, h: 1024 }, { w: 16, h: 9 }, 16);
assert.equal(a.w % 16, 0); assert.equal(a.h % 16, 0);
assert.ok(Math.abs(a.w / a.h - 16 / 9) < 0.03);
assert.ok(Math.abs(a.w * a.h - 1024 * 1024) / (1024 * 1024) < 0.05);

// image inputs (LoadImage) -> 'images' group, shown in Add field, subfolder values kept
{
  const IP = {
    '1': { class_type: 'LoadImage', _meta: { title: 'Load Image' }, inputs: { image: 'sub/a.png', upload: 'image' } },
    '2': { class_type: 'LoadImageMask', _meta: { title: 'Mask' }, inputs: { image: 'm.png', channel: 'alpha' } },
    '3': { class_type: 'Foo', _meta: { title: 'Foo' }, inputs: { pic: 'x.png' } },
  };
  const ig = detect(IP, []);
  assert.equal(ig[0].id, 'images');
  assert.deepEqual(ig[0].fields.map((f) => [f.key, f.kind, f.value]), [['1:image', 'image', 'sub/a.png'], ['2:image', 'image', 'm.png']]);
  assert.equal(listInputs(IP).find((n) => n.node === '1').items.find((i) => i.input === 'image').kind, 'image');
  const pg2 = detect(IP, [{ node: '3', input: 'pic' }]);
  assert.ok(pg2.find((g) => g.id === 'pinned'), 'non-LoadImage string still a normal field');
}

// All-nodes model: every literal input becomes a field (odd values as json), grouped by structure, searchable
{
  const { nodeSections, filterSections } = await import('../web/pocket/nodes-model.js');
  const NP = {
    '10': { class_type: 'KSampler', _meta: { title: 'Sampler' }, inputs: { seed: 1, steps: 9, cfg: 2, model: ['11', 0], extra: null, blob: { a: 1 } } },
    '11': { class_type: 'Foo', _meta: { title: 'Foo' }, inputs: { name: 'x' } },
  };
  const flat = (ss) => ss.flatMap((s) => s.nodes.flatMap((n) => n.fields));
  const plain = nodeSections(NP, null, {});
  assert.equal(plain.length, 1);
  assert.equal(flat(plain).length, 6, 'all non-link inputs');
  assert.deepEqual(flat(plain).filter((f) => f.kind === 'json').map((f) => f.input), ['extra', 'blob']);
  assert.ok(plain[0].nodes.every((n) => !n.bypassable));
  const st = { groups: [{ title: 'G', nodeIds: [5], mode: 0 }], nodes: [{ id: 5, title: 'Sampler', type: 'KSampler', mode: 0 }, { id: 6, title: 'Foo', type: 'Foo', mode: 4 }], apiIds: { 5: ['10', '10'], 6: [] } };
  const gs = nodeSections(NP, st, {});
  assert.deepEqual(gs.map((s) => s.title), ['G', 'Other']);
  assert.equal(flat(gs).length, 6, 'no duplicate claims; unclaimed prompt node 11 lands in Other');
  assert.equal(gs[1].nodes.find((n) => n.key === '6').on, false);
  assert.deepEqual(filterSections(gs, 'steps').map((s) => s.title), ['G']);
  assert.deepEqual(filterSections(gs, 'foo').map((s) => s.title), ['Other']);
}

// LoadImageMask: channel combo rides on the image field; Painter.mask is not an image; seeds outside groups honour randomize; missing node is a no-op
{
  const MP = {
    '1': { class_type: 'LoadImageMask', _meta: { title: 'Mask' }, inputs: { image: 'm.jpg', channel: 'alpha' } },
    '2': { class_type: 'Painter', _meta: { title: 'P' }, inputs: { mask: 'x' } },
    '3': { class_type: 'Whatever', _meta: { title: 'W' }, inputs: { noise_seed: 5 } },
  };
  const mg = detect(MP, []);
  const imgf = mg.find((g) => g.id === 'images').fields;
  assert.equal(imgf.length, 1);
  assert.equal(imgf[0].channel.input, 'channel');
  assert.equal(imgf[0].channel.value, 'alpha');
  assert.ok(!mg.some((g) => g.fields.some((f) => f.input === 'channel')), 'channel not listed separately');
  assert.equal(setInput(MP, '99', 'x', 1), MP);
  mg.splice(0, mg.length, ...mg.filter((g) => g.id !== 'seed')); // pretend the seed group is not shown
  const sf = seedFields(mg, MP);
  assert.deepEqual(sf.map((f) => f.key), ['3:noise_seed'], 'seed not in any group is found via prompt');
  assert.equal(reseed(MP, mg, {})['3'].inputs.noise_seed, 5, 'hidden seed is not randomized by default');
  assert.notEqual(reseed(MP, mg, { '3:noise_seed': true })['3'].inputs.noise_seed, 5);
  const ctl = { '3': { noise_seed: 'increment' } };
  const sd = seedDefaults(mg, MP, ctl);
  assert.deepEqual(sd.rand, { '3:noise_seed': false });
  assert.equal(reseed(MP, mg, sd.rand, null, sd.step)['3'].inputs.noise_seed, 6);
  assert.deepEqual(seedDefaults(mg, MP, { '3': { noise_seed: 'randomize' } }).rand, { '3:noise_seed': true });
  assert.deepEqual(seedDefaults(mg, MP, {}).rand, { '3:noise_seed': false }, 'known controls, no entry = fixed');
  assert.deepEqual(seedDefaults(mg, MP, null).rand, { '3:noise_seed': false }, 'unknown controls: hidden seed fixed');
}

console.log('fields: all ok');
