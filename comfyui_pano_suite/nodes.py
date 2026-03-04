import json
import math
from pathlib import Path
import logging

import numpy as np
import torch
import torch.nn.functional as F
from comfy_api.latest import io

try:
    import nodes
except ImportError:
    nodes = None

from .core.cutout import cutout_from_erp
from .core.math import (
    calculate_dimensions_from_megapixels,
    calculate_output_dimensions,
    finite_float,
    finite_int,
)
from .core.state import merge_state, parse_sticker_state
from .core.stickers import compose_stickers_to_erp


def _save_input_preview(images, key="pano_input_images"):
    if nodes is None or images is None:
        return {}
    try:
        res = nodes.PreviewImage().save_images(images)
        if "ui" in res and "images" in res["ui"]:
            return {key: res["ui"]["images"]}
    except Exception:
        logging.getLogger(__name__).exception("Failed to save preview image for %s", key)
    return {}


def _iter_external_sticker_payloads(sticker_image=None, sticker_state=None):
    if sticker_image is None:
        return []
    return [{
        "slot_key": "1",
        "image_tensor": sticker_image,
        "state_raw": sticker_state,
    }]


def _external_sticker_id(slot_key: str) -> str:
    return f"external_{str(slot_key or '').strip() or '1'}"


def _hash_text(value) -> str:
    text = str(value or "")
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return str(h)


def _single_image_to_numpy(image, warnings: list[str]) -> np.ndarray | None:
    if image is None or not hasattr(image, "detach"):
        return None
    try:
        arr = image.detach().cpu().numpy().astype(np.float32)
    except Exception:
        return None
    if arr.ndim == 3:
        arr = arr[None, ...]
    if arr.ndim != 4 or arr.shape[0] <= 0:
        return None
    if arr.shape[0] > 1:
        warnings.append("Multiple images received; using the first image only.")
    img = arr[0]
    if img.ndim != 3 or img.shape[0] <= 0 or img.shape[1] <= 0:
        return None
    if img.shape[-1] < 3:
        img = np.repeat(img[..., :1], 3, axis=-1)
    elif img.shape[-1] > 4:
        img = img[..., :4]
    return np.clip(img.astype(np.float32), 0.0, 1.0)


def _vfov_from_hfov(hfov_deg: float, image_w: int, image_h: int) -> float:
    width = max(1, int(image_w))
    height = max(1, int(image_h))
    hfov = float(np.clip(hfov_deg, 0.1, 179.0))
    vfov = 2.0 * math.degrees(math.atan(math.tan(math.radians(hfov) * 0.5) * (height / width)))
    return float(np.clip(vfov, 0.1, 179.0))


def _default_pose_for_sticker(image_w: int, image_h: int) -> dict:
    hfov = 30.0
    return {
        "yaw_deg": 0.0,
        "pitch_deg": 0.0,
        "hFOV_deg": hfov,
        "vFOV_deg": _vfov_from_hfov(hfov, image_w, image_h),
        "rot_deg": 0.0,
    }


def _pose_from_sticker_state(parsed_state: dict | None, image_w: int, image_h: int, warnings: list[str]) -> dict:
    default_pose = _default_pose_for_sticker(image_w, image_h)
    if not isinstance(parsed_state, dict):
        return default_pose
    hfov = float(np.clip(finite_float(parsed_state.get("hFOV_deg", default_pose["hFOV_deg"]), default_pose["hFOV_deg"]), 0.1, 179.0))
    source_aspect = parsed_state.get("source_aspect", None)
    if source_aspect is not None:
        source_aspect_val = finite_float(source_aspect, 0.0)
        current_aspect = float(max(1, image_w)) / float(max(1, image_h))
        if source_aspect_val > 0.0 and abs(source_aspect_val - current_aspect) > 1e-3:
            warnings.append("Image aspect ratio differs from source metadata; using the current image aspect ratio.")
    return {
        "yaw_deg": finite_float(parsed_state.get("yaw_deg", default_pose["yaw_deg"]), default_pose["yaw_deg"]),
        "pitch_deg": finite_float(parsed_state.get("pitch_deg", default_pose["pitch_deg"]), default_pose["pitch_deg"]),
        "hFOV_deg": hfov,
        "vFOV_deg": _vfov_from_hfov(hfov, image_w, image_h),
        "rot_deg": finite_float(parsed_state.get("roll_deg", default_pose["rot_deg"]), default_pose["rot_deg"]),
    }


def _build_sticker_state_json(shot: dict, frame_w: int, frame_h: int) -> str:
    width = max(1, int(frame_w))
    height = max(1, int(frame_h))
    payload = {
        "kind": "pano_sticker_state",
        "version": 1,
        "pose": {
            "yaw_deg": finite_float(shot.get("yaw_deg", 0.0), 0.0),
            "pitch_deg": finite_float(shot.get("pitch_deg", 0.0), 0.0),
            "roll_deg": finite_float(shot.get("roll_deg", 0.0), 0.0),
            "hFOV_deg": float(np.clip(finite_float(shot.get("hFOV_deg", 90.0), 90.0), 0.1, 179.0)),
        },
        "source_aspect": float(width) / float(height),
    }
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


class PanoramaStickersNode(io.ComfyNode):
    MAX_OUTPUT_SIDE = 4096

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PanoramaStickers",
            display_name="Panorama Stickers",
            category="Panorama Suite",
            inputs=[
                io.Combo.Input(
                    "output_preset",
                    options=["1024 x 512", "2048 x 1024", "4096 x 2048"],
                    default="2048 x 1024",
                ),
                io.String.Input("bg_color", default="#00ff00", multiline=False),
                io.String.Input(
                    "state_json",
                    default="",
                    multiline=False,
                    dynamic_prompts=False,
                ),
                io.Image.Input("bg_erp", optional=True),
                io.Image.Input("sticker_image", optional=True),
                io.String.Input(
                    "sticker_state",
                    default="",
                    multiline=False,
                    dynamic_prompts=False,
                    optional=True,
                    force_input=True,
                ),
            ],
            outputs=[io.Image.Output("cond_erp", display_name="cond_erp")],
            hidden=[io.Hidden.unique_id],
            is_output_node=True,
        )

    @staticmethod
    def _parse_output_preset(v, max_val=4096):
        if isinstance(v, str):
            head = v.split("x", 1)[0].strip()
            val = int(float(head))
        else:
            val = int(v)
        return int(np.clip(val, 8, max_val))

    @staticmethod
    def _normalize_hex_color(v):
        s = str(v or "").strip()
        if s.startswith("#"):
            s = s[1:]
        if len(s) == 3:
            s = "".join(ch * 2 for ch in s)
        if len(s) != 6:
            return "#00ff00"
        try:
            int(s, 16)
        except ValueError:
            return "#00ff00"
        return f"#{s.lower()}"

    @classmethod
    def execute(cls, output_preset, bg_color, state_json, bg_erp=None, sticker_image=None, sticker_state=""):
        out_w = cls._parse_output_preset(output_preset, max_val=cls.MAX_OUTPUT_SIDE)
        bg_hex = cls._normalize_hex_color(bg_color)
        state = merge_state(state_in=None, internal_state=state_json, fallback_preset=out_w, fallback_bg=bg_hex)
        state["output_preset"] = out_w
        state["bg_color"] = bg_hex
        warnings = []

        bg_np = None
        if bg_erp is not None:
            bg_np = bg_erp[0].detach().cpu().numpy().astype(np.float32)

        render_stickers = []
        for sticker in state.get("stickers", []):
            if isinstance(sticker, dict):
                render_stickers.append(dict(sticker))

        external_pose_ui = None
        for payload in _iter_external_sticker_payloads(sticker_image=sticker_image, sticker_state=sticker_state):
            parsed_state = parse_sticker_state(payload.get("state_raw"))
            payload_state_hash = _hash_text(payload.get("state_raw"))
            if external_pose_ui is None and parsed_state is not None:
                external_pose_ui = {
                    "yaw_deg": float(parsed_state.get("yaw_deg", 0.0)),
                    "pitch_deg": float(parsed_state.get("pitch_deg", 0.0)),
                    "hFOV_deg": float(parsed_state.get("hFOV_deg", 30.0)),
                    "rot_deg": float(parsed_state.get("roll_deg", 0.0)),
                }
            img_np = _single_image_to_numpy(payload.get("image_tensor"), warnings)
            if img_np is None:
                continue
            image_h = int(img_np.shape[0]) if img_np.ndim >= 2 else 1
            image_w = int(img_np.shape[1]) if img_np.ndim >= 2 else 1
            if img_np.shape[-1] == 3:
                alpha = np.ones((image_h, image_w, 1), dtype=np.float32)
                image_rgba = np.concatenate([img_np, alpha], axis=-1)
            else:
                image_rgba = img_np[..., :4]
            parsed_pose = _pose_from_sticker_state(parsed_state, image_w, image_h, warnings) if parsed_state is not None else None
            if external_pose_ui is None and parsed_pose is not None:
                external_pose_ui = dict(parsed_pose)

            external_id = _external_sticker_id(payload.get("slot_key"))
            for idx, sticker in enumerate(render_stickers):
                if str(sticker.get("id", "")) != external_id:
                    continue
                runtime_sticker = dict(sticker)
                if parsed_pose is not None and str(runtime_sticker.get("source_state_hash", "")) != payload_state_hash:
                    runtime_sticker.update(parsed_pose)
                else:
                    runtime_sticker["vFOV_deg"] = _vfov_from_hfov(
                        runtime_sticker.get("hFOV_deg", 30.0),
                        image_w,
                        image_h,
                    )
                runtime_sticker["image_rgba"] = image_rgba
                render_stickers[idx] = runtime_sticker
                break

        render_state = dict(state)
        render_state["stickers"] = render_stickers

        out = compose_stickers_to_erp(
            state=render_state,
            output_w=out_w,
            output_h=out_w // 2,
            bg_erp=bg_np,
            base_dir=Path.cwd(),
            quality="export",
        )

        out_t = torch.from_numpy(out)[None, ...]
        ui_ret = _save_input_preview(bg_erp) if bg_erp is not None else {}
        if sticker_image is not None:
            ui_ret.update(_save_input_preview(sticker_image, key="pano_sticker_input_images"))
        if external_pose_ui is not None:
            ui_ret["pano_sticker_input_pose"] = [external_pose_ui]
        if warnings:
            ui_ret["pano_sticker_warnings"] = [str(w) for w in warnings]
        return io.NodeOutput(out_t, ui=ui_ret)


class PanoramaCutoutNode(io.ComfyNode):
    MAX_OUTPUT_SIDE = 4096
    DEFAULT_LONG_SIDE = 1024

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PanoramaCutout",
            display_name="Panorama Cutout",
            category="Panorama Suite",
            inputs=[
                io.Image.Input("erp_image"),
                io.String.Input(
                    "state_json",
                    default="",
                    multiline=True,
                    dynamic_prompts=False,
                ),
                io.Float.Input("output_megapixels", default=1.0, min=0.01, step=0.05),
            ],
            outputs=[
                io.Image.Output("rect_image", display_name="rect_image"),
                io.String.Output("sticker_state_json", display_name="sticker_state_json"),
            ],
            hidden=[io.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def _derive_output_size_from_fov(cls, hfov_val, vfov_val):
        return calculate_output_dimensions(
            hfov_deg=hfov_val,
            vfov_deg=vfov_val,
            long_side=cls.DEFAULT_LONG_SIDE,
            max_side=cls.MAX_OUTPUT_SIDE,
        )

    @classmethod
    def execute(cls, erp_image, state_json, output_megapixels=1.0):
        output_megapixels = max(0.01, finite_float(output_megapixels, 1.0))
        state = merge_state(state_in=None, internal_state=state_json)
        shots = state.get("shots", []) if isinstance(state, dict) else []
        shot = shots[0] if shots else {
            "yaw_deg": 0.0,
            "pitch_deg": 0.0,
            "hFOV_deg": 90.0,
            "vFOV_deg": 60.0,
            "roll_deg": 0.0,
            "out_w": 1024,
            "out_h": 1024,
        }

        yaw = finite_float(shot.get("yaw_deg", 0.0), 0.0)
        pitch = finite_float(shot.get("pitch_deg", 0.0), 0.0)
        hfov = float(np.clip(finite_float(shot.get("hFOV_deg", 90.0), 90.0), 1.0, 179.0))
        vfov = float(np.clip(finite_float(shot.get("vFOV_deg", 60.0), 60.0), 1.0, 179.0))
        roll = finite_float(shot.get("roll_deg", 0.0), 0.0)
        ow_raw = finite_int(shot.get("out_w", 1024), 1024)
        oh_raw = finite_int(shot.get("out_h", 1024), 1024)

        use_megapixels = ow_raw <= 0 or oh_raw <= 0 or (ow_raw == 1024 and oh_raw == 1024)
        if use_megapixels:
            ow, oh = calculate_dimensions_from_megapixels(
                output_megapixels, hfov, vfov, max_side=cls.MAX_OUTPUT_SIDE
            )
        else:
            ow = int(np.clip(ow_raw, 8, cls.MAX_OUTPUT_SIDE))
            oh = int(np.clip(oh_raw, 8, cls.MAX_OUTPUT_SIDE))

        src = None
        try:
            if erp_image is not None and hasattr(erp_image, "detach"):
                arr = erp_image.detach().cpu().numpy().astype(np.float32)
                if arr.ndim == 4 and arr.shape[0] > 0:
                    src = arr[0]
                elif arr.ndim == 3:
                    src = arr
        except Exception:
            src = None

        if src is None:
            src = np.zeros((512, 1024, 3), dtype=np.float32)

        if src.ndim != 3:
            src = np.zeros((512, 1024, 3), dtype=np.float32)
        else:
            h, w, c = src.shape
            if h <= 1 or w <= 1:
                src = np.zeros((512, 1024, 3), dtype=np.float32)
            elif c < 3:
                src = np.repeat(src[..., :1], 3, axis=-1)
            elif c > 3:
                src = src[..., :3]

        ui_ret = _save_input_preview(erp_image) if erp_image is not None else {}
        sticker_state_json = _build_sticker_state_json(shot, ow, oh)

        try:
            out = cutout_from_erp(src, yaw, pitch, hfov, vfov, roll, ow, oh)
            if out.ndim != 3 or out.shape[-1] != 3:
                out = np.zeros((oh, ow, 3), dtype=np.float32)
            out_t = torch.from_numpy(out)[None, ...]
            return io.NodeOutput(out_t, sticker_state_json, ui=ui_ret)
        except Exception as ex:
            print(f"[PanoramaCutout] run failed, fallback passthrough: {ex}")
            try:
                if erp_image is not None and hasattr(erp_image, "shape") and len(erp_image.shape) == 4 and int(erp_image.shape[0]) > 0:
                    t = erp_image[..., :3].to(dtype=torch.float32)
                    t = t.permute(0, 3, 1, 2)
                    t = F.interpolate(t, size=(oh, ow), mode="bilinear", align_corners=False)
                    t = t.permute(0, 2, 3, 1).clamp(0.0, 1.0)
                    return io.NodeOutput(t[:1], sticker_state_json, ui=ui_ret)
            except Exception as ex2:
                print(f"[PanoramaCutout] fallback resize failed: {ex2}")
            return io.NodeOutput(torch.zeros((1, oh, ow, 3), dtype=torch.float32), sticker_state_json, ui=ui_ret)


class PanoramaPreviewNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PanoramaPreview",
            display_name="Panorama Preview",
            category="Panorama Suite",
            inputs=[io.Image.Input("erp_image")],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, erp_image):
        ui_ret = {}
        if erp_image is not None:
            ui_ret = _save_input_preview(erp_image)
        return io.NodeOutput(ui=ui_ret)


class PanoramaSeamPrepNode(io.ComfyNode):
    """
    Prepare an ERP image for seam-focused inpainting.

    Expected input shape:
    - image: [B, H, W, C] float tensor in 0..1

    Output shapes:
    - image: [B, H, W, C]
    - mask: [B, H, W]
    - mask_blurred: [B, H, W]

    seam_center_offset_px shifts the seam target center from the image midpoint.
    Positive values move the seam band right, negative values move it left.
    """

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="PanoramaSeamPrep",
            display_name="Panorama Seam Prep",
            category="Panorama Suite",
            description=(
                "Prepare an ERP image for seam-focused inpainting. "
                "Expected IMAGE input shape is [B,H,W,C]. "
                "Outputs are image [B,H,W,C], mask [B,H,W], and blurred mask [B,H,W]. "
                "Positive seam_center_offset_px moves the seam band right; negative moves it left."
            ),
            inputs=[
                io.Image.Input("image"),
                io.Int.Input("seam_width_px", default=64, min=1, max=2048, step=1),
                io.Int.Input("seam_center_offset_px", default=0, min=-2048, max=2048, step=1),
                io.Int.Input("mask_blur_px", default=10, min=0, max=256, step=1),
            ],
            outputs=[
                io.Image.Output("image", display_name="image"),
                io.Mask.Output("mask", display_name="mask"),
                io.Mask.Output("mask_blurred", display_name="mask_blurred"),
            ],
        )

    @staticmethod
    def _gaussian_kernel_1d(radius: int, dtype: torch.dtype, device: torch.device) -> torch.Tensor:
        radius = max(0, int(radius))
        if radius <= 0:
            return torch.ones((1,), dtype=dtype, device=device)
        sigma = max(0.5, float(radius) / 3.0)
        coords = torch.arange(-radius, radius + 1, dtype=dtype, device=device)
        kernel = torch.exp(-(coords * coords) / (2.0 * sigma * sigma))
        kernel = kernel / torch.clamp(kernel.sum(), min=torch.finfo(dtype).eps)
        return kernel

    @classmethod
    def _blur_mask(cls, mask: torch.Tensor, blur_px: int) -> torch.Tensor:
        radius = max(0, int(blur_px))
        if radius <= 0:
            return mask
        batch, height, width = mask.shape
        kernel = cls._gaussian_kernel_1d(radius, mask.dtype, mask.device)
        kernel_x = kernel.view(1, 1, 1, -1)
        kernel_y = kernel.view(1, 1, -1, 1)
        work = mask.contiguous().unsqueeze(1)
        work = F.pad(work, (radius, radius, 0, 0), mode="replicate")
        work = F.conv2d(work, kernel_x.expand(1, 1, 1, kernel.numel()), groups=1)
        work = F.pad(work, (0, 0, radius, radius), mode="replicate")
        work = F.conv2d(work, kernel_y.expand(1, 1, kernel.numel(), 1), groups=1)
        work = work.view(batch, height, width)
        return work.clamp(0.0, 1.0)

    @classmethod
    def execute(cls, image, seam_width_px=64, seam_center_offset_px=0, mask_blur_px=0):
        if image is None or not hasattr(image, "shape"):
            empty_img = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            empty_mask = torch.zeros((1, 1, 1), dtype=torch.float32)
            return io.NodeOutput(empty_img, empty_mask, empty_mask)

        img = image.contiguous().to(dtype=torch.float32)
        if img.ndim == 3:
            img = img.unsqueeze(0)
        if img.ndim != 4:
            raise ValueError("PanoramaSeamPrep expects IMAGE input shaped [B,H,W,C].")

        batch, height, width, channels = img.shape
        if width < 1 or height < 1:
            empty_img = torch.zeros(
                (max(batch, 1), max(height, 1), max(width, 1), max(channels, 3)),
                dtype=img.dtype,
                device=img.device,
            )
            empty_mask = torch.zeros((max(batch, 1), max(height, 1), max(width, 1)), dtype=img.dtype, device=img.device)
            return io.NodeOutput(empty_img, empty_mask, empty_mask)

        seam_width_px = max(1, int(seam_width_px))
        seam_center_offset_px = int(seam_center_offset_px)
        mask_blur_px = max(0, int(mask_blur_px))

        doubled = torch.cat((img, img), dim=2)
        start_x = int(width // 2 - seam_center_offset_px)
        start_x = max(0, min(start_x, width))
        prepared = doubled[:, :, start_x:start_x + width, :].contiguous().clamp(0.0, 1.0)

        center_x = float(width) * 0.5 + float(seam_center_offset_px)
        half_width = float(seam_width_px) * 0.5
        x = torch.arange(width, dtype=img.dtype, device=img.device)
        band = ((x >= (center_x - half_width)) & (x < (center_x + half_width))).to(dtype=img.dtype)
        mask = band.view(1, 1, width).expand(batch, height, width).contiguous()
        mask_blurred = cls._blur_mask(mask, mask_blur_px)

        return io.NodeOutput(prepared, mask, mask_blurred)


NODE_CLASS_MAPPINGS = {
    "PanoramaStickers": PanoramaStickersNode,
    "PanoramaCutout": PanoramaCutoutNode,
    "PanoramaPreview": PanoramaPreviewNode,
    "PanoramaSeamPrep": PanoramaSeamPrepNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PanoramaStickers": "Panorama Stickers",
    "PanoramaCutout": "Panorama Cutout",
    "PanoramaPreview": "Panorama Preview",
    "PanoramaSeamPrep": "Panorama Seam Prep",
}
