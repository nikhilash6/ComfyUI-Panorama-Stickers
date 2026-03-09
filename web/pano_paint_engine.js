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

// ─── Chisel Stamp Texture ────────────────────────────────────────────────────

// Build (or retrieve cached) chisel stamp for the given brush parameters.
// Shape: stadium (discorectangle) — two semicircular caps joined by a flat rectangle.
//   rx = half-width (long axis), ry = half-height (short axis, = radiusPx).
//   halfFlat = rx - ry  — half-length of the flat middle section.
// Interior alpha modulation:
//   edge lift  — stamps are more opaque near the shape boundary (ink piles at nib edge).
//   centre dip — stamps are slightly hollow at the very centre.
// The angle is NOT baked in; rotation is applied at draw time via ctx.rotate().
// col = { r, g, b, a } where a = flow (already incorporates color.a * flow from getStampColor).
// fiber ∈ [0,1]: anisotropic nib-channel noise — elongated streaks along nib axis (x), ~1.5px wide in y.
function buildChiselTexture(rx, ry, hardness, col, edgeLift, centerDip, fiber) {
  const { r: r255, g: g255, b: b255, a: flow } = col;
  const cw = Math.max(2, Math.ceil(rx) * 2);
  const ch = Math.max(2, Math.ceil(ry) * 2);
  const el = Math.max(0, edgeLift);
  const cd = Math.max(0, Math.min(0.99, centerDip));
  const fb = Math.max(0, Math.min(1, fiber ?? 0));
  const key = `chisel:${cw}:${ch}:${hardness.toFixed(2)}:${r255}:${g255}:${b255}:${flow.toFixed(3)}:${el.toFixed(2)}:${cd.toFixed(2)}:${fb.toFixed(2)}`;

  if (_stampCache.has(key)) {
    const stamp = _stampCache.get(key);
    _stampCache.delete(key);
    _stampCache.set(key, stamp);
    return stamp;
  }
  if (_stampCache.size >= STAMP_CACHE_MAX) _stampCache.delete(_stampCache.keys().next().value);

  const oc = new OffscreenCanvas(cw, ch);
  const ctx = oc.getContext("2d");
  const img = ctx.createImageData(cw, ch);
  const d = img.data;

  const halfFlat = Math.max(0, rx - ry);  // flat-section half-length
  const h = Math.max(0, Math.min(1, hardness));
  // Normalise modulation so the peak (at the shape edge) equals flow.
  const peakMod = 1 + el;

  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      // Offset from canvas centre in actual pixels.
      const ax = px + 0.5 - rx;
      const ay = py + 0.5 - ry;

      // Stadium SDF: distance from the nearest point on the centre-axis segment.
      const bx = Math.max(Math.abs(ax) - halfFlat, 0);
      const dist = Math.hypot(bx, ay);
      const sdf = dist / ry;   // 0 = centre segment, 1 = shape boundary

      if (sdf >= 1) continue;  // outside shape

      // Edge-softness mask (hardness controls crispness).
      const shapeMask = sdf <= h ? 1 : Math.max(0, (1 - sdf) / Math.max(1e-4, 1 - h));

      // Interior modulation: edge lift + centre dip.
      const innerT = 1 - sdf;  // 1 at centre, 0 at boundary
      const lift = 1 + el * (1 - innerT) * (1 - innerT);
      const dip  = 1 - cd * innerT * innerT;
      const mod  = lift * dip / peakMod;

      // Nib-fiber texture: felt channels running along the nib's long axis (x in stamp space).
      // Fine y-bands (~1.5px) with slow x-variation (~8px) create elongated streaks.
      let fiberMod = 1;
      if (fb > 0) {
        const fy = Math.floor((ay + ry) / 1.5);
        const fx = Math.floor((ax + rx) / 8);
        const fiberNoise = _seededFloat(_stampSeed(fy * 41 + 500, fx * 19 + 300));
        fiberMod = 1 - fb * 0.42 * fiberNoise;
      }

      const alpha = Math.round(255 * Math.min(1, flow * shapeMask * mod * fiberMod));
      if (alpha <= 0) continue;

      const i = (py * cw + px) * 4;
      d[i]   = r255;
      d[i + 1] = g255;
      d[i + 2] = b255;
      d[i + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  _stampCache.set(key, oc);
  return oc;
}

// ─── Scatter PRNG ─────────────────────────────────────────────────────────────

// Deterministic position hash (FNV-1a inspired) → seed for _seededFloat.
// Using position × 4-pixel precision so sub-pixel jitter doesn't change scatter.
function _stampSeed(cx, cy) {
  const xi = Math.trunc(Math.round(cx * 4));
  const yi = Math.trunc(Math.round(cy * 4));
  let h = 2166136261;
  h = Math.imul(h ^ (xi & 0xFF), 16777619);
  h = Math.imul(h ^ ((xi >> 8) & 0xFF), 16777619);
  h = Math.imul(h ^ (yi & 0xFF), 16777619);
  h = Math.imul(h ^ ((yi >> 8) & 0xFF), 16777619);
  return h >>> 0;
}

// Mulberry32 PRNG step — returns a float in [0, 1).
function _seededFloat(seed) {
  let s = (seed + 0x6D2B79F5) >>> 0;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

// ─── Stamp Context Builder ────────────────────────────────────────────────────

// ─── Crayon Stamp Texture ─────────────────────────────────────────────────────

// Returns the alpha (0-255) for a single crayon stamp pixel, or 0 if the pixel is transparent.
function _crayonPixelAlpha(px, py, rx, ry, h, gr, flow) {
  const ax       = px + 0.5 - rx;
  const ay       = py + 0.5 - ry;
  const halfFlat = Math.max(0, rx - ry);
  const bx       = Math.max(Math.abs(ax) - halfFlat, 0);
  const sdf = Math.hypot(bx, ay) / ry;
  if (sdf >= 1) return 0;

  const jitter     = _seededFloat(_stampSeed(px * 17 + 3, py * 13 + 7));
  const effSdf     = sdf + gr * 0.22 * (jitter - 0.5);
  if (effSdf >= 1) return 0;

  const shapeMask  = effSdf <= h ? 1 : Math.max(0, (1 - effSdf) / Math.max(1e-4, 1 - h));
  const noise      = _crayonPixelNoise(px, py, ax, ay, rx, ry);
  const threshold  = gr * 0.55;
  if (noise < threshold) return 0;

  const coverage   = (noise - threshold) / Math.max(1e-4, 1 - threshold);
  const grainMask  = 0.45 + 0.55 * coverage;
  return Math.round(255 * Math.min(1, flow * shapeMask * grainMask));
}

// Multi-scale wax-grain noise at a single pixel position (ax, ay relative to canvas centre).
// Returns a combined noise value in [0, 1].
function _crayonPixelNoise(px, py, ax, ay, rx, ry) {
  const cxC  = Math.floor((ax + rx) / 3);
  const cyC  = Math.floor((ay + ry) / 2);
  const nC   = _seededFloat(_stampSeed(cxC * 13 + 700, cyC * 17 + 400));
  const cxM  = Math.floor((ax + rx) / 1.5);
  const cyM  = Math.floor((ay + ry) / 1.5);
  const nM   = _seededFloat(_stampSeed(cxM * 23 + 800, cyM * 29 + 500));
  const nF   = _seededFloat(_stampSeed(px * 3 + 100, py * 5 + 200));
  return nC * 0.55 + nM * 0.3 + nF * 0.15;
}

// Build (or retrieve cached) crayon stamp.
// Shape: stadium SDF (same as chisel), but alpha is modulated by per-pixel wax grain noise
// so the interior has a fibrous, uneven texture and the edge is organically irregular.
// col = { r, g, b, a } — a includes flow.  grain ∈ [0, 1].
function buildCrayonTexture(rx, ry, hardness, col, grain) {
  const { r: r255, g: g255, b: b255, a: flow } = col;
  const cw  = Math.max(2, Math.ceil(rx) * 2);
  const ch  = Math.max(2, Math.ceil(ry) * 2);
  const gr  = Math.max(0, Math.min(1, grain));
  const key = `crayon:${cw}:${ch}:${hardness.toFixed(2)}:${r255}:${g255}:${b255}:${flow.toFixed(3)}:${gr.toFixed(2)}`;

  if (_stampCache.has(key)) {
    const s = _stampCache.get(key);
    _stampCache.delete(key);
    _stampCache.set(key, s);
    return s;
  }
  if (_stampCache.size >= STAMP_CACHE_MAX) _stampCache.delete(_stampCache.keys().next().value);

  const oc  = new OffscreenCanvas(cw, ch);
  const ctx = oc.getContext("2d");
  const img = ctx.createImageData(cw, ch);
  const d   = img.data;

  const h = Math.max(0, Math.min(1, hardness));

  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const alpha = _crayonPixelAlpha(px, py, rx, ry, h, gr, flow);
      if (alpha <= 0) continue;
      const i = (py * cw + px) * 4;
      d[i]     = r255;
      d[i + 1] = g255;
      d[i + 2] = b255;
      d[i + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  _stampCache.set(key, oc);
  return oc;
}

// ─── Stamp Context Builder ────────────────────────────────────────────────────

// Build the shared stamp context (sc) from a stroke record and descriptor.
// Centralises texture dispatch (round / chisel / crayon) and scatter params.
// sc = { ctx, stampTex, radiusPx, spacingPx, desc, aspect, angle, stampKind, scatter }
function buildStampContext(ctx, stroke, descriptor) {
  const stampKind = String(stroke?.stampKind || "round");
  const radiusPx  = getRadiusPx(stroke, descriptor);
  const hardness  = Math.max(0, Math.min(1, Number(stroke?.hardness ?? 0.9)));
  const col       = getStampColor(stroke);
  const aspect    = Math.max(0.1, Number(stroke?.aspect ?? 1));
  const angle     = Number(stroke?.angle?.value ?? 0);
  const spacingPx = getSpacingPx(stroke, radiusPx);
  const rawSc     = stroke?.scatter;
  const scatter   = rawSc
    ? { radius: Number(rawSc.radius ?? 1.5), count: Math.max(1, Math.round(rawSc.count ?? 6)) }
    : null;

  let stampTex;
  if (stampKind === "chisel") {
    const rx       = radiusPx * aspect;
    const ry       = radiusPx;
    const edgeLift = Math.max(0, Number(stroke?.chiselEdgeLift ?? 0.4));
    const centDip  = Math.max(0, Number(stroke?.chiselCenterDip ?? 0.3));
    const fiber    = Math.max(0, Math.min(1, Number(stroke?.chiselFiber ?? 0)));
    stampTex = buildChiselTexture(rx, ry, hardness, col, edgeLift, centDip, fiber);
  } else if (stampKind === "crayon") {
    const rx    = radiusPx * aspect;
    const ry    = radiusPx;
    const grain = Math.max(0, Math.min(1, Number(stroke?.crayonGrain ?? 0.65)));
    stampTex = buildCrayonTexture(rx, ry, hardness, col, grain);
  } else {
    stampTex = buildStampTexture(radiusPx, hardness, col.r, col.g, col.b, col.a);
  }

  return { ctx, stampTex, radiusPx, spacingPx, desc: descriptor, aspect, angle, stampKind, scatter };
}

// ─── Stamp Color ─────────────────────────────────────────────────────────────

// Returns {r, g, b, a} for buildStampTexture.
// Eraser and mask strokes always use white (composited with destination-out / tint later).
// Paint strokes: alpha = color.a * flow.
// stroke.opacity is NOT baked here — it is applied at composite time (commitActiveStroke /
// drawStrokeToSurface), so that "flat" and "accumulate" modes both honour it correctly.
function getStampColor(stroke) {
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (toolKind === "eraser" || layerKind === "mask") {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const flow = Math.max(0, Math.min(1, Number(stroke?.flow ?? 1)));
  const alpha = Math.max(0, Math.min(1, Number(c.a ?? 1))) * flow;
  return {
    r: Math.round(Math.max(0, Math.min(1, Number(c.r || 0))) * 255),
    g: Math.round(Math.max(0, Math.min(1, Number(c.g || 0))) * 255),
    b: Math.round(Math.max(0, Math.min(1, Number(c.b || 0))) * 255),
    a: alpha,
  };
}

// CSS color string for lasso fill polygon (not stamp-based).
// Uses color.a directly — stroke.opacity is intentionally excluded so the fill
// matches the user's chosen color exactly regardless of brush preset opacity.
function strokeStyleForKind(stroke) {
  const layerKind = String(stroke?.layerKind || "paint");
  const toolKind = String(stroke?.toolKind || "pen");
  if (toolKind === "eraser" || layerKind === "mask") return "rgba(255,255,255,1)";
  const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
  const alpha = Math.max(0, Math.min(1, Number(c.a ?? 1)));
  return `rgba(${Math.round(Number(c.r || 0) * 255)},${Math.round(Number(c.g || 0) * 255)},${Math.round(Number(c.b || 0) * 255)},${alpha})`;
}

// ─── Curve Helpers ────────────────────────────────────────────────────────────

// ─── Stamp Drawing ────────────────────────────────────────────────────────────

// Place one stamp image at (ox, oy) applying latitude correction and angle rotation.
// For chisel stamps the angle is baked via ctx.rotate so the nib stays oriented.
// Seam width accounts for the bounding box of the rotated stamp.
function _placeStamp(sc, ox, oy, rv, rh) {
  const ang = sc.angle;
  const W   = sc.desc.width;

  function _draw(x, y) {
    if (ang === 0) {
      sc.ctx.drawImage(sc.stampTex, x - rh, y - rv, rh * 2, rv * 2);
    } else {
      sc.ctx.save();
      sc.ctx.translate(x, y);
      sc.ctx.rotate(ang);
      sc.ctx.drawImage(sc.stampTex, -rh, -rv, rh * 2, rv * 2);
      sc.ctx.restore();
    }
  }

  _draw(ox, oy);
  // Seam wrap: use rotated bounding-box half-width so angled stamps near u=0/1 are mirrored.
  const seamW = ang === 0
    ? rh
    : rh * Math.abs(Math.cos(ang)) + rv * Math.abs(Math.sin(ang));
  if (ox - seamW < 0) _draw(ox + W, oy);
  if (ox + seamW > W) _draw(ox - W, oy);
}

// Draw one stamp at (cx, cy) using the shared stamp context sc.
// sc = { ctx, stampTex, radiusPx, spacingPx, desc, aspect, angle, stampKind, scatter }
//
// ERP latitude correction: horizontal radius is stretched by 1/cos(lat).
// Preset aspect further scales the horizontal radius (e.g. 2.6 for a wide chisel marker).
// For scatter brushes: each call spawns sc.scatter.count sub-stamps at random positions
// within sc.scatter.radius × radiusPx, using a deterministic position-seeded PRNG.
function _drawSingleStamp(sc, cx, cy, widthScale) {
  const ws = Math.max(0.01, Number.isFinite(widthScale) ? widthScale : 1);

  if (sc.scatter) {
    const { radius, count } = sc.scatter;
    const scatterPx = radius * sc.radiusPx * ws;
    const seed0 = _stampSeed(cx, cy);
    for (let i = 0; i < count; i++) {
      const a = _seededFloat(seed0 + i * 2) * Math.PI * 2;
      const d = Math.sqrt(_seededFloat(seed0 + i * 2 + 1)) * scatterPx;
      const sx = cx + Math.cos(a) * d;
      const sy = cy + Math.sin(a) * d;
      const subRv = Math.max(0.5, sc.radiusPx * ws * 0.48);
      const lat   = (0.5 - sy / Math.max(1, sc.desc.height)) * Math.PI;
      const rh    = subRv * sc.aspect / Math.max(0.05, Math.cos(lat));
      _placeStamp(sc, sx, sy, subRv, rh);
    }
    return;
  }

  const rv = Math.max(0.5, sc.radiusPx * ws);
  const lat = (0.5 - cy / Math.max(1, sc.desc.height)) * Math.PI;
  const rh  = rv * sc.aspect / Math.max(0.05, Math.cos(lat));
  _placeStamp(sc, cx, cy, rv, rh);
}

// Draw a complete freehand stroke using the stamp engine.
// Uses the same centripetal Catmull-Rom + midpoint-anchor algorithm as live rendering,
// so rebuild (undo/redo) looks identical to the stroke as it was drawn.
function drawStampStroke(ctx, stroke, descriptor) {
  const points = getRawPoints(stroke);
  if (!ctx || points.length === 0) return;

  const W = descriptor.width;
  const H = descriptor.height;
  const sc = buildStampContext(ctx, stroke, descriptor);

  ctx.save();
  ctx.globalCompositeOperation = "source-over";

  // Convert UV to pixel space, unwrapping the seam so consecutive points always
  // take the short path (|dx| ≤ W/2). Stamps near x<0 or x>W are mirrored by _placeStamp.
  const pts = [];
  for (let i = 0; i < points.length; i++) {
    let px = Number(points[i].u || 0) * W;
    const py = Number(points[i].v || 0) * H;
    if (i > 0 && Math.abs(px - pts[i - 1].x) > W * 0.5) {
      px += px < pts[i - 1].x ? W : -W;
    }
    pts.push({ x: px, y: py });
  }

  // First stamp at p0
  _drawSingleStamp(sc, pts[0].x, pts[0].y, 1);

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

  // Convert to pixel space and seam-unwrap so the polygon takes the short path
  // across any u=0/u=1 crossing (same strategy as drawStampStroke).
  const px = [];
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const c = getTargetCoord(points[i]);
    let x = Number(c.x || 0) * w;
    if (i > 0 && Math.abs(x - px[i - 1].x) > w * 0.5) {
      x += x < px[i - 1].x ? w : -w;
    }
    px.push({ x, y: Number(c.y || 0) * h });
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }

  function drawPoly(offsetX) {
    ctx.beginPath();
    ctx.moveTo(px[0].x + offsetX, px[0].y);
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x + offsetX, px[i].y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = style;
  drawPoly(0);
  if (minX < 0) drawPoly(w);    // polygon crosses seam leftward → mirror to right half
  if (maxX > w) drawPoly(-w);   // polygon crosses seam rightward → mirror to left half
  ctx.restore();
}

// Draw a stroke to the given ctx.
// Eraser strokes are rendered as WHITE marks; caller applies destination-out when compositing.
// For non-eraser strokes, stroke.opacity is applied when compositing onto ctx.
function drawStrokeToSurface(ctx, stroke, descriptor) {
  const kind = String(stroke?.geometry?.geometryKind || "");
  if (kind === "lasso_fill") {
    drawLassoFillNative(ctx, stroke, descriptor);
    return;
  }
  const isEraser = String(stroke?.toolKind || "") === "eraser";
  const opacity = isEraser ? 1 : Math.max(0, Math.min(1, Number(stroke?.opacity ?? 1)));
  if (opacity >= 0.999) {
    drawStampStroke(ctx, stroke, descriptor);
  } else {
    // Two-step composite: draw stamps at full flow into a temp surface,
    // then composite at stroke opacity. Ensures correct flat/accumulate behaviour on rebuild.
    const tmp = createCanvasSurface(descriptor.width, descriptor.height);
    drawStampStroke(tmp.ctx, stroke, descriptor);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.drawImage(tmp.canvas, 0, 0);
    ctx.restore();
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
    _drawSingleStamp(sc, ax + dx * t, ay + dy * t, 1);
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
  const W  = desc.width;
  const py = y * desc.height;
  const as = target.activeStroke;
  // Seam-unwrap: choose whichever side of the wrap is closer to the previous point
  // so the stamp walk takes the short path across any seam crossing.
  let px = x * W;
  if (as && Math.abs(px - as.prev.x) > W * 0.5) {
    px += px < as.prev.x ? W : -W;
  }

  if (!as) {
    // First point: build stamp context, place initial stamp, initialize CR history.
    const sc0 = buildStampContext(ctx, stroke, desc);
    const strokeOpacity = Math.max(0, Math.min(1, Number(stroke?.opacity ?? 1)));
    const velocityWidthFactor = Math.max(0, Number(stroke?.velocityWidthFactor ?? 0));
    const isEraser = String(stroke?.toolKind || "") === "eraser";
    const layerKind = String(stroke?.layerKind || "paint");

    ctx.globalCompositeOperation = "source-over";
    _drawSingleStamp(sc0, px, py, 1);

    target.activeStroke = {
      pprev: { x: px, y: py },
      prev:  { x: px, y: py },
      lastMidX: px, lastMidY: py,
      stampTex: sc0.stampTex, radiusPx: sc0.radiusPx, spacingPx: sc0.spacingPx,
      aspect: sc0.aspect, angle: sc0.angle, stampKind: sc0.stampKind, scatter: sc0.scatter,
      strokeOpacity, velocityWidthFactor,
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
  const sc = {
    ctx,
    stampTex: as.stampTex, radiusPx: as.radiusPx, spacingPx: as.spacingPx,
    desc, aspect: as.aspect, angle: as.angle, stampKind: as.stampKind, scatter: as.scatter,
  };

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
    // lassoPreviewActive: true while a lasso fill is being drawn (not yet committed).
    // composeDisplayPaint composites currentStroke at 0.5 opacity for the live preview.
    lassoPreviewActive: false,
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
      // Lasso preview: show at 50% so the boundary is clearly visible before confirming.
      const strokeOpacity = target.lassoPreviewActive ? 0.5 : Math.max(0, Math.min(1, as?.strokeOpacity ?? 1));
      dCtx.save();
      dCtx.globalAlpha = strokeOpacity;
      dCtx.drawImage(target.currentStroke.canvas, 0, 0);
      dCtx.restore();
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
      const sc = { ctx, stampTex: as.stampTex, radiusPx: as.radiusPx, spacingPx: as.spacingPx, desc: target.descriptor, aspect: as.aspect, angle: as.angle };
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

    // Lasso preview was drawn at 50%; redraw at full opacity before merging into committed.
    if (target.lassoPreviewActive) {
      clearSurface(target.currentStroke);
      drawLassoFillNative(target.currentStroke.ctx, stroke, target.descriptor);
      target.lassoPreviewActive = false;
    }

    if (as?.isEraser) {
      // Eraser: apply the white stamp bitmap as destination-out
      applyEraserToSurface(surface.ctx, target.currentStroke.canvas);
    } else {
      // Merge live stamp bitmap into committed layer, applying stroke-level opacity.
      const opacity = Math.max(0, Math.min(1, as?.strokeOpacity ?? 1));
      surface.ctx.save();
      surface.ctx.globalAlpha = opacity;
      surface.ctx.drawImage(target.currentStroke.canvas, 0, 0);
      surface.ctx.restore();
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
    target.lassoPreviewActive = false;
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
      target.lassoPreviewActive = true;
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
