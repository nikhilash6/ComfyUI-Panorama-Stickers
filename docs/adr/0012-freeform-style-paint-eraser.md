# ADR 0012: Freeform 型 paint eraser への切り替え

## Status

Accepted

## Date

2026-03-11

## Context

paint eraser を「選択済み object だけを切る」操作として扱う案は、ユーザー体験として不自然だった。

期待されている挙動は Apple Freeform に近く、以下が必要だった。

- 先に object を選択しなくても eraser が効く
- eraser stroke に触れた paint object を自動で対象にする
- ドラッグ中の見た目と release 後の結果が一致する
- 切れた結果は断片 object として残る

既存の `web/pano_editor.js` は、`strokeGroup` と `raster_frozen` が別経路で扱われており、selection 前提の commit path も混在していた。

## Decision

### 1. paint eraser の対象判定を selection 依存から外す

`paint eraser` は選択中 object を必須にしない。

代わりに、eraser stroke と交差した paint object を対象にする。

対象 object は以下の 2 種類を含む。

- `strokeGroup`
- `raster_frozen`

### 2. eraser commit を object 単位の raster cut に統一する

各対象 object について以下を行う。

1. ERP raster に変換
2. `destination-out` で eraser mask を適用
3. connected components で分裂
4. durable な `strokeGroup` / `raster_frozen` source は直接置換しない
5. 分裂結果は render / rebuild 用の transient `raster_frozen` 断片として扱う

これにより、vector stroke 群と raster object を同じ切断モデルに寄せる。
ただし persistence contract は [ADR 0006](./0006-native-paint-engine-split.md) を優先し、
durable source of truth は引き続き stroke records とする。

### 2.1 persistence contract

- durable source of truth:
  - `strokeGroup`
  - `rawPoints`
  - `processedPoints`
- derived / transient:
  - `raster_frozen`
  - eraser 後の断片 raster

つまり、ADR 0012 は eraser の操作モデルと rendering / rebuild モデルを定めるが、
durable state を `raster_frozen` 断片へ全面移行することは意味しない。

### 3. live preview は「実際に削れて見える」方式を優先する

単なる軌跡 overlay は採用しない。

ドラッグ中に対象 object そのものへ live eraser を仮適用した見た目を優先する。

### 4. 現時点では quality/performance 未達を明示する

この切り替えにより、selection 前提の誤った操作モデルは解消した。

一方で、2026-03-11 時点では以下が未解決、または不十分である。

- soft brush eraser 時の負荷が高い
- live preview と commit 結果の一致がまだ不完全なケースがある
- live preview cache の invalidation が複雑で壊れやすい
- `web/pano_editor.js` に責務が集中しすぎている

この ADR は「完成」を意味しない。操作モデルの方向を確定したものとする。

## Consequences

### Positive

- Freeform に近い操作モデルへ揃えられる
- `strokeGroup` / `raster_frozen` を同じ eraser path に寄せられる
- 選択前提の不自然な UX を除去できる

### Negative / Tradeoffs

- object ごとの raster 化と cut 判定で計算量が増える
- live preview と commit の整合を取る責務が増える
- 現状の単一巨大ファイル構成では変更の影響範囲が広い
- normalization / rebuild logic では、`strokeGroup` を durable truth としつつ、
  `raster_frozen` を transient/derived として区別して扱う必要がある

## Follow-up

次の改善は以下を前提に進める。

- eraser preview 専用の小さな runtime module へ分離する
- object 全体 ERP ではなく、交差領域だけの局所処理へ落とす
- preview 用 stroke shape と commit 用 stroke shape を完全に共通化する
- raster cut と display cache invalidation の責務を分ける

## Rejected Alternatives

### selected object only eraser を続ける

実装は小さく見えるが、ユーザー期待と一致しない。Freeform 参照の要件を満たさないため不採用。

### overlay だけで削れているように見せる

見た目だけ合わせても、release 後の結果とズレる。消しゴムとして信用できないため不採用。
