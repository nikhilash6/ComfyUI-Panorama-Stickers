import { createPanoGlRenderer } from "./pano_gl_renderer.js";

function getRendererCache(owner) {
  if (!owner) return null;
  if (!owner.__panoGlViewportCache) owner.__panoGlViewportCache = new Map();
  return owner.__panoGlViewportCache;
}

function getRendererEntry(owner, key) {
  const cache = getRendererCache(owner);
  if (!cache) return null;
  let entry = cache.get(key);
  if (!entry) {
    const renderer = createPanoGlRenderer();
    if (!renderer?.isSupported?.()) return null;
    entry = { renderer };
    cache.set(key, entry);
  }
  return entry;
}

function imageRevisionKey(img) {
  if (!img) return "";
  return [
    String(img.currentSrc || img.src || ""),
    Number(img.naturalWidth || img.videoWidth || img.width || 0),
    Number(img.naturalHeight || img.videoHeight || img.height || 0),
  ].join("|");
}

function resolveRect(options = {}) {
  if (options.rect) return options.rect;
  return {
    x: 0,
    y: 0,
    w: Math.max(1, Number(options.width || 1)),
    h: Math.max(1, Number(options.height || 1)),
  };
}

export function renderSceneToContext2D(options = {}) {
  const owner = options.owner || null;
  const ctx = options.ctx || null;
  const rect = resolveRect(options);
  if (!owner || !ctx || !rect?.w || !rect?.h) return false;

  const cacheKey = String(options.cacheKey || "scene");
  const entry = getRendererEntry(owner, cacheKey);
  const backgroundSource = options.backgroundSource || options.img || null;
  const scene = options.scene || { stickers: [], selectedId: null, hoveredId: null };
  const textures = Array.isArray(options.textures) ? options.textures : [];
  const view = options.view || { mode: "panorama", yawDeg: 0, pitchDeg: 0, fovDeg: 100 };
  if (!entry?.renderer) return false;
  const renderer = entry.renderer;
  const dpr = Math.max(1, Number(options.dpr || window.devicePixelRatio || 1));
  const backgroundRevision = options.backgroundRevision ?? imageRevisionKey(backgroundSource);
  const surface = renderer.renderScene({
    width: rect.w,
    height: rect.h,
    dpr,
    backgroundSource,
    backgroundRevision,
    textures,
    scene,
    view,
    backgroundOpacity: Number(options.backgroundOpacity ?? 1),
  });
  if (!surface) return false;
  ctx.drawImage(surface, rect.x, rect.y, rect.w, rect.h);
  return true;
}

export function renderErpViewToContext2D(options = {}) {
  return renderSceneToContext2D({
    ...options,
    cacheKey: options.cacheKey || options.mode || "erp_view",
    scene: { stickers: [], selectedId: null, hoveredId: null },
    textures: [],
    view: options.mode === "cutout"
      ? {
          mode: "cutout",
          yawDeg: Number(options.yawDeg || 0),
          pitchDeg: Number(options.pitchDeg || 0),
          rollDeg: Number(options.rollDeg || 0),
          hFovDeg: Number(options.hFovDeg || 90),
          vFovDeg: Number(options.vFovDeg || 60),
        }
      : options.mode === "unwrap"
        ? { mode: "unwrap" }
        : {
            mode: "panorama",
            yawDeg: Number(options.yawDeg || 0),
            pitchDeg: Number(options.pitchDeg || 0),
          fovDeg: Number(options.fovDeg || 100),
        },
  });
}

export function renderCutoutViewToContext2D(options = {}) {
  const view = options.view || {
    mode: "cutout",
    yawDeg: Number(options.yawDeg || 0),
    pitchDeg: Number(options.pitchDeg || 0),
    rollDeg: Number(options.rollDeg || 0),
    hFovDeg: Number(options.hFovDeg || 90),
    vFovDeg: Number(options.vFovDeg || 60),
  };
  return renderSceneToContext2D({
    ...options,
    cacheKey: options.cacheKey || "cutout_view",
    scene: { stickers: [], selectedId: null, hoveredId: null },
    textures: [],
    view,
  });
}
