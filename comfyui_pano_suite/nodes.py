from pathlib import Path
import logging

import numpy as np
import torch
import torch.nn.functional as F

try:
    import nodes
except ImportError:
    nodes = None

from .core.cutout import cutout_from_erp
from .core.math import calculate_output_dimensions, calculate_dimensions_from_megapixels, finite_float, finite_int
from .core.state import merge_state
from .core.stickers import compose_stickers_to_erp


def _save_input_preview(images, key="pano_input_images"):
    if nodes is None or images is None:
        return {}
    try:
        # PreviewImage().save_images(images) returns {"ui": {"images": [...]}}
        res = nodes.PreviewImage().save_images(images)
        if "ui" in res and "images" in res["ui"]:
            return {key: res["ui"]["images"]}
    except Exception:
        logging.getLogger(__name__).exception(f"Failed to save preview image for {key}")
    return {}


class PanoramaStickersNode:
    CATEGORY = "Panorama Suite"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("cond_erp",)
    OUTPUT_NODE = True
    MAX_OUTPUT_SIDE = 4096

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "output_preset": (
                    ["1024 x 512", "2048 x 1024", "4096 x 2048"],
                    {"default": "2048 x 1024"},
                ),
                "bg_color": ("STRING", {"default": "#00ff00", "multiline": False}),
                "state_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "dynamicPrompts": False,
                    },
                ),
            },
            "optional": {
                "bg_erp": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @staticmethod
    def _parse_output_preset(v, max_val=4096):
        if isinstance(v, str):
            # Accept labels like "2048 x 1024" and raw numeric strings.
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

    def run(self, output_preset, bg_color, state_json, unique_id=None, bg_erp=None):
        out_w = self._parse_output_preset(output_preset, max_val=self.MAX_OUTPUT_SIDE)
        bg_hex = self._normalize_hex_color(bg_color)
        state = merge_state(state_in=None, internal_state=state_json, fallback_preset=out_w, fallback_bg=bg_hex)
        state["output_preset"] = out_w
        state["bg_color"] = bg_hex

        w = out_w
        h = w // 2

        bg_np = None
        if bg_erp is not None:
            bg_np = bg_erp[0].detach().cpu().numpy().astype(np.float32)

        out = compose_stickers_to_erp(
            state=state,
            output_w=w,
            output_h=h,
            bg_erp=bg_np,
            base_dir=Path.cwd(),
            quality="export",
        )

        out_t = torch.from_numpy(out)[None, ...]

        ui_ret = {}
        if bg_erp is not None:
            ui_ret = _save_input_preview(bg_erp)

        return {"ui": ui_ret, "result": (out_t,)}


class PanoramaCutoutNode:
    CATEGORY = "Panorama Suite"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("rect_image",)
    OUTPUT_NODE = True
    MAX_OUTPUT_SIDE = 4096
    DEFAULT_LONG_SIDE = 1024

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "erp_image": ("IMAGE",),
                "state_json": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "dynamicPrompts": False,
                    },
                ),
                "output_megapixels": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.01, "step": 0.05},
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def _derive_output_size_from_fov(cls, hfov_val, vfov_val):
        return calculate_output_dimensions(
            hfov_deg=hfov_val,
            vfov_deg=vfov_val,
            long_side=cls.DEFAULT_LONG_SIDE,
            max_side=cls.MAX_OUTPUT_SIDE,
        )

    def run(
        self,
        erp_image,
        state_json,
        output_megapixels=1.0,
        unique_id=None,
    ):
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

        # Logic: If out_w/out_h are explicitly customized (non-default/non-square/non-zero), use them.
        # Otherwise, derive from megapixels target.
        # Default in JSON is often 1024x1024.
        use_megapixels = (ow_raw <= 0 or oh_raw <= 0 or (ow_raw == 1024 and oh_raw == 1024))

        if use_megapixels:
            ow, oh = calculate_dimensions_from_megapixels(
                output_megapixels, hfov, vfov, max_side=self.MAX_OUTPUT_SIDE
            )
        else:
            ow = int(np.clip(ow_raw, 8, self.MAX_OUTPUT_SIDE))
            oh = int(np.clip(oh_raw, 8, self.MAX_OUTPUT_SIDE))

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

        ui_ret = {}
        if erp_image is not None:
            ui_ret = _save_input_preview(erp_image)

        try:
            out = cutout_from_erp(src, yaw, pitch, hfov, vfov, roll, ow, oh)
            if out.ndim != 3 or out.shape[-1] != 3:
                out = np.zeros((oh, ow, 3), dtype=np.float32)
            out_t = torch.from_numpy(out)[None, ...]

            return {"ui": ui_ret, "result": (out_t,)}
        except Exception as ex:
            print(f"[PanoramaCutout] run failed, fallback passthrough: {ex}")
            try:
                if erp_image is not None and hasattr(erp_image, "shape") and len(erp_image.shape) == 4 and int(erp_image.shape[0]) > 0:
                    t = erp_image[..., :3].to(dtype=torch.float32)
                    t = t.permute(0, 3, 1, 2)
                    t = F.interpolate(t, size=(oh, ow), mode="bilinear", align_corners=False)
                    t = t.permute(0, 2, 3, 1).clamp(0.0, 1.0)
                    return {"ui": ui_ret, "result": (t[:1],)}
            except Exception as ex2:
                print(f"[PanoramaCutout] fallback resize failed: {ex2}")
            return {"ui": ui_ret, "result": (torch.zeros((1, oh, ow, 3), dtype=torch.float32),)}


class PanoramaPreviewNode:
    CATEGORY = "Panorama Suite"
    FUNCTION = "run"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "erp_image": ("IMAGE",),
            }
        }

    def run(self, erp_image):
        ui_ret = {}
        if erp_image is not None:
            # We use "pano_input_images" to pass the temp preview info to our frontend logic.
            # We do NOT copy this to "images" to avoid the standard ComfyUI preview widget
            # from double-rendering the image below our custom interactive preview.
            ui_ret = _save_input_preview(erp_image)
        return {"ui": ui_ret}


class PanoramaSeamPrepNode:
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

    CATEGORY = "Panorama Suite"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "MASK", "MASK")
    RETURN_NAMES = ("image", "mask", "mask_blurred")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "seam_width_px": ("INT", {"default": 64, "min": 1, "max": 2048, "step": 1}),
                "seam_center_offset_px": ("INT", {"default": 0, "min": -2048, "max": 2048, "step": 1}),
                "mask_blur_px": ("INT", {"default": 10, "min": 0, "max": 256, "step": 1}),
            }
        }

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

    def run(self, image, seam_width_px=64, seam_center_offset_px=0, mask_blur_px=0):
        if image is None or not hasattr(image, "shape"):
            empty_img = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            empty_mask = torch.zeros((1, 1, 1), dtype=torch.float32)
            return (empty_img, empty_mask, empty_mask)

        img = image.contiguous().to(dtype=torch.float32)
        if img.ndim == 3:
            img = img.unsqueeze(0)
        if img.ndim != 4:
            raise ValueError("PanoramaSeamPrep expects IMAGE input shaped [B,H,W,C].")

        batch, height, width, channels = img.shape
        if width < 1 or height < 1:
            empty_img = torch.zeros((max(batch, 1), max(height, 1), max(width, 1), max(channels, 3)), dtype=img.dtype, device=img.device)
            empty_mask = torch.zeros((max(batch, 1), max(height, 1), max(width, 1)), dtype=img.dtype, device=img.device)
            return (empty_img, empty_mask, empty_mask)

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
        mask_blurred = self._blur_mask(mask, mask_blur_px)

        return (prepared, mask, mask_blurred)


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
