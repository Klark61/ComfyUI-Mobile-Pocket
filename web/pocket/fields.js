// Field detection over an API-format prompt: {id: {class_type, inputs, _meta:{title}}}.
// Pure logic (no DOM) plus a small /object_info cache. The prompt itself is the single source of truth for values;
// fields are re-derived from (prompt, pins, object_info) on every render.
//
// Field: {key, node, input, cls, nodeTitle, kind, value, spec, label, sub, role, group, ...}
//   kind: image (uploaded input file) | text | string | seed | int | float | bool | combo | lora (dict {on, lora, strength}) | size (width+height of one node)
import { getJSON } from './api.js';

export const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isLoraDict = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && 'lora' in v;
export const keyOf = (node, input) => `${node}:${input}`;
const numCmp = (a, b) => { const x = Number(a), y = Number(b); return Number.isNaN(x) || Number.isNaN(y) ? String(a).localeCompare(String(b)) : x - y; };

export function nodeTitleOf(prompt, id) {
  const n = prompt && prompt[id];
  return (n && n._meta && n._meta.title) || (n && n.class_type) || `Node ${id}`;
}

// ---------------------------------------------------------------- object_info cache
const INFO = new Map();      // class_type -> class info object | null (unknown)
const inflight = new Map();  // class_type -> Promise

export const infoKnown = (cls) => INFO.has(cls);

/** Fetch (and cache) /object_info/{class} for each class. Resolves when all are settled; value = true if anything new arrived. */
export function ensureInfo(classes) {
  const jobs = [];
  let fresh = false;
  for (const cls of new Set(classes)) {
    if (!cls || INFO.has(cls)) continue;
    let p = inflight.get(cls);
    if (!p) {
      p = getJSON(`/object_info/${encodeURIComponent(cls)}`)
        .then((d) => { INFO.set(cls, (d && d[cls]) || null); fresh = true; })
        .catch(() => { INFO.set(cls, null); fresh = true; })
        .finally(() => inflight.delete(cls));
      inflight.set(cls, p);
    }
    jobs.push(p);
  }
  return Promise.all(jobs).then(() => fresh);
}

/** Normalised input spec: {type, options?, min?, max?, step?, multiline?, default?} or null. Handles ["COMBO", {options}] and [[...], opts]. */
export function specOf(cls, input) {
  const ci = INFO.get(cls);
  const inp = ci && ci.input;
  if (!inp) return null;
  const raw = (inp.required && inp.required[input]) || (inp.optional && inp.optional[input]) || (inp.hidden && inp.hidden[input]);
  if (!Array.isArray(raw)) return null;
  const [t, o] = raw;
  const opts = o && typeof o === 'object' ? o : {};
  if (Array.isArray(t)) return { ...opts, type: 'COMBO', options: t };
  if (t === 'COMBO') return { ...opts, type: 'COMBO', options: Array.isArray(opts.options) ? opts.options : [] };
  return { ...opts, type: String(t) };
}

export const loraOptions = () => (specOf('LoraLoader', 'lora_name') || {}).options || [];

// ---------------------------------------------------------------- naming
const NICE = {
  ckpt_name: 'Checkpoint', unet_name: 'Diffusion model', lora_name: 'LoRA', sampler_name: 'Sampler', scheduler: 'Scheduler',
  cfg: 'CFG', steps: 'Steps', denoise: 'Denoise', strength_model: 'Model strength', strength_clip: 'CLIP strength', strength: 'Strength',
  batch_size: 'Batch size', seed: 'Seed', noise_seed: 'Noise seed', text: 'Text', guidance: 'Guidance', width: 'Width', height: 'Height',
};
export function humanize(name) {
  if (NICE[name]) return NICE[name];
  const s = String(name).replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

// ---------------------------------------------------------------- classification
const PROMPT_NAME = /^(text|prompt|positive|negative|text_[a-z0-9]+|caption|.*_prompt|prompt_.*|clip_[lg]|t5xxl|wildcard_text)$/i;
const NOT_TEXT = /(prefix|name|path|format|mode|url|dir|folder|ext|type|separator|suffix)$/i;
const GENERIC_NAME = /^(text|value|string|str|content|input)$/i; // input names that say nothing: label by node title
const SEED_RE = /(^|_)seed$/i;
const COMBO_NAME = /(_name\d*|^scheduler|^lora_\d+)$/i;
const LORA_NAME = /^(lora(_\d+)?|lora_\d+_name)$/i; // Lora Loader Stack (lora_01), easy loraStack (lora_1_name)
const LORA_STRENGTH = /^(strength_\d+|lora_\d+_(model_|clip_)?strength)$/i;
const SWITCH_CLS = /switch/i;
const IMPACT_SWITCH = /^(Impact.*Switch|SEGSSwitch)$/;
const BOOL_CLS = /^(PrimitiveBoolean|ComfySwitchNode)$/;
const SAMPLING = ['steps', 'cfg', 'denoise', 'sampler_name', 'scheduler', 'guidance'];
const SAMPLING_ORDER = ['steps', 'cfg', 'guidance', 'denoise', 'sampler_name', 'scheduler'];
const MODEL_NAMES = ['ckpt_name', 'unet_name', 'lora_name'];
const STRENGTHS = ['strength_model', 'strength_clip'];
const FLOATY = /^(cfg|denoise|guidance|strength.*|.*_strength|.*_scale|shift|scale|sigma.*)$/i;
const SIZE_CLS = /latent|resolution|canvas|empty|size|aspect/i;

export const GROUP_DEFS = [
  { id: 'switches', label: 'Switches', icon: 'sliders' },
  { id: 'images', label: 'Images', icon: 'image' },
  { id: 'prompt', label: 'Prompt', icon: 'sparkles' },
  { id: 'seed', label: 'Seed', icon: 'dice' },
  { id: 'sampling', label: 'Sampling', icon: 'sliders' },
  { id: 'size', label: 'Size', icon: 'image' },
  { id: 'model', label: 'Model', icon: 'cube' },
  { id: 'batch', label: 'Batch', icon: 'copy' },
  { id: 'pinned', label: 'Pinned', icon: 'pin' },
];

const IMAGE_CLS = /^LoadImage(Mask)?$/;

function kindOf(name, val, spec, cls) {
  if (isLoraDict(val)) return 'lora';
  if (typeof val === 'string' && !(spec && spec.widgetType === 'PAINTER') && ((spec && spec.type === 'COMBO' && spec.image_upload) || (name === 'image' && IMAGE_CLS.test(cls || '')))) return 'image';
  if (typeof val === 'boolean') return 'bool';
  if (spec && spec.type === 'COMBO' && spec.options && spec.options.length) return 'combo';
  if (typeof val === 'number') {
    if (SEED_RE.test(name) || (spec && spec.control_after_generate)) return 'seed';
    if ((spec && spec.type === 'FLOAT') || !Number.isInteger(val) || FLOATY.test(name)) return (spec && spec.type === 'INT') ? 'int' : 'float';
    return 'int';
  }
  if (typeof val === 'string') {
    if ((spec && spec.multiline) || PROMPT_NAME.test(name)) return 'text';
    if ((val.length >= 60 || val.includes('\n')) && !NOT_TEXT.test(name)) return 'text';
    if (COMBO_NAME.test(name)) return infoKnown(cls) ? 'string' : 'combo'; // 'combo' until object_info says otherwise
    return 'string';
  }
  return null;
}

function autoGroup(name, val, kind, node) {
  if (!kind) return null;
  const cls = node.class_type || '';
  if (IMPACT_SWITCH.test(cls)) return name === 'select' && kind === 'int' ? 'switches' : null; // sel_mode only picks queue- vs run-time selection
  if (cls === 'easy loraStack') {
    if (name === 'toggle') return 'model';
    const m = /^lora_(\d+)_(name|strength|model_strength|clip_strength)$/.exec(name);
    if (!m) return null;
    const inp = node.inputs || {};
    if (Number(m[1]) > Number(inp.num_loras || 1)) return null;
    const adv = inp.mode === 'advanced';
    if (m[2] === 'strength' && adv) return null;
    if ((m[2] === 'model_strength' || m[2] === 'clip_strength') && !adv) return null;
    return 'model';
  }
  if (kind === 'bool') return (BOOL_CLS.test(node.class_type || '') || SWITCH_CLS.test(node.class_type || '')) ? 'switches' : null;
  if (kind === 'image') return 'images';
  if (kind === 'lora') return 'model';
  if (kind === 'text') return 'prompt';
  if (kind === 'seed') return 'seed';
  if (SAMPLING.includes(name)) return 'sampling';
  if (MODEL_NAMES.includes(name) || LORA_NAME.test(name) || LORA_STRENGTH.test(name)) return 'model';
  if (name === 'batch_size') return 'batch';
  if (STRENGTHS.includes(name)) return 'model';
  if (name === 'strength' && (/lora/i.test(node.class_type || '') || 'lora_name' in (node.inputs || {}))) return 'model';
  return null;
}

// ---------------------------------------------------------------- positive / negative tracing
const VALUE_NAME = /^(value|string|str|content|input|string_[a-z0-9]+|.*_text)$/i; // generic string widgets (primitives) once we reached them through a text link
const SKIP_LINK = /^(system|instruction)/i; // links that feed instructions, not the prompt itself

const TEXT_LINK = /^(text|prompt|t5xxl|clip_[lg]|text_[a-z0-9]+)$/i; // links that carry a string into an encoder
const COND_LINK = /^(conditioning[a-z0-9_]*|positive|negative|on_true|on_false|switch[a-z0-9_]*)$/i; // links worth following when not yet on a text path
const COND_CLASS = /encode|text|prompt|conditioning/i;

/** Keys of the text inputs feeding node `id` for `role`. Follows both branches of a switch, bounded by depth and a visited set. */
function traceText(prompt, id, role, depth = 0, viaText = false, seen = new Set()) {
  const out = [];
  const n = prompt[id];
  const sk = `${id}|${viaText ? 1 : 0}`;
  if (!n || !n.inputs || depth > 10 || seen.has(sk)) return out;
  seen.add(sk);
  for (const [name, v] of Object.entries(n.inputs)) {
    if (typeof v === 'string' && (PROMPT_NAME.test(name) || (viaText && VALUE_NAME.test(name)))) out.push(keyOf(id, name));
  }
  if (out.length) return out;
  const both = isLink(n.inputs.positive) && isLink(n.inputs.negative); // e.g. ControlNetApply: positive/negative pass through separately
  for (const [name, v] of Object.entries(n.inputs)) {
    if (!isLink(v) || SKIP_LINK.test(name)) continue;
    if (both && (name === 'positive' || name === 'negative') && name !== role) continue;
    const isText = TEXT_LINK.test(name);
    const up = String(v[0]);
    if (!viaText && !isText && !COND_LINK.test(name) && !COND_CLASS.test((prompt[up] && prompt[up].class_type) || '')) continue;
    out.push(...traceText(prompt, up, role, depth + 1, viaText || isText, seen));
  }
  return out;
}

/** Map "node:input" -> 'positive' | 'negative' for text inputs feeding a sampler's positive/negative links. */
export function promptRoles(prompt) {
  const roles = new Map();
  for (const id of Object.keys(prompt).sort(numCmp)) {
    const inp = prompt[id] && prompt[id].inputs;
    if (!inp) continue;
    for (const role of ['positive', 'negative']) {
      if (isLink(inp[role])) {
        for (const k of traceText(prompt, String(inp[role][0]), role)) if (!roles.has(k)) roles.set(k, role);
      }
    }
  }
  return roles;
}

// ---------------------------------------------------------------- detection
function baseField(prompt, id, input, val) {
  const node = prompt[id];
  const cls = node.class_type;
  const spec = specOf(cls, input);
  const kind = kindOf(input, val, spec, cls);
  if (!kind) return null;
  return { key: keyOf(id, input), node: id, input, cls, nodeTitle: nodeTitleOf(prompt, id), kind, value: val, spec, label: humanize(input), sub: '' };
}

/** Returns [{id,label,icon,fields:[...]}] for non-empty groups. `pins`: [{node,input,label?}]. */
export function detect(prompt, pins = []) {
  const out = Object.fromEntries(GROUP_DEFS.map((g) => [g.id, []]));
  if (!prompt || typeof prompt !== 'object') return [];
  const roles = promptRoles(prompt);
  const used = new Set();
  for (const id of Object.keys(prompt).sort(numCmp)) {
    const node = prompt[id];
    if (!node || typeof node !== 'object' || !node.inputs) continue;
    const inputs = node.inputs;
    if (isNum(inputs.width) && isNum(inputs.height) && SIZE_CLS.test(`${node.class_type} ${nodeTitleOf(prompt, id)}`)) {
      const ws = specOf(node.class_type, 'width');
      const hs = specOf(node.class_type, 'height');
      out.size.push({
        key: keyOf(id, 'size'), node: id, input: 'size', cls: node.class_type, nodeTitle: nodeTitleOf(prompt, id), kind: 'size',
        value: { w: inputs.width, h: inputs.height }, spec: { w: ws, h: hs }, label: 'Canvas', sub: '',
      });
      used.add(keyOf(id, 'width')); used.add(keyOf(id, 'height'));
    }
    for (const [name, val] of Object.entries(inputs)) {
      const key = keyOf(id, name);
      if (used.has(key) || isLink(val)) continue;
      const f = baseField(prompt, id, name, val);
      if (!f) continue;
      const g = autoGroup(name, val, f.kind, node);
      if (!g) continue;
      f.group = g;
      if (f.kind === 'text') {
        f.role = roles.get(key) || '';
        const generic = GENERIC_NAME.test(name);
        f.label = f.role ? `${f.role === 'positive' ? 'Positive' : 'Negative'} prompt` : (generic ? f.nodeTitle : humanize(name));
        f.sub = f.role ? f.nodeTitle : (generic ? '' : f.nodeTitle);
      } else if (g === 'switches' || (f.cls === 'easy loraStack' && name === 'toggle')) {
        f.label = f.nodeTitle;
        f.sub = '';
      } else if (f.kind === 'lora') {
        f.label = `LoRA ${String(name).replace(/\D+/g, '') || ''}`.trim();
        f.sub = f.nodeTitle;
      }
      if (f.kind === 'image' && IMAGE_CLS.test(node.class_type || '') && typeof inputs.channel === 'string' && !used.has(keyOf(id, 'channel'))) {
        f.channel = baseField(prompt, id, 'channel', inputs.channel); // shown inside the image control
        if (f.channel) used.add(keyOf(id, 'channel'));
      }
      out[g].push(f);
      used.add(key);
    }
  }
  const swCount = {};
  for (const f of out.switches) swCount[f.node] = (swCount[f.node] || 0) + 1;
  for (const f of out.switches) if (swCount[f.node] > 1) f.label = `${f.nodeTitle} · ${f.input}`;
  for (const p of pins || []) {
    const node = prompt[p.node];
    const key = keyOf(p.node, p.input);
    if (!node || !node.inputs || !(p.input in node.inputs) || used.has(key)) continue;
    const val = node.inputs[p.input];
    if (isLink(val)) continue;
    const f = baseField(prompt, String(p.node), p.input, val);
    if (!f) continue;
    f.group = 'pinned';
    f.pinned = true;
    f.sub = f.nodeTitle;
    out.pinned.push(f);
    used.add(key);
  }
  const rank = (f) => (f.role === 'positive' ? 0 : f.role === 'negative' ? 2 : 1);
  out.prompt.sort((a, b) => rank(a) - rank(b));
  const ord = (f) => { const i = SAMPLING_ORDER.indexOf(f.input); return i < 0 ? 99 : i; };
  out.sampling.sort((a, b) => numCmp(a.node, b.node) || ord(a) - ord(b));
  return GROUP_DEFS.map((g) => ({ ...g, fields: out[g.id] })).filter((g) => g.fields.length);
}

/** Every editable literal input grouped by node, for the "Add field" sheet. */
export function listInputs(prompt) {
  const res = [];
  for (const id of Object.keys(prompt || {}).sort(numCmp)) {
    const node = prompt[id];
    if (!node || !node.inputs) continue;
    const items = [];
    for (const [name, val] of Object.entries(node.inputs)) {
      if (isLink(val)) continue;
      const kind = kindOf(name, val, specOf(node.class_type, name), node.class_type);
      if (!kind) continue;
      let preview;
      if (kind === 'lora') preview = `${val.on === false ? 'off · ' : ''}${val.lora || 'none'}`;
      else if (typeof val === 'string') preview = val.length > 38 ? val.slice(0, 36) + '…' : val;
      else preview = String(val);
      items.push({ key: keyOf(id, name), node: id, input: name, kind, preview });
    }
    if (items.length) res.push({ node: id, title: nodeTitleOf(prompt, id), cls: node.class_type, items });
  }
  return res;
}

/** Distinct class_types that currently produce fields (first pass, before object_info arrives), pinned ones, any with a string input, plus LoraLoader when needed. */
export function classesToFetch(groups, pins, prompt) {
  const s = new Set();
  for (const g of groups) for (const f of g.fields) { s.add(f.cls); if (f.kind === 'lora') s.add('LoraLoader'); }
  for (const p of pins || []) { const n = prompt && prompt[p.node]; if (n) s.add(n.class_type); }
  // any node with a string literal: its spec decides multiline (an empty PrimitiveStringMultiline is invisible before that)
  for (const n of Object.values(prompt || {})) {
    if (n && n.class_type && n.inputs && Object.values(n.inputs).some((v) => typeof v === 'string')) s.add(n.class_type);
  }
  return [...s];
}

// ---------------------------------------------------------------- mutation helpers
export function setInput(prompt, node, input, value) {
  const n = prompt[node];
  if (!n) return prompt;
  return { ...prompt, [node]: { ...n, inputs: { ...n.inputs, [input]: value } } };
}

const SEED_CAP = 2 ** 50;
/** Random seed within min(max, 2^50); `max` is the input's spec max when known. */
export const randomSeed = (max) => Math.floor(Math.random() * (Math.min(Number.isFinite(max) ? max : SEED_CAP, SEED_CAP) + 1));
const seedMax = (f) => (f.spec && Number.isFinite(f.spec.max) ? f.spec.max : undefined);

/** Seed fields of the shown groups plus, when `prompt` is given, every other seed input in the prompt (e.g. only visible in All nodes). */
export function seedFields(groups, prompt = null) {
  const r = [];
  const seen = new Set();
  for (const g of groups) for (const f of g.fields) if (f.kind === 'seed' && !seen.has(f.key)) { r.push(f); seen.add(f.key); }
  if (prompt) for (const id of Object.keys(prompt)) for (const f of nodeFields(prompt, id)) if (f.kind === 'seed' && !seen.has(f.key)) { r.push(f); seen.add(f.key); }
  return r;
}

/**
 * Per-seed defaults mirroring the desktop's control_after_generate. `controls` = structure.controls ({apiId:{input:mode}}),
 * known only when the UI workflow was converted. Returns {rand:{key:bool}, step:{key:+1|-1}}.
 * Without controls: seeds shown in a Generate group randomize, hidden ones stay fixed.
 */
export function seedDefaults(groups, prompt, controls) {
  const rand = {}, step = {};
  for (const f of seedFields(groups, prompt)) {
    if (controls) {
      const m = (controls[f.node] || {})[f.input];
      rand[f.key] = m === 'randomize';
      if (m === 'increment') step[f.key] = 1;
      else if (m === 'decrement') step[f.key] = -1;
    } else rand[f.key] = f.group !== 'nodes';
  }
  return { rand, step };
}

/** Apply new random seeds to seed fields whose randomize flag is on (absent flag: on for seeds shown in a group, off for hidden ones). `step`: {key: +1|-1} for increment/decrement seeds that are not randomized. */
export function reseed(prompt, groups, rand, only = null, step = null) {
  let p = prompt;
  for (const f of seedFields(groups, prompt)) {
    if (only && !only.has(f.key)) continue;
    const on = rand[f.key] === undefined ? f.group !== 'nodes' : rand[f.key] !== false;
    if (!on) {
      const d = step && step[f.key];
      const v = p[f.node].inputs[f.input];
      if (d && typeof v === 'number') p = setInput(p, f.node, f.input, Math.max(0, Math.min(v + d, seedMax(f) ?? Number.MAX_SAFE_INTEGER)));
      continue;
    }
    p = setInput(p, f.node, f.input, randomSeed(seedMax(f)));
  }
  return p;
}

/** Replace seeds that cannot be sent: above Number.MAX_SAFE_INTEGER (getJSON rounds 2^64-1 up) or above the input's max. */
export function fixSeeds(prompt, groups) {
  let p = prompt;
  for (const f of seedFields(groups, prompt)) {
    const v = p[f.node].inputs[f.input];
    const mx = seedMax(f);
    if (typeof v === 'number' && (v > Number.MAX_SAFE_INTEGER || (mx !== undefined && v > mx))) p = setInput(p, f.node, f.input, randomSeed(mx));
  }
  return p;
}

export const cloneJSON = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- numbers
export function decimals(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

export function numberCfg(f) {
  const sp = f.spec || {};
  const isInt = f.kind === 'int' || f.kind === 'seed';
  let step = Number(sp.step);
  if (!(step > 0)) step = isInt ? 1 : (f.input === 'denoise' ? 0.05 : 0.1);
  const min = Number.isFinite(sp.min) ? sp.min : (isInt ? 0 : undefined);
  const max = Number.isFinite(sp.max) ? sp.max : undefined;
  const dec = isInt ? 0 : Math.min(4, Math.max(decimals(step), 2 * (step < 0.1 ? 1 : 0), f.input === 'cfg' ? 1 : 0));
  return { step, min, max, isInt, dec };
}

export function clampNum(v, cfg) {
  let x = Number(v);
  if (!Number.isFinite(x)) return null;
  if (cfg.min !== undefined) x = Math.max(cfg.min, x);
  if (cfg.max !== undefined) x = Math.min(cfg.max, x);
  return cfg.isInt ? Math.round(x) : Number(x.toFixed(Math.max(cfg.dec, 4)));
}

export function fmtNum(v, cfg) {
  if (!Number.isFinite(v)) return '';
  return cfg.isInt ? String(Math.round(v)) : String(Number(v.toFixed(Math.max(cfg.dec, 4))));
}

export const ASPECTS = [
  { id: '1:1', w: 1, h: 1 }, { id: '4:3', w: 4, h: 3 }, { id: '3:2', w: 3, h: 2 }, { id: '16:9', w: 16, h: 9 },
  { id: '3:4', w: 3, h: 4 }, { id: '2:3', w: 2, h: 3 }, { id: '9:16', w: 9, h: 16 },
];

/** New {w,h} with aspect a (w:h) at roughly the same pixel area, snapped to `snap`. */
export function applyAspect(cur, a, snap = 8) {
  const area = Math.max(1, cur.w * cur.h);
  const h = Math.sqrt((area * a.h) / a.w);
  const w = (h * a.w) / a.h;
  const r = (x) => Math.max(snap, Math.round(x / snap) * snap);
  return { w: r(w), h: r(h) };
}

export const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Every literal input of one API node as a field (for the All-nodes editor). Values kindOf can't classify (null, arrays, plain objects) become kind 'json'. */
export function nodeFields(prompt, id) {
  const node = prompt && prompt[id];
  if (!node || !node.inputs) return [];
  const out = [];
  for (const [name, val] of Object.entries(node.inputs)) {
    if (isLink(val)) continue;
    const f = baseField(prompt, String(id), name, val) || {
      key: keyOf(id, name), node: String(id), input: name, cls: node.class_type, nodeTitle: nodeTitleOf(prompt, id), kind: 'json', value: val, spec: specOf(node.class_type, name), label: humanize(name), sub: '',
    };
    f.group = 'nodes';
    out.push(f);
  }
  return out;
}
