// ComfyUI Pocket desktop-side extension.
//  (a) phone redirect to /pocket/ (runs at module top level, before app setup finishes)
//  (b) converter bridge: /?pocketconvert=1 inside an iframe converts UI workflows to API prompts
//  (c) desktop auto-snapshot on queue + "Send workflow to Pocket" command
// Everything is wrapped defensively: this file must never break the normal UI.

const TAG = "[pocket]";
// informational logging is opt-in: localStorage "comfypocket.debug" = "1" or ?debug=1 (warnings and errors always show)
const debugOn = () => {
  try { return localStorage.getItem("comfypocket.debug") === "1" || new URLSearchParams(location.search).get("debug") === "1"; } catch { return false; }
};
const log = (...a) => { if (debugOn()) console.log(TAG, ...a); };
const warn = (...a) => console.warn(TAG, ...a);

const params = new URLSearchParams(location.search);
const inFrame = (() => {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
})();
const isConverter = params.get("pocketconvert") === "1" && inFrame;

// ---------------------------------------------------------------- (a) redirect
let redirecting = false;
if (!isConverter && !inFrame) {
  try {
    // one-time migration of the pre-rename opt-out flag
    const oldFlag = localStorage.getItem("comfymobile.desktop");
    if (oldFlag !== null) {
      if (localStorage.getItem("comfypocket.desktop") === null) localStorage.setItem("comfypocket.desktop", oldFlag);
      localStorage.removeItem("comfymobile.desktop");
    }
    if (params.has("desktop")) {
      // ?desktop=1 sets the opt-out flag, ?desktop=0 clears it.
      if (params.get("desktop") === "0") localStorage.removeItem("comfypocket.desktop");
      else localStorage.setItem("comfypocket.desktop", "1");
    } else {
      const optedOut = localStorage.getItem("comfypocket.desktop") === "1";
      const phone = window.matchMedia("(pointer: coarse) and (max-width: 820px)").matches;
      if (phone && !optedOut) {
        redirecting = true;
        log("phone detected, redirecting to /pocket/");
        // a reload of canvas mode (boot.js rewrote its URL to "/") returns to /pocket/canvas
        let dest = "/pocket/";
        try { const c = JSON.parse(sessionStorage.getItem("comfypocket.canvas") || "null"); if (c && typeof c.search === "string") dest = "/pocket/canvas" + c.search; } catch {}
        location.replace(dest);
      }
    }
  } catch (e) {
    warn("redirect check failed", e);
  }
}
if (redirecting) {
  // Keep the extension-loading promise pending so the frontend does not go on to
  // restore the graph while the navigation is in flight. Fall through after 4s in
  // case the navigation was blocked, so the desktop UI is never left hanging.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  redirecting = false;
}

// ------------------------------------------------------------------- shared
const { app } = await import("../../scripts/app.js");
const { api } = await import("../../scripts/api.js");

function apiUrl(path) {
  return `${api.api_base || ""}${path}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getActiveWorkflow() {
  try {
    const store = app.extensionManager?.workflow;
    let aw = store?.activeWorkflow;
    if (aw && typeof aw === "object" && "value" in aw && !("path" in aw)) aw = aw.value;
    return aw || null;
  } catch (e) {
    return null;
  }
}

// Path relative to user/default/workflows, or null for unsaved/temporary workflows.
function activeWorkflowRelPath() {
  const wf = getActiveWorkflow();
  if (!wf || wf.isTemporary || !wf.path) return null;
  let p = typeof wf.key === "string" && wf.key ? wf.key : String(wf.path);
  p = p.replace(/^workflows\//, "");
  return p || null;
}

function toast(severity, summary, detail) {
  try {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 3500 });
  } catch (e) {
    /* ignore */
  }
}

async function putSnapshot(relPath, prompt) {
  const url = apiUrl(`/pocket/api/snapshots?path=${encodeURIComponent(relPath)}`);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, workflow_mtime: null, source: "desktop" }),
  });
  if (res.status === 404) {
    warn("snapshot endpoint not available (404), skipping");
    return false;
  }
  if (!res.ok) {
    warn("snapshot PUT failed", res.status);
    return false;
  }
  log("snapshot saved for", relPath);
  return true;
}

// ----------------------------------------------------- (c) desktop snapshot
function installSnapshotHooks() {
  // Wrap api.queuePrompt so we snapshot exactly the prompt that was submitted
  // (graphToPrompt after queueing would already contain the next control_after_generate seed).
  const original = api.queuePrompt;
  if (typeof original === "function" && !original.__comfyPocketWrapped) {
    const wrapped = async function (number, data, ...rest) {
      let relPath = null;
      try {
        relPath = activeWorkflowRelPath();
      } catch (e) {
        /* ignore */
      }
      const result = await original.call(this, number, data, ...rest);
      try {
        if (relPath && data && data.output && result && result.prompt_id) {
          const output = JSON.parse(JSON.stringify(data.output));
          putSnapshot(relPath, output).catch((e) => warn("auto-snapshot failed", e));
        }
      } catch (e) {
        warn("auto-snapshot error", e);
      }
      return result;
    };
    wrapped.__comfyPocketWrapped = true;
    api.queuePrompt = wrapped;
  }
}

async function sendWorkflowToPocket() {
  try {
    const relPath = activeWorkflowRelPath();
    if (!relPath) {
      toast("warn", "Send to Pocket", "Save the workflow first (it has no file path).");
      return;
    }
    const { output } = await app.graphToPrompt();
    const ok = await putSnapshot(relPath, output);
    toast(
      ok ? "success" : "warn",
      "Send to Pocket",
      ok ? `Snapshot saved for ${relPath}` : "Snapshot endpoint unavailable."
    );
  } catch (e) {
    warn("send workflow failed", e);
    toast("error", "Send to Pocket", String(e?.message || e));
  }
}

// -------------------------------------------------------- (b) converter bridge
function installConverterBridge() {
  // The iframe shares localStorage/sessionStorage with the desktop tab. Make it read-only
  // for workflow state so converting never clobbers drafts / open tabs / restored graph.
  try {
    const proto = Storage.prototype;
    const origGet = proto.getItem;
    proto.setItem = function () {};
    proto.removeItem = function () {};
    proto.clear = function () {};
    proto.getItem = function (k) {
      if (this === window.localStorage && /workflow/i.test(String(k))) return null;
      return origGet.call(this, k);
    };
  } catch (e) {
    warn("storage guard failed", e);
  }
  try {
    const style = document.createElement("style");
    style.textContent =
      ".p-toast,.p-dialog-mask,.p-confirmdialog,.comfy-modal,.p-popover{display:none!important}";
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {
    /* ignore */
  }

  let readyFlag = false;
  let resolveReady;
  const readyPromise = new Promise((r) => {
    resolveReady = r;
  });
  let chain = Promise.resolve();

  const post = (msg) => {
    try {
      window.parent.postMessage(msg, location.origin);
    } catch (e) {
      warn("postMessage failed", e);
    }
  };

  async function waitForAppStartup() {
    // setup() runs inside app.setup(); the graph is restored afterwards while the
    // workspace spinner is still on. Wait for it to clear so our load is not superseded.
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const spinner = app.extensionManager?.spinner;
      if (spinner === false && getActiveWorkflow()) break;
      await sleep(100);
    }
    await sleep(300);
  }

  // Temporary workflows that the converter has been sitting on (initial default + ones it created).
  const trackedTemps = new Set();

  function closeStaleTemporary() {
    // Each loadGraphData(.., null) opens a new temporary workflow tab; drop every tracked
    // temporary one except the active so the long-lived iframe does not accumulate tabs.
    try {
      const store = app.extensionManager?.workflow;
      const cur = getActiveWorkflow();
      if (cur && cur.isTemporary) trackedTemps.add(cur);
      for (const wf of Array.from(trackedTemps)) {
        if (wf === cur) continue;
        trackedTemps.delete(wf);
        if (wf.isTemporary && typeof store?.closeWorkflow === "function") {
          Promise.resolve(store.closeWorkflow(wf)).catch((e) => warn("closeWorkflow failed", e));
        }
      }
    } catch (e) {
      warn("closeStaleTemporary failed", e);
    }
  }

  // --- mode overrides + structure -------------------------------------------------------------
  const MODE_VALUES = new Set([0, 2, 4]);

  function findNodeByUiId(id) {
    // "12" -> top-level node 12; "7:3" -> node 3 inside the subgraph instance 7 (nested: "7:3:5").
    const parts = String(id).split(":");
    let graph = app.graph;
    let node = null;
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      const n = Number(raw);
      node = graph?.getNodeById?.(Number.isNaN(n) ? raw : n) || null;
      if (!node) return null;
      if (i < parts.length - 1) {
        graph = node.subgraph;
        if (!graph) return null;
      }
    }
    return node;
  }

  function applyModes(modes) {
    if (!modes || typeof modes !== "object") return;
    for (const [id, mode] of Object.entries(modes)) {
      if (!MODE_VALUES.has(Number(mode))) continue;
      const node = findNodeByUiId(id);
      if (node) node.mode = Number(mode);
      else warn("mode override for unknown node", id);
    }
  }

  const uniformMode = (nodes) => {
    if (!nodes.length) return 0;
    const m = nodes[0].mode;
    return nodes.every((n) => n.mode === m) ? m : "mixed";
  };

  const MAX_SG_DEPTH = 8;

  // Subgraph definition -> the ui-id path of its first instance ("7", nested "7:3"), so its inner nodes get ids findNodeByUiId resolves.
  // Definitions without an instance can't change the prompt and are skipped.
  function subgraphPaths(graph) {
    const paths = new Map();
    const walk = (g, prefix, depth) => {
      if (depth > MAX_SG_DEPTH) return;
      for (const n of g?.nodes ?? g?._nodes ?? []) {
        if (!n?.isSubgraphNode?.() || !n.subgraph) continue;
        const path = `${prefix}${n.id}`;
        if (paths.has(n.subgraph)) continue;
        paths.set(n.subgraph, path);
        walk(n.subgraph, `${path}:`, depth + 1);
      }
    };
    walk(graph, "", 0);
    return paths;
  }

  // A node plus, depth-first, every node inside it when it is a subgraph instance (rgthree's changeModeOfNodes does the same).
  // `stack` holds the definitions being expanded, so a self-referencing subgraph stops instead of fabricating deep ids.
  const innerNodes = (sg) => sg?.nodes ?? sg?._nodes ?? [];
  function expandNode(node, id, out, stack = []) {
    out.push({ n: node, id });
    const sg = node.isSubgraphNode?.() ? node.subgraph : null;
    if (!sg || stack.length >= MAX_SG_DEPTH || stack.includes(sg)) return;
    stack.push(sg);
    for (const c of innerNodes(sg)) expandNode(c, `${id}:${c.id}`, out, stack);
    stack.pop();
  }

  // Same set and order as rgthree's FastGroupsService.getGroupsUnsorted: the root graph's groups, then those of all subgraph definitions (also ones without an instance, which can't change the prompt but count for restrictions).
  function collectGroups() {
    const graph = app.graph;
    const list = [...(graph?._groups || [])].map((g) => ({ g, prefix: "" }));
    const paths = subgraphPaths(graph);
    for (const sg of graph?.subgraphs?.values?.() || []) {
      const prefix = paths.get(sg);
      for (const g of [...(sg._groups || sg.groups || [])]) list.push({ g, prefix: prefix === undefined ? null : `${prefix}:`, sub: String(sg.name ?? ""), sgRef: sg });
    }
    // Nodes of a graph that was never drawn (a subgraph definition) have empty bounds until updateArea runs, as in rgthree's service.
    let ctx = null;
    const measured = new Set();
    const measure = (owner) => {
      if (!owner || measured.has(owner)) return;
      measured.add(owner);
      for (const n of owner._nodes ?? owner.nodes ?? []) {
        const b = n.boundingRect;
        if (b && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0) {
          try {
            ctx ||= document.createElement("canvas").getContext("2d");
            n.updateArea?.(ctx);
          } catch (e) {
            warn("updateArea failed", e);
          }
        }
      }
    };
    return list.map((x, i) => {
      const { g } = x;
      measure(g.graph || x.sgRef || graph);
      try {
        g.recomputeInsideNodes?.();
      } catch (e) {
        warn("recomputeInsideNodes failed", e);
      }
      const owner = g.graph || x.sgRef || graph;
      const kids = (g._children ? Array.from(g._children) : g.nodes || []).filter((c) => c && typeof c.mode === "number" && c.id != null && c.graph === owner);
      // direct members decide the group's state (rgthree); the expanded list is only for the mode patch.
      // Groups of definitions without an instance have no addressable ids: no ids, state from the direct members.
      const members = [];
      const direct = x.prefix === null ? [] : kids.map((c) => ({ n: c, id: `${x.prefix}${c.id}` }));
      if (x.prefix !== null) for (const c of kids) expandNode(c, `${x.prefix}${c.id}`, members);
      return { ...x, id: `g${i}`, members, direct, directNodes: kids };
    });
  }

  function buildStructure(output) {
    const graph = app.graph;
    const rawGroups = collectGroups();
    const groups = rawGroups.map(({ g, id, members, direct, directNodes, sub }) => {
      const row = {
        id,
        title: String(g.title ?? ""),
        memberIds: direct.map((m) => String(m.id)),
        nodeIds: members.map((m) => String(m.id)),
        mode: uniformMode(directNodes),
      };
      if (sub !== undefined) row.subgraph = sub;
      return row;
    });

    // rgthree Fast Groups Bypasser / Muter: same filtering and ordering as BaseFastGroupsModeChanger.refreshWidgets
    const controllers = [];
    for (const node of graph?._nodes || []) {
      const t = String(node.type || "");
      const kind = /^Fast Groups Bypasser/i.test(t) ? "bypass" : /^Fast Groups Muter/i.test(t) ? "mute" : null;
      if (!kind) continue;
      const props = node.properties || {};
      let list = rawGroups.slice();
      // rgthree default is true; false keeps only the groups of the graph being edited (the root graph here)
      if (!(props.showAllGraphs === undefined ? true : props.showAllGraphs)) list = list.filter((x) => x.prefix === "");
      const sort = props.sort || "position";
      const byTitle = (a, b) => String(a.g.title).localeCompare(String(b.g.title));
      let alpha = [];
      if (sort === "custom alphabet") {
        const str = String(props.customSortAlphabet || "").replace(/\n/g, "");
        if (str.trim()) alpha = str.includes(",") ? str.toLowerCase().split(",") : str.toLowerCase().trim().split("");
      }
      if (sort === "alphanumeric" || (sort === "custom alphabet" && !alpha.length)) {
        list.sort(byTitle);
      } else if (sort === "custom alphabet") {
        const idx = (title) => alpha.findIndex((a) => title.toLowerCase().startsWith(a));
        list.sort((a, b) => {
          const ai = idx(String(a.g.title));
          const bi = idx(String(b.g.title));
          if (ai > -1 && bi > -1) return ai - bi || byTitle(a, b);
          if (ai > -1) return -1;
          if (bi > -1) return 1;
          return byTitle(a, b);
        });
      } else {
        const pos = (g) => g._pos || g.pos || [0, 0];
        list.sort((a, b) => {
          const aY = Math.floor(pos(a.g)[1] / 30);
          const bY = Math.floor(pos(b.g)[1] / 30);
          if (aY === bY) return Math.floor(pos(a.g)[0] / 30) - Math.floor(pos(b.g)[0] / 30);
          return aY - bY;
        });
      }
      const normColor = (c) => {
        let v = String(c || "").trim().toLowerCase();
        const preset = globalThis.LGraphCanvas?.node_colors?.[v];
        if (preset) v = String(preset.groupcolor).toLowerCase();
        v = v.replace("#", "");
        if (v.length === 3) v = v.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
        return `#${v}`;
      };
      const colors = String(props.matchColors || "").split(",").filter((c) => c.trim()).map(normColor);
      if (colors.length) list = list.filter(({ g }) => g.color && colors.includes(normColor(g.color)));
      if (String(props.matchTitle || "").trim()) {
        let re = null;
        try {
          re = new RegExp(props.matchTitle, "i");
        } catch (e) {
          warn("bad matchTitle", props.matchTitle);
        }
        list = re ? list.filter(({ g }) => re.exec(String(g.title))) : [];
      }
      controllers.push({
        id: String(node.id),
        title: String(node.title || t),
        kind,
        groups: list.map(({ id }) => id),   // group ids (structure.groups[].id), not titles: titles can repeat
        restriction: props.toggleRestriction || "default",
        mode: node.mode,
      });
    }

    const nodes = (graph?._nodes || []).map((n) => {
      const row = { id: String(n.id), title: String(n.title ?? n.type ?? ""), type: String(n.type ?? ""), mode: n.mode };
      if (n.isSubgraphNode?.() && n.subgraph) {
        // every node inside, nested subgraphs included, with its full ui-id path
        const inner = [];
        expandNode(n, String(n.id), inner);
        inner.shift();
        row.subgraph = inner.map(({ n: c, id }) => ({ id, title: String(c.title ?? c.type ?? ""), type: String(c.type ?? ""), mode: c.mode }));
      }
      return row;
    });

    // uiId -> API prompt ids. API ids are execution ids ("52", or "7:3" inside subgraph instance 7);
    // a key is listed under every prefix path, so a subgraph instance maps to all its inner prompt ids.
    const apiIds = {};
    for (const key of Object.keys(output)) {
      const parts = key.split(":");
      for (let i = 1; i <= parts.length; i++) {
        const ui = parts.slice(0, i).join(":");
        (apiIds[ui] ||= []).push(key);
      }
    }
    return { groups, controllers, nodes, apiIds, controls: seedControls(graph, output) };
  }

  // apiId -> {seedInput: 'randomize'|'fixed'|'increment'|'decrement'}, read from the live control_after_generate widgets.
  function seedControls(graph, output) {
    const res = {};
    const visit = (node, key) => {
      if (!output[key]) return;
      for (const w of node.widgets || []) {
        const lw = (w.linkedWidgets || []).find((x) => x?.name === "control_after_generate");
        if (lw && typeof lw.value === "string") (res[key] ||= {})[w.name] = lw.value;
      }
    };
    try {
      const all = [];
      for (const n of graph?._nodes || []) expandNode(n, String(n.id), all);
      for (const { n, id } of all) visit(n, id);
    } catch (e) {
      warn("seedControls failed", e);
    }
    return res;
  }

  // Why a workflow gave an empty prompt, in words for the phone (the desktop frontend only logs to its console).
  function emptyReason(workflow) {
    try {
      const lists = [["", workflow?.nodes]];
      for (const d of workflow?.definitions?.subgraphs || []) lists.push([`${d.name || d.id}: `, d.nodes]);
      const bad = new Set();
      const reg = globalThis.LiteGraph?.registered_node_types || null;
      const defIds = new Set((workflow?.definitions?.subgraphs || []).map((d) => String(d.id)));
      const missing = new Set();
      let total = 0;
      let active = 0;
      for (const [where, list] of lists) {
        for (const n of Array.isArray(list) ? list : []) {
          total++;
          if (n?.mode === 0 || n?.mode === undefined) active++;
          for (const k of ["inputs", "outputs"]) if (n && n[k] != null && !Array.isArray(n[k])) bad.add(`${where}node ${n.id} (${n.type})`);
          if (reg && n?.type && !reg[n.type] && !defIds.has(String(n.type))) missing.add(String(n.type));
        }
      }
      if (!Array.isArray(workflow?.nodes) || !total) return "The workflow file has no nodes.";
      if (bad.size) return `Malformed workflow file: ${bad.size} node(s), e.g. ${[...bad][0]}, store "inputs" or "outputs" as an object instead of a list. The desktop can't open it either.`;
      if (missing.size) return `Missing node types: ${[...missing].slice(0, 6).join(", ")}${missing.size > 6 ? ", ..." : ""}. Install the custom nodes that provide them.`;
      if (!active) return "Every node in this workflow is muted or bypassed, so there is nothing to run.";
    } catch (e) {
      warn("emptyReason failed", e);
    }
    return "The workflow produced an empty prompt (nothing to run: no output node is enabled).";
  }

  async function convertOnce(workflow, modes) {
    const prev = getActiveWorkflow();
    if (prev && prev.isTemporary) trackedTemps.add(prev);
    try {
      await app.loadGraphData(workflow, true, false, null, {
        deferWarnings: true,
        skipAssetScans: true,
        silentAssetErrors: true,
      });
      applyModes(modes);
      const res = await app.graphToPrompt();
      const output = res && res.output;
      if (!output || !Object.keys(output).length) throw new Error(emptyReason(workflow));
      const prompt = JSON.parse(JSON.stringify(output));
      let structure = null;
      try {
        structure = JSON.parse(JSON.stringify(buildStructure(prompt)));
      } catch (e) {
        warn("structure failed", e);
      }
      return { prompt, structure };
    } finally {
      closeStaleTemporary();
    }
  }

  // Returns {prompt, structure} or throws; never posts by itself.
  async function doConvert(msg) {
    const { workflow, path, modes } = msg;
    if (!workflow || typeof workflow !== "object") throw new Error("missing workflow");
    let result;
    try {
      result = await convertOnce(workflow, modes);
    } catch (e) {
      // One retry, e.g. if the initial graph restore superseded the first load.
      warn("convert failed, retrying once", e);
      await sleep(500);
      result = await convertOnce(workflow, modes);
    }
    log("converted", path || "(no path)", Object.keys(result.prompt).length, "nodes");
    return result;
  }

  const CONVERT_TIMEOUT_MS = 90000;
  const pendingIds = new Set();

  function runQueued(msg) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (reply) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        pendingIds.delete(msg.id);
        post(reply);
        return true;
      };
      const armTimer = () => {
        timer = setTimeout(() => {
        if (!finish({ type: "convert_error", id: msg.id, message: "conversion timed out" })) return;
        // The hung conversion may still be running inside the frontend; do not start the next
        // one on top of it. Fail everything still queued and reload the iframe: the parent
        // must wait for a fresh {type:'ready'} and resend.
        warn("conversion timed out, reloading converter iframe");
        for (const id of Array.from(pendingIds)) {
          post({ type: "convert_error", id, message: "converter reloading after timeout" });
        }
        pendingIds.clear();
        try {
          location.reload();
        } catch (e) {
          warn("reload failed", e);
        }
        // Never resolve: keep the chain blocked until the reload replaces this document.
        }, CONVERT_TIMEOUT_MS);
      };

      // The timeout only covers the conversion itself, not the wait for the app to start.
      readyPromise.then(() => {
        armTimer();
        return doConvert(msg);
      }).then(
        (result) => {
          finish({ type: "converted", id: msg.id, prompt: result.prompt, structure: result.structure });
          resolve();
        },
        (e) => {
          warn("convert error", e);
          finish({ type: "convert_error", id: msg.id, message: String(e?.message || e) });
          resolve();
        }
      );
    });
  }

  // Listener is registered immediately so early messages are queued until ready.
  window.addEventListener("message", (ev) => {
    try {
      if (ev.origin !== location.origin) return;
      if (ev.source !== window.parent) return;
      const msg = ev.data;
      if (!msg || msg.type !== "convert") return;
      pendingIds.add(msg.id);
      // Serialize conversions: one at a time.
      chain = chain.then(() => runQueued(msg)).catch((e) => warn("queue error", e));
    } catch (e) {
      warn("message handler error", e);
    }
  });

  return {
    async onSetup() {
      await waitForAppStartup();
      readyFlag = true;
      resolveReady();
      log("converter ready");
      post({ type: "ready" });
    },
    get ready() {
      return readyFlag;
    },
  };
}

// ------------------------------------------------------------- registration
let converter = null;
if (isConverter) {
  try {
    converter = installConverterBridge();
  } catch (e) {
    warn("converter init failed", e);
  }
}

const extension = {
  name: "ComfyUIPocket",
  commands: [
    {
      id: "ComfyPocket.SendWorkflow",
      label: "Send workflow to Pocket",
      icon: "pi pi-mobile",
      function: sendWorkflowToPocket,
    },
  ],
  menuCommands: [{ path: ["File"], commands: ["ComfyPocket.SendWorkflow"] }],
  async setup() {
    try {
      if (converter) {
        // Do not await: setup() must not block the app's own startup.
        converter.onSetup().catch((e) => warn("converter setup failed", e));
      } else {
        installSnapshotHooks();
        log("desktop hooks installed");
      }
    } catch (e) {
      warn("setup failed", e);
    }
  },
};

try {
  app.registerExtension(extension);
} catch (e) {
  warn("registerExtension failed", e);
}
