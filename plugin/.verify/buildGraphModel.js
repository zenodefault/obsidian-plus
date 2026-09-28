// src/components/graph/buildGraphModel.ts
function noteId(path) {
  return `note:${path}`;
}
function tagId(tag) {
  return `tag:${tag}`;
}
function noteLabel(path) {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}
function buildGraphModel(resolvedLinks, unresolvedLinks, tags = {}) {
  const nodes = /* @__PURE__ */ new Map();
  const edges = [];
  const seenEdge = /* @__PURE__ */ new Set();
  const addNote = (path, unresolved = false) => {
    const id = noteId(path);
    const existing = nodes.get(id);
    if (existing) {
      if (existing.unresolved && !unresolved) existing.unresolved = false;
      return id;
    }
    nodes.set(id, { id, kind: "note", label: noteLabel(path), unresolved });
    return id;
  };
  const addEdge = (source, target, kind) => {
    const key = `${kind}\0${source}\0${target}`;
    if (source === target || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, kind });
  };
  for (const from of Object.keys(resolvedLinks).sort()) {
    const fromId = addNote(from);
    for (const to of Object.keys(resolvedLinks[from] ?? {}).sort()) {
      const toId = addNote(to);
      addEdge(fromId, toId, "link");
    }
  }
  for (const from of Object.keys(unresolvedLinks).sort()) {
    const fromId = addNote(from);
    for (const to of Object.keys(unresolvedLinks[from] ?? {}).sort()) {
      const id = noteId(to);
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: "note", label: noteLabel(to), unresolved: true });
      }
      addEdge(fromId, id, "link");
    }
  }
  for (const path of Object.keys(tags).sort()) {
    const entries = tags[path] ?? {};
    const fromId = addNote(path);
    for (const rawTag of Object.keys(entries).sort()) {
      const tag = rawTag.replace(/^#/, "");
      if (!tag) continue;
      const id = tagId(tag);
      if (!nodes.has(id)) {
        nodes.set(id, { id, kind: "tag", label: tag, unresolved: false });
      }
      addEdge(fromId, id, "tag");
    }
  }
  return finalize(nodes, edges);
}
function finalize(nodes, edges) {
  const adjacency = /* @__PURE__ */ new Map();
  for (const node of nodes.keys()) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  return { nodes: [...nodes.values()], edges, adjacency };
}
export {
  buildGraphModel,
  noteLabel
};
