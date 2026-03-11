# ADR-0003: External Input Sticker Failure Boundaries

- Status: Accepted
- Date: 2026-03-04
- Owners: ComfyUI-Panorama-Stickers maintainers

## Context

`PanoramaStickers` に「外部入力ステッカー」を追加する試行で、以下の失敗が連続して発生した。

- `sticker_image` の画像解決先が安定せず、`LoadImage` だけ見えて他ノード画像が見えない。
- 画像の解決失敗時に、`bg_erp` や self-output、別の preview 保存先へ誤って落ちる実装が混入し、別画像が表示される。
- 外部入力画像を通常ステッカーとは別レイヤーで扱ったため、表示・選択・Reset・可視状態の責務が分裂した。
- `requestDraw()` 起点の常時同期を混ぜたことで、操作中に pose や visible が巻き戻る。
- 共通の画像解決ヘルパーに外部入力向けの特殊分岐を入れた結果、`PanoramaCutout` の `erp_image` など既存経路まで壊した。

特に問題だったのは、「外部入力画像の取得元」が最後まで 1 本に固定されず、
上流ノード探索・現在ノードの preview UI・既存 fallback が混在したことだった。

## Decision

1. 外部入力ステッカーの画像取得元は 1 本に固定する。
   - `PanoramaStickers.execute()` が `sticker_image` を受け取った時だけ、
     現在ノード自身の UI 出力へ専用キーで preview を保存する。
   - モーダル UI はその専用キーだけを読む。
   - 上流ノードの出力形式をフロントで推測して探し回らない。

2. 共通の画像解決ヘルパーに外部入力向けの特殊分岐を入れない。
   - `erp_image` / `bg_erp` / 通常 preview の解決経路は既存仕様を維持する。
   - 外部入力専用ロジックは、`sticker_image` 専用の狭い経路に閉じ込める。

3. 外部入力ステッカーの見た目と操作は、通常ステッカー経路に寄せる。
   - `state.stickers` 上の通常レコードとして扱う。
   - 画像本体だけを runtime/UI preview で差し込む。
   - 別 draw path、別 selection path、別 reset path を作らない。

4. 同期はイベント駆動のみとし、draw loop に状態更新を入れない。
   - 許可する契機:
     - editor open
     - connection change
     - node executed
   - `requestDraw()` ごとの state 注入は禁止する。

## Consequences

- 利点
  - 画像の取得場所が明確になり、`LoadImage` だけ例外的に動く状態を避けやすい。
  - 外部入力対応が既存の `erp_image` / `bg_erp` 経路を壊しにくくなる。
  - UI の選択・変形・Reset が通常ステッカーと同じ責務にまとまる。

- トレードオフ
  - 外部入力画像を表示するには、`PanoramaStickers` ノード自身の実行結果が必要になる。
  - 上流ノードの出力形式に依存した「その場の即時表示」は優先しない。

## Amendment 2026-03-11

- `PanoramaStickers.execute()` が `bg_erp` を受け取った場合も、現在ノード自身の `pano_input_images` を modal 背景 preview の一次ソースとして扱う。
- これは external sticker 専用経路を背景へ広げるという意味ではなく、既存の panorama input preview を modal が正しく再利用する、という整理である。
- linked `IMAGE` 解決は従来どおり維持するが、linked output が `nodeOutputs.images` ではなく `nodeOutputs.ui.images` に出るノードもあるため、同一 output slot の候補として `ui.images` も解決対象に含める。
- ただし `sticker_image` と `bg_erp` を相互代用してはならず、preview key の責務は分離したままにする。

## Non-Goals

- 上流ノードのあらゆる `IMAGE` 出力形式をフロントエンドだけで一般解決すること。
- Autogrow / DynamicSlot / `addInput` / `removeInput` による入力増殖。
- 外部入力専用の別オーバーレイ描画モデルを維持すること。

## Guardrails

- `sticker_image` の表示画像は、現在ノード自身の専用 preview キー以外から取得しない。
- 外部入力向けの fallback を、共通 `IMAGE` 解決ヘルパーへ混ぜない。
- `bg_erp` と `sticker_image` を相互代用しない。
- `requestDraw()` / animation frame / pointer move の中で external sticker state を再生成しない。
- 既存ノード (`PanoramaCutout`, `PanoramaPreview`) の画像解決経路に影響する変更は、外部入力専用経路へ分離して実装する。

## Why This ADR Exists

今回の失敗は、単一のバグではなく「責務の境界を曖昧にしたまま機能追加を進めた」ことによる再発だった。

次回の実装では、まず

- 画像はどこから読むか
- state はいつ更新してよいか
- どこまでを通常ステッカー経路へ乗せるか

を固定し、その境界を越える fallback や便利実装を入れないことを、この ADR の目的とする。
