# ADR 0008: FRAME_LOCAL 完全削除 / ERP_GLOBAL 統一

## Status

Accepted

## Date

2026-03-08

## Context

ペイント機能はまだ未公開（未リリース）のため、旧 FRAME_LOCAL 座標系との後方互換を維持する必要がない。
ERP_GLOBAL を唯一の source of truth に統一することで、コードの複雑性を大幅に削減できる。

ADR 0007 の最適化後も、以下の問題が残っていた。

- FRAME_LOCAL 投影関数群（`projectFrameStroke*` 等）が 17 関数以上存在し、保守コストが高い
- `getTargetCoord`、`normalizePoint` 等の関数に FRAME_LOCAL 分岐があり、将来のバグ源となりうる
- `frameSnapshot` フィールドがストロークレコードに残り、シリアライズ形式を複雑にしていた
- `frameTargets` Map がペイントエンジンに残り、フレームサーフェスのライフサイクル管理が必要だった

## Decision

FRAME_LOCAL 関連コードを互換レイヤーを残さず完全削除し、ERP_GLOBAL に統一する。

### 削除した要素

#### pano_editor.js (-550 lines)

| 削除した関数 / フィールド | 理由 |
|---|---|
| `getPaintEngineFrameDescriptors()` | フレーム descriptor 不要 |
| `getFrameListKey()` | フレームリスト revision 追跡不要 |
| `rebuildNativePaintCachesIfNeeded()` | dead code |
| `worldDirToFrameLocalPoint()` | FRAME_LOCAL 座標への変換不要 |
| `screenPosToFramePoint()` | FRAME_LOCAL 型点を生成する関数 |
| `captureFrameSnapshot()` | FRAME_LOCAL ストローク専用 |
| `projectFrameStroke*` 6 関数 | FRAME_LOCAL 投影群 |
| `projectFrameLasso*` 2 関数 | FRAME_LOCAL ラッソ投影群 |
| `drawFramePaintingOverlayInRect()` | ERP ラスターで代替済み |
| `drawCutoutPreviewPaintingOverlayInRect()` | ERP ラスターで代替済み |
| `drawPaintingOverlay()` | 中身が ERP_GLOBAL を return するだけになったため |
| `getCachedErpViewSegments()` + `_erpSegCache` | FRAME_LOCAL 投影キャッシュ |
| `getCachedShotRectSegments()` + `_shotSegCache` | 同上 |
| `editor._lastPaintStrokeKey` | 重複追跡フィールド |
| `frameSnapshot` フィールド in stroke records | FRAME_LOCAL 専用メタデータ |

#### pano_paint_engine.js

| 削除した要素 | 理由 |
|---|---|
| `const frameTargets = new Map()` | フレームサーフェス不要 |
| `getFrameTarget()` | フレームターゲットアクセサ |
| `syncFrameTargets()` | ADR 0007 で追加したが ERP 統一後は不要 |
| `getTargetCoord()` の FRAME_LOCAL 分岐 | 常に u/v を使う |

#### pano_paint_types.js

| 削除した要素 | 理由 |
|---|---|
| `normalizeTargetSpace()` の FRAME_LOCAL 分岐 | ERP_GLOBAL 以外は null 返却 |
| `normalizePoint()` の FRAME_LOCAL 分岐 | ERP_GLOBAL 点のみ有効 |
| `normalizeStroke()` の `frameSnapshot` 処理 | フィールド自体を削除 |

### 簡略化した要素

**`getActivePaintTargetDescriptor()`** — 常に ERP_GLOBAL descriptor を返す:
```js
function getActivePaintTargetDescriptor() {
  return { kind: "ERP_GLOBAL", width: 2048, height: 1024 };
}
```

**`ensureTarget()`** — 常に `erpTarget` を返す:
```js
function ensureTarget(_descriptor) {
  return erpTarget;
}
```

**`rebuildCommitted(state)`** — ERP ストロークのみ処理、`frameDescriptors` 引数削除:
```js
function rebuildCommitted(state) {
  // clear ERP surfaces
  // draw only strokes where targetSpace.kind === "ERP_GLOBAL"
}
```

**`appendLassoPoint()`** — frame mode では `screenPosToFrameAsErpPoint` を使用（FRAME_LOCAL 分岐を削除）

**`getTargetSpaceCoord`, `cloneTargetPointWithCoords`, `getFreehandResampleSpacing`,
`getNativeRadiusPxForStrokePoint`, `captureStrokeRadiusSpec`, `getSourcePoint2D`,
`getWorldOffsetDirForStrokePoint`** — FRAME_LOCAL 分岐を削除し ERP のみに統一

### 保持した関数

| 関数 | 理由 |
|---|---|
| `frameLocalPointToWorldDir()` | frame screen → ERP 変換の内部ステップとして `screenPosToFrameAsErpPoint` が使用 |
| `screenPosToFrameAsErpPoint()` | frame tab ペイント入力の唯一の変換器（ERP_GLOBAL 点を出力する） |

## Consequences

### 正の効果

- コード量 -667 行（`pano_editor.js` -550、`pano_paint_engine.js` -82、`pano_paint_types.js` -35）
- FRAME_LOCAL 関連バグの発生経路が構造的に存在しなくなる
- `rebuildCommitted` がフレームサーフェスのライフサイクルを管理する必要がなくなる
- ストロークのシリアライズ形式がシンプルになる（`frameSnapshot` フィールドなし）
- 新規ストロークが必ず ERP_GLOBAL に保存される（`getActivePaintTargetDescriptor` で保証）

### 負の効果・制約

- 旧 FRAME_LOCAL ストロークデータ（もし存在しても）は `normalizeTargetSpace` が `null` を返すため
  `normalizeStroke` が `null` を返し、ロード時に無視される。クラッシュはしない。
- ペイント機能が未公開のため、実際のユーザーデータへの影響はない。

## 変更ファイル

- `web/pano_editor.js`
- `web/pano_paint_engine.js`
- `web/pano_paint_types.js`
