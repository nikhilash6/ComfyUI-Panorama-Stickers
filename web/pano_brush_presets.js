// Brush preset definitions.
//
// Each preset carries all render-time parameters needed by the paint engine.
// Presets are applied to stroke records at creation time; thereafter the stroke
// record is fully self-describing (no runtime preset lookup needed).
//
// Schema fields:
//   id              — unique key, matches the object key in BRUSH_PRESETS
//   label           — display name
//   stampKind       — "round" | "chisel"
//   hardness        — edge sharpness 0..1  (0 = very soft, 1 = hard)
//   spacing         — stamp interval as fraction of diameter (e.g. 0.14 = dense)
//   flow            — per-stamp opacity contribution 0..1 (baked into stamp texture)
//   opacity         — stroke-level opacity applied at composite time 0..1
//   opacityMode     — "accumulate" | "flat"
//                     accumulate: stamps build up opacity within the stroke (pen/brush)
//                     flat:       stamps fill to coverage, whole stroke composited at opacity (marker)
//   aspect          — horizontal / vertical radius ratio (1.0 = circle, >1 = wider)
//   angle           — { kind: "fixed", value: radians }
//                   | { kind: "stroke_dir" }  (stamp rotates to follow stroke direction)
//   velocityWidthFactor — 0..1, how much faster movement narrows the stroke.
//                         0 = constant width. Placeholder for future use.
//   chiselEdgeLift  — (chisel only) 0..1, extra opacity at stamp perimeter
//   chiselCenterDip — (chisel only) 0..1, opacity reduction at stamp centre
//   scatter         — null | { radius, count }
//                     radius: scatter radius as multiple of radiusPx
//                     count:  sub-stamps per stamp position (deterministic PRNG)
//   sizeScale       — multiplier applied to the user's size slider before computing radius.
//                     Compensates for aspect ratio and softness so different brushes feel
//                     similarly sized at the same slider value. Not stored in the stroke record.

export const BRUSH_PRESETS = {
  pen: {
    id: "pen",
    label: "Pen",
    stampKind: "round",
    hardness: 0.92,
    spacing: 0.14,
    flow: 1,
    opacity: 1,
    opacityMode: "accumulate",
    aspect: 1,
    angle: { kind: "fixed", value: 0 },
    velocityWidthFactor: 0,
    chiselEdgeLift: 0,
    chiselCenterDip: 0,
    scatter: null,
    sizeScale: 1,
  },
  marker: {
    id: "marker",
    label: "Marker",
    stampKind: "chisel",
    hardness: 0.76,
    spacing: 0.06,
    // flow < 1 so accumulate mode shows visible overlap buildup (Apple Freeboard style).
    flow: 0.8,
    opacity: 0.88,
    // accumulate: overlapping areas within one stroke build up darker, like a real marker.
    opacityMode: "accumulate",
    aspect: 2.4,
    angle: { kind: "fixed", value: Math.PI / 6 },
    velocityWidthFactor: 0,
    chiselEdgeLift: 0.3,
    chiselCenterDip: 0.12,
    // Nib-fiber texture: felt channels visible as subtle streaks along the nib.
    chiselFiber: 0.28,
    scatter: null,
    // Compensates for aspect=2.4: at same slider value, nib height matches pen stroke width.
    sizeScale: 0.6,
  },
  brush: {
    id: "brush",
    label: "Soft Brush",
    stampKind: "round",
    hardness: 0.06,
    spacing: 0.06,
    flow: 0.28,
    opacity: 0.85,
    opacityMode: "accumulate",
    aspect: 1,
    angle: { kind: "fixed", value: 0 },
    velocityWidthFactor: 0,
    chiselEdgeLift: 0,
    chiselCenterDip: 0,
    scatter: null,
    // Soft edges feather out visually; scale up so it feels similar in weight to pen.
    sizeScale: 1.5,
  },
  crayon: {
    id: "crayon",
    label: "Pastel",
    stampKind: "crayon",
    hardness: 0.55,
    spacing: 0.1,
    flow: 0.82,
    opacity: 0.92,
    opacityMode: "accumulate",
    aspect: 1.2,
    angle: { kind: "fixed", value: 0 },
    velocityWidthFactor: 0,
    chiselEdgeLift: 0,
    chiselCenterDip: 0,
    // Grain = amount of per-pixel wax-texture noise applied inside the shape.
    // 0 = no grain (smooth), 1 = maximum grain.
    crayonGrain: 0.68,
    scatter: null,
    sizeScale: 0.92,
  },
};

export const DEFAULT_BRUSH_PRESET_ID = "pen";

// Apply preset fields to a stroke record (in-place, only overwrites brush params).
export function applyPresetToStroke(stroke, preset) {
  stroke.brushPresetId        = preset.id;
  stroke.stampKind            = preset.stampKind;
  stroke.hardness             = preset.hardness;
  stroke.spacing              = preset.spacing;
  stroke.flow                 = preset.flow;
  stroke.opacity              = preset.opacity;
  stroke.opacityMode          = preset.opacityMode;
  stroke.aspect               = preset.aspect;
  stroke.angle                = { ...preset.angle };
  stroke.velocityWidthFactor  = preset.velocityWidthFactor;
  stroke.chiselEdgeLift       = preset.chiselEdgeLift;
  stroke.chiselCenterDip      = preset.chiselCenterDip;
  stroke.chiselFiber          = preset.chiselFiber ?? 0;
  stroke.crayonGrain          = preset.crayonGrain ?? 0;
  stroke.scatter              = preset.scatter ? { ...preset.scatter } : null;
}
