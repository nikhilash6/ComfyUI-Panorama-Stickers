import numpy as np

from comfyui_pano_suite.core.painting import alpha_composite_over_rgb, render_painting_to_erp


def test_render_painting_to_erp_returns_independent_paint_and_mask():
    painting = {
        "version": 1,
        "paint": {
            "strokes": [{
                "id": "paint_1",
                "actionGroupId": "ag_1",
                "targetSpace": {"kind": "ERP_GLOBAL"},
                "layerKind": "paint",
                "toolKind": "pen",
                "brushPresetId": None,
                "color": {"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
                "size": 8,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 0,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [{"u": 0.1, "v": 0.2, "t": 0}, {"u": 0.3, "v": 0.2, "t": 1}],
                },
            }],
        },
        "mask": {
            "strokes": [{
                "id": "mask_1",
                "actionGroupId": "ag_2",
                "targetSpace": {"kind": "ERP_GLOBAL"},
                "layerKind": "mask",
                "toolKind": "pen",
                "brushPresetId": None,
                "color": None,
                "size": 20,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 1,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [{"u": 0.6, "v": 0.3, "t": 0}, {"u": 0.8, "v": 0.3, "t": 1}],
                },
            }],
        },
    }

    paint_rgba, mask_bw = render_painting_to_erp(painting, 256, 128)

    assert paint_rgba.shape == (128, 256, 4)
    assert mask_bw.shape == (128, 256)
    assert float(np.max(paint_rgba[..., 3])) > 0.0
    assert float(np.max(mask_bw)) > 0.0

    base = np.zeros((128, 256, 3), dtype=np.float32)
    composited = alpha_composite_over_rgb(base, paint_rgba)
    assert composited.shape == base.shape
    assert float(np.max(composited[..., 0])) > 0.0
    assert float(np.max(composited[..., 1])) < 1e-6
