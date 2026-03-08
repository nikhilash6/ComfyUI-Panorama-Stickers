import copy
import math


EMPTY_PAINTING_STATE = {
    "version": 1,
    "paint": {"strokes": []},
    "mask": {"strokes": []},
}

PAINT_TOOL_KINDS = {"pen", "marker", "brush", "eraser", "lasso_fill"}
MASK_TOOL_KINDS = {"pen", "eraser"}
GEOMETRY_KINDS = {"freehand_open", "freehand_closed", "lasso_fill"}


def empty_painting_state() -> dict:
    return copy.deepcopy(EMPTY_PAINTING_STATE)


def _finite_float(value):
    try:
        out = float(value)
    except Exception:
        return None
    if not math.isfinite(out):
        return None
    return out


def _finite_int(value):
    try:
        out = int(value)
    except Exception:
        return None
    return out


def _normalize_target_space(raw):
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind == "ERP_GLOBAL":
        return {"kind": "ERP_GLOBAL"}
    return None


def _normalize_target_point(raw, _target_space):
    if not isinstance(raw, dict):
        return None
    t = _finite_float(raw.get("t", 0.0))
    u = _finite_float(raw.get("u"))
    v = _finite_float(raw.get("v"))
    if t is None or u is None or v is None:
        return None
    u = float(u % 1.0)
    if abs(u - 1.0) < 1e-9:
        u = 0.0
    v = max(0.0, min(1.0, float(v)))
    out = {"targetKind": "ERP_GLOBAL", "u": u, "v": v, "t": float(t)}
    width_scale = _finite_float(raw.get("widthScale"))
    pressure_like = _finite_float(raw.get("pressureLike"))
    if width_scale is not None:
        out["widthScale"] = max(0.0, float(width_scale))
    if pressure_like is not None:
        out["pressureLike"] = max(0.0, float(pressure_like))
    return out


def _normalize_point_list(raw_points, target_space, min_points=1):
    if not isinstance(raw_points, list):
        return None
    out = []
    for item in raw_points:
        point = _normalize_target_point(item, target_space)
        if point is None:
            return None
        out.append(point)
    if len(out) < int(min_points):
        return None
    return out


def _normalize_geometry(raw, target_space, tool_kind, allow_lasso):
    if not isinstance(raw, dict):
        return None
    geometry_kind = str(raw.get("geometryKind") or "").strip()
    if geometry_kind not in GEOMETRY_KINDS:
        return None
    if geometry_kind == "lasso_fill":
        if tool_kind != "lasso_fill" or not allow_lasso:
            return None
        points = _normalize_point_list(raw.get("points"), target_space, min_points=3)
        if points is None:
            return None
        return {"geometryKind": "lasso_fill", "points": points}
    if geometry_kind not in {"freehand_open", "freehand_closed"}:
        return None
    if tool_kind in {"lasso_fill"}:
        return None
    points = _normalize_point_list(raw.get("points"), target_space, min_points=1)
    if points is None:
        return None
    raw_points = _normalize_point_list(raw.get("rawPoints"), target_space, min_points=1)
    processed_points = _normalize_point_list(raw.get("processedPoints"), target_space, min_points=1)
    return {
        "geometryKind": geometry_kind,
        "points": points,
        "rawPoints": raw_points if raw_points is not None else copy.deepcopy(points),
        "processedPoints": processed_points if processed_points is not None else copy.deepcopy(points),
    }


def _resolve_stroke_color(raw_color, layer_kind, tool_kind):
    """Return (color, is_valid). is_valid=False means color was required but missing."""
    if layer_kind == "mask":
        return None, True
    color = _normalize_color(raw_color, allow_color=True)
    if tool_kind != "eraser" and color is None:
        return None, False
    return color, True


def _normalize_stroke_scalars(raw):
    """Return (stroke_id, action_group_id, size, opacity, created_at) or None."""
    stroke_id = str(raw.get("id") or "").strip()
    action_group_id = str(raw.get("actionGroupId") or "").strip()
    if not stroke_id or not action_group_id:
        return None
    size = _finite_float(raw.get("size"))
    opacity = _finite_float(raw.get("opacity"))
    if size is None or opacity is None:
        return None
    created_at = _finite_int(raw.get("createdAt"))
    return stroke_id, action_group_id, size, opacity, 0 if created_at is None else created_at


def _normalize_color(raw, allow_color):
    if not allow_color:
        return None
    if not isinstance(raw, dict):
        return None
    r = _finite_float(raw.get("r"))
    g = _finite_float(raw.get("g"))
    b = _finite_float(raw.get("b"))
    a = _finite_float(raw.get("a"))
    if None in (r, g, b, a):
        return None
    return {
        "r": max(0.0, min(1.0, float(r))),
        "g": max(0.0, min(1.0, float(g))),
        "b": max(0.0, min(1.0, float(b))),
        "a": max(0.0, min(1.0, float(a))),
    }


def _normalize_stroke(raw, layer_kind):
    if not isinstance(raw, dict):
        return None
    if str(raw.get("layerKind") or "") != layer_kind:
        return None
    tool_kind = str(raw.get("toolKind") or "").strip()
    valid_tools = PAINT_TOOL_KINDS if layer_kind == "paint" else MASK_TOOL_KINDS
    if tool_kind not in valid_tools:
        return None
    target_space = _normalize_target_space(raw.get("targetSpace"))
    if target_space is None:
        return None
    geometry = _normalize_geometry(raw.get("geometry"), target_space, tool_kind, allow_lasso=(layer_kind == "paint"))
    if geometry is None:
        return None
    color, color_ok = _resolve_stroke_color(raw.get("color"), layer_kind, tool_kind)
    if not color_ok:
        return None
    scalars = _normalize_stroke_scalars(raw)
    if scalars is None:
        return None
    stroke_id, action_group_id, size, opacity, created_at = scalars
    radius_value = _finite_float(raw.get("radiusValue"))
    radius_model = str(raw.get("radiusModel") or "").strip() or None
    return {
        "id": stroke_id,
        "actionGroupId": action_group_id,
        "targetSpace": target_space,
        "layerKind": layer_kind,
        "toolKind": tool_kind,
        "brushPresetId": str(raw.get("brushPresetId") or "").strip() or None,
        "color": color,
        "size": max(0.0, float(size)),
        "opacity": max(0.0, min(1.0, float(opacity))),
        "hardness": _finite_float(raw.get("hardness")),
        "flow": _finite_float(raw.get("flow")),
        "spacing": _finite_float(raw.get("spacing")),
        "createdAt": int(created_at),
        "radiusModel": radius_model,
        "radiusValue": None if radius_value is None else max(0.0, float(radius_value)),
        "geometry": geometry,
    }


def _normalize_layer(raw, layer_kind):
    out = {"strokes": []}
    if not isinstance(raw, dict):
        return out
    strokes = raw.get("strokes")
    if not isinstance(strokes, list):
        return out
    for item in strokes:
        normalized = _normalize_stroke(item, layer_kind)
        if normalized is not None:
            out["strokes"].append(normalized)
    return out


def normalize_painting_state(raw) -> dict:
    out = empty_painting_state()
    if not isinstance(raw, dict):
        return out
    version = _finite_int(raw.get("version"))
    out["version"] = 1 if version is None else int(version)
    out["paint"] = _normalize_layer(raw.get("paint"), "paint")
    out["mask"] = _normalize_layer(raw.get("mask"), "mask")
    return out
