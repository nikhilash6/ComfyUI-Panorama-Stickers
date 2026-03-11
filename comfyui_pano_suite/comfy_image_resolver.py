from pathlib import Path

import numpy as np
from PIL import Image

from .core.painting import load_painting_layer_payload


def _resolve_comfy_image_path(asset: dict) -> Path | None:
    try:
        import folder_paths
    except ImportError:
        return None
    if not isinstance(asset, dict) or str(asset.get("type") or "").strip().lower() != "comfy_image":
        return None
    filename = str(asset.get("filename") or "").strip()
    if not filename:
        return None
    subfolder = str(asset.get("subfolder") or "").strip().strip("/\\")
    storage = str(asset.get("storage") or "input").strip().lower()
    if storage == "output":
        base = Path(folder_paths.get_output_directory())
    elif storage == "temp":
        base = Path(folder_paths.get_temp_directory())
    else:
        base = Path(folder_paths.get_input_directory())
    path = (base / subfolder / filename).resolve() if subfolder else (base / filename).resolve()
    try:
        path.relative_to(base.resolve())
    except Exception:
        return None
    return path if path.exists() and path.is_file() else None


def _load_comfy_rgba(asset: dict) -> np.ndarray | None:
    path = _resolve_comfy_image_path(asset)
    if path is None:
        return None
    try:
        return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    except Exception:
        return None


def resolve_painting_layer_payload(
    painting_layer: dict | None,
    *,
    erp_width: int | None = None,
    erp_height: int | None = None,
) -> dict | None:
    if not isinstance(painting_layer, dict):
        return None

    paint_rgba = _load_comfy_rgba(painting_layer.get("paint")) if isinstance(painting_layer.get("paint"), dict) else None
    mask_rgba = _load_comfy_rgba(painting_layer.get("mask")) if isinstance(painting_layer.get("mask"), dict) else None
    group_layers = {}

    raw_groups = painting_layer.get("groups")
    if isinstance(raw_groups, list):
        for item in raw_groups:
            if not isinstance(item, dict):
                continue
            action_group_id = str(item.get("actionGroupId") or item.get("id") or "").strip()
            if not action_group_id:
                continue
            layer = _load_comfy_rgba(item.get("image")) if isinstance(item.get("image"), dict) else None
            if layer is not None:
                group_layers[action_group_id] = layer

    return load_painting_layer_payload({
        "revision": str(painting_layer.get("revision") or "").strip(),
        "paint": paint_rgba,
        "mask": None if mask_rgba is None else mask_rgba[..., 3],
        "groups": group_layers,
    }, erp_width=erp_width, erp_height=erp_height)
