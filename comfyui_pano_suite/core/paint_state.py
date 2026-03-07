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
    if kind == "FRAME_LOCAL":
        frame_id = str(raw.get("frameId") or "").strip()
        if not frame_id:
            return None
        return {"kind": "FRAME_LOCAL", "frameId": frame_id}
    return None


def _normalize_target_point(raw, target_space):
    if not isinstance(raw, dict) or not isinstance(target_space, dict):
        return None
    t = _finite_float(raw.get("t", 0.0))
    if t is None:
        return None
    width_scale = _finite_float(raw.get("widthScale"))
    pressure_like = _finite_float(raw.get("pressureLike"))
    if target_space["kind"] == "ERP_GLOBAL":
        u = _finite_float(raw.get("u"))
        v = _finite_float(raw.get("v"))
        if u is None or v is None:
            return None
        u = float(u % 1.0)
        if abs(u - 1.0) < 1e-9:
            u = 0.0
        v = max(0.0, min(1.0, float(v)))
        out = {"targetKind": "ERP_GLOBAL", "u": u, "v": v, "t": float(t)}
        if width_scale is not None:
            out["widthScale"] = max(0.0, float(width_scale))
        if pressure_like is not None:
            out["pressureLike"] = max(0.0, float(pressure_like))
        return out
    x = _finite_float(raw.get("x"))
    y = _finite_float(raw.get("y"))
    if x is None or y is None:
        return None
    frame_id = str(raw.get("frameId") or target_space.get("frameId") or "").strip()
    if frame_id != str(target_space.get("frameId") or "").strip():
        return None
    out = {
        "targetKind": "FRAME_LOCAL",
        "frameId": frame_id,
        "x": float(x),
        "y": float(y),
        "t": float(t),
    }
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
    if layer_kind == "paint":
        if tool_kind not in PAINT_TOOL_KINDS:
            return None
    else:
        if tool_kind not in MASK_TOOL_KINDS:
            return None
    target_space = _normalize_target_space(raw.get("targetSpace"))
    if target_space is None:
        return None
    geometry = _normalize_geometry(raw.get("geometry"), target_space, tool_kind, allow_lasso=(layer_kind == "paint"))
    if geometry is None:
        return None
    color = _normalize_color(raw.get("color"), allow_color=(layer_kind == "paint"))
    if layer_kind == "paint" and tool_kind != "eraser" and tool_kind != "lasso_fill" and color is None:
        return None
    if layer_kind == "paint" and tool_kind in {"lasso_fill"} and color is None:
        return None
    if layer_kind == "mask":
        color = None
    stroke_id = str(raw.get("id") or "").strip()
    action_group_id = str(raw.get("actionGroupId") or "").strip()
    if not stroke_id or not action_group_id:
        return None
    created_at = _finite_int(raw.get("createdAt"))
    if created_at is None:
        created_at = 0
    size = _finite_float(raw.get("size"))
    opacity = _finite_float(raw.get("opacity"))
    if size is None or opacity is None:
        return None
    radius_value = _finite_float(raw.get("radiusValue"))
    radius_model = str(raw.get("radiusModel") or "").strip() or None
    frame_snapshot = None
    if target_space.get("kind") == "FRAME_LOCAL":
        snap = raw.get("frameSnapshot")
        if isinstance(snap, dict):
            yaw_deg = _finite_float(snap.get("yaw_deg"))
            pitch_deg = _finite_float(snap.get("pitch_deg"))
            hFOV_deg = _finite_float(snap.get("hFOV_deg"))
            vFOV_deg = _finite_float(snap.get("vFOV_deg"))
            roll_deg = _finite_float(snap.get("roll_deg"))
            if None not in (yaw_deg, pitch_deg, hFOV_deg, vFOV_deg, roll_deg):
                frame_snapshot = {
                    "yaw_deg": float(yaw_deg),
                    "pitch_deg": float(pitch_deg),
                    "hFOV_deg": float(hFOV_deg),
                    "vFOV_deg": float(vFOV_deg),
                    "roll_deg": float(roll_deg),
                }
    out = {
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
        "frameSnapshot": frame_snapshot,
        "radiusModel": radius_model,
        "radiusValue": None if radius_value is None else max(0.0, float(radius_value)),
        "geometry": geometry,
    }
    return out


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
