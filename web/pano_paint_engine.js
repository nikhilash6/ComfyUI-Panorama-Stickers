// Paint Engine Manager
//
// Architecture:
//   Source of truth    = stroke records (durable, in state_json.painting)
//   Native raster cache = committedPaint / committedMask per target (derived)
//   Active stroke      = currentStroke (ephemeral, accumulated incrementally)
//   Display            = composed from committed + currentStroke on demand (per rAF frame)
//
// Rendering strategy: Incremental midpoint-bezier
//
//   For paint / mask / eraser strokes:
//     - currentStroke is ACCUMULATED, never cleared per pointermove
//     - Each new point appends one bezier segment: O(1) per point
//     - commit = drawImage(currentStroke -> committed). Shape cannot change on pointerup.
//     - rebuildCommitted uses the same midpoint-bezier algorithm from rawPoints.
//
//   Eraser display compositing:
//     - currentStroke holds the eraser path drawn in white (source-over on transparent)
//     - composeDisplayPaint applies destination-out to show the preview correctly
//     - commit applies the same destination-out to the committed layer

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
    // Assigning canvas dimensions implicitly clears the canvas.
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

// Shared temp canvas for drawMaskTint — resized lazily, never shrunk.
let _maskTintTmp = null;

// Overlay a green tint over mask-shaped pixels on displayCtx.
// Does NOT affect non-mask pixels (paint pixels remain unchanged).
function drawMaskTint(displayCtx, maskCanvas) {
  if (!displayCtx || !maskCanvas) return;
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  // Lazily create / grow the shared temp surface
  if (!_maskTintTmp || _maskTintTmp.canvas.width < w || _maskTintTmp.canvas.height < h) {
    _maskTintTmp = createCanvasSurface(Math.max(w, _maskTintTmp?.canvas.width || 0), Math.max(h, _maskTintTmp?.canvas.height || 0));
  }
  const tmp = _maskTintTmp;
  tmp.ctx.clearRect(0, 0, w, h);
  // Step 1: draw mask (white marks on transparent)
  tmp.ctx.drawImage(maskCanvas, 0, 0);
  // Step 2: source-in — keep only pixels within the mask shape, fill them green
  tmp.ctx.globalCompositeOperation = "source-in";
  tmp.ctx.fillStyle = "rgba(34, 197, 94, 0.82)";
  tmp.ctx.fillRect(0, 0, w, h);
  tmp.ctx.globalCompositeOperation = "source-over"; // reset for next use
  // Step 3: overlay the green mask shape onto display (leaves paint pixels intact)
  displayCtx.save();
  displayCtx.globalCompositeOperation = "source-over";
  displayCtx.drawImage(tmp.canvas, 0, 0, w, h);
  displayCtx.restore();
}

function getTargetCoord(point) {
  if (!point || typeof point !== "object") return { x: 0, y: 0 };
  return { x: Number(point.u || 0), y: Number(point.v || 0) };
}

// Return the best available point list for rendering.
// Priority: processedPoints (smoothed, used by rebuild/undo) > rawPoints > points.
// During live drawing processedPoints is empty, so rawPoints is used.
// After commit, updateStrokeProcessedPoints fills processedPoints; subsequent rebuilds
// (undo/redo, reload) then use the smoothed version, matching live rendering quality.
function getRawPoints(stroke) {
  const geometry = stroke?.geometry;
  if (!geometry) return [];
  if (Array.isArray(geometry.processedPoints) && geometry.processedPoints.length) return geometry.processedPoints;
  if (Array.isArray(geometry.rawPoints) && geometry.rawPoints.length) return geometry.rawPoints;
  if (Array.isArray(geometry.points) && geometry.points.length) return geometry.points;
  return [];
}

function getRadiusPx(stroke, descriptor) {
  const radiusValue = Number(stroke?.radiusValue);
  const radiusModel = String(stroke?.radiusModel || "").trim();
  if ((radiusModel === "frame_local_norm" || radiusModel === "erp_uv_norm") && radiusValue > 0) {
    return Math.max(0.5, radiusValue * (descriptor?.width || 1));
  }
  return Math.max(0.5, Number(stroke?.baseSize || stroke?.size || 10) * 0.5);
}

function strokeStyleForKind(stroke) {
  // For eraser and mask: always white (currentStroke is then composited with dest-out or tint)
  // For paint: use stroke color
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (toolKind === "eraser" || layerKind === "mask") {
    return "rgba(255,255,255,1)";
  }
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const alpha = Math.max(0, Math.min(1, Number(c.a ?? stroke?.opacity ?? 1)));
  return `rgba(${Math.round(Number(c.r || 0) * 255)},${Math.round(Number(c.g || 0) * 255)},${Math.round(Number(c.b || 0) * 255)},${alpha})`;
}

// Draw a freehand stroke using midpoint-bezier algorithm.
// Used by rebuildCommitted to reproduce the exact same curve produced by incremental rendering.
//
// For non-eraser: draws directly with stroke color (source-over) → additive
// For eraser: draws WHITE marks (source-over) → caller applies destination-out when compositing
function drawMidpointBezierStroke(ctx, stroke, descriptor) {
  const rawPoints = getRawPoints(stroke);
  if (!ctx || !rawPoints.length) return;

  const w = descriptor.width;
  const h = descriptor.height;
  const lineWidth = Math.max(1, getRadiusPx(stroke, descriptor) * 2);
  const style = strokeStyleForKind(stroke);

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = style;
  ctx.fillStyle = style;
  ctx.lineWidth = lineWidth;

  const firstCoord = getTargetCoord(rawPoints[0]);
  const fx = firstCoord.x * w;
  const fy = firstCoord.y * h;

  if (rawPoints.length === 1) {
    ctx.beginPath();
    ctx.arc(fx, fy, lineWidth * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(fx, fy);

  let lastX = fx;
  let lastY = fy;

  for (let i = 1; i < rawPoints.length; i += 1) {
    const coord = getTargetCoord(rawPoints[i]);
    const px = coord.x * w;
    const py = coord.y * h;
    const midX = (lastX + px) * 0.5;
    const midY = (lastY + py) * 0.5;
    ctx.quadraticCurveTo(lastX, lastY, midX, midY);
    lastX = px;
    lastY = py;
  }
  ctx.lineTo(lastX, lastY);
  ctx.stroke();
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

// For rebuild: draw stroke to the given ctx.
// Eraser strokes are drawn as WHITE marks; caller must apply destination-out when compositing.
function drawStrokeToSurface(ctx, stroke, descriptor) {
  const kind = String(stroke?.geometry?.geometryKind || "");
  if (kind === "lasso_fill") {
    drawLassoFillNative(ctx, stroke, descriptor);
  } else {
    drawMidpointBezierStroke(ctx, stroke, descriptor);
  }
}

// Apply destination-out: erase committed layer where eraserCanvas has white marks.
function applyEraserToSurface(targetCtx, eraserCanvas) {
  targetCtx.save();
  targetCtx.globalCompositeOperation = "destination-out";
  targetCtx.drawImage(eraserCanvas, 0, 0);
  targetCtx.restore();
}

function targetKeyOf(descriptor) {
  return descriptor.kind === "ERP_GLOBAL" ? "erp" : `frame:${String(descriptor.frameId || "")}`;
}

// Append one point to the active freehand stroke using incremental midpoint-bezier.
// x, y are normalized target-space coords [0,1].
// O(1) per call — only the new segment is drawn; previous segments are not redrawn.
function appendStrokePoint(target, x, y, stroke) {
  const ctx = target.currentStroke.ctx;
  if (!ctx) return;

  const w = target.descriptor.width;
  const h = target.descriptor.height;
  const px = x * w;
  const py = y * h;
  const as = target.activeStroke;

  if (!as?.pathStarted) {
    // First point: configure style, draw an immediate dot, then open the path for subsequent segments.
    // Without the immediate dot, single taps and very short strokes would be invisible until commit.
    const lineWidth = Math.max(1, getRadiusPx(stroke, target.descriptor) * 2);
    const style = strokeStyleForKind(stroke);
    const isEraser = String(stroke?.toolKind || "") === "eraser";
    const layerKind = String(stroke?.layerKind || "paint");

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = style;
    ctx.fillStyle = style;
    ctx.lineWidth = lineWidth;

    // Draw immediate dot so the first point is visible before any movement.
    ctx.beginPath();
    ctx.arc(px, py, lineWidth * 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Open path for incremental bezier segments.
    ctx.beginPath();
    ctx.moveTo(px, py);

    target.activeStroke = { lastX: px, lastY: py, lineWidth, isEraser, layerKind, pathStarted: true, hasSegments: false };
    target.displayDirty = true;
    return;
  }

  // Subsequent point: draw bezier to midpoint, leave path open for next segment
  const midX = (as.lastX + px) * 0.5;
  const midY = (as.lastY + py) * 0.5;
  ctx.quadraticCurveTo(as.lastX, as.lastY, midX, midY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(midX, midY);
  as.lastX = px;
  as.lastY = py;
  as.hasSegments = true;
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

  // ERP_GLOBAL is the only painting target. All strokes are stored in ERP UV space.
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
        // Build temporary mask-minus-eraser for tint display
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
      // Only ERP_GLOBAL strokes are supported. Legacy FRAME_LOCAL strokes are ignored.
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

  // Begin a new stroke: clear currentStroke canvas, initialize incremental state.
  function beginStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    clearSurface(target.currentStroke);
    target.activeStroke = null;
    target.displayDirty = true;
  }

  // Commit the active stroke: finalize path, merge currentStroke into committed layer.
  // O(1) — no re-render. Shape is identical to live preview.
  function commitActiveStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    const as = target.activeStroke;

    // Finalize path
    if (as?.pathStarted) {
      const ctx = target.currentStroke.ctx;
      if (as.hasSegments) {
        // Draw final segment to the last raw point
        ctx.lineTo(as.lastX, as.lastY);
        ctx.stroke();
      } else {
        // Single tap: no segments were drawn, render a dot
        ctx.arc(as.lastX, as.lastY, as.lineWidth * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore(); // paired with ctx.save() in appendStrokePoint first-point branch
    }

    // Merge currentStroke into committed layer
    const layerKind = String(stroke?.layerKind || "paint");
    const surface = layerKind === "mask" ? target.committedMask : target.committedPaint;

    if (as?.isEraser) {
      // Eraser: apply currentStroke (white marks) as destination-out
      applyEraserToSurface(surface.ctx, target.currentStroke.canvas);
    } else {
      // For paint/mask: prefer processedPoints if available so the committed layer
      // matches what rebuildCommitted will produce (undo/redo/reload are then stable).
      // This is a one-time "finalize" smoothing step at pointerup.
      // If processedPoints are not yet filled, fall back to the live bitmap.
      const procPoints = stroke?.geometry?.processedPoints;
      if (Array.isArray(procPoints) && procPoints.length >= 1) {
        drawMidpointBezierStroke(surface.ctx, stroke, target.descriptor);
      } else {
        surface.ctx.drawImage(target.currentStroke.canvas, 0, 0);
      }
    }

    // Reset
    clearSurface(target.currentStroke);
    target.activeStroke = null;
    activeTargetKey = "";
    activeLayerKind = "";
    target.displayDirty = true;
    composeDisplayPaint(target);
  }

  function cancelActiveStroke(descriptor) {
    const target = ensureTarget(descriptor);
    if (target.activeStroke?.pathStarted) {
      // Restore the ctx state that was saved in appendStrokePoint first-point branch
      target.currentStroke.ctx.restore();
    }
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
    // For freehand: appendStrokePoint handles it; this is a no-op.
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
