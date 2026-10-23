// Text outputs of a run (PreviewAny / ShowText / anything that reports ui.text): one block per node, titled by the node,
// long text collapsed, with a copy button. Used by the Generate result card and the Queue recent rows.
import { useState } from 'preact/hooks';
import { html, icon, haptic, toast, copyText } from '../ui.js';

const LONG = 280;   // characters; beyond this the block starts collapsed

function TextBlock({ t }) {
  const long = t.text.length > LONG || t.text.split('\n').length > 6;
  const [open, setOpen] = useState(!long);
  const copy = async () => { haptic(8); toast((await copyText(t.text)) ? 'Copied' : 'Could not copy', 'ok', 1400); };
  return html`
    <div class="tout">
      <div class="tout-h">
        <span class="tout-t">${t.title}</span><em>#${t.node}</em>
        <button type="button" class="icon-btn small" aria-label=${`Copy ${t.title}`} onClick=${copy}>${icon('copy', { size: 17 })}</button>
      </div>
      <pre class=${'tout-b' + (open ? ' open' : '')} tabindex="0">${t.text}</pre>
      ${long && html`<button type="button" class="linkbtn" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>${open ? 'Show less' : 'Show more'}</button>`}
    </div>`;
}

export function TextOutputs({ texts }) {
  if (!texts || !texts.length) return null;
  return html`<div class="touts">${texts.map((t) => html`<${TextBlock} key=${t.node} t=${t} />`)}</div>`;
}
