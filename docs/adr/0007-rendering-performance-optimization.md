# ADR 0007: レンダリングパフォーマンス最適化

## Status

Accepted

## Date

2026-03-08

## Context

ペイントエンジンの基本実装（ADR 0006）が完了した後も、UI が重すぎるという問題が残っていた。
特にフレーム追加時に顕著なヒッチが発生し、ストロークが増えるほど状況が悪化した。

プロファイリングと静的解析により、以下の 4 つのボトルネックを特定した。

### B1: フレーム追加 → 全ストローク再描画 (CRITICAL)

`getPaintingRevisionKey()` がストローク revision とフレームリスト（shot ID + 解像度）を
一つの文字列に結合していた。フレームを追加するだけで revision key が変わり、
`rebuildPaintEngineIfNeeded()` が `rebuildCommitted()` を呼び出す。

`rebuildCommitted()` は ERP サーフェスと全フレームサーフェスをクリアして、
全ストロークをゼロから再描画する。ストロークが 50 本 × 500 点なら
25,000 quadratic bezier セグメントを毎フレーム追加のたびに描き直す。
しかしフレームの追加は ERP ストロークに何の影響も与えない。

### B2: フレームモードの ERP ストロークを二重描画 (HIGH)

`drawFrameViewBackground()` は:
1. ERP ペイントラスターを `renderCutoutViewToContext2D`（WebGL）でフレームへ投影
2. さらに全ストロークを `drawFramePaintingOverlayInRect`（Canvas2D）で手動投影

(1) の WebGL レンダリングに全ストロークが既に含まれているため、
(2) は O(n_strokes × projection_cost) の冗長な計算だった。
ERP_GLOBAL ストロークは WebGL テクスチャを通じて正確に投影されるため、
Canvas2D での再投影に意味はない。

### B3: `drawObjects()` が毎フレームソート (MEDIUM)

`[...getList()].sort(...)` を毎 tick 実行。フレームもステッカーも変化していなくても
O(n log n) のソートが走る。

### B4: アウトプットプレビューの Canvas2D 投影 (MEDIUM)

`drawCutoutPreviewPaintingOverlayInRect` は、全ストロークを Canvas2D で
フレームビュー矩形へ投影する。`drawScene` から毎フレーム呼ばれ、
O(n_strokes × n_points × projection_math) のコストがかかっていた。

## Decision

### Fix 1: ストローク revision とフレームリスト revision の分離

`getPaintingRevisionKey()` をストローク変化（commit/undo/redo/clear）のみを返すよう変更。
フレームリスト変化は `getFrameListKey()` で別追跡する。

`rebuildPaintEngineIfNeeded()` でストローク key が変わった場合のみ `rebuildCommitted()` を呼ぶ。
フレームリストだけが変わった場合は新設の `syncFrameTargets()` を呼ぶ。

`syncFrameTargets()` は `pano_paint_engine.js` に追加した軽量関数で、
ERP サーフェスには一切触れず、新規フレームのサーフェスを作成し、
削除されたフレームのサーフェスを廃棄するだけ。

```
フレーム追加前: O(n_strokes × n_points) の rebuildCommitted
フレーム追加後: O(1) の syncFrameTargets
```

### Fix 2: フレームモードの Canvas2D オーバーレイを除去

`drawFrameViewBackground()` の `drawFramePaintingOverlayInRect` 呼び出しを
`!erpRaster` 条件にガード。ERP ペイントラスターがある限り（= ペイントエンジン稼働中は常時）
Canvas2D オーバーレイをスキップする。ERP ストロークは WebGL の方が
品質・速度とも優れているため、Canvas2D での再投影は純粋な損失だった。

### Fix 3: `drawObjects()` ソートのメモ化

`getList()` の配列参照をキーとして使い、参照が変わった時だけ再ソートする。
アイテムの追加/削除/変更は必ず新しい配列参照を生む設計のため、
参照比較によるキャッシュ無効化が正確に機能する。

### Fix 4: アウトプットプレビューを WebGL ペイント投影に切り替え

`drawCutoutOutputPreview()` 内に `renderPreviewPaint()` ヘルパーを設け、
ERP ペイントラスターがある場合は `renderCutoutViewToContext2D` で WebGL 投影し、
ない場合のみ `drawCutoutPreviewPaintingOverlayInRect` にフォールバックする。
WebGL 側はキャッシュ（`backgroundRevision` ベース）があるため、
ストローク変化がなければ再描画しない。

## Consequences

### 正の効果

- フレーム追加時のヒッチが消える（O(n_strokes) → O(1)）
- フレームモードのレンダリングが O(n_strokes) 軽くなる（毎フレーム）
- アウトプットプレビューがキャッシュ済み WebGL テクスチャを再利用する
- `drawObjects()` のソートコストが実質ゼロになる

### 負の効果・制約

- `syncFrameTargets()` はフレームサーフェスを空で作るため、
  フレームモードに切り替えた直後は FRAME_LOCAL ストロークが表示されない
  → ただし現在は全ストロークが ERP_GLOBAL に統一されているため実害なし

- `drawFramePaintingOverlayInRect` のフォールバックパスは
  `erpRaster === null` の場合（= ペイントエンジン未初期化）のみ有効。
  実用上はこのパスに到達しない。

- アウトプットプレビューのペイント表示が WebGL の `backgroundRevision` キャッシュに依存する。
  キャッシュキーが古い値に固定されたバグがあると、ストローク変化が反映されない。
  `getPaintingRevisionKey()` = `String(editor.paintStrokeRevision)` は
  O(1) かつ正確なキーなので現実装では問題ない。

## 変更ファイル

- `web/pano_editor.js`: `getPaintingRevisionKey`, `getFrameListKey`(新), `rebuildPaintEngineIfNeeded`, `drawObjects`, `drawFrameViewBackground`, `drawCutoutOutputPreview`, editor 初期化に `_lastPaintStrokeKey` / `_sortedItemsCache` 追加
- `web/pano_paint_engine.js`: `syncFrameTargets`(新), `return {}` に追加
