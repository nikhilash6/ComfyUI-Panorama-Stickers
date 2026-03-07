import math

import numpy as np
from PIL import Image, ImageDraw

from .math import DEG2RAD, orthonormal_basis_from_forward, yaw_pitch_to_dir
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


def _erp_point_to_canvas(point: dict, width: int, height: int) -> tuple[float, float]:
    return float(point["u"]) * float(width), float(point["v"]) * float(height)


def _frame_point_to_canvas(point: dict, width: int, height: int) -> tuple[float, float]:
    return float(point["x"]) * float(width), float(point["y"]) * float(height)


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


def _stroke_segments_for_erp_geometry(stroke: dict, width: int, height: int) -> list[list[tuple[float, float]]]:
    geometry = stroke.get("geometry") or {}
    kind = str(geometry.get("geometryKind") or "")
    if kind == "rect_fill":
        p0 = geometry["p0"]
        p1 = geometry["p1"]
        x0 = min(float(p0["u"]), float(p1["u"]))
        x1 = max(float(p0["u"]), float(p1["u"]))
        y0 = min(float(p0["v"]), float(p1["v"]))
        y1 = max(float(p0["v"]), float(p1["v"]))
        if x1 - x0 > 0.5:
            return [
                [(x0 * width, y0 * height), (width, y0 * height), (width, y1 * height), (x0 * width, y1 * height)],
                [(0.0, y0 * height), (x1 * width, y0 * height), (x1 * width, y1 * height), (0.0, y1 * height)],
            ]
        return [[(x0 * width, y0 * height), (x1 * width, y0 * height), (x1 * width, y1 * height), (x0 * width, y1 * height)]]
    if kind in {"freehand_open", "freehand_closed", "lasso_fill"}:
        points = geometry.get("points") or []
        segments = []
        for group in _unwrap_erp_points(points):
            coords = [((float(pt["u"]) % 1.0) * width, float(pt["v"]) * height) for pt in group]
            segments.append(coords)
            shifted_left = [(((float(pt["u"]) - 1.0) % 1.0) * width, float(pt["v"]) * height) for pt in group]
            shifted_right = [(((float(pt["u"]) + 1.0) % 1.0) * width, float(pt["v"]) * height) for pt in group]
            segments.append(shifted_left)
            segments.append(shifted_right)
        return segments
    return []


def _dir_from_erp_point(point: dict) -> np.ndarray:
    lon = (float(point["u"]) - 0.5) * (2.0 * math.pi)
    lat = (0.5 - float(point["v"])) * math.pi
    cp = math.cos(lat)
    return np.array([cp * math.sin(lon), math.sin(lat), cp * math.cos(lon)], dtype=np.float32)


def _project_dir_to_cutout(dir_vec: np.ndarray, shot: dict) -> tuple[float, float] | None:
    yaw = float(shot.get("yaw_deg", 0.0))
    pitch = float(shot.get("pitch_deg", 0.0))
    roll = float(shot.get("roll_deg", 0.0))
    h_fov = max(0.1, float(shot.get("hFOV_deg", 90.0)))
    v_fov = max(0.1, float(shot.get("vFOV_deg", 60.0)))
    forward = yaw_pitch_to_dir(yaw, pitch)
    right, up, fwd = orthonormal_basis_from_forward(forward)
    z = float(np.dot(dir_vec, fwd))
    if z <= 1e-6:
        return None
    local_x = float(np.dot(dir_vec, right) / z)
    local_y = float(np.dot(dir_vec, up) / z)
    rr = -roll * DEG2RAD
    cr = math.cos(rr)
    sr = math.sin(rr)
    xr = local_x * cr - local_y * sr
    yr = local_x * sr + local_y * cr
    nx = xr / max(math.tan(h_fov * 0.5 * DEG2RAD), 1e-6)
    ny = yr / max(math.tan(v_fov * 0.5 * DEG2RAD), 1e-6)
    return nx * 0.5 + 0.5, 0.5 - ny * 0.5


def _stroke_segments_for_cutout_geometry(stroke: dict, width: int, height: int, shot: dict) -> list[list[tuple[float, float]]]:
    geometry = stroke.get("geometry") or {}
    target_space = stroke.get("targetSpace") or {}
    kind = str(geometry.get("geometryKind") or "")
    if target_space.get("kind") == "FRAME_LOCAL":
        if str(target_space.get("frameId") or "") != str(shot.get("id") or ""):
            return []

        def pt_canvas(point):
            return _frame_point_to_canvas(point, width, height)

        if kind == "rect_fill":
            p0 = geometry["p0"]
            p1 = geometry["p1"]
            x0 = min(float(p0["x"]), float(p1["x"])) * width
            x1 = max(float(p0["x"]), float(p1["x"])) * width
            y0 = min(float(p0["y"]), float(p1["y"])) * height
            y1 = max(float(p0["y"]), float(p1["y"])) * height
            return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
        points = geometry.get("points") or []
        return [[pt_canvas(point) for point in points]]

    def project_point(point):
        projected = _project_dir_to_cutout(_dir_from_erp_point(point), shot)
        if projected is None:
            return None
        return projected[0] * width, projected[1] * height

    if kind == "rect_fill":
        p0 = project_point(geometry["p0"])
        p1 = project_point(geometry["p1"])
        if p0 is None or p1 is None:
            return []
        x0 = min(p0[0], p1[0])
        x1 = max(p0[0], p1[0])
        y0 = min(p0[1], p1[1])
        y1 = max(p0[1], p1[1])
        return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]]
    points = geometry.get("points") or []
    coords = []
    for point in points:
        projected = project_point(point)
        if projected is None:
            if len(coords) >= 2:
                break
            continue
        coords.append(projected)
    return [coords] if len(coords) >= 1 else []


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
    rgba_img = Image.new("RGBA", (max(1, width), max(1, height)), (0, 0, 0, 0))
    mask_img = Image.new("L", (max(1, width), max(1, height)), 0)
    paint_draw = ImageDraw.Draw(rgba_img, "RGBA")
    mask_draw = ImageDraw.Draw(mask_img, "L")

    for stroke in normalized["paint"]["strokes"]:
        if (stroke.get("targetSpace") or {}).get("kind") != "ERP_GLOBAL":
            continue
        segments = _stroke_segments_for_erp_geometry(stroke, width, height)
        _draw_stroke_rgba(paint_draw, stroke, segments, width)
    for stroke in normalized["mask"]["strokes"]:
        if (stroke.get("targetSpace") or {}).get("kind") != "ERP_GLOBAL":
            continue
        segments = _stroke_segments_for_erp_geometry(stroke, width, height)
        _draw_stroke_mask(mask_draw, stroke, segments, width)

    paint = np.asarray(rgba_img, dtype=np.float32) / 255.0
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0
    return paint, mask


def render_painting_to_cutout(painting_state: dict, shot: dict, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    normalized = normalize_painting_state(painting_state)
    rgba_img = Image.new("RGBA", (max(1, width), max(1, height)), (0, 0, 0, 0))
    mask_img = Image.new("L", (max(1, width), max(1, height)), 0)
    paint_draw = ImageDraw.Draw(rgba_img, "RGBA")
    mask_draw = ImageDraw.Draw(mask_img, "L")

    for stroke in normalized["paint"]["strokes"]:
        segments = _stroke_segments_for_cutout_geometry(stroke, width, height, shot)
        _draw_stroke_rgba(paint_draw, stroke, segments, width)
    for stroke in normalized["mask"]["strokes"]:
        segments = _stroke_segments_for_cutout_geometry(stroke, width, height, shot)
        _draw_stroke_mask(mask_draw, stroke, segments, width)

    paint = np.asarray(rgba_img, dtype=np.float32) / 255.0
    mask = np.asarray(mask_img, dtype=np.float32) / 255.0
    return paint, mask


def alpha_composite_over_rgb(base_rgb: np.ndarray, paint_rgba: np.ndarray) -> np.ndarray:
    if base_rgb is None:
        return _empty_rgba(paint_rgba.shape[1], paint_rgba.shape[0])[..., :3]
    src = np.clip(base_rgb.astype(np.float32), 0.0, 1.0)
    overlay = np.clip(paint_rgba.astype(np.float32), 0.0, 1.0)
    alpha = overlay[..., 3:4]
    out = overlay[..., :3] * alpha + src * (1.0 - alpha)
    return np.clip(out, 0.0, 1.0).astype(np.float32)
