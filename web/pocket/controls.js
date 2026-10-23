// Typed field controls for the Generate view. Each takes a field (see fields.js) and calls onChange(newValue).
// Inputs use >=16px font (no iOS zoom) and 44px touch targets.
import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { api, thumbUrl } from './api.js';
import { html, icon, haptic, copyText, toast } from './ui.js';
import { numberCfg, clampNum, fmtNum, ASPECTS, applyAspect, gcd, loraOptions } from './fields.js';

export function Switch({ on, onChange, label, disabled }) {
  return html`
    <button type="button" role="switch" aria-checked=${on ? 'true' : 'false'} aria-label=${label} disabled=${!!disabled} class=${'switch' + (on ? ' on' : '')}
            onClick=${() => { haptic(6); onChange(!on); }}><i></i></button>`;
}

// ---------------------------------------------------------------- numbers
export function NumberInput({ cfg, value, onChange, label, compact }) {
  const [txt, setTxt] = useState(fmtNum(value, cfg));
  const focus = useRef(false);
  useEffect(() => { if (!focus.current) setTxt(fmtNum(value, cfg)); }, [value, cfg.dec, cfg.isInt]);
  const bump = (dir) => {
    haptic(5);
    const cur = Number.isFinite(value) ? value : 0;
    const next = clampNum(cur + dir * cfg.step, cfg);
    if (next !== null) { onChange(next); setTxt(fmtNum(next, cfg)); }
  };
  return html`
    <div class=${'num' + (compact ? ' compact' : '')}>
      <button type="button" class="num-b" aria-label=${'Decrease ' + label} disabled=${cfg.min !== undefined && value <= cfg.min} onClick=${() => bump(-1)}>${icon('minus', { size: 18, sw: 2.2 })}</button>
      <input class="num-i" type="text" inputmode=${cfg.isInt ? 'numeric' : 'decimal'} autocomplete="off" aria-label=${label} value=${txt}
             onFocus=${(e) => { focus.current = true; e.target.select(); }}
             onInput=${(e) => { setTxt(e.target.value); const n = Number(e.target.value.replace(',', '.')); if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n); }}
             onBlur=${() => { focus.current = false; const n = clampNum(txt.replace(',', '.'), cfg); const v = n === null ? value : n; onChange(v); setTxt(fmtNum(v, cfg)); }}
             onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); }} />
      <button type="button" class="num-b" aria-label=${'Increase ' + label} disabled=${cfg.max !== undefined && value >= cfg.max} onClick=${() => bump(1)}>${icon('plus', { size: 18, sw: 2.2 })}</button>
    </div>`;
}

function Range({ cfg, value, onChange, label }) {
  const span = cfg.max - cfg.min;
  const v = Number.isFinite(value) ? Math.min(cfg.max, Math.max(cfg.min, value)) : cfg.min;
  return html`<input class="rng" type="range" aria-label=${label} min=${cfg.min} max=${cfg.max} step=${cfg.step} value=${v}
                     style=${{ '--p': `${((v - cfg.min) / (span || 1)) * 100}%` }}
                     onInput=${(e) => onChange(clampNum(e.target.value, cfg))} />`;
}

function NumberField({ f, onChange }) {
  const cfg = numberCfg(f);
  const slider = cfg.min !== undefined && cfg.max !== undefined && cfg.max - cfg.min <= 30 && cfg.max > cfg.min;
  // two grid children: the stepper next to the label, the slider on its own row (see .frow.k-int in style.css)
  return html`
    <${NumberInput} cfg=${cfg} value=${f.value} label=${f.label} onChange=${onChange} />
    ${slider && html`<${Range} cfg=${cfg} value=${f.value} label=${f.label + ' slider'} onChange=${onChange} />`}`;
}

// ---------------------------------------------------------------- combo
export function ComboSelect({ value, options, onChange, label }) {
  const [q, setQ] = useState('');
  const long = options.length > 24;
  let list = options;
  if (q.trim()) {
    const t = q.trim().toLowerCase();
    list = options.filter((o) => String(o).toLowerCase().includes(t));
  }
  if (value !== undefined && value !== null && value !== '' && !list.includes(value)) list = [value, ...list];
  return html`
    <div class="combo">
      ${long && html`<label class="filter">${icon('search', { size: 16 })}<input type="search" placeholder=${`Filter ${options.length} options`} aria-label=${'Filter ' + label} value=${q} onInput=${(e) => setQ(e.target.value)} autocomplete="off" /></label>`}
      <div class="sel">
        <select aria-label=${label} value=${value} onChange=${(e) => { haptic(6); onChange(e.target.value); }}>
          ${list.map((o) => html`<option key=${o} value=${o} selected=${o === value}>${o}</option>`)}
        </select>
        ${icon('chevronD', { size: 18 })}
      </div>
      ${long && q.trim() && html`<span class="fhint">${list.length - (options.includes(value) ? 0 : 1)} match${list.length === 1 ? '' : 'es'}</span>`}
    </div>`;
}

function ComboField({ f, onChange }) {
  const options = (f.spec && f.spec.options) || [f.value];
  return html`<${ComboSelect} value=${f.value} options=${options} label=${f.label} onChange=${onChange} />`;
}

// ---------------------------------------------------------------- text
function TextArea({ f, onChange }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.45)) + 'px';
  };
  useLayoutEffect(fit, [f.value]);
  useEffect(() => { const on = () => fit(); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return html`
    <div class="ta-wrap">
      <textarea ref=${ref} class="ta" rows="2" aria-label=${f.label} spellcheck="false" autocapitalize="off" value=${f.value}
                onInput=${(e) => onChange(e.target.value)}></textarea>
      <div class="ta-tools">
        <span class="fhint">${f.value.trim() ? (f.value.trim().split(/\s+/).length === 1 ? '1 word' : f.value.trim().split(/\s+/).length + ' words') : 'Empty'}</span>
        <button type="button" class="icon-btn small" aria-label=${'Copy ' + f.label} onClick=${async () => { toast((await copyText(f.value)) ? 'Copied' : 'Copy failed', 'ok', 1400); }}>${icon('copy', { size: 17 })}</button>
        <button type="button" class="icon-btn small" aria-label=${'Clear ' + f.label} disabled=${!f.value} onClick=${() => { onChange(''); ref.current && ref.current.focus(); }}>${icon('x', { size: 17 })}</button>
      </div>
    </div>`;
}

function StringField({ f, onChange }) {
  return html`<input class="txt" type="text" aria-label=${f.label} value=${f.value} autocomplete="off" spellcheck="false" onInput=${(e) => onChange(e.target.value)} />`;
}

// ---------------------------------------------------------------- seed
function SeedField({ f, onChange, onDice, rand, onRand }) {
  return html`
    <div class="fctl-col">
      <div class="seedrow">
        <input class="txt seed-i" type="text" inputmode="numeric" pattern="[0-9]*" aria-label=${f.label} autocomplete="off" value=${String(f.value)}
               onInput=${(e) => {
                 const d = e.target.value.replace(/\D/g, '').slice(0, 16);
                 const mx = Math.min(Number.MAX_SAFE_INTEGER, f.spec && Number.isFinite(f.spec.max) ? f.spec.max : Infinity);
                 const v = d === '' ? 0 : Math.min(Number(d), mx);
                 e.target.value = d === '' || v === Number(d) ? d : String(v);
                 onChange(v);
               }} />
        <button type="button" class="icon-btn dice" aria-label="Roll a new random seed" onClick=${() => { haptic(10); onDice(); }}>${icon('dice', { size: 22 })}</button>
      </div>
      <label class="swrow">
        <span><b>Randomize</b><em>${rand ? 'A new seed is used after every run' : 'Seed stays fixed between runs'}</em></span>
        <${Switch} on=${rand} onChange=${onRand} label=${'Randomize ' + f.label} />
      </label>
    </div>`;
}

// ---------------------------------------------------------------- size
function SizeField({ f, onChange }) {
  const { w, h } = f.value;
  const mk = (sp, v) => numberCfg({ kind: 'int', input: 'size', value: v, spec: { min: 64, max: 16384, step: 8, ...(sp || {}) } });
  const wc = mk(f.spec.w, w);
  const hc = mk(f.spec.h, h);
  const snap = Math.max(wc.step, hc.step, w % 16 === 0 && h % 16 === 0 ? 16 : 8);
  const g = gcd(w, h) || 1;
  const rw = w / g, rh = h / g;
  const ratioLabel = rw <= 32 && rh <= 32 ? `${rw}:${rh}` : (w / h).toFixed(2);
  const mp = ((w * h) / 1e6).toFixed(2);
  const k = 44 / Math.max(w, h);
  const cur = ASPECTS.find((a) => Math.abs(a.w / a.h - w / h) < 0.012);
  return html`
    <div class="fctl-col">
      <div class="sizerow">
        <div class="sz"><span>Width</span><${NumberInput} cfg=${wc} value=${w} label="Width" compact onChange=${(v) => onChange({ w: v, h })} /></div>
        <button type="button" class="icon-btn swap" aria-label="Swap width and height" onClick=${() => { haptic(8); onChange({ w: h, h: w }); }}>${icon('swap', { size: 20 })}</button>
        <div class="sz"><span>Height</span><${NumberInput} cfg=${hc} value=${h} label="Height" compact onChange=${(v) => onChange({ w, h: v })} /></div>
      </div>
      <div class="sizemeta">
        <span class="ratio-box" aria-hidden="true"><i style=${{ width: Math.max(6, w * k) + 'px', height: Math.max(6, h * k) + 'px' }}></i></span>
        <span class="sizeinfo"><b>${w} × ${h}</b><em>${cur ? cur.id : ratioLabel} · ${mp} MP</em></span>
      </div>
      <div class="aspects" role="group" aria-label="Aspect ratio presets">
        ${ASPECTS.map((a) => html`<button type="button" key=${a.id} class=${'chip small' + (cur && cur.id === a.id ? ' on' : '')} aria-pressed=${cur && cur.id === a.id ? 'true' : 'false'}
            onClick=${() => { haptic(6); onChange(applyAspect({ w, h }, a, snap)); }}>${a.id}</button>`)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- lora dict (rgthree Power Lora Loader etc.)
function LoraField({ f, onChange }) {
  const v = f.value;
  const opts = loraOptions();
  const options = opts.length ? opts : [v.lora];
  const set = (patch) => onChange({ ...v, ...patch });
  const strength = Number.isFinite(v.strength) ? v.strength : 1;
  const cfg = numberCfg({ kind: 'float', input: 'strength', value: strength, spec: { min: -10, max: 10, step: 0.05 } });
  return html`
    <div class=${'fctl-col lora' + (v.on === false ? ' off' : '')}>
      <div class="lorarow">
        <${Switch} on=${v.on !== false} onChange=${(on) => set({ on })} label=${`${f.label} enabled`} />
        <div class="grow"><${ComboSelect} value=${v.lora} options=${options} label=${f.label} onChange=${(lora) => set({ lora })} /></div>
      </div>
      <div class="lorastr"><span>Strength</span><${NumberInput} cfg=${cfg} value=${strength} label=${f.label + ' strength'} compact onChange=${(s) => set({ strength: s })} /></div>
    </div>`;
}

// ---------------------------------------------------------------- image (LoadImage upload)
const splitName = (v) => { const s = String(v || ''); const i = s.lastIndexOf('/'); return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)]; };
const inputUrl = (v, type = 'input') => { const [sub, name] = splitName(v); return `/view?${new URLSearchParams({ filename: name, subfolder: sub, type })}`; };
const isJpegName = (v) => /\.jpe?g$/i.test(String(v || ''));

const MAX_BYTES = 4 * 1024 * 1024, MAX_EDGE = 3072;
const BAD_FORMAT = "This photo format isn't supported; pick a JPEG/PNG";

/** Re-encode odd formats (HEIC...) and big photos before upload. Returns {blob, name, jpeg}. PNG/WebP with real alpha stay PNG. */
export async function prepareUpload(file) {
  const plain = /^image\/(jpeg|png|webp)$/.test(file.type);
  if (plain && file.size <= MAX_BYTES) return { blob: file, name: file.name, jpeg: file.type === 'image/jpeg' };
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error(BAD_FORMAT); }
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  let alpha = false;
  if (/^image\/(png|webp|gif)$/.test(file.type)) {
    const d = x.getImageData(0, 0, w, h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 255) { alpha = true; break; }
  }
  const base = file.name.replace(/\.[^.]*$/, '') || 'photo';
  const blob = await new Promise((r) => c.toBlob(r, alpha ? 'image/png' : 'image/jpeg', 0.92));
  if (!blob) throw new Error(BAD_FORMAT);
  return { blob, name: base + (alpha ? '.png' : '.jpg'), jpeg: !alpha };
}

/** POST /upload/image (type=input, no overwrite) -> value for a LoadImage widget ("sub/name.png" when ComfyUI returns a subfolder). */
export async function uploadInput(blob, name) {
  const fd = new FormData();
  fd.append('image', blob, name);
  fd.append('type', 'input');
  fd.append('overwrite', 'false');
  const res = await fetch('/upload/image', { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
  const d = await res.json();
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

function OutputPicker({ onPick, onClose }) {
  const [st, setSt] = useState({ items: [], total: 0, loading: true, error: '' });
  const load = (offset) => {
    setSt((s) => ({ ...s, loading: true, error: '' }));
    api.outputs({ offset, limit: 48, kind: 'image' })
      .then((d) => setSt((s) => ({ items: offset ? s.items.concat(d.items || []) : (d.items || []), total: d.total || 0, loading: false, error: '' })))
      .catch((e) => setSt((s) => ({ ...s, loading: false, error: e.message || 'Could not load outputs' })));
  };
  useEffect(() => { load(0); }, []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);
  return html`
    <div class="gsheet-back" onClick=${onClose}>
      <div class="gsheet tall" role="dialog" aria-modal="true" aria-label="Pick from my outputs" onClick=${(e) => e.stopPropagation()}>
        <div class="gsheet-grab" aria-hidden="true"><i></i></div>
        <header class="gsheet-h"><h2>Pick from my outputs</h2><button type="button" class="icon-btn small" aria-label="Close" onClick=${onClose}>${icon('x', { size: 20 })}</button></header>
        <div class="gsheet-body">
          <div class="imgpick">
            ${st.items.map((it) => html`<button type="button" key=${it.path} class="imgpick-i" aria-label=${it.name} onClick=${() => onPick(it)}><img src=${thumbUrl(it, 256)} alt="" loading="lazy" /></button>`)}
          </div>
          ${st.error && html`<p class="lempty">${st.error}</p>`}
          ${!st.loading && !st.error && !st.items.length && html`<p class="lempty">No output images yet.</p>`}
          ${st.loading && html`<p class="lempty">Loading…</p>`}
          ${!st.loading && st.items.length < st.total && html`<button type="button" class="chip" onClick=${() => load(st.items.length)}>Load more</button>`}
        </div>
      </div>
    </div>`;
}

function ImageField({ f, onChange, onSet, getIdent }) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [bad, setBad] = useState(false);
  const file = useRef(null);
  const sess = useRef(null); // {value, noAlpha}: what this session uploaded (those files live in input/)
  useEffect(() => setBad(false), [f.value]);
  const run = async (fn) => {
    setBusy(true);
    const id0 = getIdent ? getIdent() : null;
    try {
      const r = await fn();
      if (getIdent && getIdent() !== id0) { toast('Workflow changed, upload discarded', 'error'); return; }
      sess.current = { value: r.value, noAlpha: r.noAlpha };
      onChange(r.value); haptic(8);
    } catch (e) { toast(e.message || 'Upload failed', 'error'); } finally { setBusy(false); }
  };
  const fromFile = (e) => {
    const fl = e.target.files && e.target.files[0];
    e.target.value = '';
    if (fl) run(async () => { const p = await prepareUpload(fl); return { value: await uploadInput(p.blob, p.name), noAlpha: p.jpeg }; });
  };
  const fromOutput = (it) => {
    setPicking(false);
    run(async () => {
      const r = await fetch(`/view?${new URLSearchParams({ filename: it.name, subfolder: it.folder || '', type: 'output' })}`);
      if (!r.ok) throw new Error(`Could not read image (HTTP ${r.status})`);
      return { value: await uploadInput(await r.blob(), it.name), noAlpha: true }; // SaveImage writes RGB
    });
  };
  const folder = (sess.current && sess.current.value === f.value) ? 'input' : ((f.spec && f.spec.image_folder) || 'input');
  const ch = f.channel;
  const noAlpha = (sess.current && sess.current.value === f.value) ? sess.current.noAlpha : isJpegName(f.value);
  return html`
    <div class="fctl-col imgf">
      <div class="imgf-prev">
        ${f.value && !bad ? html`<img src=${inputUrl(f.value, folder)} alt=${'Current image ' + f.value} onError=${() => setBad(true)} />` : html`<span class="imgf-none">${icon('image', { size: 28, sw: 1.5 })}<em>${f.value ? 'File not found on server' : 'No image'}</em></span>`}
      </div>
      <span class="fhint imgf-name">${f.value || ''}</span>
      <div class="imgf-btns">
        <button type="button" class="chip" disabled=${busy} onClick=${() => file.current && file.current.click()}>${icon('image', { size: 16 })}${busy ? 'Uploading…' : 'Choose photo'}</button>
        <button type="button" class="chip" disabled=${busy} onClick=${() => setPicking(true)}>${icon('copy', { size: 16 })}Pick from my outputs</button>
      </div>
      ${ch && html`
        <div class="imgf-ch"><span class="fhint">${ch.label}</span><${ComboSelect} value=${ch.value} options=${(ch.spec && ch.spec.options) || [ch.value]} label=${ch.label} onChange=${(v) => onSet(ch, v)} /></div>
        ${ch.value === 'alpha' && noAlpha && html`<p class="fhint imgf-warn" role="status">alpha channel: this image has none, mask will be empty</p>`}`}
      <input ref=${file} type="file" accept="image/*" hidden aria-label=${'Upload ' + f.label} onChange=${fromFile} />
      ${picking && html`<${OutputPicker} onPick=${fromOutput} onClose=${() => setPicking(false)} />`}
    </div>`;
}

// Fallback for odd literals (null, arrays, objects): edit as JSON, applied once it parses.
function JsonField({ f, onChange }) {
  const [txt, setTxt] = useState(JSON.stringify(f.value));
  const [bad, setBad] = useState(false);
  return html`<input class=${'txt' + (bad ? ' bad' : '')} type="text" aria-label=${f.label} value=${txt} autocomplete="off" spellcheck="false" aria-invalid=${bad ? 'true' : 'false'}
    onInput=${(e) => { const v = e.target.value; setTxt(v); try { const j = JSON.parse(v); setBad(false); onChange(j); } catch { setBad(true); } }} />`;
}

function BoolField({ f, onChange }) {
  return html`<${Switch} on=${!!f.value} onChange=${onChange} label=${f.label} />`;
}

/** One labelled field row. props: f, rand, onSet(f, value), onDice(f), onRand(f, bool), onUnpin(f) */
export function FieldRow({ f, rand, onSet, onDice, onRand, onUnpin, getIdent }) {
  const set = (v) => onSet(f, v);
  let ctl;
  switch (f.kind) {
    case 'text': ctl = html`<${TextArea} f=${f} onChange=${set} />`; break;
    case 'string': ctl = html`<${StringField} f=${f} onChange=${set} />`; break;
    case 'seed': ctl = html`<${SeedField} f=${f} onChange=${set} rand=${rand} onDice=${() => onDice(f)} onRand=${(b) => onRand(f, b)} />`; break;
    case 'int': case 'float': ctl = html`<${NumberField} f=${f} onChange=${set} />`; break;
    case 'bool': ctl = html`<${BoolField} f=${f} onChange=${set} />`; break;
    case 'combo': ctl = html`<${ComboField} f=${f} onChange=${set} />`; break;
    case 'json': ctl = html`<${JsonField} f=${f} onChange=${set} />`; break;
    case 'image': ctl = html`<${ImageField} f=${f} onChange=${set} onSet=${onSet} getIdent=${getIdent} />`; break;
    case 'size': ctl = html`<${SizeField} f=${f} onChange=${set} />`; break;
    case 'lora': ctl = html`<${LoraField} f=${f} onChange=${set} />`; break;
    default: return null;
  }
  const inline = f.kind === 'bool';
  const hideLabel = f.kind === 'lora' || f.kind === 'size';
  return html`
    <div class=${'frow k-' + f.kind + (inline ? ' inline' : '') + (f.role ? ' role-' + f.role : '')} data-key=${f.key}>
      ${!hideLabel && html`
        <div class="flabel">
          <span class="flabel-t">${f.label}</span>
          ${f.sub && html`<em>${f.sub}</em>`}
          ${f.pinned && html`<button type="button" class="icon-btn small unpin" aria-label=${'Unpin ' + f.label} onClick=${() => onUnpin(f)}>${icon('x', { size: 16 })}</button>`}
        </div>`}
      ${ctl}
      ${hideLabel && f.pinned && html`<button type="button" class="linkbtn" onClick=${() => onUnpin(f)}>Unpin</button>`}
    </div>`;
}
