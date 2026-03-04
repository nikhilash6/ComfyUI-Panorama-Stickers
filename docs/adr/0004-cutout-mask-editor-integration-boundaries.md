# 0004: PanoramaCutout と Core Mask Editor の統合境界

- Status: Accepted
- Date: 2026-03-04

## Context

`PanoramaCutout` に対して、ComfyUI コアの Mask Editor をそのまま統合し、

- cutout フレームを直接開く
- 保存結果を `state_json` に durable 化する
- 次回実行で `rect_image` と `mask` に反映する

ことを試みた。

途中まで以下は成立した。

- `state_json.mask_editor` に clipspace refs を保存する設計
- `frame_signature` による無効化
- backend で `rect_image` / `mask` を差し替える土台

しかし最終的に、「core Mask Editor を `PanoramaCutout` に自然に開かせる」部分で設計衝突が発生した。

## What Failed

### 1. Core Mask Editor は標準 image ノード前提

core Mask Editor の open 条件・ロード経路は、標準 image node preview の前提に寄っている。

- `node.imgs`
- `node.images`
- 標準 preview / clipspace 経路

`PanoramaCutout` は一方で、標準 image preview を抑制し、自前のリアルタイム cutout preview を前提にしている。

このため、

- core 側に合わせると realtime preview が壊れやすい
- realtime preview を守ると core 側の open 導線に乗りにくい

という構造的衝突が起きた。

### 2. 「開く導線」と「保存導線」は別問題だった

保存後の durable 化（`node.images` 監視 → `state_json.mask_editor` 保存）は一定の妥当性があった。

しかし、open 経路を無理に合わせようとすると、

- `previewMediaType`
- `node.images`
- `clipspace`

の扱いが preview システム全体に波及し、cutout の本来価値であるリアルタイム調整を損なった。

### 3. 公開 API ではなく、内部前提への依存が増えた

core 側の実導線を再利用しようとすると、

- command 実行経路
- clipspace 経路
- image node としての扱い

に依存する必要があり、結果的に frontend 実装差や内部前提に強く縛られる形になった。

この方向は保守性が低く、今後壊れやすい。

## Decision

`PanoramaCutout` に core Mask Editor を無理に統合する方針は、この時点で打ち切る。

以下は採用しない。

- `PanoramaCutout` を常時 core image node のように振る舞わせる実装
- realtime preview を犠牲にして core Mask Editor 導線へ寄せる実装
- open 経路のために `node.images` / `node.imgs` / `previewMediaType` を不自然に操作する実装

今回の試行ブランチは破棄し、採用しない。

## Consequences

### 採用する方向

今後は、`PanoramaCutout` / `PanoramaStickers` で共通利用できる **自前の最小ペイント機能** を実装する方向へ切り替える。

具体的には:

- cutout editor 内にフレーム編集モードを持つ
- 緑 overlay ベースの簡易ペイント / 消しゴム / clear を持つ
- `mask` を workflow 出力としてそのまま使える

この方向なら:

- realtime preview を維持できる
- workflow 接続可能な出力を持てる
- sticker 側にも同じ基盤を流用できる

### 残すべき教訓

1. `PanoramaCutout` のリアルタイム preview はコア体験であり、他機能のために壊してはいけない。
2. core の既存 UI を再利用できても、ノードの責務モデルが違うなら無理に統合しない。
3. 「開けること」より、「workflow 上で自然に使えること」を優先して設計する。

## Notes

この ADR は「core Mask Editor を使う試行」を否定するものではなく、
**`PanoramaCutout` に対する直接統合は、現在のアーキテクチャでは割に合わない**と判断した記録である。
