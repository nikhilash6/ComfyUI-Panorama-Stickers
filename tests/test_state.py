from comfyui_pano_suite.core.state import DEFAULT_STATE, merge_state, parse_sticker_state


def test_merge_state_handles_none_inputs():
    state = merge_state(None, None)

    assert state["version"] == 1
    assert state["projection_model"] == "pinhole_rectilinear"
    assert state["alpha_mode"] == "straight"
    assert state["output_preset"] == DEFAULT_STATE["output_preset"]
    assert state["bg_color"] == DEFAULT_STATE["bg_color"]
    assert isinstance(state["assets"], dict)
    assert isinstance(state["stickers"], list)
    assert isinstance(state["shots"], list)
    assert isinstance(state["active"], dict)
    assert state["active"]["selected_sticker_id"] is None
    assert state["active"]["selected_shot_id"] is None


def test_merge_state_handles_empty_dict_inputs_and_fallbacks():
    state = merge_state("{}", "{}", fallback_preset=1024, fallback_bg="#112233")

    assert state["output_preset"] == 1024
    assert state["bg_color"] == "#112233"
    assert state["assets"] == {}
    assert state["stickers"] == []
    assert state["shots"] == []
    assert state["active"]["selected_sticker_id"] is None
    assert state["active"]["selected_shot_id"] is None


def test_merge_state_normalizes_invalid_container_types():
    internal = '{"assets":[],"stickers":{},"shots":"bad","active":[]}'
    state = merge_state(None, internal)

    assert state["assets"] == {}
    assert state["stickers"] == []
    assert state["shots"] == []
    assert state["active"]["selected_sticker_id"] is None
    assert state["active"]["selected_shot_id"] is None


def test_merge_state_fills_missing_active_keys():
    state = merge_state(None, '{"active":{"selected_sticker_id":"st_1"}}')

    assert state["active"]["selected_sticker_id"] == "st_1"
    assert state["active"]["selected_shot_id"] is None


def test_parse_sticker_state_reads_canonical_format():
    parsed = parse_sticker_state(
        '{"kind":"pano_sticker_state","version":1,"pose":{"yaw_deg":190,"pitch_deg":100,"roll_deg":15,"hFOV_deg":200},"source_aspect":1.5}'
    )

    assert parsed is not None
    assert parsed["yaw_deg"] == -170.0
    assert parsed["pitch_deg"] == 89.9
    assert parsed["roll_deg"] == 15.0
    assert parsed["hFOV_deg"] == 179.0
    assert parsed["source_aspect"] == 1.5


def test_parse_sticker_state_rejects_invalid_kind_or_version():
    assert parse_sticker_state('{"kind":"wrong","version":1,"pose":{"yaw_deg":0,"pitch_deg":0,"roll_deg":0,"hFOV_deg":30}}') is None
    assert parse_sticker_state('{"kind":"pano_sticker_state","version":2,"pose":{"yaw_deg":0,"pitch_deg":0,"roll_deg":0,"hFOV_deg":30}}') is None
