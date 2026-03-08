// Paint Engine Manager
//
// Architecture:
//   Source of truth    = stroke records (durable, in state_json.painting)
//   Native raster cache = committedPaint / committedMask per target (derived)
//   Active stroke      = currentStroke (ephemeral, accumulated incrementally)
//   Display            = composed from committed + currentStroke on demand (per rAF frame)
//
// Rendering strategy: Stamp-based soft brush
//
//   Each freehand stroke is rendered as a sequence of pre-baked OffscreenCanvas stamp
//   images (radial gradient) placed along the path at spacing intervals.
//   The stamp is cached by (radiusPx, hardness, color) — LRU, max 128 entries.
//
//   Live drawing (O(1) per pointermove):
//     - Each new raw point triggers a spacing walk on the single [prev→current] segment.
//     - Only the new stamps for that segment are drawn to currentStroke.
//     - At commit, currentStroke is merged (drawImage) into the committed layer.
//
//   Rebuild (undo/redo, reload):
//     - Full spacing walk replayed from processedPoints (or rawPoints if not set).
//
//   Eraser: draws white stamps to currentStroke (source-over); composeDisplayPaint
//           applies destination-out for the live preview; commit applies destination-out
//           to the committed layer.
//
//   Lasso fill: polygon fill via canvas Path2D — no stamps needed.
//
//   ERP seam: stamps near the u=0 / u=1 wrap boundary are mirrored so the stroke
//             renders correctly at the panorama seam.

// ─── Canvas Surface Utilities ─────────────────────────────────────────────────

function createCanvasSurface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
  }
  return { canvas, ctx };
}

function resizeSurface(surface, width, height) {
  if (!surface) return createCanvasSurface(width, height);
  const nextW = Math.max(1, Math.round(width));
  const nextH = Math.max(1, Math.round(height));
  if (surface.canvas.width !== nextW || surface.canvas.height !== nextH) {
    surface.canvas.width = nextW;
    surface.canvas.height = nextH;
    surface.ctx.imageSmoothingEnabled = true;
  }
  return surface;
}

function clearSurface(surface) {
  if (!surface?.ctx) return;
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
}

// ─── Mask Tint Overlay ────────────────────────────────────────────────────────

// Shared temp canvas for drawMaskTint — resized lazily, never shrunk.
let _maskTintTmp = null;

// Overlay a green tint over mask-shaped pixels on displayCtx.
// Does NOT affect non-mask pixels (paint pixels remain unchanged).
function drawMaskTint(displayCtx, maskCanvas) {
  if (!displayCtx || !maskCanvas) return;
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  if (!_maskTintTmp || _maskTintTmp.canvas.width < w || _maskTintTmp.canvas.height < h) {
    _maskTintTmp = createCanvasSurface(
      Math.max(w, _maskTintTmp?.canvas.width || 0),
      Math.max(h, _maskTintTmp?.canvas.height || 0),
    );
  }
  const tmp = _maskTintTmp;
  tmp.ctx.clearRect(0, 0, w, h);
  tmp.ctx.drawImage(maskCanvas, 0, 0);
  tmp.ctx.globalCompositeOperation = "source-in";
  tmp.ctx.fillStyle = "rgba(34, 197, 94, 0.82)";
  tmp.ctx.fillRect(0, 0, w, h);
  tmp.ctx.globalCompositeOperation = "source-over";
  displayCtx.save();
  displayCtx.globalCompositeOperation = "source-over";
  displayCtx.drawImage(tmp.canvas, 0, 0, w, h);
  displayCtx.restore();
}

// ─── Coordinate Helpers ───────────────────────────────────────────────────────

function getTargetCoord(point) {
  if (!point || typeof point !== "object") return { x: 0, y: 0 };
  return { x: Number(point.u || 0), y: Number(point.v || 0) };
}

// Return the point list for rendering.
// Priority: rawPoints (source of truth) > points.
// processedPoints is intentionally ignored — live and rebuild use the same raw data.
function getRawPoints(stroke) {
  const geometry = stroke?.geometry;
  if (!geometry) return [];
  if (Array.isArray(geometry.rawPoints) && geometry.rawPoints.length) return geometry.rawPoints;
  if (Array.isArray(geometry.points) && geometry.points.length) return geometry.points;
  return [];
}

// ─── Brush Radius ─────────────────────────────────────────────────────────────

function getRadiusPx(stroke, descriptor) {
  const radiusValue = Number(stroke?.radiusValue);
  const radiusModel = String(stroke?.radiusModel || "").trim();
  const w = descriptor?.width || 1;
  if ((radiusModel === "erp_uv_norm" || radiusModel === "frame_local_norm") && radiusValue > 0) {
    // radiusValue = radius_px / reference_width (reference = 2048)
    return Math.max(0.5, radiusValue * w);
  }
  if (radiusModel === "degree_norm" && radiusValue > 0) {
    // radiusValue = angle_radius_degrees / 90; at equator, pixel_radius ≈ angle/360 * width
    return Math.max(0.5, (radiusValue * 90 / 360) * w);
  }
  return Math.max(0.5, Number(stroke?.baseSize || stroke?.size || 10) * 0.5);
}

// Stamp spacing in pixels. Falls back to brush-type defaults if not set on the stroke.
// Spacing = fraction of diameter. Smaller = denser stamps = smoother appearance.
function getSpacingPx(stroke, radiusPx) {
  const explicit = Number(stroke?.spacing);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, explicit * radiusPx * 2);
  const toolKind = String(stroke?.toolKind || "pen");
  const denseTools = toolKind === "brush" || toolKind === "eraser";
  const fraction = denseTools ? 0.15 : 0.2;
  return Math.max(1, fraction * radiusPx * 2);
}

// ─── Stamp Texture Cache ──────────────────────────────────────────────────────

// LRU cache: Map retains insertion order; oldest entry = first key.
const _stampCache = new Map();
const STAMP_CACHE_MAX = 128;

// Build (or retrieve cached) stamp OffscreenCanvas for the given brush parameters.
// The stamp is a radial gradient: full opacity out to (hardness * radius), fading to 0 at radius.
// Color (r255, g255, b255) and opacity are baked in so the same texture is ready to draw.
function buildStampTexture(radiusPx, hardness, r255, g255, b255, opacity) {
  const rr = Math.max(1, Math.round(radiusPx));
  const h = Math.max(0, Math.min(1, hardness));
  const key = `${rr}:${h.toFixed(2)}:${r255}:${g255}:${b255}:${opacity.toFixed(3)}`;

  if (_stampCache.has(key)) {
    const stamp = _stampCache.get(key);
    // LRU: promote to most-recent by re-inserting
    _stampCache.delete(key);
    _stampCache.set(key, stamp);
    return stamp;
  }

  // Evict the oldest entry when at capacity
  if (_stampCache.size >= STAMP_CACHE_MAX) {
    _stampCache.delete(_stampCache.keys().next().value);
  }

  const size = rr * 2 + 2;
  const center = rr + 1;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Radial gradient: innerR = hardness boundary (hard core), outerR = brush edge
  const innerR = h * rr;       // inside this → full opacity
  const outerR = rr + 1;       // at this radius → fully transparent
  const colorFull = `rgba(${r255},${g255},${b255},${opacity})`;
  const colorZero = `rgba(${r255},${g255},${b255},0)`;
  const grad = ctx.createRadialGradient(center, center, innerR, center, center, outerR);
  grad.addColorStop(0, colorFull);
  grad.addColorStop(1, colorZero);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  _stampCache.set(key, canvas);
  return canvas;
}

// ─── Stamp Color ─────────────────────────────────────────────────────────────

// Returns {r, g, b, a} for buildStampTexture.
// Eraser and mask strokes always use white (composited with destination-out / tint later).
// Paint strokes use the stroke color * opacity.
function getStampColor(stroke) {
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (toolKind === "eraser" || layerKind === "mask") {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const opacity = Math.max(0, Math.min(1, Number(stroke?.opacity ?? 1)));
  const alpha = Math.max(0, Math.min(1, Number(c.a ?? 1))) * opacity;
  return {
    r: Math.round(Math.max(0, Math.min(1, Number(c.r || 0))) * 255),
    g: Math.round(Math.max(0, Math.min(1, Number(c.g || 0))) * 255),
    b: Math.round(Math.max(0, Math.min(1, Number(c.b || 0))) * 255),
    a: alpha,
  };
}

// CSS color string for lasso fill polygon (not stamp-based).
// Fixes opacity bug: multiplies color.a by stroke.opacity.
function strokeStyleForKind(stroke) {
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (toolKind === "eraser" || layerKind === "mask") return "rgba(255,255,255,1)";
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const opacity = Math.max(0, Math.min(1, Number(stroke?.opacity ?? 1)));
  const alpha = Math.max(0, Math.min(1, Number(c.a ?? 1))) * opacity;
  return `rgba(${Math.round(Number(c.r || 0) * 255)},${Math.round(Number(c.g || 0) * 255)},${Math.round(Number(c.b || 0) * 255)},${alpha})`;
}

// ─── Curve Helpers ────────────────────────────────────────────────────────────

// ─── Stamp Drawing ────────────────────────────────────────────────────────────

// Draw one stamp at (cx, cy) in descriptor pixel space.
// widthScale scales the stamp radius (for pressure-like variation).
// descriptorH is used to compute ERP latitude correction: near the poles, the horizontal
// axis of ERP is compressed relative to the vertical axis, so the stamp is stretched
// horizontally by 1/cos(lat) to appear as a circle on the sphere.
// Mirrors at the ERP seam (u=0 / u=1) so strokes wrap correctly.
// desc = { width, height } — descriptor pixel dimensions.
// ERP latitude correction: stamps are horizontally stretched by 1/cos(lat) so they
// appear as circles on the sphere rather than ellipses squished near the poles.
function _drawSingleStamp(ctx, stampTex, cx, cy, radiusPx, widthScale, desc) {
  const ws = Math.max(0.01, Number.isFinite(widthScale) ? widthScale : 1);
  const rv = Math.max(0.5, radiusPx * ws);
  const lat = (0.5 - cy / Math.max(1, desc.height)) * Math.PI;
  const cosLat = Math.max(0.05, Math.cos(lat));
  const rh = rv / cosLat;
  const W = desc.width;
  ctx.drawImage(stampTex, cx - rh, cy - rv, rh * 2, rv * 2);
  if (cx - rh < 0) ctx.drawImage(stampTex, cx + W - rh, cy - rv, rh * 2, rv * 2);
  if (cx + rh > W) ctx.drawImage(stampTex, cx - W - rh, cy - rv, rh * 2, rv * 2);
}

// Draw a complete freehand stroke using the stamp engine.
// Uses the same centripetal Catmull-Rom + midpoint-anchor algorithm as live rendering,
// so rebuild (undo/redo) looks identical to the stroke as it was drawn.
function drawStampStroke(ctx, stroke, descriptor) {
  const points = getRawPoints(stroke);
  if (!ctx || points.length === 0) return;

  const W = descriptor.width;
  const H = descriptor.height;
  const radiusPx = getRadiusPx(stroke, descriptor);
  const hardness = Math.max(0, Math.min(1, Number(stroke?.hardness ?? 0.9)));
  const col = getStampColor(stroke);
  const stampTex = buildStampTexture(radiusPx, hardness, col.r, col.g, col.b, col.a);
  const spacingPx = getSpacingPx(stroke, radiusPx);
  const sc = { ctx, stampTex, radiusPx, spacingPx, desc: descriptor };

  ctx.save();
  ctx.globalCompositeOperation = "source-over";

  // Convert UV to pixel space
  const pts = points.map((p) => ({ x: Number(p.u || 0) * W, y: Number(p.v || 0) * H }));

  // First stamp at p0
  _drawSingleStamp(ctx, stampTex, pts[0].x, pts[0].y, radiusPx, 1, descriptor);

  if (pts.length === 1) { ctx.restore(); return; }

  // Mirror appendStrokePoint: midpoint anchors + centripetal CR
  let pprev = pts[0];
  let prev  = pts[0];
  let lastMid = pts[0];
  let dist = 0;

  for (let i = 1; i < pts.length; i++) {
    const curr = pts[i];
    const mid = { x: (prev.x + curr.x) * 0.5, y: (prev.y + curr.y) * 0.5 };
    if (i === 1) {
      dist = _walkLinearStamps(sc, lastMid.x, lastMid.y, mid.x, mid.y, dist);
    } else {
      dist = _walkCRStamps(sc, pprev, lastMid, mid, curr, dist);
    }
    pprev = prev;
    prev = curr;
    lastMid = mid;
  }

  // Final tail: lastMid → last raw point
  if (pts.length === 2) {
    _walkLinearStamps(sc, lastMid.x, lastMid.y, prev.x, prev.y, dist);
  } else {
    _walkCRStamps(sc, pprev, lastMid, prev, prev, dist);
  }

  ctx.restore();
}

function drawLassoFillNative(ctx, stroke, descriptor) {
  const points = Array.isArray(stroke?.geometry?.points) ? stroke.geometry.points : [];
  if (!ctx || points.length < 3) return;

  const w = descriptor.width;
  const h = descriptor.height;
  const style = strokeStyleForKind(stroke);

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = style;
  const first = getTargetCoord(points[0]);
  ctx.beginPath();
  ctx.moveTo(first.x * w, first.y * h);
  for (let i = 1; i < points.length; i += 1) {
    const p = getTargetCoord(points[i]);
    ctx.lineTo(p.x * w, p.y * h);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Draw a stroke to the given ctx.
// Eraser strokes are rendered as WHITE marks; caller applies destination-out when compositing.
function drawStrokeToSurface(ctx, stroke, descriptor) {
  const kind = String(stroke?.geometry?.geometryKind || "");
  if (kind === "lasso_fill") {
    drawLassoFillNative(ctx, stroke, descriptor);
  } else {
    drawStampStroke(ctx, stroke, descriptor);
  }
}

// Apply destination-out: erase target where eraserCanvas has white marks.
function applyEraserToSurface(targetCtx, eraserCanvas) {
  targetCtx.save();
  targetCtx.globalCompositeOperation = "destination-out";
  targetCtx.drawImage(eraserCanvas, 0, 0);
  targetCtx.restore();
}

function targetKeyOf(descriptor) {
  return descriptor.kind === "ERP_GLOBAL" ? "erp" : `frame:${String(descriptor.frameId || "")}`;
}

// ─── Incremental Stamp Helpers ────────────────────────────────────────────────

// Shared context passed to stamp-walk helpers to keep parameter counts small.
// { ctx, stampTex, radiusPx, spacingPx, desc }  where desc = { width, height }

// Walk stamps along a straight segment (ax,ay)→(bx,by). Returns new distSinceStamp.
function _walkLinearStamps(sc, ax, ay, bx, by, distSinceStamp) {
  const dx = bx - ax;
  const dy = by - ay;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 1e-9) return distSinceStamp;
  let toNext = sc.spacingPx - distSinceStamp;
  while (toNext <= segLen) {
    const t = toNext / segLen;
    _drawSingleStamp(sc.ctx, sc.stampTex, ax + dx * t, ay + dy * t, sc.radiusPx, 1, sc.desc);
    toNext += sc.spacingPx;
  }
  return segLen - toNext + sc.spacingPx;
}

// Walk stamps along a centripetal Catmull-Rom segment from p1 to p2.
// p0 and p3 are the flanking points used to compute entry/exit tangents.
// All points are {x, y} in pixel space. Returns new distSinceStamp.
// Centripetal parameterization (alpha=0.5) avoids overshoot at uneven point spacing.
function _walkCRStamps(sc, p0, p1, p2, p3, distSinceStamp) {
  // Knot intervals: sqrt of Euclidean distance (centripetal, alpha=0.5)
  const eps = 1e-4;
  const d01 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)) + eps;
  const d12 = Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)) + eps;
  const d23 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)) + eps;

  const t0 = 0;
  const t1 = d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const dt = t2 - t1;

  // Walk 16 linear sub-segments along the CR curve from p1 to p2
  const N = 16;
  let dist = distSinceStamp;
  let prevX = p1.x;
  let prevY = p1.y;

  for (let i = 1; i <= N; i++) {
    const t = t1 + dt * i / N;

    // Barry-Goldman non-uniform Catmull-Rom evaluation
    const A1x = ((t1 - t) * p0.x + (t - t0) * p1.x) / (t1 - t0);
    const A1y = ((t1 - t) * p0.y + (t - t0) * p1.y) / (t1 - t0);
    const A2x = ((t2 - t) * p1.x + (t - t1) * p2.x) / (t2 - t1);
    const A2y = ((t2 - t) * p1.y + (t - t1) * p2.y) / (t2 - t1);
    const A3x = ((t3 - t) * p2.x + (t - t2) * p3.x) / (t3 - t2);
    const A3y = ((t3 - t) * p2.y + (t - t2) * p3.y) / (t3 - t2);

    const B1x = ((t2 - t) * A1x + (t - t0) * A2x) / (t2 - t0);
    const B1y = ((t2 - t) * A1y + (t - t0) * A2y) / (t2 - t0);
    const B2x = ((t3 - t) * A2x + (t - t1) * A3x) / (t3 - t1);
    const B2y = ((t3 - t) * A2y + (t - t1) * A3y) / (t3 - t1);

    const Cx = ((t2 - t) * B1x + (t - t1) * B2x) / (t2 - t1);
    const Cy = ((t2 - t) * B1y + (t - t1) * B2y) / (t2 - t1);

    dist = _walkLinearStamps(sc, prevX, prevY, Cx, Cy, dist);
    prevX = Cx;
    prevY = Cy;
  }
  return dist;
}

// ─── Incremental Stamp Append ─────────────────────────────────────────────────

// Append one point to the active freehand stroke using centripetal Catmull-Rom stamp placement.
// x, y are normalized target-space coords [0, 1].
//
// Algorithm: midpoint anchors + centripetal CR (mirrors drawStampStroke exactly).
//   P0        → stamp at P0; initialize pprev=prev=P0, lastMid=P0
//   P1        → linear walk from lastMid to mid(P0,P1); shift history
//   P2 .. Pn  → CR walk from lastMid to mid(Pn-1,Pn), guided by pprev and Pn
//   commit    → CR tail from lastMid to last raw point (ghost = last raw point)
//
// activeStroke state:
//   pprev           — two raw points ago (pixel space {x,y})
//   prev            — one raw point ago  (pixel space {x,y})
//   lastMidX/Y      — midpoint anchor stamps were last drawn up to
//   radiusPx, stampTex, spacingPx, distSinceStamp
//   isEraser, layerKind, pointCount
function appendStrokePoint(target, x, y, stroke) {
  const ctx = target.currentStroke.ctx;
  if (!ctx) return;

  const desc = target.descriptor;
  const px = x * desc.width;
  const py = y * desc.height;
  const as = target.activeStroke;

  if (!as) {
    // First point: place initial stamp, initialize CR history.
    const radiusPx = getRadiusPx(stroke, desc);
    const hardness = Math.max(0, Math.min(1, Number(stroke?.hardness ?? 0.9)));
    const col = getStampColor(stroke);
    const stampTex = buildStampTexture(radiusPx, hardness, col.r, col.g, col.b, col.a);
    const spacingPx = getSpacingPx(stroke, radiusPx);
    const isEraser = String(stroke?.toolKind || "") === "eraser";
    const layerKind = String(stroke?.layerKind || "paint");

    ctx.globalCompositeOperation = "source-over";
    _drawSingleStamp(ctx, stampTex, px, py, radiusPx, 1, desc);

    target.activeStroke = {
      pprev: { x: px, y: py },
      prev:  { x: px, y: py },
      lastMidX: px, lastMidY: py,
      radiusPx, stampTex, spacingPx,
      distSinceStamp: 0,
      isEraser, layerKind,
      pointCount: 1,
    };
    target.displayDirty = true;
    return;
  }

  const midX = (as.prev.x + px) * 0.5;
  const midY = (as.prev.y + py) * 0.5;

  ctx.globalCompositeOperation = "source-over";
  const sc = { ctx, stampTex: as.stampTex, radiusPx: as.radiusPx, spacingPx: as.spacingPx, desc };

  if (as.pointCount === 1) {
    // Second point: linear from first stamp to first midpoint anchor.
    as.distSinceStamp = _walkLinearStamps(sc, as.lastMidX, as.lastMidY, midX, midY, as.distSinceStamp);
  } else {
    // Third+ point: centripetal CR from lastMid to newMid, guided by pprev and curr.
    as.distSinceStamp = _walkCRStamps(
      sc,
      as.pprev,
      { x: as.lastMidX, y: as.lastMidY },
      { x: midX, y: midY },
      { x: px, y: py },
      as.distSinceStamp,
    );
  }

  as.pprev = as.prev;
  as.prev  = { x: px, y: py };
  as.lastMidX = midX;
  as.lastMidY = midY;
  as.pointCount++;
  target.displayDirty = true;
}

// ─── Engine Factory ────────────────────────────────────────────────────────────

export function createPaintEngineManager() {
  const erpTarget = {
    descriptor: { kind: "ERP_GLOBAL", width: 2048, height: 1024 },
    committedPaint: createCanvasSurface(2048, 1024),
    committedMask: createCanvasSurface(2048, 1024),
    currentStroke: createCanvasSurface(2048, 1024),
    displayPaint: createCanvasSurface(2048, 1024),
    // Per-target active stroke state for incremental rendering.
    // Set by beginStroke, updated by appendStrokePoint, cleared by commit/cancel.
    activeStroke: null,
    // displayDirty: composeDisplayPaint is skipped when false.
    // Set to true whenever committed or currentStroke content changes.
    displayDirty: true,
  };
  let activeTargetKey = "";
  let activeLayerKind = "";

  // ERP_GLOBAL is the only painting target.
  function ensureTarget(_descriptor) {
    return erpTarget;
  }

  // Compose the displayPaint canvas from committed layers + active stroke.
  // Skipped when displayDirty is false (nothing changed since last compose).
  function composeDisplayPaint(target) {
    if (!target.displayDirty) return;
    target.displayDirty = false;
    const dCtx = target.displayPaint.ctx;
    clearSurface(target.displayPaint);

    const isActive = activeTargetKey === targetKeyOf(target.descriptor);
    const as = isActive ? target.activeStroke : null;

    if (as?.isEraser) {
      // Eraser preview: start from committed, apply currentStroke as destination-out
      if (as.layerKind === "paint") {
        dCtx.drawImage(target.committedPaint.canvas, 0, 0);
        applyEraserToSurface(dCtx, target.currentStroke.canvas);
        drawMaskTint(dCtx, target.committedMask.canvas);
      } else {
        // Mask eraser: show paint + (mask minus eraser)
        dCtx.drawImage(target.committedPaint.canvas, 0, 0);
        const tmp = createCanvasSurface(target.committedMask.canvas.width, target.committedMask.canvas.height);
        tmp.ctx.drawImage(target.committedMask.canvas, 0, 0);
        applyEraserToSurface(tmp.ctx, target.currentStroke.canvas);
        drawMaskTint(dCtx, tmp.canvas);
      }
      return;
    }

    // Normal: committedPaint → maskTint → currentStroke overlay
    dCtx.drawImage(target.committedPaint.canvas, 0, 0);
    drawMaskTint(dCtx, target.committedMask.canvas);
    if (!isActive) return;
    if (activeLayerKind === "paint") {
      dCtx.drawImage(target.currentStroke.canvas, 0, 0);
    } else if (activeLayerKind === "mask") {
      drawMaskTint(dCtx, target.currentStroke.canvas);
    }
  }

  function rebuildCommitted(state) {
    // Deduplication is handled by the caller (rebuildPaintEngineIfNeeded in pano_editor.js).
    clearSurface(erpTarget.committedPaint);
    clearSurface(erpTarget.committedMask);
    clearSurface(erpTarget.currentStroke);
    erpTarget.activeStroke = null;

    const allStrokes = [
      ...(Array.isArray(state?.painting?.paint?.strokes) ? state.painting.paint.strokes : []),
      ...(Array.isArray(state?.painting?.mask?.strokes) ? state.painting.mask.strokes : []),
    ];

    allStrokes.forEach((stroke) => {
      // Only ERP_GLOBAL strokes are supported. Legacy FRAME_LOCAL strokes are silently ignored.
      if (stroke?.targetSpace?.kind !== "ERP_GLOBAL") return;

      const descriptor = erpTarget.descriptor;
      const layerKind = String(stroke?.layerKind || "paint");
      const toolKind = String(stroke?.toolKind || "pen");
      const isEraser = toolKind === "eraser";

      if (isEraser) {
        const tmp = createCanvasSurface(descriptor.width, descriptor.height);
        drawStrokeToSurface(tmp.ctx, stroke, descriptor);
        const surface = layerKind === "mask" ? erpTarget.committedMask : erpTarget.committedPaint;
        applyEraserToSurface(surface.ctx, tmp.canvas);
      } else if (layerKind === "mask") {
        drawStrokeToSurface(erpTarget.committedMask.ctx, stroke, descriptor);
      } else {
        drawStrokeToSurface(erpTarget.committedPaint.ctx, stroke, descriptor);
      }
    });

    erpTarget.displayDirty = true;
    composeDisplayPaint(erpTarget);
  }

  // Begin a new stroke: clear currentStroke canvas, reset active stroke state.
  function beginStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    clearSurface(target.currentStroke);
    target.activeStroke = null;
    target.displayDirty = true;
  }

  // Commit the active stroke: merge currentStroke bitmap into the committed layer.
  function commitActiveStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    const as = target.activeStroke;

    // Draw the pending tail: stamps have been placed up to lastMid; draw lastMid → last raw point.
    if (as && as.pointCount > 1) {
      const ctx = target.currentStroke.ctx;
      ctx.globalCompositeOperation = "source-over";
      const sc = { ctx, stampTex: as.stampTex, radiusPx: as.radiusPx, spacingPx: as.spacingPx, desc: target.descriptor };
      if (as.pointCount === 2) {
        // Only one linear segment was drawn; tail is also linear.
        _walkLinearStamps(sc, as.lastMidX, as.lastMidY, as.prev.x, as.prev.y, as.distSinceStamp);
      } else {
        // CR tail with ghost end (prev duplicated) to smoothly close the curve.
        _walkCRStamps(sc, as.pprev, { x: as.lastMidX, y: as.lastMidY }, as.prev, as.prev, as.distSinceStamp);
      }
    }

    const layerKind = String(stroke?.layerKind || "paint");
    const surface = layerKind === "mask" ? target.committedMask : target.committedPaint;

    if (as?.isEraser) {
      // Eraser: apply the white stamp bitmap as destination-out
      applyEraserToSurface(surface.ctx, target.currentStroke.canvas);
    } else {
      // Merge the live stamp bitmap directly into the committed layer.
      // rebuildCommitted will use processedPoints for future undo/redo replays.
      surface.ctx.drawImage(target.currentStroke.canvas, 0, 0);
    }

    clearSurface(target.currentStroke);
    target.activeStroke = null;
    activeTargetKey = "";
    activeLayerKind = "";
    target.displayDirty = true;
    composeDisplayPaint(target);
  }

  function cancelActiveStroke(descriptor) {
    const target = ensureTarget(descriptor);
    clearSurface(target.currentStroke);
    target.activeStroke = null;
    activeLayerKind = "";
    target.displayDirty = true;
    composeDisplayPaint(target);
  }

  // Legacy full-redraw path used for lasso fill preview (polygon is typically short, O(n) is fine).
  function updateActiveStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    const kind = String(stroke?.geometry?.geometryKind || "");
    if (kind === "lasso_fill") {
      clearSurface(target.currentStroke);
      drawLassoFillNative(target.currentStroke.ctx, stroke, target.descriptor);
      target.displayDirty = true;
      composeDisplayPaint(target);
    }
    // For freehand: appendStrokePoint handles it incrementally.
  }

  function getErpTarget() {
    composeDisplayPaint(erpTarget);
    return erpTarget;
  }

  return {
    rebuildCommitted,
    beginStroke,
    appendStrokePoint,
    updateActiveStroke,
    commitActiveStroke,
    cancelActiveStroke,
    getErpTarget,
    ensureTarget,
  };
}
