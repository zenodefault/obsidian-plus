// src/components/graph/renderGraph.ts
var CAMERA_ZOOM_MIN = 0.05;
var CAMERA_ZOOM_MAX = 6;
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
function easeInOutCubic(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
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
function fitCameraToPoints(points, viewport, opts = {}) {
  const padding = opts.padding ?? 80;
  const minZoom = opts.minZoom ?? CAMERA_ZOOM_MIN;
  const maxZoom = opts.maxZoom ?? 1.6;
  if (points.length === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(viewport.width / (bw + padding * 2), viewport.height / (bh + padding * 2)))
  );
  return {
    x: -(minX + maxX) / 2,
    y: -(minY + maxY) / 2,
    zoom
  };
}
function worldToScreen(p, camera, viewport) {
  return {
    x: viewport.width / 2 + (p.x + camera.x) * camera.zoom,
    y: viewport.height / 2 + (p.y + camera.y) * camera.zoom
  };
}
function screenToWorld(sx, sy, camera, viewport) {
  return {
    x: (sx - viewport.width / 2) / camera.zoom - camera.x,
    y: (sy - viewport.height / 2) / camera.zoom - camera.y
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
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  easeInOutCubic,
  edgeEmphasis,
  effectiveRadius,
  emphasisFor,
  fitCameraToPoints,
  labelCharBudget,
  nodeDegree,
  renderGraph,
  screenToWorld,
  withAlpha,
  worldToScreen
};
