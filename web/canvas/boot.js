// Canvas mode boot (phone layer for the real ComfyUI frontend).
// Served as a classic script in <head> of /pocket/canvas, so it runs BEFORE the app bundle. Everything here lives in memory:
//   1. URL fix        : the frontend derives its API base from location.pathname, so /pocket/canvas is rewritten to "/".
//   2. DPR cap        : window.devicePixelRatio is capped (default 1.25, ?dpr=N overrides) so LiteGraph's backing store stays small.
//   3. Extension filter: GET /extensions is filtered through DENYLIST below (?ext=all keeps everything).
//   4. Phone settings : GET /settings is answered with PHONE_SETTINGS merged in (in memory only).
//   5. Write guard    : any POST/PUT that would persist a PHONE_SETTINGS key (/settings, /settings/<id>, comfy.settings.json) is dropped.
//   6. gestures       : after the app is ready, web/canvas/gestures.js is imported and installed (?gestures=0 skips it); touch prefs live in
//                       web/canvas/prefs.js (localStorage 'comfypocket.canvas.prefs' only).
//   7. ?path=<wf>     : opens that saved workflow (relative to user/default/workflows) like the desktop workflow sidebar does.
// The desktop shares the same user settings, so NOTHING in here may reach the server's settings file.
(() => {
  'use strict';
  // one-time comfymobile.* -> comfypocket.* storage migration (async; the keys are only read after the app is ready)
  import('/pocket/static/canvas/storage-migrate.js').then((m) => m.migrateAll()).catch(() => {});
  const Q = new URLSearchParams(location.search);
  const onRoute = /^\/pocket\/canvas\/?$/.test(location.pathname);
  // ?canvas=1 / window.__COMFY_CANVAS__ activate the layer on "/" too (used by tests that inject this file through CDP).
  if (!onRoute && Q.get('canvas') !== '1' && !window.__COMFY_CANVAS__) return;
  if (window.__canvasBoot) return;

  // ------------------------------------------------------------------ tunables
  // Extension denylist. Entries are lower-case paths relative to /extensions/ : "pack" drops the whole pack,
  // "pack/file.js" (or "pack/dir") drops one file (prefix match on a path segment boundary).
  // RULE: only UI-only scripts (overlays, buttons, toasts, monitors). Never drop a script that adds node widgets or graph logic:
  // a node whose widget is missing loses its widgets_values on Save. Never drop (even file-wise unless proven UI-only):
  // rgthree-comfy, comfyui-impact-pack, comfyui-kjnodes, comfyui-easy-use, comfyui-custom-scripts, cg-use-everywhere,
  // comfyui_fill-nodes, donutnodes, comfyui-resolution-master.
  const DENYLIST = [
    // Crystools: CPU/GPU/RAM monitor overlay + progress bar (the nodes' own widgets live in debugger.js / extensions.js, kept)
    'comfyui-crystools/monitor.js', 'comfyui-crystools/monitorui.js',
    'comfyui-crystools/progressbar.js', 'comfyui-crystools/progressbarui.js', 'comfyui-crystools/progressbaruibase.js',
    'comfyui-crystools-main/monitor.js', 'comfyui-crystools-main/monitorui.js',
    'comfyui-crystools-main/progressbar.js', 'comfyui-crystools-main/progressbarui.js', 'comfyui-crystools-main/progressbaruibase.js',
    // CivitAI floating button (donutnodes keeps its node widgets)
    'donutnodes/donut_civitai_browser.js',
    // ComfyUI-Manager legacy menu / toasts / badges / dialogs (UI only)
    'comfyui-manager/comfyui-manager.js', 'comfyui-manager/custom-nodes-manager.js', 'comfyui-manager/model-manager.js',
    'comfyui-manager/components-manager.js', 'comfyui-manager/snapshot.js', 'comfyui-manager/comfyui-share-common.js',
    'comfyui-manager/comfyui-share-copus.js', 'comfyui-manager/comfyui-share-openart.js', 'comfyui-manager/comfyui-share-youml.js',
    'comfyui-manager/comfyui-gui-builder.js', 'comfyui-manager/turbogrid.esm.js',
    // image browser top-menu button
    'comfyui-image-browser-master/image_browser_button.js',
    // ComfyUI_LC123_nodes: overlay / diagnostics / drawing-effect scripts without node hooks
    'comfyui_lc123_nodes/lc_align.js', 'comfyui_lc123_nodes/lc_connection_fx.js', 'comfyui_lc123_nodes/lc_system_check.js',
    'comfyui_lc123_nodes/lc_pack_usage.js', 'comfyui_lc123_nodes/lc_recent_colors.js', 'comfyui_lc123_nodes/lc_report_csv.js',
    'comfyui_lc123_nodes/lc_performance_settings.js',
    // comfyui-vrgamedevgirl: pop-up / theme / test scripts without node hooks
    'comfyui-vrgamedevgirl/vrgdg_popuptest.js', 'comfyui-vrgamedevgirl/vrgdg_uithemes.js', 'comfyui-vrgamedevgirl/vrgdg_overlaytrack.js',
    'comfyui-vrgamedevgirl/vrgdg_browserimagebridge.js', 'comfyui-vrgamedevgirl/vrgdg_musicvideowizardui.js',
    'comfyui-vrgamedevgirl/vrgdg_musicvideopromptcreatorui.js', 'comfyui-vrgamedevgirl/vrgdg_musicvideobuilderluts.js',
    'comfyui-vrgamedevgirl/vrgdg_postprocesscomparepreview.js', 'comfyui-vrgamedevgirl/vrgdg_facefixui.js',
  ];

  // Workflow-aware pruning (only with ?path, off with ?prune=0 or ?ext=all). A node pack's scripts are only needed when the opened
  // workflow contains one of its nodes, so every pack that is NOT used by the workflow and NOT in NEVER_DROP is skipped
  // (this is what gets app-ready down to the phone budget; the static DENYLIST alone only removes overlays).
  // Pruning is skipped entirely (static denylist only) when the workflow has a node type we cannot map to a pack.
  // Limitation: a node added later from a pruned pack gets only the plain widgets of its backend definition.
  const NEVER_DROP = ['rgthree-comfy', 'comfyui-impact-pack', 'comfyui-kjnodes', 'comfyui-easy-use', 'comfyui-custom-scripts',
    'cg-use-everywhere', 'comfyui_fill-nodes', 'donutnodes', 'comfyui-resolution-master'];
  const FRONTEND_TYPES = /^(Note|MarkdownNote|Reroute|PrimitiveNode|GroupNode|SubgraphInputNode|SubgraphOutputNode|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|.*\(rgthree\))$/;
  // ?prune=0 turns pruning off; ?prune=all (experiment / measuring the floor) ignores NEVER_DROP and prunes every unused pack.
  const PRUNE = !!Q.get('path') && Q.get('prune') !== '0' && Q.get('ext') !== 'all';
  const PRUNE_ALL = Q.get('prune') === 'all';

  // Always dropped, even with ?ext=all: this repo's desktop extension redirects phones to /pocket/ (and adds a converter bridge and
  // desktop auto-snapshot), none of which belongs inside canvas mode. Matched by file name, so any install folder name works.
  const ALWAYS_DENY = ['comfyui-pocket'];
  const OWN_EXT_FILE = '/pocket_ext.js';

  // Phone settings, applied IN MEMORY ONLY (GET /settings is rewritten; writes of these keys are dropped).
  const PHONE_SETTINGS = {
    'Comfy.RightSidePanel.IsOpen': false,                 // properties panel closed
    'Comfy.Graph.CanvasInfo': false,                      // no fps/info text bottom-left
    'Comfy.Minimap.Visible': false,                       // minimap steals touches and draw time
    'LiteGraph.Canvas.MaximumFps': 60,
    'Comfy.NodeSearchBoxImpl.FollowCursor': false,        // a node added from the search box is placed, not ghost-dragged by the finger
    'Comfy.LinkRenderMode': 1,                            // 0 straight, 1 linear (cheapest), 2 spline (default), -1 hidden
    'LiteGraph.Canvas.MinFontSizeForLOD': 10,             // LOD below zoom ~= 10 / (14 * sqrt(dpr)) = 0.64 at dpr 1.25 (default 8 -> 0.51)
  };
  const WORKFLOW_PATH = Q.get('path');
  if (WORKFLOW_PATH) PHONE_SETTINGS['Comfy.Workflow.Persist'] = false;   // do not restore the previous workflow over ?path
  const DPR_CAP = (() => { const v = parseFloat(Q.get('dpr')); return v > 0 ? v : 1.25; })();
  const KEEP_ALL_EXT = Q.get('ext') === 'all';

  const B = window.__canvasBoot = {
    config: { DENYLIST, ALWAYS_DENY, NEVER_DROP, PHONE_SETTINGS, DPR_CAP, KEEP_ALL_EXT, WORKFLOW_PATH },
    droppedExt: [], keptExt: 0, prune: { enabled: PRUNE, state: PRUNE ? 'pending' : 'off', keptPacks: [], prunedPacks: [] }, droppedWrites: [], passedWrites: [], settingsReads: 0,
    pathState: WORKFLOW_PATH ? 'pending' : 'none', gestures: null, gesturesState: 'pending', errors: [],
  };
  const fail = (what, e) => { B.errors.push(what + ': ' + (e && e.message || e)); console.warn('[canvas boot]', what, e); };

  // Reload support: the URL is rewritten to "/" below, so a reload would hit the desktop page. Remember how we were opened;
  // web/ext/pocket_ext.js sends a phone reload of "/" back to /pocket/canvas<search> instead of /pocket/.
  try { if (onRoute) sessionStorage.setItem('comfypocket.canvas', JSON.stringify({ search: location.search })); } catch {}

  // ------------------------------------------------------------------ 1. URL fix (API base = location.pathname minus last segment)
  try {
    if (/^https?:$/.test(location.protocol) && location.pathname !== '/') history.replaceState(history.state, '', '/' + location.search + location.hash);
  } catch (e) { fail('replaceState', e); }

  // ------------------------------------------------------------------ 2. devicePixelRatio cap
  try {
    const d = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    const real = d && d.get ? () => d.get.call(window) : () => (d ? d.value : 1);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, enumerable: true, get: () => Math.min(real(), DPR_CAP) });
    B.realDpr = real;
  } catch (e) { fail('dpr', e); }

  // ------------------------------------------------------------------ 3-5. fetch interception
  const origFetch = window.fetch.bind(window);

  // prefetch the workflow file and /object_info while the page boots; /object_info is handed to the frontend afterwards (no second download)
  let objectInfoText = null;
  const pruneInfo = !PRUNE ? Promise.resolve(null) : (async () => {
    const [wr, orr, pr] = await Promise.all([
      origFetch('/api/userdata/' + encodeURIComponent('workflows/' + WORKFLOW_PATH.replace(/^\/+/, ''))),
      origFetch('/api/object_info'),
      origFetch('/pocket/api/canvas/node-packs').catch(() => null),   // type -> [every custom_nodes folder that provides it]
    ]);
    if (!wr.ok || !orr.ok) throw new Error(`prefetch ${wr.status}/${orr.status}`);
    objectInfoText = await orr.text();
    const wf = await wr.json(), info = JSON.parse(objectInfoText);
    const providers = pr && pr.ok ? await pr.json() : null;
    const types = new Set();
    const addNodes = (list) => { for (const n of list || []) if (n && n.type) types.add(n.type); };
    addNodes(wf.nodes);
    for (const sg of (wf.definitions && wf.definitions.subgraphs) || []) addNodes(sg.nodes);
    for (const g of Object.values((wf.extra && wf.extra.groupNodes) || {})) addNodes(g && g.nodes);
    const used = new Set(), unmapped = [];
    for (const t of types) {
      let hit = false;
      for (const f of (providers && providers[t]) || []) { used.add(f.toLowerCase()); hit = true; }
      const mod = info[t] && info[t].python_module;
      const m = typeof mod === 'string' && mod.match(/^custom_nodes\.([^.]+)/);
      if (m) { used.add(m[1].toLowerCase()); hit = true; }
      else if (info[t]) hit = true;                              // core node
      if (!hit && !FRONTEND_TYPES.test(t)) unmapped.push(t);
    }
    if (unmapped.length) throw new Error('unmapped node types: ' + unmapped.slice(0, 5).join(', '));
    // Packs whose JS registers GLOBAL widget types (getCustomWidgets: COLOR, BOOL, COLORCODE...) are never pruned: without them every input of
    // that type becomes a socket and widgets_values shift. The list comes from the server (node-packs "__widget_providers__"); an older
    // server without it, or no provider map at all, means we cannot know -> no pruning.
    const wp = providers && providers.__widget_providers__;
    if (!Array.isArray(wp)) throw new Error('node-packs has no widget provider list (server restart needed)');
    for (const f of wp) used.add(String(f).toLowerCase());
    B.prune.widgetProviders = wp.slice();
    // Without the provider map, a node reported by a pack that ships no frontend script of its own (wrapper packs such as
    // comfyui-workflow-encrypt re-register other packs' nodes) may get its widgets from a pack we cannot identify: do not prune.
    B.prune.providerMap = !!providers;
    return { used, ambiguousOK: !!providers };
  })().catch((e) => { B.prune.state = 'skipped: ' + (e && e.message || e); return null; });
  const denied = (rel) => {
    const r = rel.toLowerCase();
    if (r.endsWith(OWN_EXT_FILE)) return true;
    return ALWAYS_DENY.concat(KEEP_ALL_EXT ? [] : DENYLIST).some((e) => r === e || r.startsWith(e + '/'));
  };
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const overridden = (k) => Object.prototype.hasOwnProperty.call(PHONE_SETTINGS, k);

  function describe(input, init) {
    let url, method = 'GET';
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && input.url) { url = input.url; method = input.method || 'GET'; }
    if (init && init.method) method = init.method;
    let u; try { u = new URL(url, location.href); } catch { return null; }
    if (u.origin !== location.origin) return null;
    return { u, method: String(method).toUpperCase(), p: u.pathname.replace(/^\/api(?=\/)/, '') };
  }
  async function bodyText(input, init) {
    if (init && init.body !== undefined && init.body !== null) return typeof init.body === 'string' ? init.body : null;
    if (input && typeof input !== 'string' && !(input instanceof URL) && input.clone) return await input.clone().text();
    return null;
  }

  window.fetch = async function (input, init) {
    let d; try { d = describe(input, init); } catch { d = null; }
    if (!d) return origFetch(input, init);
    const { p, method } = d;
    try {
      // --- extension list
      if (method === 'GET' && p === '/extensions') {
        const res = await origFetch(input, init);
        if (!res.ok) return res;
        const list = await res.clone().json();
        if (!Array.isArray(list)) return res;
        const pi = await pruneInfo;   // {used: Set of lower-case pack folder names used by the workflow, ambiguousOK} or null
        let used = pi && pi.used;
        if (used && !pi.ambiguousOK) {
          const withJs = new Set(list.map((e) => (String(e).match(/^\/extensions\/([^/]+)\//) || [])[1]).filter(Boolean).map((x) => x.toLowerCase()));
          const noJs = [...used].filter((u) => !withJs.has(u));
          if (noJs.length) { B.prune.state = 'skipped: used pack(s) without frontend scripts and no provider map: ' + noJs.join(','); used = null; }
        }
        if (used) B.prune.state = 'active';
        const keptPacks = new Set(), prunedPacks = new Set();
        const keep = [];
        for (const e of list) {
          const m = typeof e === 'string' && e.match(/^\/extensions\/(.+)$/);
          let drop = !!m && denied(m[1]);
          const pack = m && m[1].split('/')[0].toLowerCase();
          if (m && !drop && used && pack !== 'core' && !used.has(pack) && (PRUNE_ALL || !NEVER_DROP.includes(pack))) { drop = true; prunedPacks.add(pack); }
          else if (m && pack !== 'core') keptPacks.add(pack);
          if (drop) B.droppedExt.push(m[1]); else keep.push(e);
        }
        B.prune.keptPacks = [...keptPacks].sort(); B.prune.prunedPacks = [...prunedPacks].sort();
        B.keptExt = keep.length;
        return jsonResponse(keep, res.status);
      }
      // --- object_info: hand over the prefetched copy
      if (method === 'GET' && p === '/object_info') {
        await pruneInfo;
        if (objectInfoText !== null) { const t = objectInfoText; objectInfoText = null; return new Response(t, { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        return origFetch(input, init);
      }
      // --- settings read: merge phone overrides
      if (method === 'GET' && p === '/settings') {
        const res = await origFetch(input, init);
        if (!res.ok) return res;
        const s = await res.clone().json();
        B.settingsReads++;
        return jsonResponse(Object.assign({}, s, PHONE_SETTINGS), res.status);
      }
      const one = p.match(/^\/settings\/(.+)$/);
      if (one) {
        const id = decodeURIComponent(one[1]);
        if (method === 'GET' && overridden(id)) return jsonResponse(PHONE_SETTINGS[id]);
        if ((method === 'POST' || method === 'PUT') && overridden(id)) {
          B.droppedWrites.push(id);
          return new Response(null, { status: 200 });
        }
        if (method === 'POST' || method === 'PUT') B.passedWrites.push(id);
        return origFetch(input, init);
      }
      // --- bulk settings write (POST /settings, or the settings file through the userdata API)
      const isFile = /^\/userdata\/(?:.*%2F)?comfy\.settings\.json$/i.test(p) || /^\/userdata\/comfy\.settings\.json$/i.test(p);
      if ((method === 'POST' || method === 'PUT') && (p === '/settings' || isFile)) {
        const txt = await bodyText(input, init);
        let obj = null; try { obj = txt === null ? null : JSON.parse(txt); } catch {}
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          if (isFile) { B.droppedWrites.push('(unparseable settings file write)'); return new Response(null, { status: 200 }); }
          return origFetch(input, init);
        }
        const rest = {};
        for (const k of Object.keys(obj)) { if (overridden(k)) B.droppedWrites.push(k); else { rest[k] = obj[k]; B.passedWrites.push(k); } }
        if (!Object.keys(rest).length) return new Response(null, { status: 200 });
        const headers = (init && init.headers) || (input && input.headers) || { 'Content-Type': 'application/json' };
        return origFetch(d.u.href, { method, headers, body: JSON.stringify(rest), credentials: 'same-origin' });
      }
    } catch (e) { fail('fetch ' + method + ' ' + p, e); }
    return origFetch(input, init);
  };

  // ------------------------------------------------------------------ toasts that only make sense on the desktop
  // (the frontend raises "ComfyUI-Manager upgrade required" because the legacy manager UI is old; it is not an extension.)
  const HIDE_TOAST = [/ComfyUI-Manager upgrade required/i];
  try {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const msgs = n.matches && n.matches('.p-toast-message') ? [n] : (n.querySelectorAll ? n.querySelectorAll('.p-toast-message') : []);
        for (const el of msgs) if (HIDE_TOAST.some((re) => re.test(el.textContent || ''))) {
          el.setAttribute('data-canvas-hide', '1');
          const x = el.querySelector('.p-toast-close-button'); if (x) setTimeout(() => x.click(), 0);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  } catch (e) { fail('toast observer', e); }

  // ------------------------------------------------------------------ in-memory assertion + 6. ?path
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function untilReady(timeout = 120000) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      const a = window.app;
      const wf = a && a.extensionManager && a.extensionManager.workflow;
      if (a && a.canvas && a.canvas.canvas && wf && wf.activeWorkflow && wf.getWorkflowByPath) return a;
      await sleep(40);
    }
    throw new Error('app not ready');
  }

  async function openSaved(app, rel, fresh) {
    const wfStore = app.extensionManager.workflow;
    const key = 'workflows/' + rel.replace(/^\/+/, '');
    let wf = wfStore.getWorkflowByPath(key);
    if (!wf) { await wfStore.syncWorkflows(); wf = wfStore.getWorkflowByPath(key); }
    if (!wf) throw new Error('workflow not found: ' + rel);
    // what WorkflowService.openWorkflow does for a persisted workflow
    if (!wf.isLoaded) await wf.load();
    B.internal = true;
    let ok; try { ok = await app.loadGraphData(JSON.parse(fresh && wf.originalContent ? wf.originalContent : JSON.stringify(wf.activeState)), true, true, wf, { checkForRerouteMigration: false, deferWarnings: true }); } finally { B.internal = false; }
    if (ok === false) throw new Error('loadGraphData refused ' + rel);
    return wf;
  }

  // ------------------------------------------------------------------ unsaved-changes draft (written by toolbar.js, restored here)
  const DRAFT_PREFIX = 'comfypocket.canvas.draft:';
  const OPEN_KEY = 'comfypocket.canvas.open';
  async function restoreDraft(app) {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_PREFIX + WORKFLOW_PATH) || 'null'); } catch {}
    if (!d || !d.graph || !d.ts) return;
    let mtime = 0;
    try { const r = await origFetch('/api/userdata/' + encodeURIComponent('workflows/' + WORKFLOW_PATH.replace(/^\/+/, ''))); const lm = r.headers.get('Last-Modified'); mtime = lm ? Date.parse(lm) : 0; } catch {}
    if (!(d.ts > mtime)) { try { localStorage.removeItem(DRAFT_PREFIX + WORKFLOW_PATH); } catch {} return; }
    const wf = app.extensionManager.workflow.activeWorkflow;
    B.internal = true;
    try { await app.loadGraphData(JSON.parse(JSON.stringify(d.graph)), true, true, wf, { checkForRerouteMigration: false, deferWarnings: true }); }
    finally { B.internal = false; }
    try {   // loading with the workflow resets the change tracker's baseline to the draft: put the saved file back as baseline so it counts as modified (Save + draft logic)
      const ct = wf.changeTracker, base = wf.originalContent ? JSON.parse(wf.originalContent) : null;
      if (base) ct.initialState = base;
      ct.checkState();
      if (typeof ct.updateModified === 'function') ct.updateModified();
      if (!wf.isModified) wf.isModified = true;
    } catch (e) { fail('draft baseline', e); }
    B.draftRestored = true;
    const ui = B.toolbar && B.toolbar.chip;
    if (ui) ui('Restored unsaved changes', 'Discard', async () => {
      try { localStorage.removeItem(DRAFT_PREFIX + WORKFLOW_PATH); } catch {}
      B.internal = true; try { await openSaved(app, WORKFLOW_PATH, true); try { const ct = wf.changeTracker; ct.initialState = JSON.parse(wf.originalContent); ct.checkState(); if (typeof ct.updateModified === 'function') ct.updateModified(); if (wf.isModified) wf.isModified = false; } catch {} } finally { B.internal = false; }
    });
  }

  // Pruning was decided for ?path only. When the user opens ANOTHER workflow (sidebar, Open, recent, drop) its packs may be missing,
  // so reload the page for it: saved ones with ?path=<it>, unsaved / dropped ones through sessionStorage with pruning off.
  function guardLoads(app) {
    if (B.prune.state !== 'active' || app.__canvasGuard) return;
    app.__canvasGuard = true;
    const orig = app.loadGraphData.bind(app);
    app.loadGraphData = function (graphData, clean, restoreView, workflow, options) {
      if (B.internal || B.prune.state !== 'active') return orig(graphData, clean, restoreView, workflow, options);
      const wp = workflow && typeof workflow === 'object' && !workflow.isTemporary && typeof workflow.path === 'string' ? workflow.path.replace(/^workflows\//, '') : '';
      if (wp && wp === WORKFLOW_PATH) return orig(graphData, clean, restoreView, workflow, options);
      B.guarded = wp || '(unsaved)';
      const q = new URLSearchParams(location.search);
      try { sessionStorage.removeItem('comfypocket.canvas'); } catch {}
      if (wp) { q.set('path', wp); q.delete('open'); }
      else {
        try { sessionStorage.setItem(OPEN_KEY, JSON.stringify({ graph: graphData, name: typeof workflow === 'string' ? workflow : (workflow && workflow.filename) || null })); } catch (e) { fail('stash', e); return orig(graphData, clean, restoreView, workflow, options); }
        q.delete('path'); q.set('prune', '0'); q.set('open', '1');
      }
      try { sessionStorage.setItem('comfypocket.canvas', JSON.stringify({ search: '?' + q })); } catch {}
      location.href = '/pocket/canvas?' + q;
      return new Promise(() => {});
    };
  }

  B.ready = (async () => {
    const app = await untilReady();
    try {   // assert the overrides really are what the store holds (the settings POSTs are dropped anyway)
      const st = app.extensionManager.setting;
      B.settingMismatch = [];
      for (const k of Object.keys(PHONE_SETTINGS)) {
        let cur; try { cur = st.get(k); } catch { continue; }
        if (cur !== PHONE_SETTINGS[k]) { B.settingMismatch.push(k + '=' + cur); try { await st.set(k, PHONE_SETTINGS[k]); } catch (e) { fail('set ' + k, e); } }
      }
      const sb = app.extensionManager.sidebarTab;
      if (sb && sb.activeSidebarTabId) sb.toggleSidebarTab(sb.activeSidebarTabId);
    } catch (e) { fail('apply settings', e); }
    if (WORKFLOW_PATH) {
      try { await openSaved(app, WORKFLOW_PATH); B.pathState = 'open'; }
      catch (e) { B.pathState = 'error'; fail('open ?path', e); }
    }
    if (Q.get('open') === '1') {   // a dropped / unsaved workflow handed over by guardLoads() (stashed in sessionStorage)
      try {
        const o = JSON.parse(sessionStorage.getItem(OPEN_KEY) || 'null'); sessionStorage.removeItem(OPEN_KEY);
        if (o && o.graph) { B.internal = true; try { await app.loadGraphData(o.graph, true, true, o.name || null); } finally { B.internal = false; } B.pathState = 'open'; }
      } catch (e) { fail('open stashed workflow', e); }
    }
    if (Q.get('gestures') !== '0') {   // gesture compositor (web/canvas/gestures.js): CSS-transform pan/pinch, one exact ds update at the end
      try {
        const pm = await import('/pocket/static/canvas/prefs.js'); B.prefs = pm.sharedPrefs();   // touch prefs: localStorage only, shared with toolbar.js
        const m = await import('/pocket/static/canvas/gestures.js'); B.gestures = m.install(app, { prefs: B.prefs }); B.gesturesState = 'installed';
      }
      catch (e) { B.gesturesState = 'error'; fail('gestures', e); }
    } else B.gesturesState = 'off';
    try { const m = await import('/pocket/static/canvas/toolbar.js'); B.toolbar = m.install(app); B.toolbarState = 'installed'; }   // touch toolbar (toolbar.js)
    catch (e) { B.toolbarState = 'error'; fail('toolbar', e); }
    if (WORKFLOW_PATH && B.pathState === 'open') {
      try { const m = await import('/pocket/static/mode.js'); m.writeMode(WORKFLOW_PATH, 'canvas'); } catch (e) { fail('writeMode', e); }   // mobile app's "Continue in canvas" chip
      try { await restoreDraft(app); } catch (e) { fail('draft', e); }
    }
    guardLoads(app);
    B.readyAt = performance.now();
    document.documentElement.setAttribute('data-canvas-ready', B.pathState);
    return B;
  })().catch((e) => { fail('ready', e); return B; });
})();
