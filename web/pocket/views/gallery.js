// Gallery: day-grouped thumbnail grid, infinite scroll, filters, pull-to-refresh, multi-select delete.
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { html, icon, haptic, toast, confirmDialog, useBus, noDrag } from '../ui.js';
import { api, thumbUrl, viewUrl, itemKey, isVideo } from '../api.js';
import { bus } from '../bus.js';
import { openViewer } from './viewer.js';

const PAGE = 60;
const CHUNK = 60;
const KINDS = [['all', 'All'], ['image', 'Images'], ['video', 'Videos']];

function dayLabel(mtime) {
  const d = new Date(mtime * 1000);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function PosterVideo({ src }) {
  const ref = useRef(null);
  // release the decoder explicitly: browsers cap concurrent media players
  useEffect(() => () => { const v = ref.current; if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ } } }, []);
  return html`<video ref=${ref} src=${src} preload="metadata" muted playsinline tabindex="-1" aria-hidden="true"></video>`;
}

// Mounts the <video> only while near the viewport (and unmounts it again when scrolled away).
function LazyVideo({ item }) {
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting), { rootMargin: '300px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return html`<div class="vid-poster" ref=${ref}>${on && html`<${PosterVideo} src=${viewUrl(item) + '#t=0.1'} />`}</div>`;
}

function Tile({ item, selecting, selected, onOpen, onLong }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef(0);
  const start = useRef(null);
  const fired = useRef(false);
  const video = isVideo(item);

  const clear = () => { clearTimeout(timer.current); timer.current = 0; };
  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired.current = false;
    start.current = [e.clientX, e.clientY];
    clear();
    timer.current = setTimeout(() => { fired.current = true; onLong(item); }, 480);
  };
  const move = (e) => {
    if (!start.current) return;
    if (Math.hypot(e.clientX - start.current[0], e.clientY - start.current[1]) > 9) clear();
  };
  const click = (e) => {
    if (fired.current) { fired.current = false; e.preventDefault(); return; }
    onOpen(item, e.currentTarget);
  };

  return html`
    <button class=${'tile' + (loaded ? ' loaded' : '') + (selected ? ' sel' : '') + (item._new ? ' fresh' : '')}
            data-k=${itemKey(item)} type="button"
            aria-label=${`${item.name}${video ? ' (video)' : ''}${item.fav ? ', favourite' : ''}${selecting ? (selected ? ', selected' : ', not selected') : ''}`}
            aria-pressed=${selecting ? selected : undefined}
            onPointerDown=${down} onPointerMove=${move} onPointerUp=${clear} onPointerCancel=${clear} onPointerLeave=${clear}
            onContextMenu=${(e) => e.preventDefault()} onClick=${click}>
      ${video
        ? html`<${LazyVideo} item=${item} />`
        : html`<img src=${thumbUrl(item)} alt="" loading="lazy" decoding="async" draggable=${false} onDragStart=${noDrag}
                    onLoad=${() => setLoaded(true)} onError=${() => { setFailed(true); setLoaded(true); }} />`}
      ${failed && html`<span class="tile-fail">${icon('alert', { size: 22 })}</span>`}
      ${video && html`<span class="tile-badge play">${icon('play', { size: 14, fill: true, sw: 0 })}</span>`}
      ${item.fav && !selecting && html`<span class="tile-badge fav">${icon('heart', { size: 14, fill: true, sw: 0 })}</span>`}
      ${selecting && html`<span class=${'tile-check' + (selected ? ' on' : '')}>${selected && icon('check', { size: 16, sw: 3 })}</span>`}
    </button>`;
}

export function Gallery({ active }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [folders, setFolders] = useState([]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [more, setMore] = useState(false);
  const [filters, setFilters] = useState({ folder: '', kind: 'all', fav: false, q: '' });
  const [qInput, setQInput] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selected, setSelected] = useState(null); // Set<string> | null
  const [refreshing, setRefreshing] = useState(false);

  const rootRef = useRef(null);
  const sentinel = useRef(null);
  const ptr = useRef(null);
  const token = useRef(0);
  const busyMore = useRef(false);
  const lastFetch = useRef(0);
  const itemsRef = useRef(items); itemsRef.current = items;
  const totalRef = useRef(total); totalRef.current = total;
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const activeRef = useRef(active); activeRef.current = active;
  const selectedRef = useRef(selected); selectedRef.current = selected;

  const params = (offset) => {
    const f = filtersRef.current;
    return { offset, limit: PAGE, folder: f.folder, kind: f.kind === 'all' ? '' : f.kind, fav: f.fav, q: f.q };
  };
  const scroller = () => rootRef.current?.parentElement;

  const reloading = useRef(false);
  const anchor = useRef(null);

  // Remember which tile is at the top of the viewport so list changes above it don't move the content
  // (iOS has no overflow-anchor; where it exists the correction below is simply ~0).
  const captureAnchor = () => {
    const sc = scroller();
    anchor.current = null;
    if (!sc || sc.scrollTop <= 0) return;
    const top = sc.getBoundingClientRect().top + 90;
    for (const el of rootRef.current.querySelectorAll('.tile[data-k]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top) { anchor.current = { key: el.dataset.k, top: r.top }; break; }
    }
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    const sc = scroller();
    const el = rootRef.current && rootRef.current.querySelector(`[data-k="${CSS.escape(a.key)}"]`);
    if (sc && el) {
      const d = el.getBoundingClientRect().top - a.top;
      if (Math.abs(d) > 1) sc.scrollTop += d;
    }
  }, [items]);

  const reload = useCallback(async () => {
    const t = ++token.current;
    reloading.current = true;
    busyMore.current = false;
    setMore(false);
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    try {
      const r = await api.outputs(params(0));
      if (t !== token.current) return;
      lastFetch.current = Date.now();
      itemsRef.current = r.items; totalRef.current = r.total;
      setItems(r.items); setTotal(r.total); setFolders(r.folders || []);
      setStatus('ready');
    } catch (e) {
      if (t !== token.current) return;
      setStatus('error');
    } finally {
      if (t === token.current) reloading.current = false;
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (busyMore.current || reloading.current || itemsRef.current.length >= totalRef.current) return [];
    busyMore.current = true; setMore(true);
    const t = token.current;
    try {
      const cur = itemsRef.current;
      let r = await api.outputs(params(cur.length));
      if (t !== token.current) return [];
      const have = new Set(cur.map(itemKey));
      let fresh;
      if (r.total !== totalRef.current && cur.length < 440) {
        // files were added/removed since the last fetch, so the offset is unreliable: re-sync the loaded range in one request
        r = await api.outputs({ ...params(0), limit: Math.min(500, cur.length + PAGE) });
        if (t !== token.current) return [];
        fresh = r.items.filter((i) => !have.has(itemKey(i)));
        captureAnchor();
        itemsRef.current = r.items;
      } else {
        // plain offset paging (also used past the 500-item re-sync cap: new files only shift the offset, key dedupe absorbs the overlap)
        fresh = r.items.filter((i) => !have.has(itemKey(i)));
        for (let hop = 1; !fresh.length && r.items.length && hop <= 4 && cur.length + hop * PAGE < r.total; hop++) {
          r = await api.outputs(params(cur.length + hop * PAGE));
          if (t !== token.current) return [];
          fresh = r.items.filter((i) => !have.has(itemKey(i)));
        }
        itemsRef.current = [...cur, ...fresh];
      }
      totalRef.current = r.total;
      setItems(itemsRef.current); setTotal(r.total); setFolders(r.folders || []);
      return fresh;
    } catch (e) {
      toast('Could not load more', 'error');
      return [];
    } finally {
      if (t === token.current) { busyMore.current = false; setMore(false); }
    }
  }, []);

  // merge the newest page into the current list without disturbing scroll
  const refresh = useCallback(async (manual) => {
    if (reloading.current) return;
    if (manual) setRefreshing(true);
    const t = token.current;
    try {
      const r = await api.outputs(params(0));
      if (t !== token.current || reloading.current) return;
      lastFetch.current = Date.now();
      const cur = itemsRef.current;
      const have = new Set(cur.map(itemKey));
      const fresh = r.items.filter((i) => !have.has(itemKey(i)));
      totalRef.current = r.total;
      setTotal(r.total); setFolders(r.folders || []);
      if (fresh.length && fresh.length === r.items.length && cur.length) {
        itemsRef.current = r.items;
        setItems(r.items); // gap: too many new items, restart the list
      } else if (fresh.length) {
        captureAnchor();
        itemsRef.current = [...fresh.map((i) => ({ ...i, _new: true })), ...cur];
        setItems(itemsRef.current);
        if (manual) toast(`${fresh.length} new`, 'ok');
      } else if (manual) toast('Up to date', 'info', 1400);
      setStatus('ready');
    } catch (e) {
      if (manual) toast('Refresh failed', 'error');
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  // filters -> reload
  useEffect(() => { scroller()?.scrollTo({ top: 0 }); reload(); }, [filters]);
  // debounce search text
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === qInput.trim() ? f : { ...f, q: qInput.trim() })), 280);
    return () => clearTimeout(id);
  }, [qInput]);

  // external events
  useBus('outputs:new', useCallback(() => refresh(false), []));
  useBus('outputs:deleted', useCallback(({ paths }) => {
    const gone = new Set(paths);
    const next = itemsRef.current.filter((i) => !gone.has(i.path));
    const removed = itemsRef.current.length - next.length;
    setTotal((t) => Math.max(0, t - removed));
    setItems(next);
    setSelected((s) => (s ? new Set([...s].filter((k) => !gone.has(k))) : s));
  }, []));
  useBus('outputs:fav', useCallback(({ path, fav }) => {
    setItems((list) => {
      if (filtersRef.current.fav && !fav) return list.filter((i) => i.path !== path);
      return list.map((i) => (i.path === path ? { ...i, fav } : i));
    });
  }, []));

  // refresh when returning to the tab / app
  useEffect(() => {
    if (active && Date.now() - lastFetch.current > 15000 && status === 'ready') refresh(false);
  }, [active]);
  useEffect(() => {
    const on = () => { if (!document.hidden && activeRef.current && Date.now() - lastFetch.current > 15000) refresh(false); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // infinite scroll (re-armed after every page so a still-visible sentinel keeps loading)
  useEffect(() => {
    const el = sentinel.current; const root = scroller();
    if (!el || !root || status !== 'ready') return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { root, rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [items.length, total, status]);

  // pull to refresh
  useEffect(() => {
    const sc = scroller(); const ind = ptr.current;
    if (!sc || !ind) return;
    let y0 = null; let dist = 0;
    const set = (d, anim) => {
      ind.style.transition = anim ? 'transform .3s var(--ease), opacity .3s' : 'none';
      ind.style.transform = `translate3d(-50%, ${d - 48}px, 0) rotate(${d * 3}deg)`;
      ind.style.opacity = Math.min(1, d / 50);
      ind.classList.toggle('ready', d >= 64);
    };
    const ts = (e) => { y0 = sc.scrollTop <= 0 && activeRef.current && !selectedRef.current ? e.touches[0].clientY : null; dist = 0; };
    const tm = (e) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || sc.scrollTop > 0) { if (dist) set(0, true); y0 = null; dist = 0; return; }
      if (e.cancelable) e.preventDefault();
      dist = Math.min(96, dy * 0.45);
      set(dist, false);
    };
    const te = () => {
      if (y0 === null) return;
      const go = dist >= 64;
      y0 = null;
      set(go ? 56 : 0, true);
      if (go) { haptic(10); refresh(true).then(() => set(0, true)); }
      dist = 0;
    };
    sc.addEventListener('touchstart', ts, { passive: true });
    sc.addEventListener('touchmove', tm, { passive: false });
    sc.addEventListener('touchend', te);
    sc.addEventListener('touchcancel', te);
    return () => { sc.removeEventListener('touchstart', ts); sc.removeEventListener('touchmove', tm); sc.removeEventListener('touchend', te); sc.removeEventListener('touchcancel', te); };
  }, []);

  const groups = useMemo(() => {
    const out = [];
    for (const it of items) {
      const label = dayLabel(it.mtime);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(it); else out.push({ label, items: [it] });
    }
    // bound DOM/paint work per block: each ~60-tile chunk gets content-visibility:auto (see .chunk in style.css)
    for (const g of out) { g.chunks = []; for (let i = 0; i < g.items.length; i += CHUNK) g.chunks.push(g.items.slice(i, i + CHUNK)); }
    return out;
  }, [items]);

  // ---- actions
  const toggle = useCallback((item) => {
    setSelected((s) => {
      const n = new Set(s || []);
      n.has(item.path) ? n.delete(item.path) : n.add(item.path);
      return n;
    });
    haptic(5);
  }, []);
  const open = useCallback((item, el) => {
    if (selectedRef.current) { toggle(item); return; }
    const list = itemsRef.current;
    const index = list.findIndex((i) => itemKey(i) === itemKey(item));
    openViewer({
      items: list, index,
      origin: el ? el.getBoundingClientRect() : null,
      getOrigin: (it) => rootRef.current?.querySelector(`[data-k="${CSS.escape(itemKey(it))}"]`)?.getBoundingClientRect() || null,
      loadMore,
    });
  }, []);
  const longPress = useCallback((item) => {
    haptic(18);
    setSelected((s) => new Set([...(s || []), item.path]));
  }, []);
  const delSelected = async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const ok = await confirmDialog({
      title: `Delete ${paths.length} ${paths.length === 1 ? 'item' : 'items'}?`,
      message: 'They are moved to a private trash and are deleted for good after 30 days.',
      confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.del(paths);
      if (r.deleted.length) bus.emit('outputs:deleted', { paths: r.deleted });
      if (r.errors.length) toast(`${r.errors.length} could not be deleted`, 'error');
      else toast(`Moved ${r.deleted.length} to trash`, 'ok');
      setSelected(null);
    } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
  };
  const setF = (patch) => { setSelected(null); setFilters((f) => ({ ...f, ...patch })); };
  const selecting = !!selected;
  const filtered = !!(filters.q || filters.folder || filters.kind !== 'all');

  return html`
    <div class="gallery" ref=${rootRef}>
      <div class="ptr" ref=${ptr} aria-hidden="true">${icon('refresh', { size: 20, sw: 2.2 })}</div>
      <div class="gbar">
        ${selecting
          ? html`<div class="selbar">
              <button class="icon-btn" aria-label="Cancel selection" onClick=${() => setSelected(null)}>${icon('x', { size: 20 })}</button>
              <strong class="selcount">${selected.size} selected</strong>
              <span class="grow"></span>
              <button class="btn small" onClick=${() => setSelected(new Set(items.map((i) => i.path)))}>Select loaded</button>
              <button class="btn small danger" disabled=${!selected.size} onClick=${delSelected}>${icon('trash', { size: 16 })} Delete</button>
            </div>`
          : html`
            ${folders.length > 0 && html`<div class="chips" role="group" aria-label="Folders">
              <button class=${'chip' + (!filters.folder ? ' on' : '')} aria-pressed=${!filters.folder} onClick=${() => setF({ folder: '' })}>All</button>
              ${folders.map((f) => html`<button key=${f} class=${'chip' + (filters.folder === f ? ' on' : '')} aria-pressed=${filters.folder === f} onClick=${() => setF({ folder: f })}>${icon('folder', { size: 14 })}${f}</button>`)}
            </div>`}
            <div class="gctl">
              <div class="seg" role="group" aria-label="Media type">
                ${KINDS.map(([k, l]) => html`<button key=${k} class=${filters.kind === k ? 'on' : ''} aria-pressed=${filters.kind === k} onClick=${() => setF({ kind: k })}>${l}</button>`)}
              </div>
              <span class="grow"></span>
              <button class=${'icon-btn' + (searchOpen || filters.q ? ' on' : '')} aria-label="Search" aria-pressed=${searchOpen} onClick=${() => setSearchOpen((o) => !o)}>${icon('search', { size: 20 })}</button>
              <button class=${'icon-btn fav' + (filters.fav ? ' on' : '')} aria-label="Favourites only" aria-pressed=${filters.fav} onClick=${() => setF({ fav: !filters.fav })}>${icon('heart', { size: 20, fill: filters.fav })}</button>
              <button class=${'icon-btn' + (refreshing ? ' spin' : '')} aria-label="Refresh" onClick=${() => refresh(true)}>${icon('refresh', { size: 20 })}</button>
            </div>
            ${searchOpen && html`<div class="search">
              ${icon('search', { size: 18 })}
              <input type="search" placeholder="Search filenames" aria-label="Search filenames" value=${qInput} autofocus
                     onInput=${(e) => setQInput(e.currentTarget.value)} />
              ${qInput && html`<button class="icon-btn small" aria-label="Clear search" onClick=${() => setQInput('')}>${icon('x', { size: 16 })}</button>`}
            </div>`}`}
      </div>

      ${status === 'loading' && html`<div class="grid skeleton" role="status" aria-label="Loading">${Array.from({ length: 18 }, (_, i) => html`<div key=${i} class="tile sk" style=${{ '--d': (i % 6) * 60 + 'ms' }}></div>`)}</div>`}

      ${status === 'error' && html`<div class="empty">
        <div class="empty-art err">${icon('alert', { size: 32, sw: 1.5 })}</div>
        <h2>Can't reach ComfyUI</h2>
        <p>Check that the server is running and your phone is on the same network.</p>
        <button class="btn primary" onClick=${reload}>Try again</button>
      </div>`}

      ${status === 'ready' && items.length === 0 && html`<div class="empty">
        <div class="empty-art">${icon(filters.fav ? 'heart' : 'image', { size: 32, sw: 1.5 })}</div>
        <h2>${filters.fav ? 'No favourites yet' : filtered ? 'Nothing matches' : 'No images yet'}</h2>
        <p>${filters.fav ? 'Tap the heart on an image to keep it here.' : filtered ? 'Try clearing some filters.' : 'Generated images will show up here.'}</p>
      </div>`}

      ${status === 'ready' && groups.map((g) => html`
        <section key=${g.label} class="day">
          <h2 class="day-h"><span>${g.label}</span><em>${g.items.length}</em></h2>
          ${g.chunks.map((c, ci) => html`<div key=${ci} class="chunk" style=${{ '--n': c.length }}><div class="grid">
            ${c.map((it) => html`<${Tile} key=${itemKey(it)} item=${it} selecting=${selecting}
                selected=${selecting && selected.has(it.path)} onOpen=${open} onLong=${longPress} />`)}
          </div></div>`)}
        </section>`)}

      <div ref=${sentinel} class="sentinel" aria-hidden="true"></div>
      ${more && html`<div class="grid skeleton more">${Array.from({ length: 6 }, (_, i) => html`<div key=${i} class="tile sk"></div>`)}</div>`}
      ${status === 'ready' && items.length > 0 && items.length >= total && html`<p class="end">${total} ${total === 1 ? 'item' : 'items'}</p>`}
    </div>`;
}
