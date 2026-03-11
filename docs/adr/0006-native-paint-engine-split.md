# ADR 0006: Panorama Paint の Native Editing Engine 分離

## Status

Accepted

## Date

2026-03-07

## Context

`PanoramaStickers` / `PanoramaCutout` に対して、共通の paint system を段階的に導入したが、
最初の実装は次の問題を起こした。

- active editing view でも projected geometry を直接描いていた
- drag 中と pointerup 後で線形が変わった
- freehand の品質が低く、穴・ボコつき・不自然な補間が出た
- frame / panorama / unwrap の表示責務が混ざった
- frame view と cutout preview を同種のものとして扱い、責務が破綻した
- pointermove 中にモーダル全体で重い再描画が走り、描き味が悪化した

特に問題だったのは、cross-view 整合性を先に成立させようとして、
editing view の描き味を projected overlay 依存にしてしまったことだった。

その結果、

- `pointerup` で線が変わる
- FOV や view 差で線幅が不安定になる
- frame で描いた線が panorama 側で frame に張り付く
- preview で projected stroke が暴れる

といった UX 上の破綻が起きた。

## Decision

paint system は次の 2 系統に明確に分離する。

1. `Editing Engine`
2. `ERP / Frame Integration`

この 2 つを混ぜない。

### 1. Editing Engine

Editing Engine の責務は次に限定する。

- native target-space での低レイテンシ描画
- raw input の収集
- raw -> processed の stroke geometry 処理
- current stroke / committed stroke の分離
- paint / mask の独立レイヤー管理

active editing view では projected geometry を主表示に使わない。

つまり、

- ERP を編集中なら ERP native raster
- frame を編集中なら frame-local native raster

を直接表示する。

### 2. ERP / Frame Integration

ERP / Frame Integration の責務は次に限定する。

- panorama / unwrap / frame / preview 間の cross-view 表示
- projected overlay / projected cache
- ERP seam 処理
- frame pose 変更時の invalidation
- backend materialization

cross-view は従属表示であり、
active editing target の描き味を壊してはならない。

## Durable Source of Truth

source of truth は完成ラスタではなく stroke records とする。

- durable 保存先は `state_json.painting`
- durable shape は `paint` / `mask` 分離
- undo / redo stack は durable に保存しない
- raster cache は derived data only

freehand の durable geometry は少なくとも次を持つ。

- `rawPoints`
- `processedPoints`

`rawPoints` を残す理由は、将来

- smoothing 強度変更
- width solve 変更
- pseudo pressure 導入

に対して再処理可能性を確保するためである。

## Display Model

### Panorama / Unwrap

- panorama と unwrap は同じ `ERP_GLOBAL` を見る別 view とする
- どちらも同じ ERP native raster を表示する
- 差は display transform のみ

### Frame View

frame view は `FRAME_LOCAL(frameId)` の専用 editor とする。

- 背景は active frame の基準画像
- その上に frame-native paint / mask raster
- pointer は frame 外でも継続
- 表示だけ frame rect clip
- zoom / pan は ephemeral
- durable 保存しない

frame view は cutout preview の拡大版ではない。

### Cross-view

cross-view は projected overlay / projected cache のみとする。

- ERP -> frame
- frame -> ERP / panorama / unwrap

active editing target の主表示は native raster、
他 target での参照表示だけが projected overlay である。

## Geometry Pipeline

freehand は次の 3 段階に固定する。

1. `rawPoints`
2. `processedPoints`
3. `projectedSamples`

役割は次の通り。

- durable:
  - `rawPoints`
  - `processedPoints`
- ephemeral:
  - `projectedSamples`

rasterizer は `processedPoints` 後段に限定する。

## Projection Rules

cross-view の freehand 再投影は、
「点列を target view に写してそのまま結ぶ」方式を採用しない。

少なくとも次を必須にする。

- segment 単位で扱う
- adaptive subdivision
- discontinuity 判定
- clip

segment は次の場合に切る。

- 背面
- shot 外
- 投影失敗
- seam cross
- 大きな screen-space jump

invalid point を跨いだまま polygon / ribbon を作らない。

## Line Width

線幅の基準は current view の screen px ではなく、
stroke が属する target space 上の半径とする。

- `ERP_GLOBAL` は ERP 側基準半径
- `FRAME_LOCAL` は frame-local 側基準半径

FOV を変えても source 側の線幅は変わらない。
view 差による見かけ幅の変化は投影結果としてのみ現れる。

## Mask

mask は paint の一部ではない。

- durable state でも分離
- native raster cache でも分離
- rendering path でも分離
- backend materialization でのみ利用方法を決める

mask の意味は常に白黒独立実体であり、
緑 overlay は UI 表示上の都合に留める。

## History Policy

`editor_history` の durable 保存は採用しない。

理由:

- state が肥大し workflow draft 保存失敗を引き起こした
- frame 移動など高頻度操作で durable snapshot が過剰に増えた
- history と source of truth を混ぜると責務が曖昧になる

Undo / Redo は editor session 内のみとする。

## Consequences

### Positive

- active editing の描き味を cross-view 都合から切り離せる
- drag 中と commit 後の見た目差を減らせる
- paint / mask / ERP / frame の責務が明確になる
- 後段で variable width や高品質 brush へ拡張しやすくなる

### Tradeoffs

- cross-view overlay は Phase 1 では conservative になる
- durable records と native caches の二層管理が必要になる
- `web/pano_editor.js` の責務分割が前提になる

## Implementation Guidance

次の順で進める。

1. durable schema cleanup
2. native editing engine scaffolding
3. freehand native engine
4. paint / mask split in engine
5. lasso fill native path
6. display adapters
7. backend materialization

## Explicit Non-Goals for Phase 1

Phase 1 では次を完成目標にしない。

- 商用品質の variable-width brush
- perfect parity な cross-view raster projection
- lasso の複雑な seam/occlusion 完全対応

Phase 1 の主目標は、
「fixed-width freehand が active target で気持ちよく描けること」
である。

## Follow-up

- `web/pano_editor.js` から engine / processor / rasterizer / adapters を分離する
- freehand を native engine 前提で再構築する
- projected overlay cache を target/view ごとに分離する
- Python 側 materialization を `rawPoints` / `processedPoints` 前提へ揃える
