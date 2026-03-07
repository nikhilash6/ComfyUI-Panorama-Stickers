function finiteNumber(value, fallback = null) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function emptyPaintingState() {
  return {
    version: 1,
    paint: { strokes: [] },
    mask: { strokes: [] },
  };
}

function normalizeTargetSpace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").trim();
  if (kind === "ERP_GLOBAL") return { kind: "ERP_GLOBAL" };
  if (kind !== "FRAME_LOCAL") return null;
  const frameId = String(raw.frameId || "").trim();
  if (!frameId) return null;
  return { kind: "FRAME_LOCAL", frameId };
}

function normalizePoint(raw, targetSpace) {
  if (!raw || typeof raw !== "object" || !targetSpace) return null;
  const t = finiteNumber(raw.t, 0);
  if (targetSpace.kind === "ERP_GLOBAL") {
    const u = finiteNumber(raw.u, null);
    const v = finiteNumber(raw.v, null);
    if (u == null || v == null) return null;
    return {
      targetKind: "ERP_GLOBAL",
      u: ((u % 1) + 1) % 1,
      v: Math.max(0, Math.min(1, v)),
      t,
    };
  }
  const x = finiteNumber(raw.x, null);
  const y = finiteNumber(raw.y, null);
  const frameId = String(raw.frameId || targetSpace.frameId || "").trim();
  if (x == null || y == null || frameId !== targetSpace.frameId) return null;
  return { targetKind: "FRAME_LOCAL", frameId, x, y, t };
}

function normalizePointList(raw, targetSpace, minPoints = 1) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    const point = normalizePoint(item, targetSpace);
    if (!point) return null;
    out.push(point);
  }
  return out.length >= minPoints ? out : null;
}

function normalizeGeometry(raw, targetSpace, toolKind, allowLasso) {
  if (!raw || typeof raw !== "object") return null;
  const geometryKind = String(raw.geometryKind || "").trim();
  if (geometryKind === "rect_fill") {
    if (toolKind !== "rect_fill_drag") return null;
    const p0 = normalizePoint(raw.p0, targetSpace);
    const p1 = normalizePoint(raw.p1, targetSpace);
    return p0 && p1 ? { geometryKind, p0, p1 } : null;
  }
  if (geometryKind === "lasso_fill") {
    if (!allowLasso || toolKind !== "lasso_fill") return null;
    const points = normalizePointList(raw.points, targetSpace, 3);
    return points ? { geometryKind, points } : null;
  }
  if (geometryKind !== "freehand_open" && geometryKind !== "freehand_closed") return null;
  if (toolKind === "rect_fill_drag" || toolKind === "lasso_fill") return null;
  const points = normalizePointList(raw.points, targetSpace, 1);
  return points ? { geometryKind, points } : null;
}

function normalizeStroke(raw, layerKind) {
  if (!raw || typeof raw !== "object" || String(raw.layerKind || "") !== layerKind) return null;
  const targetSpace = normalizeTargetSpace(raw.targetSpace);
  if (!targetSpace) return null;
  const toolKind = String(raw.toolKind || "").trim();
  const geometry = normalizeGeometry(raw.geometry, targetSpace, toolKind, layerKind === "paint");
  if (!geometry) return null;
  const size = finiteNumber(raw.size, null);
  const opacity = finiteNumber(raw.opacity, null);
  if (size == null || opacity == null) return null;
  const id = String(raw.id || "").trim();
  const actionGroupId = String(raw.actionGroupId || "").trim();
  if (!id || !actionGroupId) return null;
  let color = null;
  if (layerKind === "paint") {
    const src = raw.color;
    if (!src || typeof src !== "object") return null;
    color = {
      r: Math.max(0, Math.min(1, finiteNumber(src.r, 0))),
      g: Math.max(0, Math.min(1, finiteNumber(src.g, 0))),
      b: Math.max(0, Math.min(1, finiteNumber(src.b, 0))),
      a: Math.max(0, Math.min(1, finiteNumber(src.a, 1))),
    };
  }
  return {
    id,
    actionGroupId,
    targetSpace,
    layerKind,
    toolKind,
    brushPresetId: String(raw.brushPresetId || "").trim() || null,
    size: Math.max(0, size),
    opacity: Math.max(0, Math.min(1, opacity)),
    hardness: finiteNumber(raw.hardness, null),
    flow: finiteNumber(raw.flow, null),
    spacing: finiteNumber(raw.spacing, null),
    createdAt: Math.trunc(finiteNumber(raw.createdAt, 0)),
    color,
    geometry,
  };
}

function normalizeLayer(raw, layerKind) {
  const out = { strokes: [] };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.strokes)) return out;
  for (const item of raw.strokes) {
    const normalized = normalizeStroke(item, layerKind);
    if (normalized) out.strokes.push(normalized);
  }
  return out;
}

export function normalizePaintingState(raw) {
  const base = emptyPaintingState();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: 1,
    paint: normalizeLayer(raw.paint, "paint"),
    mask: normalizeLayer(raw.mask, "mask"),
  };
}

export { emptyPaintingState };
