// Fullscreen media viewer with hand-written pointer-event gestures.
//
// Public API (usable from any view):
//   openViewer({ items, index = 0, origin?, getOrigin?, loadMore? })
//       items     [{path?, name, folder?, kind?, mtime?, size?, fav?, url?, thumb?, type?}]
//                 Output files need `path` (enables favourite / delete / remix / metadata).
//                 Other media (temp previews...) can pass `url` (+ optional `thumb`) instead.
//       origin    DOMRect of the tapped tile (open animation), getOrigin(item) -> DOMRect|null (close animation)
//       loadMore  async () => newItems   called when swiping near the end
//   closeViewer() -> Promise resolved once the viewer is gone
//
// Gestures: drag = swipe between items, pinch / double-tap / wheel = zoom, drag when zoomed = pan,
// drag down = dismiss, drag up = details sheet, tap = toggle chrome.
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'preact/hooks';
import { html, icon, haptic, toast, confirmDialog, copyText, triggerDownload, useBus, noDrag } from '../ui.js';
import { api, thumbUrl, viewUrl, itemKey, isVideo, fmtBytes } from '../api.js';
import { bus } from '../bus.js';
import { navigate } from '../router.js';

const GAP = 24; // px between slides
const MAX_SCALE = 6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rubber = (v, max) => (Math.abs(v) <= max ? v : Math.sign(v) * (max + (Math.abs(v) - max) * 0.35));

let isOpen = false;

export function openViewer(opts) {
  if (!opts || !opts.items || !opts.items.length) return;
  bus.emit('viewer:open', opts);
}

export function closeViewer() {
  return new Promise((resolve) => {
    if (!isOpen) return resolve();
    bus.once('viewer:closed', resolve);
    bus.emit('viewer:request-close');
  });
}

// ---- metadata cache
const metaCache = new Map();
function loadMeta(path) {
  if (!metaCache.has(path)) {
    metaCache.set(path, api.meta(path).catch((e) => { metaCache.delete(path); throw e; }));
  }
  return metaCache.get(path);
}

function Chip({ label, value, onClick }) {
  if (value === undefined || value === null || value === '') return null;
  return html`<${onClick ? 'button' : 'div'} class=${'mchip' + (onClick ? ' tap' : '')} onClick=${onClick}><span>${label}</span><b>${value}</b><//>`;
}

function PromptBlock({ title, text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > 220;
  const copy = async () => { haptic(8); toast((await copyText(text)) ? `${title} copied` : 'Copy not available here', 'ok', 1600); };
  return html`
    <section class="pblock">
      <header><h3>${title}</h3>
        <button class="btn small" onClick=${copy} aria-label=${'Copy ' + title.toLowerCase()}>${icon('copy', { size: 15 })} Copy</button>
      </header>
      <p class=${long && !open ? 'clamp' : ''}>${text}</p>
      ${long && html`<button class="linkbtn" onClick=${() => setOpen(!open)}>${open ? 'Show less' : 'Show more'}</button>`}
    </section>`;
}

function Details({ item }) {
  const [state, setState] = useState({ loading: !!item.path });
  useEffect(() => {
    if (!item.path || isVideo(item)) { setState({ loading: false, data: null }); return; }
    let live = true;
    setState({ loading: true });
    loadMeta(item.path).then((data) => live && setState({ data }), (error) => live && setState({ error }));
    return () => { live = false; };
  }, [item.path]);

  const s = state.data?.summary || {};
  const date = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : '';
  return html`
    <div class="details">
      <div class="det-title">
        <h2>${item.name}</h2>
        <p>${[date, fmtBytes(item.size), s.width && `${s.width}×${s.height}`].filter(Boolean).join(' · ')}</p>
      </div>
      ${state.loading && html`<div class="det-skel"><i></i><i></i><i></i></div>`}
      ${state.error && html`<p class="muted">Couldn't read metadata.</p>`}
      ${state.data && !state.data.has_prompt && html`<p class="muted">No generation data is embedded in this file.</p>`}
      ${state.data && html`
        <${PromptBlock} title="Prompt" text=${s.positive} />
        <${PromptBlock} title="Negative" text=${s.negative} />
        <div class="mchips">
          <${Chip} label="Model" value=${s.model} />
          <${Chip} label="Sampler" value=${s.sampler} />
          <${Chip} label="Scheduler" value=${s.scheduler} />
          <${Chip} label="Steps" value=${s.steps} />
          <${Chip} label="CFG" value=${s.cfg} />
          <${Chip} label="Seed" value=${s.seed}
                   onClick=${s.seed !== undefined && s.seed !== null ? async () => { haptic(8); toast((await copyText(String(s.seed))) ? 'Seed copied' : 'Copy not available here', 'ok', 1400); } : undefined} />
          ${(s.loras || []).map((l) => html`<${Chip} key=${l.name} label="LoRA" value=${`${l.name}${l.strength !== undefined && l.strength !== null ? ' · ' + l.strength : ''}`} />`)}
        </div>`}
    </div>`;
}

function Slide({ item, offset }) {
  const [ready, setReady] = useState(false);
  const cur = offset === 0;
  const video = isVideo(item);
  const hasThumb = !video && (item.path || item.thumb);
  return html`
    <div class=${'slide' + (cur ? ' cur' : '')} style=${{ '--o': offset }} aria-hidden=${cur ? undefined : 'true'}>
      <div class="vw-zoom">
        ${video
          ? (cur && html`<video src=${viewUrl(item)} controls playsinline loop autoplay preload="auto"></video>`)
          : html`
            ${hasThumb && html`<img class="lo" src=${thumbUrl(item)} alt="" draggable=${false} onDragStart=${noDrag} />`}
            ${Math.abs(offset) <= 1 && html`<img class=${'hi' + (ready ? ' in' : '')} src=${viewUrl(item)} alt=${cur ? item.name : ''}
                                                  draggable=${false} onDragStart=${noDrag} decoding="async" onLoad=${() => setReady(true)} />`}`}
        ${!video && !ready && cur && html`<span class="spinner" role="status" aria-label="Loading image"></span>`}
      </div>
    </div>`;
}

function Viewer({ opts, onClosed }) {
  const [list, setList] = useState(opts.items);
  const [index, setIndex] = useState(clamp(opts.index || 0, 0, opts.items.length - 1));
  const [sheet, setSheet] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [phase, setPhase] = useState('opening'); // opening | open | closing

  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const trackRef = useRef(null);
  const closeBtn = useRef(null);
  const g = useRef({ W: 0, H: 0, dx: 0, dy: 0, ds: 1, scale: 1, tx: 0, ty: 0, bd: 1, anim: 0, raf: 0 }).current;
  const S = useRef({}); S.current = { list, index, sheet, chrome, phase };
  const loadingMore = useRef(false);
  const preloaded = useRef([]);
  const prevFocus = useRef(document.activeElement);

  const item = list[index];

  // ---- rendering helpers (imperative: all gesture motion bypasses Preact)
  const curZoom = () => stageRef.current?.querySelector('.slide.cur .vw-zoom');
  const apply = () => {
    g.raf = 0;
    const tr = trackRef.current; const root = rootRef.current;
    if (!tr || !root) return;
    tr.style.transform = `translate3d(${g.dx}px,${g.dy}px,0) scale(${g.ds})`;
    const z = curZoom();
    if (z) z.style.transform = g.scale === 1 && !g.tx && !g.ty ? '' : `translate3d(${g.tx}px,${g.ty}px,0) scale(${g.scale})`;
    root.style.setProperty('--bd', g.bd);
  };
  const sched = () => { if (!g.raf) g.raf = requestAnimationFrame(apply); };
  const measure = () => { const s = stageRef.current; if (s) { g.W = s.clientWidth; g.H = s.clientHeight; } };
  const cancelAnim = () => { if (g.anim) { cancelAnimationFrame(g.anim); g.anim = 0; } g.fin = null; };
  // jump a running animation to its end state and run its completion callback (so e.g. go() still commits setIndex)
  const finishAnim = () => {
    if (!g.anim) return;
    cancelAnimationFrame(g.anim); g.anim = 0;
    const f = g.fin; g.fin = null;
    if (f) f();
  };
  const run = (ms, fn, done, ease = easeOut) => {
    cancelAnim();
    const t0 = performance.now();
    g.fin = () => { fn(ease(1)); apply(); done && done(); };
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      fn(ease(p));
      apply();
      if (p < 1) g.anim = requestAnimationFrame(step); else { g.anim = 0; g.fin = null; done && done(); }
    };
    g.anim = requestAnimationFrame(step);
  };
  const nat = () => {
    const z = curZoom();
    const v = z?.querySelector('video');
    if (v && v.videoWidth) return { w: v.videoWidth, h: v.videoHeight };
    for (const sel of ['img.hi', 'img.lo']) {
      const im = z?.querySelector(sel);
      if (im && im.naturalWidth) return { w: im.naturalWidth, h: im.naturalHeight };
    }
    return { w: g.W, h: g.H };
  };
  const bounds = (scale) => {
    const n = nat(); const fit = Math.min(g.W / n.w, g.H / n.h);
    return [Math.max(0, (n.w * fit * scale - g.W) / 2), Math.max(0, (n.h * fit * scale - g.H) / 2)];
  };
  const settleZoom = (ms = 260) => {
    // snap scale into [1, MAX] and pan into bounds
    const s0 = g.scale; const x0 = g.tx; const y0 = g.ty;
    const s1 = clamp(s0, 1, MAX_SCALE);
    const [bx, by] = bounds(s1);
    const x1 = s1 === 1 ? 0 : clamp(x0, -bx, bx);
    const y1 = s1 === 1 ? 0 : clamp(y0, -by, by);
    if (s1 === s0 && x1 === x0 && y1 === y0) return;
    run(ms, (t) => { g.scale = s0 + (s1 - s0) * t; g.tx = x0 + (x1 - x0) * t; g.ty = y0 + (y1 - y0) * t; });
  };
  const zoomAt = (px, py, s1, ms) => {
    // zoom to s1 keeping screen point (px,py) (relative to stage centre) fixed
    const s0 = g.scale; const x0 = g.tx; const y0 = g.ty;
    s1 = clamp(s1, 1, MAX_SCALE);
    const [bx, by] = bounds(s1);
    const x1 = s1 === 1 ? 0 : clamp(px - (px - x0) * (s1 / s0), -bx, bx);
    const y1 = s1 === 1 ? 0 : clamp(py - (py - y0) * (s1 / s0), -by, by);
    if (!ms) { g.scale = s1; g.tx = x1; g.ty = y1; sched(); return; }
    run(ms, (t) => { g.scale = s0 + (s1 - s0) * t; g.tx = x0 + (x1 - x0) * t; g.ty = y0 + (y1 - y0) * t; }, null, easeInOut);
  };
  const snapBack = () => {
    const dx = g.dx; const dy = g.dy; const ds = g.ds; const bd = g.bd;
    run(240, (t) => { g.dx = dx * (1 - t); g.dy = dy * (1 - t); g.ds = ds + (1 - ds) * t; g.bd = bd + (1 - bd) * t; });
    rootRef.current?.classList.remove('gesturing');
  };

  // ---- navigation / close
  const go = (dir) => {
    const { list: l, index: i } = S.current;
    const ni = i + dir;
    if (ni < 0 || ni >= l.length) { if (g.dx) snapBack(); return; }
    g.scale = 1; g.tx = 0; g.ty = 0;
    const from = g.dx; const to = -dir * (g.W + GAP);
    haptic(4);
    run(Math.round(clamp(Math.abs(to - from) / g.W, 0.25, 1) * 280), (t) => { g.dx = from + (to - from) * t; }, () => setIndex(ni));
  };

  const startClose = useCallback(() => {
    if (S.current.phase === 'closing') return;
    setPhase('closing');
    setSheet(false);
    g.scale = 1; g.tx = 0; g.ty = 0;
    const it = S.current.list[S.current.index];
    const r = opts.getOrigin && it ? opts.getOrigin(it) : null;
    const ok = r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    const st = stageRef.current.getBoundingClientRect();
    const f = { dx: g.dx, dy: g.dy, ds: g.ds, bd: g.bd };
    const to = ok
      ? { dx: r.left + r.width / 2 - (st.left + st.width / 2), dy: r.top + r.height / 2 - (st.top + st.height / 2), ds: r.width / Math.min(g.W, g.H), bd: 0 }
      : { dx: f.dx, dy: f.dy + (f.dy > 40 ? 160 : 40), ds: Math.min(f.ds, 0.88), bd: 0 };
    rootRef.current.classList.add('gesturing');
    run(ok ? 300 : 220, (t) => { for (const k of ['dx', 'dy', 'ds', 'bd']) g[k] = f[k] + (to[k] - f[k]) * t; }, () => onClosed(prevFocus.current), ok ? easeInOut : easeOut);
  }, []);

  const requestClose = useCallback(() => {
    if (history.state && history.state.mv) history.back(); else startClose();
  }, []);
  useBus('viewer:request-close', requestClose);
  useEffect(() => {
    const pop = () => startClose();
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  // ---- open animation
  useLayoutEffect(() => {
    measure();
    const st = stageRef.current.getBoundingClientRect();
    const r = opts.origin;
    const ok = r && r.width > 0;
    if (ok) {
      g.dx = r.left + r.width / 2 - (st.left + st.width / 2);
      g.dy = r.top + r.height / 2 - (st.top + st.height / 2);
      g.ds = r.width / Math.min(g.W, g.H);
    } else { g.ds = 0.94; }
    g.bd = 0;
    apply();
    rootRef.current.classList.add('gesturing');
    const f = { dx: g.dx, dy: g.dy, ds: g.ds };
    run(ok ? 340 : 240, (t) => { g.dx = f.dx * (1 - t); g.dy = f.dy * (1 - t); g.ds = f.ds + (1 - f.ds) * t; g.bd = t; }, () => {
      rootRef.current?.classList.remove('gesturing');
      setPhase('open');
    }, ok ? easeInOut : easeOut);
    rootRef.current?.focus({ preventScroll: true });
    const onResize = () => { measure(); settleZoom(0); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); cancelAnim(); cancelAnimationFrame(g.raf); };
  }, []);

  // ---- index change: reset transform state, preload neighbours, load more
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    cancelAnim();
    g.dx = 0; g.dy = 0; g.ds = 1; g.scale = 1; g.tx = 0; g.ty = 0;
    stageRef.current?.querySelectorAll('.vw-zoom').forEach((z) => { z.style.transform = ''; });
    g.bd = 1; apply();
  }, [index]);
  useEffect(() => {
    const keep = [];
    for (const d of [-2, 2]) {
      const it = list[index + d];
      if (it && !isVideo(it)) { const im = new Image(); im.decoding = 'async'; im.src = viewUrl(it); keep.push(im); }
    }
    preloaded.current = keep;
    if (opts.loadMore && index >= list.length - 4 && !loadingMore.current) {
      loadingMore.current = true;
      opts.loadMore().then((more) => {
        if (more && more.length) setList((l) => { const have = new Set(l.map(itemKey)); return [...l, ...more.filter((m) => !have.has(itemKey(m)))]; });
      }).catch(() => {}).finally(() => { loadingMore.current = false; });
    }
  }, [index, list.length]);

  // ---- gestures
  useEffect(() => {
    const stage = stageRef.current;
    const pts = new Map();
    let mode = null; let start = null; let base = null; let pinch = null;
    let hist = []; let lastTap = null; let tapTimer = 0; let noTap = false;

    const pushHist = (x, y) => { const t = performance.now(); hist.push([t, x, y]); hist = hist.filter((h) => t - h[0] < 120); };
    const velocity = () => {
      if (hist.length < 2) return [0, 0];
      const a = hist[0]; const b = hist[hist.length - 1]; const dt = Math.max(1, b[0] - a[0]);
      return [(b[1] - a[1]) / dt, (b[2] - a[2]) / dt];
    };
    const center = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };
    const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };

    const down = (e) => {
      if (S.current.phase !== 'open') return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const vid = S.current.list[S.current.index];
      if (vid && isVideo(vid) && e.clientY > innerHeight - 90) return; // native video controls
      measure();
      if (pts.size === 0) { finishAnim(); noTap = false; }
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (pts.size === 1) {
        mode = null; hist = []; pushHist(e.clientX, e.clientY);
        start = { x: e.clientX, y: e.clientY, t: performance.now(), tx: g.tx, ty: g.ty };
      } else if (pts.size === 2) {
        if (g.dx || g.dy || g.ds !== 1) { g.dx = 0; g.dy = 0; g.ds = 1; g.bd = 1; rootRef.current.classList.remove('gesturing'); sched(); }
        const t = two();
        const [cx, cy] = [t.mx - (stage.getBoundingClientRect().left + g.W / 2), t.my - (stage.getBoundingClientRect().top + g.H / 2)];
        pinch = { d0: t.d, s0: g.scale, x0: g.tx, y0: g.ty, cx, cy };
        mode = 'pinch'; noTap = true;
        clearTimeout(tapTimer); lastTap = null;
      }
    };

    const move = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (mode === 'pinch' && pts.size >= 2) {
        const t = two(); const r = stage.getBoundingClientRect();
        const mx = t.mx - r.left - g.W / 2; const my = t.my - r.top - g.H / 2;
        let s = pinch.s0 * (t.d / pinch.d0);
        s = s < 1 ? 1 - (1 - s) * 0.6 : Math.min(s, MAX_SCALE * 1.15);
        g.scale = s;
        g.tx = mx - (pinch.cx - pinch.x0) * (s / pinch.s0);
        g.ty = my - (pinch.cy - pinch.y0) * (s / pinch.s0);
        sched();
        return;
      }
      if (pts.size !== 1 || !start) return;
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      pushHist(e.clientX, e.clientY);
      if (!mode) {
        if (Math.hypot(dx, dy) < 8) return;
        if (g.scale > 1.02) { mode = 'pan'; }
        else if (Math.abs(dx) > Math.abs(dy)) mode = 'swipe';
        else mode = dy > 0 ? 'dismiss' : 'up';
        if (mode !== 'pan') rootRef.current.classList.add('gesturing');
        base = { tx: g.tx, ty: g.ty, x: e.clientX, y: e.clientY };
        clearTimeout(tapTimer); lastTap = null;
      }
      if (mode === 'pan') {
        const [bx, by] = bounds(g.scale);
        g.tx = rubber(base.tx + (e.clientX - base.x), bx);
        g.ty = rubber(base.ty + (e.clientY - base.y), by);
      } else if (mode === 'swipe') {
        const { index: i, list: l } = S.current;
        const edge = (i === 0 && dx > 0) || (i === l.length - 1 && dx < 0);
        g.dx = edge ? dx * 0.28 : dx;
      } else if (mode === 'dismiss') {
        g.dy = dy; g.dx = dx * 0.6;
        g.ds = 1 - Math.min(0.28, dy / 1400);
        g.bd = 1 - Math.min(1, dy / 420);
      } else if (mode === 'up') {
        g.dy = Math.max(-60, dy * 0.25);
      }
      sched();
    };

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const wasTwo = pts.size >= 2;
      pts.delete(e.pointerId);
      try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

      if (mode === 'pinch') {
        if (pts.size === 1) {            // continue as pan with the remaining finger
          const [p] = [...pts.values()];
          mode = 'pan'; hist = []; start = { x: p.x, y: p.y, t: performance.now() };
          base = { tx: g.tx, ty: g.ty, x: p.x, y: p.y };
          if (g.scale <= 1.02) mode = null;
        } else if (pts.size === 0) { mode = null; start = null; settleZoom(); }
        return;
      }
      if (pts.size > 0 || wasTwo || !start) return;

      const [vx, vy] = velocity();
      const dx = e.clientX - start.x; const dy = e.clientY - start.y;
      const m = mode; mode = null;
      rootRef.current.classList.remove('gesturing');

      if (m === 'swipe') {
        const dir = dx < 0 ? 1 : -1;
        if (Math.abs(dx) > g.W * 0.2 || Math.abs(vx) > 0.45) go(dir); else snapBack();
      } else if (m === 'dismiss') {
        if (dy > 110 || vy > 0.7) { haptic(6); requestClose(); } else snapBack();
      } else if (m === 'up') {
        if (dy < -60 || vy < -0.5) { setSheet(true); haptic(6); }
        snapBack();
      } else if (m === 'pan') {
        settleZoom();
        // fling: nothing fancy, bounded pan only
      } else if (!noTap && Math.hypot(dx, dy) < 10 && performance.now() - start.t < 350) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          clearTimeout(tapTimer); lastTap = null;
          const it = S.current.list[S.current.index];
          if (it && isVideo(it)) return;
          const [cx, cy] = center(e);
          haptic(5);
          zoomAt(cx, cy, g.scale > 1.05 ? 1 : 2.6, 280);
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
          clearTimeout(tapTimer);
          tapTimer = setTimeout(() => {
            lastTap = null;
            if (S.current.sheet) setSheet(false); else setChrome((c) => !c);
          }, 270);
        }
      }
      start = null;
    };

    const cancel = (e) => {
      pts.delete(e.pointerId);
      if (!pts.size) { mode = null; start = null; rootRef.current.classList.remove('gesturing'); if (g.dx || g.dy || g.ds !== 1) snapBack(); settleZoom(); }
    };

    const wheel = (e) => {
      e.preventDefault();
      if (S.current.phase !== 'open') return;
      measure();
      finishAnim();
      const [cx, cy] = center(e);
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(cx, cy, clamp(g.scale * f, 1, MAX_SCALE), 0);
    };

    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', cancel);
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => {
      clearTimeout(tapTimer);
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', cancel);
      stage.removeEventListener('wheel', wheel);
    };
  }, []);

  // keyboard
  useEffect(() => {
    const key = (e) => {
      if (e.target.closest && e.target.closest('.modal')) return;
      if (e.key === 'Escape') { e.preventDefault(); if (S.current.sheet) setSheet(false); else requestClose(); }
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'i') setSheet((s) => !s);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // ---- actions
  const toggleFav = async () => {
    if (!item.path) return;
    const fav = !item.fav;
    haptic(fav ? 14 : 6);
    const set = (v) => setList((l) => l.map((x) => (itemKey(x) === itemKey(item) ? { ...x, fav: v } : x)));
    set(fav);
    try {
      await api.favorite(item.path, fav);
      bus.emit('outputs:fav', { path: item.path, fav });
    } catch (e) { set(!fav); toast('Could not update favourite', 'error'); }
  };
  const del = async () => {
    if (!item.path) return;
    const ok = await confirmDialog({ title: 'Delete this file?', message: `${item.name} will be moved to a private trash and deleted for good after 30 days.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const r = await api.del([item.path]);
      if (!r.deleted.length) throw new Error(r.errors[0]?.error || 'failed');
      bus.emit('outputs:deleted', { paths: r.deleted });
      toast('Moved to trash', 'ok');
      // state may have changed while awaiting (swipes, loadMore): derive from the latest committed state
      const key = itemKey(item);
      const cur = S.current;
      const curKey = cur.list[cur.index] ? itemKey(cur.list[cur.index]) : null;
      const nl = cur.list.filter((x) => itemKey(x) !== key);
      if (!nl.length) { requestClose(); return; }
      const ni = curKey && curKey !== key ? nl.findIndex((x) => itemKey(x) === curKey) : Math.min(cur.index, nl.length - 1);
      setList((l) => l.filter((x) => itemKey(x) !== key));
      setIndex(Math.max(0, ni));
    } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
  };
  const share = async () => {
    try { await navigator.share({ title: item.name, url: new URL(viewUrl(item), location.href).href }); } catch { /* cancelled */ }
  };
  const remix = async () => {
    await closeViewer();
    navigate('generate', { remix: item.path });
  };
  const canShare = typeof navigator.share === 'function';

  const slides = [];
  for (let o = -1; o <= 1; o++) {
    const it = list[index + o];
    if (it) slides.push(html`<${Slide} key=${itemKey(it)} item=${it} offset=${o} />`);
  }

  const cls = `vw ph-${phase}${chrome ? '' : ' chrome-off'}${sheet ? ' sheet-on' : ''}`;
  return html`
    <div class=${cls} ref=${rootRef} role="dialog" aria-modal="true" aria-label="Media viewer" tabindex="-1">
      <div class="vw-back"></div>
      <div class="vw-stage" ref=${stageRef}>
        <div class="vw-track" ref=${trackRef}>${slides}</div>
      </div>

      <div class="vw-ui">
        <div class="vw-top">
          <button class="icon-btn glass" ref=${closeBtn} aria-label="Close viewer" onClick=${requestClose}>${icon('x', { size: 22 })}</button>
          <div class="vw-title"><strong>${item.name}</strong><span>${index + 1} / ${list.length}</span></div>
          <button class=${'icon-btn glass' + (sheet ? ' on' : '')} aria-label="Details" aria-pressed=${sheet} onClick=${() => setSheet((s) => !s)}>${icon('info', { size: 22 })}</button>
        </div>
        <button class="vw-nav prev" aria-label="Previous" onClick=${() => go(-1)} disabled=${index === 0}>${icon('chevronL', { size: 26 })}</button>
        <button class="vw-nav next" aria-label="Next" onClick=${() => go(1)} disabled=${index >= list.length - 1}>${icon('chevronR', { size: 26 })}</button>
        <div class="vw-bottom">
          <div class="actions glass" role="toolbar" aria-label="Actions">
            ${item.path && html`<button class=${'act fav' + (item.fav ? ' on' : '')} aria-label=${item.fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed=${!!item.fav} onClick=${toggleFav}>${icon('heart', { size: 22, fill: !!item.fav })}</button>`}
            <button class="act" aria-label="Download" onClick=${() => triggerDownload(viewUrl(item), item.name)}>${icon('download', { size: 22 })}</button>
            ${canShare && html`<button class="act" aria-label="Share" onClick=${share}>${icon('share', { size: 22 })}</button>`}
            ${item.path && !isVideo(item) && html`<button class="act" aria-label="Remix in Generate" onClick=${remix}>${icon('remix', { size: 22 })}</button>`}
            ${item.path && html`<button class="act danger" aria-label="Delete" onClick=${del}>${icon('trash', { size: 22 })}</button>`}
          </div>
        </div>
      </div>

      <${Sheet} open=${sheet} onClose=${() => setSheet(false)} item=${item} />
    </div>`;
}

function Sheet({ open, onClose, item }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const down = (e) => { drag.current = { y: e.clientY, d: 0 }; e.currentTarget.setPointerCapture(e.pointerId); ref.current.style.transition = 'none'; };
  const move = (e) => {
    if (!drag.current) return;
    drag.current.d = Math.max(0, e.clientY - drag.current.y);
    ref.current.style.transform = `translate3d(0,${drag.current.d}px,0)`;
  };
  const up = () => {
    if (!drag.current) return;
    const d = drag.current.d; drag.current = null;
    ref.current.style.transition = ''; ref.current.style.transform = '';
    if (d > 80) onClose();
  };
  return html`
    <div class=${'sheet' + (open ? ' open' : '')} ref=${ref} role="region" aria-label="Details" aria-hidden=${open ? undefined : 'true'} inert=${!open}>
      <div class="sheet-grab" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}><i></i></div>
      <div class="sheet-body">${open && html`<${Details} item=${item} />`}</div>
    </div>`;
}

export function ViewerHost() {
  const [session, setSession] = useState(null);
  const seq = useRef(0);
  useBus('viewer:open', useCallback((opts) => {
    if (isOpen) return;
    isOpen = true;
    history.pushState({ mv: 1 }, '');
    setSession({ id: ++seq.current, opts });
  }, []));
  const onClosed = useCallback((focusEl) => {
    isOpen = false;
    setSession(null);
    try { focusEl && focusEl.focus && focusEl.focus({ preventScroll: true }); } catch { /* ignore */ }
    bus.emit('viewer:closed');
  }, []);
  if (!session) return null;
  return html`<${Viewer} key=${session.id} opts=${session.opts} onClosed=${onClosed} />`;
}
