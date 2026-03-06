# ADR 0005: WebGL Preview Unification

## Status

Accepted

## Context

The editor modal, node thumbnail preview, and standalone preview node were still
using CPU triangle projection for ERP background rendering. That caused:

- visible triangle faceting
- duplicated projection math across files
- poor performance under interaction
- different rendering behavior between modal and node previews

The repo already had enough shared camera/projection math to support a single
WebGL-backed ERP background path, but `main` did not yet ship a renderer module.

## Decision

We introduce a shared WebGL2 ERP renderer and route the following normal paths
through it:

- modal panorama background
- modal unwrap background
- modal cutout output preview background
- DOM/runtime node panorama preview background
- standalone preview node background
- cutout preview runtime background

The renderer remains display-only. It is responsible for sampling ERP imagery
into panorama, unwrap, and cutout viewports. It does not own paint semantics,
input semantics, or state semantics.

CPU projection remains only as a fallback path where the WebGL renderer is not
available or a call site still needs a temporary compatibility path.

## Consequences

Positive:

- panorama/cutout/unwrap background rendering shares one sampling path
- CPU triangle projection is removed from normal preview interactions where the
  WebGL renderer can be used
- modal and node previews converge on the same rendering behavior

Tradeoffs:

- sticker overlay warping is still not fully GPU-native in this phase
- some CPU fallback code remains in place for compatibility
- WebGL support is now a normal dependency for best-quality preview rendering

## Follow-up

- migrate sticker overlay projection onto a GPU path
- remove remaining CPU projection fallbacks from normal rendering paths
- extend the renderer to cover paint/mask overlays when the paint rewrite lands
