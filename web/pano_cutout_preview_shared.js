import { drawCutoutProjectionPreview } from "./pano_cutout_projection.js";
import { renderCutoutViewToContext2D } from "./pano_gl_viewport.js";
import { buildCutoutViewParamsFromShot } from "./pano_gl_scene.js";

export function renderSharedCutoutPreview(options = {}) {
  const {
    owner = null,
    ctx = null,
    rect = null,
    shot = null,
    bgImage = null,
    cachePrefix = "cutout_preview",
    quality = "balanced",
    paintCanvas = null,
    paintRevision = "",
    drawDisplayList = null,
  } = options;

  if (!ctx || !rect || !shot) return false;
  const cutoutView = buildCutoutViewParamsFromShot(shot);
  const glDrawn = typeof drawDisplayList === "function"
    ? !!drawDisplayList(ctx, rect, cutoutView, bgImage, String(cachePrefix || "cutout_preview"))
    : false;
  const fallbackDrawn = !glDrawn
    && !!bgImage
    && !!drawCutoutProjectionPreview(
      ctx,
      owner,
      bgImage,
      rect,
      shot,
      String(quality || "balanced"),
    );

  if (paintCanvas) {
    renderCutoutViewToContext2D({
      owner,
      cacheKey: `${String(cachePrefix || "cutout_preview")}_paint`,
      ctx,
      rect,
      img: paintCanvas,
      view: cutoutView,
      backgroundRevision: String(paintRevision || ""),
      backgroundOpacity: 1,
    });
  }

  return !!glDrawn || !!fallbackDrawn || !!paintCanvas;
}
