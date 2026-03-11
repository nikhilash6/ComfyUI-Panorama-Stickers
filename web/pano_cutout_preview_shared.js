import { drawCutoutProjectionPreview } from "./pano_cutout_projection.js";
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

  return !!glDrawn || !!fallbackDrawn;
}
