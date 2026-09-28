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

// src/components/graph/forceLayout.ts
var REPULSION = 2400;
var SPRING_LENGTH = 90;
var SPRING_STRENGTH = 0.04;
var DAMPING = 0.85;
var ITERATIONS = 220;
var CANVAS_RADIUS = 420;
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function computeLayout(model, seed = 2654435769) {
  const rng = makeRng(seed ^ 2246822507);
  const nodes = model.nodes;
  const positions = /* @__PURE__ */ new Map();
  nodes.forEach((node, i) => {
    const angle = 2 * Math.PI * i / Math.max(1, nodes.length);
    const radius = node.kind === "tag" ? CANVAS_RADIUS * 0.35 : CANVAS_RADIUS * 0.7;
    positions.set(node.id, {
      x: Math.cos(angle) * radius + (rng() - 0.5) * 40,
      y: Math.sin(angle) * radius + (rng() - 0.5) * 40
    });
  });
  const velocities = /* @__PURE__ */ new Map();
  for (const node of nodes) velocities.set(node.id, { x: 0, y: 0 });
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const forces = /* @__PURE__ */ new Map();
    for (const node of nodes) forces.set(node.id, { x: 0, y: 0 });
    const cell = SPRING_LENGTH * 2;
    const grid = /* @__PURE__ */ new Map();
    for (const node of nodes) {
      const p = positions.get(node.id);
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(node);
      else grid.set(key, [node]);
    }
    for (const node of nodes) {
      const p = positions.get(node.id);
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      const force = forces.get(node.id);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id === node.id) continue;
            const q = positions.get(other.id);
            applyRepulsion(node, p, q, force);
          }
        }
      }
    }
    for (const edge of model.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const length = edge.kind === "tag" ? SPRING_LENGTH * 1.35 : SPRING_LENGTH;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1e-4;
      const displacement = SPRING_STRENGTH * (dist - length) * Math.min(3, 1 + dist / (length * 2));
      const fx = dx / dist * displacement;
      const fy = dy / dist * displacement;
      const fa = forces.get(edge.source);
      const fb = forces.get(edge.target);
      fa.x += fx;
      fa.y += fy;
      fb.x -= fx;
      fb.y -= fy;
    }
    const cooling = 1 - iter / ITERATIONS;
    for (const node of nodes) {
      const force = forces.get(node.id);
      const vel = velocities.get(node.id);
      vel.x = (vel.x + force.x * 0.02) * DAMPING;
      vel.y = (vel.y + force.y * 0.02) * DAMPING;
      const p = positions.get(node.id);
      p.x += vel.x * cooling;
      p.y += vel.y * cooling;
    }
  }
  let cx = 0;
  let cy = 0;
  for (const p of positions.values()) {
    cx += p.x;
    cy += p.y;
  }
  cx /= Math.max(1, positions.size);
  cy /= Math.max(1, positions.size);
  for (const p of positions.values()) {
    p.x -= cx;
    p.y -= cy;
  }
  return { positions };
}
function applyRepulsion(node, p, q, force) {
  let dx = p.x - q.x;
  let dy = p.y - q.y;
  let distSq = dx * dx + dy * dy;
  if (distSq < 0.01) {
    const nudge = hashString(node.id) % 7 - 3 || 1;
    dx = nudge * 0.37;
    dy = -nudge * 0.21;
    distSq = dx * dx + dy * dy;
  }
  const dist = Math.sqrt(distSq);
  const strength = REPULSION / (distSq * dist + 0.01);
  force.x += dx * strength * 0.01;
  force.y += dy * strength * 0.01;
}

// src/components/graph/renderGraph.ts
function nodeDegree(model, id) {
  return model.adjacency.get(id)?.length ?? 0;
}
function effectiveRadius(model, node) {
  const base = node.kind === "tag" ? 5 : 6.5;
  if (node.kind !== "note") return base;
  const degree = nodeDegree(model, node.id);
  const scale = 1 + Math.min(Math.sqrt(degree) * 0.36, 2.1);
  return base * scale;
}
function emphasisFor(model, nodeId, state) {
  if (state.searchMatches) {
    if (state.searchMatches.has(nodeId)) return 1;
    return nodeId === state.selectedId ? 0.9 : 0.1;
  }
  if (state.selectedId) {
    if (nodeId === state.selectedId) return 1;
    for (const n of model.adjacency.get(state.selectedId) ?? []) {
      if (n === nodeId) return 1;
    }
    return 0.12;
  }
  return 1;
}
function edgeEmphasis(model, source, target, state) {
  const a = emphasisFor(model, source, state);
  const b = emphasisFor(model, target, state);
  return Math.min(a, b);
}
function worldToScreen(p, camera, viewport) {
  return {
    x: viewport.width / 2 + (p.x + camera.x) * camera.zoom,
    y: viewport.height / 2 + (p.y + camera.y) * camera.zoom
  };
}
function labelCharBudget(zoom, emphasized) {
  if (emphasized && zoom >= 0.35) return 44;
  if (zoom >= 1.1) return 44;
  if (zoom >= 0.7) return 28;
  if (zoom >= 0.45) return 18;
  return 0;
}
function renderGraph(input) {
  const { ctx, model, positions, camera, viewport, dpr, theme, state } = input;
  const w = viewport.width;
  const h = viewport.height;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const entrance = state.entranceProgress;
  for (const edge of model.edges) {
    const a = positions.get(edge.source);
    const b = positions.get(edge.target);
    if (!a || !b) continue;
    const emphasis = edgeEmphasis(model, edge.source, edge.target, state) * entrance;
    if (emphasis <= 0.02) continue;
    const pa = worldToScreen(a, camera, viewport);
    const pb = worldToScreen(b, camera, viewport);
    if (pa.x < -40 && pb.x < -40 || pa.x > w + 40 && pb.x > w + 40 || pa.y < -40 && pb.y < -40 || pa.y > h + 40 && pb.y > h + 40) {
      continue;
    }
    const isTag = edge.kind === "tag";
    const isConnectedToSelection = state.selectedId !== null && (edge.source === state.selectedId || edge.target === state.selectedId);
    const lit = emphasis >= 0.99;
    ctx.globalAlpha = isTag ? emphasis * 0.32 : emphasis * (lit ? 0.55 : 0.4);
    ctx.strokeStyle = isConnectedToSelection && lit ? theme.accent : theme.faint;
    ctx.lineWidth = isTag ? 0.75 : isConnectedToSelection && lit ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  const drawOrder = [];
  for (const node of model.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const emphasis = emphasisFor(model, node.id, state);
    drawOrder.push({ node, pos, emphasis });
  }
  drawOrder.sort((x, y) => x.emphasis - y.emphasis);
  for (const { node, pos, emphasis } of drawOrder) {
    const s = worldToScreen(pos, camera, viewport);
    const rWorld = effectiveRadius(model, node);
    const isSelected = node.id === state.selectedId;
    const isHover = node.id === state.hoverId;
    const grow = isSelected ? 1.35 : isHover ? 1.15 : 1;
    const r = Math.max(1.5, rWorld * camera.zoom * grow * (0.5 + 0.5 * entrance));
    if (s.x < -60 || s.x > w + 60 || s.y < -60 || s.y > h + 60) continue;
    ctx.globalAlpha = emphasis * entrance;
    if (emphasis <= 0.02) continue;
    if (isSelected) {
      const halo = ctx.createRadialGradient(s.x, s.y, r * 0.4, s.x, s.y, r * 3.2);
      halo.addColorStop(0, withAlpha(theme.accent, 0.28));
      halo.addColorStop(1, withAlpha(theme.accent, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (node.kind === "tag") {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = theme.tagFill;
      ctx.strokeStyle = isSelected || isHover ? theme.accent : withAlpha(theme.text, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
      ctx.fill();
      if (isSelected || isHover) ctx.stroke();
      ctx.restore();
    } else if (node.unresolved) {
      ctx.save();
      ctx.strokeStyle = withAlpha(theme.warning, 0.8);
      ctx.lineWidth = 1.25;
      ctx.setLineDash([2.5, 2.5]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = isSelected ? theme.accent : withAlpha(theme.accent, 0.88);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (isHover && !isSelected) {
        ctx.strokeStyle = theme.accentSoft;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const emphasized = emphasis >= 0.99 || isSelected || isHover;
    const budget = labelCharBudget(camera.zoom, emphasized);
    if (budget > 0) {
      const label = node.label;
      if (label.length > 0) {
        const fontSize = node.kind === "tag" ? 10 : 11.5;
        ctx.font = `${node.kind === "tag" ? "italic " : "500 "}${fontSize}px ${theme.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const shown = label.length > budget ? `${label.slice(0, Math.max(1, budget - 1))}\u2026` : label;
        const ly = s.y - r - fontSize * 0.85;
        ctx.globalAlpha = emphasis * entrance * (isSelected ? 0.95 : 0.82);
        ctx.fillStyle = isSelected ? theme.text : theme.muted;
        ctx.strokeStyle = withAlpha(theme.text, 0);
        ctx.fillText(shown, s.x, ly);
      }
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function withAlpha(color, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (short) {
    const r = parseInt(short[1] + short[1], 16);
    const g = parseInt(short[2] + short[2], 16);
    const b = parseInt(short[3] + short[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (long) {
    return `rgba(${parseInt(long[1], 16)}, ${parseInt(long[2], 16)}, ${parseInt(long[3], 16)}, ${a})`;
  }
  return hex;
}
export {
  buildGraphModel,
  computeLayout,
  renderGraph
};
