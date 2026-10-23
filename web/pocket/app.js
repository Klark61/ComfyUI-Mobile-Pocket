// App shell: hash router, header (progress slot + desktop link), glass tab bar, toasts, confirm dialog, viewer host.
//
// Extending (tasks 5/6): import your view module and set its `component` in VIEWS below.
// A view component receives {active, params}; it stays mounted (state + scroll preserved) once visited.
import './migrate-run.js';
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { html, icon, useBus, haptic } from './ui.js';
import { bus } from './bus.js';
import { useRoute, navigate } from './router.js';
import { Gallery } from './views/gallery.js';
import { Queue } from './views/queue.js';
import { Generate } from './views/generate.js';
import { queueStore } from './queue-store.js';
import { ViewerHost, openViewer, closeViewer } from './views/viewer.js';

export const VIEWS = [
  { id: 'gallery', label: 'Gallery', icon: 'image', component: Gallery },
  { id: 'generate', label: 'Generate', icon: 'sparkles', component: Generate },
  { id: 'queue', label: 'Queue', icon: 'queue', component: Queue },
];

function Brand() {
  return html`
    <a class="brand" href="#/gallery">
      <span class="brand-name">Comfy${' '}<b>Pocket</b></span>
    </a>`;
}

function Progress() {
  const [p, setP] = useState(null);
  useBus('progress', setP);
  const ind = !!(p && p.indeterminate);
  const pct = p && p.max ? Math.max(0, Math.min(100, (p.value / p.max) * 100)) : 0;
  return html`
    <a class=${'hd-progress' + (p ? ' on' : '')} href="#/queue" title=${p ? 'Open queue' : undefined}
       aria-hidden=${p ? undefined : 'true'} tabindex=${p ? undefined : '-1'}>
      ${p && html`<span class="hd-progress-label">${p.label || 'Working'}${!ind && html`<em>${Math.round(pct)}%</em>`}</span>`}
    </a>
    <span class=${'hd-bar' + (p ? ' on' : '') + (ind ? ' ind' : '')} role=${p && !ind ? 'progressbar' : undefined} aria-label=${p && !ind ? 'Progress' : undefined}
          aria-valuemin=${p && !ind ? '0' : undefined} aria-valuemax=${p && !ind ? '100' : undefined} aria-valuenow=${p && !ind ? Math.round(pct) : undefined}
          aria-hidden=${p && !ind ? undefined : 'true'}><i style=${ind ? undefined : { transform: `scaleX(${pct / 100})` }}></i></span>`;
}

function Header() {
  return html`
    <header class="hd">
      <${Brand} />
      <${Progress} />
      <a class="icon-btn" href="/?desktop=1" aria-label="Open desktop UI" title="Desktop UI">${icon('monitor', { size: 20 })}</a>
    </header>`;
}

function TabBar({ active }) {
  const [counts, setCounts] = useState({});
  useBus('queue:count', (n) => setCounts((c) => ({ ...c, queue: n })));
  const idx = Math.max(0, VIEWS.findIndex((v) => v.id === active));
  return html`
    <nav class="tabs" aria-label="Sections" style=${{ '--i': idx, '--n': VIEWS.length }}>
      <span class="tab-pill" aria-hidden="true"></span>
      ${VIEWS.map((v) => html`
        <a key=${v.id} class=${'tab' + (v.id === active ? ' on' : '')} href=${'#/' + v.id}
           aria-current=${v.id === active ? 'page' : undefined} onClick=${() => haptic(6)}>
          <span class="tab-ic">${icon(v.icon, { size: 23 })}${counts[v.id] > 0 && html`<span class="badge" aria-label=${counts[v.id] + ' pending'}>${counts[v.id]}</span>`}</span>
          <span class="tab-label">${v.label}</span>
        </a>`)}
    </nav>`;
}

function Toasts() {
  const [list, setList] = useState([]);
  const seq = useRef(0);
  useBus('toast', useCallback(({ msg, kind, ms }) => {
    const id = ++seq.current;
    setList((l) => [...l.slice(-2), { id, msg, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), ms);
  }, []));
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map((t) => html`<div key=${t.id} class=${'toast ' + t.kind}>${t.msg}</div>`)}
  </div>`;
}

function Confirm() {
  const [d, setD] = useState(null);
  const cancelRef = useRef(null);
  useBus('confirm', setD);
  useEffect(() => { if (d) cancelRef.current?.focus(); }, [d]);
  if (!d) return null;
  const done = (v) => { setD(null); d.resolve(v); };
  return html`
    <div class="modal-back" onClick=${() => done(false)}>
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby="cf-m" onClick=${(e) => e.stopPropagation()}>
        <h3 id="cf-t">${d.title || 'Are you sure?'}</h3>
        <p id="cf-m">${d.message}</p>
        <div class="modal-actions">
          <button class="btn" ref=${cancelRef} onClick=${() => done(false)}>Cancel</button>
          <button class=${'btn ' + (d.danger ? 'danger' : 'primary')} onClick=${() => done(true)}>${d.confirmLabel || 'OK'}</button>
        </div>
      </div>
    </div>`;
}

function App() {
  const { view, params } = useRoute();
  const known = VIEWS.some((v) => v.id === view);
  const active = known ? view : 'gallery';
  const [visited, setVisited] = useState({ [active]: true });

  useEffect(() => { if (!known) history.replaceState(null, '', '#/gallery'); }, [known]);
  useEffect(() => { setVisited((v) => (v[active] ? v : { ...v, [active]: true })); }, [active]);
  useEffect(() => { document.getElementById('boot')?.classList.add('gone'); setTimeout(() => document.getElementById('boot')?.remove(), 500); }, []);

  return html`
    <${Header} />
    <main class="views">
      ${VIEWS.map((v) => visited[v.id] && html`
        <section key=${v.id} class=${'view' + (v.id === active ? ' active' : '')} id=${'view-' + v.id}
                 aria-hidden=${v.id === active ? undefined : 'true'} inert=${v.id !== active}>
          <${v.component} active=${v.id === active} params=${v.id === active ? params : {}} />
        </section>`)}
    </main>
    <${TabBar} active=${active} />
    <${ViewerHost} />
    <${Toasts} />
    <${Confirm} />`;
}

render(html`<${App} />`, document.getElementById('app'));
queueStore.start();

// Debug / cross-module access (views should import directly; this is for consoles and extensions).
window.comfyPocket = { bus, openViewer, closeViewer, navigate, VIEWS };
