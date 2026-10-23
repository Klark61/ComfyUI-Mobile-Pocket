// Pure model for the All-nodes editor: workflow groups -> nodes -> literal-input fields (+ bypass state).
// Without a converter `structure` (history/remix) every prompt node is listed in one ungrouped section with no bypass toggle.
import { nodeFields, nodeTitleOf } from './fields.js';
import { nodeMap, nodeRows, effMode, groupKey } from './sections-model.js';

const sid = (x) => String(x);
/** Natural order for ids like "4", "10", "30:5", "30:12": segment by segment, numbers numerically. */
export function numCmp(a, b) {
  const x = sid(a).split(':'), y = sid(b).split(':');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = Number(x[i]), ny = Number(y[i]);
    const d = Number.isNaN(nx) || Number.isNaN(ny) ? (x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0) : nx - ny;
    if (d) return d;
  }
  return 0;
}

/** -> [{id, title, nodes:[{key, uiId, title, type, apiIds, bypassable, on, mode, inherited, offMode, fields}]}] */
export function nodeSections(prompt, structure, modes) {
  if (!prompt) return [];
  const claimed = new Set();
  const entry = (key, uiId, title, type, apiIds, bypassable, on, extra) => {
    const ids = [...new Set(apiIds.map(sid))].filter((a) => prompt[a] && !claimed.has(a));
    for (const a of ids) claimed.add(sid(a));
    // key by the API id when the card owns exactly one, so open cards survive the switch between API ids and UI ids
    return { key: ids.length === 1 ? ids[0] : key, uiId, title, type, apiIds: ids, bypassable, on, mode: on ? 0 : 4, inherited: false, offMode: 4, ...extra, fields: ids.flatMap((a) => nodeFields(prompt, a)) };
  };
  if (!structure) {
    const nodes = Object.keys(prompt).sort(numCmp).map((id) => entry(id, null, nodeTitleOf(prompt, id), prompt[id].class_type, [id], false, true));
    return nodes.length ? [{ id: 'all', title: 'All nodes', nodes }] : [];
  }
  const nmap = nodeMap(structure);
  const api = structure.apiIds || {};
  // each node belongs to the smallest group containing it (nested groups keep their own nodes)
  const groupOf = new Map();
  const bySize = (structure.groups || []).map((g, i) => [g, i]).sort((p, q) => (p[0].nodeIds || []).length - (q[0].nodeIds || []).length || p[1] - q[1]);
  const gkey = (g, i) => groupKey(g, i);
  for (const [g, i] of bySize) for (const id of g.nodeIds || []) if (!groupOf.has(sid(id))) groupOf.set(sid(id), gkey(g, i));
  const byGroup = new Map();
  const other = [];
  const rows = nodeRows(structure);
  // child rows claim their API ids first; a subgraph instance only gets what no child claimed
  const built = new Map();
  const order = rows.map((r, i) => i).sort((i, j) => (rows[j].depth - rows[i].depth) || (i - j));
  for (const i of order) {
    const r = rows[i];
    const mode = effMode(structure, modes, r.id, nmap);
    const pm = r.parent ? effMode(structure, modes, r.parent, nmap) : 0;
    const inherited = pm !== 0;
    const m = inherited ? pm : mode;
    const orig = (nmap.get(r.id) || {}).mode;
    const e = entry(r.id, r.id, r.title, r.type, api[r.id] || [], true, m === 0, { mode: m, inherited, offMode: orig === 2 || orig === 4 ? orig : 4 });
    built.set(i, e);
  }
  rows.forEach((r, i) => {
    const e = built.get(i);
    const gt = groupOf.get(r.id) || (r.parent && groupOf.get(r.parent));
    if (gt === undefined) other.push(e); else { if (!byGroup.has(gt)) byGroup.set(gt, []); byGroup.get(gt).push(e); }
  });
  for (const id of Object.keys(prompt).sort(numCmp)) if (!claimed.has(id)) other.push(entry(id, null, nodeTitleOf(prompt, id), prompt[id].class_type, [id], false, true));
  const out = [];
  const seen = new Set();
  (structure.groups || []).forEach((g, i) => {
    const k = gkey(g, i);
    if (seen.has(k) || !byGroup.has(k)) return;
    seen.add(k);
    out.push({ id: 'g:' + k, title: g.title, nodes: byGroup.get(k) });
  });
  if (other.length) out.push({ id: 'other', title: 'Other', nodes: other });
  return out;
}

/** Case-insensitive filter by node title, class type or input name. Keeps whole nodes; drops empty sections. */
export function filterSections(sections, q) {
  const t = (q || '').trim().toLowerCase();
  if (!t) return sections;
  return sections.map((s) => ({
    ...s,
    nodes: s.nodes.filter((n) => `${n.title} ${n.type}`.toLowerCase().includes(t) || n.fields.some((f) => f.input.toLowerCase().includes(t))),
  })).filter((s) => s.nodes.length);
}
