function finiteNumber(value, fallback = null) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function emptyPaintingState() {
  return {
    version: 1,
    groups: [],
    paint: { strokes: [] },
    mask: { strokes: [] },
  };
}

function normalizeGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const actionGroupId = String(item.actionGroupId || item.id || "").trim();
    if (!actionGroupId || seen.has(actionGroupId)) continue;
    seen.add(actionGroupId);
    const z = finiteNumber(item.z_index ?? item.zIndex, out.length);
    out.push({
      id: String(item.id || actionGroupId),
      type: "strokeGroup",
      actionGroupId,
      z_index: Math.max(0, Math.round(z ?? out.length)),
      locked: item.locked === true,
    });
  }
  return out;
}

function normalizeTargetSpace(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind || "").trim();
  if (kind === "ERP_GLOBAL") return { kind: "ERP_GLOBAL" };
  return null;
}

function normalizePoint(raw, targetSpace) {
  if (!raw || typeof raw !== "object" || !targetSpace) return null;
  const t = finiteNumber(raw.t, 0);
  const widthScale = finiteNumber(raw.widthScale, null);
  const pressureLike = finiteNumber(raw.pressureLike, null);
  if (targetSpace.kind === "ERP_GLOBAL") {
    const u = finiteNumber(raw.u, null);
    const v = finiteNumber(raw.v, null);
    if (u == null || v == null) return null;
    const out = {
      targetKind: "ERP_GLOBAL",
      u: ((u % 1) + 1) % 1,
      v: Math.max(0, Math.min(1, v)),
      t,
    };
    if (widthScale != null) out.widthScale = Math.max(0, widthScale);
    if (pressureLike != null) out.pressureLike = Math.max(0, pressureLike);
    return out;
  }
  return null;
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
  if (geometryKind === "lasso_fill") {
    if (!allowLasso || toolKind !== "lasso_fill") return null;
    const points = normalizePointList(raw.points, targetSpace, 3);
    return points ? { geometryKind, points } : null;
  }
  if (geometryKind !== "freehand_open" && geometryKind !== "freehand_closed") return null;
  if (toolKind === "lasso_fill") return null;
  const points = normalizePointList(raw.points, targetSpace, 1);
  if (!points) return null;
  const rawPoints = normalizePointList(raw.rawPoints, targetSpace, 1);
  const processedPoints = normalizePointList(raw.processedPoints, targetSpace, 1);
  return {
    geometryKind,
    points,
    rawPoints: rawPoints || points.map((pt) => ({ ...pt })),
    processedPoints: processedPoints || points.map((pt) => ({ ...pt })),
  };
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
  const radiusValue = finiteNumber(raw.radiusValue, null);
  const radiusModel = String(raw.radiusModel || "").trim() || null;
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
    radiusModel,
    radiusValue: radiusValue == null ? null : Math.max(0, radiusValue),
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
    groups: normalizeGroups(raw.groups),
    paint: normalizeLayer(raw.paint, "paint"),
    mask: normalizeLayer(raw.mask, "mask"),
  };
}

export { emptyPaintingState };
