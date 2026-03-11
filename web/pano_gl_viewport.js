import { createPanoGlRenderer } from "./pano_gl_renderer.js";

const SHARED_RENDERER_KEY = "__shared_renderer";

function getRendererCache(owner) {
  if (!owner) return null;
  if (!owner.__panoGlViewportCache) owner.__panoGlViewportCache = new Map();
  return owner.__panoGlViewportCache;
}

function getRendererEntry(owner, key) {
  const cache = getRendererCache(owner);
  if (!cache) return null;
  let shared = cache.get(SHARED_RENDERER_KEY);
  if (!shared) {
    const renderer = createPanoGlRenderer();
    if (!renderer?.isSupported?.()) return null;
    shared = { renderer };
    cache.set(SHARED_RENDERER_KEY, shared);
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = { renderer: shared.renderer, lastRenderKey: null, cachedCanvas: null };
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

function viewRevisionKey(view) {
  const mode = String(view?.mode || "panorama");
  if (mode === "unwrap") return "unwrap";
  if (mode === "cutout") {
    return `c|${Number(view.yawDeg || 0).toFixed(4)}|${Number(view.pitchDeg || 0).toFixed(4)}|${Number(view.rollDeg || 0).toFixed(4)}|${Number(view.hFovDeg || 90).toFixed(4)}|${Number(view.vFovDeg || 60).toFixed(4)}`;
  }
  return `p|${Number(view.yawDeg || 0).toFixed(4)}|${Number(view.pitchDeg || 0).toFixed(4)}|${Number(view.fovDeg || 100).toFixed(4)}`;
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
  const hasExplicitBackgroundRevision = options.backgroundRevision != null;
  const isLiveBackgroundSource = (
    (typeof HTMLVideoElement !== "undefined" && backgroundSource instanceof HTMLVideoElement)
    || (typeof HTMLCanvasElement !== "undefined" && backgroundSource instanceof HTMLCanvasElement)
  );
  const backgroundRevision = hasExplicitBackgroundRevision
    ? String(options.backgroundRevision)
    : (isLiveBackgroundSource ? "" : imageRevisionKey(backgroundSource));
  const backgroundOpacity = Number(options.backgroundOpacity ?? 1);

  // Result cache: only applies when scene has no stickers and no textures (e.g. cutout/ERP
  // background-only renders). Sticker scenes are not cached because scene/texture state is not
  // included in the key and would produce stale hits when stickers change.
  const sceneIsEmpty = scene.stickers.length === 0 && textures.length === 0;
  const allowEmptySceneCache = sceneIsEmpty && (!!hasExplicitBackgroundRevision || !isLiveBackgroundSource);
  const renderKey = `${Math.round(rect.w)}x${Math.round(rect.h)}|${dpr}|${viewRevisionKey(view)}|${backgroundRevision}|${backgroundOpacity.toFixed(3)}`;
  if (allowEmptySceneCache && entry.lastRenderKey === renderKey && entry.cachedCanvas) {
    ctx.drawImage(entry.cachedCanvas, rect.x, rect.y, rect.w, rect.h);
    return true;
  }

  const surface = renderer.renderScene({
    width: rect.w,
    height: rect.h,
    dpr,
    backgroundSource,
    backgroundRevision,
    textures,
    scene,
    view,
    backgroundOpacity,
  });
  if (!surface) return false;

  // For empty scenes, copy the WebGL surface to a per-entry 2D cache canvas so subsequent hits
  // avoid the GPU pipeline. Must clearRect before drawImage: the WebGL surface has transparent
  // pixels where gl.clear() left rgba(0,0,0,0), and source-over drawImage would let stale pixels
  // from the previous render bleed through those transparent areas, accumulating across frames.
  if (allowEmptySceneCache) {
    const sw = surface.width;
    const sh = surface.height;
    if (!entry.cachedCanvas || entry.cachedCanvas.width !== sw || entry.cachedCanvas.height !== sh) {
      entry.cachedCanvas = document.createElement("canvas");
      entry.cachedCanvas.width = sw;
      entry.cachedCanvas.height = sh;
    }
    const cacheCtx = entry.cachedCanvas.getContext("2d");
    cacheCtx.clearRect(0, 0, sw, sh);
    cacheCtx.drawImage(surface, 0, 0);
    entry.lastRenderKey = renderKey;
  } else {
    entry.lastRenderKey = null;
  }

  ctx.drawImage(surface, rect.x, rect.y, rect.w, rect.h);
  return true;
}

export function renderErpViewToContext2D(options = {}) {
  let view;
  if (options.mode === "cutout") {
    view = {
      mode: "cutout",
      yawDeg: Number(options.yawDeg || 0),
      pitchDeg: Number(options.pitchDeg || 0),
      rollDeg: Number(options.rollDeg || 0),
      hFovDeg: Number(options.hFovDeg || 90),
      vFovDeg: Number(options.vFovDeg || 60),
    };
  } else if (options.mode === "unwrap") {
    view = { mode: "unwrap" };
  } else {
    view = {
      mode: "panorama",
      yawDeg: Number(options.yawDeg || 0),
      pitchDeg: Number(options.pitchDeg || 0),
      fovDeg: Number(options.fovDeg || 100),
    };
  }
  return renderSceneToContext2D({
    ...options,
    cacheKey: options.cacheKey || options.mode || "erp_view",
    scene: { stickers: [], selectedId: null, hoveredId: null },
    textures: [],
    view,
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
