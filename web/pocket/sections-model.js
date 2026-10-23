// Pure logic for the Sections panel (no DOM, no preact): group/node on-off state from the converter's `structure`
// plus the phone's mode overrides, group toggle patches (incl. rgthree restrictions), value merge after a re-convert,
// and applying overrides to a UI workflow JSON (so the workflow embedded in a queued run matches what was run).
//
// structure (see converter.js): {groups:[{id,title,nodeIds,mode}], controllers:[{id,title,kind,groups:[groupId],restriction}],
// nodes:[{id,title,type,mode,subgraph?}], apiIds:{uiId:[apiId]}}. modes: {uiNodeId: 0|2|4}, ids are strings.

// Node types that never run or only control other nodes: not worth a toggle, and never touched by a group toggle.
export const VIRTUAL_TYPE = /^(Note|MarkdownNote|Label|Reroute|PrimitiveNode|Bookmark|Fast Groups|Fast Muter|Fast Bypasser|Fast Actions|Image Comparer)/i;

const sid = (x) => String(x);

export function nodeMap(structure) {
  const m = new Map();
  if (!structure) return m;
  for (const n of structure.nodes || []) {
    m.set(sid(n.id), n);
    for (const c of n.subgraph || []) m.set(sid(c.id), c);
  }
  return m;
}

/** Effective mode of a node: pending override first, then what the last conversion reported. */
export function effMode(structure, modes, id, nmap) {
  const k = sid(id);
  if (modes && modes[k] !== undefined) return modes[k];
  const n = (nmap || nodeMap(structure)).get(k);
  return n ? n.mode : 0;
}

/** Stable reference of a group: its converter id, or its position for structures saved before groups had ids. */
export const groupKey = (g, i) => (g && g.id != null ? sid(g.id) : `g${i}`);

/** Group by reference (a group id). Falls back to the title for old snapshots/presets, whose controllers listed titles. */
export function findGroup(structure, ref) {
  const gs = (structure && structure.groups) || [];
  const r = sid(ref);
  // match by id only when the groups have ids (old snapshots: positional keys must not hit a group titled "g1")
  const i = gs.some((g) => g && g.id != null) ? gs.findIndex((g, k) => groupKey(g, k) === r) : -1;
  return i >= 0 ? gs[i] : gs.find((g) => sid(g.title) === r) || null;
}

const realIds = (ids, nmap) => ids.map(sid).filter((id) => { const n = nmap.get(sid(id)); return !(n && VIRTUAL_TYPE.test(n.type)); });

/** Group node ids that a toggle should touch (expanded: subgraph instances plus inner nodes; no controllers/notes). */
export function groupTargets(structure, g, nmap) {
  return realIds(g.nodeIds || [], nmap || nodeMap(structure));
}

/** Direct members only (what rgthree looks at for a group's state); old snapshots without memberIds use nodeIds. */
export function groupMembers(structure, g, nmap) {
  return realIds(g.memberIds || g.nodeIds || [], nmap || nodeMap(structure));
}

/** {on: some node active, all: every node active, n: node count} */
export function groupState(structure, modes, g, nmap) {
  nmap = nmap || nodeMap(structure);
  const ids = groupMembers(structure, g, nmap);
  if (!ids.length) return { on: g.mode === 0, all: g.mode === 0, n: 0 };
  const ms = ids.map((id) => effMode(structure, modes, id, nmap));
  return { on: ms.some((m) => m === 0), all: ms.every((m) => m === 0), n: ids.length };
}

/**
 * Mode patch for turning group `ref` (group id) on/off, optionally through a Fast Groups controller `ctl`.
 * Returns {patch} or {blocked:'always one'} / null when the group is unknown.
 */
export function groupPatch(structure, modes, ref, on, ctl) {
  const nmap = nodeMap(structure);
  const find = (r) => findGroup(structure, r);
  const g = find(ref);
  if (!g) return null;
  const off = ctl && ctl.kind === 'mute' ? 2 : 4;
  const patch = {};
  const set = (grp, mode) => { for (const id of groupTargets(structure, grp, nmap)) patch[sid(id)] = mode; };
  const restriction = (ctl && ctl.restriction) || 'default';
  if (!on && restriction === 'always one') {
    const others = (ctl.groups || []).map(find).filter((o) => o && o !== g);
    if (!others.some((o) => groupState(structure, modes, o, nmap).on)) return { blocked: 'always one' };
  }
  set(g, on ? 0 : off);
  if (on && /\bone\b/.test(restriction)) {
    for (const r of ctl.groups || []) { const o = find(r); if (o && o !== g) set(o, off); }
  }
  return { patch };
}

/** Rows for the per-node bypass list: real, runnable nodes (plus anything already bypassed/muted). */
export function nodeRows(structure) {
  if (!structure) return [];
  const api = structure.apiIds || {};
  const rows = [];
  const keep = (n) => !VIRTUAL_TYPE.test(String(n.type)) && ((api[sid(n.id)] && api[sid(n.id)].length) || n.mode === 2 || n.mode === 4);
  for (const n of structure.nodes || []) {
    const isSg = Array.isArray(n.subgraph);
    if (keep(n) || (isSg && !VIRTUAL_TYPE.test(String(n.type)))) rows.push({ id: sid(n.id), title: n.title || n.type, type: n.type, depth: 0, sg: isSg });
    if (isSg) for (const c of n.subgraph) if (keep(c)) {
      const parts = sid(c.id).split(':');   // "30:8:2" -> depth 2, immediate parent "30:8"
      rows.push({ id: sid(c.id), title: c.title || c.type, type: c.type, depth: Math.max(1, parts.length - 1), sg: false, parent: parts.length > 2 ? parts.slice(0, -1).join(':') : sid(n.id) });
    }
  }
  return rows;
}

const isLink = (v) => Array.isArray(v);

/** True for an API-format workflow file ({id: {class_type, inputs}} map, "Save (API)"): it already is the prompt. */
export function isApiFormat(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || Array.isArray(json.nodes)) return false;
  const vals = Object.values(json);
  return vals.length > 0 && vals.every((n) => n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object' && !Array.isArray(n.inputs));
}

/** Copy literal input values from `old` onto `fresh` (same node id, same class_type, same input name; links untouched). */
export function mergeValues(fresh, old) {
  const out = JSON.parse(JSON.stringify(fresh));
  if (!old) return out;
  for (const [id, node] of Object.entries(out)) {
    const o = old[id];
    if (!o || o.class_type !== node.class_type || !o.inputs || !node.inputs) continue;
    for (const k of Object.keys(node.inputs)) {
      if (isLink(node.inputs[k]) || !(k in o.inputs) || isLink(o.inputs[k])) continue;
      node.inputs[k] = o.inputs[k];
    }
  }
  return out;
}

/** UI workflow copy with the overrides written into node.mode (top-level ids and "inst:inner[:inner...]" via definitions.subgraphs). */
export function applyModesToUi(ui, modes) {
  if (!ui || !modes || !Object.keys(modes).length) return ui;
  const out = { ...ui, nodes: (ui.nodes || []).map((n) => (modes[sid(n.id)] !== undefined ? { ...n, mode: modes[sid(n.id)] } : n)) };
  const inner = Object.entries(modes).filter(([k]) => k.includes(':'));
  const subs = ui.definitions && Array.isArray(ui.definitions.subgraphs) ? ui.definitions.subgraphs : null;
  if (inner.length && subs) {
    const defs = subs.map((d) => ({ ...d, nodes: (d.nodes || []).slice() }));
    for (const [k, mode] of inner) {
      const parts = k.split(':');
      let node = (ui.nodes || []).find((n) => sid(n.id) === parts[0]);
      for (let i = 1; node && i < parts.length; i++) {
        const def = defs.find((d) => sid(d.id) === sid(node.type));
        const j = def ? def.nodes.findIndex((n) => sid(n.id) === parts[i]) : -1;
        if (j < 0) { node = null; break; }
        if (i === parts.length - 1) def.nodes[j] = { ...def.nodes[j], mode };
        else node = def.nodes[j];
      }
    }
    out.definitions = { ...ui.definitions, subgraphs: defs };
  }
  return out;
}
