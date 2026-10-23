// Touch toolbar + phone editing UX for canvas mode (installed by boot.js after the app is ready).
//   - bottom toolbar: Add node, Delete, Bypass, Mute, Undo, Redo, Run (+ progress pill), Save, Simple, overflow (full extensions, fit view)
//   - full-screen editor sheet for multiline (textarea) widgets
//   - Menu button -> the selected node's (or group's) context menu, the canvas menu when nothing is selected
//   - opt-in long-press (pref, default Off) -> context menu; never fires once the finger moved
//   - Settings sheet (More menu): one finger on empty canvas, long-press menu + delay (localStorage only, applied live)
// Everything goes through the frontend's own command store where a command exists.
import { LongPress, sharedPrefs } from './prefs.js';
const ICONS = {
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  del: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  bypass: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
  run: 'M8 5v14l11-7z',
  save: 'M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z',
  simple: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  ctx: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  more: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
};
const svg = (k, flip) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"${flip ? ' style="transform:scaleX(-1)"' : ''}><path d="${ICONS[k]}" fill="currentColor"/></svg>`;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };

export function install(app) {
  const prefs = sharedPrefs();
  const root = document.documentElement;
  root.classList.add('canvas-mode');
  const cmd = (id) => app.extensionManager.command.execute(id);
  const cv = () => app.canvas;
  const wfPath = () => { const w = app.extensionManager.workflow.activeWorkflow; return w && w.path ? w.path.replace(/^workflows\//, '') : (window.__canvasBoot && window.__canvasBoot.config.WORKFLOW_PATH) || ''; };
  const selCount = () => { const c = cv(); return c && c.selectedItems ? c.selectedItems.size : Object.keys((c && c.selected_nodes) || {}).length; };
  const toast = (msg) => { const t = el('div', 'cvt-toast'); t.textContent = String(msg); document.body.appendChild(t); setTimeout(() => t.remove(), 2200); };
  const safe = (fn) => async () => { try { await fn(); } catch (e) { console.warn('[canvas toolbar]', e); toast(String(e && e.message || e)); } };

  // ---------------------------------------------------------------- toolbar
  const bar = el('div', 'cvt-bar'); bar.id = 'canvas-toolbar';
  const pill = el('div', 'cvt-pill'); pill.id = 'canvas-run-pill'; pill.hidden = true;
  const buttons = {};
  const add = (key, icon, label, fn, opts = {}) => {
    const b = el('button', 'cvt-btn', svg(icon, opts.flip) + `<span>${label}</span>`);
    b.type = 'button'; b.dataset.act = key; b.setAttribute('aria-label', label);
    b.addEventListener('pointerdown', (e) => e.preventDefault());   // keep focus / selection as is
    b.addEventListener('click', safe(fn));
    bar.appendChild(b); buttons[key] = b; return b;
  };
  const centreEvent = () => {
    const r = cv().canvas.getBoundingClientRect();
    const e = new PointerEvent('click', { clientX: r.left + r.width / 2, clientY: r.top + (r.height - 56) / 2, pointerType: 'touch' });
    cv().adjustMouseEvent(e);
    return e;
  };
  add('add', 'add', 'Add', () => {
    closeMenu();
    document.dispatchEvent(new CustomEvent('litegraph:canvas', { detail: { subType: 'empty-double-click', originalEvent: centreEvent() } }));
  });
  add('delete', 'del', 'Delete', () => cmd('Comfy.Canvas.DeleteSelectedItems'));
  add('bypass', 'bypass', 'Bypass', () => cmd('Comfy.Canvas.ToggleSelectedNodes.Bypass'));
  add('menu', 'ctx', 'Menu', () => { closeMenu(); openSelectionMenu(); });
  add('undo', 'undo', 'Undo', () => cmd('Comfy.Undo'));
  add('run', 'run', 'Run', () => cmd('Comfy.QueuePrompt'));
  add('save', 'save', 'Save', async () => { await cmd('Comfy.SaveWorkflow'); toast('Saved'); });
  const moreBtn = add('more', 'more', 'More', () => { menu.hidden ? openMenu() : closeMenu(); });
  document.body.append(bar, pill);

  // overflow menu
  const menu = el('div', 'cvt-menu'); menu.hidden = true;
  const mi = (key, label, fn) => { const b = el('button', 'cvt-menu-item', label); b.type = 'button'; b.dataset.act = key; b.addEventListener('click', safe(() => { closeMenu(); return fn(); })); menu.appendChild(b); buttons[key] = b; };
  mi('mute', 'Mute / unmute selected', () => cmd('Comfy.Canvas.ToggleSelectedNodes.Mute'));
  mi('redo', 'Redo', () => cmd('Comfy.Redo'));
  mi('fit', 'Fit view', () => cmd('Comfy.Canvas.FitView'));
  mi('simple', 'Simple mode', () => {
    const p = wfPath();
    try { sessionStorage.removeItem('comfypocket.canvas'); } catch {}
    location.href = '/pocket/#/generate?wfpath=' + encodeURIComponent(p);
  });
  mi('full', 'Full extensions (reload)', () => {
    const p = wfPath();
    const q = new URLSearchParams(); if (p) q.set('path', p); q.set('prune', '0'); q.set('ext', 'all');
    try { sessionStorage.setItem('comfypocket.canvas', JSON.stringify({ search: '?' + q })); } catch {}
    location.href = '/pocket/canvas?' + q;
  });
  document.body.appendChild(menu);
  function openMenu() { menu.hidden = false; }
  function closeMenu() { menu.hidden = true; }
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !moreBtn.contains(e.target)) closeMenu(); }, true);

  // enabled / disabled state
  const refresh = () => {
    const n = selCount();
    for (const k of ['delete', 'bypass', 'mute']) buttons[k].disabled = n === 0;
  };
  refresh();
  setInterval(refresh, 300);
  document.addEventListener('pointerup', () => setTimeout(refresh, 0), true);

  // ---------------------------------------------------------------- run progress pill
  const api = app.api;
  let running = false;
  const nodeName = (id) => {
    if (id === null || id === undefined) return '';
    const g = app.graph, n = g && g.getNodeById ? g.getNodeById(Number(String(id).split(':').pop())) : null;
    return (n && (n.title || n.type)) || ('#' + id);
  };
  const show = (txt, pct) => { pill.hidden = false; pill.textContent = txt; pill.style.setProperty('--p', (pct || 0) + '%'); };
  const hide = () => { running = false; pill.hidden = true; buttons.run.classList.remove('busy'); };
  if (api && api.addEventListener) {
    api.addEventListener('execution_start', () => { running = true; buttons.run.classList.add('busy'); show('Starting…', 0); });
    api.addEventListener('executing', (e) => {
      const id = e.detail; if (id === null || id === undefined) { if (running) hide(); return; }
      show(nodeName(id), 0);
    });
    api.addEventListener('progress', (e) => {
      const d = e.detail || {}; const pct = d.max ? Math.round((100 * d.value) / d.max) : 0;
      running = true; show(`${nodeName(d.node)} ${pct}%`, pct);
    });
    for (const ev of ['execution_success', 'execution_error', 'execution_interrupted']) api.addEventListener(ev, () => { hide(); if (ev === 'execution_error') toast('Run failed'); });
  }

  // ---------------------------------------------------------------- multiline text widget -> full-screen sheet
  let sheet = null;
  const findWidget = (ta) => {
    const nodes = (app.graph && app.graph._nodes) || [];
    for (const n of nodes) for (const w of n.widgets || []) if (w.element === ta || w.inputEl === ta) return { node: n, widget: w };
    return null;
  };
  function openSheet(ta) {
    if (sheet) return;
    const hit = findWidget(ta); if (!hit) return false;
    const { node, widget } = hit;
    const wrap = el('div', 'cvt-sheet'); wrap.id = 'canvas-text-sheet';
    const head = el('div', 'cvt-sheet-head');
    const cancel = el('button', 'cvt-sheet-btn', 'Cancel'), done = el('button', 'cvt-sheet-btn primary', 'Done');
    const title = el('div', 'cvt-sheet-title'); title.textContent = (widget.label || widget.name || 'Text') + ' - ' + (node.title || node.type);
    head.append(cancel, title, done);
    const area = el('textarea', 'cvt-sheet-area'); area.value = widget.value == null ? '' : String(widget.value);
    area.spellcheck = false;
    wrap.append(head, area); document.body.appendChild(wrap);
    sheet = wrap;
    const fit = () => { const vv = window.visualViewport; if (vv) { wrap.style.height = vv.height + 'px'; wrap.style.top = vv.offsetTop + 'px'; } };
    fit(); if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    const close = () => { if (window.visualViewport) window.visualViewport.removeEventListener('resize', fit); wrap.remove(); sheet = null; };
    cancel.onclick = close;
    done.onclick = () => {
      const v = area.value;
      widget.value = v;
      try { widget.callback && widget.callback(v, cv(), node, null, null); } catch (e) { console.warn(e); }
      if (widget.inputEl && widget.inputEl.value !== v) widget.inputEl.value = v;
      try { cv().setDirty(true, true); (node.graph || app.graph).setDirtyCanvas(true, true); } catch {}
      try { const wf = app.extensionManager.workflow.activeWorkflow; wf && wf.changeTracker && wf.changeTracker.checkState(); } catch {}
      close();
    };
    setTimeout(() => area.focus(), 50);
    return true;
  }
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (sheet || !t || t.tagName !== 'TEXTAREA' || !t.classList.contains('comfy-multiline-input') || t.readOnly) return;
    if (openSheet(t)) t.blur();
  }, true);

  // ---------------------------------------------------------------- context menus
  // One finger never opens a menu by holding (gestures.js blocks the native contextmenu and the frontend's 600 ms fake right-click).
  // Menus open from the Menu button, or - only when the pref is On - from a still long-press (cancelled the moment the finger moves).
  const canvasEl = cv().canvas;
  function openContextAt(clientX, clientY, node) {
    const c = cv();
    const ev = new MouseEvent('contextmenu', { clientX, clientY, bubbles: true, cancelable: true, button: 2 });
    c.adjustMouseEvent(ev);
    try { document.querySelectorAll('.litecontextmenu').forEach((m) => m.remove()); } catch {}
    if (node === undefined) node = c.graph.getNodeOnPos(ev.canvasX, ev.canvasY, c.visible_nodes);
    if (node && !(c.selectedItems && c.selectedItems.has(node))) { try { c.selectNode ? c.selectNode(node) : c.select(node); } catch {} }
    c.processContextMenu(node || null, ev);
  }
  // the selected node (or group) -> its menu near it; nothing selected -> the canvas menu in the middle of the view
  function openSelectionMenu() {
    const c = cv(), r = c.canvas.getBoundingClientRect(), ds = c.ds;
    const items = c.selectedItems ? [...c.selectedItems] : Object.values(c.selected_nodes || {});
    const node = items.find((i) => i && typeof i.getInputPos === 'function');
    const group = !node && items.find((i) => i && i.pos && typeof i.isInResize === 'function');
    const clampX = (x) => Math.min(r.right - 12, Math.max(r.left + 12, x)), clampY = (y) => Math.min(r.bottom - 150, Math.max(r.top + 90, y));
    const scr = (gx, gy) => [r.left + (gx + ds.offset[0]) * ds.scale, r.top + (gy + ds.offset[1]) * ds.scale];
    if (node) {
      const [x, y] = scr(node.pos[0] + node.size[0] / 2, node.pos[1] - 12);   // title bar, centre: clear of the slots
      return openContextAt(clampX(x), clampY(y), node);
    }
    if (group) {
      const [x, y] = scr(group.pos[0] + 40, group.pos[1] + 10);
      return openContextAt(clampX(x), clampY(y), null);
    }
    return openContextAt(r.left + r.width / 2, r.top + (r.height - 56) / 2, null);
  }

  const lpc = new LongPress({
    getPrefs: () => prefs.get(),
    fire: (x, y) => {
      const gs = app.__pocketGestures;
      if (gs && gs.gesturing) return;
      if (cv().linkConnector && cv().linkConnector.isConnecting) return;
      try { openContextAt(x, y); } catch (err) { console.warn('[canvas toolbar] context menu', err); }
    },
  });
  const onPtr = (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (e.type === 'pointerdown') { if (e.target !== canvasEl) { lpc.cancel(); lpc.blocked = true; lpc.ids.add(e.pointerId); return; } lpc.down(e.pointerId, e.clientX, e.clientY); }
    else if (e.type === 'pointermove') lpc.move(e.pointerId, e.clientX, e.clientY);
    else lpc.up(e.pointerId);
  };
  // gestures.js swallows pointer events for some touches before any later window listener runs, so it hands every touch event to us first
  if (app.__pocketGestures && app.__pocketGestures.hooks) app.__pocketGestures.hooks.push(onPtr);
  else for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) window.addEventListener(t, onPtr, { capture: true, passive: true });

  // ---------------------------------------------------------------- settings sheet (gear in the More menu)
  let settings = null;
  const SETTING_ROWS = [
    { key: 'emptyDrag', title: 'One finger on empty canvas', hint: 'Two fingers always pan and zoom. A tap on empty canvas deselects.', opts: [['none', 'Nothing'], ['pan', 'Pan'], ['box', 'Box select']] },
    { key: 'longPress', title: 'Long-press menu', hint: 'Hold a finger still to open the context menu. Moving cancels it.', opts: [['off', 'Off'], ['on', 'On']] },
    { key: 'longPressMs', title: 'Long-press delay', hint: '', opts: [[500, '500 ms'], [700, '700 ms'], [1000, '1000 ms']] },
  ];
  function openSettings() {
    if (settings) return;
    const wrap = el('div', 'cvt-sheet'); wrap.id = 'canvas-settings-sheet';
    const head = el('div', 'cvt-sheet-head');
    const title = el('div', 'cvt-sheet-title'); title.textContent = 'Canvas settings';
    const done = el('button', 'cvt-sheet-btn primary', 'Done'); done.type = 'button';
    head.append(title, done);
    const body = el('div', 'cvt-set-body');
    const paint = () => {
      const cur = prefs.get();
      for (const b of body.querySelectorAll('.cvt-seg-btn')) b.classList.toggle('on', String(cur[b.dataset.pref]) === b.dataset.val);
      const delay = body.querySelector('[data-row="longPressMs"]'); if (delay) delay.classList.toggle('dim', cur.longPress !== 'on');
    };
    for (const row of SETTING_ROWS) {
      const r = el('div', 'cvt-set-row'); r.dataset.row = row.key;
      const t = el('div', 'cvt-set-title'); t.textContent = row.title;
      const seg = el('div', 'cvt-seg');
      for (const [val, label] of row.opts) {
        const b = el('button', 'cvt-seg-btn'); b.type = 'button'; b.textContent = label; b.dataset.pref = row.key; b.dataset.val = String(val);
        b.addEventListener('click', () => { prefs.set({ [row.key]: typeof val === 'number' ? val : val }); paint(); });
        seg.appendChild(b);
      }
      r.append(t, seg);
      if (row.hint) { const h = el('div', 'cvt-set-hint'); h.textContent = row.hint; r.appendChild(h); }
      body.appendChild(r);
    }
    wrap.append(head, body); document.body.appendChild(wrap);
    settings = wrap; paint();
    done.onclick = () => { wrap.remove(); settings = null; };
  }
  mi('settings', '⚙ Settings', () => openSettings());

  // ---------------------------------------------------------------- unsaved-changes draft (restored by boot.js) + chip
  const DRAFT_PREFIX = 'comfypocket.canvas.draft:';
  let chipEl = null;
  const chip = (text, label, onClick) => {
    if (chipEl) chipEl.remove();
    chipEl = el('div', 'cvt-chip'); chipEl.id = 'canvas-draft-chip';
    const t = el('span', '', ''); t.textContent = text + ' · ';
    const b = el('button', 'cvt-chip-btn', ''); b.textContent = label; b.type = 'button';
    const x = el('button', 'cvt-chip-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Dismiss');
    b.onclick = safe(async () => { chipEl.remove(); chipEl = null; await onClick(); });
    x.onclick = () => { chipEl.remove(); chipEl = null; };
    chipEl.append(t, b, x); document.body.appendChild(chipEl);
    return chipEl;
  };
  let lastState = null, lastChange = 0, pendingDraft = false;
  const writeDraft = () => {
    pendingDraft = false;
    try {
      const wf = app.extensionManager.workflow.activeWorkflow; const p = wfPath();
      if (!wf || !p || wf.isTemporary) return;
      try { wf.changeTracker && wf.changeTracker.checkState(); } catch {}
      const key = DRAFT_PREFIX + p;
      if (!wf.isModified) { localStorage.removeItem(key); return; }
      const graph = (wf.changeTracker && wf.changeTracker.activeState) || app.graph.serialize();
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), graph }));
    } catch (e) { console.warn('[canvas toolbar] draft', e); }
  };
  setInterval(() => {   // debounced 2 s after the last change; unmodified (saved) workflows drop their draft
    try {
      const wf = app.extensionManager.workflow.activeWorkflow;
      const st = wf && wf.changeTracker && wf.changeTracker.activeState;
      if (st !== lastState) { lastState = st; lastChange = Date.now(); pendingDraft = true; }
      else if (pendingDraft && Date.now() - lastChange >= 2000) writeDraft();
    } catch {}
  }, 500);
  window.addEventListener('pagehide', writeDraft);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeDraft(); });

  return { bar, pill, menu, buttons, openSheet, openSettings, openSelectionMenu, refresh, chip, writeDraft, prefs, longPress: lpc };
}
