import base64
import io
import math

import numpy as np
from PIL import Image, ImageDraw

from .cutout import cutout_from_erp
from .paint_state import normalize_painting_state


def _empty_rgba(width: int, height: int) -> np.ndarray:
    return np.zeros((max(1, height), max(1, width), 4), dtype=np.float32)


def _empty_mask(width: int, height: int) -> np.ndarray:
    return np.zeros((max(1, height), max(1, width)), dtype=np.float32)


def _stroke_color_rgba(stroke: dict) -> tuple[int, int, int, int]:
    color = stroke.get("color") or {}
    return (
        int(max(0.0, min(1.0, float(color.get("r", 0.0)))) * 255.0),
        int(max(0.0, min(1.0, float(color.get("g", 0.0)))) * 255.0),
        int(max(0.0, min(1.0, float(color.get("b", 0.0)))) * 255.0),
        int(max(0.0, min(1.0, float(color.get("a", 1.0)))) * max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))) * 255.0),
    )


def _stroke_width_px(stroke: dict, width: int, height: int) -> int:
    # radiusValue is stored as ERP-normalised radius (fraction of ERP width).
    # JS sets it to  size * 0.5 / 2048.  Pixel diameter = radiusValue * 2 * output_width.
    radius_value = stroke.get("radiusValue")
    if radius_value is not None:
        try:
            rv = float(radius_value)
            if rv > 0:
                return max(1, int(round(rv * 2.0 * width)))
        except (TypeError, ValueError):
            pass
    # Fallback for strokes that pre-date radiusValue
    base = max(1.0, float(stroke.get("size", 1.0)))
    scale = max(1.0, min(width, height) / 512.0)
    return max(1, int(round(base * scale)))


def _mask_fill_value(stroke: dict) -> int:
    if str(stroke.get("toolKind") or "") == "eraser":
        return 0
    return int(max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))) * 255.0)


def _paint_draw_color(stroke: dict):
    if str(stroke.get("toolKind") or "") == "eraser":
        return (0, 0, 0, 0)
    return _stroke_color_rgba(stroke)


def _unwrap_erp_points(points: list[dict]) -> list[list[dict]]:
    if not points:
        return []
    group = [dict(points[0])]
    offset = 0.0
    out = []
    prev_u = float(points[0]["u"])
    for point in points[1:]:
        cur_u = float(point["u"])
        delta = cur_u - prev_u
        if delta > 0.5:
            offset -= 1.0
        elif delta < -0.5:
            offset += 1.0
        next_point = dict(point)
        next_point["u"] = cur_u + offset
        group.append(next_point)
        prev_u = cur_u
    out.append(group)
    return out


def _catmull_rom_resample(coords: list[tuple[float, float]], spacing: float = 2.0) -> list[tuple[float, float]]:
    """Densify a polyline via Catmull-Rom spline so PIL draws smooth curves."""
    n = len(coords)
    if n < 2:
        return coords
    # Phantom end-points mirror the first/last segment.
    pts = [
        (2 * coords[0][0] - coords[1][0], 2 * coords[0][1] - coords[1][1]),
        *coords,
        (2 * coords[-1][0] - coords[-2][0], 2 * coords[-1][1] - coords[-2][1]),
    ]
    out: list[tuple[float, float]] = [coords[0]]
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        seg_len = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
        steps = max(1, int(math.ceil(seg_len / max(spacing, 0.5))))
        for j in range(1, steps + 1):
            t = j / steps
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * (
                2 * p1[0]
                + (-p0[0] + p2[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                2 * p1[1]
                + (-p0[1] + p2[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
            )
            out.append((x, y))
    return out


def _stroke_segments_for_erp_geometry(stroke: dict, width: int, height: int) -> list[list[tuple[float, float]]]:
    geometry = stroke.get("geometry") or {}
    kind = str(geometry.get("geometryKind") or "")
    if kind not in {"freehand_open", "freehand_closed", "lasso_fill"}:
        return []
    # ADR 0006: processedPoints is the durable dense point list written by JS on commit.
    # Fall back to points (= rawPoints) with Catmull-Rom densification for old strokes.
    processed = geometry.get("processedPoints")
    raw = geometry.get("points") or []
    use_processed = isinstance(processed, list) and len(processed) >= 1
    source_points = processed if use_processed else raw
    segments = []
    for group in _unwrap_erp_points(source_points):
        coords = [(float(pt["u"]) * width, float(pt["v"]) * height) for pt in group]
        shift_neg = [((float(pt["u"]) - 1.0) * width, float(pt["v"]) * height) for pt in group]
        shift_pos = [((float(pt["u"]) + 1.0) * width, float(pt["v"]) * height) for pt in group]
        if not use_processed and kind in {"freehand_open", "freehand_closed"} and len(coords) >= 2:
            # Old strokes without processedPoints: densify via Catmull-Rom as fallback.
            brush_px = _stroke_width_px(stroke, width, height)
            spacing = max(1.0, brush_px * 0.5)
            coords = _catmull_rom_resample(coords, spacing)
            shift_neg = _catmull_rom_resample(shift_neg, spacing)
            shift_pos = _catmull_rom_resample(shift_pos, spacing)
        segments.append(coords)
        segments.append(shift_neg)
        segments.append(shift_pos)
    return segments


def _stroke_point_paths_for_erp_geometry(stroke: dict) -> list[list[dict]]:
    geometry = stroke.get("geometry") or {}
    kind = str(geometry.get("geometryKind") or "")
    if kind not in {"freehand_open", "freehand_closed"}:
        return []
    processed = geometry.get("processedPoints")
    raw = geometry.get("points") or []
    source_points = processed if isinstance(processed, list) and len(processed) >= 1 else raw
    return _unwrap_erp_points(source_points)


def _stroke_radius_px(stroke: dict, width: int, height: int) -> float:
    return max(0.5, _stroke_width_px(stroke, width, height) * 0.5)


def _stroke_spacing_px(stroke: dict, radius_px: float) -> float:
    spacing = stroke.get("spacing")
    try:
        spacing_val = float(spacing)
        if spacing_val > 0:
            return max(1.0, spacing_val * radius_px * 2.0)
    except (TypeError, ValueError):
        pass
    tool_kind = str(stroke.get("toolKind") or "pen")
    fraction = 0.15 if tool_kind in {"brush", "eraser"} else 0.2
    return max(1.0, fraction * radius_px * 2.0)


_STAMP_ALPHA_CACHE: dict[tuple, np.ndarray] = {}


def _cached_stamp_alpha(cache_key: tuple, builder):
    stamp = _STAMP_ALPHA_CACHE.get(cache_key)
    if stamp is not None:
        return stamp
    stamp = builder()
    if len(_STAMP_ALPHA_CACHE) >= 128:
        _STAMP_ALPHA_CACHE.pop(next(iter(_STAMP_ALPHA_CACHE)))
    _STAMP_ALPHA_CACHE[cache_key] = stamp
    return stamp


def _build_round_stamp_alpha(radius_px: float, hardness: float, aspect: float = 1.0, angle_rad: float = 0.0) -> np.ndarray:
    rx = max(1.0, float(radius_px) * max(0.1, float(aspect)))
    ry = max(1.0, float(radius_px))
    pad = 1.0
    half_w = int(math.ceil(rx + pad))
    half_h = int(math.ceil(ry + pad))
    yy, xx = np.mgrid[-half_h:half_h + 1, -half_w:half_w + 1].astype(np.float32)
    if abs(angle_rad) > 1e-6:
        ca = math.cos(angle_rad)
        sa = math.sin(angle_rad)
        xr = xx * ca + yy * sa
        yr = -xx * sa + yy * ca
    else:
        xr = xx
        yr = yy
    dist = np.sqrt((xr / rx) ** 2 + (yr / ry) ** 2)
    inner = max(0.0, min(1.0, float(hardness)))
    alpha = np.zeros_like(dist, dtype=np.float32)
    alpha[dist <= inner] = 1.0
    feather = (dist > inner) & (dist < 1.0)
    denom = max(1e-6, 1.0 - inner)
    alpha[feather] = 1.0 - ((dist[feather] - inner) / denom)
    return np.clip(alpha, 0.0, 1.0)


def _build_chisel_stamp_alpha(radius_px: float, hardness: float, aspect: float = 1.0, angle_rad: float = 0.0) -> np.ndarray:
    ry = max(1.0, float(radius_px))
    rx = max(ry, float(radius_px) * max(1.0, float(aspect)))
    pad = 1.0
    half_w = int(math.ceil(rx + pad))
    half_h = int(math.ceil(ry + pad))
    yy, xx = np.mgrid[-half_h:half_h + 1, -half_w:half_w + 1].astype(np.float32)
    if abs(angle_rad) > 1e-6:
        ca = math.cos(angle_rad)
        sa = math.sin(angle_rad)
        xr = xx * ca + yy * sa
        yr = -xx * sa + yy * ca
    else:
        xr = xx
        yr = yy
    half_flat = max(0.0, rx - ry)
    qx = np.maximum(np.abs(xr) - half_flat, 0.0)
    qy = np.abs(yr)
    dist = np.sqrt(qx * qx + qy * qy) / max(ry, 1e-6)
    inner = max(0.0, min(1.0, float(hardness)))
    alpha = np.zeros_like(dist, dtype=np.float32)
    alpha[dist <= inner] = 1.0
    feather = (dist > inner) & (dist < 1.0)
    denom = max(1e-6, 1.0 - inner)
    alpha[feather] = 1.0 - ((dist[feather] - inner) / denom)
    return np.clip(alpha, 0.0, 1.0)


def _get_stamp_alpha(stroke: dict, radius_px: float) -> np.ndarray:
    stamp_kind = str(stroke.get("stampKind") or "round")
    hardness = max(0.0, min(1.0, float(stroke.get("hardness", 0.9))))
    aspect = max(0.1, float(stroke.get("aspect", 1.0)))
    angle = stroke.get("angle") or {}
    angle_rad = float(angle.get("value", 0.0)) if str(angle.get("kind") or "fixed") == "fixed" else 0.0
    if stamp_kind == "chisel":
        key = ("chisel", round(radius_px, 2), round(hardness, 2), round(aspect, 2), round(angle_rad, 4))
        return _cached_stamp_alpha(key, lambda: _build_chisel_stamp_alpha(radius_px, hardness, aspect, angle_rad))
    key = ("round", stamp_kind, round(radius_px, 2), round(hardness, 2), round(aspect, 2), round(angle_rad, 4))
    return _cached_stamp_alpha(key, lambda: _build_round_stamp_alpha(radius_px, hardness, aspect, angle_rad))


def _blend_alpha_mask(dst: np.ndarray, src_alpha: np.ndarray, left: int, top: int):
    h, w = dst.shape[:2]
    sh, sw = src_alpha.shape[:2]
    x0 = max(0, int(left))
    y0 = max(0, int(top))
    x1 = min(w, int(left) + sw)
    y1 = min(h, int(top) + sh)
    if x0 >= x1 or y0 >= y1:
        return
    sx0 = x0 - int(left)
    sy0 = y0 - int(top)
    sx1 = sx0 + (x1 - x0)
    sy1 = sy0 + (y1 - y0)
    src = np.clip(src_alpha[sy0:sy1, sx0:sx1], 0.0, 1.0)
    region = dst[y0:y1, x0:x1]
    region[...] = src + region * (1.0 - src)


def _composite_color_layer(dst: np.ndarray, stroke_alpha: np.ndarray, color_rgb: np.ndarray, opacity: float):
    src_a = np.clip(stroke_alpha * max(0.0, min(1.0, float(opacity))), 0.0, 1.0)
    if not np.any(src_a > 1e-6):
        return
    dst[..., :3] = color_rgb[None, None, :] * src_a[..., None] + dst[..., :3] * (1.0 - src_a[..., None])
    dst[..., 3] = src_a + dst[..., 3] * (1.0 - src_a)


def _erase_from_rgba(dst: np.ndarray, erase_alpha: np.ndarray):
    erase = 1.0 - np.clip(erase_alpha, 0.0, 1.0)
    dst[..., :3] *= erase[..., None]
    dst[..., 3] *= erase


def _composite_mask_layer(dst: np.ndarray, stroke_alpha: np.ndarray, opacity: float):
    src_a = np.clip(stroke_alpha * max(0.0, min(1.0, float(opacity))), 0.0, 1.0)
    dst[...] = src_a + dst * (1.0 - src_a)


def _erase_from_mask(dst: np.ndarray, erase_alpha: np.ndarray):
    dst[...] = dst * (1.0 - np.clip(erase_alpha, 0.0, 1.0))


def _stamp_positions_for_path(coords: list[tuple[float, float]], spacing_px: float) -> list[tuple[float, float]]:
    if not coords:
        return []
    out = [coords[0]]
    dist_since = 0.0
    for i in range(1, len(coords)):
        ax, ay = coords[i - 1]
        bx, by = coords[i]
        dx = bx - ax
        dy = by - ay
        seg_len = math.hypot(dx, dy)
        if seg_len < 1e-6:
            continue
        ux = dx / seg_len
        uy = dy / seg_len
        to_next = spacing_px - dist_since
        while to_next <= seg_len + 1e-6:
            out.append((ax + ux * to_next, ay + uy * to_next))
            to_next += spacing_px
        dist_since = seg_len - (to_next - spacing_px)
    return out


def _stroke_freehand_alpha(stroke: dict, width: int, height: int) -> np.ndarray:
    radius_px = _stroke_radius_px(stroke, width, height)
    spacing_px = _stroke_spacing_px(stroke, radius_px)
    base_alpha = _get_stamp_alpha(stroke, radius_px)
    stamp_alpha = np.clip(base_alpha * max(0.0, min(1.0, float(stroke.get("flow", 1.0)))), 0.0, 1.0)
    stroke_alpha = np.zeros((height, width), dtype=np.float32)
    half_h = stamp_alpha.shape[0] // 2
    half_w = stamp_alpha.shape[1] // 2
    for group in _stroke_point_paths_for_erp_geometry(stroke):
        coords = [(float(pt["u"]) * width, float(pt["v"]) * height) for pt in group]
        for x, y in _stamp_positions_for_path(coords, spacing_px):
            left = int(round(x)) - half_w
            top = int(round(y)) - half_h
            _blend_alpha_mask(stroke_alpha, stamp_alpha, left, top)
            _blend_alpha_mask(stroke_alpha, stamp_alpha, left - width, top)
            _blend_alpha_mask(stroke_alpha, stamp_alpha, left + width, top)
    return stroke_alpha


def _polygon_alpha_mask(segments: list[list[tuple[float, float]]], width: int, height: int) -> np.ndarray:
    img = Image.new("L", (max(1, width), max(1, height)), 0)
    draw = ImageDraw.Draw(img, "L")
    for coords in segments:
        if len(coords) >= 3:
            draw.polygon(coords, fill=255, outline=255)
    return np.asarray(img, dtype=np.float32) / 255.0


def _draw_stroke_rgba(draw: ImageDraw.ImageDraw, stroke: dict, segments: list[list[tuple[float, float]]], width: int):
    kind = str((stroke.get("geometry") or {}).get("geometryKind") or "")
    fill = _paint_draw_color(stroke)
    if fill[3] <= 0 and str(stroke.get("toolKind") or "") != "eraser":
        return
    brush_width = _stroke_width_px(stroke, width, width)
    for coords in segments:
        if not coords:
            continue
        if kind in {"rect_fill", "lasso_fill", "freehand_closed"} and len(coords) >= 3:
            draw.polygon(coords, fill=fill, outline=fill)
            continue
        if len(coords) == 1:
            x, y = coords[0]
            draw.ellipse((x - brush_width * 0.5, y - brush_width * 0.5, x + brush_width * 0.5, y + brush_width * 0.5), fill=fill)
            continue
        draw.line(coords, fill=fill, width=brush_width, joint="curve")


def _draw_stroke_mask(draw: ImageDraw.ImageDraw, stroke: dict, segments: list[list[tuple[float, float]]], width: int):
    kind = str((stroke.get("geometry") or {}).get("geometryKind") or "")
    fill = _mask_fill_value(stroke)
    brush_width = _stroke_width_px(stroke, width, width)
    for coords in segments:
        if not coords:
            continue
        if kind in {"rect_fill", "lasso_fill", "freehand_closed"} and len(coords) >= 3:
            draw.polygon(coords, fill=fill, outline=fill)
            continue
        if len(coords) == 1:
            x, y = coords[0]
            draw.ellipse((x - brush_width * 0.5, y - brush_width * 0.5, x + brush_width * 0.5, y + brush_width * 0.5), fill=fill)
            continue
        draw.line(coords, fill=fill, width=brush_width, joint="curve")


def render_painting_to_erp(painting_state: dict, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    normalized = normalize_painting_state(painting_state)
    paint = _empty_rgba(width, height)
    mask = _empty_mask(width, height)

    for stroke in normalized["paint"]["strokes"]:
        if (stroke.get("targetSpace") or {}).get("kind") != "ERP_GLOBAL":
            continue
        geometry_kind = str((stroke.get("geometry") or {}).get("geometryKind") or "")
        tool_kind = str(stroke.get("toolKind") or "")
        if geometry_kind == "lasso_fill":
            segments = _stroke_segments_for_erp_geometry(stroke, width, height)
            alpha = _polygon_alpha_mask(segments, width, height)
            color = stroke.get("color") or {}
            color_rgb = np.array([
                max(0.0, min(1.0, float(color.get("r", 0.0)))),
                max(0.0, min(1.0, float(color.get("g", 0.0)))),
                max(0.0, min(1.0, float(color.get("b", 0.0)))),
            ], dtype=np.float32)
            color_alpha = max(0.0, min(1.0, float(color.get("a", 1.0))))
            _composite_color_layer(paint, alpha * color_alpha, color_rgb, max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))))
            continue
        stroke_alpha = _stroke_freehand_alpha(stroke, width, height)
        if tool_kind == "eraser":
            _erase_from_rgba(paint, stroke_alpha)
            continue
        color = stroke.get("color") or {}
        color_rgb = np.array([
            max(0.0, min(1.0, float(color.get("r", 0.0)))),
            max(0.0, min(1.0, float(color.get("g", 0.0)))),
            max(0.0, min(1.0, float(color.get("b", 0.0)))),
        ], dtype=np.float32)
        color_alpha = max(0.0, min(1.0, float(color.get("a", 1.0))))
        _composite_color_layer(paint, stroke_alpha * color_alpha, color_rgb, max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))))

    for stroke in normalized["mask"]["strokes"]:
        if (stroke.get("targetSpace") or {}).get("kind") != "ERP_GLOBAL":
            continue
        geometry_kind = str((stroke.get("geometry") or {}).get("geometryKind") or "")
        tool_kind = str(stroke.get("toolKind") or "")
        if geometry_kind == "lasso_fill":
            segments = _stroke_segments_for_erp_geometry(stroke, width, height)
            alpha = _polygon_alpha_mask(segments, width, height)
            if tool_kind == "eraser":
                _erase_from_mask(mask, alpha)
            else:
                _composite_mask_layer(mask, alpha, max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))))
            continue
        stroke_alpha = _stroke_freehand_alpha(stroke, width, height)
        if tool_kind == "eraser":
            _erase_from_mask(mask, stroke_alpha)
        else:
            _composite_mask_layer(mask, stroke_alpha, max(0.0, min(1.0, float(stroke.get("opacity", 1.0)))))

    return np.clip(paint, 0.0, 1.0).astype(np.float32), np.clip(mask, 0.0, 1.0).astype(np.float32)


def _warp_erp_layer_to_cutout(erp_layer: np.ndarray, shot: dict, width: int, height: int) -> np.ndarray:
    yaw = float(shot.get("yaw_deg", 0.0))
    pitch = float(shot.get("pitch_deg", 0.0))
    roll = float(shot.get("roll_deg", 0.0))
    h_fov = max(0.1, float(shot.get("hFOV_deg", 90.0)))
    v_fov = max(0.1, float(shot.get("vFOV_deg", 60.0)))
    if erp_layer.ndim == 2:
        rgb = np.repeat(np.clip(erp_layer[..., None].astype(np.float32), 0.0, 1.0), 3, axis=2)
        warped = cutout_from_erp(rgb, yaw, pitch, h_fov, v_fov, roll, width, height)
        return np.clip(warped[..., 0], 0.0, 1.0).astype(np.float32)
    if erp_layer.ndim == 3 and erp_layer.shape[2] in {3, 4}:
        src = np.clip(erp_layer[..., :3].astype(np.float32), 0.0, 1.0)
        if erp_layer.shape[2] == 4:
            alpha = np.clip(erp_layer[..., 3].astype(np.float32), 0.0, 1.0)
            premult = src * alpha[..., None]
            warped_premult = cutout_from_erp(premult, yaw, pitch, h_fov, v_fov, roll, width, height)
            warped_alpha = _warp_erp_layer_to_cutout(alpha, shot, width, height)
            safe_alpha = np.maximum(warped_alpha[..., None], 1e-6)
            warped_rgb = np.where(warped_alpha[..., None] > 1e-6, warped_premult / safe_alpha, 0.0)
            return np.dstack([np.clip(warped_rgb, 0.0, 1.0), np.clip(warped_alpha, 0.0, 1.0)]).astype(np.float32)
        warped_rgb = cutout_from_erp(src, yaw, pitch, h_fov, v_fov, roll, width, height)
        return np.clip(warped_rgb, 0.0, 1.0).astype(np.float32)
    return _empty_rgba(width, height) if erp_layer.ndim == 3 else _empty_mask(width, height)


def _decode_raster_dataurl(asset: dict | None, *, want_mask: bool = False) -> np.ndarray | None:
    if not isinstance(asset, dict):
        return None
    if str(asset.get("type") or "").strip().lower() != "dataurl":
        return None
    value = str(asset.get("value") or "")
    if not value.startswith("data:image") or "," not in value:
        return None
    try:
        raw = base64.b64decode(value.split(",", 1)[1])
        img = Image.open(io.BytesIO(raw))
        if want_mask:
            rgba = img.convert("RGBA")
            arr = np.asarray(rgba, dtype=np.float32) / 255.0
            alpha = arr[..., 3]
            rgb = arr[..., :3].max(axis=-1)
            return np.maximum(alpha, rgb).astype(np.float32)
        return np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
    except Exception:
        return None


def _render_snapshot_to_cutout(painting_raster: dict | None, shot: dict, width: int, height: int) -> tuple[np.ndarray, np.ndarray] | None:
    if not isinstance(painting_raster, dict):
        return None
    paint_src = _decode_raster_dataurl(painting_raster.get("paint"), want_mask=False)
    mask_src = _decode_raster_dataurl(painting_raster.get("mask"), want_mask=True)
    if paint_src is None and mask_src is None:
        return None
    paint = _warp_erp_layer_to_cutout(paint_src, shot, width, height) if paint_src is not None else _empty_rgba(width, height)
    mask = _warp_erp_layer_to_cutout(mask_src, shot, width, height) if mask_src is not None else _empty_mask(width, height)
    return paint, mask


def render_painting_to_cutout(
    painting_state: dict,
    shot: dict,
    width: int,
    height: int,
    *,
    erp_width: int = 2048,
    erp_height: int = 1024,
    painting_raster: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    snapshot = _render_snapshot_to_cutout(painting_raster, shot, width, height)
    if snapshot is not None:
        return snapshot
    erp_width = max(64, int(erp_width))
    erp_height = max(32, int(erp_height))
    paint_erp, mask_erp = render_painting_to_erp(painting_state, erp_width, erp_height)
    paint = _warp_erp_layer_to_cutout(paint_erp, shot, width, height)
    mask = _warp_erp_layer_to_cutout(mask_erp, shot, width, height)
    return paint, mask


def alpha_composite_over_rgb(base_rgb: np.ndarray, paint_rgba: np.ndarray) -> np.ndarray:
    if base_rgb is None:
        return _empty_rgba(paint_rgba.shape[1], paint_rgba.shape[0])[..., :3]
    src = np.clip(base_rgb.astype(np.float32), 0.0, 1.0)
    overlay = np.clip(paint_rgba.astype(np.float32), 0.0, 1.0)
    alpha = overlay[..., 3:4]
    out = overlay[..., :3] * alpha + src * (1.0 - alpha)
    return np.clip(out, 0.0, 1.0).astype(np.float32)
