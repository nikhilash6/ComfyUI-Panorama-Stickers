そのまま Codex に渡せます。

````markdown
今回は「中間実装」ではなく、最終実装まで耐えられる骨格として組み直してください。
場当たり的な改善や、後で捨てる前提の仮実装は避けてください。

目標は次です。

- `PanoramaStickers` / `PanoramaCutout` の paint system を、最終構造に近い形で作る
- frame / panorama / unwrap の整合性を維持する
- ただし編集中の描き味を最優先し、cross-view の都合で editing view を壊さない
- source of truth は durable に残す
- paint と mask は完全独立レイヤーとして扱う
- 後で variable width / smoothing / pseudo pressure / 高品質 brush へ拡張できる構造にする

## 1. 絶対方針

### 1-1. 公開ノードは分ける
公開ノードは統合しない。

- `PanoramaStickers`
- `PanoramaCutout`

内部実装は共有してよいが、公開I/OとUXは分けること。

### 1-2. editing view と cross-view を分離する
ここが最重要。

- **editing target では native raster を主役にする**
- **cross-view は従属表示にする**
- active editing 中の view に projected geometry を直接使わない
- `pointerup` で形が変わる実装にしない
- drag 中と commit 後で見た目が別物になる構造を禁止する

つまり、

- ERP を編集中なら ERP native painting engine
- frame を編集中なら frame-local native painting engine
- 他 view は projected overlay / projected cache

にすること。

### 1-3. source of truth は stroke records
完成ラスタを source of truth にしない。

- durable source of truth = `state_json.painting`
- durable に保存するのは stroke records
- undo / redo stack は ephemeral only
- raster cache は derived data only

## 2. 最終アーキテクチャ

実装は次の2系統に分ける。

### A. Editing Engine
責務:
- native target-space での快適な描き味
- raw input -> processed centerline -> rasterization
- drag 中も commit 後も同じ描画エンジン
- low latency
- paint / mask の independent rendering

### B. ERP / Frame Integration
責務:
- ERP seam handling
- frame ↔ ERP / unwrap の cross-view 表示
- projected overlay / projected cache
- frame pose 変更時の invalidation
- backend materialization

A と B を混ぜないこと。
A を壊して B を成立させようとしないこと。

## 3. データモデル

### 3-1. durable 保存先
`state_json.painting`

例:

```ts
type PaintingState = {
  version: 1
  strokes: StrokeRecord[]
}
````

### 3-2. StrokeRecord

単一万能型にしない。判別可能な geometry を持つこと。

```ts
type StrokeRecord =
  | FreehandStrokeRecord
  | RectFillStrokeRecord
  | LassoFillStrokeRecord
```

共通項目:

```ts
type StrokeCommon = {
  id: string
  actionGroupId: string
  targetSpace:
    | { kind: "ERP_GLOBAL" }
    | { kind: "FRAME_LOCAL"; frameId: string }
  layerKind: "paint" | "mask"
  geometryKind: "freehand" | "rect_fill" | "lasso_fill"
  brushId: string
  color: { r:number; g:number; b:number; a:number } | null
  baseSize: number
  opacity: number
  createdAt: number
}
```

freehand は少なくとも rawPoints を durable に残すこと。

```ts
type RawPoint = {
  x: number
  y: number
  t: number
}
```

注意:

* `ERP_GLOBAL` の `x,y` は正規化 `u,v`
* `FRAME_LOCAL(frameId)` の `x,y` は frame 基準の正規化座標
* frame は 0..1 外の点も保存してよい
* view 座標は durable に保存しない

### 3-3. session 内の派生データ

durable ではなく session / render 用に持ってよい。

* `processedPoints`
* `projectedSamples`
* native raster cache
* projected overlay cache
* hover / selection / preview
* undo / redo stack

## 4. paint と mask

mask は paint の一部ではない。
完全独立レイヤーとして扱うこと。

* durable state でも分ける
* raster cache でも分ける
* rendering path でも分ける
* backend materialization でのみ各ノードが使い方を決める

意味:

* `paint`: RGBA の描画レイヤー
* `mask`: 白黒の独立レイヤー

UI 上の色付きオーバーレイは表示都合であり、mask の実体ではない。

## 5. Editing Engine の実装仕様

### 5-1. 最終構造

editing target ごとに、少なくとも次のレイヤー構造を持つこと。

* `committedPaintCanvas`
* `committedMaskCanvas`
* `currentStrokeCanvas`

必要なら viewport 表示用キャンバスを分けてよいが、
少なくとも「確定済み」と「現在のストローク」は分離すること。

### 5-2. 入力処理

* `PointerEvent` を使う
* `setPointerCapture` を使う
* 使える環境では `getCoalescedEvents()` を使う
* `pointermove` で重い処理をしない
* 描画更新は `requestAnimationFrame` ベース
* `pointerup` は `window` 側でも拾ってドラッグアウトに耐える

### 5-3. active stroke の原則

* drag 中も commit 後も、同じ描画エンジン・同じ smoothing 経路を使う
* `pointerup` 時に線形状が変わらないこと
* commit 時は「見た目を描き直す」のではなく「同じ結果を committed layer に merge する」こと

### 5-4. smoothing / geometry pipeline

構造はこの3段階に固定する。

* `rawPoints`
* `processedPoints`
* `projectedSamples`（cross-view 用のみ）

まず fixed-width freehand の質を出す。
疑似筆圧や variable width は後から足せる構造にするが、最初から複雑化しすぎない。

### 5-5. freehand Phase 1 の品質方針

最初の本命は次。

* raw input を受ける
* weighted smoothing または Catmull-Rom / quadratic Bezier 系で processed centerline を作る
* Canvas2D の `round cap / round join` を使う
* high-DPI を考慮する
* active stroke は currentStrokeCanvas で増分描画する
* 毎フレーム `new OffscreenCanvas(...)` を作らない
* 一時キャンバスは再利用する
* 全面再描画ではなく dirty rect を意識する設計にする

ここでの目標は「気持ちよく描ける固定幅 freehand」を native target-space で成立させること。

### 5-6. variable width への備え

今すぐ完成させなくてよいが、構造は備えること。

* `processedPoints` に `widthScale` などを持てるようにする
* 将来 `pressureLike` / speed-based width solve を足せるようにする
* durable は rawPoints 中心でよい
* session 内では processed geometry をキャッシュしてよい

### 5-7. geometryKind ごとの扱い

* `freehand`: rawPoints -> processedPoints -> native raster
* `rect_fill`: drag rectangle を preview し、commit で fill
* `lasso_fill`: freeform polygon を閉路化し、commit で fill
* geometryKind ごとに path 生成と rasterization を分けること

## 6. ERP / Frame 固有仕様

### 6-1. panorama / unwrap

* panorama と unwrap は同じ `ERP_GLOBAL` を見る
* どちらも同じ ERP native layer を別 view で見ているだけにする
* 片方で描いたものが他方に出ること

### 6-2. frame view

* frame view は `FRAME_LOCAL(frameId)` を編集する
* Affinity の artboard 的挙動にする
* pointer 入力は frame 外でも継続してよい
* ただし描画結果は frame rect で完全に clip
* 入力を止めない。描画結果だけを矩形で切る

### 6-3. frame から ERP への見せ方

frame 由来の内容を ERP タブに見せるときは、

* `FRAME_LOCAL` の source of truth から
* frame-native raster cache を作り
* それを ERP view 用に projected overlay として表示する

これを `ERP_GLOBAL` の真の durable データとして再保存しないこと。

### 6-4. frame pose 変更時

frame の位置や yaw/pitch/roll/FOV が変わったとき:

* frame-local strokes はそのまま
* frame-native raster cache もそのまま
* projected overlay cache だけ invalid
* ERP / panorama 側で再投影表示だけ更新

つまり、絵の中身は描き直さず、置き場所だけ変えて投影し直すこと。

### 6-5. ERP seam

ERP の左右継ぎ目は専用処理を持つこと。

* `Δu > 0.5` などの seam cross を検出する
* split して rasterize / project する
* 無効な segment を跨いで巨大 polygon を作らないこと

### 6-6. projected overlay の原則

cross-view 用 projected overlay では:

* segment 単位で扱う
* adaptive subdivision を入れる
* 背面 / shot 外 / 投影失敗 / 大ジャンプで segment を切る
* invalid point を含むまま polygon 化しない
* overlay は毎フレーム clear / restore を厳密に行う

editing target の描き味を支える主役に projected geometry を使わないこと。

## 7. backend materialization

### 7-1. PanoramaStickers

* `state_json.painting` を読み込む
* `paint` と `mask` は内部的に分離したまま扱う
* `cond_erp` へどう反映するかは backend adapter の責務とする
* mask を paint と混ぜて durable にしない

### 7-2. PanoramaCutout

* `rect_image` に paint を反映
* `mask` を別出力
* `sticker_state` は維持
* `FRAME_LOCAL` と必要な `ERP_GLOBAL` の寄与を cutout view に materialize する

## 8. performance 方針

今回は「後で捨てる軽量化」は不要だが、
**最終構造として重くなりにくい責務分離** は最初から入れること。

* active editing のレイテンシ最優先
* cross-view 更新は active editing をブロックしない
* preview / side panel / history serialization を pointermove の主経路に載せない
* 一時キャンバスや offscreen は再利用する
* 可能なら dirty rect
* 可能なら worker 化の余地を残す
* ただし Phase 1 から WebGL / WebGPU brush engine へ逃げない
* まず Canvas2D native editing engine で「描き味」を成立させる

## 9. 実装順

今回は中間実装ではなく、最終構造にそのまま繋がる順序で進めること。

### Step 1

Editing Engine の骨格を入れる。

* raw / processed / projected の分離
* committedPaint / committedMask / currentStroke の分離
* PointerEvent + coalesced events + rAF
* drag 中と commit 後で見た目が変わらない構造

### Step 2

fixed-width freehand を native target-space で成立させる。

* ERP native editing
* frame native editing
* round cap / join
* smoothing
* incremental current stroke rendering
* pointerup で形が変わらないこと

### Step 3

paint / mask 独立レイヤーを完成させる。

* paint tool
* mask tool
* eraser
* rect fill
* lasso fill

### Step 4

ERP / frame integration を入れる。

* panorama / unwrap 共有
* frame view clipping
* seam handling
* frame → ERP projected overlay
* ERP → frame projected overlay
* frame pose invalidation

### Step 5

backend materialization を入れる。

* Stickers -> cond_erp
* Cutout -> rect_image + mask

### Step 6

その後でのみ variable width / pseudo pressure / 高品質 brush を足す。

## 10. 禁止事項

* projected geometry を editing target の主描画経路に使うこと
* `pointerup` で線の形が変わること
* paint と mask を混ぜること
* view 座標を durable 保存すること
* 一時オフスクリーンを毎 move で new すること
* cross-view 同期のために active editing を重くすること
* geometryKind を単一型に押し込むこと
* `FRAME_LOCAL` の中身変更と frame pose 変更を同じ invalidation にすること

## 11. 完了条件

最低限ここまで到達したら、この骨格は採用してよい。

* active editing 中に「ペイントツールを使っている感じ」がある
* drag 中と pointerup 後で形が変わらない
* fixed-width freehand がカクカクしすぎない
* frame / ERP / unwrap の整合性が保たれる
* frame pose 変更で中身を再ラスタライズしない
* paint / mask が独立レイヤーとして成立している
* projected overlay が editing feel を壊していない

要するに、今回は
「cross-view 整合性のための幾何」を主役にするのではなく、
「描いている面の native raster を主役」にし、
その上で durable stroke records と projected overlays を従属させる最終骨格を作ってください。

```
```
