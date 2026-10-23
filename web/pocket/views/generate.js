// Generate view: pick a source (recent run / saved workflow / preset / remixed image), edit the detected fields, queue.
//
// The API prompt is the single source of truth (st.prompt). Fields are derived from it by fields.js; edits write straight
// back into the prompt. Workflows without a fresh snapshot are converted through the hidden desktop-frontend iframe
// (converter.js) and the result is stored as a snapshot so the next open is instant.
import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { html, icon, haptic, toast, confirmDialog } from '../ui.js';
import { getJSON, postJSON, thumbUrl } from '../api.js';
import { navigate } from '../router.js';
import { canvasUrl, wfPathParam, canCanvas, writeMode, lastModeFor } from '../mode.js';
import { ws } from '../ws.js';
import { queueStore, useQueue } from '../queue-store.js';
import { convertWorkflowFull } from '../converter.js';
import {
  detect, ensureInfo, classesToFetch, setInput, reseed, fixSeeds, seedFields, randomSeed, seedDefaults, cloneJSON, listInputs, humanize, nodeTitleOf, keyOf,
} from '../fields.js';
import { FieldRow } from '../controls.js';
import { SectionsCard } from './sections.js';
import { NodesSheet } from './nodes.js';
import { TextOutputs } from './textouts.js';
import { groupPatch, mergeValues, applyModesToUi, isApiFormat } from '../sections-model.js';

const LAST_KEY = 'comfypocket.gen.last';
const pinsKey = (path) => 'comfypocket.pins.' + path;
const modesKey = (path) => 'comfypocket.modes.' + path;
const enc = encodeURIComponent;
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;

// ---------------------------------------------------------------- persistence (all try/catch: storage may be blocked)
function readLast() {
  try {
    const j = JSON.parse(localStorage.getItem(LAST_KEY));
    if (j && j.prompt && typeof j.prompt === 'object' && j.src) return j;
  } catch { /* ignore */ }
  return null;
}
function writeLast(st) {
  try {
    if (!st.prompt) { localStorage.removeItem(LAST_KEY); return; }
    localStorage.setItem(LAST_KEY, JSON.stringify({ src: st.src, prompt: st.prompt, pins: st.pins, rand: st.rand, runs: st.runs, sec: st.sec || null }));
  } catch { /* quota or blocked: the session just will not be restored */ }
}
function readPins(path) {
  try { const p = JSON.parse(localStorage.getItem(pinsKey(path))); return Array.isArray(p) ? p : []; } catch { return []; }
}
function writePins(path, pins) {
  try { localStorage.setItem(pinsKey(path), JSON.stringify(pins)); } catch { /* ignore */ }
}
// Sections: per-workflow mode overrides {uiNodeId: 0|2|4}, kept on the phone too (the server snapshot only stores them once updated)
function readModes(path) {
  try { const m = JSON.parse(localStorage.getItem(modesKey(path))); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch { return {}; }
}
function writeModes(path, modes) {
  try { if (modes && Object.keys(modes).length) localStorage.setItem(modesKey(path), JSON.stringify(modes)); else localStorage.removeItem(modesKey(path)); } catch { /* ignore */ }
}
const sameModes = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
const newSec = (path, modes, structure, dirty) => ({ path, modes: modes || {}, okModes: structure ? { ...(modes || {}) } : {}, structure: structure || null, dirty: !!dirty });

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function outThumb(o, ts) {
  if (!o || VIDEO.test(o.filename)) return null;
  if ((o.type || 'output') === 'output') return thumbUrl({ path: (o.subfolder ? o.subfolder + '/' : '') + o.filename, mtime: ts ? ts / 1000 : undefined }, 160);
  return `/view?${new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type })}`;
}

/** /prompt 400 body -> {title, detail, items:[{node, title, message}]} */
function explainError(e, prompt) {
  const b = e && e.body;
  const out = { title: 'Could not queue', detail: '', items: [] };
  if (b && typeof b === 'object') {
    const er = b.error;
    if (typeof er === 'string') out.title = er;
    else if (er && er.message) { out.title = er.message; out.detail = er.details || ''; }
    for (const [id, ne] of Object.entries(b.node_errors || {})) {
      for (const x of (ne && ne.errors) || []) {
        out.items.push({ node: id, title: (prompt && prompt[id] && nodeTitleOf(prompt, id)) || (ne && ne.class_type) || `Node ${id}`, message: [x.message, x.details].filter(Boolean).join(': ') });
      }
    }
  } else out.title = (e && e.message) || 'Network error';
  return out;
}

// ---------------------------------------------------------------- small pieces
function Sheet({ title, onClose, children, tall }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.focus();
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return html`
    <div class="gsheet-back" onClick=${onClose}>
      <div class=${'gsheet' + (tall ? ' tall' : '')} role="dialog" aria-modal="true" aria-label=${title} tabindex="-1" ref=${ref} onClick=${(e) => e.stopPropagation()}>
        <div class="gsheet-grab" aria-hidden="true"><i></i></div>
        <header class="gsheet-h"><h2>${title}</h2><button type="button" class="icon-btn small" aria-label="Close" onClick=${onClose}>${icon('x', { size: 20 })}</button></header>
        <div class="gsheet-body">${children}</div>
      </div>
    </div>`;
}

function useList(loader, deps) {
  const [s, setS] = useState({ loading: true, items: [], error: '' });
  const reload = useCallback(() => {
    let dead = false;
    setS((x) => ({ ...x, loading: true, error: '' }));
    loader().then((items) => { if (!dead) setS({ loading: false, items, error: '' }); },
      (e) => { if (!dead) setS({ loading: false, items: [], error: e.message || 'Failed to load' }); });
    return () => { dead = true; };
  }, deps);
  useEffect(reload, [reload]);
  return [s, reload];
}

function Skeleton() { return html`<div class="rskel" aria-hidden="true"><i></i><i></i><i></i></div>`; }

function ListState({ s, empty, children }) {
  if (s.loading && !s.items.length) return html`<${Skeleton} />`;
  if (s.error) return html`<div class="qerr" role="alert">${icon('alert', { size: 18 })}<div><b>Could not load</b><span>${s.error}</span></div></div>`;
  if (!s.items.length) return html`<p class="lempty">${empty}</p>`;
  return children;
}

/** First positive (else first) prompt text of an API prompt, for list labels. */
function promptSnippet(prompt) {
  try {
    const g = detect(prompt).find((x) => x.id === 'prompt');
    const t = g && g.fields[0] && String(g.fields[0].value).replace(/\s+/g, ' ').trim();
    return t ? (t.length > 70 ? t.slice(0, 68) + '…' : t) : '';
  } catch { return ''; }
}

function RecentList({ onPick }) {
  const [s] = useList(async () => ((await getJSON('/pocket/api/history?limit=30&include_prompt=1')).history || [])
    .map((r) => ({ ...r, snippet: promptSnippet(r.prompt) })), []);
  return html`
    <${ListState} s=${s} empty="No finished runs yet. Queue something from the desktop UI and it will show up here.">
      <ul class="slist">
        ${s.items.map((r) => {
          const th = outThumb(r.outputs && r.outputs[0], r.ts);
          const bad = r.status && r.status !== 'success';
          const title = r.workflow_name || r.snippet || 'Run ' + String(r.prompt_id).slice(0, 6);
          return html`
            <li key=${r.prompt_id}>
              <button type="button" class="srow" onClick=${() => onPick(r)}>
                <span class="sthumb">${th ? html`<img src=${th} alt="" loading="lazy" decoding="async" onLoad=${(e) => e.target.classList.add('in')} />` : icon('image', { size: 20 })}</span>
                <span class="smain">
                  <strong>${title}</strong>
                  <span>${ago(r.ts)}${r.outputs && r.outputs.length ? ` · ${r.outputs.length} image${r.outputs.length === 1 ? '' : 's'}` : ''}${r.workflow_name && r.snippet ? ' · ' + r.snippet : ''}</span>
                </span>
                ${bad && html`<span class="pill bad">Failed</span>`}
                <span class="srow-go" aria-hidden="true">${icon('chevronR', { size: 18 })}</span>
              </button>
            </li>`;
        })}
      </ul>
    <//>`;
}

function WorkflowList({ onPick, onCanvas }) {
  const [s, reload] = useList(async () => (await getJSON('/pocket/api/workflows')).workflows || [], []);
  const [q, setQ] = useState('');
  const t = q.trim().toLowerCase();
  const items = t ? s.items.filter((w) => w.path.toLowerCase().includes(t)) : s.items;
  return html`
    <${ListState} s=${s} empty="No saved workflows found in your ComfyUI user folder.">
      ${s.items.length > 6 && html`<label class="search gs-search">${icon('search', { size: 18 })}<input type="search" placeholder="Search workflows" aria-label="Search workflows" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>`}
      <ul class="slist">
        ${items.map((w) => {
          const dir = w.path.includes('/') ? w.path.slice(0, w.path.lastIndexOf('/')) : '';
          return html`
            <li key=${w.path} class="srow wf">
              <button type="button" class="srow-main" onClick=${() => onPick(w, false)}>
                <span class="sthumb ic">${icon('workflow', { size: 22 })}</span>
                <span class="smain">
                  <strong>${w.name}</strong>
                  <span>${dir || 'Workflows'}</span>
                </span>
                ${!w.has_snapshot ? html`<span class="pill dim">Needs prep</span>` : w.stale ? html`<span class="pill warn">Stale</span>` : html`<span class="pill ok">Ready</span>`}
              </button>
              <button type="button" class="icon-btn small" aria-label=${`Re-convert ${w.name}`} title="Re-convert from the saved workflow" onClick=${() => onPick(w, true)}>${icon('refresh', { size: 18 })}</button>
              <button type="button" class="icon-btn small" aria-label=${`Open ${w.name} in canvas`} title="Open in canvas" onClick=${() => onCanvas(w)}>${icon('workflow', { size: 18 })}</button>
            </li>`;
        })}
      </ul>
      ${!items.length && html`<p class="lempty">No match.</p>`}
    <//>`;
}

function PresetList({ onPick }) {
  const [s, reload] = useList(async () => (await getJSON('/pocket/api/presets')).presets || [], []);
  const del = async (p) => {
    if (!(await confirmDialog({ title: 'Delete preset?', message: `"${p.name}" will be removed.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await getJSON(`/pocket/api/presets?id=${enc(p.id)}`, { method: 'DELETE' }); toast('Preset deleted', 'ok'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return html`
    <${ListState} s=${s} empty="No presets yet. Edit a prompt and tap Save preset to keep your favourite setups.">
      <ul class="slist">
        ${s.items.map((p) => html`
          <li key=${p.id} class="srow wf">
            <button type="button" class="srow-main" onClick=${() => onPick(p)}>
              <span class="sthumb ic">${icon('bookmark', { size: 22 })}</span>
              <span class="smain"><strong>${p.name}</strong><span>Preset</span></span>
            </button>
            <button type="button" class="icon-btn small danger-ic" aria-label=${`Delete preset ${p.name}`} onClick=${() => del(p)}>${icon('trash', { size: 18 })}</button>
          </li>`)}
      </ul>
    <//>`;
}

const TABS = [['recent', 'Recent'], ['workflows', 'Workflows'], ['presets', 'Presets']];

function SourceSheet({ tab, setTab, onClose, onHistory, onWorkflow, onPreset, onCanvas }) {
  return html`
    <${Sheet} title="Start from" onClose=${onClose} tall>
      <div class="seg wide" role="tablist" aria-label="Source">
        ${TABS.map(([id, label]) => html`<button type="button" key=${id} role="tab" aria-selected=${tab === id ? 'true' : 'false'} class=${tab === id ? 'on' : ''} onClick=${() => setTab(id)}>${label}</button>`)}
      </div>
      <div class="sheet-list" role="tabpanel">
        ${tab === 'recent' && html`<${RecentList} onPick=${onHistory} />`}
        ${tab === 'workflows' && html`<${WorkflowList} onPick=${onWorkflow} onCanvas=${onCanvas} />`}
        ${tab === 'presets' && html`<${PresetList} onPick=${onPreset} />`}
      </div>
    <//>`;
}

function AddFieldSheet({ prompt, pins, shown, onToggle, onClose }) {
  const [q, setQ] = useState('');
  const nodes = useMemo(() => listInputs(prompt), [prompt]);
  const pinned = new Set(pins.map((p) => keyOf(p.node, p.input)));
  const t = q.trim().toLowerCase();
  const rows = nodes.map((n) => ({
    ...n,
    items: t ? n.items.filter((i) => `${n.title} ${n.cls} ${i.input} ${i.preview}`.toLowerCase().includes(t)) : n.items,
  })).filter((n) => n.items.length);
  return html`
    <${Sheet} title="Add field" onClose=${onClose} tall>
      <label class="search gs-search">${icon('search', { size: 18 })}<input type="search" placeholder="Search nodes and inputs" aria-label="Search inputs" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      <p class="lhint">Pin any node input to edit it from the main screen.</p>
      <div class="addlist">
        ${rows.map((n) => html`
          <section key=${n.node} class="addnode">
            <h3><span>${n.title}</span><em>#${n.node}${n.title !== n.cls ? ' · ' + n.cls : ''}</em></h3>
            ${n.items.map((i) => {
              const isPin = pinned.has(i.key);
              const auto = !isPin && shown.has(i.key);
              return html`
                <button key=${i.key} type="button" class=${'addrow' + (isPin ? ' on' : '')} disabled=${auto} aria-pressed=${isPin ? 'true' : 'false'}
                        onClick=${() => onToggle({ node: n.node, input: i.input, label: `${n.title} · ${humanize(i.input)}` })}>
                  <span class="addrow-m"><b>${humanize(i.input)}</b><em>${i.preview}</em></span>
                  ${auto ? html`<span class="pill dim">Shown</span>` : html`<span class=${'addchk' + (isPin ? ' on' : '')}>${isPin ? icon('check', { size: 16, sw: 2.6 }) : icon('plus', { size: 16, sw: 2.4 })}</span>`}
                </button>`;
            })}
          </section>`)}
        ${!rows.length && html`<p class="lempty">Nothing matches.</p>`}
      </div>
    <//>`;
}

function SaveSheet({ src, pins, onSave, onClose }) {
  const [name, setName] = useState(src && src.kind === 'preset' ? src.label : (src && src.label) || '');
  const [busy, setBusy] = useState(false);
  const update = src && src.kind === 'preset' && name.trim() === src.label;
  return html`
    <${Sheet} title="Save preset" onClose=${onClose}>
      <form onSubmit=${async (e) => { e.preventDefault(); if (!name.trim() || busy) return; setBusy(true); try { await onSave(name.trim()); } finally { setBusy(false); } }}>
        <label class="flabel" for="preset-name"><span class="flabel-t">Name</span></label>
        <input id="preset-name" class="txt" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Portrait, 3:4" value=${name} onInput=${(e) => setName(e.target.value)} />
        <p class="lhint">Saves the current prompt, all edited values${pins.length ? ` and ${pins.length} pinned field${pins.length === 1 ? '' : 's'}` : ''}. It can be reopened any time from Start from.</p>
        <div class="modal-actions">
          <button type="button" class="btn" onClick=${onClose}>Cancel</button>
          <button type="submit" class="btn primary" disabled=${!name.trim() || busy}>${update ? 'Update preset' : 'Save preset'}</button>
        </div>
      </form>
    <//>`;
}

function PrepCard({ prep, onCancel }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const secs = Math.round((Date.now() - prep.t0) / 1000);
  const text = { fetch: 'Reading workflow…', starting: 'Starting the converter…', converting: 'Converting nodes…', load: 'Loading…' }[prep.phase] || 'Working…';
  return html`
    <section class="qcard prep" role="status" aria-live="polite">
      <div class="prep-orb" aria-hidden="true"><i></i><span>${icon('sparkles', { size: 26, sw: 1.6 })}</span></div>
      <h2>Preparing ${prep.name}…</h2>
      <p class="prep-phase">${text}${secs >= 3 ? ` ${secs}s` : ''}</p>
      ${(prep.phase === 'starting' || prep.phase === 'converting' || prep.phase === 'fetch') && html`<p class="prep-hint">First time can take about 20 seconds. Next time it opens instantly.</p>`}
      <button type="button" class="btn small" onClick=${onCancel}>Cancel</button>
    </section>`;
}

function ErrorCard({ err, onClose }) {
  return html`
    <section class="qerr big" role="alert">
      ${icon('alert', { size: 20 })}
      <div>
        <b>${err.title}</b>
        ${err.detail && html`<span>${err.detail}</span>`}
        ${err.items.map((i, n) => html`<span key=${n}><strong>${i.title}</strong> · ${i.message}</span>`)}
      </div>
      <button type="button" class="icon-btn small" aria-label="Dismiss" onClick=${onClose}>${icon('x', { size: 18 })}</button>
    </section>`;
}

function GroupCard({ g, open, onToggle, handlers, rand }) {
  const nodes = new Set(g.fields.map((f) => f.node));
  const multi = nodes.size > 1;
  let last = null;
  return html`
    <section class=${'fgroup' + (open ? ' open' : '')} aria-label=${g.label}>
      <button type="button" class="fgroup-h" aria-expanded=${open ? 'true' : 'false'} onClick=${onToggle}>
        <span class="fgroup-ic">${icon(g.icon, { size: 18 })}</span>
        <span class="fgroup-t">${g.label}</span>
        <em>${g.fields.length}</em>
        <span class="fgroup-chev">${icon('chevronD', { size: 18 })}</span>
      </button>
      ${open && html`
        <div class="fgroup-b">
          ${g.fields.map((f) => {
            const head = multi && f.node !== last && f.kind !== 'text' && !f.pinned;
            last = f.node;
            return html`
              ${head && html`<div class="fnode" key=${'h' + f.node}><span>${f.nodeTitle}</span><em>#${f.node}</em></div>`}
              <${FieldRow} key=${f.key} f=${f} rand=${rand[f.key] !== false} ...${handlers} />`;
          })}
        </div>`}
    </section>`;
}

const KIND_IC = { history: 'history', workflow: 'workflow', preset: 'bookmark', remix: 'remix' };
const KIND_LABEL = { history: 'Recent run', workflow: 'Workflow', preset: 'Preset', remix: 'Remix' };

function SourceCard({ src, onChange }) {
  return html`
    <section class="srcard" aria-label="Current source">
      <span class=${'src-ic' + (src.thumb ? ' img' : '')}>
        ${src.thumb ? html`<img src=${src.thumb} alt="" onLoad=${(e) => e.target.classList.add('in')} />` : icon(KIND_IC[src.kind] || 'sparkles', { size: 22 })}
      </span>
      <span class="src-main">
        <span class="src-k">${KIND_LABEL[src.kind] || 'Source'}${src.stale ? html` <i class="pill warn">Stale</i>` : ''}</span>
        <strong>${src.label}</strong>
        ${src.sub && html`<span class="src-sub">${src.sub}</span>`}
      </span>
      <button type="button" class="btn small" onClick=${onChange}>Change</button>
    </section>`;
}

function ModeSwitch({ src, onCanvas }) {
  const ok = canCanvas(src);
  const chip = ok && lastModeFor(src.path) === 'canvas';
  return html`
    <div class="modesw">
      <div class="seg" role="group" aria-label="Editing mode">
        <button type="button" class="on" aria-pressed="true">Simple</button>
        <button type="button" disabled=${!ok} aria-pressed="false" data-act="canvas" onClick=${onCanvas}>Canvas</button>
      </div>
      ${!ok && html`<span class="lhint">Canvas needs a saved workflow</span>`}
      ${chip && html`<button type="button" class="chip" data-act="continue-canvas" onClick=${onCanvas}>Continue in canvas</button>`}
    </div>`;
}

function Hero({ onOpen }) {
  const tiles = [
    ['recent', 'history', 'Recent runs', 'Remix anything you already made'],
    ['workflows', 'workflow', 'Saved workflows', 'Run your own graphs from the phone'],
    ['presets', 'bookmark', 'Presets', 'Your saved prompt setups'],
  ];
  return html`
    <section class="hero">
      <div class="empty-art">${icon('sparkles', { size: 34, sw: 1.5 })}</div>
      <h2>What are we making?</h2>
      <p>Start from a past run, a saved workflow or a preset. Change the prompt and settings, then queue it.</p>
      <div class="startgrid">
        ${tiles.map(([id, ic, t, d]) => html`
          <button type="button" key=${id} class="start" onClick=${() => onOpen(id)}>
            <span class="start-ic">${icon(ic, { size: 22 })}</span>
            <span class="start-t"><strong>${t}</strong><em>${d}</em></span>
            <span class="srow-go" aria-hidden="true">${icon('chevronR', { size: 18 })}</span>
          </button>`)}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- view
const EMPTY = { src: null, prompt: null, base: null, pins: [], rand: {}, runs: 1 };

export function Generate({ active, params }) {
  const [st, setSt] = useState(() => {
    if (params && (params.remix || params.wfpath)) return EMPTY;
    const last = readLast();
    return last ? { ...EMPTY, src: last.src, prompt: last.prompt, pins: last.pins || [], rand: last.rand || {}, runs: last.runs || 1, sec: last.sec && last.sec.path ? last.sec : null } : EMPTY;
  });
  const [infoVer, setInfoVer] = useState(0);
  const [sheet, setSheet] = useState(null);   // null | {kind:'source', tab} | 'add' | 'save'
  const [prep, setPrep] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(null);
  const [lastRun, setLastRun] = useState(null);   // prompt id of the last queued run: its text outputs show in the result card
  const q = useQueue();
  const [closed, setClosed] = useState({});
  const root = useRef(null);
  const abortRef = useRef(null);
  const seqRef = useRef(0);
  const uiCache = useRef(new Map());
  const hold = useRef(!!(params && (params.remix || params.wfpath))); // no session saving until the first load lands (it would wipe the stored session)
  const stRef = useRef(st);
  stRef.current = st;
  const secTimer = useRef(0);
  const secSeq = useRef(0);
  const loadSeq = useRef(0); // bumped when a different source is loaded (not on re-convert of the same workflow)
  const [secErr, setSecErr] = useState(null);

  // ---- derived
  const groups = useMemo(() => (st.prompt ? detect(st.prompt, st.pins) : []), [st.prompt, st.pins, infoVer]);
  // desktop parity: each seed's control_after_generate (from the converter's structure.controls) decides if it randomizes; explicit toggles in st.rand win
  const ctls = st.sec && st.sec.structure ? st.sec.structure.controls : null;
  const sd = useMemo(() => (st.prompt ? seedDefaults(groups, st.prompt, ctls) : { rand: {}, step: {} }), [groups, st.prompt, ctls]);
  const randEff = useMemo(() => ({ ...sd.rand, ...st.rand }), [sd, st.rand]);
  const clsSig = useMemo(() => classesToFetch(groups, st.pins, st.prompt).sort().join('|'), [groups]);
  useEffect(() => {
    if (!clsSig) return;
    let dead = false;
    ensureInfo(clsSig.split('|')).then((fresh) => { if (fresh && !dead) setInfoVer((v) => v + 1); });
    return () => { dead = true; };
  }, [clsSig]);

  // persist (debounced) + per-workflow pins
  useEffect(() => {
    if (hold.current && !st.prompt) return undefined;
    const id = setTimeout(() => writeLast(st), 350);
    return () => clearTimeout(id);
  }, [st]);
  useEffect(() => { if (st.src && st.src.kind === 'workflow') writePins(st.src.path, st.pins); }, [st.pins]);
  useEffect(() => { if (st.sec && st.src && st.src.kind === 'workflow' && st.sec.path === st.src.path) writeModes(st.sec.path, st.sec.modes); }, [st.sec && st.sec.modes]);
  // a workflow whose structure has no seed controls yet (older snapshot / not loaded): convert once so seeds follow the desktop's control_after_generate
  const ctlTried = useRef('');
  useEffect(() => {
    const sec = st.sec;
    if (!sec || sec.dirty || !sec.path || (sec.structure && sec.structure.controls) || ctlTried.current === sec.path) return;
    ctlTried.current = sec.path;
    queueSecConvert({});
  }, [st.sec && st.sec.path, st.sec && st.sec.structure]);
  // a session restored mid-conversion (reload while a toggle was pending): redo it
  useEffect(() => {
    if (stRef.current.sec && stRef.current.sec.dirty) secTimer.current = setTimeout(runSecConvert, 200);
    return () => clearTimeout(secTimer.current);
  }, []);

  // ---- loading
  const scrollTop = () => { const sc = root.current && root.current.parentElement; if (sc) sc.scrollTop = 0; };

  const apply = ({ src, prompt, pins = [], newSeed, sec = null }) => {
    if (!prompt || typeof prompt !== 'object' || !Object.keys(prompt).length) throw new Error('This source has no usable prompt');
    hold.current = false;
    { const key = (x) => (x ? `${x.kind}|${x.path || x.id || x.label}` : ''); if (key(stRef.current.src) !== key(src)) loadSeq.current++; }
    let p = cloneJSON(prompt);
    const base = cloneJSON(prompt);
    const gs = detect(p, pins);
    if (newSeed) { const d = seedDefaults(gs, p, sec && sec.structure ? sec.structure.controls : null); p = reseed(p, gs, d.rand, null, d.step); }
    p = fixSeeds(p, gs);
    clearTimeout(secTimer.current); secSeq.current++; setSecErr(null);
    setSt((s) => ({ src, prompt: p, base, pins, rand: {}, runs: s.runs, sec }));
    if (sec && sec.dirty) secTimer.current = setTimeout(runSecConvert, 150);
    setQueued(null); setLastRun(null); setErr(null); setSheet(null); setClosed({});
    scrollTop();
  };

  const runLoad = async (name, fn) => {
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const my = ++seqRef.current;
    setPrep({ name, phase: 'load', t0: Date.now() });
    setSheet(null); setErr(null);
    const setPhase = (phase) => { if (seqRef.current === my) setPrep((p) => (p ? { ...p, phase } : p)); };
    try {
      const res = await fn({ signal: ac.signal, setPhase });
      if (seqRef.current !== my) return;
      apply(res);
    } catch (e) {
      if (seqRef.current !== my || (e && e.name === 'AbortError')) return;
      setErr({ title: `Could not open ${name}`, detail: e.message || String(e), items: [] });
      haptic(20);
    } finally {
      if (seqRef.current === my) setPrep(null);
    }
  };

  const cancelPrep = () => { if (abortRef.current) abortRef.current.abort(); seqRef.current++; setPrep(null); };

  const loadHistory = (r) => runLoad(r.workflow_name || 'run', async () => {
    const prompt = r.prompt || ((await getJSON(`/pocket/api/history/item?id=${enc(r.prompt_id)}`)) || {}).prompt;
    return {
      src: { kind: 'history', id: r.prompt_id, label: r.workflow_name || r.snippet || 'Run ' + String(r.prompt_id).slice(0, 6), sub: ago(r.ts), thumb: outThumb(r.outputs && r.outputs[0], r.ts) },
      prompt,
      newSeed: true,
    };
  });

  const loadWorkflow = (w, force) => runLoad(w.name, async ({ signal, setPhase }) => {
    const mk = (prompt, stale, sec) => ({ src: { kind: 'workflow', path: w.path, label: w.name, sub: w.path, stale: !!stale }, prompt, pins: readPins(w.path), sec });
    // saved sections state: the server snapshot's (if it stores one), else this phone's; a prompt that predates it needs a re-convert
    const secFromSnap = (snap) => {
      const local = readModes(w.path);
      const hasLocal = !sameModes(local, {});
      if (snap.structure) return newSec(w.path, snap.modes || local, snap.structure, !snap.modes && hasLocal);
      return newSec(w.path, local, null, hasLocal);
    };
    const snapUrl = `/pocket/api/snapshots?path=${enc(w.path)}`;
    if (!force && w.has_snapshot && !w.stale) {
      const snap = await getJSON(snapUrl, { signal });
      return mk(snap.prompt, false, secFromSnap(snap));
    }
    setPhase('fetch');
    const ui = await getJSON(`/pocket/api/workflows/file?path=${enc(w.path)}`, { signal });
    uiCache.current.set(w.path, ui);
    if (isApiFormat(ui)) return mk(ui, false, null);   // an API-format file already is the prompt: no converter, no Sections
    try {
      const modes = readModes(w.path);
      const { prompt, structure } = await convertWorkflowFull(ui, w.path, { signal, onPhase: setPhase, modes });
      try {
        await getJSON(`/pocket/api/snapshots?path=${enc(w.path)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, workflow_mtime: null, source: 'phone', modes, structure }),
        });
      } catch { toast('Converted, but saving the snapshot failed', 'error'); }
      return mk(prompt, false, newSec(w.path, modes, structure, false));
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (w.has_snapshot) {
        const snap = await getJSON(snapUrl, { signal });
        toast('Conversion failed, using the older snapshot', 'error', 4200);
        return mk(snap.prompt, true, secFromSnap(snap));
      }
      throw e;
    }
  });

  const loadPreset = (p) => runLoad(p.name, async () => {
    const d = await getJSON(`/pocket/api/presets?id=${enc(p.id)}`);
    return {
      src: { kind: 'preset', id: d.id || p.id, label: d.name || p.name, sub: 'Preset' },
      prompt: d.prompt,
      sec: d.wf_path ? newSec(d.wf_path, d.modes || {}, d.structure || null, false) : null,
      pins: (d.fields || []).filter((x) => x && x.node !== undefined && x.input).map((x) => ({ node: String(x.node), input: x.input, label: x.label })),
    };
  });

  // save the session first (the debounced save may not have run yet), then hand over to the canvas editor
  const openCanvas = (path) => {
    if (!path) return;
    if (stRef.current.prompt) writeLast(stRef.current);
    writeMode(path, 'canvas');
    location.href = canvasUrl(path);
  };

  // coming back from canvas: "#/generate?wfpath=<path>" reloads that workflow from disk (its file changed), bypassing snapshots
  const wfPath = wfPathParam(params);
  useEffect(() => {
    if (!wfPath) return;
    if (location.hash.startsWith('#/generate')) history.replaceState(null, '', '#/generate');
    writeMode(wfPath, 'simple');
    loadWorkflow({ name: baseName(wfPath).replace(/\.json$/i, ''), path: wfPath, has_snapshot: false }, true);
  }, [wfPath]);

  const remixPath = params && params.remix;
  useEffect(() => {
    if (!remixPath) return;
    // the remix is consumed: back / reload must not re-run it and discard edits
    if (location.hash.startsWith('#/generate')) history.replaceState(null, '', '#/generate');
    runLoad(baseName(remixPath), async () => {
      const m = await getJSON(`/pocket/api/meta?path=${enc(remixPath)}`);
      if (!m || !m.has_prompt || !m.prompt) throw new Error('This image has no embedded prompt to remix.');
      return {
        src: { kind: 'remix', path: remixPath, label: baseName(remixPath), sub: 'Remixed from an image', thumb: thumbUrl({ path: remixPath }, 160) },
        prompt: m.prompt,
        newSeed: true,
      };
    });
  }, [remixPath]);

  // ---- editing
  const onSet = useCallback((f, v) => {
    setSt((s) => {
      let prompt = s.prompt;
      if (f.kind === 'size') prompt = setInput(setInput(prompt, f.node, 'width', v.w), f.node, 'height', v.h);
      else prompt = setInput(prompt, f.node, f.input, v);
      // typing a seed by hand means "use this one": switch randomize off
      const rand = f.kind === 'seed' && s.rand[f.key] !== false ? { ...s.rand, [f.key]: false } : s.rand;
      return { ...s, prompt, rand };
    });
  }, []);
  const onDice = useCallback((f) => setSt((s) => ({ ...s, prompt: setInput(s.prompt, f.node, f.input, randomSeed(f.spec && f.spec.max)), rand: s.rand[f.key] !== false ? { ...s.rand, [f.key]: false } : s.rand })), []); // every run reseeds, so a picked seed only sticks with randomize off
  const onRand = useCallback((f, on) => setSt((s) => ({ ...s, rand: { ...s.rand, [f.key]: on } })), []);
  const onUnpin = useCallback((f) => setSt((s) => ({ ...s, pins: s.pins.filter((p) => keyOf(p.node, p.input) !== f.key) })), []);
  const getIdent = useCallback(() => { const x = stRef.current.src; return x ? `${x.kind}|${x.path || x.id || x.label}|${loadSeq.current}` : ''; }, []); // async uploads compare this before applying their result
  const handlers = useMemo(() => ({ onSet, onDice, onRand, onUnpin, getIdent }), [onSet, onDice, onRand, onUnpin, getIdent]);

  const togglePin = (pin) => setSt((s) => {
    const k = keyOf(pin.node, pin.input);
    const has = s.pins.some((p) => keyOf(p.node, p.input) === k);
    return { ...s, pins: has ? s.pins.filter((p) => keyOf(p.node, p.input) !== k) : [...s.pins, pin] };
  });

  const shownKeys = useMemo(() => {
    const k = new Set();
    for (const g of groups) {
      if (g.id === 'pinned') continue;
      for (const f of g.fields) { if (f.kind === 'size') { k.add(keyOf(f.node, 'width')); k.add(keyOf(f.node, 'height')); } else k.add(f.key); }
    }
    return k;
  }, [groups]);

  // ---- save preset
  const savePreset = async (name) => {
    try {
      let id = (st.src && st.src.kind === 'preset' && st.src.label === name) ? st.src.id
        : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'preset';
      if (!(st.src && st.src.kind === 'preset' && st.src.id === id)) {
        const list = (await getJSON('/pocket/api/presets')).presets || [];
        const taken = new Map(list.map((p) => [p.id, p.name]));
        let n = 2;
        const root_ = id;
        while (taken.has(id) && taken.get(id) !== name) id = `${root_}-${n++}`.slice(0, 64);
      }
      await getJSON(`/pocket/api/presets?id=${enc(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt: st.prompt, fields: st.pins.map((p) => ({ node: p.node, input: p.input, label: p.label || '' })), source: 'phone',
          ...(st.sec ? { wf_path: st.sec.path, modes: st.sec.modes, structure: st.sec.structure } : {}) }),
      });
      setSt((s) => ({ ...s, src: { kind: 'preset', id, label: name, sub: 'Preset' }, base: cloneJSON(s.prompt) }));
      setSheet(null);
      haptic(12);
      toast('Preset saved', 'ok');
    } catch (e) { toast(e.message || 'Could not save preset', 'error'); }
  };

  const resetEdits = () => { if (st.base) { setSt((s) => ({ ...s, prompt: cloneJSON(s.base), rand: {} })); haptic(8); toast('Reset to the loaded values', 'ok', 1600); } };

  // ---- sections (workflow groups / nodes on, off)
  const fetchUi = async (path) => {
    if (uiCache.current.has(path)) return uiCache.current.get(path);
    const ui = await getJSON(`/pocket/api/workflows/file?path=${enc(path)}`);
    uiCache.current.set(path, ui);
    return ui;
  };

  // Re-convert the saved UI workflow with the current overrides, then put the user's edited values back on the new prompt.
  async function runSecConvert() {
    const sec = stRef.current.sec;
    if (!sec) return;
    const my = ++secSeq.current;
    try {
      const ui = await fetchUi(sec.path);
      const { prompt, structure } = await convertWorkflowFull(ui, sec.path, { modes: sec.modes });
      if (secSeq.current !== my) return;   // a newer toggle took over
      const cur = stRef.current;
      if (!cur.sec || cur.sec.path !== sec.path) return;
      const done = sameModes(cur.sec.modes, sec.modes);
      setSt((s) => {
        if (!s.sec || s.sec.path !== sec.path) return s;
        const merged = mergeValues(prompt, s.prompt);
        const gs = detect(merged, s.pins);
        return {
          ...s, prompt: fixSeeds(merged, gs), base: cloneJSON(mergeValues(prompt, s.base || s.prompt)),
          sec: { ...s.sec, structure, okModes: { ...sec.modes }, dirty: !done },
        };
      });
      setSecErr(null);
      if (done && cur.src && cur.src.kind === 'workflow') {
        // remember the sections with the phone snapshot (the pure converted prompt, no edits)
        getJSON(`/pocket/api/snapshots?path=${enc(sec.path)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, workflow_mtime: null, source: 'phone', modes: sec.modes, structure }),
        }).catch(() => {});
      }
    } catch (e) {
      if (secSeq.current !== my) return;
      // undo the toggles that could not be applied: the prompt still matches the last good modes
      setSt((s) => (s.sec && s.sec.path === sec.path ? { ...s, sec: { ...s.sec, modes: { ...s.sec.okModes }, dirty: false } } : s));
      setSecErr(`Could not update sections: ${(e && e.message) || e}`);
      haptic(20);
    }
  }

  const queueSecConvert = (patch) => {
    setSt((s) => (s.sec ? { ...s, sec: { ...s.sec, modes: { ...s.sec.modes, ...patch }, dirty: true } } : s));
    setSecErr(null);
    clearTimeout(secTimer.current);
    secTimer.current = setTimeout(runSecConvert, 350);   // debounce rapid toggles
  };
  const onSecGroup = (title, on, ctl) => {
    const sec = stRef.current.sec;
    if (!sec || !sec.structure) return;
    const r = groupPatch(sec.structure, sec.modes, title, on, ctl);
    if (!r) return;
    if (r.blocked) { toast('Keep at least one group on (this controller is "always one")', 'error', 2600); haptic(15); return; }
    queueSecConvert(r.patch);
  };
  const onSecNode = (id, on, offMode) => queueSecConvert({ [id]: on ? 0 : offMode === 2 ? 2 : 4 });
  const onSecLoad = () => queueSecConvert({});

  // ---- queue
  const getUi = async () => {
    const path = st.sec ? st.sec.path : (st.src && st.src.kind === 'workflow' ? st.src.path : null);
    if (!path) return null;
    try {
      const ui = await fetchUi(path);
      return isApiFormat(ui) ? null : applyModesToUi(ui, st.sec && st.sec.modes);   // an API-format file has no UI workflow to embed
    } catch { return null; }
  };

  const generate = async () => {
    if (busy || !st.prompt || (st.sec && st.sec.dirty)) return;
    setBusy(true); setErr(null); setQueued(null);
    haptic(12);
    let prompt = cloneJSON(st.prompt);
    const ids = [];
    try {
      const ui = await getUi();
      const extra = ui ? { extra_pnginfo: { workflow: ui } } : null;
      const name = (st.src && st.src.label) || 'Pocket run';
      let warn = 0;
      for (let i = 0; i < st.runs; i++) {
        prompt = fixSeeds(reseed(prompt, groups, randEff, null, Object.fromEntries(Object.entries(sd.step).filter(([k]) => st.rand[k] === undefined))), groups); // every run, including the first: an unchanged prompt is served from cache
        const body = { prompt, client_id: ws.clientId };
        if (extra) body.extra_data = extra;
        const r = await postJSON('/prompt', body);
        if (r && r.prompt_id) { ids.push(r.prompt_id); queueStore.nameJob(r.prompt_id, name); }
        if (r && r.node_errors && Object.keys(r.node_errors).length) warn++;
      }
      // show the seeds of the last queued run (randomized or fixed up), unless the user moved on to another source meanwhile
      setSt((s) => {
        if (s.src !== st.src || !s.prompt) return s;
        let p = s.prompt;
        for (const f of seedFields(groups, prompt)) {
          const cur = p[f.node] && p[f.node].inputs;
          const next = prompt[f.node].inputs[f.input];
          if (cur && f.input in cur && next !== st.prompt[f.node].inputs[f.input]) p = setInput(p, f.node, f.input, next);
        }
        return { ...s, prompt: p };
      });
      setQueued({ n: ids.length, at: Date.now() });
      if (ids.length) setLastRun(ids[ids.length - 1]);
      if (warn) toast('Queued, but some nodes reported problems', 'error', 4000);
      queueStore.sync();
    } catch (e) {
      const ex = explainError(e, prompt);
      if (ids.length) ex.title = `Queued ${ids.length} of ${st.runs}. ${ex.title}`;
      setErr(ex);
      scrollTop();
      if (ids.length) { setQueued({ n: ids.length, at: Date.now() }); queueStore.sync(); }
      haptic(30);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!queued) return;
    const id = setTimeout(() => setQueued(null), 12000);
    return () => clearTimeout(id);
  }, [queued]);

  // text outputs of the last queued run (PreviewAny etc.): from the finished history row, or live from the websocket
  const runRow = lastRun && q.recent.find((r) => r.id === lastRun);
  const runTexts = lastRun ? ((runRow && runRow.texts && runRow.texts.length ? runRow.texts : q.liveTexts[lastRun]) || []) : [];
  const runLive = !!(lastRun && q.running && q.running.id === lastRun);

  const hasPrompt = !!st.prompt;
  const sourceSheet = sheet && sheet.kind === 'source';

  return html`
    <div class=${'gen' + (hasPrompt ? ' has' : '')} ref=${root}>
      ${prep && html`<${PrepCard} prep=${prep} onCancel=${cancelPrep} />`}
      ${err && html`<${ErrorCard} err=${err} onClose=${() => setErr(null)} />`}
      ${!hasPrompt && !prep && html`<${Hero} onOpen=${(tab) => setSheet({ kind: 'source', tab })} />`}
      ${hasPrompt && !prep && html`
        <${SourceCard} src=${st.src} onChange=${() => setSheet({ kind: 'source', tab: 'recent' })} />
        <${ModeSwitch} src=${st.src} onCanvas=${() => openCanvas(st.src.path)} />
        <div class="gentools">
          <button type="button" class="chip" onClick=${() => setSheet('save')}>${icon('save', { size: 16 })}Save preset</button>
          <button type="button" class="chip" onClick=${() => setSheet('add')}>${icon('plus', { size: 16 })}Add field</button>
          <button type="button" class="chip" onClick=${() => setSheet('nodes')}>${icon('sliders', { size: 16 })}All nodes</button>
          ${st.base && html`<button type="button" class="chip" onClick=${resetEdits}>${icon('undo', { size: 16 })}Reset</button>`}
          ${st.src && st.src.kind === 'workflow' && st.sec && html`<button type="button" class="chip" onClick=${() => loadWorkflow({ name: st.src.label, path: st.src.path, has_snapshot: true, stale: true }, true)}>${icon('refresh', { size: 16 })}Re-convert</button>`}
        </div>
        ${runTexts.length > 0 && html`
          <section class="resultcard" aria-label="Text output of the last run">
            <div class="resultcard-h">${icon('sparkles', { size: 18 })}<span>Text output</span><em>${runLive ? 'running…' : 'last run'}</em>
              <button type="button" class="icon-btn small" aria-label="Dismiss text output" onClick=${() => setLastRun(null)}>${icon('x', { size: 17 })}</button></div>
            <${TextOutputs} texts=${runTexts} />
          </section>`}
        ${st.sec && html`<${SectionsCard} sec=${st.sec} busy=${st.sec.dirty} err=${secErr} onGroup=${onSecGroup} onNode=${onSecNode} onLoad=${onSecLoad} />`}
        ${groups.length ? groups.map((g) => html`
          <${GroupCard} key=${g.id} g=${g} open=${!closed[g.id]} onToggle=${() => setClosed((c) => ({ ...c, [g.id]: !c[g.id] }))} handlers=${handlers} rand=${randEff} />`)
          : html`<p class="lempty">No editable fields were detected in this prompt. Use Add field to pin any input.</p>`}
        <button type="button" class="addbtn" onClick=${() => setSheet('add')}>${icon('plus', { size: 18 })}Add field</button>
        <div class="genbar" role="region" aria-label="Queue">
          ${queued && html`
            <div class="qdone" role="status">
              <span class="qdone-ic">${icon('checkCircle', { size: 20 })}</span>
              <span>Queued${queued.n > 1 ? ` ×${queued.n}` : ''}</span>
              <button type="button" class="linkbtn" onClick=${() => navigate('queue')}>View progress${icon('arrowR', { size: 14, sw: 2.2 })}</button>
            </div>`}
          <div class="genbar-row">
            <div class="runs" role="group" aria-label="How many times to queue">
              <button type="button" aria-label="Fewer runs" disabled=${st.runs <= 1} onClick=${() => { haptic(5); setSt((s) => ({ ...s, runs: Math.max(1, s.runs - 1) })); }}>${icon('minus', { size: 18, sw: 2.2 })}</button>
              <span aria-live="polite"><b>×${st.runs}</b></span>
              <button type="button" aria-label="More runs" disabled=${st.runs >= 8} onClick=${() => { haptic(5); setSt((s) => ({ ...s, runs: Math.min(8, s.runs + 1) })); }}>${icon('plus', { size: 18, sw: 2.2 })}</button>
            </div>
            <button type="button" class="btn primary gen-go" disabled=${busy || !!(st.sec && st.sec.dirty)} onClick=${generate}>
              ${busy ? html`<span class="spinner-s white"></span>Queuing…` : html`${icon('sparkles', { size: 20 })}Generate${st.runs > 1 ? ` ×${st.runs}` : ''}`}
            </button>
          </div>
        </div>`}
      ${sourceSheet && html`<${SourceSheet} tab=${sheet.tab} setTab=${(tab) => setSheet({ kind: 'source', tab })} onClose=${() => setSheet(null)} onHistory=${loadHistory} onWorkflow=${loadWorkflow} onCanvas=${(w) => openCanvas(w.path)} onPreset=${loadPreset} />`}
      ${sheet === 'nodes' && hasPrompt && html`<${NodesSheet} Sheet=${Sheet} prompt=${st.prompt} sec=${st.sec} rand=${randEff} handlers=${handlers} onNode=${st.sec && st.sec.structure ? onSecNode : null} onLoad=${onSecLoad} busy=${!!(st.sec && st.sec.dirty)} onClose=${() => setSheet(null)} />`}
      ${sheet === 'add' && hasPrompt && html`<${AddFieldSheet} prompt=${st.prompt} pins=${st.pins} shown=${shownKeys} onToggle=${togglePin} onClose=${() => setSheet(null)} />`}
      ${sheet === 'save' && hasPrompt && html`<${SaveSheet} src=${st.src} pins=${st.pins} onSave=${savePreset} onClose=${() => setSheet(null)} />`}
    </div>`;
}
