/**
 * Graph model (Workstream: graph sidebar). Pure function from Obsidian's
 * metadata cache to the graph the canvas renders. No DOM, no Obsidian types
 * on the wire — a plain `MetadataCacheLike` seam keeps it unit-testable.
 *
 * Nodes are notes (circles) and tags (squares). Edges are resolved wiki-links
 * plus tag membership; unresolved links still produce a hollow node so
 * gaps in the vault stay visible (health surface, not decoration).
 */

export interface GraphNode {
  /** Unique key: `note:<path>` or `tag:<name>`. */
  id: string;
  kind: "note" | "tag";
  /** Note path, or tag name for tag nodes. */
  label: string;
  /** Unresolved wiki-link target: no such note exists (yet). */
  unresolved: boolean;
  /** Tag nodes are decorative squares; notes are the substance. */
}

export interface GraphEdge {
  source: string; // node id
  target: string; // node id
  kind: "link" | "tag";
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node id → the nodes directly connected to it. */
  adjacency: Map<string, string[]>;
}

/** Minimal seam over Obsidian's MetadataCache (unit-testable). */
export interface MetadataCacheLike {
  resolvedLinks: Record<string, Record<string, number>>;
  unresolvedLinks: Record<string, Record<string, number>>;
  /** Map from tag string (no `#`) to count, per file path. */
  getTags?: () => Record<string, number> | null;
}

/** Tag entries from the metadata cache: `#tag` (with hash) → count. */
export interface TagCacheLike {
  /** path → (tag-with-hash → count) */
  tags: Record<string, Record<string, number>>;
}

function noteId(path: string): string {
  return `note:${path}`;
}

function tagId(tag: string): string {
  return `tag:${tag}`;
}

/** Basename of a note path for display, minus the `.md` suffix. */
export function noteLabel(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/**
 * Build the graph. Deterministic: node and edge order follow sorted keys so
 * the same vault always renders the same way.
 */
export function buildGraphModel(
  resolvedLinks: Record<string, Record<string, number>>,
  unresolvedLinks: Record<string, Record<string, number>>,
  tags: TagCacheLike["tags"] = {},
): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();

  const addNote = (path: string, unresolved = false): string => {
    const id = noteId(path);
    const existing = nodes.get(id);
    if (existing) {
      if (existing.unresolved && !unresolved) existing.unresolved = false;
      return id;
    }
    nodes.set(id, { id, kind: "note", label: noteLabel(path), unresolved });
    return id;
  };

  const addEdge = (source: string, target: string, kind: GraphEdge["kind"]): void => {
    const key = `${kind}\u0000${source}\u0000${target}`;
    if (source === target || seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ source, target, kind });
  };

  // Resolved links: both endpoints exist. Sorted for deterministic order.
  for (const from of Object.keys(resolvedLinks).sort()) {
    const fromId = addNote(from);
    for (const to of Object.keys(resolvedLinks[from] ?? {}).sort()) {
      const toId = addNote(to);
      addEdge(fromId, toId, "link");
    }
  }

  // Unresolved links: target note does not exist; keep it visible but hollow.
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

  // Tag membership: note → tag (square nodes). A note with no links still
  // enters the graph through its tags ("it shows everything").
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

function finalize(
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
): GraphModel {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes.keys()) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  return { nodes: [...nodes.values()], edges, adjacency };
}
