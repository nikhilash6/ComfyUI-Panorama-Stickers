from comfyui_pano_suite.core.paint_state import normalize_painting_state


def test_normalize_painting_state_splits_layers_and_geometry():
    state = normalize_painting_state({
        "version": 1,
        "paint": {
            "strokes": [{
                "id": "paint_1",
                "actionGroupId": "ag_1",
                "targetSpace": {"kind": "ERP_GLOBAL"},
                "layerKind": "paint",
                "toolKind": "lasso_fill",
                "brushPresetId": "brush_soft",
                "color": {"r": 1.0, "g": 0.5, "b": 0.25, "a": 0.8},
                "size": 12,
                "opacity": 0.7,
                "hardness": 0.5,
                "flow": 0.3,
                "spacing": 0.2,
                "createdAt": 123,
                "geometry": {
                    "geometryKind": "lasso_fill",
                    "points": [
                        {"u": 0.1, "v": 0.2, "t": 0},
                        {"u": 0.2, "v": 0.25, "t": 1},
                        {"u": 0.18, "v": 0.3, "t": 2},
                    ],
                },
            }],
        },
        "mask": {
            "strokes": [{
                "id": "mask_1",
                "actionGroupId": "ag_2",
                "targetSpace": {"kind": "FRAME_LOCAL", "frameId": "frame_a"},
                "layerKind": "mask",
                "toolKind": "rect_fill_drag",
                "color": {"r": 1, "g": 0, "b": 0, "a": 1},
                "size": 8,
                "opacity": 1.0,
                "hardness": None,
                "flow": None,
                "spacing": None,
                "createdAt": 456,
                "geometry": {
                    "geometryKind": "rect_fill",
                    "p0": {"frameId": "frame_a", "x": -0.2, "y": 0.1, "t": 0},
                    "p1": {"frameId": "frame_a", "x": 1.2, "y": 0.9, "t": 1},
                },
            }],
        },
    })

    assert state["paint"]["strokes"][0]["geometry"]["geometryKind"] == "lasso_fill"
    assert state["mask"]["strokes"][0]["geometry"]["geometryKind"] == "rect_fill"
    assert state["mask"]["strokes"][0]["color"] is None
    assert state["mask"]["strokes"][0]["geometry"]["p0"]["x"] == -0.2
    assert state["mask"]["strokes"][0]["geometry"]["p1"]["x"] == 1.2


def test_normalize_painting_state_rejects_mismatched_geometry_and_view_coords():
    state = normalize_painting_state({
        "paint": {
            "strokes": [{
                "id": "bad_paint",
                "actionGroupId": "ag_1",
                "targetSpace": {"kind": "ERP_GLOBAL"},
                "layerKind": "paint",
                "toolKind": "rect_fill_drag",
                "color": {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0},
                "size": 4,
                "opacity": 1.0,
                "createdAt": 0,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [{"x": 10, "y": 20, "t": 0}],
                },
            }],
        },
        "mask": {
            "strokes": [{
                "id": "bad_mask",
                "actionGroupId": "ag_2",
                "targetSpace": {"kind": "FRAME_LOCAL", "frameId": "frame_a"},
                "layerKind": "mask",
                "toolKind": "pen",
                "size": 4,
                "opacity": 1.0,
                "createdAt": 0,
                "geometry": {
                    "geometryKind": "freehand_open",
                    "points": [{"u": 0.1, "v": 0.2, "t": 0}],
                },
            }],
        },
    })

    assert state["paint"]["strokes"] == []
    assert state["mask"]["strokes"] == []
