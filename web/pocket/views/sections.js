// "Sections" card on the Generate view: the desktop's Fast Groups Bypasser/Muter toggles, every group, and a per-node bypass list.
// Pure state logic lives in ../sections-model.js; generate.js owns the modes and the re-convert.
import { useState, useMemo } from 'preact/hooks';
import { html, icon } from '../ui.js';
import { Switch } from '../controls.js';
import { nodeMap, groupState, nodeRows, effMode, findGroup, groupKey } from '../sections-model.js';

const short = (t) => String(t || '').trim();

function GroupRow({ title, st, disabled, onChange }) {
  return html`
    <div class=${'secrow' + (st.on ? ' on' : '')}>
      <span class="secrow-t">${short(title)}</span>
      ${st.on && !st.all && st.n > 1 && html`<span class="pill dim">partial</span>`}
      <${Switch} on=${st.on} onChange=${disabled ? () => {} : onChange} label=${`${short(title)} ${st.on ? 'on' : 'off'}`} />
    </div>`;
}

export function SectionsCard({ sec, busy, err, onGroup, onNode, onLoad }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const [adv, setAdv] = useState(false);
  const structure = sec.structure;
  const nmap = useMemo(() => nodeMap(structure), [structure]);
  const rows = useMemo(() => nodeRows(structure), [structure]);
  const stateOf = (g) => (g ? groupState(structure, sec.modes, g, nmap) : null);

  const controllers = (structure && structure.controllers) || [];
  const groups = (structure && structure.groups) || [];

  return html`
    <section class=${'fgroup sections' + (open ? ' open' : '')} aria-label="Sections" aria-busy=${busy ? 'true' : 'false'}>
      <button type="button" class="fgroup-h" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
        <span class="fgroup-ic">${icon('sliders', { size: 18 })}</span>
        <span class="fgroup-t">Sections</span>
        ${busy && html`<span class="spinner-s" role="status" aria-label="Updating"></span>`}
        <span class="fgroup-chev">${icon('chevronD', { size: 18 })}</span>
      </button>
      ${open && html`
        <div class="fgroup-b sec-b">
          ${err && html`<p class="sec-err" role="alert">${err}</p>`}
          ${!structure && html`
            <p class="sec-hint">Turn parts of this workflow on or off, like the groups on the desktop.</p>
            <button type="button" class="btn primary" disabled=${busy} onClick=${onLoad}>${busy ? html`<span class="spinner-s white"></span>Loading…` : 'Load sections'}</button>`}
          ${structure && controllers.map((c) => html`
            <div class="sec-ctl" key=${c.id}>
              <div class="fnode"><span>${short(c.title)}</span><em>${c.kind === 'mute' ? 'mutes' : 'bypasses'}${c.restriction && c.restriction !== 'default' ? ` · ${c.restriction}` : ''}</em></div>
              ${c.groups.length ? c.groups.map((ref) => { const g = findGroup(structure, ref); const s = stateOf(g); return s && html`<${GroupRow} key=${ref} title=${g.title} st=${s} onChange=${(on) => onGroup(ref, on, c)} />`; })
                : html`<p class="sec-hint">No groups match this controller.</p>`}
            </div>`)}
          ${structure && !controllers.length && !groups.length && html`<p class="sec-hint">This workflow has no groups. Use the node list below to bypass single nodes.</p>`}
          ${structure && groups.length > 0 && html`
            <button type="button" class="sec-disc" aria-expanded=${all ? 'true' : 'false'} onClick=${() => setAll(!all)}>
              <span>All groups</span><em>${groups.length}</em><span class=${'sec-chev' + (all ? ' up' : '')}>${icon('chevronD', { size: 16 })}</span>
            </button>
            ${all && html`<div class="sec-list">${groups.map((g, i) => html`<${GroupRow} key=${groupKey(g, i)} title=${g.title} st=${groupState(structure, sec.modes, g, nmap)} onChange=${(on) => onGroup(groupKey(g, i), on, null)} />`)}</div>`}`}
          ${structure && rows.length > 0 && html`
            <button type="button" class="sec-disc" aria-expanded=${adv ? 'true' : 'false'} onClick=${() => setAdv(!adv)}>
              <span>Advanced: single nodes</span><em>${rows.length}</em><span class=${'sec-chev' + (adv ? ' up' : '')}>${icon('chevronD', { size: 16 })}</span>
            </button>
            ${adv && html`<div class="sec-list">${rows.map((r) => {
              const on = effMode(structure, sec.modes, r.id, nmap) === 0;
              return html`
                <div class=${'secrow' + (on ? ' on' : '') + (r.depth ? ' sub' : '')} key=${r.id}>
                  <span class="secrow-t">${short(r.title)}<em>#${r.id}</em></span>
                  <${Switch} on=${on} onChange=${(v) => onNode(r.id, v)} label=${`${short(r.title)} ${on ? 'enabled' : 'bypassed'}`} />
                </div>`;
            })}</div>`}`}
        </div>`}
    </section>`;
}
