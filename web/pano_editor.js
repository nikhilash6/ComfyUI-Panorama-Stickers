import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  attachCutoutPreview,
  attachPreviewNode,
  attachStickersNodePreview,
} from "./pano_node_preview.js";
import { isPanoramaPreviewNodeName } from "./pano_preview_identity.js";
import { drawCutoutProjectionPreview } from "./pano_cutout_projection.js";
import { renderCutoutViewToContext2D, renderErpViewToContext2D, renderSceneToContext2D } from "./pano_gl_viewport.js";
import { createPanoInteractionController } from "./pano_interaction_controller.js";
import { clamp, wrapYaw, shortestYawDelta } from "./pano_math.js";
import { BRUSH_PRESETS, DEFAULT_BRUSH_PRESET_ID, applyPresetToStroke } from "./pano_brush_presets.js";
import { createHistoryController } from "./pano_paint_history.js";
import { createPaintEngineManager } from "./pano_paint_engine.js";
import { normalizePaintingState } from "./pano_paint_types.js";
import {
  buildCutoutViewParamsFromShot,
  buildPanoramaViewParamsFromEditor,
  buildStickerSceneFromState,
  buildStickerTexturesFromState,
} from "./pano_gl_scene.js";

const STATE_WIDGET = "state_json";
const EXTERNAL_STICKER_ID = "sticker_image_1";
const EXTERNAL_STICKER_SOURCE_KIND = "external_image";
const EXTERNAL_STICKER_PREVIEW_KEY = "pano_sticker_input_images";
const ENABLE_STICKERS_NODE_PREVIEW = false;
const PAINT_COLOR_SWATCHES = [
  { id: "green", label: "Green", color: { r: 0, g: 1, b: 0, a: 1 } },
  { id: "red", label: "Red", color: { r: 1, g: 0, b: 0, a: 1 } },
  { id: "blue", label: "Blue", color: { r: 0, g: 0, b: 1, a: 1 } },
  { id: "black", label: "Black", color: { r: 0, g: 0, b: 0, a: 1 } },
  { id: "white", label: "White", color: { r: 1, g: 1, b: 1, a: 1 } },
];
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

// Global registry: nodeId → Promise for in-flight paint layer uploads.
// beforeQueuePrompt waits for all pending promises before sending the graph.
const _paintLayerUploadRegistry = new Map();
const ICON = {
  // Source: @geist-ui/icons globe.js (v1.0.2)
  globe: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' shape-rendering='geometricPrecision'><circle cx='12' cy='12' r='10'/><path d='M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z'/></svg>",
  pano: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M1.5 8.2c1.9-2.2 4.1-3.3 6.5-3.3s4.6 1.1 6.5 3.3'/><path d='M2.6 10.9c1.5-1.5 3.3-2.3 5.4-2.3s3.9.8 5.4 2.3'/><circle cx='8' cy='12.2' r='1' fill='currentColor' stroke='none'/></svg>",
  unwrap: "<svg viewBox='0 0 16 16' aria-hidden='true'><rect x='1.75' y='3' width='12.5' height='10' rx='2'/><path d='M5.9 3v10M10.1 3v10'/></svg>",
  undo: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M5.5 4.3 2.8 7l2.7 2.7'/><path d='M3.1 7h5.3a3.7 3.7 0 1 1 0 7.4'/></svg>",
  redo: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='m10.5 4.3 2.7 2.7-2.7 2.7'/><path d='M12.9 7H7.6a3.7 3.7 0 1 0 0 7.4'/></svg>",
  add: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M8 3.1v9.8M3.1 8h9.8'/></svg>",
  clear: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M2.8 4.4h10.4'/><path d='m5.8 4.4.6-1.4h3.2l.6 1.4'/><path d='M4.5 4.4v8a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-8'/><path d='M6.7 6.5v4.7M9.3 6.5v4.7'/></svg>",
  duplicate: "<svg viewBox='0 0 16 16' aria-hidden='true'><rect x='5.3' y='5.3' width='7.7' height='7.7' rx='1.4'/><rect x='3' y='3' width='7.7' height='7.7' rx='1.4'/></svg>",
  bring_front: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M6 12V4'/><path d='m4.4 5.6 1.6-1.6 1.6 1.6'/><path d='M9.5 11h3.1M9.5 8h2.2M9.5 5h1.2'/></svg>",
  send_back: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M6 4v8'/><path d='m4.4 10.4 1.6 1.6 1.6-1.6'/><path d='M9.5 11h1.2M9.5 8h2.2M9.5 5h3.1'/></svg>",
  aspect: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M14.866 14.7041C13.9131 14.5727 12.9574 14.4687 12 14.3923V12.8876C12.8347 12.9523 13.6683 13.0373 14.4999 13.1426L14.5 9.00003H16L15.9999 14L15.9999 14.8605L15.1475 14.7429L14.866 14.7041ZM16 7.00003L16 2.49996L16 1.6394L15.1475 1.75699L14.866 1.79581C13.9131 1.92725 12.9574 2.03119 12 2.10765V3.61228C12.8347 3.54757 13.6683 3.46256 14.5 3.35727L14.5 7.00003H16ZM9.99998 2.22729V3.72844C8.66715 3.77999 7.33282 3.77999 5.99998 3.72844V2.22729C7.33279 2.28037 8.66718 2.28037 9.99998 2.22729ZM9.99998 14.2726V12.7715C8.66715 12.7199 7.33282 12.7199 5.99998 12.7715V14.2726C7.33279 14.2195 8.66718 14.2195 9.99998 14.2726ZM3.99998 14.3923C3.04258 14.4687 2.08683 14.5727 1.13391 14.7041L0.85242 14.7429L-0.0000610352 14.8605L-0.0000578761 14L-0.0000396322 9.00003H1.49996L1.49995 13.1426C2.33162 13.0373 3.16521 12.9523 3.99998 12.8876V14.3923ZM1.49997 7.00003L1.49998 3.35727C2.33164 3.46256 3.16522 3.54757 3.99998 3.61228V2.10765C3.0426 2.03119 2.08686 1.92725 1.13395 1.79581L0.852462 1.75699L-0.0000127554 1.6394L-0.0000159144 2.49995L-0.0000323345 7.00003H1.49997Z' fill='currentColor'/></svg>",
  rotate_90: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M6.21967 4.71967L5.68934 5.25L6.75 6.31066L7.28033 5.78033L9.25 3.81066V13.5C9.25 13.6381 9.13807 13.75 9 13.75H2.75H2V15.25H2.75H9C9.9665 15.25 10.75 14.4665 10.75 13.5V3.81066L12.7197 5.78033L13.25 6.31066L14.3107 5.25L13.7803 4.71967L10.5303 1.46967C10.2374 1.17678 9.76256 1.17678 9.46967 1.46967L6.21967 4.71967Z' fill='currentColor'/></svg>",
  back_initial: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M3 14V2.5' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5'/><path d='M4.5 3.5h6.2l-1.6 2.2 1.6 2.2H4.5z' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5'/><path d='M12.8 12.2H7.2' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5'/><path d='m8.9 10.6-1.7 1.6 1.7 1.6' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5'/></svg>",
  delete: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M2.8 4.4h10.4'/><path d='m5.8 4.4.6-1.4h3.2l.6 1.4'/><path d='M4.5 4.4v8a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-8'/><path d='M6.7 6.5v4.7M9.3 6.5v4.7'/></svg>",
  reset: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M8 3.2a4.8 4.8 0 1 1-4.8 4.8'/><path d='M3.2 3.2v3.6h3.6'/></svg>",
  eye: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M4.02168 4.76932C6.11619 2.33698 9.88374 2.33698 11.9783 4.76932L14.7602 7.99999L11.9783 11.2307C9.88374 13.663 6.1162 13.663 4.02168 11.2307L1.23971 7.99999L4.02168 4.76932ZM13.1149 3.79054C10.422 0.663244 5.57797 0.663247 2.88503 3.79054L-0.318359 7.5106V8.48938L2.88503 12.2094C5.57797 15.3367 10.422 15.3367 13.1149 12.2094L16.3183 8.48938V7.5106L13.1149 3.79054ZM6.49997 7.99999C6.49997 7.17157 7.17154 6.49999 7.99997 6.49999C8.82839 6.49999 9.49997 7.17157 9.49997 7.99999C9.49997 8.82842 8.82839 9.49999 7.99997 9.49999C7.17154 9.49999 6.49997 8.82842 6.49997 7.99999ZM7.99997 4.99999C6.34311 4.99999 4.99997 6.34314 4.99997 7.99999C4.99997 9.65685 6.34311 11 7.99997 11C9.65682 11 11 9.65685 11 7.99999C11 6.34314 9.65682 4.99999 7.99997 4.99999Z' fill='currentColor'/></svg>",
  eye_dashed: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M6.51404 3.15793C7.48217 2.87411 8.51776 2.87411 9.48589 3.15793L9.90787 1.71851C8.66422 1.35392 7.33571 1.35392 6.09206 1.71851L6.51404 3.15793ZM10.848 3.78166C11.2578 4.04682 11.6393 4.37568 11.9783 4.76932L13.046 6.00934L14.1827 5.03056L13.1149 3.79054C12.6818 3.28761 12.1918 2.86449 11.6628 2.52224L10.848 3.78166ZM4.02168 4.76932C4.36065 4.37568 4.74209 4.04682 5.15195 3.78166L4.33717 2.52225C3.80815 2.86449 3.3181 3.28761 2.88503 3.79054L1.81723 5.03056L2.95389 6.00934L4.02168 4.76932ZM14.1138 7.24936L14.7602 7.99999L14.1138 8.75062L15.2505 9.72941L16.3183 8.48938V7.5106L15.2505 6.27058L14.1138 7.24936ZM1.88609 7.24936L1.23971 7.99999L1.88609 8.75062L0.749437 9.72941L-0.318359 8.48938V7.5106L0.749436 6.27058L1.88609 7.24936ZM13.0461 9.99064L11.9783 11.2307C11.6393 11.6243 11.2578 11.9532 10.848 12.2183L11.6628 13.4777C12.1918 13.1355 12.6818 12.7124 13.1149 12.2094L14.1827 10.9694L13.0461 9.99064ZM4.02168 11.2307L2.95389 9.99064L1.81723 10.9694L2.88503 12.2094C3.3181 12.7124 3.80815 13.1355 4.33717 13.4777L5.15195 12.2183C4.7421 11.9532 4.36065 11.6243 4.02168 11.2307ZM9.90787 14.2815L9.48589 12.8421C8.51776 13.1259 7.48217 13.1259 6.51405 12.8421L6.09206 14.2815C7.33572 14.6461 8.66422 14.6461 9.90787 14.2815ZM6.49997 7.99999C6.49997 7.17157 7.17154 6.49999 7.99997 6.49999C8.82839 6.49999 9.49997 7.17157 9.49997 7.99999C9.49997 8.82842 8.82839 9.49999 7.99997 9.49999C7.17154 9.49999 6.49997 8.82842 6.49997 7.99999ZM7.99997 4.99999C6.34311 4.99999 4.99997 6.34314 4.99997 7.99999C4.99997 9.65685 6.34311 11 7.99997 11C9.65682 11 11 9.65685 11 7.99999C11 6.34314 9.65682 4.99999 7.99997 4.99999Z' fill='currentColor'/></svg>",
  fullscreen: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z' fill='currentColor'/></svg>",
  camera: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M1.5 3.5H3.5L5 1H11L12.5 3.5H14.5H16V5V12.5C16 13.8807 14.8807 15 13.5 15H2.5C1.11929 15 0 13.8807 0 12.5V5V3.5H1.5ZM4.78624 4.27174L5.84929 2.5H10.1507L11.2138 4.27174L11.6507 5H12.5H14.5V12.5C14.5 13.0523 14.0523 13.5 13.5 13.5H2.5C1.94772 13.5 1.5 13.0523 1.5 12.5V5H3.5H4.34929L4.78624 4.27174ZM9.75 8.5C9.75 9.4665 8.9665 10.25 8 10.25C7.0335 10.25 6.25 9.4665 6.25 8.5C6.25 7.5335 7.0335 6.75 8 6.75C8.9665 6.75 9.75 7.5335 9.75 8.5ZM11.25 8.5C11.25 10.2949 9.79493 11.75 8 11.75C6.20507 11.75 4.75 10.2949 4.75 8.5C4.75 6.70507 6.20507 5.25 8 5.25C9.79493 5.25 11.25 6.70507 11.25 8.5Z' fill='currentColor'/></svg>",
  // Source: vercel.com/geist/icons
  plus_circle: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M14.5 8C14.5 11.5899 11.5899 14.5 8 14.5C4.41015 14.5 1.5 11.5899 1.5 8C1.5 4.41015 4.41015 1.5 8 1.5C11.5899 1.5 14.5 4.41015 14.5 8ZM16 8C16 12.4183 12.4183 16 8 16C3.58172 16 0 12.4183 0 8C0 3.58172 3.58172 0 8 0C12.4183 0 16 3.58172 16 8ZM8.75 4.25V5V7.25H11H11.75V8.75H11H8.75V11V11.75L7.25 11.75V11V8.75H5H4.25V7.25H5H7.25V5V4.25H8.75Z' fill='currentColor'/></svg>",
  crosshair: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M7.25 11.75L7.25 14.4572C4.2595 14.1136 1.88638 11.7405 1.5428 8.75H4.25H5V7.25H4.25H1.5428C1.88638 4.2595 4.2595 1.88638 7.25 1.5428V4.25V5H8.75V4.25V1.5428C11.7405 1.88638 14.1136 4.2595 14.4572 7.25L11.75 7.25H11V8.75L11.75 8.75H14.4572C14.1136 11.7405 11.7405 14.1136 8.75 14.4572V11.75L8.75 11H7.25V11.75ZM15.9653 8.75C15.6102 12.5697 12.5697 15.6102 8.75 15.9653V16H8H7.25V15.9653C3.43032 15.6102 0.389836 12.5697 0.0346937 8.75H0V8V7.25H0.0346937C0.389836 3.43032 3.43032 0.389836 7.25 0.0346937V0H8H8.75V0.0346937C12.5697 0.389836 15.6102 3.43032 15.9653 7.25H16V8V8.75H15.9653Z' fill='currentColor'/></svg>",
  fullscreen_close: "<svg viewBox='0 0 16 16' aria-hidden='true'><path fill-rule='evenodd' clip-rule='evenodd' d='M6 1V1.75V5C6 5.55229 5.55228 6 5 6H1.75H1V4.5H1.75H4.5V1.75V1H6ZM14.25 6H15V4.5H14.25H11.5V1.75V1H10V1.75V5C10 5.55228 10.4477 6 11 6H14.25ZM10 14.25V15H11.5V14.25V11.5H14.29H15.04V10H14.29H11C10.4477 10 10 10.4477 10 11V14.25ZM1.75 10H1V11.5H1.75H4.5V14.25V15H6V14.25V11C6 10.4477 5.55229 10 5 10H1.75Z' fill='currentColor'/></svg>",
  close: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M3.7 3.7 12.3 12.3M12.3 3.7 3.7 12.3'/></svg>",
  copy: "<svg viewBox='0 0 16 16' aria-hidden='true'><rect x='5.2' y='5.2' width='7.8' height='7.8' rx='1.4'/><rect x='3' y='3' width='7.8' height='7.8' rx='1.4'/></svg>",
  chevron: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='m4.5 6.5 3.5 3.5 3.5-3.5'/></svg>",
  pen: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='m11.8 2.2 2 2-7.6 7.6-2.7.7.7-2.7z'/><path d='m10.7 3.3 2 2'/></svg>",
  mask: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M3 8c1.4-2 3.2-3 5-3s3.6 1 5 3c-1.4 2-3.2 3-5 3S4.4 10 3 8Z'/><path d='M8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3Z'/></svg>",
  cursor_tool: "<svg viewBox='0 0 16 16' aria-hidden='true'><path d='M3 2.5 12.2 8l-4 1.2 1.8 4.3-1.8.8-1.9-4.3-2.6 2.2z' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.35'/></svg>",
  palette_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Z'/><path d='M7 13.5a2.5 2.5 0 0 0 2.5 2.5H11a2 2 0 0 1 0 4h-1'/><circle cx='7.5' cy='8.5' r='.9' fill='currentColor' stroke='none'/><circle cx='12' cy='6.5' r='.9' fill='currentColor' stroke='none'/><circle cx='16.5' cy='8.5' r='.9' fill='currentColor' stroke='none'/></svg>",
  circle_dashed_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='M10.1 2.6A9.9 9.9 0 0 1 13.9 2.6'/><path d='M17.8 4.2a9.9 9.9 0 0 1 2 2.8'/><path d='M21.4 10.1a9.9 9.9 0 0 1 0 3.8'/><path d='M19.8 17.8a9.9 9.9 0 0 1-2.8 2'/><path d='M13.9 21.4a9.9 9.9 0 0 1-3.8 0'/><path d='M6.2 19.8a9.9 9.9 0 0 1-2-2.8'/><path d='M2.6 13.9a9.9 9.9 0 0 1 0-3.8'/><path d='M4.2 6.2a9.9 9.9 0 0 1 2.8-2'/></svg>",
  pencil_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='m3 21 3.8-1 10-10a2.1 2.1 0 0 0-3-3L3.8 17z'/><path d='m14.5 6.5 3 3'/></svg>",
  brush_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='M14.5 4.5c1.4-1.4 3.6-1.4 5 0s1.4 3.6 0 5l-5.7 5.7c-.5.5-1.2.8-1.9.8H9.8'/><path d='M9.5 13.5c-2.5 0-4.5 2-4.5 4.5 0 1-.8 1.8-1.8 1.8H3'/><path d='M8.5 12.5 11 15'/></svg>",
  // Source: Lucide paintbrush-vertical
  paintbrush_vertical_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='2'><path d='M10 2v2'/><path d='M14 2v4'/><path d='M17 2a1 1 0 0 1 1 1v9H6V3a1 1 0 0 1 1-1z'/><path d='M6 12a1 1 0 0 0-1 1v1a2 2 0 0 0 2 2h2a1 1 0 0 1 1 1v2.9a2 2 0 1 0 4 0V17a1 1 0 0 1 1-1h2a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1'/></svg>",
  highlighter_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='m14 4 6 6'/><path d='m4 20 4.5-1 9-9-3.5-3.5-9 9z'/><path d='M13 7 17 11'/><path d='M3 21h7'/></svg>",
  spray_can_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='M10 6h6'/><path d='M12 3h2a2 2 0 0 1 2 2v1'/><path d='M9 8h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z'/><path d='M5 10h.01'/><path d='M3 14h.01'/><path d='M5 18h.01'/></svg>",
  eraser_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='m7 13.5 6.8-6.8a2.2 2.2 0 0 1 3.1 0l2.4 2.4a2.2 2.2 0 0 1 0 3.1l-6.8 6.8a2.2 2.2 0 0 1-1.5.6H7.8a2.2 2.2 0 0 1-1.6-.6l-1.5-1.5a2.2 2.2 0 0 1 0-3.1L7 13.5Z'/><path d='M13.5 19.5H21'/></svg>",
  lasso_tool: "<svg viewBox='0 0 24 24' aria-hidden='true' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.75'><path d='M7.2 18.8C4.6 18 3 16.2 3 14c0-3.9 4-7 9-7s9 3.1 9 7-4 7-9 7c-1.1 0-2.2-.1-3.1-.4'/><path d='M7 17c1 0 1.8.8 1.8 1.8S8 20.6 7 20.6s-1.8-.8-1.8-1.8S6 17 7 17Z'/></svg>",
};

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeInCubic(t) {
  return t * t * t;
}
function vec3(x, y, z) { return { x, y, z }; }
function add(a, b) { return vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
function mul(a, s) { return vec3(a.x * s, a.y * s, a.z * s); }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}
function norm(a) {
  const l = Math.hypot(a.x, a.y, a.z) || 1e-8;
  return vec3(a.x / l, a.y / l, a.z / l);
}
function yawPitchToDir(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG2RAD;
  const pitch = pitchDeg * DEG2RAD;
  const cp = Math.cos(pitch);
  return vec3(cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw));
}
function dirToYawPitch(d) {
  return {
    yaw: wrapYaw(Math.atan2(d.x, d.z) * RAD2DEG),
    pitch: clamp(Math.asin(clamp(d.y, -1, 1)) * RAD2DEG, -90, 90),
  };
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x; const yi = poly[i].y;
    const xj = poly[j].x; const yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y))
      && (pt.x < ((xj - xi) * (pt.y - yi)) / ((yj - yi) || 1e-6) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function colorToCss(color, alphaOverride = null) {
  const alpha = alphaOverride == null ? Number(color?.a ?? 1) : Number(alphaOverride);
  return `rgba(${Math.round(clamp(Number(color?.r ?? 0), 0, 1) * 255)}, ${Math.round(clamp(Number(color?.g ?? 0), 0, 1) * 255)}, ${Math.round(clamp(Number(color?.b ?? 0), 0, 1) * 255)}, ${clamp(alpha, 0, 1)})`;
}
function colorsApproximatelyEqual(a, b, eps = 0.015) {
  if (!a || !b) return false;
  return Math.abs(Number(a.r ?? 0) - Number(b.r ?? 0)) <= eps
    && Math.abs(Number(a.g ?? 0) - Number(b.g ?? 0)) <= eps
    && Math.abs(Number(a.b ?? 0) - Number(b.b ?? 0)) <= eps
    && Math.abs(Number(a.a ?? 1) - Number(b.a ?? 1)) <= eps;
}
function cloneColor(color) {
  return {
    r: clamp(Number(color?.r ?? 0), 0, 1),
    g: clamp(Number(color?.g ?? 0), 0, 1),
    b: clamp(Number(color?.b ?? 0), 0, 1),
    a: clamp(Number(color?.a ?? 1), 0, 1),
  };
}
function isPresetPaintColor(color) {
  return PAINT_COLOR_SWATCHES.some((swatch) => colorsApproximatelyEqual(color, swatch.color));
}
function hsv01ToRgb(h, s, v) {
  const hue = ((Number(h) % 1) + 1) % 1;
  const sat = clamp(Number(s), 0, 1);
  const val = clamp(Number(v), 0, 1);
  if (sat <= 1e-6) return { r: val, g: val, b: val };
  const i = Math.floor(hue * 6);
  const f = hue * 6 - i;
  const p = val * (1 - sat);
  const q = val * (1 - f * sat);
  const t = val * (1 - (1 - f) * sat);
  switch (i % 6) {
    case 0: return { r: val, g: t, b: p };
    case 1: return { r: q, g: val, b: p };
    case 2: return { r: p, g: val, b: t };
    case 3: return { r: p, g: q, b: val };
    case 4: return { r: t, g: p, b: val };
    default: return { r: val, g: p, b: q };
  }
}
function rgb01ToHsv(color) {
  const r = clamp(Number(color?.r ?? 0), 0, 1);
  const g = clamp(Number(color?.g ?? 0), 0, 1);
  const b = clamp(Number(color?.b ?? 0), 0, 1);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 1e-6) {
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / delta + 2) / 6;
    else h = ((r - g) / delta + 4) / 6;
  }
  const s = max <= 1e-6 ? 0 : delta / max;
  return { h, s, v: max };
}
function formatParamValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return Number(n.toFixed(3)).toString();
}
function toPositiveFinite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Number(fallback);
}
function ratioTextFromPair(w, h) {
  const ww = toPositiveFinite(w, 1);
  const hh = toPositiveFinite(h, 1);
  if (ww <= 0 || hh <= 0) return "1:1";
  const scale = 1000;
  const wi = Math.max(1, Math.round(ww * scale));
  const hi = Math.max(1, Math.round(hh * scale));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(wi, hi) || 1;
  const rw = Math.max(1, Math.round(wi / g));
  const rh = Math.max(1, Math.round(hi / g));
  return `${rw}:${rh}`;
}
function getCutoutAspectLabel(item) {
  if (!item || typeof item !== "object") return "1:1";
  const stored = String(item.aspect_id || "").trim();
  if (stored) return stored;
  const ow = toPositiveFinite(item.out_w, 0);
  const oh = toPositiveFinite(item.out_h, 0);
  if (ow > 0 && oh > 0) return ratioTextFromPair(ow, oh);
  const hf = clamp(Number(item.hFOV_deg || 90), 1, 179) * DEG2RAD;
  const vf = clamp(Number(item.vFOV_deg || 60), 1, 179) * DEG2RAD;
  const rw = Math.max(1e-6, Math.tan(hf * 0.5));
  const rh = Math.max(1e-6, Math.tan(vf * 0.5));
  return ratioTextFromPair(rw, rh);
}
function expandTri(d0, d1, d2, px = 1.1) {
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = (p) => {
    const vx = p.x - cx;
    const vy = p.y - cy;
    const ll = Math.hypot(vx, vy) || 1;
    return { x: p.x + (vx / ll) * px, y: p.y + (vy / ll) * px };
  };
  return [grow(d0), grow(d1), grow(d2)];
}

function installCss() {
  if (document.getElementById("pano-suite-style-link")) return;
  const link = document.createElement("link");
  link.id = "pano-suite-style-link";
  link.rel = "stylesheet";
  link.href = new URL("./pano_editor.css", import.meta.url).toString();
  document.head.appendChild(link);
}

const SHARED_UI_SETTINGS_KEY = "pano_suite.ui_settings.v1";
const NODE_GRID_VISIBILITY_KEY = "pano_suite.node_grid_visibility.v1";
let sharedUiSettingsMemory = null;
let nodeGridVisibilityMemory = null;
let parseStateJsonCache = { text: null, parsed: null };

function normalizeUiSettings(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const q = String(src.preview_quality || "balanced");
  return {
    invert_view_x: !!src.invert_view_x,
    invert_view_y: !!src.invert_view_y,
    preview_quality: (q === "draft" || q === "balanced" || q === "high") ? q : "balanced",
  };
}

function loadSharedUiSettings() {
  try {
    const text = String(window?.localStorage?.getItem(SHARED_UI_SETTINGS_KEY) || "").trim();
    if (!text) return sharedUiSettingsMemory ? normalizeUiSettings(sharedUiSettingsMemory) : null;
    const parsed = JSON.parse(text);
    const normalized = normalizeUiSettings(parsed);
    sharedUiSettingsMemory = normalized;
    return normalized;
  } catch {
    return sharedUiSettingsMemory ? normalizeUiSettings(sharedUiSettingsMemory) : null;
  }
}

function saveSharedUiSettings(settings) {
  const normalized = normalizeUiSettings(settings);
  sharedUiSettingsMemory = normalized;
  try {
    window?.localStorage?.setItem(SHARED_UI_SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // localStorage unavailable; memory fallback is used.
  }
  return normalized;
}

function loadNodeGridVisibilityMap() {
  if (nodeGridVisibilityMemory && typeof nodeGridVisibilityMemory === "object") {
    return nodeGridVisibilityMemory;
  }
  try {
    const text = String(window?.localStorage?.getItem(NODE_GRID_VISIBILITY_KEY) || "").trim();
    if (!text) {
      nodeGridVisibilityMemory = {};
      return nodeGridVisibilityMemory;
    }
    const parsed = JSON.parse(text);
    nodeGridVisibilityMemory = parsed && typeof parsed === "object" ? parsed : {};
    return nodeGridVisibilityMemory;
  } catch {
    nodeGridVisibilityMemory = {};
    return nodeGridVisibilityMemory;
  }
}

function getNodeGridVisibility(nodeId, fallback = true) {
  const key = String(nodeId ?? "").trim();
  if (!key) return !!fallback;
  const map = loadNodeGridVisibilityMap();
  const v = map[key];
  return typeof v === "boolean" ? v : !!fallback;
}

function setNodeGridVisibility(nodeId, visible) {
  const key = String(nodeId ?? "").trim();
  if (!key) return;
  const map = loadNodeGridVisibilityMap();
  map[key] = !!visible;
  nodeGridVisibilityMemory = map;
  try {
    window?.localStorage?.setItem(NODE_GRID_VISIBILITY_KEY, JSON.stringify(map));
  } catch {
    // localStorage unavailable; memory fallback is used.
  }
}

function cloneAssetMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  Object.entries(raw).forEach(([k, v]) => {
    out[k] = (v && typeof v === "object") ? { ...v } : v;
  });
  return out;
}

function cloneStickerList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (!item || typeof item !== "object") return item;
    const next = { ...item };
    if (next.crop && typeof next.crop === "object") next.crop = { ...next.crop };
    if (next.initial_pose && typeof next.initial_pose === "object") next.initial_pose = { ...next.initial_pose };
    next.visible = next.visible !== false;
    return next;
  });
}

function paintingStrokeCount(painting) {
  const paintCount = Array.isArray(painting?.paint?.strokes) ? painting.paint.strokes.length : 0;
  const maskCount = Array.isArray(painting?.mask?.strokes) ? painting.mask.strokes.length : 0;
  return { paintCount, maskCount };
}

function makePaintId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeEditorHistory(raw) {
  if (!raw || typeof raw !== "object") {
    return { version: 1, entries: [], index: -1 };
  }
  const entries = Array.isArray(raw.entries) ? raw.entries.map((entry) => String(entry || "")) : [];
  const index = Number.isInteger(Number(raw.index)) ? Number(raw.index) : (entries.length - 1);
  return {
    version: 1,
    entries,
    index: Math.max(-1, Math.min(entries.length - 1, index)),
  };
}

function cloneStateForHistorySnapshot(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const next = JSON.parse(JSON.stringify(raw));
  delete next.editor_history;
  delete next.painting_layer;
  return next;
}

function cloneShotList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ((item && typeof item === "object") ? { ...item } : item));
}

function parseState(text, preset = 2048, bg = "#00ff00") {
  const sharedUi = loadSharedUiSettings();
  const base = {
    version: 1,
    projection_model: "pinhole_rectilinear",
    alpha_mode: "straight",
    bg_color: bg,
    output_preset: preset,
    assets: {},
    stickers: [],
    shots: [],
    painting: normalizePaintingState(null),
    painting_layer: null,
    ui_settings: {
      invert_view_x: !!sharedUi?.invert_view_x,
      invert_view_y: !!sharedUi?.invert_view_y,
      preview_quality: String(sharedUi?.preview_quality || "balanced"),
    },
    active: { selected_sticker_id: null, selected_shot_id: null },
  };
  const textTrimmed = String(text || "").trim();
  if (!textTrimmed) return base;
  try {
    let p = null;
    if (parseStateJsonCache.text === textTrimmed) {
      p = parseStateJsonCache.parsed;
    } else {
      p = JSON.parse(textTrimmed);
      parseStateJsonCache = { text: textTrimmed, parsed: p };
    }
    if (!p || typeof p !== "object") return base;
    const merged = {
      ...base,
      ...p,
      version: 1,
      projection_model: "pinhole_rectilinear",
      alpha_mode: "straight",
      assets: cloneAssetMap(p.assets),
      stickers: cloneStickerList(p.stickers),
      shots: cloneShotList(p.shots),
      // source of truth persists target-local stroke geometry, never view coordinates.
      painting: normalizePaintingState(p.painting),
      painting_layer: (p.painting_layer && typeof p.painting_layer === "object") ? p.painting_layer : null,
      ui_settings: {
        invert_view_x: !!(p.ui_settings && p.ui_settings.invert_view_x),
        invert_view_y: !!(p.ui_settings && p.ui_settings.invert_view_y),
        preview_quality: (() => {
          const q = String(p.ui_settings?.preview_quality || "balanced");
          return (q === "draft" || q === "balanced" || q === "high") ? q : "balanced";
        })(),
      },
      active: p.active && typeof p.active === "object" ? { ...p.active } : { ...base.active },
    };
    if (sharedUi) {
      merged.ui_settings = normalizeUiSettings({ ...merged.ui_settings, ...sharedUi });
    }
    delete merged.editor_history;
    return merged;
  } catch {
    parseStateJsonCache = { text: textTrimmed, parsed: null };
    return base;
  }
}

function cameraBasis(yawDeg, pitchDeg, rollDeg = 0) {
  const fwd = yawPitchToDir(yawDeg, pitchDeg);
  const worldUp = vec3(0, 1, 0);
  let right = cross(worldUp, fwd);
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) right = vec3(1, 0, 0);
  right = norm(right);
  let up = norm(cross(fwd, right));
  const rr = rollDeg * DEG2RAD;
  const cr = Math.cos(rr);
  const sr = Math.sin(rr);
  const r2 = add(mul(right, cr), mul(up, sr));
  const u2 = add(mul(right, -sr), mul(up, cr));
  return { fwd, right: norm(r2), up: norm(u2) };
}

function stickerCornerDirs(item) {
  const hf = clamp(Number(item.hFOV_deg || 30), 1, 179) * DEG2RAD;
  const vf = clamp(Number(item.vFOV_deg || 30), 1, 179) * DEG2RAD;
  const tx = Math.tan(hf * 0.5);
  const ty = Math.tan(vf * 0.5);
  const { fwd, right, up } = cameraBasis(
    Number(item.yaw_deg || 0),
    Number(item.pitch_deg || 0),
    Number(item.rot_deg || item.roll_deg || 0),
  );
  const mk = (x, y) => norm(add(add(fwd, mul(right, x * tx)), mul(up, y * ty)));
  return [
    mk(-1, 1),
    mk(1, 1),
    mk(1, -1),
    mk(-1, -1),
  ];
}

function getNodePreviewImage(node, assetId, asset) {
  if (!node.__panoPreviewImageCache) node.__panoPreviewImageCache = new Map();
  const key = String(assetId || "");
  if (!key) return null;
  const src = stickerAssetToPreviewSrc(asset);
  if (!src) return null;
  const cached = node.__panoPreviewImageCache.get(key);
  if (cached && cached.src === src) return cached.img;
  const img = new Image();
  img.src = src;
  img.onload = () => {
    node.setDirtyCanvas?.(true, true);
  };
  node.__panoPreviewImageCache.set(key, { src, img });
  return img;
}

function drawImageTriPreview(ctx, img, s0, s1, s2, d0, d1, d2) {
  const den = (s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y));
  if (Math.abs(den) < 1e-6) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  const m11 = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / den;
  const m12 = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / den;
  const m13 = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / den;
  const m21 = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / den;
  const m22 = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / den;
  const m23 = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / den;
  ctx.transform(m11, m21, m12, m22, m13, m23);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function projectDirToPreview(dir, viewBasis, rect, tanHalfY) {
  const cx = dot(dir, viewBasis.right);
  const cy = dot(dir, viewBasis.up);
  const cz = dot(dir, viewBasis.fwd);
  if (cz <= 1e-4) return null;
  const sy = (cy / cz) / tanHalfY;
  const sx = (cx / cz) / tanHalfY;
  return {
    x: rect.x + rect.w * 0.5 + sx * rect.h * 0.5,
    y: rect.y + rect.h * 0.5 - sy * rect.h * 0.5,
  };
}

function drawLatLonGrid(ctx, rect, viewBasis, tanHalfY) {
  const drawLine = (pts, color, width = 1) => {
    let open = false;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const p of pts) {
      if (!p) {
        open = false;
        continue;
      }
      if (!open) {
        ctx.moveTo(p.x, p.y);
        open = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
  };
  const lonVals = [];
  for (let lon = -180; lon <= 180; lon += 15) lonVals.push(lon);
  const latVals = [];
  for (let lat = -75; lat <= 75; lat += 15) latVals.push(lat);
  lonVals.forEach((lonDeg) => {
    const pts = [];
    for (let latDeg = -85; latDeg <= 85; latDeg += 4) {
      const lat = latDeg * DEG2RAD;
      const lon = lonDeg * DEG2RAD;
      const d = vec3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      pts.push(projectDirToPreview(d, viewBasis, rect, tanHalfY));
    }
    drawLine(pts, "rgba(61, 61, 66, 0.88)", lonDeg % 90 === 0 ? 1.3 : 1);
  });
  latVals.forEach((latDeg) => {
    const pts = [];
    for (let lonDeg = -180; lonDeg <= 180; lonDeg += 4) {
      const lat = latDeg * DEG2RAD;
      const lon = lonDeg * DEG2RAD;
      const d = vec3(Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
      pts.push(projectDirToPreview(d, viewBasis, rect, tanHalfY));
    }
    drawLine(pts, latDeg === 0 ? "rgba(250, 250, 250, 0.86)" : "rgba(61, 61, 66, 0.88)", latDeg === 0 ? 1.5 : 1);
  });
}

function drawStickerPreviewPano(ctx, node, rect, viewBasis, tanHalfY, state, item) {
  const hf = clamp(Number(item.hFOV_deg || 30), 1, 179) * DEG2RAD;
  const vf = clamp(Number(item.vFOV_deg || 30), 1, 179) * DEG2RAD;
  const tx = Math.tan(hf * 0.5);
  const ty = Math.tan(vf * 0.5);
  const crop = item.crop || {};
  const c0x = clamp(Number(crop.x0 ?? 0), 0, 1);
  const c0y = clamp(Number(crop.y0 ?? 0), 0, 1);
  const c1x = clamp(Number(crop.x1 ?? 1), 0, 1);
  const c1y = clamp(Number(crop.y1 ?? 1), 0, 1);
  const cw = Math.max(1e-4, c1x - c0x);
  const ch = Math.max(1e-4, c1y - c0y);
  const basis = cameraBasis(
    Number(item.yaw_deg || 0),
    Number(item.pitch_deg || 0),
    Number(item.rot_deg || item.roll_deg || 0),
  );
  const Nu = 12;
  const Nv = 9;
  const verts = Array.from({ length: Nv + 1 }, () => Array(Nu + 1).fill(null));
  const sample = Array.from({ length: Nv + 1 }, () => Array(Nu + 1).fill(null));
  for (let j = 0; j <= Nv; j += 1) {
    for (let i = 0; i <= Nu; i += 1) {
      const u = i / Nu;
      const v = j / Nv;
      const uu = c0x + u * cw;
      const vv = c0y + v * ch;
      const x = (uu * 2 - 1) * tx;
      const y = (1 - vv * 2) * ty;
      const d = norm(add(add(basis.fwd, mul(basis.right, x)), mul(basis.up, y)));
      verts[j][i] = projectDirToPreview(d, viewBasis, rect, tanHalfY);
      sample[j][i] = { x: u, y: v };
    }
  }

  const asset = state.assets?.[item.asset_id];
  const img = getNodePreviewImage(node, item.asset_id, asset);
  const iw = Math.max(1, Number(img?.naturalWidth || img?.width || 1));
  const ih = Math.max(1, Number(img?.naturalHeight || img?.height || 1));
  for (let j = 0; j < Nv; j += 1) {
    for (let i = 0; i < Nu; i += 1) {
      const p00 = verts[j][i];
      const p10 = verts[j][i + 1];
      const p01 = verts[j + 1][i];
      const p11 = verts[j + 1][i + 1];
      if (!p00 || !p10 || !p01 || !p11) continue;
      if (img && img.complete && (img.naturalWidth || 0) > 0) {
        const s00 = { x: sample[j][i].x * iw, y: sample[j][i].y * ih };
        const s10 = { x: sample[j][i + 1].x * iw, y: sample[j][i + 1].y * ih };
        const s01 = { x: sample[j + 1][i].x * iw, y: sample[j + 1][i].y * ih };
        const s11 = { x: sample[j + 1][i + 1].x * iw, y: sample[j + 1][i + 1].y * ih };
        drawImageTriPreview(ctx, img, s00, s10, s11, p00, p10, p11);
        drawImageTriPreview(ctx, img, s00, s11, s01, p00, p11, p01);
      } else {
        ctx.fillStyle = "rgba(0, 112, 243, 0.20)";
        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y);
        ctx.lineTo(p10.x, p10.y);
        ctx.lineTo(p11.x, p11.y);
        ctx.lineTo(p01.x, p01.y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  const corners = stickerCornerDirs(item).map((d) => projectDirToPreview(d, viewBasis, rect, tanHalfY));
  if (corners.every((p) => !!p)) {
    ctx.strokeStyle = "rgba(250, 250, 250, 0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.stroke();
  }
}

function drawPanoramaNodePreview(node, ctx) {
  const stateWidget = getWidget(node, STATE_WIDGET);
  const raw = String(stateWidget?.value || "");
  const bg = String(getWidget(node, "bg_color")?.value || "#00ff00");
  const state = parseState(raw, 2048, bg);

  const rect = getNodePreviewRect(node);
  if (!rect) return;
  if (!node.__panoPreviewView) {
    const selectedId = state.active?.selected_sticker_id || null;
    const selected = (state.stickers || []).find((s) => s.id === selectedId) || null;
    node.__panoPreviewView = {
      yaw: Number(selected?.yaw_deg || 0),
      pitch: Number(selected?.pitch_deg || 0),
      fov: 100,
    };
  }
  applyNodePreviewInertia(node);
  const viewYaw = Number(node.__panoPreviewView.yaw || 0);
  const viewPitch = Number(node.__panoPreviewView.pitch || 0);
  const viewBasis = cameraBasis(viewYaw, viewPitch, 0);
  const tanHalfY = Math.tan((Number(node.__panoPreviewView.fov || 100) * DEG2RAD) * 0.5);

  ctx.save();
  ctx.fillStyle = "#0a0a0a";
  ctx.strokeStyle = "#3f3f46";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.clip();

  ctx.fillStyle = "#070707";
  ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
  drawLatLonGrid(ctx, rect, viewBasis, tanHalfY);

  const stickers = [...(state.stickers || [])].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
  stickers.forEach((item) => drawStickerPreviewPano(ctx, node, rect, viewBasis, tanHalfY, state, item));
  const labels = [
    { name: "Left", dir: yawPitchToDir(-90, 0) },
    { name: "Front", dir: yawPitchToDir(0, 0) },
    { name: "Right", dir: yawPitchToDir(90, 0) },
    { name: "Back", dir: yawPitchToDir(180, 0) },
  ];
  ctx.fillStyle = "rgba(250, 250, 250, 0.48)";
  ctx.font = "500 10px Geist, sans-serif";
  ctx.textAlign = "center";
  labels.forEach((l) => {
    const p = projectDirToPreview(l.dir, viewBasis, rect, tanHalfY);
    if (p) ctx.fillText(l.name, p.x, p.y + 20);
  });

  const fov = Number(node.__panoPreviewView?.fov || 100);
  ctx.textAlign = "left";
  ctx.font = "11px Geist, sans-serif";
  ctx.fillStyle = "rgba(250, 250, 250, 0.88)";
  ctx.fillText(`FOV ${fov.toFixed(1)}`, rect.x + 8, rect.y + rect.h - 10);

  const rb = getNodePreviewResetButtonRect(rect);
  ctx.fillStyle = "rgba(17, 17, 17, 0.92)";
  ctx.strokeStyle = "rgba(82, 82, 91, 0.95)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(rb.x, rb.y, rb.w, rb.h, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(250, 250, 250, 0.92)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "10px Geist, sans-serif";
  ctx.fillText("Reset", rb.x + rb.w * 0.5, rb.y + rb.h * 0.5 + 0.5);
  ctx.textBaseline = "alphabetic";
  ctx.restore();

}

function applyNodePreviewInertia(node, ts = performance.now()) {
  const m = node.__panoPreviewInertia;
  if (!m || !m.active || !node.__panoPreviewView) return;
  const dt = m.lastTs > 0 ? Math.max(0.001, (ts - m.lastTs) / 1000) : (1 / 60);
  m.lastTs = ts;
  node.__panoPreviewView.yaw = wrapYaw(Number(node.__panoPreviewView.yaw || 0) + m.vx * dt);
  node.__panoPreviewView.pitch = clamp(Number(node.__panoPreviewView.pitch || 0) + m.vy * dt, -89.9, 89.9);
  const damping = Math.exp(-5.5 * dt);
  m.vx *= damping;
  m.vy *= damping;
  if (Math.abs(m.vx) < 0.8 && Math.abs(m.vy) < 0.8) {
    m.vx = 0;
    m.vy = 0;
    m.active = false;
  } else {
    node.setDirtyCanvas?.(true, false);
  }
}

function getNodePreviewRect(node) {
  const pad = 8;
  const widgetsBottom = getNodeWidgetsBottom(node);
  const btn = getNodeEditorButtonRect(node);
  const top = btn ? (btn.y + btn.h + 2) : (widgetsBottom + 2);
  const x = pad;
  const w = Math.max(120, Number(node.size?.[0] || 0) - pad * 2);
  const h = Math.max(84, Number(node.size?.[1] || 0) - top - pad);
  if (h < 40 || w < 80) return null;
  return { x, y: top, w, h };
}

function getNodeWidgetsBottom(node) {
  const widgetTop = 32;
  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  let y = widgetTop;
  widgets.forEach((w) => {
    if (!w || w.hidden || w.type === "hidden") return;
    let h = 22;
    try {
      const size = typeof w.computeSize === "function" ? w.computeSize(node.size?.[0] || 0) : null;
      if (Array.isArray(size) && Number.isFinite(Number(size[1]))) h = Number(size[1]);
    } catch {
      h = 22;
    }
    y += h;
  });
  return y;
}

function getNodeEditorButtonRect(node) {
  if (!node?.__panoCustomEditorButton) return null;
  const pad = 8;
  const y = getNodeWidgetsBottom(node) + 2;
  const w = Math.max(120, Number(node.size?.[0] || 0) - pad * 2);
  return { x: pad, y, w, h: 30 };
}

function getNodeAutoHeightWithEditorButton(node) {
  const button = getNodeEditorButtonRect(node);
  if (!button) return Math.ceil(getNodeWidgetsBottom(node) + 40);
  const bottomPad = 8;
  return Math.ceil(button.y + button.h + bottomPad);
}

function drawNodeEditorButton(node, ctx) {
  const r = getNodeEditorButtonRect(node);
  if (!r) return;
  const hover = !!node.__panoEditorBtnHover;
  ctx.save();
  ctx.fillStyle = hover ? "rgba(44, 44, 47, 0.96)" : "rgba(32, 32, 35, 0.96)";
  ctx.strokeStyle = "rgba(98, 98, 105, 0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(244, 244, 246, 0.95)";
  ctx.font = "500 12px Plus Jakarta Sans, Geist, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(node.__panoEditorButtonText || "Open Editor"), r.x + r.w * 0.5, r.y + r.h * 0.5 + 0.5);
  ctx.restore();
}

function pointInRect(x, y, r) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function getNodePreviewResetButtonRect(rect) {
  const w = 50;
  const h = 20;
  const m = 8;
  return {
    x: rect.x + rect.w - w - m,
    y: rect.y + rect.h - h - m,
    w,
    h,
  };
}

function getWidget(node, name) { return node.widgets?.find((w) => w.name === name) || null; }
function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
function getEditorNodeTitle(node, type) {
  const rawType = String(node?.comfyClass || node?.type || node?.title || "").trim();
  const titleMap = {
    PanoramaStickers: "Panorama Stickers",
    "Panorama Stickers": "Panorama Stickers",
    PanoramaCutout: "Panorama Cutout",
    "Panorama Cutout": "Panorama Cutout",
    PanoramaPreview: "Panorama Preview",
    "Panorama Preview": "Panorama Preview",
  };
  if (titleMap[rawType]) return titleMap[rawType];
  if (rawType) return rawType;
  if (type === "cutout") return "Panorama Cutout";
  return "Panorama Stickers";
}
function hideWidget(node, widgetName) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  widgets.forEach((w) => {
    const n = String(w?.name || "");
    if (!(n === widgetName || n.trim() === widgetName || n.toLowerCase().includes(String(widgetName).toLowerCase()))) return;
    if (w.__panoHidden) return;
    w.__panoHidden = true;
    w.computeSize = () => [0, 0];
    w.type = "hidden";
    w.hidden = true;
    w.options = { ...(w.options || {}), hidden: true };
    if (w.inputEl?.style) w.inputEl.style.display = "none";
    if (w.parentEl?.style) w.parentEl.style.display = "none";
  });
}

function ensureActionButtonWidget(node, buttonText, callback) {
  if (!node || typeof node.addWidget !== "function") return null;
  const widgets = Array.isArray(node.widgets) ? node.widgets : [];
  let widget = widgets.find((w) => String(w?.name || "") === String(buttonText));
  if (widget) {
    widget.callback = callback;
    widget.hidden = false;
    widget.__panoHidden = false;
    widget.type = "button";
    if (widget.inputEl?.style) widget.inputEl.style.display = "";
    if (widget.parentEl?.style) widget.parentEl.style.display = "";
    if (typeof widget.computeSize !== "function" || widget.computeSize() == null || widget.hidden) {
      widget.computeSize = () => [Math.max(120, Number(node?.size?.[0] || 0) - 20), 30];
    }
    return widget;
  }
  widget = node.addWidget("button", buttonText, null, callback);
  if (widget) {
    widget.serialize = false;
  }
  return widget;
}
function uid(prefix) { return `${prefix}_${Math.random().toString(16).slice(2, 10)}`; }

function parseOutputPresetValue(v, fallback = 2048) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const s = String(v ?? "").trim();
  if (!s) return fallback;
  const head = s.includes("x") ? s.split("x", 1)[0].trim() : s;
  const n = Number(head);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function getGraphLinkById(graph, linkId) {
  if (!graph || linkId == null) return null;
  const links = graph.links;
  if (!links) return null;
  if (links instanceof Map) return links.get(linkId) || links.get(Number(linkId)) || links.get(String(linkId)) || null;
  return links[linkId] || links[String(linkId)] || null;
}

function getGraphNodeById(graph, id) {
  if (!graph || id == null) return null;
  if (typeof graph.getNodeById === "function") return graph.getNodeById(id);
  return graph._nodes_by_id?.[id] || graph._nodes_by_id?.[String(id)] || null;
}

function resolveOriginFromLinkInfo(linkInfo) {
  if (!linkInfo) return { originId: null, originSlot: 0 };
  if (typeof linkInfo === "object" && !Array.isArray(linkInfo)) {
    return {
      originId: linkInfo.origin_id ?? null,
      originSlot: Number(linkInfo.origin_slot ?? 0),
    };
  }
  if (Array.isArray(linkInfo)) {
    return {
      originId: linkInfo[1] ?? null,
      originSlot: Number(linkInfo[2] ?? 0),
    };
  }
  return { originId: null, originSlot: 0 };
}

function resolveInputOriginNode(node, inputIndex, fallbackOriginId = null) {
  let originNode = null;
  try {
    originNode = typeof node?.getInputNode === "function" ? node.getInputNode(inputIndex) : null;
  } catch {
    originNode = null;
  }
  if (originNode?.isSubgraphNode?.()) {
    try {
      const inputLink = typeof node?.getInputLink === "function" ? node.getInputLink(inputIndex) : null;
      const resolved = inputLink ? originNode.resolveSubgraphOutputLink?.(Number(inputLink.origin_slot ?? 0)) : null;
      if (resolved?.outputNode) originNode = resolved.outputNode;
    } catch {
      // ignore
    }
  }
  if (!originNode && fallbackOriginId != null) {
    originNode = getGraphNodeById(node?.graph, fallbackOriginId);
  }
  return originNode;
}

function comfyImageEntryToUrl(entry) {
  if (!entry || typeof entry !== "object") return "";
  const filename = String(entry.filename || "");
  if (!filename) return "";
  const params = new URLSearchParams();
  params.set("filename", filename);
  params.set("type", String(entry.type || "output"));
  if (entry.subfolder) params.set("subfolder", String(entry.subfolder));
  const q = `/view?${params.toString()}`;
  return typeof api?.apiURL === "function" ? api.apiURL(q) : q;
}

function isDirectImageUrl(src) {
  const s = String(src || "").trim();
  if (!s) return false;
  return (
    /^https?:\/\//i.test(s)
    || s.startsWith("/")
    || s.startsWith("blob:")
    || s.startsWith("data:")
  );
}

function splitFilenameAndSubfolder(pathish) {
  const normalized = String(pathish || "").trim().replaceAll("\\", "/");
  const trimmed = normalized.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!trimmed) return { filename: "", subfolder: "" };
  const parts = trimmed.split("/").filter(Boolean);
  if (!parts.length) return { filename: "", subfolder: "" };
  const filename = String(parts.pop() || "").trim();
  const subfolder = parts.join("/");
  return { filename, subfolder };
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  values.forEach((v) => {
    const s = String(v || "").trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  });
  return out;
}

function buildImageSrcCandidates(srcRaw) {
  const src = String(srcRaw || "").trim();
  if (!src) return [];
  if (isDirectImageUrl(src)) return [src];
  const { filename, subfolder } = splitFilenameAndSubfolder(src);
  if (!filename) return [src];
  const byView = ["temp", "output", "input"].map((type) => comfyImageEntryToUrl({
    filename,
    subfolder,
    type,
  }));
  return uniqStrings([...byView, src]);
}

function stickerAssetToPreviewSrc(asset) {
  if (!asset || typeof asset !== "object") return "";
  const type = String(asset.type || "").trim().toLowerCase();
  if (type === "dataurl") return String(asset.value || "");
  if (type === "comfy_image") {
    const filename = String(asset.filename || "").trim();
    if (!filename) return "";
    return comfyImageEntryToUrl({
      filename,
      subfolder: String(asset.subfolder || ""),
      type: String(asset.storage || "input"),
    });
  }
  return "";
}

function lookupNodeOutputEntry(nodeId) {
  const store = app?.nodeOutputs;
  if (!store || nodeId == null) return null;
  // Performance fix: Use strictly direct lookup.
  // Iterating all outputs every frame causes massive lag when many nodes are present.
  const raw = String(nodeId);
  if (store instanceof Map) {
    return store.get(nodeId) || store.get(raw) || store.get(Number(raw)) || null;
  }
  return store[nodeId] || store[raw] || null;
}

function imageSourceFromCandidate(candidate) {
  if (!candidate) return "";
  if (typeof candidate === "string") return String(candidate || "").trim();
  if (Array.isArray(candidate)) {
    if (candidate.length === 0) return "";
    if (candidate.length === 1) return imageSourceFromCandidate(candidate[0]);
    const filename = String(candidate[0] || "").trim();
    if (filename) {
      const subfolder = String(candidate[1] || "").trim();
      const type = String(candidate[2] || "output").trim() || "output";
      return comfyImageEntryToUrl({ filename, subfolder, type });
    }
    for (const entry of candidate) {
      const src = imageSourceFromCandidate(entry);
      if (src) return src;
    }
    return "";
  }
  if (typeof candidate?.src === "string" && candidate.src) return candidate.src;
  if (typeof candidate?.url === "string" && candidate.url) return candidate.url;
  return comfyImageEntryToUrl(candidate);
}

function findLinkedInputImageSource(node, preferredInputNames = []) {
  const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
  if (!inputs.length) return { src: "", sourceType: "", inputName: "" };
  const preferred = preferredInputNames
    .map((name) => inputs.findIndex((i) => String(i?.name || "") === String(name)))
    .filter((idx) => idx >= 0);
  const imageTyped = inputs
    .map((input, idx) => ({ input, idx }))
    .filter(({ input }) => String(input?.type || "").toUpperCase() === "IMAGE")
    .map(({ idx }) => idx);
  const indices = [...new Set([...preferred, ...imageTyped])];

  for (const idx of indices) {
    const input = inputs[idx];
    const linkId = input?.link;
    if (linkId == null) continue;
    const linkInfo = getGraphLinkById(node.graph, linkId);
    const { originId, originSlot } = resolveOriginFromLinkInfo(linkInfo);
    if (originId == null) continue;
    const originNode = resolveInputOriginNode(node, idx, originId);
    const resolvedOriginSlot = Number(originSlot || 0);
    if (!originNode) continue;

    let appNodeImageUrls = [];
    try {
      appNodeImageUrls = typeof app?.getNodeImageUrls === "function" ? (app.getNodeImageUrls(originNode) || []) : [];
    } catch {
      appNodeImageUrls = [];
    }
    if (Array.isArray(appNodeImageUrls) && appNodeImageUrls.length) {
      const ordered = [];
      if (resolvedOriginSlot >= 0 && resolvedOriginSlot < appNodeImageUrls.length) ordered.push(appNodeImageUrls[resolvedOriginSlot]);
      ordered.push(...appNodeImageUrls);
      for (const cand of ordered) {
        const src = imageSourceFromCandidate(cand);
        if (src) {
          return { src, sourceType: "appNodeImageUrls", inputName: String(input?.name || "") };
        }
      }
    }

    const outputs = lookupNodeOutputEntry(originNode?.id ?? originId);
    const outImgs = Array.isArray(outputs?.images) ? outputs.images : [];
    if (outImgs.length) {
      const ordered = [];
      if (resolvedOriginSlot >= 0 && resolvedOriginSlot < outImgs.length) ordered.push(outImgs[resolvedOriginSlot]);
      ordered.push(...outImgs);
      for (const cand of ordered) {
        const src = imageSourceFromCandidate(cand);
        if (src) {
          return { src, sourceType: "nodeOutputs", inputName: String(input?.name || "") };
        }
      }
    }

    const nodeImgs = Array.isArray(originNode?.imgs) ? originNode.imgs : [];
    if (nodeImgs.length) {
      const ordered = [];
      if (resolvedOriginSlot >= 0 && resolvedOriginSlot < nodeImgs.length) ordered.push(nodeImgs[resolvedOriginSlot]);
      ordered.push(...nodeImgs);
      for (const cand of ordered) {
        const src = imageSourceFromCandidate(cand);
        if (src) {
          return { src, sourceType: "nodeImgs", inputName: String(input?.name || "") };
        }
      }
    }

    const imageWidget = originNode?.widgets?.find((w) => String(w?.name || "").toLowerCase() === "image");
    if (imageWidget) {
      let src = imageSourceFromCandidate(imageWidget.value);
      if (src && !src.includes("/") && !src.includes(":") && (originNode.comfyClass === "LoadImage" || originNode.type === "LoadImage")) {
        src = api.apiURL(`/view?filename=${encodeURIComponent(src)}&type=input&subfolder=`);
      }
      if (src) {
        return { src, sourceType: "widget", inputName: String(input?.name || "") };
      }
    }
  }

  // Fallback: Check if the current node has explicitly saved input images (e.g. from upstream non-file nodes)
  // We do this check regardless of linked inputs if preferred inputs are exhausted, to support
  // scenarios where the link exists but provides no image data (e.g. some custom nodes).
  const selfOutput = lookupNodeOutputEntry(node?.id);
  const fallbackCandidates = [];
  if (Array.isArray(selfOutput?.pano_input_images)) fallbackCandidates.push(...selfOutput.pano_input_images);
  if (Array.isArray(selfOutput?.ui?.pano_input_images)) fallbackCandidates.push(...selfOutput.ui.pano_input_images);

  if (fallbackCandidates.length > 0) {
    for (const item of fallbackCandidates) {
      const src = imageSourceFromCandidate(item);
      if (src) {
        return { src, sourceType: "selfOutput", inputName: "fallback" };
      }
    }
  }

  return { src: "", sourceType: "", inputName: "" };
}

function getLinkedInputImage(node, preferredInputNames = [], onLoad = null) {
  const resolved = findLinkedInputImageSource(node, preferredInputNames);
  const srcRaw = String(resolved?.src || "").trim();
  if (!srcRaw) return null;
  const candidates = buildImageSrcCandidates(srcRaw);
  if (!candidates.length) return null;
  if (!node.__panoLinkedInputImageCache) node.__panoLinkedInputImageCache = new Map();
  const key = preferredInputNames.join("|") || "image";
  const cached = node.__panoLinkedInputImageCache.get(key);
  if (cached && cached.srcRaw === srcRaw && cached.img) return cached.img;

  const img = new Image();
  const cacheEntry = { srcRaw, resolvedSrc: "", img };
  node.__panoLinkedInputImageCache.set(key, cacheEntry);
  let attempt = -1;
  const tryLoadNext = () => {
    attempt += 1;
    if (attempt >= candidates.length) {
      try { node.__panoLinkedInputImageCache?.delete?.(key); } catch { }
      return;
    }
    const nextSrc = candidates[attempt];
    cacheEntry.resolvedSrc = nextSrc;
    img.src = nextSrc;
  };

  img.onload = () => {
    onLoad?.();
    node.setDirtyCanvas?.(true, true);
  };
  img.onerror = (ev) => {
    if (attempt + 1 < candidates.length) {
      tryLoadNext();
      return;
    }
    try { node.__panoLinkedInputImageCache?.delete?.(key); } catch { }
  };
  tryLoadNext();
  return img;
}

function showEditor(node, type, options = {}) {
  const readOnly = options?.readOnly === true;
  const hideSidebar = options?.hideSidebar ?? readOnly;
  const previewMode = readOnly;
  const nodeTitle = getEditorNodeTitle(node, type);
  const sideTitleHtml = `<span class="pano-side-title-icon" aria-hidden="true">${ICON.globe}</span><span>${escapeHtml(nodeTitle)}</span>`;
  installCss();
  const presetWidget = getWidget(node, "output_preset");
  const bgWidget = getWidget(node, "bg_color");
  const stateWidget = getWidget(node, STATE_WIDGET);

  const state = parseState(
    String(stateWidget?.value || ""),
    parseOutputPresetValue(presetWidget?.value, 2048),
    String(bgWidget?.value || "#00ff00"),
  );
  node.__panoLiveStateOverride = JSON.stringify(state);
  node.__panoDomPreview?.requestDraw?.();
  node.setDirtyCanvas?.(true, true);
  node.graph?.setDirtyCanvas?.(true, true);
  app?.canvas?.setDirty?.(true, true);

  if (type === "cutout") {
    state.shots = Array.isArray(state.shots) ? state.shots.slice(0, 1) : [];
    if (!state.shots.length) {
      state.active.selected_shot_id = null;
    }
  }
  const overlay = document.createElement("div");
  overlay.className = "pano-modal-overlay";
  const root = document.createElement("div");
  root.className = "pano-modal";
  const fullscreenBtnHtml = previewMode
    ? `<button class="pano-btn pano-btn-icon" data-action="toggle-fullscreen" aria-label="Fullscreen" data-tip="Fullscreen">${ICON.fullscreen}</button>`
    : "";
  root.innerHTML = `
    <div class="pano-stage-wrap">
      <canvas class="pano-stage" width="1600" height="800"></canvas>
      <div class="pano-stage-drop-hint" aria-hidden="true">
        <div class="pano-stage-drop-hint-text">Drag and drop image here</div>
      </div>
      ${previewMode ? "" : `
      <div class="pano-floating-left" data-tool-rail>
        <button class="pano-btn pano-btn-icon${"cursor" === "cursor" ? " active" : ""}" type="button" data-tool-mode="cursor" aria-label="Cursor" aria-pressed="true" data-tip="Cursor">${ICON.cursor_tool}</button>
        <button class="pano-btn pano-btn-icon" type="button" data-tool-mode="paint" aria-label="Paint" aria-pressed="false" data-tip="Paint">${ICON.palette_tool}</button>
        <button class="pano-btn pano-btn-icon" type="button" data-tool-mode="mask" aria-label="Mask" aria-pressed="false" data-tip="Mask">${ICON.circle_dashed_tool}</button>
        ${type === "cutout"
          ? `<button class="pano-btn pano-btn-icon" type="button" data-tool-ui-action="add-or-look" aria-label="Add Frame" data-tip="Add frame">${ICON.plus_circle}</button>`
          : `<button class="pano-btn pano-btn-icon" type="button" data-tool-ui-action="add" aria-label="Add Image" data-tip="Add image">${ICON.add}</button>`
        }
        <button class="pano-btn pano-btn-icon" type="button" data-tool-ui-action="clear" aria-label="Clear All" data-tip="Clear all">${ICON.clear}</button>
        <button class="pano-btn pano-btn-icon" type="button" data-tool-ui-action="undo" aria-label="Undo" data-tip="Undo">${ICON.undo}</button>
        <button class="pano-btn pano-btn-icon" type="button" data-tool-ui-action="redo" aria-label="Redo" data-tip="Redo">${ICON.redo}</button>
      </div>
      <div class="pano-paint-color-float" data-paint-color-row hidden>
        ${PAINT_COLOR_SWATCHES.map((swatch) => `<button class="pano-paint-color-dot" type="button" data-paint-color-swatch="${swatch.id}" aria-label="${swatch.label}" data-tip="${swatch.label}" style="--swatch:${colorToCss(swatch.color, 1)}"></button>`).join("")}
        <button class="pano-paint-color-dot pano-paint-color-dot-rainbow" type="button" data-paint-color-custom aria-label="Custom color" data-tip="Custom color"></button>
        <div class="pano-paint-color-pop" data-paint-color-pop hidden>
          <div class="pano-paint-color-pop-head">
            <span class="pano-paint-color-preview" data-paint-color-preview></span>
            <span class="pano-paint-color-pop-label">Custom Color</span>
          </div>
          <div class="pano-paint-color-field">
            <div class="pano-paint-sv-panel" data-paint-color-sv>
              <div class="pano-paint-sv-cursor" data-paint-color-sv-cursor></div>
            </div>
            <div class="pano-paint-hue-strip" data-paint-hue-strip>
              <div class="pano-paint-hue-handle" data-paint-hue-handle></div>
            </div>
          </div>
          <label class="pano-paint-color-field">
            <span>Opacity</span>
            <div class="pano-paint-alpha-wrap">
              <input type="range" min="0" max="100" step="1" value="100" data-paint-alpha-slider>
              <span data-paint-alpha-value>100%</span>
            </div>
          </label>
          <div class="pano-paint-color-history" data-paint-color-history-wrap>
            <div class="pano-paint-color-history-list" data-paint-color-history></div>
          </div>
        </div>
      </div>
      <div class="pano-paint-footer" data-paint-footer hidden>
        <div class="pano-paint-footer-group" data-paint-group="paint" hidden>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="pen" aria-label="Pen" data-tip="Pen">${ICON.pencil_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="brush" aria-label="Soft Brush" data-tip="Soft Brush">${ICON.spray_can_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="marker" aria-label="Marker" data-tip="Marker">${ICON.highlighter_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="crayon" aria-label="Pastel" data-tip="Pastel">${ICON.paintbrush_vertical_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="eraser" aria-label="Eraser" data-tip="Eraser">${ICON.eraser_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-paint-tool="lasso_fill" aria-label="Lasso" data-tip="Lasso">${ICON.lasso_tool}</button>
        </div>
        <div class="pano-paint-footer-group" data-paint-group="mask" hidden>
          <button class="pano-btn pano-btn-icon" type="button" data-mask-tool="pen" aria-label="Mask Pen" data-tip="Mask pen">${ICON.pencil_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-mask-tool="eraser" aria-label="Mask Eraser" data-tip="Mask eraser">${ICON.eraser_tool}</button>
          <button class="pano-btn pano-btn-icon" type="button" data-mask-tool="lasso_fill" aria-label="Mask Lasso" data-tip="Mask lasso">${ICON.lasso_tool}</button>
        </div>
        <div class="pano-paint-size-row" data-paint-size-row hidden>
          <input class="pano-paint-size-slider" data-paint-size-slider type="range" min="1" max="120" step="1" value="10">
          <span class="pano-paint-size-value" data-paint-size-value>10</span>
        </div>
        <div class="pano-paint-clear-row" data-paint-clear-row hidden>
          <button class="pano-btn pano-btn-icon pano-paint-layer-clear" type="button" data-paint-layer-clear-current aria-label="Clear Current Layer" data-tip="Clear current">${ICON.clear}</button>
        </div>
      </div>`}
      <div class="pano-floating-top">
        <div class="pano-view-toggle" data-selected="pano" data-view-count="${type === "cutout" ? "3" : "2"}">
          <button class="pano-view-btn" data-view="pano" aria-pressed="true" aria-label="Panorama">${ICON.pano}<span class="label">Panorama</span></button>
          <button class="pano-view-btn" data-view="unwrap" aria-pressed="false" aria-label="Unwrap">${ICON.unwrap}<span class="label">Unwrap</span></button>
          ${type === "cutout" ? `<button class="pano-view-btn" data-view="frame" aria-pressed="false" aria-label="Frame">Frame</button>` : ""}
        </div>
      </div>
      <div class="pano-floating-right">
        <span>FOV</span>
        <span class="pano-fov-value" data-fov-value>100.0</span>
        <button class="pano-btn pano-btn-icon" data-action="reset-view" aria-label="Reset View" data-tip="Reset view">${ICON.reset}</button>
        <button class="pano-btn pano-btn-icon" data-action="toggle-grid" aria-label="Hide Grid" data-tip="Hide grid" aria-pressed="true">${ICON.eye}</button>
        ${fullscreenBtnHtml}
      </div>
      <div class="pano-selection-menu" data-selection-menu>
      </div>
      <button class="pano-btn pano-btn-icon pano-output-preview-toggle" data-action="toggle-output-preview-size" aria-label="Expand Preview" data-tip="Expand preview" style="display:none">${ICON.fullscreen}</button>
      <div class="pano-tooltip" data-tooltip></div>
    </div>
    <div class="pano-side" data-side>
      <div class="pano-side-head">
        <div class="pano-side-title">${sideTitleHtml}</div>
        <div class="pano-side-actions"></div>
      </div>
      <div class="pano-divider"></div>
    </div>
  `;

  overlay.appendChild(root);
  document.body.appendChild(overlay);

  const canvas = root.querySelector("canvas");
  const stageWrap = root.querySelector(".pano-stage-wrap");
  const paintCursorEl = document.createElement("div");
  paintCursorEl.setAttribute("aria-hidden", "true");
  paintCursorEl.style.position = "absolute";
  paintCursorEl.style.left = "0";
  paintCursorEl.style.top = "0";
  paintCursorEl.style.pointerEvents = "none";
  paintCursorEl.style.zIndex = "12";
  paintCursorEl.style.display = "none";
  paintCursorEl.style.willChange = "transform,width,height,background,border-radius";
  stageWrap?.appendChild(paintCursorEl);
  const paintSizePreviewEl = document.createElement("div");
  paintSizePreviewEl.className = "pano-paint-size-preview";
  paintSizePreviewEl.setAttribute("aria-hidden", "true");
  const paintSizePreviewSampleEl = document.createElement("div");
  paintSizePreviewSampleEl.className = "pano-paint-size-preview-sample";
  paintSizePreviewEl.appendChild(paintSizePreviewSampleEl);
  stageWrap?.appendChild(paintSizePreviewEl);
  const ctx = canvas.getContext("2d");
  const side = root.querySelector("[data-side]");
  const viewBtns = root.querySelectorAll("[data-view]");
  const viewToggle = root.querySelector(".pano-view-toggle");
  const fovValueEl = root.querySelector("[data-fov-value]");
  const selectionMenu = root.querySelector("[data-selection-menu]");
  const outputPreviewToggleBtn = root.querySelector("[data-action='toggle-output-preview-size']");
  const addOrLookBtn = root.querySelector("[data-tool-ui-action='add-or-look']");
  const frameViewBtn = root.querySelector("[data-view='frame']");
  const fullscreenBtn = root.querySelector("[data-action='toggle-fullscreen']");
  const tooltipEl = root.querySelector("[data-tooltip]");
  const toolRail = root.querySelector("[data-tool-rail]");
  const paintFooter = root.querySelector("[data-paint-footer]");
  const paintColorRow = root.querySelector("[data-paint-color-row]");
  const paintColorPop = root.querySelector("[data-paint-color-pop]");
  const paintColorPreview = root.querySelector("[data-paint-color-preview]");
  const paintColorSv = root.querySelector("[data-paint-color-sv]");
  const paintColorSvCursor = root.querySelector("[data-paint-color-sv-cursor]");
  const paintHueStrip = root.querySelector("[data-paint-hue-strip]");
  const paintHueHandle = root.querySelector("[data-paint-hue-handle]");
  const paintAlphaSlider = root.querySelector("[data-paint-alpha-slider]");
  const paintAlphaValue = root.querySelector("[data-paint-alpha-value]");
  const paintColorHistoryWrap = root.querySelector("[data-paint-color-history-wrap]");
  const paintColorHistory = root.querySelector("[data-paint-color-history]");
  const paintSizeRow = root.querySelector("[data-paint-size-row]");
  const paintClearRow = root.querySelector("[data-paint-clear-row]");
  const paintLayerClearCurrentBtn = root.querySelector("[data-paint-layer-clear-current]");
  const paintSizeSlider = root.querySelector("[data-paint-size-slider]");
  const paintSizeValue = root.querySelector("[data-paint-size-value]");
  let paintSizePreviewTimer = 0;
  if (type === "cutout") canvas.style.opacity = "0";
  if (hideSidebar) {
    side?.remove();
    root.classList.add("pano-modal-readonly");
  }
  const commitCustomPaintHistory = () => {
    if (!editor.customPaintSessionStart) return;
    if (colorsApproximatelyEqual(editor.customPaintSessionStart, editor.customPaintColor)) {
      editor.customPaintSessionStart = null;
      return;
    }
    if (isPresetPaintColor(editor.customPaintColor)) {
      editor.customPaintSessionStart = null;
      return;
    }
    const next = [
      cloneColor(editor.customPaintColor),
      ...editor.customPaintHistory.filter((item) => !colorsApproximatelyEqual(item, editor.customPaintColor)),
    ];
    editor.customPaintHistory = next.slice(0, 7);
    editor.customPaintSessionStart = null;
  };
  const closePaintColorPop = (commitHistory = false) => {
    if (!paintColorPop || paintColorPop.hidden) return;
    if (commitHistory) commitCustomPaintHistory();
    else editor.customPaintSessionStart = null;
    paintColorPop.hidden = true;
  };
  const openPaintColorPop = () => {
    if (!paintColorPop) return;
    if (paintColorPop.hidden) editor.customPaintSessionStart = cloneColor(editor.customPaintColor);
    paintColorPop.hidden = false;
  };
  root.addEventListener("pointerdown", (ev) => {
    hideTooltip();
    if (ev.target.closest(".pano-picker")) return;
    if (ev.target.closest("[data-paint-color-row]")) return;
    root.querySelectorAll(".pano-picker-pop").forEach((el) => {
      el.hidden = true;
    });
    closePaintColorPop(true);
    if (type === "cutout" && editor.cutoutAspectOpen && !ev.target.closest(".pano-aspect-popover") && !ev.target.closest("[data-action='aspect']")) {
      editor.cutoutAspectOpen = false;
      editor.menuMode = "";
      editor.menuSize.measured = false;
      updateSelectionMenu();
      requestDraw();
    }
  });

  const editor = {
    mode: "pano",
    selectedId: type === "stickers" ? state.active.selected_sticker_id : state.active.selected_shot_id,
    viewYaw: 0,
    viewPitch: 0,
    viewFov: 100,
    historyController: createHistoryController(80),
    primaryTool: "cursor",
    paintTool: "pen",
    maskTool: "pen",
    brushSizes: { pen: 20, marker: 20, brush: 20, crayon: 20 },
    activeBrushPresetId: DEFAULT_BRUSH_PRESET_ID,
    paintColor: { r: 0, g: 1, b: 0, a: 1 },
    customPaintColor: { r: 0, g: 1, b: 0, a: 1 },
    customPaintHistory: [],
    customPaintSessionStart: null,
    pointerPos: { x: 0, y: 0, inside: false },
    interaction: null,
    hqFrames: 0,
    viewInertia: { vx: 0, vy: 0, active: false },
    menuSize: { w: 220, h: 40, measured: false },
    menuMode: "",
    cutoutAspectOpen: false,
    showGrid: getNodeGridVisibility(node?.id, true),
    outputPreviewExpanded: false,
    outputPreviewAnim: 0,
    outputPreviewAnimFrom: 0,
    outputPreviewAnimTo: 0,
    outputPreviewAnimStartTs: 0,
    outputPreviewAnimDurationMs: 180,
    outputPreviewRect: null,
    frameView: { zoom: 1, panX: 0, panY: 0 },
    paintEngine: createPaintEngineManager(),
    paintEngineRevisionKey: "",
    paintStrokeRevision: 0,
    _sortedItemsCache: null,
    panelLastValues: null,
    panelWasEnabled: false,
    viewTween: null,
    fullscreen: false,
    fullscreenPrevShowGrid: null,
  };
  if (type === "stickers") {
    editor.selectedId = null;
    state.active.selected_sticker_id = null;
  }
  const imageCache = new Map();
  const runtime = {
    dirty: true,
    rafId: 0,
    running: true,
    lastTickTs: 0,
    lastSizeCheckTs: 0,
    pendingStableLayoutFrames: type === "cutout" ? 2 : 0,
    hasPresentedFrame: type !== "cutout",
  };
  const tooltip = {
    timer: 0,
    target: null,
  };
  const dragCue = {
    active: false,
    depth: 0,
  };

  function dragHasImageFiles(e) {
    const dt = e?.dataTransfer;
    if (!dt) return false;
    if (dt.items && dt.items.length) {
      for (const item of dt.items) {
        if (!item || item.kind !== "file") continue;
        const t = String(item.type || "").toLowerCase();
        if (!t || t.startsWith("image/")) return true;
      }
      return false;
    }
    if (dt.files && dt.files.length) {
      return Array.from(dt.files).some((f) => isImageFile(f));
    }
    return false;
  }

  function setDropCue(on) {
    const next = !!on;
    if (dragCue.active === next) return;
    dragCue.active = next;
    stageWrap.classList.toggle("drop-active", next);
  }

  function startViewTween(targetYaw, targetPitch, targetFov = editor.viewFov, minMs = 140, maxMs = 620) {
    const dyaw = shortestYawDelta(editor.viewYaw, targetYaw);
    const dpitch = targetPitch - editor.viewPitch;
    const dfov = targetFov - editor.viewFov;
    const dist = Math.hypot(dyaw, dpitch) + Math.abs(dfov) * 0.6;
    const durationMs = Math.round(clamp(minMs + dist * 2.2, minMs, maxMs));
    editor.viewTween = {
      active: true,
      startTs: performance.now(),
      durationMs,
      startYaw: editor.viewYaw,
      startPitch: editor.viewPitch,
      startFov: editor.viewFov,
      targetPitch,
      targetFov,
      deltaYaw: dyaw,
    };
    editor.viewInertia.active = false;
    editor.viewInertia.vx = 0;
    editor.viewInertia.vy = 0;
    requestDraw();
  }

  // Coordinate sanity: front-facing sticker should have top edge above bottom edge.
  const __sanity = stickerCornerOrderSanity();
  void __sanity;

  function getList() { return type === "stickers" ? state.stickers : state.shots; }
  function getSelected() { return getList().find((s) => s.id === editor.selectedId) || null; }
  function getNextStickerZIndex() {
    const stickers = Array.isArray(state.stickers) ? state.stickers : [];
    return stickers.reduce((acc, item) => {
      const next = Number(item?.z_index);
      return Math.max(acc, Number.isFinite(next) ? next : 0);
    }, -1) + 1;
  }
  function isExternalSticker(item) {
    if (!item || typeof item !== "object") return false;
    return String(item.id || "") === EXTERNAL_STICKER_ID
      || String(item.source_kind || "") === EXTERNAL_STICKER_SOURCE_KIND;
  }
  function isStickerHidden(item) {
    return !!(item && typeof item === "object" && item.visible === false);
  }
  function getStickerDisplayAlpha(item) {
    if (isExternalSticker(item) && isStickerHidden(item)) return 0.2;
    return 1;
  }
  function restoreSelectedToInitialPose() {
    if (readOnly || type !== "stickers") return;
    const selected = getSelected();
    if (!selected || !isExternalSticker(selected)) return;
    const initial = selected.initial_pose;
    if (!initial || typeof initial !== "object") return;
    selected.yaw_deg = Number(initial.yaw_deg ?? selected.yaw_deg ?? 0);
    selected.pitch_deg = Number(initial.pitch_deg ?? selected.pitch_deg ?? 0);
    selected.hFOV_deg = Number(initial.hFOV_deg ?? selected.hFOV_deg ?? 30);
    const previewImg = getStickerUiImage(EXTERNAL_STICKER_PREVIEW_KEY, () => {
      requestDraw();
    });
    if (previewImg && (previewImg.complete || previewImg.naturalWidth || previewImg.width)) {
      selected.vFOV_deg = computeStickerVFov(
        Number(initial.hFOV_deg ?? selected.hFOV_deg ?? 30),
        Number(previewImg.naturalWidth || previewImg.width || 1),
        Number(previewImg.naturalHeight || previewImg.height || 1),
      );
    } else {
      selected.vFOV_deg = Number(initial.vFOV_deg ?? selected.vFOV_deg ?? 30);
    }
    selected.rot_deg = Number(initial.rot_deg ?? selected.rot_deg ?? 0);
    pushHistory();
    commitAndRefreshNode();
    updateSidePanel();
    updateSelectionMenu();
    requestDraw();
  }
  function getRestorePoseForSticker(item) {
    if (!item || !isExternalSticker(item)) return null;
    const initial = item.initial_pose;
    if (!initial || typeof initial !== "object") return null;
    const pose = {
      yaw_deg: Number(initial.yaw_deg ?? item.yaw_deg ?? 0),
      pitch_deg: Number(initial.pitch_deg ?? item.pitch_deg ?? 0),
      hFOV_deg: Number(initial.hFOV_deg ?? item.hFOV_deg ?? 30),
      vFOV_deg: Number(initial.vFOV_deg ?? item.vFOV_deg ?? 30),
      rot_deg: Number(initial.rot_deg ?? item.rot_deg ?? 0),
    };
    const previewImg = getStickerUiImage(EXTERNAL_STICKER_PREVIEW_KEY, () => {
      requestDraw();
    });
    if (previewImg && (previewImg.complete || previewImg.naturalWidth || previewImg.width)) {
      pose.vFOV_deg = computeStickerVFov(
        pose.hFOV_deg,
        Number(previewImg.naturalWidth || previewImg.width || 1),
        Number(previewImg.naturalHeight || previewImg.height || 1),
      );
    }
    return pose;
  }
  function canRestoreSelectedToInitial() {
    const selected = getSelected();
    if (!selected || !isExternalSticker(selected)) return false;
    const restorePose = getRestorePoseForSticker(selected);
    if (!restorePose) return false;
    const close = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= 1e-4;
    return !(
      close(selected.yaw_deg, restorePose.yaw_deg)
      && close(selected.pitch_deg, restorePose.pitch_deg)
      && close(selected.hFOV_deg, restorePose.hFOV_deg)
      && close(selected.vFOV_deg, restorePose.vFOV_deg)
      && close(selected.rot_deg, restorePose.rot_deg)
    );
  }
  function getNodeUiList(key) {
    const outputs = lookupNodeOutputEntry(node?.id);
    if (Array.isArray(outputs?.ui?.[key])) return outputs.ui[key];
    if (Array.isArray(outputs?.[key])) return outputs[key];
    return [];
  }
  function getNodeUiValue(key) {
    const outputs = lookupNodeOutputEntry(node?.id);
    if (outputs?.ui && Object.prototype.hasOwnProperty.call(outputs.ui, key)) return outputs.ui[key];
    if (outputs && Object.prototype.hasOwnProperty.call(outputs, key)) return outputs[key];
    return null;
  }
  function normalizeInputPoseValue(value, debugValue = null) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && typeof first === "object" && !Array.isArray(first)) return first;
    }
    if (Array.isArray(debugValue) && debugValue.length > 0) {
      const parsed = debugValue[0]?.parsed_state;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          yaw_deg: Number(parsed.yaw_deg || 0),
          pitch_deg: Number(parsed.pitch_deg || 0),
          hFOV_deg: Number(parsed.hFOV_deg || 30),
          rot_deg: Number(parsed.roll_deg || 0),
        };
      }
    }
    return null;
  }
  function getStickerUiImage(key, onLoad = null) {
    const list = getNodeUiList(key);
    const first = Array.isArray(list) && list.length ? list[0] : null;
    const src = imageSourceFromCandidate(first);
    if (!src) return null;
    const cacheKey = `__ui__${key}`;
    const cached = imageCache.get(cacheKey);
    if (cached && cached.__panoSrc === src) return cached;
    const img = new Image();
    img.__panoSrc = src;
    img.onload = () => {
      if (typeof onLoad === "function") onLoad(img);
      else requestDraw();
    };
    img.src = src;
    imageCache.set(cacheKey, img);
    return img;
  }
  function hashStringSimple(text) {
    const s = String(text || "");
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return String(h >>> 0);
  }
  function computeStickerVFov(hFovDeg, width, height) {
    const w = Math.max(1, Number(width || 1));
    const h = Math.max(1, Number(height || 1));
    const hf = clamp(Number(hFovDeg || 30), 0.1, 179) * DEG2RAD;
    const vf = 2 * Math.atan(Math.tan(hf * 0.5) * (h / w));
    return clamp(vf * RAD2DEG, 0.1, 179);
  }
  function parseLinkedStickerState(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") return null;
      if (String(parsed.kind || "") !== "pano_sticker_state") return null;
      const versionValue = parsed.version;
      let version = null;
      if (typeof versionValue === "number" && Number.isInteger(versionValue)) {
        version = versionValue;
      } else if (typeof versionValue === "string" && /^\d+$/.test(versionValue)) {
        version = Number.parseInt(versionValue, 10);
      }
      if (version !== 1) return null;
      const pose = parsed.pose;
      if (!pose || typeof pose !== "object") return null;
      const yawRaw = Number(pose.yaw_deg);
      const pitchRaw = Number(pose.pitch_deg);
      const rollRaw = Number(pose.roll_deg);
      const hRaw = Number(pose.hFOV_deg);
      if (![yawRaw, pitchRaw, rollRaw, hRaw].every((v) => Number.isFinite(v))) return null;
      let yaw = ((yawRaw + 180) % 360 + 360) % 360 - 180;
      if (Object.is(yaw, -0)) yaw = 0;
      const out = {
        yaw_deg: yaw,
        pitch_deg: clamp(pitchRaw, -89.9, 89.9),
        roll_deg: rollRaw,
        hFOV_deg: clamp(hRaw, 0.1, 179),
      };
      const sourceAspect = Number(parsed.source_aspect);
      if (Number.isFinite(sourceAspect) && sourceAspect > 0) out.source_aspect = sourceAspect;
      return out;
    } catch {
      return null;
    }
  }
  function buildCanonicalCutoutStickerState(item) {
    const widthRaw = Number(item?.out_w);
    const heightRaw = Number(item?.out_h);
    const width = Math.max(1, Number.isFinite(widthRaw) ? widthRaw : 1024);
    const height = Math.max(1, Number.isFinite(heightRaw) ? heightRaw : 1024);
    const yawRaw = Number(item?.yaw_deg);
    const pitchRaw = Number(item?.pitch_deg);
    const rollRaw = Number(item?.roll_deg ?? item?.rot_deg);
    const hFovRaw = Number(item?.hFOV_deg);
    return {
      kind: "pano_sticker_state",
      version: 1,
      pose: {
        yaw_deg: wrapYaw(Number.isFinite(yawRaw) ? yawRaw : 0),
        pitch_deg: clamp(Number.isFinite(pitchRaw) ? pitchRaw : 0, -89.9, 89.9),
        roll_deg: Number.isFinite(rollRaw) ? rollRaw : 0,
        hFOV_deg: clamp(Number.isFinite(hFovRaw) ? hFovRaw : 90, 0.1, 179),
      },
      source_aspect: width / height,
    };
  }
  function buildCanonicalSelectedStickerState(item) {
    if (!item || typeof item !== "object") return buildCanonicalCutoutStickerState(null);
    const yawRaw = Number(item?.yaw_deg);
    const pitchRaw = Number(item?.pitch_deg);
    const rollRaw = Number(item?.roll_deg ?? item?.rot_deg);
    const hFovRaw = Number(item?.hFOV_deg);
    const vFovRaw = Number(item?.vFOV_deg);
    let sourceAspect = 1;
    if (Number.isFinite(hFovRaw) && Number.isFinite(vFovRaw)) {
      const hf = clamp(hFovRaw, 0.1, 179) * DEG2RAD;
      const vf = clamp(vFovRaw, 0.1, 179) * DEG2RAD;
      const tanV = Math.tan(vf * 0.5);
      if (Math.abs(tanV) > 1e-6) {
        const ratio = Math.tan(hf * 0.5) / tanV;
        if (Number.isFinite(ratio) && ratio > 0) sourceAspect = ratio;
      }
    }
    if (item?.asset_id && state?.assets?.[item.asset_id]) {
      const asset = state.assets[item.asset_id];
      const width = Number(asset?.w || 0);
      const height = Number(asset?.h || 0);
      if (width > 0 && height > 0) sourceAspect = width / height;
    }
    return {
      kind: "pano_sticker_state",
      version: 1,
      pose: {
        yaw_deg: wrapYaw(Number.isFinite(yawRaw) ? yawRaw : 0),
        pitch_deg: clamp(Number.isFinite(pitchRaw) ? pitchRaw : 0, -89.9, 89.9),
        roll_deg: Number.isFinite(rollRaw) ? rollRaw : 0,
        hFOV_deg: clamp(Number.isFinite(hFovRaw) ? hFovRaw : 30, 0.1, 179),
      },
      source_aspect: sourceAspect,
    };
  }
  function getLinkedStringInputValue(inputName) {
    const input = Array.isArray(node?.inputs)
      ? node.inputs.find((entry) => String(entry?.name || "") === String(inputName))
      : null;
    const linkId = input?.link;
    if (linkId != null) {
      const linkInfo = getGraphLinkById(node.graph, linkId);
      const { originId, originSlot } = resolveOriginFromLinkInfo(linkInfo);
      const outputs = lookupNodeOutputEntry(originId);
      const groups = [
        outputs?.output,
        outputs?.result,
        outputs?.data?.output,
        outputs?.data?.result,
        outputs?.ui?.output,
        outputs?.ui?.result,
      ];
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        const idx = Number(originSlot || 0);
        const val = group[idx];
        if (typeof val === "string" && val.trim()) return val;
      }
    }
    return String(getWidget(node, inputName)?.value || "");
  }
  function buildExternalInitialPose(inputPose, stateRaw, previewImg) {
    const parsed = (inputPose && typeof inputPose === "object")
      ? {
        yaw_deg: Number(inputPose.yaw_deg || 0),
        pitch_deg: Number(inputPose.pitch_deg || 0),
        roll_deg: Number(inputPose.rot_deg ?? inputPose.roll_deg ?? 0),
        hFOV_deg: Number(inputPose.hFOV_deg || 30),
      }
      : parseLinkedStickerState(stateRaw);
    if (parsed) {
      const width = Number(previewImg?.naturalWidth || previewImg?.width || parsed.source_aspect || 1);
      const height = Number(previewImg?.naturalHeight || previewImg?.height || 1);
      return {
        yaw_deg: Number(parsed.yaw_deg || 0),
        pitch_deg: Number(parsed.pitch_deg || 0),
        hFOV_deg: Number(parsed.hFOV_deg || 30),
        vFOV_deg: computeStickerVFov(parsed.hFOV_deg, width, height),
        rot_deg: Number(parsed.roll_deg || 0),
      };
    }
    const width = Number(previewImg?.naturalWidth || previewImg?.width || 1);
    const height = Number(previewImg?.naturalHeight || previewImg?.height || 1);
    return {
      yaw_deg: Number(editor.viewYaw || 0),
      pitch_deg: Number(editor.viewPitch || 0),
      hFOV_deg: 30,
      vFOV_deg: computeStickerVFov(30, width, height),
      rot_deg: 0,
    };
  }
  function reconcileExternalStickerFromInputs(reason = "sync") {
    if (type !== "stickers" || readOnly) return;
    const input = Array.isArray(node?.inputs)
      ? node.inputs.find((entry) => String(entry?.name || "") === "sticker_image")
      : null;
    const linkId = input?.link ?? null;
    const previewImg = getStickerUiImage(EXTERNAL_STICKER_PREVIEW_KEY, () => {
      node.__panoExternalStickerSync?.("image-loaded");
    });
    const inputPose = normalizeInputPoseValue(getNodeUiValue("pano_sticker_input_pose"), null);
    const stateRaw = getLinkedStringInputValue("sticker_state");
    const stateHash = inputPose && typeof inputPose === "object"
      ? hashStringSimple(JSON.stringify(inputPose))
      : hashStringSimple(stateRaw);
    const stickers = Array.isArray(state.stickers) ? state.stickers : (state.stickers = []);
    const existingIndex = stickers.findIndex((item) => String(item?.id || "") === EXTERNAL_STICKER_ID);
    if (linkId == null) {
      if (existingIndex >= 0) {
        stickers.splice(existingIndex, 1);
        if (editor.selectedId === EXTERNAL_STICKER_ID) {
          editor.selectedId = null;
          state.active.selected_sticker_id = null;
        }
        commitAndRefreshNode();
        updateSidePanel();
        updateSelectionMenu();
        requestDraw();
      }
      return;
    }
    const maxZ = stickers.reduce((acc, item) => Math.max(acc, Number(item?.z_index || 0)), -1);
    let target = existingIndex >= 0 ? stickers[existingIndex] : null;
    const sourceChanged = !target
      || Number(target.source_link_id ?? -1) !== Number(linkId)
      || String(target.source_state_hash || "") !== stateHash;
    if (!target) {
      target = {
        id: EXTERNAL_STICKER_ID,
        source_kind: EXTERNAL_STICKER_SOURCE_KIND,
      };
      stickers.push(target);
    }
    target.id = EXTERNAL_STICKER_ID;
    target.source_kind = EXTERNAL_STICKER_SOURCE_KIND;
    target.source_link_id = Number(linkId);
    target.source_state_hash = stateHash;
    target.visible = target.visible !== false;
    let stateChanged = false;
    if (sourceChanged) {
      const pose = buildExternalInitialPose(inputPose, stateRaw, previewImg);
      Object.assign(target, pose, {
        initial_pose: { ...pose },
        visible: true,
        z_index: maxZ + 1,
      });
      stateChanged = true;
    } else if (previewImg && (previewImg.complete || previewImg.naturalWidth || previewImg.width)) {
      const nextVFov = computeStickerVFov(
        Number(target.hFOV_deg || 30),
        Number(previewImg.naturalWidth || previewImg.width || 1),
        Number(previewImg.naturalHeight || previewImg.height || 1),
      );
      if (Math.abs(Number(target.vFOV_deg || 0) - nextVFov) > 1e-6) {
        target.vFOV_deg = nextVFov;
        stateChanged = true;
      }
    }
    if (stateChanged) {
      commitAndRefreshNode();
      updateSidePanel();
      updateSelectionMenu();
    }
    requestDraw();
    void reason;
  }
  function applyInitialCutoutFocus() {
    if (type !== "cutout") return;
    const shots = getList();
    if (!Array.isArray(shots) || shots.length === 0) return;
    const preferredId = String(state.active?.selected_shot_id || editor.selectedId || "");
    const target = shots.find((s) => String(s?.id || "") === preferredId) || shots[0];
    if (!target) return;
    editor.selectedId = target.id || null;
    state.active.selected_shot_id = editor.selectedId;
    editor.viewYaw = wrapYaw(Number(target.yaw_deg || 0));
    editor.viewPitch = clamp(Number(target.pitch_deg || 0), -89.9, 89.9);
  }
  function syncLookAtFrameButtonState() {
    if (!addOrLookBtn) return;
    const hasFrames = type === "cutout" && getList().length > 0;
    if (hasFrames) {
      addOrLookBtn.innerHTML = ICON.crosshair;
      addOrLookBtn.setAttribute("aria-label", "Look at frame");
      addOrLookBtn.setAttribute("data-tip", "Look at frame");
    } else {
      addOrLookBtn.innerHTML = ICON.plus_circle;
      addOrLookBtn.setAttribute("aria-label", "Add frame");
      addOrLookBtn.setAttribute("data-tip", "Add frame");
    }
  }

  function syncViewToggleState() {
    const frameEnabled = type === "cutout" && getList().length > 0;
    if (editor.mode === "frame" && !frameEnabled) editor.mode = "pano";
    if (frameViewBtn) {
      frameViewBtn.disabled = !frameEnabled;
      frameViewBtn.setAttribute("aria-disabled", frameEnabled ? "false" : "true");
    }
    viewBtns.forEach((btn) => {
      const active = btn.dataset.view === editor.mode;
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (viewToggle) viewToggle.setAttribute("data-selected", editor.mode);
    if (isPaintCursorEnabled()) updateCursor(editor.pointerPos);
    else canvas.style.cursor = editor.mode === "pano" ? "grab" : "default";
  }

  function stickerCornerOrderSanity() {
    const test = {
      yaw_deg: 0, pitch_deg: 0, hFOV_deg: 20, vFOV_deg: 20, rot_deg: 0,
    };
    const dirs = stickerCornersDir(test);
    if (!dirs || dirs.length !== 4) return false;
    // top-left y should be >= bottom-left y in world-up axis
    return dirs[0].y >= dirs[3].y;
  }

  function cameraBasis() {
    const fwd = yawPitchToDir(editor.viewYaw, editor.viewPitch);
    let upWorld = vec3(0, 1, 0);
    if (Math.abs(dot(fwd, upWorld)) > 0.999) upWorld = vec3(0, 0, 1);
    const right = norm(cross(upWorld, fwd));
    const up = norm(cross(fwd, right));
    return { right, up, fwd };
  }

  function projectDir(dir) {
    const { right, up, fwd } = cameraBasis();
    const cx = dot(dir, right);
    const cy = dot(dir, up);
    const cz = dot(dir, fwd);
    if (cz <= 1e-5) return null;
    const w = canvas.width;
    const h = canvas.height;
    const hfov = editor.viewFov * DEG2RAD;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (h / w));
    const sx = (w / 2) / Math.tan(hfov / 2);
    const sy = (h / 2) / Math.tan(vfov / 2);
    return {
      x: w / 2 + (cx / cz) * sx,
      y: h / 2 - (cy / cz) * sy,
      z: cz,
    };
  }

  function screenToWorldDir(x, y) {
    const { right, up, fwd } = cameraBasis();
    const w = canvas.width;
    const h = canvas.height;
    const hfov = editor.viewFov * DEG2RAD;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (h / w));
    const nx = ((x - w / 2) / (w / 2)) * Math.tan(hfov / 2);
    const ny = ((h / 2 - y) / (h / 2)) * Math.tan(vfov / 2);
    const world = add(add(mul(right, nx), mul(up, ny)), fwd);
    return norm(world);
  }

  function getUnwrapRect() {
    const w = canvas.width;
    const h = canvas.height;
    const targetAR = 2.0; // ERP 2:1
    const canvasAR = w / Math.max(h, 1);
    if (canvasAR >= targetAR) {
      const rh = h;
      const rw = rh * targetAR;
      const rx = (w - rw) * 0.5;
      return { x: rx, y: 0, w: rw, h: rh };
    }
    const rw = w;
    const rh = rw / targetAR;
    const ry = (h - rh) * 0.5;
    return { x: 0, y: ry, w: rw, h: rh };
  }

  function getStickerImage(stickerOrAssetId) {
    if (stickerOrAssetId && typeof stickerOrAssetId === "object"
      && (isExternalSticker(stickerOrAssetId) || stickerOrAssetId.external === true)) {
      return getStickerUiImage(EXTERNAL_STICKER_PREVIEW_KEY, () => {
        node.__panoExternalStickerSync?.("image-loaded");
      });
    }
    const assetId = (stickerOrAssetId && typeof stickerOrAssetId === "object")
      ? String(stickerOrAssetId.asset_id || stickerOrAssetId.assetId || "")
      : String(stickerOrAssetId || "");
    if (!assetId) return null;
    const cached = imageCache.get(assetId);
    if (cached) return cached;
    const asset = state.assets?.[assetId];
    const src = stickerAssetToPreviewSrc(asset);
    if (!src) return null;
    const img = new Image();
    img.onload = () => requestDraw();
    img.src = src;
    imageCache.set(assetId, img);
    return img;
  }

  function buildEditorStickerScene() {
    return buildStickerSceneFromState(state, {
      selectedId: editor.selectedId || null,
      hoveredId: null,
      includeHidden: true,
    });
  }

  function buildEditorStickerTextures(scene) {
    return buildStickerTexturesFromState(
      state,
      (assetId, asset, item) => getStickerImage(item || assetId),
      { scene },
    );
  }

  async function uploadStickerAssetFile(file, fallbackName = "sticker.png") {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("subfolder", "panorama_stickers");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp || resp.status !== 200) {
      throw new Error(`upload failed (${resp?.status || "no-response"})`);
    }
    const data = await resp.json();
    const filename = String(data?.name || "").trim();
    if (!filename) {
      throw new Error("upload response missing filename");
    }
    return {
      type: "comfy_image",
      filename,
      subfolder: String(data?.subfolder || "panorama_stickers"),
      storage: String(data?.type || "input"),
      name: String(file?.name || fallbackName),
    };
  }

  async function uploadCanvasAsPaintLayer(canvas, filename) {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const body = new FormData();
    body.append("image", blob, filename);
    body.append("type", "input");
    body.append("subfolder", "panorama_stickers");
    body.append("overwrite", "1");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp || resp.status !== 200) throw new Error(`upload failed (${resp?.status})`);
    const data = await resp.json();
    const fn = String(data?.name || "").trim();
    if (!fn) throw new Error("upload response missing filename");
    return {
      type: "comfy_image",
      filename: fn,
      subfolder: String(data?.subfolder || "panorama_stickers"),
      storage: String(data?.type || "input"),
    };
  }

  let _paintLayerSyncRevision = null;
  let _paintLayerSyncPending = false;

  function syncPaintingLayerAsync() {
    const nodeId = String(node.id ?? "0");
    const promise = (async () => {
      const rev = getPaintingRevisionKey();
      const counts = paintingStrokeCount(state.painting);
      if (counts.paintCount <= 0 && counts.maskCount <= 0) {
        if (state.painting_layer !== null) {
          state.painting_layer = null;
          _paintLayerSyncRevision = rev;
          commitState();
        }
        return;
      }
      if (_paintLayerSyncRevision === rev) return;
      if (_paintLayerSyncPending) return;
      _paintLayerSyncPending = true;
      try {
        rebuildPaintEngineIfNeeded();
        const erpTarget = editor.paintEngine?.getErpTarget?.() || null;
        const paintCanvas = erpTarget?.committedPaint?.canvas || null;
        const maskCanvas = erpTarget?.committedMask?.canvas || null;
        if (!paintCanvas || !maskCanvas) return;
        let paintRef = null;
        let maskRef = null;
        if (counts.paintCount > 0) {
          paintRef = await uploadCanvasAsPaintLayer(paintCanvas, `pano_paint_${nodeId}.png`);
        }
        if (counts.maskCount > 0) {
          maskRef = await uploadCanvasAsPaintLayer(maskCanvas, `pano_mask_${nodeId}.png`);
        }
        if (rev === getPaintingRevisionKey()) {
          state.painting_layer = { paint: paintRef, mask: maskRef };
          _paintLayerSyncRevision = rev;
          commitState();
        }
      } catch (e) {
        console.warn("[pano] paint layer upload failed:", e);
      } finally {
        _paintLayerSyncPending = false;
      }
    })();
    _paintLayerUploadRegistry.set(nodeId, promise);
    promise.finally(() => {
      if (_paintLayerUploadRegistry.get(nodeId) === promise) {
        _paintLayerUploadRegistry.delete(nodeId);
      }
    });
  }

  function getConnectedErpImage() {
    const inputNames = Array.isArray(node?.inputs)
      ? node.inputs.map((i) => String(i?.name || ""))
      : [];
    const hasEpr = inputNames.includes("erp_image");
    const hasBg = inputNames.includes("bg_erp");
    let preferred = [];
    if (readOnly && (hasEpr || hasBg)) {
      preferred = hasEpr ? ["erp_image", "bg_erp"] : ["bg_erp", "erp_image"];
    } else {
      preferred = type === "stickers" ? ["bg_erp", "erp_image"] : ["erp_image", "bg_erp"];
    }
    const img = getLinkedInputImage(node, preferred, () => requestDraw());
    return img;
  }

  function getWrappedErpCanvas(img) {
    if (!img || !img.complete || !(img.naturalWidth || img.width)) return null;
    const iw = Number(img.naturalWidth || img.width || 0);
    const ih = Number(img.naturalHeight || img.height || 0);
    if (iw <= 1 || ih <= 1) return null;
    if (!node.__panoWrappedErpCache) node.__panoWrappedErpCache = { src: "", w: 0, h: 0, canvas: null };
    const src = String(img.src || "");
    const cached = node.__panoWrappedErpCache;
    if (cached.canvas && cached.src === src && cached.w === iw && cached.h === ih) return cached.canvas;
    const cv = document.createElement("canvas");
    cv.width = iw * 2;
    cv.height = ih;
    const cctx = cv.getContext("2d");
    if (!cctx) return null;
    cctx.drawImage(img, 0, 0, iw, ih);
    cctx.drawImage(img, iw, 0, iw, ih);
    node.__panoWrappedErpCache = { src, w: iw, h: ih, canvas: cv };
    return cv;
  }

  function drawErpBackgroundUnwrap(rect) {
    const img = getConnectedErpImage();
    if (!img || !img.complete || !(img.naturalWidth || img.width)) return;
    if (renderErpViewToContext2D({
      owner: node,
      cacheKey: "modal_unwrap_bg",
      ctx,
      rect,
      img,
      mode: "unwrap",
      backgroundOpacity: 0.94,
    })) {
      return;
    }
    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  function drawErpBackgroundPano() {
    const img = getConnectedErpImage();
    if (!img || !img.complete || !(img.naturalWidth || img.width)) return;
    if (renderErpViewToContext2D({
      owner: node,
      cacheKey: "modal_pano_bg",
      ctx,
      rect: { x: 0, y: 0, w: canvas.width, h: canvas.height },
      img,
      mode: "panorama",
      yawDeg: Number(editor.viewYaw || 0),
      pitchDeg: Number(editor.viewPitch || 0),
      fovDeg: Number(editor.viewFov || 100),
    })) {
      return;
    }
    const iw = Number(img.naturalWidth || img.width || 0);
    const ih = Number(img.naturalHeight || img.height || 0);
    if (iw <= 1 || ih <= 1) return;
    const wrapped = getWrappedErpCanvas(img);
    if (!wrapped) return;
    const q = String(state.ui_settings?.preview_quality || "balanced");
    const cacheKey = [
      String(img.src || ""),
      iw,
      ih,
      canvas.width,
      canvas.height,
      q,
      Number(editor.viewYaw || 0).toFixed(4),
      Number(editor.viewPitch || 0).toFixed(4),
      Number(editor.viewFov || 100).toFixed(4),
    ].join("|");
    const cached = node.__panoPanoBackgroundCache;
    if (cached?.canvas && cached.key === cacheKey) {
      ctx.drawImage(cached.canvas, 0, 0);
      return;
    }
    const bgCanvas = document.createElement("canvas");
    bgCanvas.width = canvas.width;
    bgCanvas.height = canvas.height;
    const bgCtx = bgCanvas.getContext("2d");
    if (!bgCtx) return;
    const Nu = q === "high" ? 44 : (q === "draft" ? 24 : 32);
    const Nv = q === "high" ? 28 : (q === "draft" ? 14 : 20);
    const verts = Array.from({ length: Nv + 1 }, () => Array(Nu + 1).fill(null));
    const sample = Array.from({ length: Nv + 1 }, () => Array(Nu + 1).fill(null));

    for (let j = 0; j <= Nv; j += 1) {
      for (let i = 0; i <= Nu; i += 1) {
        const x = (canvas.width * i) / Nu;
        const y = (canvas.height * j) / Nv;
        const d = screenToWorldDir(x, y);
        const ll = dirToLonLat(d);
        let u = (ll.lon / (2 * Math.PI) + 0.5) * iw;
        while (u < 0) u += iw;
        while (u >= iw) u -= iw;
        const v = (0.5 - ll.lat / Math.PI) * ih;
        verts[j][i] = { x, y };
        sample[j][i] = { x: u, y: v };
      }
    }

    bgCtx.save();
    bgCtx.globalAlpha = 0.94;
    for (let j = 0; j < Nv; j += 1) {
      for (let i = 0; i < Nu; i += 1) {
        const p00 = verts[j][i];
        const p10 = verts[j][i + 1];
        const p01 = verts[j + 1][i];
        const p11 = verts[j + 1][i + 1];
        if (!p00 || !p10 || !p01 || !p11) continue;
        const s00 = { ...sample[j][i] };
        const s10 = { ...sample[j][i + 1] };
        const s01 = { ...sample[j + 1][i] };
        const s11 = { ...sample[j + 1][i + 1] };
        const umin = Math.min(s00.x, s10.x, s01.x, s11.x);
        const umax = Math.max(s00.x, s10.x, s01.x, s11.x);
        if (umax - umin > iw * 0.5) {
          [s00, s10, s01, s11].forEach((s) => {
            if (s.x < iw * 0.5) s.x += iw;
          });
        }
        drawImageTriTo(bgCtx, wrapped, s00, s10, s11, p00, p10, p11);
        drawImageTriTo(bgCtx, wrapped, s00, s11, s01, p00, p11, p01);
      }
    }
    bgCtx.restore();
    node.__panoPanoBackgroundCache = { key: cacheKey, canvas: bgCanvas };
    ctx.drawImage(bgCanvas, 0, 0);
  }

  function pruneUnusedAssets() {
    if (type !== "stickers") return;
    const used = new Set(
      (state.stickers || [])
        .map((s) => String(s?.asset_id || ""))
        .filter((id) => !!id),
    );
    Object.keys(state.assets || {}).forEach((id) => {
      if (!used.has(id)) {
        delete state.assets[id];
        imageCache.delete(id);
      }
    });
  }

  function dirToLonLat(d) {
    return {
      lon: Math.atan2(d.x, d.z),
      lat: Math.asin(clamp(d.y, -1, 1)),
    };
  }

  function projectDirUnwrap(d, refX = null) {
    const { lon, lat } = dirToLonLat(d);
    const r = getUnwrapRect();
    let x = r.x + ((lon / (2 * Math.PI)) + 0.5) * r.w;
    const y = r.y + (0.5 - (lat / Math.PI)) * r.h;
    if (refX !== null) {
      while (x - refX > r.w / 2) x -= r.w;
      while (x - refX < -r.w / 2) x += r.w;
    }
    return { x, y, z: 1 };
  }

  function getStickerFrame(item) {
    const centerDir = yawPitchToDir(Number(item.yaw_deg || 0), Number(item.pitch_deg || 0));
    let upWorld = vec3(0, 1, 0);
    if (Math.abs(dot(centerDir, upWorld)) > 0.999) upWorld = vec3(0, 0, 1);
    const right = norm(cross(upWorld, centerDir));
    const up = norm(cross(centerDir, right));

    const tanX = Math.tan(clamp(Number(item.hFOV_deg || 20), 0.1, 179) * 0.5 * DEG2RAD);
    const tanY = Math.tan(clamp(Number(item.vFOV_deg || 20), 0.1, 179) * 0.5 * DEG2RAD);
    const rot = Number(item.rot_deg || item.roll_deg || 0) * DEG2RAD;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    return {
      centerDir,
      right,
      up,
      tanX,
      tanY,
      cr,
      sr,
    };
  }

  function stickerDirFromFrame(frame, x, y) {
    const xr = x * frame.cr - y * frame.sr;
    const yr = x * frame.sr + y * frame.cr;
    return norm(add(add(frame.centerDir, mul(frame.right, xr)), mul(frame.up, yr)));
  }

  function stickerCornersDir(item) {
    const frame = getStickerFrame(item);

    // Corner order is fixed to: top-left, top-right, bottom-right, bottom-left
    const cornersLocal = [
      { u: -1, v: 1 },
      { u: 1, v: 1 },
      { u: 1, v: -1 },
      { u: -1, v: -1 },
    ];

    return cornersLocal.map(({ u, v }) => {
      return stickerDirFromFrame(frame, u * frame.tanX, v * frame.tanY);
    });
  }

  function stickerSampleDir(item, u, v) {
    const frame = getStickerFrame(item);

    const x = (u * 2 - 1) * frame.tanX;
    const y = (1 - v * 2) * frame.tanY;
    return stickerDirFromFrame(frame, x, y);
  }

  function drawImageTriTo(targetCtx, img, s0, s1, s2, d0, d1, d2) {
    const denom = (s0.x * (s1.y - s2.y)) + (s1.x * (s2.y - s0.y)) + (s2.x * (s0.y - s1.y));
    if (Math.abs(denom) < 1e-6) return;

    const a = ((d0.x * (s1.y - s2.y)) + (d1.x * (s2.y - s0.y)) + (d2.x * (s0.y - s1.y))) / denom;
    const b = ((d0.x * (s2.x - s1.x)) + (d1.x * (s0.x - s2.x)) + (d2.x * (s1.x - s0.x))) / denom;
    const c = ((d0.x * (s1.x * s2.y - s2.x * s1.y)) + (d1.x * (s2.x * s0.y - s0.x * s2.y)) + (d2.x * (s0.x * s1.y - s1.x * s0.y))) / denom;
    const d = ((d0.y * (s1.y - s2.y)) + (d1.y * (s2.y - s0.y)) + (d2.y * (s0.y - s1.y))) / denom;
    const e = ((d0.y * (s2.x - s1.x)) + (d1.y * (s0.x - s2.x)) + (d2.y * (s1.x - s0.x))) / denom;
    const f = ((d0.y * (s1.x * s2.y - s2.x * s1.y)) + (d1.y * (s2.x * s0.y - s0.x * s2.y)) + (d2.y * (s0.x * s1.y - s1.x * s0.y))) / denom;

    const [e0, e1, e2] = expandTri(d0, d1, d2, 0.45);
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.moveTo(e0.x, e0.y);
    targetCtx.lineTo(e1.x, e1.y);
    targetCtx.lineTo(e2.x, e2.y);
    targetCtx.closePath();
    targetCtx.clip();
    targetCtx.setTransform(a, d, b, e, c, f);
    targetCtx.drawImage(img, 0, 0);
    targetCtx.restore();
  }

  function drawImageTri(img, s0, s1, s2, d0, d1, d2) {
    drawImageTriTo(ctx, img, s0, s1, s2, d0, d1, d2);
  }

  function getMeshDivisions() {
    const q = String(state.ui_settings?.preview_quality || "balanced");
    if (q === "draft") {
      if (editor.hqFrames && editor.hqFrames > 0) return [28, 20];
      if (editor.interaction) return [12, 9];
      return [20, 14];
    }
    if (q === "high") {
      if (editor.hqFrames && editor.hqFrames > 0) return [48, 36];
      if (editor.interaction) return [20, 14];
      return [36, 26];
    }
    if (editor.hqFrames && editor.hqFrames > 0) return [40, 30];
    if (editor.interaction) return [16, 12];
    return [28, 20];
  }

  function drawGridUnwrap(skipBackground = false) {
    const w = canvas.width;
    const h = canvas.height;
    const r = getUnwrapRect();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    if (!skipBackground) {
      ctx.fillStyle = "#070707";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#070707";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (!skipBackground) drawErpBackgroundUnwrap(r);
    rebuildPaintEngineIfNeeded();
    const erpRaster = editor.paintEngine?.getErpTarget?.()?.displayPaint?.canvas || null;
    if (erpRaster) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(erpRaster, r.x, r.y, r.w, r.h);
      ctx.restore();
    }

    if (editor.showGrid && !editor.fullscreen) {
      ctx.strokeStyle = "#3f3f46";
      for (let i = 0; i <= 16; i += 1) {
        const x = r.x + (r.w * i) / 16;
        ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      }
      for (let i = 0; i <= 8; i += 1) {
        const y = r.y + (r.h * i) / 8;
        ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
      }

      ctx.strokeStyle = "rgba(250, 250, 250, 0.86)";
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(r.x, r.y + r.h / 2); ctx.lineTo(r.x + r.w, r.y + r.h / 2); ctx.stroke();

      ctx.fillStyle = "rgba(250, 250, 250, 0.42)";
      ctx.font = "500 11px Geist, sans-serif";
      ctx.textAlign = "center";
      const ly = r.y + r.h * 0.57;
      ctx.fillText("Left", r.x + r.w * 0.25, ly);
      ctx.fillText("Front", r.x + r.w * 0.50, ly);
      ctx.fillText("Right", r.x + r.w * 0.75, ly);
      ctx.fillText("Back", r.x + 38, ly);
      ctx.fillText("Back", r.x + r.w - 38, ly);
    }
  }

  function drawLineOnSphere(pointsDir, color, width = 1) {
    let started = false;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const d of pointsDir) {
      const p = projectDir(d);
      if (!p) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else { ctx.lineTo(p.x, p.y); }
    }
    ctx.stroke();
  }

  function drawGridPano(skipBackground = false) {
    const w = canvas.width;
    const h = canvas.height;
    if (!skipBackground) {
      ctx.fillStyle = "#070707";
      ctx.fillRect(0, 0, w, h);
    }
    if (!skipBackground) drawErpBackgroundPano();
    rebuildPaintEngineIfNeeded();
    const erpRaster = editor.paintEngine?.getErpTarget?.()?.displayPaint?.canvas || null;
    if (erpRaster) {
      // During active paint stroke or lasso fill, append point count to backgroundRevision so
      // WebGL re-uploads displayPaint every frame (live preview). Otherwise use the committed
      // revision key so texture upload is skipped when nothing changed.
      const _iKind = editor.interaction?.kind;
      const _iGeo = editor.interaction?.stroke?.geometry;
      const activePoints = (_iKind === "paint_stroke" || _iKind === "paint_lasso_fill")
        ? `_live${_iGeo?.rawPoints?.length ?? _iGeo?.points?.length ?? 0}`
        : "";
      renderErpViewToContext2D({
        owner: node,
        cacheKey: "modal_pano_paint_raster",
        ctx,
        rect: { x: 0, y: 0, w, h },
        backgroundSource: erpRaster,
        backgroundRevision: getPaintingRevisionKey() + activePoints,
        mode: "panorama",
        yawDeg: editor.viewYaw,
        pitchDeg: editor.viewPitch,
        fovDeg: editor.viewFov,
      });
    }

    if (editor.showGrid && !editor.fullscreen) {
      for (let lon = -180; lon <= 180; lon += 15) {
        const pts = [];
        for (let lat = -89; lat <= 89; lat += 4) pts.push(yawPitchToDir(lon, lat));
        drawLineOnSphere(pts, "#3f3f46", lon % 90 === 0 ? 1.3 : 1);
      }
      for (let lat = -75; lat <= 75; lat += 15) {
        const pts = [];
        for (let lon = -180; lon <= 180; lon += 4) pts.push(yawPitchToDir(lon, lat));
        drawLineOnSphere(pts, lat === 0 ? "rgba(250, 250, 250, 0.86)" : "#3f3f46", lat === 0 ? 1.5 : 1);
      }

      const labels = [
        { name: "Left", dir: yawPitchToDir(-90, 0) },
        { name: "Front", dir: yawPitchToDir(0, 0) },
        { name: "Right", dir: yawPitchToDir(90, 0) },
        { name: "Back", dir: yawPitchToDir(180, 0) },
      ];
      ctx.fillStyle = "rgba(250, 250, 250, 0.42)";
      ctx.font = "500 11px Geist, sans-serif";
      ctx.textAlign = "center";
      labels.forEach((l) => {
        const p = projectDir(l.dir);
        if (p) ctx.fillText(l.name, p.x, p.y + 24);
      });
    }
  }

  function renderModalStickerScene() {
    try {
      if (type !== "stickers") return false;
      if (editor.mode !== "pano" && editor.mode !== "unwrap") return false;
      const scene = buildEditorStickerScene();
      const textures = buildEditorStickerTextures(scene);
      if (!Array.isArray(scene?.stickers) || scene.stickers.length === 0 || textures.length === 0) return false;
      const view = editor.mode === "unwrap"
        ? { mode: "unwrap" }
        : buildPanoramaViewParamsFromEditor(editor);
      return renderSceneToContext2D({
        owner: node,
        cacheKey: editor.mode === "unwrap" ? "modal_unwrap_scene" : "modal_pano_scene",
        ctx,
        rect: editor.mode === "unwrap" ? getUnwrapRect() : { x: 0, y: 0, w: canvas.width, h: canvas.height },
        backgroundSource: null,
        backgroundRevision: "",
        textures,
        scene,
        view,
      });
    } catch (err) {
      void err;
      return false;
    }
  }

  function objectGeom(item) {
    const centerDir = yawPitchToDir(Number(item.yaw_deg || 0), Number(item.pitch_deg || 0));
    const center = editor.mode === "unwrap" ? projectDirUnwrap(centerDir) : projectDir(centerDir);
    if (!center) return { visible: false };
    const projectDirForShape = (d, refX = null) => {
      if (editor.mode === "unwrap") return projectDirUnwrap(d, refX);
      const { right, up, fwd } = cameraBasis();
      const cx = dot(d, right);
      const cy = dot(d, up);
      const cz = dot(d, fwd);
      const w = canvas.width;
      const h = canvas.height;
      const hfov = editor.viewFov * DEG2RAD;
      const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (h / Math.max(w, 1)));
      const sx = (w / 2) / Math.tan(hfov / 2);
      const sy = (h / 2) / Math.tan(vfov / 2);
      const z = Math.max(cz, 1e-4);
      const guard = Math.max(w, h) * 2.0;
      return {
        x: clamp(w / 2 + (cx / z) * sx, -guard, w + guard),
        y: clamp(h / 2 - (cy / z) * sy, -guard, h + guard),
        z,
      };
    };
    const frame = getStickerFrame(item);
    const cornersDir = stickerCornersDir(item);
    const corners = cornersDir.map((d) => projectDirForShape(d, center.x));
    const rotateStemBaseDir = stickerDirFromFrame(frame, 0, frame.tanY);
    const rotateHandleDir = stickerDirFromFrame(frame, 0, frame.tanY + Math.max(frame.tanY * 0.43, 0.053));
    const rotateStemBase = projectDirForShape(rotateStemBaseDir, center.x);
    const rotateHandleHint = projectDirForShape(rotateHandleDir, rotateStemBase?.x ?? center.x);
    const handleDx = (rotateHandleHint?.x ?? rotateStemBase.x) - rotateStemBase.x;
    const handleDy = (rotateHandleHint?.y ?? rotateStemBase.y) - rotateStemBase.y;
    const handleLen = Math.hypot(handleDx, handleDy) || 1;
    const rotateHandle = {
      x: rotateStemBase.x + (handleDx / handleLen) * 30,
      y: rotateStemBase.y + (handleDy / handleLen) * 30,
    };
    const topEdgeCenter = projectDirForShape(stickerDirFromFrame(frame, 0, frame.tanY), center.x);
    const rightEdgeCenter = projectDirForShape(stickerDirFromFrame(frame, frame.tanX, 0), center.x);
    const bottomEdgeCenter = projectDirForShape(stickerDirFromFrame(frame, 0, -frame.tanY), center.x);
    const leftEdgeCenter = projectDirForShape(stickerDirFromFrame(frame, -frame.tanX, 0), center.x);
    const edgeMidpoints = [
      {
        edge: "top",
        x: topEdgeCenter.x,
        y: topEdgeCenter.y,
        a: { x: corners[0].x, y: corners[0].y },
        b: { x: corners[1].x, y: corners[1].y },
      },
      {
        edge: "right",
        x: rightEdgeCenter.x,
        y: rightEdgeCenter.y,
        a: { x: corners[1].x, y: corners[1].y },
        b: { x: corners[2].x, y: corners[2].y },
      },
      {
        edge: "bottom",
        x: bottomEdgeCenter.x,
        y: bottomEdgeCenter.y,
        a: { x: corners[2].x, y: corners[2].y },
        b: { x: corners[3].x, y: corners[3].y },
      },
      {
        edge: "left",
        x: leftEdgeCenter.x,
        y: leftEdgeCenter.y,
        a: { x: corners[3].x, y: corners[3].y },
        b: { x: corners[0].x, y: corners[0].y },
      },
    ];
    return {
      center: { x: center.x, y: center.y },
      corners: corners.map((c) => ({ x: c.x, y: c.y })),
      edgeMidpoints,
      rotateStemBase: { x: rotateStemBase.x, y: rotateStemBase.y },
      rotateHandle,
      topEdge: { a: 0, b: 1 },
      visible: true,
    };
  }

  function drawStickerMeshMapped(item, img, dstRect, srcRect, alpha = 1) {
    const dx0 = clamp(Math.min(Number(dstRect.x0 ?? 0), Number(dstRect.x1 ?? 1)), 0, 1);
    const dy0 = clamp(Math.min(Number(dstRect.y0 ?? 0), Number(dstRect.y1 ?? 1)), 0, 1);
    const dx1 = clamp(Math.max(Number(dstRect.x0 ?? 0), Number(dstRect.x1 ?? 1)), 0, 1);
    const dy1 = clamp(Math.max(Number(dstRect.y0 ?? 0), Number(dstRect.y1 ?? 1)), 0, 1);
    const sx0 = clamp(Math.min(Number(srcRect.x0 ?? 0), Number(srcRect.x1 ?? 1)), 0, 1);
    const sy0 = clamp(Math.min(Number(srcRect.y0 ?? 0), Number(srcRect.y1 ?? 1)), 0, 1);
    const sx1 = clamp(Math.max(Number(srcRect.x0 ?? 0), Number(srcRect.x1 ?? 1)), 0, 1);
    const sy1 = clamp(Math.max(Number(srcRect.y0 ?? 0), Number(srcRect.y1 ?? 1)), 0, 1);

    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const [Nu, Nv] = getMeshDivisions();
    const centerDir = yawPitchToDir(Number(item.yaw_deg || 0), Number(item.pitch_deg || 0));
    const centerProj = editor.mode === "unwrap" ? projectDirUnwrap(centerDir) : null;

    const verts = [];
    for (let j = 0; j <= Nv; j += 1) {
      for (let i = 0; i <= Nu; i += 1) {
        const u = i / Nu;
        const v = j / Nv;
        const wu = dx0 + (dx1 - dx0) * u;
        const wv = dy0 + (dy1 - dy0) * v;
        const su = (sx0 + (sx1 - sx0) * u) * iw;
        const sv = (sy0 + (sy1 - sy0) * v) * ih;
        const d = stickerSampleDir(item, wu, wv);
        const p = editor.mode === "unwrap" ? projectDirUnwrap(d, centerProj?.x ?? null) : projectDir(d);
        verts.push({ p, s: { x: su, y: sv } });
      }
    }

    const W = canvas.width;
    let drawnTriangles = 0;
    for (let j = 0; j < Nv; j += 1) {
      for (let i = 0; i < Nu; i += 1) {
        const idx = (jj, ii) => jj * (Nu + 1) + ii;
        const v00 = verts[idx(j, i)];
        const v10 = verts[idx(j, i + 1)];
        const v11 = verts[idx(j + 1, i + 1)];
        const v01 = verts[idx(j + 1, i)];
        if (!v00.p || !v10.p || !v11.p || !v01.p) continue;

        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha;
        drawImageTri(img, v00.s, v10.s, v11.s, v00.p, v10.p, v11.p);
        drawImageTri(img, v00.s, v11.s, v01.s, v00.p, v11.p, v01.p);
        ctx.globalAlpha = prevAlpha;
        drawnTriangles += 2;

        if (editor.mode === "unwrap") {
          const p00p = { x: v00.p.x + W, y: v00.p.y };
          const p10p = { x: v10.p.x + W, y: v10.p.y };
          const p11p = { x: v11.p.x + W, y: v11.p.y };
          const p01p = { x: v01.p.x + W, y: v01.p.y };
          const p00m = { x: v00.p.x - W, y: v00.p.y };
          const p10m = { x: v10.p.x - W, y: v10.p.y };
          const p11m = { x: v11.p.x - W, y: v11.p.y };
          const p01m = { x: v01.p.x - W, y: v01.p.y };
          const prevAlpha2 = ctx.globalAlpha;
          ctx.globalAlpha = alpha;
          drawImageTri(img, v00.s, v10.s, v11.s, p00p, p10p, p11p);
          drawImageTri(img, v00.s, v11.s, v01.s, p00p, p11p, p01p);
          drawImageTri(img, v00.s, v10.s, v11.s, p00m, p10m, p11m);
          drawImageTri(img, v00.s, v11.s, v01.s, p00m, p11m, p01m);
          ctx.globalAlpha = prevAlpha2;
          drawnTriangles += 4;
        }
      }
    }
    return drawnTriangles > 0;
  }

  function drawStickerMesh(item, img) {
    return drawStickerMeshMapped(item, img, { x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: 1, y1: 1 }, 1);
  }

  function sampleStickerEdge(item, edge, steps, refX = null) {
    const out = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      let u = 0;
      let v = 0;
      if (edge === 0) { u = t; v = 0; }         // top
      else if (edge === 1) { u = 1; v = t; }    // right
      else if (edge === 2) { u = 1 - t; v = 1; } // bottom
      else { u = 0; v = 1 - t; }                // left

      const d = stickerSampleDir(item, u, v);
      const p = editor.mode === "unwrap" ? projectDirUnwrap(d, refX) : projectDir(d);
      if (p) out.push(p);
    }
    return out;
  }

  function drawStickerBoundary(item, selected) {
    const centerDir = yawPitchToDir(Number(item.yaw_deg || 0), Number(item.pitch_deg || 0));
    const centerProj = editor.mode === "unwrap" ? projectDirUnwrap(centerDir) : null;
    const refX = centerProj ? centerProj.x : null;
    const steps = editor.mode === "pano" ? 28 : 20;
    const edges = [
      sampleStickerEdge(item, 0, steps, refX),
      sampleStickerEdge(item, 1, steps, refX),
      sampleStickerEdge(item, 2, steps, refX),
      sampleStickerEdge(item, 3, steps, refX),
    ];

    ctx.strokeStyle = selected ? "rgba(250, 250, 250, 0.9)" : "#71717a";
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    let started = false;
    for (const edge of edges) {
      for (const p of edge) {
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
    }
    ctx.closePath();
    ctx.stroke();
  }

  function renderModalStickerBodyFallback() {
    if (type !== "stickers") return false;
    let anyDrawn = false;
    const items = [...getList()].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
    for (const item of items) {
      if (item?.visible === false) continue;
      const g = objectGeom(item);
      const img = getStickerImage(item);
      const alpha = getStickerDisplayAlpha(item);
      if (img && (img.complete || img.width)) {
        if (drawStickerMeshMapped(item, img, { x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: 1, y1: 1 }, alpha)) {
          anyDrawn = true;
        }
        continue;
      }
      if (!g.visible) continue;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(g.corners[0].x, g.corners[0].y);
      for (let i = 1; i < 4; i += 1) ctx.lineTo(g.corners[i].x, g.corners[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
      anyDrawn = true;
    }
    return anyDrawn;
  }

  function drawObjects() {
    const [usedNu, usedNv] = getMeshDivisions();
    const rawList = getList();
    const orderKey = rawList.map((item) => `${String(item?.id || "")}:${Number(item?.z_index || 0)}`).join("|");
    if (!editor._sortedItemsCache || editor._sortedItemsCache.src !== rawList || editor._sortedItemsCache.orderKey !== orderKey) {
      editor._sortedItemsCache = {
        src: rawList,
        orderKey,
        sorted: [...rawList].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0)),
      };
    }
    const items = editor._sortedItemsCache.sorted;
    for (const item of items) {
      const selected = item.id === editor.selectedId;
      const g = objectGeom(item);
      if (type !== "stickers" && !g.visible) {
        continue;
      }

      if (type === "stickers") {
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = getStickerDisplayAlpha(item);
        drawStickerBoundary(item, selected);
        ctx.globalAlpha = prevAlpha;
      } else {
        ctx.fillStyle = selected ? "rgba(0, 112, 243, 0.24)" : "rgba(255, 255, 255, 0.12)";
        ctx.beginPath();
        ctx.moveTo(g.corners[0].x, g.corners[0].y);
        for (let i = 1; i < 4; i += 1) ctx.lineTo(g.corners[i].x, g.corners[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = selected ? "rgba(255, 255, 255, 1)" : "rgba(255, 255, 255, 0.82)";
        ctx.lineWidth = selected ? 2.8 : 1.9;
        ctx.beginPath();
        ctx.moveTo(g.corners[0].x, g.corners[0].y);
        for (let i = 1; i < 4; i += 1) ctx.lineTo(g.corners[i].x, g.corners[i].y);
        ctx.closePath();
        ctx.stroke();
      }

      if (selected && g.visible) {
        const accent = (type === "stickers" && isExternalSticker(item)) ? "#f59e0b" : "#0070f3";
        ctx.fillStyle = accent;
        g.corners.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 6.5, 0, Math.PI * 2); ctx.fill(); });
        if (type === "cutout") {
          ctx.strokeStyle = accent;
          ctx.lineCap = "round";
          ctx.lineWidth = 4;
          g.edgeMidpoints.forEach((m) => {
            const dx = (m.b?.x ?? m.x) - (m.a?.x ?? m.x);
            const dy = (m.b?.y ?? m.y) - (m.a?.y ?? m.y);
            const ll2 = Math.hypot(dx, dy) || 1;
            const tx = dx / ll2;
            const ty = dy / ll2;
            const half = 10;
            ctx.beginPath();
            ctx.moveTo(m.x - tx * half, m.y - ty * half);
            ctx.lineTo(m.x + tx * half, m.y + ty * half);
            ctx.stroke();
          });
          ctx.lineCap = "butt";
        }
        ctx.strokeStyle = "rgba(250, 250, 250, 0.9)";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(g.rotateStemBase.x, g.rotateStemBase.y);
        ctx.lineTo(g.rotateHandle.x, g.rotateHandle.y);
        ctx.stroke();
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(g.rotateHandle.x, g.rotateHandle.y, 10, 0, Math.PI * 2); ctx.fill();
      }
    }

    if (editor.hqFrames && usedNu >= 40 && usedNv >= 30) {
      editor.hqFrames -= 1;
      if (editor.hqFrames > 0) requestDraw();
    }
  }

  function drawCutoutOutputPreview() {
    if (type !== "cutout") return;
    const shot = getSelected() || state.shots?.[0];
    if (!shot) {
      editor.outputPreviewRect = null;
      if (outputPreviewToggleBtn) outputPreviewToggleBtn.style.display = "none";
      return;
    }

    const margin = 14;
    const mix = clamp(Number(editor.outputPreviewAnim ?? (editor.outputPreviewExpanded ? 1 : 0)), 0, 1);
    const maxWCollapsed = Math.max(120, Math.min(250, canvas.width * 0.28));
    const maxWExpanded = Math.max(260, Math.min(560, canvas.width * 0.62));
    const maxHCollapsed = Math.max(76, Math.min(150, canvas.height * 0.22));
    const maxHExpanded = Math.max(160, Math.min(340, canvas.height * 0.48));
    const maxW = lerp(maxWCollapsed, maxWExpanded, mix);
    const maxH = lerp(maxHCollapsed, maxHExpanded, mix);
    const cutoutView = buildCutoutViewParamsFromShot(shot);
    const aspect = Number(cutoutView?.aspect || 1);
    let pw = maxW;
    let ph = pw / aspect;
    if (ph > maxH) {
      ph = maxH;
      pw = ph * aspect;
    }
    const px = canvas.width - margin - pw;
    const py = margin;
    const radius = 12;
    editor.outputPreviewRect = { x: px, y: py, w: pw, h: ph };
    const placeOutputPreviewToggle = () => {
      if (!outputPreviewToggleBtn) return;
      const left = `${Math.round(px + pw - 8 - 24)}px`;
      const top = `${Math.round(py + 8)}px`;
      outputPreviewToggleBtn.style.display = "inline-flex";
      if (outputPreviewToggleBtn.style.left !== left) outputPreviewToggleBtn.style.left = left;
      if (outputPreviewToggleBtn.style.top !== top) outputPreviewToggleBtn.style.top = top;
    };

    const roundedRect = (x, y, w, h, r) => {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, rr);
      } else {
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
      }
      ctx.closePath();
    };

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 22;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = "rgba(10, 10, 10, 0.72)";
    roundedRect(px, py, pw, ph, radius);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundedRect(px, py, pw, ph, radius);
    ctx.clip();

    const img = getConnectedErpImage();
    const previewRect = { x: px, y: py, w: pw, h: ph };
    const erpPreviewRaster = editor.paintEngine?.getErpTarget?.()?.displayPaint?.canvas || null;
    const getLivePaintRevisionSuffix = () => {
      const interactionKind = String(editor.interaction?.kind || "");
      const geometry = editor.interaction?.stroke?.geometry || null;
      if (interactionKind !== "paint_stroke" && interactionKind !== "paint_lasso_fill") return "";
      return `_live${geometry?.rawPoints?.length ?? geometry?.points?.length ?? 0}`;
    };

    const renderPreviewPaint = () => {
      if (erpPreviewRaster) {
        renderCutoutViewToContext2D({
          owner: node,
          cacheKey: "modal_cutout_output_preview_paint",
          ctx,
          rect: previewRect,
          img: erpPreviewRaster,
          view: cutoutView,
          backgroundRevision: getPaintingRevisionKey() + getLivePaintRevisionSuffix(),
          backgroundOpacity: 1,
        });
      }
    };

    if (!img || !img.complete || !(img.naturalWidth || img.width)) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
      renderPreviewPaint();
      ctx.restore();
      placeOutputPreviewToggle();
      return;
    }

    if (Number(img.naturalWidth || img.width || 0) <= 1 || Number(img.naturalHeight || img.height || 0) <= 1) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
      renderPreviewPaint();
      ctx.restore();
      placeOutputPreviewToggle();
      return;
    }

    const glDrawn = renderCutoutViewToContext2D({
      owner: node,
      cacheKey: "modal_cutout_output_preview",
      ctx,
      rect: previewRect,
      img,
      view: cutoutView,
    });
    const fallbackDrawn = !glDrawn && drawCutoutProjectionPreview(
      ctx,
      node,
      img,
      previewRect,
      shot,
      mix > 0.65 ? "high" : "balanced",
    );
    void fallbackDrawn;
    renderPreviewPaint();
    ctx.restore();
    placeOutputPreviewToggle();
  }

  function projectErpStrokeToCurrentView(stroke) {
    const geometry = stroke?.geometry;
    if (!geometry || geometry.geometryKind !== "freehand_open") return [];
    const points = getStrokePointList(stroke, "points");
    return points.map((pt, index) => {
      const dirs = getWorldOffsetDirForStrokePoint(stroke, pt, index, points, null);
      return projectWorldDirToCurrentViewSample(dirs.centerDir, dirs.offsetDir);
    }).filter(Boolean);
  }

  function frameLocalPointToWorldDir(shot, point) {
    if (!shot || !point) return null;
    const u = Number(point.x || 0);
    const v = Number(point.y || 0);
    return stickerSampleDir(shot, u, v);
  }

  function erpPointToWorldDir(point) {
    if (!point) return null;
    const lon = (Number(point.u || 0) - 0.5) * (2 * Math.PI);
    const lat = (0.5 - Number(point.v || 0)) * Math.PI;
    const cp = Math.cos(lat);
    return vec3(cp * Math.sin(lon), Math.sin(lat), cp * Math.cos(lon));
  }

  function getStrokePointList(stroke, key = "points") {
    const geometry = stroke?.geometry;
    const points = Array.isArray(geometry?.[key]) ? geometry[key] : [];
    return points;
  }

  function getTargetSpaceCoord(point) {
    if (!point || typeof point !== "object") return { x: 0, y: 0 };
    return { x: Number(point?.u || 0), y: Number(point?.v || 0) };
  }

  function cloneTargetPointWithCoords(template, x, y, extra = {}) {
    const base = {
      ...template,
      t: Number(template?.t || 0),
      widthScale: getStrokePointScalar(template, "widthScale", 1),
      pressureLike: getStrokePointScalar(template, "pressureLike", 1),
    };
    return { ...base, ...extra, u: x, v: y };
  }

  function interpolateTargetPoint(a, b, t) {
    const ac = getTargetSpaceCoord(a);
    const bc = getTargetSpaceCoord(b);
    return cloneTargetPointWithCoords(a, lerp(ac.x, bc.x, t), lerp(ac.y, bc.y, t), {
      t: lerp(Number(a?.t || 0), Number(b?.t || 0), t),
      widthScale: lerp(getStrokePointScalar(a, "widthScale", 1), getStrokePointScalar(b, "widthScale", 1), t),
      pressureLike: lerp(getStrokePointScalar(a, "pressureLike", 1), getStrokePointScalar(b, "pressureLike", 1), t),
    });
  }

  function getFreehandResampleSpacing(targetSpace, finalPass = false) {
    return finalPass ? 0.0012 : 0.0018;
  }

  function processFreehandPoints(rawPoints, targetSpace, finalPass = false) {
    if (!Array.isArray(rawPoints) || !rawPoints.length) return [];
    if (rawPoints.length === 1) return [cloneTargetPointWithCoords(rawPoints[0], getTargetSpaceCoord(rawPoints[0]).x, getTargetSpaceCoord(rawPoints[0]).y)];
    const spacing = getFreehandResampleSpacing(targetSpace, finalPass);
    const buildUniformSamples = (srcPoints, sampleSpacing) => {
      const cumulative = [0];
      for (let i = 1; i < srcPoints.length; i += 1) {
        const a = getTargetSpaceCoord(srcPoints[i - 1]);
        const b = getTargetSpaceCoord(srcPoints[i]);
        cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const totalLen = cumulative[cumulative.length - 1] || 0;
      if (totalLen <= 1e-8) {
        const only = srcPoints[0];
        const onlyCoord = getTargetSpaceCoord(only);
        return [cloneTargetPointWithCoords(only, onlyCoord.x, onlyCoord.y)];
      }
      const out = [];
      let segIndex = 0;
      for (let d = 0; d <= totalLen + 1e-9; d += sampleSpacing) {
        while (segIndex < cumulative.length - 2 && cumulative[segIndex + 1] < d) segIndex += 1;
        const s0 = cumulative[segIndex];
        const s1 = cumulative[segIndex + 1];
        const range = Math.max(1e-8, s1 - s0);
        out.push(interpolateTargetPoint(srcPoints[segIndex], srcPoints[segIndex + 1], clamp((d - s0) / range, 0, 1)));
      }
      const tail = srcPoints[srcPoints.length - 1];
      const tailCoord = getTargetSpaceCoord(tail);
      const prev = out[out.length - 1];
      const prevCoord = prev ? getTargetSpaceCoord(prev) : null;
      if (!prevCoord || Math.hypot(prevCoord.x - tailCoord.x, prevCoord.y - tailCoord.y) > sampleSpacing * 0.35) {
        out.push(cloneTargetPointWithCoords(tail, tailCoord.x, tailCoord.y));
      }
      return out;
    };
    const chaikinPass = (srcPoints) => {
      if (!Array.isArray(srcPoints) || srcPoints.length < 3) return srcPoints ? srcPoints.slice() : [];
      const out = [cloneTargetPointWithCoords(srcPoints[0], getTargetSpaceCoord(srcPoints[0]).x, getTargetSpaceCoord(srcPoints[0]).y)];
      for (let i = 0; i < srcPoints.length - 1; i += 1) {
        const a = srcPoints[i];
        const b = srcPoints[i + 1];
        const ac = getTargetSpaceCoord(a);
        const bc = getTargetSpaceCoord(b);
        const q = cloneTargetPointWithCoords(a,
          (ac.x * 0.75) + (bc.x * 0.25),
          (ac.y * 0.75) + (bc.y * 0.25),
          {
            t: (Number(a.t || 0) * 0.75) + (Number(b.t || 0) * 0.25),
            widthScale: (getStrokePointScalar(a, "widthScale", 1) * 0.75) + (getStrokePointScalar(b, "widthScale", 1) * 0.25),
            pressureLike: (getStrokePointScalar(a, "pressureLike", 1) * 0.75) + (getStrokePointScalar(b, "pressureLike", 1) * 0.25),
          });
        const r = cloneTargetPointWithCoords(a,
          (ac.x * 0.25) + (bc.x * 0.75),
          (ac.y * 0.25) + (bc.y * 0.75),
          {
            t: (Number(a.t || 0) * 0.25) + (Number(b.t || 0) * 0.75),
            widthScale: (getStrokePointScalar(a, "widthScale", 1) * 0.25) + (getStrokePointScalar(b, "widthScale", 1) * 0.75),
            pressureLike: (getStrokePointScalar(a, "pressureLike", 1) * 0.25) + (getStrokePointScalar(b, "pressureLike", 1) * 0.75),
          });
        out.push(q, r);
      }
      out.push(cloneTargetPointWithCoords(srcPoints[srcPoints.length - 1], getTargetSpaceCoord(srcPoints[srcPoints.length - 1]).x, getTargetSpaceCoord(srcPoints[srcPoints.length - 1]).y));
      return out;
    };
    const resampled = buildUniformSamples(rawPoints, spacing);
    if (resampled.length < 3) return resampled;
    const passes = finalPass ? 2 : 1;
    let curved = resampled.slice();
    for (let i = 0; i < passes; i += 1) curved = chaikinPass(curved);
    const finalPoints = buildUniformSamples(curved, Math.max(spacing * 0.75, 0.00055));
    return finalPoints;
  }

  function getStrokePointScalar(point, name, fallback = 1) {
    const value = Number(point?.[name]);
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  }

  function getStrokeRadiusSpec(stroke) {
    const radiusValue = Number(stroke?.radiusValue);
    if (Number.isFinite(radiusValue) && radiusValue > 0) {
      const model = String(stroke?.radiusModel || "").trim() || "erp_uv_norm";
      if (model === "world_angle") {
        return {
          model: "erp_uv_norm",
          value: Math.max(1e-6, Number(stroke?.size || 10) * 0.5 / 2048),
        };
      }
      return {
        model,
        value: radiusValue,
      };
    }
    return {
      model: "erp_uv_norm",
      value: Math.max(1e-6, Number(stroke?.size || 10) * 0.5 / 2048),
    };
  }

  function createRasterSurface(width, height) {
    const surface = document.createElement("canvas");
    surface.width = Math.max(1, Math.round(width));
    surface.height = Math.max(1, Math.round(height));
    const surfaceCtx = surface.getContext("2d");
    if (surfaceCtx) {
      surfaceCtx.clearRect(0, 0, surface.width, surface.height);
      surfaceCtx.imageSmoothingEnabled = true;
    }
    return { canvas: surface, ctx: surfaceCtx };
  }

  function getPaintingRevisionKey() {
    // Tracks stroke changes (commit, undo/redo, clear all).
    return String(editor.paintStrokeRevision);
  }

  function rebuildPaintEngineIfNeeded() {
    const key = getPaintingRevisionKey();
    if (editor.paintEngineRevisionKey === key) return;
    editor.paintEngineRevisionKey = key;
    editor.paintEngine?.rebuildCommitted(state);
  }

  function getActivePaintTargetDescriptor() {
    return { kind: "ERP_GLOBAL", width: 2048, height: 1024 };
  }

  function getSourcePoint2D(stroke, point) {
    return { x: Number(point?.u || 0), y: Number(point?.v || 0) };
  }

  function getStrokeNormal2D(stroke, points, index) {
    const prev = getSourcePoint2D(stroke, points[Math.max(0, index - 1)] || points[index]);
    const next = getSourcePoint2D(stroke, points[Math.min(points.length - 1, index + 1)] || points[index]);
    const dx = Number(next.x || 0) - Number(prev.x || 0);
    const dy = Number(next.y || 0) - Number(prev.y || 0);
    const len = Math.hypot(dx, dy);
    // When prev === next (single-point stroke or zero-length segment), use a default
    // right-facing normal so the offset point yields a valid non-zero radiusPx.
    if (len < 1e-12) return { x: 1, y: 0 };
    return { x: -dy / len, y: dx / len };
  }

  function getWorldOffsetDirForStrokePoint(stroke, point, index, points, sourceShot = null) {
    const centerDir = erpPointToWorldDir(point);
    if (!centerDir) return { centerDir: null, offsetDir: null };
    const radiusSpec = getStrokeRadiusSpec(stroke);
    const scale = getStrokePointScalar(point, "widthScale", 1) * getStrokePointScalar(point, "pressureLike", 1);
    if (radiusSpec.model === "world_angle") {
      const prevDir = erpPointToWorldDir(points[Math.max(0, index - 1)] || point);
      const nextDir = erpPointToWorldDir(points[Math.min(points.length - 1, index + 1)] || point);
      const tangent = norm(vec3(
        Number((nextDir?.x || centerDir.x) - (prevDir?.x || centerDir.x)),
        Number((nextDir?.y || centerDir.y) - (prevDir?.y || centerDir.y)),
        Number((nextDir?.z || centerDir.z) - (prevDir?.z || centerDir.z)),
      ));
      const normal3 = norm(cross(tangent, centerDir));
      const offsetDir = norm(add(centerDir, mul(normal3, Math.tan(radiusSpec.value * scale))));
      return { centerDir, offsetDir };
    }
    const normal2 = getStrokeNormal2D(stroke, points, index);
    const offsetPt = {
      ...point,
      u: Number(point?.u || 0) + (normal2.x * radiusSpec.value * scale),
      v: Number(point?.v || 0) + (normal2.y * radiusSpec.value * scale),
    };
    return {
      centerDir,
      offsetDir: erpPointToWorldDir(offsetPt),
    };
  }

  function projectWorldDirToCurrentViewSample(centerDir, offsetDir) {
    if (!centerDir || !offsetDir) return null;
    if (editor.mode === "unwrap") {
      const r = getUnwrapRect();
      const cll = dirToLonLat(centerDir);
      const oll = dirToLonLat(offsetDir);
      const center = {
        x: r.x + (((cll.lon / (2 * Math.PI)) + 0.5) * r.w),
        y: r.y + ((0.5 - (cll.lat / Math.PI)) * r.h),
      };
      const offset = {
        x: r.x + (((oll.lon / (2 * Math.PI)) + 0.5) * r.w),
        y: r.y + ((0.5 - (oll.lat / Math.PI)) * r.h),
      };
      return {
        x: center.x,
        y: center.y,
        radiusPx: Math.max(0.5, Math.hypot(offset.x - center.x, offset.y - center.y)),
        z: 1,
      };
    }
    const center = projectDir(centerDir);
    const offset = projectDir(offsetDir);
    if (!center || !offset || Number(center.z || 0) <= 0 || Number(offset.z || 0) <= 0) return null;
    return {
      x: center.x,
      y: center.y,
      radiusPx: Math.max(0.5, Math.hypot(offset.x - center.x, offset.y - center.y)),
      z: center.z,
    };
  }

  function projectWorldDirToFrameRectSample(targetShot, rect, centerDir, offsetDir) {
    if (!targetShot || !rect || !centerDir || !offsetDir) return null;
    const centerLocal = worldDirToFrameLocalPoint(targetShot, centerDir);
    const offsetLocal = worldDirToFrameLocalPoint(targetShot, offsetDir);
    if (!centerLocal || !offsetLocal) return null;
    const center = {
      x: Number(rect.x || 0) + (Number(centerLocal.x || 0) * Number(rect.w || 0)),
      y: Number(rect.y || 0) + (Number(centerLocal.y || 0) * Number(rect.h || 0)),
    };
    const offset = {
      x: Number(rect.x || 0) + (Number(offsetLocal.x || 0) * Number(rect.w || 0)),
      y: Number(rect.y || 0) + (Number(offsetLocal.y || 0) * Number(rect.h || 0)),
    };
    return {
      x: center.x,
      y: center.y,
      radiusPx: Math.max(0.5, Math.hypot(offset.x - center.x, offset.y - center.y)),
      z: 1,
    };
  }

  function getNativeRadiusPxForStrokePoint(stroke, point, targetWidth, targetHeight, shot = null) {
    const spec = getStrokeRadiusSpec(stroke);
    const scale = getStrokePointScalar(point, "widthScale", 1) * getStrokePointScalar(point, "pressureLike", 1);
    if (spec.model === "erp_uv_norm") return Math.max(0.5, spec.value * targetWidth * scale);
    if (spec.model === "world_angle") {
      if (shot) {
        return Math.max(0.5, ((spec.value / Math.max(1e-6, Number(shot.hFOV_deg || 90) * DEG2RAD)) * targetWidth) * scale);
      }
      return Math.max(0.5, ((spec.value / (2 * Math.PI)) * targetWidth) * scale);
    }
    return Math.max(0.5, Number(stroke?.size || 10) * 0.5 * scale);
  }

  function configureStrokeFill(targetCtx, stroke, options = {}) {
    const layerKind = String(stroke?.layerKind || "paint");
    const toolKind = String(stroke?.toolKind || "pen");
    const preview = options.preview === true;
    const markerAlphaScale = preview ? 0.78 : 1;
    targetCtx.globalAlpha = toolKind === "marker" ? 0.7 * markerAlphaScale : 1;
    if (layerKind === "mask") {
      targetCtx.fillStyle = preview ? "rgba(34, 197, 94, 0.75)" : "rgba(255,255,255,1)";
      return;
    }
    if (toolKind === "eraser") {
      targetCtx.globalCompositeOperation = "destination-out";
      targetCtx.fillStyle = "rgba(0,0,0,1)";
      return;
    }
    const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
    const alpha = preview ? Math.max(0.28, Number(c.a ?? 1) * 0.88) : Math.max(0.12, Number(c.a ?? 1));
    targetCtx.fillStyle = `rgba(${Math.round(Number(c.r || 0) * 255)}, ${Math.round(Number(c.g || 0) * 255)}, ${Math.round(Number(c.b || 0) * 255)}, ${alpha})`;
  }

  function drawDiscStamp(targetCtx, sample, maxRadiusPx) {
    const r = Math.max(0.5, Math.min(maxRadiusPx, Number(sample?.radiusPx || 0.5)));
    if (!Number.isFinite(sample?.x) || !Number.isFinite(sample?.y) || !Number.isFinite(r)) return;
    targetCtx.beginPath();
    targetCtx.arc(Number(sample.x || 0), Number(sample.y || 0), r, 0, Math.PI * 2);
    targetCtx.fill();
  }

  function drawStampedStroke(targetCtx, samples, stroke, bounds, options = {}) {
    if (!targetCtx || !Array.isArray(samples) || !samples.length) return;
    const maxRadiusPx = Math.max(bounds.w, bounds.h) * 0.25;
    targetCtx.save();
    configureStrokeFill(targetCtx, stroke, options);
    const drawSample = (sample) => drawDiscStamp(targetCtx, sample, maxRadiusPx);
    if (samples.length === 1) {
      drawSample(samples[0]);
      targetCtx.restore();
      return;
    }
    for (let i = 0; i < samples.length - 1; i += 1) {
      const a = samples[i];
      const b = samples[i + 1];
      if (!a || !b) continue;
      const ax = Number(a.x || 0);
      const ay = Number(a.y || 0);
      const bx = Number(b.x || 0);
      const by = Number(b.y || 0);
      const ar = Math.max(0.5, Math.min(maxRadiusPx, Number(a.radiusPx || 0.5)));
      const br = Math.max(0.5, Math.min(maxRadiusPx, Number(b.radiusPx || 0.5)));
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      if (!Number.isFinite(ar) || !Number.isFinite(br)) continue;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len) || len < 1e-6) {
        drawSample(a);
        continue;
      }
      if (len > Math.max(bounds.w, bounds.h) * 0.5) continue;
      const minRadius = Math.max(0.5, Math.min(ar, br));
      const step = Math.max(0.35, Math.min(minRadius * 0.4, 2.25));
      const count = Math.max(1, Math.ceil(len / step));
      for (let j = 0; j <= count; j += 1) {
        const t = j / count;
        drawSample({
          x: lerp(ax, bx, t),
          y: lerp(ay, by, t),
          radiusPx: lerp(ar, br, t),
        });
      }
    }
    drawSample(samples[samples.length - 1]);
    targetCtx.restore();
  }

  function drawNativeStrokePath(targetCtx, samples, stroke, bounds) {
    drawStampedStroke(targetCtx, samples, stroke, bounds, { preview: false });
  }

  function drawNativeLassoFill(targetCtx, points, stroke, bounds, axisKeys) {
    if (!targetCtx || !Array.isArray(points) || points.length < 3) return;
    const xKey = axisKeys?.x || "u";
    const yKey = axisKeys?.y || "v";
    targetCtx.save();
    if (String(stroke?.layerKind || "") === "mask") {
      targetCtx.fillStyle = "rgba(255,255,255,1)";
    } else if (String(stroke?.toolKind || "") === "eraser") {
      targetCtx.globalCompositeOperation = "destination-out";
      targetCtx.fillStyle = "rgba(0,0,0,1)";
    } else {
      const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
      targetCtx.fillStyle = `rgba(${Math.round(Number(c.r || 0) * 255)}, ${Math.round(Number(c.g || 0) * 255)}, ${Math.round(Number(c.b || 0) * 255)}, ${Number(c.a ?? 1)})`;
    }
    targetCtx.beginPath();
    targetCtx.moveTo(Number(points[0]?.[xKey] || 0) * bounds.w, Number(points[0]?.[yKey] || 0) * bounds.h);
    for (let i = 1; i < points.length; i += 1) {
      targetCtx.lineTo(Number(points[i]?.[xKey] || 0) * bounds.w, Number(points[i]?.[yKey] || 0) * bounds.h);
    }
    targetCtx.closePath();
    targetCtx.fill();
    targetCtx.restore();
  }

  function worldDirToFrameLocalPoint(shot, dir) {
    if (!shot || !dir) return null;
    const frame = getStickerFrame(shot);
    const cz = dot(dir, frame.centerDir);
    if (!Number.isFinite(cz) || cz <= 1e-6) return null;
    const xr = dot(dir, frame.right) / cz;
    const yr = dot(dir, frame.up) / cz;
    const x = (xr * frame.cr) + (yr * frame.sr);
    const y = (-xr * frame.sr) + (yr * frame.cr);
    return {
      x: (x / Math.max(1e-6, frame.tanX) + 1) * 0.5,
      y: (1 - (y / Math.max(1e-6, frame.tanY))) * 0.5,
    };
  }

  function projectErpStrokeToFrameRect(stroke, shot, rect) {
    const geometry = stroke?.geometry;
    if (!geometry || geometry.geometryKind !== "freehand_open" || !shot || !rect) return [];
    const points = getStrokePointList(stroke, "points");
    return points.map((pt, index) => {
      const dirs = getWorldOffsetDirForStrokePoint(stroke, pt, index, points, null);
      return projectWorldDirToFrameRectSample(shot, rect, dirs.centerDir, dirs.offsetDir);
    }).filter(Boolean);
  }

  function drawProjectedStrokePath(projected, stroke, options = {}) {
    if (!Array.isArray(projected) || projected.length < 1) return;
    drawStampedStroke(ctx, projected, stroke, { w: canvas.width, h: canvas.height }, options);
  }

  function drawProjectedStrokeSegments(segments, stroke, options = {}) {
    segments.forEach((segment) => drawProjectedStrokePath(segment, stroke, options));
  }

  function projectLassoPointsToCurrentView(points) {
    if (!Array.isArray(points) || points.length < 3) return [];
    if (editor.mode === "unwrap") {
      const r = getUnwrapRect();
      return points.map((pt) => ({
        x: r.x + (Number(pt.u || 0) * r.w),
        y: r.y + (Number(pt.v || 0) * r.h),
      }));
    }
    const projected = points.map((pt) => projectDir(erpPointToWorldDir(pt))).filter(Boolean);
    return projected.every((pt) => Number(pt.z || 0) > 0)
      ? projected.map((pt) => ({ x: Number(pt.x || 0), y: Number(pt.y || 0) }))
      : [];
  }

  function isProjectedPolygonContinuous(projected, maxJump = 160) {
    if (!Array.isArray(projected) || projected.length < 3) return false;
    for (let i = 0; i < projected.length; i += 1) {
      const a = projected[i];
      const b = projected[(i + 1) % projected.length];
      if (!a || !b) return false;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;
      if (Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y)) > maxJump) return false;
    }
    return true;
  }

  function projectLassoPointsToFrameView(points, shot, rect) {
    if (!Array.isArray(points) || points.length < 3 || !shot || !rect) return [];
    const projected = points.map((pt) => ({
      x: Number(rect.x || 0) + (Number(pt.x || 0) * Number(rect.w || 0)),
      y: Number(rect.y || 0) + (Number(pt.y || 0) * Number(rect.h || 0)),
    }));
    return isProjectedPolygonContinuous(projected, Math.max(80, Math.max(rect.w, rect.h) * 0.75)) ? projected : [];
  }

  function projectErpLassoPointsToFrameRect(points, shot, rect) {
    if (!Array.isArray(points) || points.length < 3 || !shot || !rect) return [];
    const projected = [];
    for (const pt of points) {
      const dir = erpPointToWorldDir(pt);
      const local = worldDirToFrameLocalPoint(shot, dir);
      if (!local) return [];
      projected.push({
        x: Number(rect.x || 0) + (Number(local.x || 0) * Number(rect.w || 0)),
        y: Number(rect.y || 0) + (Number(local.y || 0) * Number(rect.h || 0)),
      });
    }
    return isProjectedPolygonContinuous(projected, Math.max(80, Math.max(rect.w, rect.h) * 0.75)) ? projected : [];
  }

  function drawLassoPreviewPolygon(projected, stroke, options = {}) {
    if (!Array.isArray(projected) || projected.length < 3) return;
    const layerKind = String(stroke?.layerKind || "paint");
    const toolKind = String(stroke?.toolKind || "pen");
    const preview = options.preview === true;
    ctx.save();
    if (layerKind === "mask") {
      ctx.fillStyle = `rgba(34, 197, 94, ${preview ? 0.55 : 0.85})`;
    } else if (toolKind === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
      const fillAlpha = preview ? Math.max(0.12, Number(c.a ?? 1) * 0.45) : Math.max(0.2, Number(c.a ?? 1));
      const strokeAlpha = preview ? Math.max(0.28, Number(c.a ?? 1) * 0.9) : Math.max(0.32, Number(c.a ?? 1));
      ctx.fillStyle = `rgba(${Math.round(Number(c.r || 0) * 255)}, ${Math.round(Number(c.g || 0) * 255)}, ${Math.round(Number(c.b || 0) * 255)}, ${fillAlpha})`;
      ctx.strokeStyle = `rgba(${Math.round(Number(c.r || 0) * 255)}, ${Math.round(Number(c.g || 0) * 255)}, ${Math.round(Number(c.b || 0) * 255)}, ${strokeAlpha})`;
      ctx.lineWidth = 1.5;
    }
    ctx.beginPath();
    ctx.moveTo(Number(projected[0].x || 0), Number(projected[0].y || 0));
    for (let i = 1; i < projected.length; i += 1) ctx.lineTo(Number(projected[i].x || 0), Number(projected[i].y || 0));
    ctx.closePath();
    ctx.fill();
    if (layerKind !== "mask" && toolKind !== "eraser") ctx.stroke();
    ctx.restore();
  }

  function drawFrameViewBackground() {
    const shot = getActiveCutoutShot();
    const rect = getFrameViewRect(shot);
    const img = getConnectedErpImage();
    if (!shot || !rect) return false;
    ctx.save();
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = "rgba(14, 14, 14, 1)";
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    if (img && (img.complete || img.naturalWidth || img.width) && Number(img.naturalWidth || img.width || 0) > 1 && Number(img.naturalHeight || img.height || 0) > 1) {
      const view = buildCutoutViewParamsFromShot(shot);
      const glDrawn = renderCutoutViewToContext2D({
        owner: node,
        cacheKey: `modal_frame_bg_${String(shot.id || "")}`,
        ctx,
        rect,
        img,
        view,
      });
      if (!glDrawn) {
        drawCutoutProjectionPreview(
          ctx,
          node,
          img,
          rect,
          shot,
          String(state.ui_settings?.preview_quality || "balanced"),
        );
      }
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    rebuildPaintEngineIfNeeded();
    // Project ERP paint into the frame rect so strokes are world-fixed.
    // Frame paint is now stored in ERP_GLOBAL space; the cutout projection shows
    // the correct slice of the panorama paint for the current frame orientation.
    const erpRaster = editor.paintEngine?.getErpTarget?.()?.displayPaint?.canvas || null;
    if (erpRaster) {
      const _iKind = editor.interaction?.kind;
      const _iGeo = editor.interaction?.stroke?.geometry;
      const activePoints = (_iKind === "paint_stroke" || _iKind === "paint_lasso_fill")
        ? `_live${_iGeo?.rawPoints?.length ?? _iGeo?.points?.length ?? 0}`
        : "";
      renderCutoutViewToContext2D({
        owner: node,
        cacheKey: `modal_frame_paint_${String(shot.id || "")}`,
        ctx,
        rect,
        img: erpRaster,
        view: buildCutoutViewParamsFromShot(shot),
        backgroundRevision: getPaintingRevisionKey() + activePoints,
      });
    }
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    ctx.restore();
    return true;
  }

  // Draw dashed outline for the lasso fill region while the user is still drawing.
  // The fill itself is rendered at 50% by the paint engine (lassoPreviewActive).
  // This overlay adds a visible dashed border on the 2D canvas.
  function drawLassoOutlineOverlay() {
    if (editor.interaction?.kind !== "paint_lasso_fill") return;
    const stroke = editor.interaction.stroke;
    const points = stroke?.geometry?.points;
    let projected;
    if (editor.mode === "frame") {
      const shot = getActiveCutoutShot();
      const rect = getFrameViewRect(shot);
      projected = projectErpLassoPointsToFrameRect(points, shot, rect);
    } else {
      projected = projectLassoPointsToCurrentView(points);
    }
    if (!Array.isArray(projected) || projected.length < 3) return;

    const c = stroke?.color || { r: 1, g: 0.25, b: 0.25, a: 1 };
    const cr = Math.round(Number(c.r || 0) * 255);
    const cg = Math.round(Number(c.g || 0) * 255);
    const cb = Math.round(Number(c.b || 0) * 255);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(Number(projected[0].x || 0), Number(projected[0].y || 0));
    for (let i = 1; i < projected.length; i++) ctx.lineTo(Number(projected[i].x || 0), Number(projected[i].y || 0));
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},1)`;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawScene() {
    if (editor.mode === "frame") drawFrameViewBackground();
    else if (editor.mode === "unwrap") drawGridUnwrap(false);
    else drawGridPano(false);
    const stickerSceneDrawn = renderModalStickerScene();
    if (type === "stickers" && !stickerSceneDrawn) {
      renderModalStickerBodyFallback();
    }
    if (editor.mode !== "frame") drawObjects();
    if (editor.mode !== "frame") drawCutoutOutputPreview();
    drawLassoOutlineOverlay();
    if (fovValueEl) fovValueEl.textContent = `${editor.viewFov.toFixed(1)}`;
    updateSelectionMenu();
    if (!runtime.hasPresentedFrame) {
      runtime.hasPresentedFrame = true;
      canvas.style.opacity = "1";
    }
  }

  function isCutoutTransformInteractionActive() {
    if (type !== "cutout") return false;
    const kind = String(editor.interaction?.kind || "");
    return kind === "move" || kind === "scale" || kind === "scale_x" || kind === "scale_y" || kind === "rotate";
  }

  function requestDraw(options = {}) {
    const localOnly = !!options.localOnly;
    syncLookAtFrameButtonState();
    syncViewToggleState();
    if (!localOnly) {
      node.__panoLiveStateOverride = JSON.stringify(state);
      if (!isCutoutTransformInteractionActive()) {
        node.__panoDomPreview?.requestDraw?.();
        node.setDirtyCanvas?.(true, false);
        node.graph?.setDirtyCanvas?.(true, true);
        app?.canvas?.setDirty?.(true, true);
      }
    }
    runtime.dirty = true;
  }

  function syncCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const nextW = Math.max(2, Math.round(rect.width));
    const nextH = Math.max(2, Math.round(rect.height));
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
      runtime.dirty = true;
      if (type === "cutout") {
        runtime.pendingStableLayoutFrames = Math.max(Number(runtime.pendingStableLayoutFrames || 0), 1);
      }
      return true;
    }
    return false;
  }

  function tick(ts = performance.now()) {
    if (!runtime.running) return;
    const dt = runtime.lastTickTs > 0 ? Math.max(0.001, (ts - runtime.lastTickTs) / 1000) : (1 / 60);
    runtime.lastTickTs = ts;
    if (editor.outputPreviewAnim !== editor.outputPreviewAnimTo) {
      const dur = Math.max(1, Number(editor.outputPreviewAnimDurationMs || 180));
      const t = clamp((ts - Number(editor.outputPreviewAnimStartTs || 0)) / dur, 0, 1);
      const expanding = editor.outputPreviewAnimTo > editor.outputPreviewAnimFrom;
      const eased = expanding ? easeOutCubic(t) : easeInCubic(t);
      editor.outputPreviewAnim = lerp(editor.outputPreviewAnimFrom, editor.outputPreviewAnimTo, eased);
      runtime.dirty = true;
      if (t >= 1) {
        editor.outputPreviewAnim = editor.outputPreviewAnimTo;
      }
    }

    if (editor.viewTween?.active) {
      const tw = editor.viewTween;
      const t = clamp((ts - tw.startTs) / tw.durationMs, 0, 1);
      const eased = easeInOutCubic(t);
      editor.viewYaw = wrapYaw(tw.startYaw + tw.deltaYaw * eased);
      editor.viewPitch = tw.startPitch + (tw.targetPitch - tw.startPitch) * eased;
      editor.viewFov = tw.startFov + (tw.targetFov - tw.startFov) * eased;
      runtime.dirty = true;
      if (t >= 1) editor.viewTween = null;
    }

    editor.viewInertia.vx = Number(viewController.state.inertia.vx || 0);
    editor.viewInertia.vy = Number(viewController.state.inertia.vy || 0);
    editor.viewInertia.active = !!viewController.state.inertia.active;
    if (viewController.stepInertia(ts)) {
      editor.viewInertia.vx = Number(viewController.state.inertia.vx || 0);
      editor.viewInertia.vy = Number(viewController.state.inertia.vy || 0);
      editor.viewInertia.active = !!viewController.state.inertia.active;
      runtime.dirty = true;
    }

    if (runtime.dirty || (ts - runtime.lastSizeCheckTs) >= 220) {
      syncCanvasSize();
      runtime.lastSizeCheckTs = ts;
    }
    if (runtime.pendingStableLayoutFrames > 0) {
      runtime.pendingStableLayoutFrames -= 1;
      runtime.dirty = true;
    }
    if (runtime.dirty) {
      if (runtime.pendingStableLayoutFrames > 0) {
        runtime.rafId = requestAnimationFrame(tick);
        return;
      }
      runtime.dirty = false;
      drawScene();
    }
    runtime.rafId = requestAnimationFrame(tick);
  }

  function stopRenderLoop() {
    runtime.running = false;
    if (runtime.rafId) cancelAnimationFrame(runtime.rafId);
    runtime.rafId = 0;
  }

  function pushHistory() {
    if (readOnly) return;
    editor.historyController.commitActionGroup(JSON.stringify(cloneStateForHistorySnapshot(state)));
  }

  function restoreHistory(step) {
    if (readOnly) return;
    const snapshot = step < 0 ? editor.historyController.undo() : editor.historyController.redo();
    if (!snapshot) return;
    const parsed = JSON.parse(snapshot);
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, parsed);
    editor.selectedId = type === "stickers" ? state.active.selected_sticker_id : state.active.selected_shot_id;
    editor.paintStrokeRevision += 1;
    syncPaintUi();
    updateSidePanel();
    commitState();
    requestDraw();
    syncPaintingLayerAsync();
  }

  function syncPaintUi() {
    toolRail?.querySelectorAll("[data-tool-mode]").forEach((btn) => {
      const active = btn.getAttribute("data-tool-mode") === editor.primaryTool;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    if (paintFooter) {
      const showFooter = editor.primaryTool === "paint" || editor.primaryTool === "mask";
      paintFooter.hidden = !showFooter;
      paintFooter.querySelectorAll("[data-paint-group]").forEach((group) => {
        const mode = group.getAttribute("data-paint-group");
        group.hidden = mode !== editor.primaryTool;
      });
      if (paintSizeRow) paintSizeRow.hidden = editor.primaryTool !== "paint";
      if (paintClearRow) paintClearRow.hidden = !(editor.primaryTool === "paint" || editor.primaryTool === "mask");
      if (paintLayerClearCurrentBtn) {
        const label = editor.primaryTool === "mask" ? "Clear mask" : "Clear paint";
        paintLayerClearCurrentBtn.setAttribute("aria-label", label);
        paintLayerClearCurrentBtn.setAttribute("data-tip", label);
      }
      paintFooter.querySelectorAll("[data-paint-tool]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-paint-tool") === editor.paintTool && editor.primaryTool === "paint");
      });
      paintFooter.querySelectorAll("[data-mask-tool]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-mask-tool") === editor.maskTool && editor.primaryTool === "mask");
      });
    }
    if (paintColorRow) {
      const showColorRow = editor.primaryTool === "paint";
      const colorEnabled = showColorRow && editor.paintTool !== "eraser";
      paintColorRow.hidden = !showColorRow;
      paintColorRow.classList.toggle("disabled", !colorEnabled);
      if (!colorEnabled && paintColorPop) paintColorPop.hidden = true;
      const matchedSwatchId = PAINT_COLOR_SWATCHES.find((swatch) => colorsApproximatelyEqual(editor.paintColor, swatch.color))?.id || "";
      paintColorRow.querySelectorAll("[data-paint-color-swatch]").forEach((btn) => {
        const active = btn.getAttribute("data-paint-color-swatch") === matchedSwatchId;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
        btn.disabled = !colorEnabled;
      });
      const customBtn = paintColorRow.querySelector("[data-paint-color-custom]");
      if (customBtn) {
        const customActive = !matchedSwatchId;
        customBtn.classList.toggle("active", customActive);
        customBtn.style.setProperty("--custom-color", colorToCss(editor.customPaintColor, 1));
        customBtn.setAttribute("aria-pressed", customActive ? "true" : "false");
        customBtn.disabled = !colorEnabled;
      }
      if (paintAlphaSlider) paintAlphaSlider.value = String(Math.round(clamp(Number(editor.customPaintColor?.a ?? 1), 0, 1) * 100));
      if (paintAlphaValue) paintAlphaValue.textContent = `${Math.round(clamp(Number(editor.customPaintColor?.a ?? 1), 0, 1) * 100)}%`;
      if (paintColorPreview) paintColorPreview.style.background = colorToCss(editor.customPaintColor);
      if (paintColorPop) {
        const hsv = rgb01ToHsv(editor.customPaintColor);
        paintColorPop.style.setProperty("--picker-hue-color", colorToCss({ ...hsv01ToRgb(hsv.h, 1, 1), a: 1 }, 1));
        paintColorPop.style.setProperty("--picker-sat", `${clamp(hsv.s, 0, 1) * 100}%`);
        paintColorPop.style.setProperty("--picker-val", `${(1 - clamp(hsv.v, 0, 1)) * 100}%`);
        paintColorPop.style.setProperty("--picker-hue", `${clamp(hsv.h, 0, 1) * 100}%`);
      }
      if (paintColorSvCursor) {
        const hsv = rgb01ToHsv(editor.customPaintColor);
        paintColorSvCursor.style.left = `${clamp(hsv.s, 0, 1) * 100}%`;
        paintColorSvCursor.style.top = `${(1 - clamp(hsv.v, 0, 1)) * 100}%`;
      }
      if (paintHueHandle) {
        const hsv = rgb01ToHsv(editor.customPaintColor);
        paintHueHandle.style.left = `${clamp(hsv.h, 0, 1) * 100}%`;
      }
      if (paintColorHistoryWrap && paintColorHistory) {
        const slots = Array.from({ length: 7 }, (_, index) => editor.customPaintHistory[index] || null);
        paintColorHistory.innerHTML = slots.map((color, index) => `
          <button class="pano-paint-color-history-dot${color ? "" : " empty"}" type="button" data-paint-history-index="${index}" ${color ? `style="--swatch:${colorToCss(color, 1)}"` : ""} aria-label="Recent color ${index + 1}" ${color ? "" : "disabled"}></button>
        `).join("");
        paintColorHistory.querySelectorAll("[data-paint-history-index]").forEach((btn) => {
          btn.onclick = () => {
            const idx = Number(btn.getAttribute("data-paint-history-index"));
            const color = editor.customPaintHistory[idx];
            if (!color) return;
            editor.customPaintColor = cloneColor(color);
            editor.paintColor = cloneColor(color);
            syncPaintUi();
          };
        });
      }
    }
    if (paintColorRow && paintFooter && stageWrap) {
      if (paintColorRow.hidden || paintFooter.hidden) {
        paintColorRow.style.left = "";
        paintColorRow.style.bottom = "";
      } else {
        const stageRect = stageWrap.getBoundingClientRect();
        const footerRect = paintFooter.getBoundingClientRect();
        const centerX = ((footerRect.left + footerRect.right) * 0.5) - stageRect.left;
        const bottom = stageRect.bottom - footerRect.top + 10;
        paintColorRow.style.left = `${Math.round(centerX)}px`;
        paintColorRow.style.bottom = `${Math.round(bottom)}px`;
      }
    }
    const sizePresetId = getBrushPresetIdForTool(editor.primaryTool === "paint" ? editor.paintTool : editor.maskTool);
    const currentSize = editor.brushSizes[sizePresetId] ?? 10;
    if (paintSizeSlider) {
      paintSizeSlider.value = String(currentSize);
      const pct = ((currentSize - 1) / 119) * 100;
      paintSizeSlider.style.setProperty("--v", `${clamp(pct, 0, 100)}%`);
    }
    if (paintSizeValue) paintSizeValue.textContent = String(currentSize);
  }

  function addParamRow(container, selected, key, label, min, max, step, enabled = true) {
    const row = document.createElement("div");
    row.dataset.key = key;
    row.dataset.min = String(min);
    row.dataset.max = String(max);
    row.className = "pano-field";
    row.innerHTML = `<label>${label}</label><input type='range' min='${min}' max='${max}' step='${step}' value='${Number(selected[key] || 0)}'><input type='number' min='${min}' max='${max}' step='${step}' value='${formatParamValue(selected[key] || 0)}'>`;
    const [rng, num] = row.querySelectorAll("input");
    const setRangeFill = () => {
      const nMin = Number(min);
      const nMax = Number(max);
      const nVal = Number(rng.value);
      const pct = ((nVal - nMin) / Math.max(1e-6, nMax - nMin)) * 100;
      rng.style.setProperty("--v", `${clamp(pct, 0, 100)}%`);
    };
    rng.disabled = !enabled;
    num.disabled = !enabled;
    const setVal = (v) => {
      if (!enabled) return;
      let out = Number(v);
      if (Number.isNaN(out)) out = 0;
      out = clamp(out, min, max);
      if (key === "yaw_deg") out = wrapYaw(out);
      selected[key] = out;
      rng.value = String(out);
      num.value = formatParamValue(out);
      setRangeFill();
      requestDraw();
    };
    rng.oninput = () => setVal(rng.value);
    num.oninput = () => setVal(num.value);
    rng.onchange = () => pushHistory();
    num.onchange = () => pushHistory();
    setRangeFill();
    container.appendChild(row);
  }

  function syncSidePanelControls() {
    const selected = getSelected();
    if (!selected) return;
    editor.panelLastValues = {
      yaw_deg: Number(selected.yaw_deg || 0),
      pitch_deg: Number(selected.pitch_deg || 0),
      hFOV_deg: Number(selected.hFOV_deg || (type === "stickers" ? 30 : 90)),
      vFOV_deg: Number(selected.vFOV_deg || (type === "stickers" ? 30 : 60)),
      rot_deg: Number(selected.rot_deg || 0),
      roll_deg: Number(selected.roll_deg || 0),
      out_w: Number(selected.out_w || 1024),
      out_h: Number(selected.out_h || 1024),
      aspect_id: getCutoutAspectLabel(selected),
    };
    const rows = side.querySelectorAll(".pano-field[data-key]");
    rows.forEach((row) => {
      const key = row.dataset.key;
      if (!key) return;
      if (!(key in selected)) return;
      const rng = row.querySelector("input[type='range']");
      const num = row.querySelector("input[type='number']");
      if (!rng || !num) return;
      const min = Number(row.dataset.min ?? rng.min ?? 0);
      const max = Number(row.dataset.max ?? rng.max ?? 0);
      let out = Number(selected[key] || 0);
      if (Number.isNaN(out)) out = 0;
      out = clamp(out, min, max);
      const s = String(out);
      if (rng.value !== s) rng.value = s;
      const t = formatParamValue(out);
      if (num.value !== t) num.value = t;
      const pct = ((out - min) / Math.max(1e-6, max - min)) * 100;
      rng.style.setProperty("--v", `${clamp(pct, 0, 100)}%`);
    });
    const resolvedAspect = getCutoutAspectLabel(selected);
    const aspectLabel = side.querySelector(".pano-cutout-aspect-label span");
    if (aspectLabel) aspectLabel.textContent = resolvedAspect;
    const presetBtns = side.querySelectorAll(".pano-cutout-aspect-pop [data-aspect]");
    presetBtns.forEach((btn) => {
      btn.classList.toggle("active", String(btn.getAttribute("data-aspect")) === resolvedAspect);
    });
  }

  function updateSidePanel() {
    if (hideSidebar) return;
    const staticNodes = [...side.children].slice(0, 2);
    side.innerHTML = "";
    staticNodes.forEach((n) => side.appendChild(n));

    const sideActions = side.querySelector(".pano-side-actions");
    if (sideActions) {
      sideActions.innerHTML = "";
    }
    if (previewMode) {
      const inspector = document.createElement("div");
      inspector.className = "pano-inspector";
      const uiDetails = document.createElement("details");
      uiDetails.className = "pano-ui-settings";
      uiDetails.open = false;
      uiDetails.innerHTML = `
      <summary>
        <span class="pano-ui-summary-label">UI Settings</span>
        <span class="pano-ui-caret" aria-hidden="true">${ICON.chevron}</span>
      </summary>
      <div class="pano-ui-settings-body">
        <div class="pano-ui-row">
          <label>Drag X</label>
          <div class="pano-segment" data-setting="invert-x" data-selected="${state.ui_settings?.invert_view_x ? "1" : "0"}">
            <button class="pano-segment-btn" type="button" data-value="0" aria-pressed="${state.ui_settings?.invert_view_x ? "false" : "true"}">Normal</button>
            <button class="pano-segment-btn" type="button" data-value="1" aria-pressed="${state.ui_settings?.invert_view_x ? "true" : "false"}">Inverted</button>
          </div>
        </div>
        <div class="pano-ui-row">
          <label>Drag Y</label>
          <div class="pano-segment" data-setting="invert-y" data-selected="${state.ui_settings?.invert_view_y ? "1" : "0"}">
            <button class="pano-segment-btn" type="button" data-value="0" aria-pressed="${state.ui_settings?.invert_view_y ? "false" : "true"}">Normal</button>
            <button class="pano-segment-btn" type="button" data-value="1" aria-pressed="${state.ui_settings?.invert_view_y ? "true" : "false"}">Inverted</button>
          </div>
        </div>
        <div class="pano-ui-row">
          <label for="pano-ui-quality">Render Quality</label>
          <div class="pano-picker pano-ui-picker" data-ui-picker="quality">
            <button class="pano-picker-trigger" type="button">
              <span class="pano-picker-label"></span>
              <span class="pano-picker-caret">▾</span>
            </button>
            <div class="pano-picker-pop" hidden></div>
          </div>
        </div>
        <div class="pano-ui-row">
          <span></span>
          <button class="pano-btn subtle" type="button" data-action="ui-reset-defaults">Reset Defaults</button>
        </div>
      </div>
    `;
      const segX = uiDetails.querySelector("[data-setting='invert-x']");
      const segY = uiDetails.querySelector("[data-setting='invert-y']");
      const qualityPicker = uiDetails.querySelector("[data-ui-picker='quality']");
      const resetUi = uiDetails.querySelector("[data-action='ui-reset-defaults']");
      const setupUiPicker = (pickerEl, options, getValue, setValue) => {
        const trigger = pickerEl.querySelector(".pano-picker-trigger");
        const label = pickerEl.querySelector(".pano-picker-label");
        const pop = pickerEl.querySelector(".pano-picker-pop");
        const refresh = () => {
          const cur = String(getValue());
          const found = options.find((o) => String(o.value) === cur) || options[0];
          label.textContent = found.label;
          pop.innerHTML = "";
          options.forEach((o) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `pano-picker-item${String(o.value) === cur ? " active" : ""}`;
            b.textContent = o.label;
            b.onclick = () => {
              setValue(o.value);
              pop.hidden = true;
              refresh();
              persistUiSettings();
              requestDraw();
            };
            pop.appendChild(b);
          });
        };
        trigger.onclick = (ev) => {
          ev.stopPropagation();
          uiDetails.querySelectorAll(".pano-ui-picker .pano-picker-pop").forEach((el) => {
            if (el !== pop) el.hidden = true;
          });
          pop.hidden = !pop.hidden;
        };
        refresh();
        return refresh;
      };
      const setSegmentValue = (seg, on) => {
        seg.setAttribute("data-selected", on ? "1" : "0");
        seg.querySelectorAll(".pano-segment-btn").forEach((b) => {
          b.setAttribute("aria-pressed", b.getAttribute("data-value") === (on ? "1" : "0") ? "true" : "false");
        });
      };
      segX.querySelectorAll(".pano-segment-btn").forEach((btn) => {
        btn.onclick = () => {
          const on = btn.getAttribute("data-value") === "1";
          state.ui_settings.invert_view_x = on;
          setSegmentValue(segX, on);
          persistUiSettings();
          requestDraw();
        };
      });
      segY.querySelectorAll(".pano-segment-btn").forEach((btn) => {
        btn.onclick = () => {
          const on = btn.getAttribute("data-value") === "1";
          state.ui_settings.invert_view_y = on;
          setSegmentValue(segY, on);
          persistUiSettings();
          requestDraw();
        };
      });
      const refreshQuality = setupUiPicker(
        qualityPicker,
        [
          { value: "draft", label: "Draft" },
          { value: "balanced", label: "Balanced" },
          { value: "high", label: "High" },
        ],
        () => String(state.ui_settings.preview_quality || "balanced"),
        (v) => {
          const q = String(v || "balanced");
          state.ui_settings.preview_quality = (q === "draft" || q === "high") ? q : "balanced";
        },
      );
      resetUi.onclick = () => {
        state.ui_settings.invert_view_x = false;
        state.ui_settings.invert_view_y = false;
        state.ui_settings.preview_quality = "balanced";
        setSegmentValue(segX, false);
        setSegmentValue(segY, false);
        refreshQuality();
        persistUiSettings();
        requestDraw();
      };
      inspector.appendChild(uiDetails);
      side.appendChild(inspector);

      const footer = document.createElement("div");
      footer.className = "pano-side-footer";
      footer.innerHTML = `<button class="pano-btn pano-btn-primary" data-action="close-preview">Close</button>`;
      footer.querySelector("[data-action='close-preview']").onclick = () => closeEditor();
      side.appendChild(footer);
      installTooltipHandlers(inspector);
      return;
    }

    const list = getList();
    const selected = getSelected();
    if (selected) {
      editor.panelLastValues = {
        yaw_deg: Number(selected.yaw_deg || 0),
        pitch_deg: Number(selected.pitch_deg || 0),
        hFOV_deg: Number(selected.hFOV_deg || (type === "stickers" ? 30 : 90)),
        vFOV_deg: Number(selected.vFOV_deg || (type === "stickers" ? 30 : 60)),
        rot_deg: Number(selected.rot_deg || 0),
        roll_deg: Number(selected.roll_deg || 0),
        out_w: Number(selected.out_w || 1024),
        out_h: Number(selected.out_h || 1024),
        aspect_id: getCutoutAspectLabel(selected),
      };
    }
    const fallback = editor.panelLastValues || (type === "stickers"
      ? { yaw_deg: 0, pitch_deg: 0, hFOV_deg: 30, vFOV_deg: 30, rot_deg: 0 }
      : { yaw_deg: 0, pitch_deg: 0, hFOV_deg: 90, vFOV_deg: 60, roll_deg: 0, out_w: 1024, out_h: 1024, aspect_id: "1:1" });
    const effective = selected || fallback;
    const enabled = !!selected;

    const inspector = document.createElement("div");
    inspector.className = "pano-inspector";
    const counts = paintingStrokeCount(state.painting);
    const summary = document.createElement("div");
    summary.innerHTML = `
      <div class="pano-section-title">
        <span>Paint Rebuild</span>
        <span class="meta">${editor.primaryTool === "cursor" ? "Cursor" : (editor.primaryTool === "paint" ? `Paint · ${editor.paintTool}` : `Mask · ${editor.maskTool}`)}</span>
      </div>
      <div class="pano-param-note">All strokes use ERP_GLOBAL (normalized u,v).</div>
      <div class="pano-param-note">Durable strokes: paint ${counts.paintCount} / mask ${counts.maskCount}</div>
      <div class="pano-section-title">
        <span>Transform</span>
      </div>
    `;
    while (summary.firstChild) inspector.appendChild(summary.firstChild);
    side.appendChild(inspector);

    if (type === "stickers") {
      const targetRow = document.createElement("div");
      targetRow.className = "pano-field-wide pano-target-row";
      targetRow.innerHTML = `
        <label>Image</label>
        <div class="pano-picker">
          <button class="pano-picker-trigger" type="button">
            <span class="pano-picker-label"></span>
            <span class="pano-picker-caret">▾</span>
          </button>
          <div class="pano-picker-pop" hidden></div>
        </div>
      `;
      const trigger = targetRow.querySelector(".pano-picker-trigger");
      const labelEl = targetRow.querySelector(".pano-picker-label");
      const pop = targetRow.querySelector(".pano-picker-pop");
      const items = [{ id: "", label: "No image" }];
      list.forEach((item, i) => {
        const baseLabel = isExternalSticker(item)
          ? String(item.id || EXTERNAL_STICKER_ID)
          : String(state.assets?.[item.asset_id]?.name || item.asset_id || item.id);
        const label = `${i + 1}. ${baseLabel}${isExternalSticker(item) && isStickerHidden(item) ? " (hidden)" : ""}`;
        items.push({ id: item.id, label });
      });
      const currentId = selected?.id || "";
      const currentLabel = (items.find((it) => it.id === currentId) || items[0]).label;
      labelEl.textContent = currentLabel;
      pop.innerHTML = "";
      items.forEach((it) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `pano-picker-item${it.id === currentId ? " active" : ""}`;
        btn.textContent = it.label;
        btn.onclick = () => {
          pop.hidden = true;
          editor.selectedId = it.id || null;
          state.active.selected_sticker_id = editor.selectedId;
          const selectedNow = getSelected();
          if (selectedNow) {
            const targetYaw = wrapYaw(Number(selectedNow.yaw_deg || 0));
            const targetPitch = clamp(Number(selectedNow.pitch_deg || 0), -89.9, 89.9);
            startViewTween(targetYaw, targetPitch, editor.viewFov);
          }
          updateSidePanel();
          updateSelectionMenu();
          requestDraw();
        };
        pop.appendChild(btn);
      });
      trigger.disabled = list.length === 0;
      trigger.onclick = (ev) => {
        ev.stopPropagation();
        if (trigger.disabled) return;
        pop.hidden = !pop.hidden;
      };
      inspector.appendChild(targetRow);
    }

    const toolsRow = document.createElement("div");
    toolsRow.className = "pano-state-actions";
    toolsRow.innerHTML = `<button class="pano-btn subtle pano-btn-tight pano-btn-copy" data-action="copy-state-inline">${ICON.copy}<span>Copy State</span></button>`;
    const copyInline = toolsRow.querySelector("[data-action='copy-state-inline']");
    copyInline.disabled = !enabled;
    copyInline.onclick = async () => {
      if (!enabled) return;
      const text = JSON.stringify(type === "cutout"
        ? buildCanonicalCutoutStickerState(effective)
        : buildCanonicalSelectedStickerState(selected));
      try {
        await navigator.clipboard.writeText(text);
        const label = copyInline.querySelector("span");
        if (label) {
          label.textContent = "Copied";
          window.setTimeout(() => {
            label.textContent = "Copy State";
          }, 900);
        }
      } catch {
        // no-op fallback for environments without clipboard permission
      }
    };
    inspector.appendChild(toolsRow);

    const paramsWrap = document.createElement("div");
    paramsWrap.className = `pano-params${editor.panelWasEnabled ? "" : " disabled"}`;
    inspector.appendChild(paramsWrap);

    if (type === "cutout") {
      const aspectRow = document.createElement("div");
      aspectRow.className = "pano-field-wide pano-aspect-row";
      const aspectLabel = getCutoutAspectLabel(effective);
      aspectRow.innerHTML = `
        <label>Aspect</label>
        <div class="pano-cutout-aspect-inline">
          <div class="pano-picker pano-cutout-aspect-picker">
            <button class="pano-picker-trigger pano-cutout-aspect-trigger" type="button" ${enabled ? "" : "disabled"}>
              <span class="pano-cutout-aspect-label">${ICON.aspect}<span>${aspectLabel}</span></span>
              <span class="pano-picker-caret">▾</span>
            </button>
            <div class="pano-picker-pop pano-cutout-aspect-pop" hidden>
              <div class="pano-cutout-aspect-presets">
                <button class="pano-picker-item" type="button" data-aspect="1:1">1:1</button>
                <button class="pano-picker-item" type="button" data-aspect="4:3">4:3</button>
                <button class="pano-picker-item" type="button" data-aspect="3:2">3:2</button>
                <button class="pano-picker-item" type="button" data-aspect="16:9">16:9</button>
              </div>
              <div class="pano-cutout-aspect-custom">
                <input type="number" min="1" step="1" value="1" data-role="custom-w" aria-label="Aspect width">
                <span>:</span>
                <input type="number" min="1" step="1" value="1" data-role="custom-h" aria-label="Aspect height">
                <button class="pano-btn" type="button" data-action="aspect-custom-apply">Set</button>
              </div>
            </div>
          </div>
          <button class="pano-btn pano-btn-icon pano-cutout-aspect-rotate" type="button" data-action="rotate-90-side" aria-label="Rotate 90°" ${enabled ? "" : "disabled"}>${ICON.rotate_90}</button>
        </div>
      `;
      const trigger = aspectRow.querySelector(".pano-picker-trigger");
      const pop = aspectRow.querySelector(".pano-cutout-aspect-pop");
      const labelSpan = aspectRow.querySelector(".pano-cutout-aspect-label span");
      const cw = aspectRow.querySelector("[data-role='custom-w']");
      const ch = aspectRow.querySelector("[data-role='custom-h']");
      const applyCustomBtn = aspectRow.querySelector("[data-action='aspect-custom-apply']");
      const rotateBtn = aspectRow.querySelector("[data-action='rotate-90-side']");
      const refreshAspectUi = () => {
        const now = getSelected();
        const text = getCutoutAspectLabel(now || effective);
        if (labelSpan) labelSpan.textContent = text;
        const presets = pop.querySelectorAll("[data-aspect]");
        presets.forEach((btn) => {
          btn.classList.toggle("active", String(btn.getAttribute("data-aspect")) === text);
        });
      };
      if (enabled) {
        trigger.onclick = (ev) => {
          ev.stopPropagation();
          pop.hidden = !pop.hidden;
        };
        pop.querySelectorAll("[data-aspect]").forEach((btn) => {
          btn.onclick = () => {
            const now = getSelected();
            if (!now) return;
            applyCutoutAspect(now, String(btn.getAttribute("data-aspect") || "1:1"));
            pop.hidden = true;
            refreshAspectUi();
            syncSidePanelControls();
            pushHistory();
            commitAndRefreshNode();
            requestDraw();
          };
        });
        applyCustomBtn.onclick = () => {
          const now = getSelected();
          if (!now) return;
          const ok = applyCutoutAspectCustom(now, Number(cw.value), Number(ch.value));
          if (!ok) return;
          pop.hidden = true;
          refreshAspectUi();
          syncSidePanelControls();
          pushHistory();
          commitAndRefreshNode();
          requestDraw();
        };
        rotateBtn.onclick = () => {
          const now = getSelected();
          if (!now) return;
          rotateCutoutAspect90(now);
          refreshAspectUi();
          syncSidePanelControls();
          pushHistory();
          commitAndRefreshNode();
          requestDraw();
        };
      }
      refreshAspectUi();
      paramsWrap.appendChild(aspectRow);
    }

    addParamRow(paramsWrap, effective, "yaw_deg", "Yaw", -180, 180, 0.1, enabled && !readOnly);
    addParamRow(paramsWrap, effective, "pitch_deg", "Pitch", -90, 90, 0.1, enabled && !readOnly);
    addParamRow(paramsWrap, effective, "hFOV_deg", "H FOV", 1, 179, 0.1, enabled && !readOnly);
    addParamRow(paramsWrap, effective, "vFOV_deg", "V FOV", 1, 179, 0.1, enabled && !readOnly);
    if (type === "stickers") {
      addParamRow(paramsWrap, effective, "rot_deg", "Rotation", -180, 180, 0.1, enabled && !readOnly);
    } else {
      addParamRow(paramsWrap, effective, "roll_deg", "Roll", -180, 180, 0.1, enabled && !readOnly);
    }

    if (enabled !== editor.panelWasEnabled) {
      requestAnimationFrame(() => {
        paramsWrap.classList.toggle("disabled", !enabled);
      });
    } else {
      paramsWrap.classList.toggle("disabled", !enabled);
    }
    editor.panelWasEnabled = enabled;
    syncLookAtFrameButtonState();

    if (!readOnly) {
      const uiDetails = document.createElement("details");
      uiDetails.className = "pano-ui-settings";
      uiDetails.open = false;
      uiDetails.innerHTML = `
      <summary>
        <span class="pano-ui-summary-label">UI Settings</span>
        <span class="pano-ui-caret" aria-hidden="true">${ICON.chevron}</span>
      </summary>
      <div class="pano-ui-settings-body">
        <div class="pano-ui-row">
          <label>Drag X</label>
          <div class="pano-segment" data-setting="invert-x" data-selected="${state.ui_settings?.invert_view_x ? "1" : "0"}">
            <button class="pano-segment-btn" type="button" data-value="0" aria-pressed="${state.ui_settings?.invert_view_x ? "false" : "true"}">Normal</button>
            <button class="pano-segment-btn" type="button" data-value="1" aria-pressed="${state.ui_settings?.invert_view_x ? "true" : "false"}">Inverted</button>
          </div>
        </div>
        <div class="pano-ui-row">
          <label>Drag Y</label>
          <div class="pano-segment" data-setting="invert-y" data-selected="${state.ui_settings?.invert_view_y ? "1" : "0"}">
            <button class="pano-segment-btn" type="button" data-value="0" aria-pressed="${state.ui_settings?.invert_view_y ? "false" : "true"}">Normal</button>
            <button class="pano-segment-btn" type="button" data-value="1" aria-pressed="${state.ui_settings?.invert_view_y ? "true" : "false"}">Inverted</button>
          </div>
        </div>
        <div class="pano-ui-row">
          <label for="pano-ui-quality">Render Quality</label>
          <div class="pano-picker pano-ui-picker" data-ui-picker="quality">
            <button class="pano-picker-trigger" type="button">
              <span class="pano-picker-label"></span>
              <span class="pano-picker-caret">▾</span>
            </button>
            <div class="pano-picker-pop" hidden></div>
          </div>
        </div>
        <div class="pano-ui-row">
          <span></span>
          <button class="pano-btn subtle" type="button" data-action="ui-reset-defaults">Reset Defaults</button>
        </div>
      </div>
    `;
      const segX = uiDetails.querySelector("[data-setting='invert-x']");
      const segY = uiDetails.querySelector("[data-setting='invert-y']");
      const qualityPicker = uiDetails.querySelector("[data-ui-picker='quality']");
      const resetUi = uiDetails.querySelector("[data-action='ui-reset-defaults']");
      const setupUiPicker = (pickerEl, options, getValue, setValue) => {
        const trigger = pickerEl.querySelector(".pano-picker-trigger");
        const label = pickerEl.querySelector(".pano-picker-label");
        const pop = pickerEl.querySelector(".pano-picker-pop");
        const refresh = () => {
          const cur = String(getValue());
          const found = options.find((o) => String(o.value) === cur) || options[0];
          label.textContent = found.label;
          pop.innerHTML = "";
          options.forEach((o) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `pano-picker-item${String(o.value) === cur ? " active" : ""}`;
            b.textContent = o.label;
            b.onclick = () => {
              setValue(o.value);
              pop.hidden = true;
              refresh();
              persistUiSettings();
              node.setDirtyCanvas(true, true);
              requestDraw();
            };
            pop.appendChild(b);
          });
        };
        trigger.onclick = (ev) => {
          ev.stopPropagation();
          uiDetails.querySelectorAll(".pano-ui-picker .pano-picker-pop").forEach((el) => {
            if (el !== pop) el.hidden = true;
          });
          pop.hidden = !pop.hidden;
        };
        refresh();
        return refresh;
      };
      const setSegmentValue = (seg, on) => {
        seg.setAttribute("data-selected", on ? "1" : "0");
        seg.querySelectorAll(".pano-segment-btn").forEach((b) => {
          b.setAttribute("aria-pressed", b.getAttribute("data-value") === (on ? "1" : "0") ? "true" : "false");
        });
      };
      segX.querySelectorAll(".pano-segment-btn").forEach((btn) => {
        btn.onclick = () => {
          const on = btn.getAttribute("data-value") === "1";
          state.ui_settings.invert_view_x = on;
          setSegmentValue(segX, on);
          persistUiSettings();
          node.setDirtyCanvas(true, true);
          requestDraw();
        };
      });
      segY.querySelectorAll(".pano-segment-btn").forEach((btn) => {
        btn.onclick = () => {
          const on = btn.getAttribute("data-value") === "1";
          state.ui_settings.invert_view_y = on;
          setSegmentValue(segY, on);
          persistUiSettings();
          node.setDirtyCanvas(true, true);
          requestDraw();
        };
      });
      const refreshQuality = setupUiPicker(
        qualityPicker,
        [
          { value: "draft", label: "Draft" },
          { value: "balanced", label: "Balanced" },
          { value: "high", label: "High" },
        ],
        () => String(state.ui_settings.preview_quality || "balanced"),
        (v) => {
          const q = String(v || "balanced");
          state.ui_settings.preview_quality = (q === "draft" || q === "high") ? q : "balanced";
        },
      );
      resetUi.onclick = () => {
        state.ui_settings.invert_view_x = false;
        state.ui_settings.invert_view_y = false;
        state.ui_settings.preview_quality = "balanced";
        setSegmentValue(segX, false);
        setSegmentValue(segY, false);
        refreshQuality();
        persistUiSettings();
        node.setDirtyCanvas(true, true);
        requestDraw();
      };
      inspector.appendChild(uiDetails);
    }

    const footer = document.createElement("div");
    footer.className = "pano-side-footer";
    footer.innerHTML = `
      <button class="pano-btn" data-action="cancel-close">Cancel</button>
      <button class="pano-btn pano-btn-primary" data-action="save-close">Save</button>
    `;
    footer.querySelector("[data-action='cancel-close']").onclick = () => closeEditor();
    footer.querySelector("[data-action='save-close']").onclick = () => {
      apply();
      closeEditor();
    };
    side.appendChild(footer);
    installTooltipHandlers(inspector);
  }

  function isImageFile(file) {
    if (!file) return false;
    const t = String(file.type || "").toLowerCase();
    if (t.startsWith("image/")) return true;
    const n = String(file.name || "").toLowerCase();
    return n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".webp") || n.endsWith(".gif") || n.endsWith(".bmp");
  }

  async function addImageStickerFromFile(file) {
    if (readOnly) return;
    if (type !== "stickers") return;
    if (!isImageFile(file)) return;
    const aid = uid("asset");
    const tempUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("image load failed"));
        i.src = tempUrl;
      });
      imageCache.set(aid, img);
      const uploaded = await uploadStickerAssetFile(file, String(file.name || aid));
      state.assets[aid] = uploaded;
      const ar = (img.naturalHeight || img.height || 1) / (img.naturalWidth || img.width || 1);
      const id = uid("st");
      state.stickers.push({
        id,
        asset_id: aid,
        yaw_deg: editor.viewYaw,
        pitch_deg: editor.viewPitch,
        hFOV_deg: 30,
        vFOV_deg: clamp(30 * ar, 1, 179),
        rot_deg: 0,
        z_index: getNextStickerZIndex(),
      });
      editor.selectedId = id;
      state.active.selected_sticker_id = id;
      pushHistory();
      commitAndRefreshNode();
      updateSidePanel();
      requestDraw();
    } catch (err) {
      console.error("[PanoramaSuite] failed to add sticker asset", err);
      delete state.assets[aid];
      imageCache.delete(aid);
    } finally {
      URL.revokeObjectURL(tempUrl);
    }
  }

  function addImageSticker() {
    if (readOnly) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void addImageStickerFromFile(file);
    };
    input.click();
  }

  async function migrateLegacyEmbeddedAssets() {
    if (readOnly || type !== "stickers") return;
    const assets = state.assets && typeof state.assets === "object" ? state.assets : {};
    const entries = Object.entries(assets).filter(([, asset]) => {
      const t = String(asset?.type || "").toLowerCase();
      const v = String(asset?.value || "");
      return t === "dataurl" && v.startsWith("data:image");
    });
    if (!entries.length) return;
    let changed = false;
    for (const [assetId, asset] of entries) {
      try {
        const dataUrl = String(asset?.value || "");
        if (!dataUrl) continue;
        const blob = await fetch(dataUrl).then((r) => r.blob());
        const ext = String(blob.type || "image/png").split("/")[1] || "png";
        const name = String(asset?.name || `${assetId}.${ext}`);
        const file = new File([blob], name, { type: blob.type || "image/png" });
        const uploaded = await uploadStickerAssetFile(file, name);
        state.assets[assetId] = {
          ...uploaded,
          w: Number(asset?.w || 0),
          h: Number(asset?.h || 0),
        };
        changed = true;
      } catch (err) {
        console.error("[PanoramaSuite] failed to migrate embedded sticker asset", { assetId, err });
      }
    }
    if (changed) {
      commitAndRefreshNode();
      requestDraw();
    }
  }

  function addCutoutFrame() {
    if (readOnly) return;
    if (type !== "cutout") return;
    forceCursorTool();
    state.shots = [{
      id: uid("sh"),
      yaw_deg: editor.viewYaw,
      pitch_deg: editor.viewPitch,
      hFOV_deg: 64,
      vFOV_deg: 40,
      roll_deg: 0,
      out_w: 1024,
      out_h: 1024,
      aspect_id: "1:1",
    }];
    editor.selectedId = state.shots[0].id;
    editor.cutoutAspectOpen = false;
    state.active.selected_shot_id = editor.selectedId;
    pushHistory();
    commitAndRefreshNode();
    updateSidePanel();
    requestDraw();
  }

  function clearCutoutFrame() {
    if (readOnly) return;
    if (type !== "cutout") return;
    state.shots = [];
    editor.selectedId = null;
    if (editor.mode === "frame") editor.mode = "pano";
    editor.cutoutAspectOpen = false;
    state.active.selected_shot_id = null;
    pushHistory();
    commitAndRefreshNode();
    updateSidePanel();
    requestDraw();
  }

  function showCanvasConfirm(title, text, confirmLabel = "Clear") {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "pano-canvas-confirm";
      layer.innerHTML = `
        <div class="pano-canvas-confirm-card" role="dialog" aria-modal="true" aria-label="${title}">
          <div class="pano-canvas-confirm-title">${title}</div>
          <div class="pano-canvas-confirm-text">${text}</div>
          <div class="pano-canvas-confirm-actions">
            <button class="pano-btn" data-action="cancel">Cancel</button>
            <button class="pano-btn pano-btn-primary" data-action="confirm">${confirmLabel}</button>
          </div>
        </div>
      `;
      const close = (ok) => {
        layer.remove();
        resolve(!!ok);
      };
      layer.addEventListener("pointerdown", (ev) => {
        if (ev.target === layer) close(false);
      });
      const cancelBtn = layer.querySelector("[data-action='cancel']");
      const confirmBtn = layer.querySelector("[data-action='confirm']");
      cancelBtn.onclick = () => close(false);
      confirmBtn.onclick = () => close(true);
      stageWrap.appendChild(layer);
      confirmBtn.focus();
    });
  }

  async function clearAll() {
    if (readOnly) return;
    const ok = await showCanvasConfirm(
      "Clear All Paint Data",
      type === "stickers"
        ? "This will remove all paint, mask, and sticker images in the current node."
        : "This will remove all paint, mask, and cutout frames in the current node.",
      "Clear All",
    );
    if (!ok) return;
    state.painting = normalizePaintingState(null);
    editor.paintStrokeRevision += 1;
    if (type === "stickers") {
      state.stickers = [];
      state.assets = {};
      editor.selectedId = null;
      state.active.selected_sticker_id = null;
      pruneUnusedAssets();
    } else {
      state.shots = [];
      editor.selectedId = null;
      state.active.selected_shot_id = null;
      if (editor.mode === "frame") editor.mode = "pano";
      editor.cutoutAspectOpen = false;
    }
    pushHistory();
    commitAndRefreshNode();
    updateSidePanel();
    updateSelectionMenu();
    requestDraw();
  }

  async function clearPaintingLayer(layerKind) {
    if (readOnly) return;
    const kind = layerKind === "mask" ? "mask" : "paint";
    const label = kind === "mask" ? "Mask" : "Paint";
    const strokes = getPaintingLayerList(kind);
    if (!strokes.length && !(editor.interaction?.kind === "draw" && editor.interaction?.layerKind === kind)) return;
    const ok = await showCanvasConfirm(
      `Clear ${label}`,
      `This will remove all ${kind} strokes in the current node.`,
      `Clear ${label}`,
    );
    if (!ok) return;
    if (editor.interaction?.kind === "draw" && editor.interaction?.layerKind === kind) {
      const targetDescriptor = getActivePaintTargetDescriptor(editor.interaction);
      if (targetDescriptor) editor.paintEngine.cancelActiveStroke(targetDescriptor);
      editor.interaction = null;
    }
    strokes.length = 0;
    editor.paintStrokeRevision += 1;
    pushHistory();
    commitAndRefreshNode();
    updateSidePanel();
    updateSelectionMenu();
    syncPaintUi();
    requestDraw();
  }

  function duplicateSelected() {
    if (readOnly) return;
    if (type !== "stickers") return;
    const selected = getSelected();
    if (!selected) return;
    if (isExternalSticker(selected)) return;
    const copy = JSON.parse(JSON.stringify(selected));
    copy.id = uid(type === "stickers" ? "st" : "sh");
    copy.yaw_deg = wrapYaw((copy.yaw_deg || 0) + 8);
    if (type === "stickers") {
      copy.z_index = getNextStickerZIndex();
      state.stickers.push(copy);
      state.active.selected_sticker_id = copy.id;
    } else {
      state.shots = [copy];
      state.active.selected_shot_id = copy.id;
    }
    editor.selectedId = copy.id;
    pushHistory();
    updateSidePanel();
    requestDraw();
  }

  function deleteSelected() {
    if (readOnly) return;
    const selected = getSelected();
    if (!selected) return;
    if (type === "stickers") {
      if (isExternalSticker(selected)) {
        selected.visible = isStickerHidden(selected);
        pushHistory();
        commitAndRefreshNode();
        updateSidePanel();
        updateSelectionMenu();
        requestDraw();
        return;
      }
      state.stickers = state.stickers.filter((s) => s.id !== selected.id);
      pruneUnusedAssets();
      editor.selectedId = state.stickers[0]?.id || null;
      state.active.selected_sticker_id = editor.selectedId;
      pushHistory();
      commitAndRefreshNode();
      updateSidePanel();
      requestDraw();
      return;
    }
    clearCutoutFrame();
  }

  function applyCutoutAspect(selected, aspect) {
    if (!selected) return;
    const pairs = {
      "1:1": [1, 1],
      "3:2": [3, 2],
      "4:3": [4, 3],
      "16:9": [16, 9],
    };
    const currentLandscape = (() => {
      const hf = Number(selected.hFOV_deg || 64);
      const vf = Number(selected.vFOV_deg || 40);
      if (Math.abs(hf - vf) > 1e-6) return hf >= vf;
      return Number(selected.out_w || 1024) >= Number(selected.out_h || 1024);
    })();
    let [aw, ah] = pairs[String(aspect)] || pairs["1:1"];
    if ((aw >= ah) !== currentLandscape) [aw, ah] = [ah, aw];
    const ratio = aw / ah;
    const hf = clamp(Number(selected.hFOV_deg || 64), 1, 179);
    const vf = clamp(Number(selected.vFOV_deg || 40), 1, 179);
    const span = Math.sqrt(Math.max(1, hf * vf));
    const targetHF = clamp(span * Math.sqrt(ratio), 1, 179);
    const targetVF = clamp(span / Math.sqrt(ratio), 1, 179);
    selected.hFOV_deg = targetHF;
    selected.vFOV_deg = targetVF;
    const base = Math.max(512, Number(selected.out_w || 1024), Number(selected.out_h || 1024));
    const scale = base / Math.max(aw, ah);
    const ow = Math.max(256, Math.round((aw * scale) / 8) * 8);
    const oh = Math.max(256, Math.round((ah * scale) / 8) * 8);
    selected.out_w = ow;
    selected.out_h = oh;
    selected.aspect_id = String(aspect);
  }

  function applyCutoutAspectCustom(selected, w, h) {
    if (!selected) return false;
    const rw = Math.max(1, Number(w));
    const rh = Math.max(1, Number(h));
    if (!Number.isFinite(rw) || !Number.isFinite(rh)) return false;
    const currentLandscape = (() => {
      const hf = Number(selected.hFOV_deg || 64);
      const vf = Number(selected.vFOV_deg || 40);
      if (Math.abs(hf - vf) > 1e-6) return hf >= vf;
      return Number(selected.out_w || 1024) >= Number(selected.out_h || 1024);
    })();
    let aw = rw;
    let ah = rh;
    if ((aw >= ah) !== currentLandscape) [aw, ah] = [ah, aw];
    const ratio = aw / ah;
    const hf = clamp(Number(selected.hFOV_deg || 64), 1, 179);
    const vf = clamp(Number(selected.vFOV_deg || 40), 1, 179);
    const span = Math.sqrt(Math.max(1, hf * vf));
    selected.hFOV_deg = clamp(span * Math.sqrt(ratio), 1, 179);
    selected.vFOV_deg = clamp(span / Math.sqrt(ratio), 1, 179);
    const base = Math.max(512, Number(selected.out_w || 1024), Number(selected.out_h || 1024));
    const scale = base / Math.max(aw, ah);
    selected.out_w = Math.max(256, Math.round((aw * scale) / 8) * 8);
    selected.out_h = Math.max(256, Math.round((ah * scale) / 8) * 8);
    selected.aspect_id = `${Math.round(rw)}:${Math.round(rh)}`;
    return true;
  }

  function rotateCutoutAspect90(selected) {
    if (!selected) return;
    const ow = Math.max(8, Number(selected.out_w || 1024));
    const oh = Math.max(8, Number(selected.out_h || 1024));
    selected.out_w = oh;
    selected.out_h = ow;
    const hf = Math.max(1, Number(selected.hFOV_deg || 90));
    const vf = Math.max(1, Number(selected.vFOV_deg || 60));
    selected.hFOV_deg = vf;
    selected.vFOV_deg = hf;
  }

  function normalizeStickerZIndices() {
    state.stickers
      .sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0))
      .forEach((st, i) => { st.z_index = i; });
  }

  function bringSelectedToFront() {
    if (readOnly) return;
    if (type !== "stickers") return;
    const selected = getSelected();
    if (!selected) return;
    normalizeStickerZIndices();
    const sorted = [...state.stickers].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
    const idx = sorted.findIndex((s) => s.id === selected.id);
    if (idx < 0 || idx === sorted.length - 1) return;
    const [item] = sorted.splice(idx, 1);
    sorted.push(item);
    sorted.forEach((s, i) => { s.z_index = i; });
    editor._sortedItemsCache = null;
    pushHistory();
    updateSelectionMenu();
    requestDraw();
  }

  function sendSelectedToBack() {
    if (readOnly) return;
    if (type !== "stickers") return;
    const selected = getSelected();
    if (!selected) return;
    normalizeStickerZIndices();
    const sorted = [...state.stickers].sort((a, b) => Number(a.z_index || 0) - Number(b.z_index || 0));
    const idx = sorted.findIndex((s) => s.id === selected.id);
    if (idx <= 0) return;
    const [item] = sorted.splice(idx, 1);
    sorted.unshift(item);
    sorted.forEach((s, i) => { s.z_index = i; });
    editor._sortedItemsCache = null;
    pushHistory();
    updateSelectionMenu();
    requestDraw();
  }

  function apply() {
    if (readOnly) return;
    state.projection_model = "pinhole_rectilinear";
    state.alpha_mode = "straight";
    if (presetWidget) state.output_preset = parseOutputPresetValue(presetWidget.value, Number(state.output_preset || 2048));
    if (bgWidget) state.bg_color = String(bgWidget.value || state.bg_color || "#00ff00");
    commitState();
    node.setDirtyCanvas(true, true);
  }

  function commitState() {
    if (readOnly) return;
    const text = JSON.stringify(state);
    if (stateWidget) {
      stateWidget.value = text;
      stateWidget.callback?.(text);
    }
  }
  function persistUiSettings() {
    state.ui_settings = saveSharedUiSettings(state.ui_settings);
    if (!readOnly) {
      commitState();
    }
  }
  function commitAndRefreshNode() {
    if (readOnly) return;
    commitState();
    node.setDirtyCanvas?.(true, true);
  }

  function forceCursorTool() {
    if (editor.primaryTool === "cursor") return;
    editor.primaryTool = "cursor";
    syncPaintUi();
    updateSidePanel();
  }

  function screenPos(evt) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((evt.clientX - r.left) / r.width) * canvas.width,
      y: ((evt.clientY - r.top) / r.height) * canvas.height,
    };
  }

  function supportsErpPainting() {
    return editor.mode === "pano" || editor.mode === "unwrap";
  }

  function getActiveCutoutShot() {
    if (type !== "cutout") return null;
    return getSelected() || state.shots?.[0] || null;
  }

  function getFrameViewRect(shot = getActiveCutoutShot()) {
    if (!shot) return null;
    const aspect = Math.max(1e-4, Number(buildCutoutViewParamsFromShot(shot)?.aspect || 1));
    const pad = 56;
    const availW = Math.max(80, canvas.width - pad * 2);
    const availH = Math.max(80, canvas.height - pad * 2);
    let baseW = availW;
    let baseH = baseW / aspect;
    if (baseH > availH) {
      baseH = availH;
      baseW = baseH * aspect;
    }
    const zoom = Math.max(0.1, Number(editor.frameView?.zoom || 1));
    const w = baseW * zoom;
    const h = baseH * zoom;
    const panX = Number(editor.frameView?.panX || 0);
    const panY = Number(editor.frameView?.panY || 0);
    return {
      x: ((canvas.width - w) * 0.5) + panX,
      y: ((canvas.height - h) * 0.5) + panY,
      w,
      h,
    };
  }

  function supportsFramePainting() {
    return type === "cutout" && editor.mode === "frame" && !!getActiveCutoutShot();
  }

  function screenPosToErpPoint(pos, ts = performance.now()) {
    if (editor.mode === "unwrap") {
      const r = getUnwrapRect();
      const u = (pos.x - r.x) / Math.max(1, r.w);
      const v = (pos.y - r.y) / Math.max(1, r.h);
      return {
        targetKind: "ERP_GLOBAL",
        u: ((u % 1) + 1) % 1,
        v: clamp(v, 0, 1),
        t: Number(ts || 0),
      };
    }
    const d = screenToWorldDir(pos.x, pos.y);
    const { lon, lat } = dirToLonLat(d);
    return {
      targetKind: "ERP_GLOBAL",
      u: ((lon / (2 * Math.PI)) + 0.5 + 1) % 1,
      v: clamp(0.5 - (lat / Math.PI), 0, 1),
      t: Number(ts || 0),
    };
  }

  // Convert a frame-view screen position to ERP UV coordinates via world direction.
  // This ensures strokes drawn in frame view are world-fixed (painting on the panorama,
  // not on the camera lens). Moving the frame after painting does not affect stroke position.
  function screenPosToFrameAsErpPoint(pos, shot, ts = performance.now()) {
    const rect = getFrameViewRect(shot);
    if (!rect) return null;
    const framePoint = {
      x: (Number(pos.x) - rect.x) / Math.max(1, rect.w),
      y: (Number(pos.y) - rect.y) / Math.max(1, rect.h),
    };
    const dir = frameLocalPointToWorldDir(shot, framePoint);
    if (!dir) return null;
    const { lon, lat } = dirToLonLat(dir);
    return {
      targetKind: "ERP_GLOBAL",
      u: ((lon / (2 * Math.PI)) + 0.5 + 1) % 1,
      v: clamp(0.5 - (lat / Math.PI), 0, 1),
      t: Number(ts || 0),
    };
  }

  function zoomFrameViewAt(anchor, factor) {
    const shot = getActiveCutoutShot();
    const before = getFrameViewRect(shot);
    if (!shot || !before) return false;
    const prevZoom = Math.max(0.1, Number(editor.frameView?.zoom || 1));
    const nextZoom = clamp(prevZoom * Number(factor || 1), 0.25, 12);
    if (Math.abs(nextZoom - prevZoom) < 1e-6) return false;
    const nx = (Number(anchor.x) - before.x) / Math.max(1e-6, before.w);
    const ny = (Number(anchor.y) - before.y) / Math.max(1e-6, before.h);
    editor.frameView.zoom = nextZoom;
    const after = getFrameViewRect(shot);
    if (!after) return false;
    editor.frameView.panX += Number(anchor.x) - (after.x + (after.w * nx));
    editor.frameView.panY += Number(anchor.y) - (after.y + (after.h * ny));
    return true;
  }

  function captureStrokeRadiusSpec(targetSpace, sizePx) {
    const r = Number(sizePx || 0) * 0.5;
    // ERP: normalize against 2048 (full equirectangular canvas reference width).
    return {
      radiusModel: "erp_uv_norm",
      radiusValue: Math.max(1e-6, r / 2048),
    };
  }

  function getBrushPresetIdForTool(toolKind) {
    const kind = String(toolKind || "").trim();
    if (kind === "eraser") return DEFAULT_BRUSH_PRESET_ID;
    if (BRUSH_PRESETS[kind]) return kind;
    return editor.activeBrushPresetId || DEFAULT_BRUSH_PRESET_ID;
  }

  function isPaintCursorEnabled() {
    return (editor.primaryTool === "paint" || editor.primaryTool === "mask") && (supportsErpPainting() || supportsFramePainting());
  }

  function isActivePaintCursorVisible() {
    return isPaintCursorEnabled() && editor.pointerPos?.inside === true;
  }

  function setPointerPos(p, inside = true) {
    const nextX = Number(p?.x || 0);
    const nextY = Number(p?.y || 0);
    const nextInside = inside !== false;
    const prev = editor.pointerPos || { x: 0, y: 0, inside: false };
    const changed = prev.inside !== nextInside || Math.abs(prev.x - nextX) > 0.01 || Math.abs(prev.y - nextY) > 0.01;
    editor.pointerPos = { x: nextX, y: nextY, inside: nextInside };
    return changed;
  }

  function getActivePaintCursorDescriptor() {
    if (!isActivePaintCursorVisible()) return null;
    const layerKind = editor.primaryTool === "mask" ? "mask" : "paint";
    const toolKind = layerKind === "mask" ? editor.maskTool : editor.paintTool;
    const presetId = getBrushPresetIdForTool(toolKind);
    const preset = BRUSH_PRESETS[presetId] || BRUSH_PRESETS[DEFAULT_BRUSH_PRESET_ID];
    const rawSize = Number(editor.brushSizes[presetId] ?? 10);
    const size = Math.max(1, rawSize) * Math.max(0.1, Number(preset.sizeScale ?? 1));
    const radius = Math.max(3, size * 0.5);
    const baseColor = layerKind === "mask"
      ? { r: 34 / 255, g: 197 / 255, b: 94 / 255, a: 0.8 }
      : (toolKind === "eraser" ? { r: 1, g: 1, b: 1, a: 0.2 } : cloneColor(editor.paintColor));
    const fillAlpha = layerKind === "mask"
      ? 0.2
      : (toolKind === "eraser" ? 0.06 : clamp(Math.max(0.16, Number(baseColor.a ?? 1) * 0.3), 0.16, 0.52));
    const strokeAlpha = layerKind === "mask"
      ? 0.95
      : (toolKind === "eraser" ? 0.75 : clamp(Math.max(0.46, Number(baseColor.a ?? 1) * 0.92), 0.46, 1));
    return {
      layerKind,
      toolKind,
      preset,
      radius,
      fillStyle: colorToCss(baseColor, fillAlpha),
      strokeStyle: colorToCss(baseColor, strokeAlpha),
      x: Number(editor.pointerPos?.x || 0),
      y: Number(editor.pointerPos?.y || 0),
    };
  }

  function syncPaintCursorElement() {
    const cursor = getActivePaintCursorDescriptor();
    if (!paintCursorEl) return;
    if (!cursor) {
      paintCursorEl.style.display = "none";
      return;
    }

    let width = cursor.radius * 2;
    let height = cursor.radius * 2;
    let borderRadius = "999px";
    let rotateDeg = 0;
    let background = cursor.fillStyle;

    if (cursor.toolKind === "marker") {
      const aspect = Math.max(1, Number(cursor.preset?.aspect ?? 1));
      width = Math.max(10, cursor.radius * 2 * aspect);
      height = Math.max(6, cursor.radius * 2);
      borderRadius = `${Math.min(6, height * 0.42)}px`;
      rotateDeg = Number(cursor.preset?.angle?.value || 0) * RAD2DEG;
    } else if (cursor.toolKind === "brush") {
      background = `radial-gradient(circle at 50% 50%, ${cursor.strokeStyle} 0%, ${cursor.fillStyle} 45%, rgba(0,0,0,0) 100%)`;
    } else if (cursor.toolKind === "lasso_fill") {
      width = Math.max(12, cursor.radius * 1.5);
      height = width;
      background = `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 45%, ${cursor.strokeStyle} 46%, ${cursor.strokeStyle} 60%, rgba(0,0,0,0) 61%)`;
    } else if (cursor.toolKind === "eraser") {
      background = "rgba(255,255,255,0.14)";
    }

    paintCursorEl.style.display = "block";
    paintCursorEl.style.width = `${Math.round(width)}px`;
    paintCursorEl.style.height = `${Math.round(height)}px`;
    paintCursorEl.style.borderRadius = borderRadius;
    paintCursorEl.style.background = background;
    paintCursorEl.style.transform = `translate(${Math.round(cursor.x - width * 0.5)}px, ${Math.round(cursor.y - height * 0.5)}px) rotate(${rotateDeg}deg)`;
  }

  function showPaintSizePreview() {
    if (!paintSizePreviewEl || !paintSizePreviewSampleEl) return;
    const layerKind = editor.primaryTool === "mask" ? "mask" : "paint";
    const toolKind = layerKind === "mask" ? editor.maskTool : editor.paintTool;
    const presetId = getBrushPresetIdForTool(toolKind);
    const preset = BRUSH_PRESETS[presetId] || BRUSH_PRESETS[DEFAULT_BRUSH_PRESET_ID];
    const rawSize = Number(editor.brushSizes[presetId] ?? 10);
    const size = Math.max(1, rawSize) * Math.max(0.1, Number(preset.sizeScale ?? 1));
    const radius = Math.max(6, size * 0.5);
    const isEraser = toolKind === "eraser";
    const baseColor = layerKind === "mask"
      ? { r: 34 / 255, g: 197 / 255, b: 94 / 255, a: 0.82 }
      : (isEraser ? { r: 1, g: 1, b: 1, a: 0.22 } : cloneColor(editor.paintColor));
    const fill = layerKind === "mask"
      ? colorToCss(baseColor, 0.22)
      : (isEraser ? "rgba(255,255,255,0.14)" : colorToCss(baseColor, clamp(Math.max(0.18, Number(baseColor.a ?? 1) * 0.34), 0.18, 0.56)));
    const stroke = layerKind === "mask"
      ? colorToCss(baseColor, 0.96)
      : (isEraser ? "rgba(255,255,255,0.72)" : colorToCss(baseColor, clamp(Math.max(0.56, Number(baseColor.a ?? 1) * 0.96), 0.56, 1)));

    let width = radius * 2;
    let height = radius * 2;
    let borderRadius = "999px";
    let rotateDeg = 0;
    let background = fill;

    if (toolKind === "marker") {
      const aspect = Math.max(1, Number(preset?.aspect ?? 1));
      width = Math.max(16, radius * 2 * aspect);
      height = Math.max(10, radius * 2);
      borderRadius = `${Math.min(8, height * 0.42)}px`;
      rotateDeg = Number(preset?.angle?.value || 0) * RAD2DEG;
    } else if (toolKind === "brush") {
      background = `radial-gradient(circle at 50% 50%, ${stroke} 0%, ${fill} 48%, rgba(0,0,0,0) 100%)`;
    } else if (toolKind === "lasso_fill") {
      width = Math.max(18, radius * 1.8);
      height = width;
      background = `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 42%, ${stroke} 43%, ${stroke} 58%, rgba(0,0,0,0) 59%)`;
    } else if (isEraser) {
      background = "rgba(255,255,255,0.12)";
    }

    paintSizePreviewSampleEl.style.width = `${Math.round(width)}px`;
    paintSizePreviewSampleEl.style.height = `${Math.round(height)}px`;
    paintSizePreviewSampleEl.style.borderRadius = borderRadius;
    paintSizePreviewSampleEl.style.background = background;
    paintSizePreviewSampleEl.style.border = `2px solid ${stroke}`;
    paintSizePreviewSampleEl.style.transform = `rotate(${rotateDeg}deg)`;

    if (paintSizePreviewTimer) {
      clearTimeout(paintSizePreviewTimer);
      paintSizePreviewTimer = 0;
    }
    paintSizePreviewEl.classList.remove("fade-out");
    paintSizePreviewEl.classList.add("show");
  }

  function hidePaintSizePreview() {
    if (!paintSizePreviewEl || !paintSizePreviewEl.classList.contains("show")) return;
    paintSizePreviewEl.classList.add("fade-out");
    if (paintSizePreviewTimer) clearTimeout(paintSizePreviewTimer);
    paintSizePreviewTimer = window.setTimeout(() => {
      paintSizePreviewEl.classList.remove("show", "fade-out");
      paintSizePreviewTimer = 0;
    }, 180);
  }

  function buildFreehandStrokeRecord(layerKind, toolKind, points, targetSpace) {
    const presetId = getBrushPresetIdForTool(toolKind);
    const preset = BRUSH_PRESETS[presetId] || BRUSH_PRESETS[DEFAULT_BRUSH_PRESET_ID];
    const rawSize = editor.brushSizes[presetId] ?? 10;
    const size = Math.max(1, rawSize) * Math.max(0.1, preset.sizeScale ?? 1);
    const radiusSpec = captureStrokeRadiusSpec(targetSpace, size);
    const preparedPoints = points.map((pt) => ({
      ...pt,
      t: Number(pt?.t || 0),
      widthScale: Number.isFinite(Number(pt?.widthScale)) ? Math.max(0, Number(pt.widthScale)) : 1,
      pressureLike: Number.isFinite(Number(pt?.pressureLike)) ? Math.max(0, Number(pt.pressureLike)) : 1,
    }));
    const stroke = {
      id: makePaintId(layerKind),
      actionGroupId: makePaintId("ag"),
      targetSpace: targetSpace && typeof targetSpace === "object" ? { ...targetSpace } : { kind: "ERP_GLOBAL" },
      layerKind,
      toolKind,
      size,
      createdAt: Date.now(),
      color: layerKind === "paint" ? { ...editor.paintColor } : null,
      radiusModel: radiusSpec.radiusModel,
      radiusValue: radiusSpec.radiusValue,
      geometry: {
        geometryKind: "freehand_open",
        rawPoints: preparedPoints.map((pt) => ({ ...pt })),
        points: preparedPoints.map((pt) => ({ ...pt })),
      },
    };
    applyPresetToStroke(stroke, preset);
    return stroke;
  }

  function buildLassoFillStrokeRecord(layerKind, toolKind, points, targetSpace) {
    const preparedPoints = points.map((pt) => ({
      ...pt,
      t: Number(pt?.t || 0),
      widthScale: Number.isFinite(Number(pt?.widthScale)) ? Math.max(0, Number(pt.widthScale)) : 1,
      pressureLike: Number.isFinite(Number(pt?.pressureLike)) ? Math.max(0, Number(pt.pressureLike)) : 1,
    }));
    const presetId = getBrushPresetIdForTool(toolKind);
    const preset = BRUSH_PRESETS[presetId] || BRUSH_PRESETS[DEFAULT_BRUSH_PRESET_ID];
    const stroke = {
      id: makePaintId(layerKind),
      actionGroupId: makePaintId("ag"),
      targetSpace: targetSpace && typeof targetSpace === "object" ? { ...targetSpace } : { kind: "ERP_GLOBAL" },
      layerKind,
      toolKind,
      size: 10,
      createdAt: Date.now(),
      color: layerKind === "paint" ? { ...editor.paintColor } : null,
      radiusModel: null,
      radiusValue: null,
      geometry: {
        geometryKind: "lasso_fill",
        points: preparedPoints.map((pt) => ({ ...pt })),
      },
    };
    applyPresetToStroke(stroke, preset);
    return stroke;
  }

  function getPaintingLayerList(layerKind) {
    const root = state.painting || (state.painting = normalizePaintingState(null));
    const layer = root[layerKind] || (root[layerKind] = { strokes: [] });
    if (!Array.isArray(layer.strokes)) layer.strokes = [];
    return layer.strokes;
  }

  function appendPaintPoint(interaction, pos, ts = performance.now()) {
    let next;
    if (editor.mode === "frame") {
      // Frame view: convert screen position to ERP UV via frame's world projection.
      // This keeps strokes world-fixed regardless of subsequent frame camera moves.
      const shot = getActiveCutoutShot();
      if (!shot) return false;
      next = screenPosToFrameAsErpPoint(pos, shot, ts);
    } else {
      next = screenPosToErpPoint(pos, ts);
    }
    const rawPoints = interaction.stroke.geometry.rawPoints || interaction.stroke.geometry.points;
    const points = interaction.stroke.geometry.points;
    // Dedup against raw coords so OEF smoothing doesn't cause points to be incorrectly skipped
    const prevRaw = rawPoints[rawPoints.length - 1];
    if (prevRaw) {
      const du = Math.abs(Number(next.u ?? next.x ?? 0) - Number(prevRaw.u ?? prevRaw.x ?? 0));
      const dv = Math.abs(Number(next.v ?? next.y ?? 0) - Number(prevRaw.v ?? prevRaw.y ?? 0));
      if (du < 0.0015 && dv < 0.0015) return false;
    }
    const sample = {
      ...next,
      t: Number(next?.t || 0),
      widthScale: 1,
      pressureLike: 1,
    };
    rawPoints.push({ ...sample });
    points.push({ ...sample });
    // Incremental rendering: send raw point to engine (O(1), no full re-render)
    const targetDescriptor = getActivePaintTargetDescriptor(interaction);
    if (targetDescriptor) {
      const engineTarget = editor.paintEngine.ensureTarget(targetDescriptor);
      editor.paintEngine.appendStrokePoint(engineTarget, Number(sample.u ?? 0), Number(sample.v ?? 0), interaction.stroke);
    }
    return true;
  }

  function appendLassoPoint(interaction, pos, ts = performance.now()) {
    let next;
    if (editor.mode === "frame") {
      const shot = getActiveCutoutShot();
      if (!shot) return false;
      next = screenPosToFrameAsErpPoint(pos, shot, ts);
    } else {
      next = screenPosToErpPoint(pos, ts);
    }
    const points = interaction?.stroke?.geometry?.points;
    if (!next || !Array.isArray(points)) return false;
    const prev = points[points.length - 1];
    if (prev) {
      const du = Math.abs(Number(next.u ?? next.x ?? 0) - Number(prev.u ?? prev.x ?? 0));
      const dv = Math.abs(Number(next.v ?? next.y ?? 0) - Number(prev.v ?? prev.y ?? 0));
      if (du < 0.0015 && dv < 0.0015) return false;
    }
    points.push({
      ...next,
      t: Number(next?.t || 0),
      widthScale: 1,
      pressureLike: 1,
    });
    return true;
  }

  function commitPaintInteraction(interaction) {
    const geometry = interaction?.stroke?.geometry || null;
    if (!geometry) return false;
    if (geometry.geometryKind === "lasso_fill") {
      const points = Array.isArray(geometry.points) ? geometry.points : [];
      if (points.length < 3) return false;
      getPaintingLayerList(interaction.layerKind).push(interaction.stroke);
      return true;
    }
    const rawPoints = geometry.rawPoints || geometry.points || [];
    if (rawPoints.length < 1) return false;
    // ADR 0006: processedPoints is durable; rasterizer (Python) uses it directly.
    geometry.processedPoints = processFreehandPoints(rawPoints, interaction.stroke.targetSpace, true);
    getPaintingLayerList(interaction.layerKind).push(interaction.stroke);
    return true;
  }

  function hitObjectAt(p) {
    const items = [...getList()].sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0));
    for (const item of items) {
      const g = objectGeom(item);
      if (!g.visible) continue;
      if (pointInPoly(p, g.corners)) return { item, geom: g };
    }
    return null;
  }

  function handleHit(geom, p) {
    if (!geom || !geom.visible) return { kind: "none", cursor: editor.mode === "pano" ? "grab" : "default" };
    if (type === "cutout" && Array.isArray(geom.edgeMidpoints)) {
      const mid = geom.edgeMidpoints.find((m) => dist2(m, p) <= 13 * 13);
      if (mid) {
        const horiz = (mid.edge === "left" || mid.edge === "right");
        return { kind: horiz ? "scale_x" : "scale_y", cursor: horiz ? "ew-resize" : "ns-resize", edge: mid.edge, mid };
      }
    }
    const cornerIdx = geom.corners.findIndex((c) => dist2(c, p) <= 11 * 11);
    if (cornerIdx >= 0) {
      const c = geom.corners[cornerIdx];
      const vx = c.x - geom.center.x;
      const vy = c.y - geom.center.y;
      const cursor = (vx * vy) >= 0 ? "nwse-resize" : "nesw-resize";
      return { kind: "scale", cornerIdx, cursor };
    }
    if (dist2(geom.rotateHandle, p) <= 12 * 12) return { kind: "rotate", cursor: "grab" };
    if (pointInPoly(p, geom.corners)) return { kind: "move", cursor: "move" };
    return { kind: "none", cursor: editor.mode === "pano" ? "grab" : "default" };
  }

  function updateCursor(p) {
    syncPaintCursorElement();
    if (editor.interaction) {
      if (editor.interaction.kind === "paint_stroke" || editor.interaction.kind === "paint_lasso_fill") canvas.style.cursor = "none";
      else if (editor.interaction.kind === "view") canvas.style.cursor = "grabbing";
      else if (editor.interaction.kind === "pan_frame") canvas.style.cursor = "grabbing";
      else if (editor.interaction.kind === "move") canvas.style.cursor = "move";
      else if (editor.interaction.kind === "scale" || editor.interaction.kind === "scale_x" || editor.interaction.kind === "scale_y") canvas.style.cursor = editor.interaction.cursor || "nwse-resize";
      else if (editor.interaction.kind === "rotate") canvas.style.cursor = "grabbing";
      else canvas.style.cursor = "default";
      return;
    }
    if (isActivePaintCursorVisible()) {
      canvas.style.cursor = "none";
      return;
    }
    if (editor.mode === "frame") {
      canvas.style.cursor = editor.primaryTool === "cursor" ? "grab" : "default";
      return;
    }
    const selected = getSelected();
    const geom = selected ? objectGeom(selected) : null;
    const h = handleHit(geom, p);
    canvas.style.cursor = h.cursor;
  }

  function updateSelectionMenu() {
    if (!selectionMenu) return;
    if (editor.mode === "frame") {
      selectionMenu.style.display = "none";
      return;
    }
    const selected = getSelected();
    if (!selected || editor.interaction) {
      selectionMenu.style.display = "none";
      return;
    }
    const menuMode = type === "stickers"
      ? `stickers:${isExternalSticker(selected) ? "external" : "normal"}`
      : `cutout:${editor.cutoutAspectOpen ? "open" : "closed"}`;
    if (editor.menuMode !== menuMode) {
      if (type === "stickers") {
        selectionMenu.innerHTML = `
          <button class="pano-btn pano-btn-icon" data-action="bring-front" aria-label="Bring to Front" data-tip="Bring to front">${ICON.bring_front}</button>
          <button class="pano-btn pano-btn-icon" data-action="send-back" aria-label="Send to Back" data-tip="Send to back">${ICON.send_back}</button>
          ${isExternalSticker(selected) ? "" : `<button class="pano-btn pano-btn-icon" data-action="duplicate" aria-label="Duplicate" data-tip="Duplicate">${ICON.duplicate}</button>`}
          ${isExternalSticker(selected) ? `<button class="pano-btn pano-btn-icon" data-action="back-initial" aria-label="Back to Initial" data-tip="Back to initial position">${ICON.back_initial}</button>` : ""}
          ${isExternalSticker(selected)
            ? `<button class="pano-btn pano-btn-icon" data-action="toggle-visible" aria-label="Hide" data-tip="Hide input image">${ICON.eye_dashed}</button>`
            : `<button class="pano-btn pano-btn-icon" data-action="delete" aria-label="Delete" data-tip="Delete">${ICON.delete}</button>`}
        `;
      } else {
        const activeAspect = getCutoutAspectLabel(selected);
        selectionMenu.innerHTML = `
          <div class="pano-cutout-menu">
            <button class="pano-btn pano-btn-icon" data-action="aspect" aria-label="Aspect Ratio" data-tip="Aspect ratio">${ICON.aspect}</button>
            <div class="pano-aspect-popover${editor.cutoutAspectOpen ? " open" : ""}" role="dialog" aria-label="Aspect Ratio">
              <button class="pano-btn pano-aspect-choice${activeAspect === "1:1" ? " active" : ""}" data-action="aspect-set" data-aspect="1:1">1:1</button>
              <button class="pano-btn pano-aspect-choice${activeAspect === "4:3" ? " active" : ""}" data-action="aspect-set" data-aspect="4:3">4:3</button>
              <button class="pano-btn pano-aspect-choice${activeAspect === "3:2" ? " active" : ""}" data-action="aspect-set" data-aspect="3:2">3:2</button>
              <button class="pano-btn pano-aspect-choice${activeAspect === "16:9" ? " active" : ""}" data-action="aspect-set" data-aspect="16:9">16:9</button>
            </div>
          </div>
          <button class="pano-btn pano-btn-icon" data-action="rotate-90" aria-label="Rotate 90°" data-tip="Rotate 90°">${ICON.rotate_90}</button>
          <button class="pano-btn pano-btn-icon" data-action="delete" aria-label="Delete" data-tip="Delete">${ICON.delete}</button>
        `;
      }
      editor.menuMode = menuMode;
      editor.menuSize.measured = false;
      installTooltipHandlers(selectionMenu);
    }
    if (type === "stickers" && isExternalSticker(selected)) {
      const backBtn = selectionMenu.querySelector("[data-action='back-initial']");
      if (backBtn) {
        const enabled = canRestoreSelectedToInitial();
        backBtn.disabled = !enabled;
        backBtn.setAttribute("aria-disabled", enabled ? "false" : "true");
        backBtn.setAttribute("data-tip", enabled ? "Back to initial position" : "Already at initial position");
      }
      const toggleBtn = selectionMenu.querySelector("[data-action='toggle-visible']");
      if (toggleBtn) {
        const hidden = isStickerHidden(selected);
        toggleBtn.innerHTML = hidden ? ICON.eye : ICON.eye_dashed;
        toggleBtn.setAttribute("aria-label", hidden ? "Show" : "Hide");
        toggleBtn.setAttribute("data-tip", hidden ? "Show input image" : "Hide input image");
      }
    }
    const geom = objectGeom(selected);
    if (!geom?.visible) {
      selectionMenu.style.display = "none";
      return;
    }
    const poly = geom.corners;
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const prevDisplay = selectionMenu.style.display;
    const prevVisibility = selectionMenu.style.visibility;
    selectionMenu.style.display = "flex";
    selectionMenu.style.visibility = "hidden";
    const rect = selectionMenu.getBoundingClientRect();
    const measuredW = Math.round(Number(rect?.width || 0)) || selectionMenu.offsetWidth || editor.menuSize.w || 220;
    const measuredH = Math.round(Number(rect?.height || 0)) || selectionMenu.offsetHeight || editor.menuSize.h || 40;
    editor.menuSize.w = Number.isFinite(measuredW) && measuredW > 0 ? measuredW : 220;
    editor.menuSize.h = Number.isFinite(measuredH) && measuredH > 0 ? measuredH : 40;
    selectionMenu.style.display = prevDisplay;
    selectionMenu.style.visibility = prevVisibility;
    editor.menuSize.measured = true;
    const menuW = editor.menuSize.w;
    const menuH = editor.menuSize.h;
    const pad = 14;
    selectionMenu.style.display = "flex";
    let x = (minX + maxX) * 0.5 - menuW * 0.5;
    let y = maxY + 22;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      selectionMenu.style.display = "none";
      return;
    }
    x = clamp(x, pad, canvas.width - menuW - pad);
    if (y + menuH > canvas.height - pad) {
      selectionMenu.style.display = "none";
      return;
    }
    selectionMenu.style.left = `${x}px`;
    selectionMenu.style.top = `${y}px`;
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    if (tooltip.timer) {
      clearTimeout(tooltip.timer);
      tooltip.timer = 0;
    }
    tooltip.target = null;
    tooltipEl.classList.remove("show", "pano-tooltip-footer", "pano-tooltip-tool-rail");
  }

  function showTooltipFor(el) {
    if (!tooltipEl || !el || !el.isConnected) return;
    const text = String(el.getAttribute("data-tip") || "").trim();
    if (!text) return;
    tooltipEl.textContent = text;
    const hostRect = stageWrap.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const mw = tooltipEl.offsetWidth || 100;
    const mh = tooltipEl.offsetHeight || 24;
    const inToolRail = !!el.closest(".pano-floating-left");
    const inFooter = !!el.closest(".pano-paint-footer") || !!el.closest(".pano-paint-color-float");
    tooltipEl.classList.remove("pano-tooltip-footer", "pano-tooltip-tool-rail");
    let x = rect.left - hostRect.left + rect.width * 0.5 - mw * 0.5;
    let y = rect.top - hostRect.top - mh - 8;
    if (inToolRail) {
      tooltipEl.classList.add("pano-tooltip-tool-rail");
      x = rect.right - hostRect.left + 10;
      y = rect.top - hostRect.top + rect.height * 0.5 - mh * 0.5;
      x = clamp(x, pad, Math.max(pad, hostRect.width - mw - pad));
      y = clamp(y, pad, Math.max(pad, hostRect.height - mh - pad));
    } else if (inFooter) {
      tooltipEl.classList.add("pano-tooltip-footer");
      const footerHost = el.closest(".pano-paint-footer");
      const footerRect = footerHost ? footerHost.getBoundingClientRect() : rect;
      x = footerRect.left - hostRect.left + footerRect.width * 0.5 - mw * 0.5;
      y = footerRect.bottom - hostRect.top + 5;
      x = clamp(x, pad, Math.max(pad, hostRect.width - mw - pad));
      y = Math.max(pad, y);
    }
    x = clamp(x, pad, Math.max(pad, hostRect.width - mw - pad));
    y = Math.max(pad, y);
    tooltipEl.style.left = `${x}px`;
    tooltipEl.style.top = `${y}px`;
    tooltipEl.classList.add("show");
  }

  function installTooltipHandlers(scope) {
    scope.querySelectorAll("[data-tip]").forEach((el) => {
      if (el.__panoTipBound) return;
      el.__panoTipBound = true;
      el.addEventListener("pointerenter", () => {
        tooltip.target = el;
        if (tooltip.timer) clearTimeout(tooltip.timer);
        tooltip.timer = window.setTimeout(() => {
          if (tooltip.target === el) showTooltipFor(el);
        }, 220);
      });
      el.addEventListener("pointerleave", () => {
        if (tooltip.target === el) tooltip.target = null;
        hideTooltip();
      });
      el.addEventListener("pointerdown", hideTooltip);
    });
  }

  const viewController = createPanoInteractionController({
    getView: () => ({ yaw: editor.viewYaw, pitch: editor.viewPitch, fov: editor.viewFov }),
    setView: (next) => {
      editor.viewYaw = wrapYaw(Number(next.yaw || 0));
      editor.viewPitch = clamp(Number(next.pitch || 0), -89.9, 89.9);
      editor.viewFov = clamp(Number(next.fov || editor.viewFov || 100), 35, 140);
    },
    getInvert: () => ({
      x: state.ui_settings?.invert_view_x ? -1 : 1,
      y: state.ui_settings?.invert_view_y ? -1 : 1,
    }),
    getUnwrapRect,
    onInteraction: () => {
      runtime.dirty = true;
    },
  });

  canvas.onpointerdown = (e) => {
    const p = screenPos(e);
    setPointerPos(p, true);
    editor.viewTween = null;
    viewController.state.inertia.active = false;
    viewController.state.inertia.vx = 0;
    viewController.state.inertia.vy = 0;
    if (e.button === 1) {
      e.preventDefault();
      if (editor.mode === "frame") {
        editor.interaction = { kind: "pan_frame", last: p };
      } else {
        editor.interaction = { kind: "view", last: p, lastTs: performance.now() };
        viewController.startDrag(p.x, p.y, e.pointerId, performance.now());
      }
      updateCursor(p);
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (readOnly) {
      if (editor.mode === "pano") {
        editor.interaction = { kind: "view", last: p, lastTs: performance.now() };
        viewController.startDrag(p.x, p.y, e.pointerId, performance.now());
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
      } else if (editor.mode === "frame") {
        editor.interaction = { kind: "pan_frame", last: p };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
      }
      return;
    }

    if ((editor.primaryTool === "paint" || editor.primaryTool === "mask") && (supportsErpPainting() || supportsFramePainting())) {
      const layerKind = editor.primaryTool === "mask" ? "mask" : "paint";
      const toolKind = editor.primaryTool === "mask" ? editor.maskTool : editor.paintTool;
      const activeShot = supportsFramePainting() ? getActiveCutoutShot() : null;
      // Always use ERP_GLOBAL: frame-view strokes are converted to world-space ERP UV
      // via the frame's projection so they stay fixed in the panorama when the frame moves.
      const targetSpace = { kind: "ERP_GLOBAL" };
      const startPoint = activeShot
        ? screenPosToFrameAsErpPoint(p, activeShot, performance.now())
        : screenPosToErpPoint(p, performance.now());
      editor.interaction = {
        kind: toolKind === "lasso_fill" ? "paint_lasso_fill" : "paint_stroke",
        layerKind,
        stroke: toolKind === "lasso_fill"
          ? buildLassoFillStrokeRecord(layerKind, toolKind, [startPoint], targetSpace)
          : buildFreehandStrokeRecord(layerKind, toolKind, [startPoint], targetSpace),
      };
      const targetDescriptor = getActivePaintTargetDescriptor(editor.interaction);
      if (targetDescriptor) {
        editor.paintEngine.beginStroke(editor.interaction.stroke, targetDescriptor);
        if (editor.interaction.kind === "paint_stroke") {
          // Seed the incremental renderer with the first point
          const engineTarget = editor.paintEngine.ensureTarget(targetDescriptor);
          const cx = Number(startPoint?.u ?? startPoint?.x ?? 0);
          const cy = Number(startPoint?.v ?? startPoint?.y ?? 0);
          editor.paintEngine.appendStrokePoint(engineTarget, cx, cy, editor.interaction.stroke);
        } else {
          // Lasso fill: use full-redraw path
          editor.paintEngine.updateActiveStroke(editor.interaction.stroke, targetDescriptor);
        }
      }
      updateCursor(p);
      canvas.setPointerCapture(e.pointerId);
      requestDraw();
      return;
    }

    if (editor.mode === "frame") {
      if (editor.primaryTool === "cursor") {
        editor.interaction = { kind: "pan_frame", last: p };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
      }
      updateCursor(p);
      return;
    }

    const selected = getSelected();
    const selGeom = selected ? objectGeom(selected) : null;

    if (selected && selGeom?.visible) {
      const h = handleHit(selGeom, p);
      if (h.kind === "scale") {
        editor.interaction = {
          kind: "scale",
          item: selected,
          center: selGeom.center,
          startDist: Math.max(1, Math.hypot(p.x - selGeom.center.x, p.y - selGeom.center.y)),
          startHFOV: Number(selected.hFOV_deg || 20),
          startVFOV: Number(selected.vFOV_deg || 20),
          cursor: h.cursor,
        };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (h.kind === "scale_x" || h.kind === "scale_y") {
        editor.interaction = {
          kind: h.kind,
          item: selected,
          center: selGeom.center,
          startDist: Math.max(1, Math.hypot(p.x - selGeom.center.x, p.y - selGeom.center.y)),
          startHFOV: Number(selected.hFOV_deg || 20),
          startVFOV: Number(selected.vFOV_deg || 20),
          cursor: h.cursor,
          edge: h.edge,
        };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (h.kind === "rotate") {
        editor.interaction = {
          kind: "rotate",
          item: selected,
          center: selGeom.center,
          startRot: Number(selected.rot_deg || selected.roll_deg || 0),
          startAng: Math.atan2(p.y - selGeom.center.y, p.x - selGeom.center.x),
        };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (h.kind === "move") {
        editor.interaction = {
          kind: "move",
          item: selected,
          offset: { x: p.x - selGeom.center.x, y: p.y - selGeom.center.y },
        };
        updateCursor(p);
        canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    const hit = hitObjectAt(p);
    if (hit) {
      const isNewSelection = editor.selectedId !== hit.item.id;
      if (isNewSelection && editor.selectedId) {
        pushHistory();
        commitState();
      }
      editor.selectedId = hit.item.id;
      if (type === "cutout" && isNewSelection) editor.cutoutAspectOpen = false;
      if (type === "stickers") state.active.selected_sticker_id = hit.item.id;
      else state.active.selected_shot_id = hit.item.id;
      if (isNewSelection) updateSidePanel();
      updateSelectionMenu();
      requestDraw();
      if (isNewSelection) {
        updateCursor(p);
        return;
      }
      editor.interaction = {
        kind: "move",
        item: hit.item,
        offset: { x: p.x - hit.geom.center.x, y: p.y - hit.geom.center.y },
      };
      updateCursor(p);
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    const selectedBeforeClear = getSelected();
    if (selectedBeforeClear) {
      editor.panelLastValues = {
        yaw_deg: Number(selectedBeforeClear.yaw_deg || 0),
        pitch_deg: Number(selectedBeforeClear.pitch_deg || 0),
        hFOV_deg: Number(selectedBeforeClear.hFOV_deg || (type === "stickers" ? 30 : 90)),
        vFOV_deg: Number(selectedBeforeClear.vFOV_deg || (type === "stickers" ? 30 : 60)),
        rot_deg: Number(selectedBeforeClear.rot_deg || 0),
        roll_deg: Number(selectedBeforeClear.roll_deg || 0),
        out_w: Number(selectedBeforeClear.out_w || 1024),
        out_h: Number(selectedBeforeClear.out_h || 1024),
        aspect_id: getCutoutAspectLabel(selectedBeforeClear),
      };
    }
    const hadSelection = !!editor.selectedId;
    if (hadSelection) {
      pushHistory();
      commitState();
    }
    editor.selectedId = null;
    if (type === "cutout") editor.cutoutAspectOpen = false;
    if (type === "stickers") state.active.selected_sticker_id = null;
    else state.active.selected_shot_id = null;
    if (hadSelection) updateSidePanel();
    updateSelectionMenu();
    requestDraw();

    if (editor.mode === "pano") {
      editor.interaction = { kind: "view", last: p, lastTs: performance.now() };
      viewController.startDrag(p.x, p.y, e.pointerId, performance.now());
      updateCursor(p);
      canvas.setPointerCapture(e.pointerId);
    }
  };

  canvas.onpointermove = (e) => {
    const p = screenPos(e);
    setPointerPos(p, true);
    if (!editor.interaction) {
      updateCursor(p);
      return;
    }
    updateCursor(p);
    const it = editor.interaction;

    if (it.kind === "paint_stroke") {
      const samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      let changed = false;
      samples.forEach((sample) => {
        const sp = screenPos(sample);
        // appendPaintPoint now calls appendStrokePoint internally (O(1) incremental rendering)
        if (appendPaintPoint(it, sp, performance.now())) changed = true;
      });
      if (changed) requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "paint_lasso_fill") {
      const samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      let changed = false;
      samples.forEach((sample) => {
        const sp = screenPos(sample);
        if (appendLassoPoint(it, sp, performance.now())) changed = true;
      });
      if (changed) {
        const targetDescriptor = getActivePaintTargetDescriptor(it);
        if (targetDescriptor) editor.paintEngine.updateActiveStroke(it.stroke, targetDescriptor);
        requestDraw({ localOnly: true });
      }
      return;
    }

    if (it.kind === "view") {
      const now = performance.now();
      viewController.moveDrag(p.x, p.y, editor.mode === "unwrap" ? "unwrap" : "pano", now);
      it.lastTs = now;
      it.last = p;
      requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "pan_frame") {
      editor.frameView.panX += p.x - it.last.x;
      editor.frameView.panY += p.y - it.last.y;
      it.last = p;
      requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "move") {
      const tx = p.x - it.offset.x;
      const ty = p.y - it.offset.y;
      if (editor.mode === "unwrap") {
        const r = getUnwrapRect();
        const nx = clamp((tx - r.x) / Math.max(r.w, 1), 0, 1);
        const ny = clamp((ty - r.y) / Math.max(r.h, 1), 0, 1);
        it.item.yaw_deg = wrapYaw(nx * 360 - 180);
        it.item.pitch_deg = clamp(90 - ny * 180, -90, 90);
      } else {
        const dir = screenToWorldDir(tx, ty);
        const yp = dirToYawPitch(dir);
        it.item.yaw_deg = yp.yaw;
        it.item.pitch_deg = yp.pitch;
      }
      requestDraw({ localOnly: true });
      return;
    }


    if (it.kind === "scale") {
      const d = Math.max(1, Math.hypot(p.x - it.center.x, p.y - it.center.y));
      const ratio = d / it.startDist;
      it.item.hFOV_deg = clamp(it.startHFOV * ratio, 1, 179);
      it.item.vFOV_deg = clamp(it.startVFOV * ratio, 1, 179);
      requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "scale_x") {
      const d = Math.max(1, Math.hypot(p.x - it.center.x, p.y - it.center.y));
      const ratio = d / it.startDist;
      it.item.hFOV_deg = clamp(it.startHFOV * ratio, 1, 179);
      requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "scale_y") {
      const d = Math.max(1, Math.hypot(p.x - it.center.x, p.y - it.center.y));
      const ratio = d / it.startDist;
      it.item.vFOV_deg = clamp(it.startVFOV * ratio, 1, 179);
      requestDraw({ localOnly: true });
      return;
    }

    if (it.kind === "rotate") {
      const a = Math.atan2(p.y - it.center.y, p.x - it.center.x);
      let delta = (a - it.startAng) * RAD2DEG;
      let out = it.startRot - delta;
      if (e.shiftKey) out = Math.round(out / 45) * 45;
      const key = type === "stickers" ? "rot_deg" : "roll_deg";
      it.item[key] = out;
      requestDraw({ localOnly: true });
    }
  };

  canvas.onpointerup = () => {
    const ended = editor.interaction;
    if (editor.interaction?.kind === "paint_stroke" || editor.interaction?.kind === "paint_lasso_fill") {
      if (commitPaintInteraction(editor.interaction)) {
        editor.paintStrokeRevision += 1;
        const targetDescriptor = getActivePaintTargetDescriptor(editor.interaction);
        if (targetDescriptor) editor.paintEngine.commitActiveStroke(editor.interaction.stroke, targetDescriptor);
        pushHistory();
        commitState();
        node.setDirtyCanvas(true, true);
        requestDraw();
        syncPaintingLayerAsync();
      } else {
        const targetDescriptor = getActivePaintTargetDescriptor(editor.interaction);
        if (targetDescriptor) editor.paintEngine.cancelActiveStroke(targetDescriptor);
      }
    } else if (editor.interaction && editor.interaction.kind !== "view" && editor.interaction.kind !== "pan_frame") {
      pushHistory();
      commitState();
      node.setDirtyCanvas(true, true);
      syncSidePanelControls();
      editor.hqFrames = 1;
      updateSelectionMenu();
      requestDraw();
    }
    editor.interaction = null;
    if (ended && ended.kind === "view") {
      viewController.endDrag(performance.now());
    }
    syncViewToggleState();
    updateSelectionMenu();
    updateCursor(editor.pointerPos);
    requestDraw();
  };

  canvas.onpointercancel = () => {
    if (editor.interaction?.kind === "view") {
      viewController.endDrag(performance.now());
    }
    if (editor.interaction?.kind === "paint_stroke" || editor.interaction?.kind === "paint_lasso_fill") {
      const targetDescriptor = getActivePaintTargetDescriptor(editor.interaction);
      if (targetDescriptor) editor.paintEngine.cancelActiveStroke(targetDescriptor);
    }
    editor.interaction = null;
    syncViewToggleState();
    updateCursor(editor.pointerPos);
    requestDraw({ localOnly: true });
  };

  canvas.onauxclick = (e) => {
    if (e.button === 1) e.preventDefault();
  };

  canvas.onmousemove = (e) => {
    const p = screenPos(e);
    setPointerPos(p, true);
    if (editor.interaction) return;
    updateCursor(p);
  };

  canvas.onmouseleave = () => {
    setPointerPos(editor.pointerPos, false);
    updateCursor(editor.pointerPos);
  };

  canvas.onwheel = (e) => {
    if (editor.mode === "frame") {
      const p = screenPos(e);
      const factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
      if (zoomFrameViewAt(p, factor)) requestDraw({ localOnly: true });
      e.preventDefault();
      return;
    }
    if (editor.mode !== "pano") return;
    if (viewController.applyWheelEvent(e)) requestDraw({ localOnly: true });
    e.preventDefault();
  };

  canvas.ondragover = (e) => {
    if (type !== "stickers" || readOnly) return;
    e.preventDefault();
    setDropCue(true);
  };

  canvas.ondrop = (e) => {
    if (type !== "stickers" || readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    dragCue.depth = 0;
    setDropCue(false);
    const files = Array.from(e.dataTransfer?.files || []);
    const file = files.find((f) => isImageFile(f));
    if (!file) return;
    void addImageStickerFromFile(file);
  };

  const onWindowDragEnter = (e) => {
    if (type !== "stickers" || readOnly) return;
    if (!dragHasImageFiles(e)) return;
    dragCue.depth += 1;
    setDropCue(true);
    e.preventDefault();
  };
  const onWindowDragOver = (e) => {
    if (type !== "stickers" || readOnly) return;
    if (!dragCue.active && dragHasImageFiles(e)) setDropCue(true);
    if (dragCue.active) e.preventDefault();
  };
  const onWindowDragLeave = (e) => {
    if (type !== "stickers" || readOnly) return;
    if (!dragCue.active) return;
    dragCue.depth = Math.max(0, dragCue.depth - 1);
    const leftWindow = (Number(e.clientX) <= 0 && Number(e.clientY) <= 0);
    if (dragCue.depth === 0 || leftWindow) setDropCue(false);
  };
  const onWindowDrop = (e) => {
    if (type !== "stickers" || readOnly) return;
    dragCue.depth = 0;
    setDropCue(false);
    if (dragHasImageFiles(e)) e.preventDefault();
  };
  window.addEventListener("dragenter", onWindowDragEnter, true);
  window.addEventListener("dragover", onWindowDragOver, true);
  window.addEventListener("dragleave", onWindowDragLeave, true);
  window.addEventListener("drop", onWindowDrop, true);

  viewBtns.forEach((btn) => {
    btn.onclick = () => {
      if (btn.disabled) return;
      editor.mode = btn.dataset.view;
      forceCursorTool();
      syncViewToggleState();
      requestDraw();
    };
  });

  const undoBtn = root.querySelector("[data-action='undo']");
  if (undoBtn) {
    undoBtn.onclick = () => {
      if (readOnly) return;
      restoreHistory(-1);
    };
  }
  const redoBtn = root.querySelector("[data-action='redo']");
  if (redoBtn) {
    redoBtn.onclick = () => {
      if (readOnly) return;
      restoreHistory(1);
    };
  }
  const addBtn = root.querySelector("[data-action='add']");
  if (addBtn) {
    addBtn.onclick = () => {
      if (readOnly) return;
      (type === "stickers" ? addImageSticker() : addCutoutFrame());
    };
  }
  const clearBtn = root.querySelector("[data-action='clear']");
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (readOnly) return;
      clearAll();
    };
  }
  const applyBtn = root.querySelector("[data-action='save']");
  if (applyBtn) applyBtn.onclick = () => {
    if (readOnly) return;
    apply();
  };
  root.querySelector("[data-action='reset-view']").onclick = () => {
    startViewTween(0, 0, 100, 180, 680);
  };
  const gridBtn = root.querySelector("[data-action='toggle-grid']");
  const syncGridToggleButton = () => {
    if (!gridBtn) return;
    const visible = !!editor.showGrid;
    gridBtn.innerHTML = visible ? ICON.eye : ICON.eye_dashed;
    gridBtn.setAttribute("aria-pressed", visible ? "true" : "false");
    gridBtn.setAttribute("aria-label", visible ? "Hide Grid" : "Show Grid");
    gridBtn.setAttribute("data-tip", visible ? "Hide grid" : "Show grid");
  };
  if (gridBtn) {
    syncGridToggleButton();
    gridBtn.onclick = () => {
      editor.showGrid = !editor.showGrid;
      setNodeGridVisibility(node?.id, editor.showGrid);
      syncGridToggleButton();
      requestDraw();
    };
  }
  if (toolRail) {
    toolRail.querySelectorAll("[data-tool-mode]").forEach((btn) => {
      btn.onclick = () => {
        if (readOnly) return;
        const newTool = String(btn.getAttribute("data-tool-mode") || "cursor");
        editor.primaryTool = newTool;
        if (newTool === "paint" || newTool === "mask") {
          editor.selectedId = null;
          if (type === "stickers") state.active.selected_sticker_id = null;
          else state.active.selected_shot_id = null;
        }
        syncPaintUi();
        updateSidePanel();
        requestDraw();
      };
    });
    toolRail.querySelectorAll("[data-tool-ui-action]").forEach((btn) => {
      btn.onclick = () => {
        if (readOnly) return;
        const action = String(btn.getAttribute("data-tool-ui-action") || "");
        if (action === "undo") restoreHistory(-1);
        else if (action === "redo") restoreHistory(1);
        else if (action === "clear") clearAll();
        else if (action === "add") addImageSticker();
        else if (action === "add-or-look") {
          if (getList().length === 0) {
            addCutoutFrame();
          } else {
            const target = getSelected() || getList()[0];
            if (!target) return;
            editor.selectedId = target.id || null;
            state.active.selected_shot_id = editor.selectedId;
            const targetYaw = wrapYaw(Number(target.yaw_deg || 0));
            const targetPitch = clamp(Number(target.pitch_deg || 0), -89.9, 89.9);
            startViewTween(targetYaw, targetPitch, editor.viewFov);
            updateSidePanel();
            updateSelectionMenu();
            requestDraw();
          }
        }
      };
    });
  }
  if (paintFooter) {
    paintFooter.querySelectorAll("[data-paint-tool]").forEach((btn) => {
      btn.onclick = () => {
        editor.primaryTool = "paint";
        const tool = String(btn.getAttribute("data-paint-tool") || "pen");
        editor.paintTool = tool;
        if (BRUSH_PRESETS[tool]) editor.activeBrushPresetId = tool;
        syncPaintUi();
        updateSidePanel();
        requestDraw();
      };
    });
    paintFooter.querySelectorAll("[data-mask-tool]").forEach((btn) => {
      btn.onclick = () => {
        editor.primaryTool = "mask";
        editor.maskTool = String(btn.getAttribute("data-mask-tool") || "pen");
        syncPaintUi();
        updateSidePanel();
        requestDraw();
      };
    });
    if (paintLayerClearCurrentBtn) {
      paintLayerClearCurrentBtn.onclick = () => {
        clearPaintingLayer(editor.primaryTool === "mask" ? "mask" : "paint");
      };
    }
  }
  if (paintSizeSlider) {
    paintSizeSlider.oninput = () => {
      const v = Math.max(1, Math.min(120, Math.round(Number(paintSizeSlider.value))));
      const sizePresetId = getBrushPresetIdForTool(editor.primaryTool === "paint" ? editor.paintTool : editor.maskTool);
      editor.brushSizes[sizePresetId] = v;
      const pct = ((v - 1) / 119) * 100;
      paintSizeSlider.style.setProperty("--v", `${clamp(pct, 0, 100)}%`);
      if (paintSizeValue) paintSizeValue.textContent = String(v);
      showPaintSizePreview();
    };
    paintSizeSlider.onchange = () => hidePaintSizePreview();
    paintSizeSlider.addEventListener("pointerup", hidePaintSizePreview);
    paintSizeSlider.addEventListener("pointercancel", hidePaintSizePreview);
    paintSizeSlider.addEventListener("blur", hidePaintSizePreview);
  }
  if (paintColorRow) {
    paintColorRow.querySelectorAll("[data-paint-color-swatch]").forEach((btn) => {
      btn.onclick = () => {
        const swatch = PAINT_COLOR_SWATCHES.find((item) => item.id === btn.getAttribute("data-paint-color-swatch"));
        if (!swatch) return;
        editor.paintColor = cloneColor(swatch.color);
        closePaintColorPop(true);
        syncPaintUi();
      };
    });
    const customBtn = paintColorRow.querySelector("[data-paint-color-custom]");
    if (customBtn) {
      customBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (paintColorPop && !paintColorPop.hidden) closePaintColorPop(true);
        else openPaintColorPop();
        syncPaintUi();
      };
    }
  }
  const updatePaintColorFromSv = (clientX, clientY) => {
    if (!paintColorSv) return;
    const rect = paintColorSv.getBoundingClientRect();
    const sat = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const val = 1 - clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    const hsv = rgb01ToHsv(editor.customPaintColor);
    const next = { ...hsv01ToRgb(hsv.h, sat, val), a: Number(editor.customPaintColor?.a ?? 1) };
    editor.customPaintColor = cloneColor(next);
    editor.paintColor = cloneColor(next);
    syncPaintUi();
  };
  const updatePaintColorFromHue = (clientX) => {
    if (!paintHueStrip) return;
    const rect = paintHueStrip.getBoundingClientRect();
    const hue = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const hsv = rgb01ToHsv(editor.customPaintColor);
    const next = { ...hsv01ToRgb(hue, hsv.s, hsv.v), a: Number(editor.customPaintColor?.a ?? 1) };
    editor.customPaintColor = cloneColor(next);
    editor.paintColor = cloneColor(next);
    syncPaintUi();
  };
  const bindDrag = (startEvent, onMove) => {
    const pointerId = startEvent.pointerId;
    onMove(startEvent);
    const handleMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      onMove(moveEvent);
    };
    const finish = (endEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  if (paintColorSv) {
    paintColorSv.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      bindDrag(ev, (moveEvent) => updatePaintColorFromSv(moveEvent.clientX, moveEvent.clientY));
    };
  }
  if (paintHueStrip) {
    paintHueStrip.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      bindDrag(ev, (moveEvent) => updatePaintColorFromHue(moveEvent.clientX));
    };
  }
  if (paintAlphaSlider) {
    paintAlphaSlider.oninput = () => {
      const next = { ...editor.customPaintColor, a: clamp(Number(paintAlphaSlider.value) / 100, 0, 1) };
      editor.customPaintColor = cloneColor(next);
      editor.paintColor = cloneColor(next);
      syncPaintUi();
    };
  }
  const syncFullscreenButton = () => {
    if (!fullscreenBtn) return;
    const active = !!editor.fullscreen;
    fullscreenBtn.innerHTML = active ? ICON.fullscreen_close : ICON.fullscreen;
    fullscreenBtn.setAttribute("aria-label", active ? "Exit Fullscreen" : "Fullscreen");
    fullscreenBtn.setAttribute("data-tip", active ? "Exit fullscreen" : "Fullscreen");
  };
  const setFullscreenState = (active) => {
    const on = !!active;
    if (editor.fullscreen === on) return;
    editor.fullscreen = on;
    root.classList.toggle("pano-modal-fullscreen", on);
    if (on) {
      editor.fullscreenPrevShowGrid = !!editor.showGrid;
      editor.showGrid = false;
    } else if (editor.fullscreenPrevShowGrid !== null) {
      editor.showGrid = !!editor.fullscreenPrevShowGrid;
      editor.fullscreenPrevShowGrid = null;
    }
    syncGridToggleButton();
    syncFullscreenButton();
    requestDraw();
  };
  const isOverlayFullscreen = () => document.fullscreenElement === overlay;
  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenEnabled) {
        setFullscreenState(!editor.fullscreen);
        return;
      }
      if (!isOverlayFullscreen()) {
        await overlay.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      setFullscreenState(!editor.fullscreen);
    }
  };
  const onFullscreenChange = () => {
    if (document.fullscreenEnabled) {
      setFullscreenState(isOverlayFullscreen());
    }
  };
  document.addEventListener("fullscreenchange", onFullscreenChange);
  if (fullscreenBtn) {
    syncFullscreenButton();
    fullscreenBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleFullscreen();
    };
  }
  const syncOutputPreviewToggleButton = () => {
    if (!outputPreviewToggleBtn) return;
    const expanded = !!editor.outputPreviewExpanded;
    outputPreviewToggleBtn.innerHTML = expanded ? ICON.fullscreen_close : ICON.fullscreen;
    outputPreviewToggleBtn.setAttribute("aria-label", expanded ? "Reduce Preview" : "Expand Preview");
    outputPreviewToggleBtn.setAttribute("data-tip", expanded ? "Reduce preview" : "Expand preview");
  };
  if (outputPreviewToggleBtn) {
    syncOutputPreviewToggleButton();
    outputPreviewToggleBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const nextExpanded = !editor.outputPreviewExpanded;
      editor.outputPreviewExpanded = nextExpanded;
      editor.outputPreviewAnimFrom = editor.outputPreviewAnim;
      editor.outputPreviewAnimTo = nextExpanded ? 1 : 0;
      editor.outputPreviewAnimStartTs = performance.now();
      syncOutputPreviewToggleButton();
      requestDraw();
    };
  }
  selectionMenu.addEventListener("click", (ev) => {
    const target = ev.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (readOnly) return;
    if (action === "aspect") {
      editor.cutoutAspectOpen = !editor.cutoutAspectOpen;
      editor.menuSize.measured = false;
      updateSelectionMenu();
      requestDraw();
      return;
    }
    if (action === "aspect-set") {
      const selected = getSelected();
      if (!selected) return;
      const aspect = String(target.getAttribute("data-aspect") || "1:1");
      applyCutoutAspect(selected, aspect);
      editor.cutoutAspectOpen = false;
      editor.menuSize.measured = false;
      syncSidePanelControls();
      pushHistory();
      commitAndRefreshNode();
      updateSelectionMenu();
      requestDraw();
      return;
    }
    if (action === "rotate-90") {
      const selected = getSelected();
      if (!selected) return;
      rotateCutoutAspect90(selected);
      editor.cutoutAspectOpen = false;
      editor.menuSize.measured = false;
      syncSidePanelControls();
      pushHistory();
      commitAndRefreshNode();
      updateSelectionMenu();
      requestDraw();
      return;
    }
    if (action === "bring-front") {
      bringSelectedToFront();
      return;
    }
    if (action === "send-back") {
      sendSelectedToBack();
      return;
    }
    if (action === "duplicate") {
      duplicateSelected();
      return;
    }
    if (action === "back-initial") {
      restoreSelectedToInitialPose();
      return;
    }
    if (action === "toggle-visible") {
      deleteSelected();
      return;
    }
    if (action === "delete") {
      deleteSelected();
      return;
    }
    requestDraw();
  });

  const modalPrevOnExecuted = node.onExecuted;
  const modalPrevOnConnectionsChange = node.onConnectionsChange;
  let modalOnExecuted = null;
  let modalOnConnectionsChange = null;
  let modalExternalStickerSync = null;
  if (!readOnly && type === "stickers") {
    modalExternalStickerSync = (reason = "sync") => {
      reconcileExternalStickerFromInputs(reason);
    };
    node.__panoExternalStickerSync = modalExternalStickerSync;
    modalOnExecuted = function onPanoEditorExecuted(...args) {
      if (typeof modalPrevOnExecuted === "function") {
        modalPrevOnExecuted.apply(this, args);
      }
      this.__panoExternalStickerSync?.("executed");
    };
    node.onExecuted = modalOnExecuted;
    modalOnConnectionsChange = function onPanoEditorConnectionsChange(...args) {
      if (typeof modalPrevOnConnectionsChange === "function") {
        modalPrevOnConnectionsChange.apply(this, args);
      }
      this.__panoExternalStickerSync?.("connections");
    };
    node.onConnectionsChange = modalOnConnectionsChange;
  }

  const closeEditor = () => {
    if (document.fullscreenElement === overlay) {
      document.exitFullscreen?.().catch(() => { });
    }
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    node.__panoLiveStateOverride = null;
    node.__panoDomPreview?.requestDraw?.();
    node.graph?.setDirtyCanvas?.(true, true);
    app?.canvas?.setDirty?.(true, true);
    hideTooltip();
    stopRenderLoop();
    setDropCue(false);
    window.removeEventListener("keydown", onEscClose, true);
    window.removeEventListener("keydown", onDeleteKey, true);
    window.removeEventListener("keydown", onUndoRedoKey, true);
    window.removeEventListener("dragenter", onWindowDragEnter, true);
    window.removeEventListener("dragover", onWindowDragOver, true);
    window.removeEventListener("dragleave", onWindowDragLeave, true);
    window.removeEventListener("drop", onWindowDrop, true);
    if (!readOnly && type === "stickers") {
      if (node.onExecuted === modalOnExecuted) node.onExecuted = modalPrevOnExecuted;
      if (node.onConnectionsChange === modalOnConnectionsChange) node.onConnectionsChange = modalPrevOnConnectionsChange;
      if (node.__panoExternalStickerSync === modalExternalStickerSync) node.__panoExternalStickerSync = null;
    }
    overlay.remove();
  };
  const onEscClose = (ev) => {
    if (ev.key !== "Escape") return;
    if (editor.fullscreen && document.fullscreenElement === overlay) {
      document.exitFullscreen?.().catch(() => { });
      return;
    }
    if (editor.fullscreen) {
      setFullscreenState(false);
      return;
    }
    closeEditor();
  };
  const onDeleteKey = (ev) => {
    const key = String(ev.key || "");
    const code = String(ev.code || "");
    const keyCode = Number(ev.keyCode || 0);
    const isDeleteKey = key === "Delete" || code === "Delete" || keyCode === 46;
    const isBackspaceKey = key === "Backspace" || code === "Backspace" || keyCode === 8;
    if (!isDeleteKey && !isBackspaceKey) return;
    const t = ev.target;
    const tag = (t?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
    const selected = getSelected();
    if (!selected) return;
    deleteSelected();
    ev.preventDefault();
    ev.stopPropagation();
  };
  const onUndoRedoKey = (ev) => {
    if (readOnly) return;
    if (!ev.ctrlKey && !ev.metaKey) return;
    const key = String(ev.key || "").toLowerCase();
    const code = String(ev.code || "");
    if (key !== "z" && code !== "KeyZ") return;
    const t = ev.target;
    const tag = (t?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
    restoreHistory(ev.shiftKey ? 1 : -1);
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("keydown", onEscClose, true);
  window.addEventListener("keydown", onDeleteKey, true);
  window.addEventListener("keydown", onUndoRedoKey, true);
  overlay.addEventListener("pointerdown", (ev) => {
    if (ev.target === overlay) closeEditor();
  });

  installTooltipHandlers(root);
  applyInitialCutoutFocus();
  if (!readOnly && type === "stickers") {
    reconcileExternalStickerFromInputs("open");
  }
  void migrateLegacyEmbeddedAssets();
  pushHistory();
  syncPaintUi();
  updateSidePanel();
  syncLookAtFrameButtonState();
  syncCanvasSize();
  updateCursor(editor.pointerPos);
  requestDraw();
  runtime.rafId = requestAnimationFrame(tick);
}

function installEditorButton(nodeType, nodeData, matchType, buttonText) {
  const cleanupPreviewBindings = (node) => {
    try { node.__panoDomRestore?.(); } catch { }
    try { node.__panoLegacyRestore?.(); } catch { }
    node.__panoDomPreview = null;
    node.__panoLegacyPreviewHooked = false;
    node.__panoPreviewHooked = false;
    node.__panoPreviewAttached = false;
    node.__panoPreviewMountKey = null;
  };

  function installOrUpdate(node) {
    const mountKey = `editor_btn|${matchType}`;
    const alreadyAttached = node.__panoPreviewAttached === true && node.__panoPreviewMountKey === mountKey;

    // Avoid redundant cleanup/re-attach if already attached with the same key
    if (alreadyAttached) return;

    cleanupPreviewBindings(node);
    hideWidget(node, STATE_WIDGET);

    const sw = getWidget(node, STATE_WIDGET);
    if (sw && !sw.__panoPreviewPatchedCb) {
      sw.__panoPreviewPatchedCb = true;
      const prevCb = sw.callback;
      sw.callback = (v) => {
        const r = prevCb ? prevCb(v) : undefined;
        // Only trigger soft repaint, avoid forcing a full workflow persistence on every move if storage is tight
        node.setDirtyCanvas?.(true, false);
        return r;
      };
    }
    const bg = getWidget(node, "bg_color");
    if (bg && (bg.value == null || String(bg.value).trim() === "" || String(bg.value).toLowerCase() === "#000000")) {
      bg.value = "#00ff00";
      bg.callback?.("#00ff00");
    }

    if (matchType === "PanoramaStickers") {
      ensureActionButtonWidget(node, buttonText, () => showEditor(node, "stickers"));
      if (ENABLE_STICKERS_NODE_PREVIEW) {
        attachStickersNodePreview(node, {
          enabled: true,
          buttonText,
          onOpen: () => showEditor(node, "stickers"),
        });
        // Respect user-sized nodes; initialize only when preview is enabled and size is invalid.
        if (!Array.isArray(node.size) || node.size[0] < 10 || node.size[1] < 10) {
          node.size = [360, 260];
        }
      } else {
        // Without node preview, let LiteGraph size the node from widgets only.
        node.__panoPreviewAttached = true;
        node.__panoPreviewMountKey = mountKey;
        return;
      }
      node.__panoPreviewAttached = true;
      node.__panoPreviewMountKey = mountKey;
      return;
    }

    ensureActionButtonWidget(node, buttonText, () => showEditor(node, "cutout"));
    attachCutoutPreview(node, {
      buttonText,
      onOpen: () => showEditor(node, "cutout"),
    });

    if (!Array.isArray(node.size) || node.size[0] < 10 || node.size[1] < 10) {
      node.size = [360, 260];
    }

    node.__panoPreviewAttached = true;
    node.__panoPreviewMountKey = mountKey;
  }

  const onNodeCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
    installOrUpdate(this);
    return r;
  };

  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
    if (this.widgets) installOrUpdate(this);
    return r;
  };

  const onAdded = nodeType.prototype.onAdded;
  nodeType.prototype.onAdded = function () {
    const r = onAdded ? onAdded.apply(this, arguments) : undefined;
    if (this.widgets) installOrUpdate(this);
    return r;
  };
}

function installStandalonePreviewNode(nodeType) {
  if (!Array.isArray(nodeType?.prototype?.size) || nodeType.prototype.size[0] < 100 || nodeType.prototype.size[1] < 100) {
    nodeType.prototype.size = [360, 260];
  }
}

function installStandalonePreviewInstance(node) {
  if (!node) return;
  if (node.__panoStandaloneInstallDone) return;
  if (node.__panoStandaloneInstallProbeActive) return;
  node.__panoStandaloneInstallProbeActive = true;

  const tryInstall = () => {
    const nodeId = Number(node?.id ?? -1);
    const ready = nodeId >= 0 && !!node?.graph;
    const tries = Number(node.__panoStandaloneInstallProbeTries || 0) + 1;
    node.__panoStandaloneInstallProbeTries = tries;

    if (!ready && tries < 40) {
      requestAnimationFrame(tryInstall);
      return;
    }
    ensureActionButtonWidget(node, "Open Preview", () => showEditor(node, "stickers", { readOnly: true, hideSidebar: false }));
    attachPreviewNode(node, {
      buttonText: "Open Preview",
      modalTitle: "Panorama Preview",
      imageInputName: "erp_image",
      onOpen: (n) => showEditor(n, "stickers", { readOnly: true, hideSidebar: false }),
    });
    node.__panoStandaloneInstallDone = true;
    node.__panoStandaloneInstallProbeActive = false;
  };

  requestAnimationFrame(tryInstall);
}

app.registerExtension({
  name: "ComfyUI.PanoramaSuite.Editor",
  async beforeQueuePrompt() {
    // Wait for all in-flight paint layer uploads before sending the prompt.
    const pending = [..._paintLayerUploadRegistry.values()];
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    const name = String(nodeData?.name || "");
    if (name === "PanoramaStickers" || name === "Panorama Stickers") {
      installEditorButton(nodeType, nodeData, "PanoramaStickers", "Open Stickers Editor");
    }
    if (name === "PanoramaCutout" || name === "Panorama Cutout") {
      installEditorButton(nodeType, nodeData, "PanoramaCutout", "Open Cutout Editor");
    }
    if (isPanoramaPreviewNodeName(name)) {
      installStandalonePreviewNode(nodeType);
    }
  },
  nodeCreated(node) {
    const name = String(node?.comfyClass || node?.type || node?.title || "");
    if (!isPanoramaPreviewNodeName(name)) return;
    installStandalonePreviewInstance(node);
  },
});
