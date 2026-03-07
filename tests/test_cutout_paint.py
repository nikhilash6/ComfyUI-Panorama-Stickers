import numpy as np

from comfyui_pano_suite.core.painting import render_painting_to_cutout


def test_render_painting_to_cutout_combines_erp_and_frame_layers():
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
            }, {
                "id": "frame_paint",
                "actionGroupId": "ag_2",
                "targetSpace": {"kind": "FRAME_LOCAL", "frameId": "frame_1"},
                "layerKind": "paint",
                "toolKind": "rect_fill_drag",
                "brushPresetId": None,
                "color": {"r": 0.0, "g": 1.0, "b": 0.0, "a": 1.0},
                "size": 4,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 2,
                "geometry": {
                    "geometryKind": "rect_fill",
                    "p0": {"frameId": "frame_1", "x": 0.2, "y": 0.2, "t": 0},
                    "p1": {"frameId": "frame_1", "x": 0.8, "y": 0.8, "t": 1},
                },
            }],
        },
        "mask": {
            "strokes": [{
                "id": "frame_mask",
                "actionGroupId": "ag_3",
                "targetSpace": {"kind": "FRAME_LOCAL", "frameId": "frame_1"},
                "layerKind": "mask",
                "toolKind": "rect_fill_drag",
                "brushPresetId": None,
                "color": None,
                "size": 4,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 3,
                "geometry": {
                    "geometryKind": "rect_fill",
                    "p0": {"frameId": "frame_1", "x": 0.25, "y": 0.25, "t": 0},
                    "p1": {"frameId": "frame_1", "x": 0.75, "y": 0.75, "t": 1},
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
