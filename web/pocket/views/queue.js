// Queue view: running job card (live preview + progress), pending list, recent results.
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { html, icon, haptic, toast, confirmDialog } from '../ui.js';
import { thumbUrl, itemKey, getJSON } from '../api.js';
import { queueStore, useQueue, runProgress, nodeTitle, jobOutputsToItems } from '../queue-store.js';
import { openViewer } from './viewer.js';
import { TextOutputs } from './textouts.js';

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const id = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(id); }, [ms]);
}

function Bar({ value, label, right, thin }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  return html`
    <div class=${'qbar' + (thin ? ' thin' : '')}>
      <div class="qbar-meta"><span>${label}</span><b>${right}</b></div>
      <div class="qbar-track" role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(pct * 100)}><i style=${{ transform: `scaleX(${pct})` }}></i></div>
    </div>`;
}

function RunningCard({ run }) {
  useTick();
  const p = runProgress(run);
  const cur = p && p.cur;
  const title = cur ? nodeTitle(run.prompt, cur.nodeId) : '';
  const elapsed = run.startedAt ? fmtDur(Date.now() - run.startedAt) : '';
  const stepping = cur && cur.max > 1;
  return html`
    <section class="qcard running" aria-label="Running job">
      <div class="qprev">
        ${run.preview
          ? html`<img src=${run.preview} alt="Live preview" decoding="async" />`
          : html`<div class="qprev-empty"><i></i>${icon('sparkles', { size: 30, sw: 1.5 })}</div>`}
        <span class="qlive"><i></i>${run.stopping ? 'Stopping' : 'Running'}</span>
        ${elapsed && html`<span class="qtime">${elapsed}</span>`}
      </div>
      <div class="qbody">
        <h2 class="qname">${run.name}</h2>
        ${run.live
          ? html`
            <div class="qnode">${title ? html`<span class="dotpulse"></span>${title}` : 'Preparing…'}</div>
            ${stepping && html`<${Bar} label="Step" value=${p.step} right=${`${cur.value} / ${cur.max}`} />`}
            ${p.total > 0 && html`<${Bar} label="Overall" thin value=${p.overall} right=${`${p.done} of ${p.total} nodes`} />`}`
          : html`${run.own
                   ? html`<div class="qnode">Starting…</div>`
                   : html`<p class="qnote">${icon('info', { size: 16 })}<span>Started on another device. Waiting for live updates…</span></p>`}
                 <div class="qbar indet"><div class="qbar-track"><i></i></div></div>`}
        <button class="btn danger wide" disabled=${run.stopping} onClick=${() => { haptic(12); queueStore.interrupt(run.id); }}>
          ${icon('x', { size: 18 })} ${run.stopping ? 'Stopping…' : 'Interrupt'}
        </button>
      </div>
    </section>`;
}

function IdleCard({ conn, reachable }) {
  return html`
    <section class="qcard idle">
      <div class="empty-art">${icon(reachable ? 'queue' : 'alert', { size: 30, sw: 1.5 })}</div>
      <h2>${reachable ? 'Nothing running' : 'Server unreachable'}</h2>
      <p>${reachable ? 'Queue a job from the Generate tab or the desktop UI and it will show up here live.' : 'Waiting for ComfyUI to respond…'}</p>
    </section>`;
}

function PendingRow({ job, index }) {
  return html`
    <li class="prow">
      <span class="prow-n">${index + 1}</span>
      <div class="prow-main"><strong>${job.name}</strong><span>${job.nodeCount ? `${job.nodeCount} nodes` : 'queued'}${job.createTime ? ' · ' + ago(job.createTime) : ''}</span></div>
      <button class="icon-btn" aria-label=${`Cancel ${job.name}`} onClick=${() => { haptic(8); queueStore.cancelPending(job.id); }}>${icon('x', { size: 20 })}</button>
    </li>`;
}

function ErrorBlock({ row, live }) {
  const [err, setErr] = useState(live || (row.error ? { nodeType: row.error.node_type, message: row.error.exception_message, nodeTitle: '' } : null));
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const j = await getJSON(`/api/jobs/${row.id}`);
      const e = j.execution_error;
      setErr(e ? { nodeType: e.node_type, message: e.exception_message } : { message: 'No error details were recorded.' });
    } catch { setErr({ message: 'Could not load details.' }); }
    setBusy(false);
  };
  if (!err) return html`<button class="linkbtn" disabled=${busy} onClick=${load}>${busy ? 'Loading…' : 'Show error details'}</button>`;
  return html`<div class="qerr" role="alert">${icon('alert', { size: 16 })}<div><b>${err.nodeTitle || err.nodeType || 'Error'}</b><span>${err.message}</span></div></div>`;
}

const STATUS = { completed: ['Done', 'ok'], failed: ['Failed', 'bad'], cancelled: ['Stopped', 'warn'] };

function RecentRow({ row, errors, onOpen }) {
  const [label, tone] = STATUS[row.status] || ['Done', 'ok'];
  const shown = row.outputs.slice(0, 4);
  const more = row.outputs.length - shown.length;
  return html`
    <li class="rrow">
      <div class="rrow-head">
        <span class=${'pill ' + tone}>${label}</span>
        <strong class="rrow-name">${row.name}</strong>
        <span class="rrow-time">${[ago(row.ts), row.duration ? fmtDur(row.duration) : ''].filter(Boolean).join(' · ')}</span>
      </div>
      ${shown.length > 0 && html`<div class="rthumbs">
        ${shown.map((o, i) => {
          const path = (o.subfolder ? o.subfolder + '/' : '') + o.filename;
          const isOut = (o.type || 'output') === 'output';
          const video = /\.(mp4|webm|mov|mkv)$/i.test(o.filename);
          const key = isOut ? path : `/view?${new URLSearchParams({ filename: o.filename, subfolder: o.subfolder || '', type: o.type })}`;
          const src = isOut ? thumbUrl({ path }) : key;
          return html`<button key=${key} class="rthumb" data-k=${key} aria-label=${`Open ${o.filename}`} onClick=${(e) => onOpen(row, i, e.currentTarget)}>
            ${video ? html`<span class="rthumb-vid">${icon('film', { size: 22 })}</span>` : html`<img src=${src} alt="" loading="lazy" decoding="async" onLoad=${(e) => e.currentTarget.classList.add('in')} onError=${(e) => e.currentTarget.parentNode.classList.add('gone')} />`}
            ${i === shown.length - 1 && more > 0 && html`<span class="rthumb-more">+${more}</span>`}
          </button>`;
        })}
      </div>`}
      ${row.texts && row.texts.length > 0 && html`<${TextOutputs} texts=${row.texts} />`}
      ${row.status === 'failed' && html`<${ErrorBlock} row=${row} live=${errors[row.id]} />`}
    </li>`;
}

export function Queue({ active }) {
  const q = useQueue();
  const rootRef = useRef(null);
  useTick(15000); // refresh "x ago" labels

  useEffect(() => { if (active) { queueStore.sync(); queueStore.loadRecent(); } }, [active]);

  const allItems = useMemo(() => jobOutputsToItems(q.recent), [q.recent]);
  const open = (row, i, el) => {
    const first = allItems.findIndex((it) => it.job === row.id);
    const index = first < 0 ? 0 : first + i;
    openViewer({
      items: allItems, index,
      origin: el.getBoundingClientRect(),
      getOrigin: (it) => rootRef.current?.querySelector(`[data-k="${CSS.escape(itemKey(it))}"]`)?.getBoundingClientRect() || null,
    });
  };
  const clear = async () => {
    const ok = await confirmDialog({ title: `Clear ${q.pending.length} pending ${q.pending.length === 1 ? 'job' : 'jobs'}?`, message: 'The running job is not affected.', confirmLabel: 'Clear all', danger: true });
    if (ok) { haptic(12); queueStore.clearPending(); toast('Pending jobs cleared', 'ok'); }
  };
  const canVibrate = typeof navigator.vibrate === 'function';

  return html`
    <div class="queue" ref=${rootRef}>
      ${q.conn !== 'open' && html`<div class="qbanner" role="status"><i class="spinner-s"></i>${q.conn === 'connecting' ? 'Connecting to ComfyUI…' : 'Connection lost. Reconnecting…'}</div>`}

      ${q.running ? html`<${RunningCard} run=${q.running} />` : html`<${IdleCard} conn=${q.conn} reachable=${q.serverReachable} />`}

      ${q.pending.length > 0 && html`
        <section class="qsec">
          <header class="qsec-h"><h2>Up next <em>${q.pending.length}</em></h2><button class="btn small" onClick=${clear}>${icon('trash', { size: 15 })} Clear</button></header>
          <ul class="plist">${q.pending.map((j, i) => html`<${PendingRow} key=${j.id} job=${j} index=${i} />`)}</ul>
        </section>`}

      <section class="qsec">
        <header class="qsec-h">
          <h2>Recent</h2>
          <span class="grow"></span>
          ${canVibrate && html`<button class=${'icon-btn small' + (q.vibrate ? ' on' : '')} aria-pressed=${q.vibrate} aria-label="Vibrate when a job finishes" title="Vibrate when finished" onClick=${() => queueStore.setVibrate(!q.vibrate)}>${icon('sparkles', { size: 17 })}</button>`}
          <button class="icon-btn small" aria-label="Refresh recent jobs" onClick=${() => { queueStore.sync(); queueStore.loadRecent(); }}>${icon('refresh', { size: 17 })}</button>
        </header>
        ${!q.recentLoaded && html`<div class="rskel"><i></i><i></i><i></i></div>`}
        ${q.recentLoaded && q.recent.length === 0 && html`<p class="muted qempty">No finished jobs yet.</p>`}
        <ul class="rlist">${q.recent.map((r) => html`<${RecentRow} key=${r.id} row=${r} errors=${q.errors} onOpen=${open} />`)}</ul>
      </section>
    </div>`;
}
