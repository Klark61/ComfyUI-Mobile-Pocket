// "All nodes" editor: every node of the current prompt, grouped like the workflow's groups, with all literal inputs and a bypass toggle.
// Edits go through Generate's handlers (same prompt object); bypass goes through Generate's Sections re-convert (onNode).
import { useState, useMemo, useEffect } from 'preact/hooks';
import { html, icon } from '../ui.js';
import { Switch, FieldRow } from '../controls.js';
import { ensureInfo } from '../fields.js';
import { nodeSections, filterSections } from '../nodes-model.js';

function NodeCard({ n, open, onToggle, handlers, rand, onNode, busy }) {
  return html`
    <div class=${'nnode' + (n.on ? '' : ' off')} data-node=${n.key}>
      <div class="nnode-h">
        <button type="button" class="nnode-t linkbtn" style="flex:1;min-width:0;text-align:left" aria-expanded=${open ? 'true' : 'false'} onClick=${onToggle}>
          <span class="nt"><b>${n.title}</b><em>#${n.key} · ${n.type}${n.fields.length ? ` · ${n.fields.length}` : ''}${n.on ? '' : n.inherited ? ` · ${n.mode === 2 ? 'muted' : 'bypassed'} (subgraph)` : n.mode === 2 ? ' · muted' : ' · bypassed'}</em></span>
        </button>
        ${n.bypassable && onNode && html`<${Switch} on=${n.on} disabled=${busy || n.inherited} onChange=${(v) => onNode(n.uiId, v, n.offMode)} label=${`${n.title} ${n.on ? 'enabled' : n.mode === 2 ? 'muted' : 'bypassed'}`} />`}
      </div>
      ${open && html`
        <div class="nnode-b">
          ${n.fields.map((f) => html`<${FieldRow} key=${f.key} f=${f} rand=${rand[f.key] !== false} ...${handlers} />`)}
          ${!n.fields.length && html`<p class="fhint">${n.on ? 'No editable inputs.' : `${n.mode === 2 ? 'Muted' : 'Bypassed'}: turn it on to edit its inputs.`}</p>`}
        </div>`}
    </div>`;
}

export function NodesSheet({ Sheet, prompt, sec, rand, handlers, onNode, onLoad, busy, onClose }) {
  const [q, setQ] = useState('');
  const [openN, setOpenN] = useState({});
  const [closedG, setClosedG] = useState({});
  const [bump_, bump] = useState(0);
  const structure = sec && sec.structure;
  useEffect(() => {
    ensureInfo(Object.values(prompt || {}).map((n) => n && n.class_type)).then((fresh) => { if (fresh) bump((x) => x + 1); });
  }, [prompt]);
  const all = useMemo(() => nodeSections(prompt, structure, sec && sec.modes), [prompt, structure, sec && sec.modes, bump_]);
  const shown = filterSections(all, q);
  const searching = !!q.trim();
  const total = all.reduce((a, s) => a + s.nodes.length, 0);
  return html`
    <${Sheet} title="All nodes" onClose=${onClose} tall>
      <label class="search gs-search nodes-q">${icon('search', { size: 18 })}<input type="search" placeholder=${`Search ${total} nodes and inputs`} aria-label="Search nodes" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
      ${sec && !structure && html`<button type="button" class="chip" disabled=${busy} onClick=${onLoad}>${busy ? 'Loading…' : 'Load groups and bypass switches'}</button>`}
      ${shown.map((s) => {
        const gOpen = searching || !closedG[s.id];
        return html`
          <section class="ngroup" key=${s.id}>
            <h3>
              <button type="button" class="linkbtn" style="display:flex;align-items:center;width:100%;gap:8px;text-align:left;font:inherit;color:inherit" aria-expanded=${gOpen ? 'true' : 'false'} onClick=${() => setClosedG((c) => ({ ...c, [s.id]: gOpen }))}>${s.title}<em>${s.nodes.length}</em><span style="margin-left:auto">${icon('chevronD', { size: 16 })}</span></button>
            </h3>
            ${gOpen && s.nodes.map((n) => html`<${NodeCard} key=${n.key} n=${n} open=${!!openN[n.key] || (searching && s.nodes.length < 6)} onToggle=${() => setOpenN((o) => ({ ...o, [n.key]: !o[n.key] }))} handlers=${handlers} rand=${rand} onNode=${onNode} busy=${busy} />`)}
          </section>`;
      })}
      ${!shown.length && html`<p class="lempty">Nothing matches.</p>`}
    <//>`;
}
