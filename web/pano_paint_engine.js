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

function drawMaskTint(displayCtx, maskCanvas) {
  if (!displayCtx || !maskCanvas) return;
  displayCtx.save();
  displayCtx.drawImage(maskCanvas, 0, 0);
  displayCtx.globalCompositeOperation = "source-atop";
  displayCtx.fillStyle = "rgba(34, 197, 94, 0.82)";
  displayCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  displayCtx.restore();
}

function resizeSurface(surface, width, height) {
  if (!surface) return createCanvasSurface(width, height);
  const nextW = Math.max(1, Math.round(width));
  const nextH = Math.max(1, Math.round(height));
  if (surface.canvas.width !== nextW || surface.canvas.height !== nextH) {
    surface.canvas.width = nextW;
    surface.canvas.height = nextH;
  }
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  surface.ctx.imageSmoothingEnabled = true;
  return surface;
}

function clearSurface(surface) {
  if (!surface?.ctx) return;
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
}

function clonePoint(raw) {
  return raw && typeof raw === "object" ? { ...raw } : raw;
}

function getTargetCoord(point) {
  if (!point || typeof point !== "object") return { x: 0, y: 0 };
  if (String(point.targetKind || "") === "FRAME_LOCAL" || "x" in point || "y" in point) {
    return { x: Number(point.x || 0), y: Number(point.y || 0) };
  }
  return { x: Number(point.u || 0), y: Number(point.v || 0) };
}

function getGeometryPoints(stroke, key = "processedPoints") {
  const geometry = stroke?.geometry;
  if (!geometry || typeof geometry !== "object") return [];
  if (Array.isArray(geometry[key]) && geometry[key].length) return geometry[key];
  if (Array.isArray(geometry.points) && geometry.points.length) return geometry.points;
  return [];
}

function getRadiusPx(stroke, point, width) {
  const radiusValue = Number(stroke?.radiusValue);
  const radiusModel = String(stroke?.radiusModel || "").trim();
  const widthScale = Number.isFinite(Number(point?.widthScale)) ? Math.max(0, Number(point.widthScale)) : 1;
  const pressureLike = Number.isFinite(Number(point?.pressureLike)) ? Math.max(0, Number(point.pressureLike)) : 1;
  const scale = widthScale * pressureLike;
  if (radiusModel === "frame_local_norm" || radiusModel === "erp_uv_norm") {
    return Math.max(0.5, Number(radiusValue || 0) * width * scale);
  }
  return Math.max(0.5, Number(stroke?.baseSize || stroke?.size || 10) * 0.5 * scale);
}

function configurePathStyle(ctx, stroke, kind = "stroke") {
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (layerKind === "mask") {
    if (kind === "fill") ctx.fillStyle = "rgba(255,255,255,1)";
    else ctx.strokeStyle = "rgba(255,255,255,1)";
    return;
  }
  if (toolKind === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    if (kind === "fill") ctx.fillStyle = "rgba(0,0,0,1)";
    else ctx.strokeStyle = "rgba(0,0,0,1)";
    return;
  }
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const rgba = `rgba(${Math.round(Number(c.r || 0) * 255)}, ${Math.round(Number(c.g || 0) * 255)}, ${Math.round(Number(c.b || 0) * 255)}, ${Math.max(0, Math.min(1, Number(c.a ?? stroke?.opacity ?? 1)))})`;
  if (kind === "fill") ctx.fillStyle = rgba;
  else ctx.strokeStyle = rgba;
}

function drawFreehandStrokeNative(ctx, stroke, target, pointKey = "processedPoints") {
  const points = getGeometryPoints(stroke, pointKey);
  if (!ctx || !points.length) return;
  ctx.save();
  configurePathStyle(ctx, stroke, "stroke");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const avgRadius = points.reduce((acc, pt) => acc + getRadiusPx(stroke, pt, target.width), 0) / Math.max(1, points.length);
  if (points.length === 1) {
    const only = getTargetCoord(points[0]);
    ctx.beginPath();
    ctx.arc(only.x * target.width, only.y * target.height, Math.max(0.5, avgRadius), 0, Math.PI * 2);
    if (ctx.globalCompositeOperation === "destination-out") ctx.fill();
    else {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  ctx.lineWidth = Math.max(1, avgRadius * 2);
  const first = getTargetCoord(points[0]);
  ctx.beginPath();
  ctx.moveTo(first.x * target.width, first.y * target.height);
  for (let i = 1; i < points.length; i += 1) {
    const p = getTargetCoord(points[i]);
    ctx.lineTo(p.x * target.width, p.y * target.height);
  }
  ctx.stroke();
  ctx.restore();
}

function drawLassoFillNative(ctx, stroke, target) {
  const points = Array.isArray(stroke?.geometry?.points) ? stroke.geometry.points : [];
  if (!ctx || points.length < 3) return;
  ctx.save();
  configurePathStyle(ctx, stroke, "fill");
  const first = getTargetCoord(points[0]);
  ctx.beginPath();
  ctx.moveTo(first.x * target.width, first.y * target.height);
  for (let i = 1; i < points.length; i += 1) {
    const p = getTargetCoord(points[i]);
    ctx.lineTo(p.x * target.width, p.y * target.height);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawStrokeNative(ctx, stroke, target, pointKey = "processedPoints") {
  const kind = String(stroke?.geometry?.geometryKind || "");
  if (kind === "lasso_fill") {
    drawLassoFillNative(ctx, stroke, target);
    return;
  }
  drawFreehandStrokeNative(ctx, stroke, target, pointKey);
}

function targetKeyOf(descriptor) {
  return descriptor.kind === "ERP_GLOBAL" ? "erp" : `frame:${String(descriptor.frameId || "")}`;
}

export function createPaintEngineManager() {
  const erpTarget = {
    descriptor: { kind: "ERP_GLOBAL", width: 2048, height: 1024 },
    committedPaint: createCanvasSurface(2048, 1024),
    committedMask: createCanvasSurface(2048, 1024),
    currentStroke: createCanvasSurface(2048, 1024),
    displayPaint: createCanvasSurface(2048, 1024),
  };
  const frameTargets = new Map();
  let revisionKey = "";
  let activeTargetKey = "";
  let activeLayerKind = "";

  function ensureTarget(descriptor) {
    if (descriptor.kind === "ERP_GLOBAL") return erpTarget;
    const key = String(descriptor.frameId || "");
    let target = frameTargets.get(key);
    if (!target) {
      target = {
        descriptor: { ...descriptor },
        committedPaint: createCanvasSurface(descriptor.width, descriptor.height),
        committedMask: createCanvasSurface(descriptor.width, descriptor.height),
        currentStroke: createCanvasSurface(descriptor.width, descriptor.height),
        displayPaint: createCanvasSurface(descriptor.width, descriptor.height),
      };
      frameTargets.set(key, target);
    }
    target.descriptor = { ...descriptor };
    target.committedPaint = resizeSurface(target.committedPaint, descriptor.width, descriptor.height);
    target.committedMask = resizeSurface(target.committedMask, descriptor.width, descriptor.height);
    target.currentStroke = resizeSurface(target.currentStroke, descriptor.width, descriptor.height);
    target.displayPaint = resizeSurface(target.displayPaint, descriptor.width, descriptor.height);
    return target;
  }

  function getSurfaceForStroke(target, stroke) {
    return String(stroke?.layerKind || "") === "mask" ? target.committedMask : target.committedPaint;
  }

  function composeDisplayPaint(target) {
    clearSurface(target.displayPaint);
    target.displayPaint.ctx.drawImage(target.committedPaint.canvas, 0, 0);
    drawMaskTint(target.displayPaint.ctx, target.committedMask.canvas);
    if (activeTargetKey !== targetKeyOf(target.descriptor)) return;
    if (activeLayerKind === "paint") {
      target.displayPaint.ctx.drawImage(target.currentStroke.canvas, 0, 0);
      return;
    }
    if (activeLayerKind === "mask") {
      drawMaskTint(target.displayPaint.ctx, target.currentStroke.canvas);
    }
  }

  function rebuildCommitted(state, frameDescriptors = []) {
    const nextKey = JSON.stringify({
      painting: state?.painting || null,
      frames: frameDescriptors.map((item) => ({ id: item.id, w: item.width, h: item.height })),
    });
    if (revisionKey === nextKey) return;
    revisionKey = nextKey;
    clearSurface(erpTarget.committedPaint);
    clearSurface(erpTarget.committedMask);
    clearSurface(erpTarget.currentStroke);
    frameTargets.forEach((target) => {
      clearSurface(target.committedPaint);
      clearSurface(target.committedMask);
      clearSurface(target.currentStroke);
    });
    const frameMap = new Map(frameDescriptors.map((item) => [String(item.id || ""), item]));
    const strokes = [
      ...(Array.isArray(state?.painting?.paint?.strokes) ? state.painting.paint.strokes : []),
      ...(Array.isArray(state?.painting?.mask?.strokes) ? state.painting.mask.strokes : []),
    ];
    strokes.forEach((stroke) => {
      const descriptor = stroke?.targetSpace?.kind === "FRAME_LOCAL"
        ? frameMap.get(String(stroke?.targetSpace?.frameId || "")) || null
        : erpTarget.descriptor;
      if (!descriptor) return;
      const target = ensureTarget(descriptor);
      drawStrokeNative(getSurfaceForStroke(target, stroke).ctx, stroke, target.descriptor);
    });
    composeDisplayPaint(erpTarget);
    frameTargets.forEach((target) => composeDisplayPaint(target));
  }

  function beginStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    clearSurface(target.currentStroke);
  }

  function updateActiveStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    clearSurface(target.currentStroke);
    drawStrokeNative(target.currentStroke.ctx, stroke, target.descriptor, "processedPoints");
    composeDisplayPaint(target);
  }

  function commitActiveStroke(stroke, descriptor) {
    const target = ensureTarget(descriptor);
    activeTargetKey = targetKeyOf(target.descriptor);
    activeLayerKind = String(stroke?.layerKind || "");
    clearSurface(target.currentStroke);
    drawStrokeNative(getSurfaceForStroke(target, stroke).ctx, stroke, target.descriptor, "processedPoints");
    composeDisplayPaint(target);
    clearSurface(target.currentStroke);
    activeLayerKind = "";
  }

  function cancelActiveStroke(descriptor) {
    const target = ensureTarget(descriptor);
    clearSurface(target.currentStroke);
    composeDisplayPaint(target);
    activeLayerKind = "";
  }

  function getErpTarget() {
    composeDisplayPaint(erpTarget);
    return erpTarget;
  }

  function getFrameTarget(frameId) {
    const target = frameTargets.get(String(frameId || ""));
    if (!target) return null;
    composeDisplayPaint(target);
    return target;
  }

  return {
    rebuildCommitted,
    beginStroke,
    updateActiveStroke,
    commitActiveStroke,
    cancelActiveStroke,
    getErpTarget,
    getFrameTarget,
    ensureTarget,
  };
}
