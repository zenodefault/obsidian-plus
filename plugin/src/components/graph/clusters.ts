/**
 * Knowledge clusters (Workstream: graph redesign).
 *
 * Clusters are computed from the **real** graph structure — connected
 * components over the actual link/tag edges — never from invented semantics.
 * A cluster is therefore a *connected group of notes*, and its label is
 * derived from data the user actually wrote:
 *
 *   1. the most common tag among its members (a tag the user applied), or
 *   2. the title of its hub (the member with the highest real link count), or
 *   3. a plain count when neither is informative.
 *
 * `labelSource` reports which of those was used, so surfaces can stay honest
 * ("connected group · by tag") instead of implying semantic meaning that was
 * never computed. When the core starts exporting a richer knowledge graph
 * (entities, concepts, memories), this module is the seam to swap: the
 * renderer only needs `nodeIds` + `label` + a point.
 *
 * Pure and deterministic: same model, same clusters, same order.
 */

import type { GraphModel, GraphNode } from "./buildGraphModel";

/** A group of nodes connected by real edges. */
export interface GraphCluster {
  /** Stable id: the lexicographically smallest member node id. */
  id: string;
  /** Member node ids, sorted for determinism. */
  nodeIds: string[];
  /** Member count (size 1 = an isolated node, not a region). */
  size: number;
  /** Human label derived from real data (see `labelSource`). */
  label: string;
  /** Where the label came from — never claim more than this. */
  labelSource: "tag" | "hub" | "count";
  /** Highest-degree member id (the hub), or the only member. */
  hubId: string;
  /** Real degree of `hubId`. */
  hubDegree: number;
}

/** Clusters smaller than this are not drawn as regions (they are noise). */
export const MIN_REGION_SIZE = 3;

/**
 * Connected components over link + tag edges. Isolated notes come back as
 * single-member clusters so nothing silently disappears from the math.
 */
export function findClusters(model: GraphModel): GraphCluster[] {
  const byId = new Map<string, GraphNode>();
  for (const node of model.nodes) byId.set(node.id, node);

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    // Path compression keeps repeated lookups cheap on large vaults.
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Deterministic root choice: the smaller id wins.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const id of byId.keys()) parent.set(id, id);
  for (const edge of model.edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) union(edge.source, edge.target);
  }

  const groups = new Map<string, string[]>();
  for (const id of byId.keys()) {
    const root = find(id);
    const bucket = groups.get(root);
    if (bucket) bucket.push(id);
    else groups.set(root, [id]);
  }

  const clusters: GraphCluster[] = [];
  for (const members of groups.values()) {
    members.sort();
    const label = labelFor(members, byId, model);
    clusters.push({
      id: members[0]!,
      nodeIds: members,
      size: members.length,
      label: label.label,
      labelSource: label.source,
      hubId: label.hubId,
      hubDegree: model.adjacency.get(label.hubId)?.length ?? 0,
    });
  }

  // Deterministic order: biggest regions first, then by id.
  clusters.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return clusters;
}

/** `node id → cluster id`, for O(1) lookups in interaction code. */
export function clusterIndex(clusters: GraphCluster[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const cluster of clusters) {
    for (const id of cluster.nodeIds) index.set(id, cluster.id);
  }
  return index;
}

function labelFor(
  members: string[],
  byId: Map<string, GraphNode>,
  model: GraphModel,
): { label: string; source: GraphCluster["labelSource"]; hubId: string } {
  // Hub: real degree, ties broken by id for determinism.
  let hubId = members[0]!;
  let hubDegree = model.adjacency.get(hubId)?.length ?? 0;
  for (const id of members) {
    const degree = model.adjacency.get(id)?.length ?? 0;
    if (degree > hubDegree || (degree === hubDegree && id < hubId)) {
      hubId = id;
      hubDegree = degree;
    }
  }

  // Tags the user actually applied, counted across members.
  const tagCounts = new Map<string, number>();
  for (const id of members) {
    const node = byId.get(id);
    if (!node || node.kind !== "tag") continue;
    if ((model.adjacency.get(id)?.length ?? 0) < 2) continue; // a tag used once is not a region name
    tagCounts.set(node.label, (tagCounts.get(node.label) ?? 0) + 1);
  }
  let bestTag: string | null = null;
  let bestTagCount = 0;
  for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestTagCount) {
      bestTag = tag;
      bestTagCount = count;
    }
  }
  if (bestTag && members.length >= MIN_REGION_SIZE) {
    return { label: `#${bestTag}`, source: "tag", hubId };
  }

  if (members.length >= MIN_REGION_SIZE) {
    const hub = byId.get(hubId);
    if (hub) return { label: hub.label, source: "hub", hubId };
  }

  return {
    label: `${members.length} note${members.length === 1 ? "" : "s"}`,
    source: "count",
    hubId,
  };
}
