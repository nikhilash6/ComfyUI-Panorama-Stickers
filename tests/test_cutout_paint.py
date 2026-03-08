import numpy as np

from comfyui_pano_suite.core.painting import render_painting_to_cutout


def test_render_painting_to_cutout_projects_erp_strokes_into_frame():
    painting = {
        "version": 1,
        "paint": {
            "strokes": [{
                "id": "erp_paint",
                "actionGroupId": "ag_1",
                "targetSpace": {"kind": "ERP_GLOBAL"},
                "layerKind": "paint",
                "toolKind": "pen",
                "brushPresetId": None,
                "color": {"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0},
                "size": 6,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 1,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [
                        {"u": 0.49, "v": 0.5, "t": 0},
                        {"u": 0.51, "v": 0.5, "t": 1},
                    ],
                },
            }],
        },
        "mask": {
            "strokes": [{
                "id": "erp_mask",
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
                "createdAt": 2,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [
                        {"u": 0.48, "v": 0.5, "t": 0},
                        {"u": 0.52, "v": 0.5, "t": 1},
                    ],
                },
            }],
        },
    }
    shot = {
        "id": "frame_1",
        "yaw_deg": 0.0,
        "pitch_deg": 0.0,
        "roll_deg": 0.0,
        "hFOV_deg": 90.0,
        "vFOV_deg": 90.0,
    }

    paint_rgba, mask_bw = render_painting_to_cutout(painting, shot, 128, 128)

    assert paint_rgba.shape == (128, 128, 4)
    assert mask_bw.shape == (128, 128)
    assert float(np.max(paint_rgba[..., 3])) > 0.0
    assert float(np.max(mask_bw)) > 0.0
