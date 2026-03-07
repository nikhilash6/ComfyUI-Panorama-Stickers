# Panorama Paint Rebuild 要件定義

この文書は、`PanoramaStickers` / `PanoramaCutout` のペイント再設計について、Codex が迷わず順番に実装できるようにするための要件定義である。

重要:

* この文書は **実装順を固定する**。
* Codex は **チェックリストを上から順に実装** すること。
* 後ろの項目を先回りして作らないこと。
* UI の見た目だけ合わせて内部を曖昧にしないこと。
* まず **座標系 / データモデル / トランザクション単位** を固め、その後に UI を載せること。

---

## 0. 前提となる製品判断

### 0-1. ノードは統合しない

`PanoramaStickers` と `PanoramaCutout` は、公開ノードとしては **分けたまま** にする。

理由:

* 2つはユーザーの頭の中で役割が違う
* 統合しても内部モード分岐が必要なら、単一ノード化の利益が薄い
* 公開I/Oを無理に揃えるとノードが肥大化して分かりにくい
* モーダルUIで主役にしたい操作が違う

### 0-2. ただし内部実装は共有してよい

共有してよいもの:

* 共通モーダル基盤
* 共通ビューポート処理
* 共通レンダリング補助
* 共通ペイントエンジン
* 共通座標変換
* 共通 Undo/Redo
* 共通ブラシ管理
* 共通 state 正規化

分けるべきもの:

* 公開ノード契約
* ノードごとの主役アクション
* 見せるタブ
* 強調する左メニュー項目
* ノード固有の用語と導線

---

## 1. 今回の目的

今回の目的は、消えてしまった旧ペイント実装を前提にせず、**根本から作り直す** ことである。

今回の再設計で達成すること:

1. すべての対象ビューで一貫したペイント体験を作る
2. `PanoramaStickers` と `PanoramaCutout` の UX を分ける
3. paint / mask の実体を明確化する
4. panorama / unwrap / frame の座標関係を定義する
5. ラスタ画像の再投影ではなく、**ストローク幾何の再投影** を採用する
6. Undo/Redo / Clear All の作用範囲とトランザクション単位を明確化する

今回の目的ではないもの:

* 完全なベクターエディタ化
* Illustrator 的なパス編集
* GPU 専用設計への最適化
* 任意の複数要素グループ化UI
* レイヤーシステム全体の導入

---

## 2. 用語定義

### 2-1. View

ユーザーが見ている画面の種類。

* `panorama view`: 球面投影されたパノラマ表示
* `unwrap view`: ERP の平面展開表示
* `frame view`: `Cutout` のフレーム単位の平面表示

### 2-2. Target Space

ストロークが属する座標空間。**source of truth は view ではなく target space に属する。**

* `ERP_GLOBAL`: パノラマ全体に属する座標空間
* `FRAME_LOCAL(frameId)`: 特定フレームに属するローカル座標空間

### 2-3. Layer Kind

* `paint`: RGBA の描画レイヤー
* `mask`: 専用のマスクレイヤー

### 2-4. Tool Kind

共通ツール:

* `cursor`
* `paint`
* `mask`
* `image_add`
* `clear_all`
* `undo`
* `redo`

ペイント系の詳細ツール:

paint:

* `pen`
* `marker`
* `brush`
* `eraser`
* `lasso_fill`

mask:

* `pen`
* `eraser`

### 2-5. Transaction / Action Group

Undo/Redo の最小単位。

例:

* 1回のストローク
* 1回の塗りつぶし
* 画像追加1回
* フレーム追加1回
* Clear All 1回

内部的に複数セグメントへ分割されても、**ユーザーの1操作は1 transaction** として扱う。

---

## 3. UI 全体方針

## 3-1. 共通左縦ツールバー

全タブ共通で、現在のフッターメニューを **キャンバス左側の縦メニュー** に移す。

上から順に:

1. カーソル
2. ペイント
3. マスク
4. 画像追加
5. Clear All
6. Undo
7. Redo

注意:

* 手のひらツールは **導入しない**
* パン操作は別ショートカットや既存操作で行うならそれでよい
* 左バーは共通骨格だが、ノードごとの強調は変えてよい

## 3-2. 下部ツールバー

### paint ツール選択時のみ表示

左から:

1. ペン
2. マーカー
3. ブラシ
4. 消しゴム
5. ドラッグ範囲塗りつぶし
6. 投げ縄塗りつぶし
7. ペンサイズスライダー
8. 色選択

   * 緑
   * 赤
   * 青
   * 白
   * 黒
   * カラーホイール
   * スポイト
   * 透明度

### mask ツール選択時のみ表示

左から:

1. ペン
2. 消しゴム
3. ドラッグ範囲塗りつぶし
4. ペンサイズスライダー

## 3-3. サイズ記憶

サイズは **ツールごとに別保存** とする。

例:

* pen のサイズ
* marker のサイズ
* brush のサイズ
* eraser のサイズ
* mask pen のサイズ
* mask eraser のサイズ

これらは互いに上書きしない。

## 3-4. Clear All

`Clear All` は本当に **すべて消す** ボタンとして扱う。

対象:

* 現在のノード内の paint データ全体
* 現在のノード内の mask データ全体
* ERP 側 / frame 側を含む全対象

ただし:

* 必ず確認ダイアログを出す
* 1 transaction として履歴に積む
* Undo で復元可能にする

## 3-5. Undo / Redo

* 履歴は **グローバル action history** とする
* paint / mask ごとに別履歴にはしない
* ノード内の編集操作は1本の履歴列に積む

理由:

* ユーザー視点では「さっきやったことを戻す」が自然
* paint と mask で履歴が分かれると直感に反する

---

## 4. ノードごとの UX 分岐

## 4-1. PanoramaStickers

`PanoramaStickers` は **画像を配置・調整する道具** として見せる。

要件:

* 左バーの `画像追加` を少し強調する
* frame 操作を主役として見せない
* frame タブは持たない
* 画像追加系導線を明確にする

## 4-2. PanoramaCutout

`PanoramaCutout` は **フレームを作り、切り出し・調整する道具** として見せる。

要件:

* 左メニューに `フレーム追加` を追加する
* `画像追加` は `Stickers` ほど目立たせない
* `frame tab` を持つ
* `frame tab` は `Cutout` のみ

### frame tab の活性条件

* フレームが 0 件のとき: 非アクティブ
* フレームを1件以上作成した後: 使用可能
* フレームが再び 0 件になったら: 非アクティブへ戻す

### Frame 追加直後

* frame 追加時のみ `frame tab` をアクティブにしてよい
* 追加したフレームの編集へ自然に遷移する

---

## 5. Freeform / Affinity 的 UX の定義

ここでいう「Freeform 的 UX」は、**無限キャンバス上で操作は継続するが、描画結果の見せ方は対象ごとに明確に制御される** ことを意味する。

完全な Apple Freeform の再現を目的にはしないが、次の感覚を満たすこと:

* 操作中に不自然にロックされない
* ビュー外 / 画像外に出ても入力が破綻しない
* ただし描画結果は対象ルールに従って綺麗に制御される

## 5-1. panorama / unwrap

* panorama と unwrap は、同じ `ERP_GLOBAL` 実体を別ビューで見ているだけ
* どちらで描いても同じ ERP に作用する
* view 切り替えは見え方の切り替えであり、別データではない

## 5-2. frame view

`frame view` は `FRAME_LOCAL(frameId)` を編集する。

Affinity のアートボードに近い挙動として、以下を満たすこと:

* ポインタ移動やストローク入力はフレーム外でも連続してよい
* ただし描画結果は **フレーム矩形で完全にクリップ** される
* クリップは直線矩形であること
* クリップのためにペン挙動そのものを止めたり折ったりしないこと

つまり:

* 入力は連続
* 描画結果だけが矩形で切られる

## 5-3. group 処理の定義

このフェーズでは、ユーザー向けの高度な任意グループUIは作らない。

ただし、内部的に次の「グループ」は厳密に扱うこと。

### a. action group

1回のユーザー操作が複数内部要素に分割されても、Undo/Redo 上は1つとして扱う。

例:

* ERP のシームをまたいで内部的に2セグメントに分かれた1ストローク
* frame の外まで引いたが、描画時に矩形クリップされた1ストローク
* lasso のプレビューと commit

### b. target group

ストロークは必ず1つの target space に属する。

* ERP_GLOBAL
* FRAME_LOCAL(frameId)

1つのストロークが複数 target に同時所属してはならない。

### c. render group

表示時には、現在の view に応じて複数 target のストロークが再投影されうる。

ただし source of truth は target 側であり、表示都合の合成結果を真実にしてはならない。

---

## 6. 座標系の設計

## 6-1. 基本原則

**view 座標は保存しない。**

保存してよいのは次のみ:

* `ERP_GLOBAL` 用の座標
* `FRAME_LOCAL(frameId)` 用の座標

ズームやパンや表示切り替えで壊れないことを優先する。

## 6-2. screen/view 座標

これは一時的な入力用。

用途:

* pointer event 取得
* hover 判定
* 一時プレビュー
* hit test

永続化禁止。

## 6-3. ERP_GLOBAL の保存座標

panorama / unwrap 共通の source of truth は `ERP_GLOBAL` に置く。

最低要件:

* 正規化 ERP 座標 `u,v` を持つ
* `u,v` は `[0,1]` 基準

推奨:

* 内部補助として球面方向ベクトルや seam-safe な補助表現を使ってよい
* ただし公開データモデルの基本概念は `ERP_GLOBAL` として統一する

### ERP シーム要件

* `u=0` と `u=1` を跨ぐストロークで破綻しないこと
* 必要なら内部的にセグメント分割してよい
* ただし 1 transaction のまま扱うこと

## 6-4. FRAME_LOCAL の保存座標

`frame view` の source of truth は `FRAME_LOCAL(frameId)` に置く。

最低要件:

* フレーム矩形に対するローカル正規化座標を持つ
* 座標系は frame 内の 2D 平面

推奨:

* `x,y` は frame 基準の正規化座標 `[0,1]`
* frame の向き・FOV・投影情報は frame 定義側で持つ

## 6-5. view 切り替え時の原則

切り替え時に行うのは **ストローク幾何の座標変換** である。

やってはいけないこと:

* 完成済みラスタ画像をそのまま別空間へ座標変換すること
* view 切り替えのたびに既存ピクセルを再変形すること

理由:

* 劣化する
* ぼやける
* 消しゴム / マスクの一致が崩れる

正しい順序:

1. source target のストローク幾何を取り出す
2. 現在 view に必要な座標空間へ変換する
3. 変換後の path に対して、その view でブラシ描画する

---

## 7. ペイントエンジンの設計

## 7-1. source of truth

source of truth は **ストローク記録** である。

追加固定:

* source of truth は **完成ラスタではない**
* source of truth は `ERP_GLOBAL` / `FRAME_LOCAL(frameId)` の **stroke geometry**
* view は stroke records を表示するだけであり、view 側の描画結果を真実にしない

## 7-2. cache 階層

correctness を優先しつつ、将来の最適化余地を残すため、少なくとも責務を次の 3 層に分ける。

1. source of truth

   * durable な stroke records

2. native target-space raster cache

   * `ERP_GLOBAL` は ERP 上にまず安定した線として描く
   * `FRAME_LOCAL(frameId)` は frame-local 上にまず安定した線として描く
   * paint / mask は完全分離

3. projected view cache

   * panorama / unwrap / frame / preview の各 view に見せるための投影表示
   * target-space raster または stroke geometry を元に、その view 用の表示だけを作る

重要:

* `frame-native raster` を `ERP_GLOBAL` の真の paint データとして再保存してはいけない
* frame の位置だけ変わった場合、`FRAME_LOCAL` の native raster は再生成せず、projected view cache だけ invalid にしてよい
* まずは correctness と表示安定性を優先し、速度最適化は後段でよい

ラスタキャッシュは持ってよいが、真実ではない。

つまり:

* 保存本体 = stroke records
* 高速表示用 = derived raster cache

## 7-2. Stroke Record

各 stroke は少なくとも次を持つこと。

```ts
type StrokeRecord = {
  id: string
  actionGroupId: string
  targetSpace: {
    kind: "ERP_GLOBAL"
  } | {
    kind: "FRAME_LOCAL"
    frameId: string
  }
  layerKind: "paint" | "mask"
  toolKind: "pen" | "marker" | "brush" | "eraser" | "lasso_fill"
  brushPresetId: string | null
  color: { r:number, g:number, b:number, a:number } | null
  size: number
  opacity: number
  hardness: number | null
  flow: number | null
  spacing: number | null
  points: StrokePoint[]
  closed: boolean
  createdAt: number
}
```

`StrokePoint` は少なくとも target-local の位置と時間順序を持つこと。

## 7-3. ブラシ設計方針

ペン / マーカー / ブラシの違いは、単なる透明度差ではなく、**ブラシ形状と描画則の差** として扱う。

重要:

* 「透明度が違うだけ」は不可
* 透明度は色設定でも変えられるため、それだけではツール差にならない

### 最低限の意味付け

#### pen

* 硬めの輪郭
* 安定した線
* 筆圧未対応でもよい
* 比較的 spacing 小さめ

#### marker

* マーカーらしい塗り重ね感
* 端が少し柔らかい
* pen より面感がある
* 単なる alpha 低下だけにしない

#### brush

* ソフトな輪郭
* pen / marker より柔らかい塗り
* 面で馴染む

#### eraser

* 現在 layer を削る
* paint では alpha を削る
* mask では mask 値を消す

実装上はブラシスタンプ画像や preset 定義で差を出してよい。

## 7-4. mask の扱い

mask は paint と混ぜない。

* paint は RGBA 描画レイヤー
* mask は mask 専用レイヤー

mask 側のツール:

* pen
* eraser

mask に marker / brush / lasso_fill はこのフェーズでは不要。

## 7-5. lasso_fill

paint 専用。

* pointer で閉じた自由形状を作る
* commit 時に内部を塗る
* 自動閉路でよい
* 1 transaction
* source of truth はラスタ領域ではなく、閉路 path と fill action として持つ

## 7-7. ストローク補間

* pointer 点列はそのまま生で使わず、適度に resample / smooth してよい
* ただし補間後も source target の座標で持つこと
* view 座標で補間して保存してはいけない

## 7-8. 表示とキャッシュ

高速化のため、次を持ってよい。

* ERP paint cache
* ERP mask cache
* frame 単位の paint cache
* frame 単位の mask cache

ただしルール:

* cache は derived data
* cache 破損時でも stroke records から再構築できること
* 別空間への表示で cache のピクセルを再変形しないこと

---

## 8. 空間間の変換ルール

## 8-1. panorama / unwrap

両者は同じ `ERP_GLOBAL` を見る。

したがって:

* unwrap で描いたものは panorama に現れる
* panorama で描いたものは unwrap に現れる
* これは別データの同期ではなく、同じ実体の別投影である

## 8-2. frame ↔ panorama / unwrap

`FRAME_LOCAL(frameId)` と `ERP_GLOBAL` は別 target だが、表示上は相互参照できる。

原則:

* frame 由来ストロークを panorama/unwrap に見せるときは、stroke geometry を ERP/view 側へ再投影する
* ERP 由来ストロークを frame に見せるときは、必要に応じて frame 側へ再投影する
* 完成ラスタを再投影しない
* point 単位で写してそのまま polyline 化しない
* 少なくとも segment 単位で扱い、adaptive subdivision、不連続判定、clip を入れる

### segment / discontinuity ルール

背面・shot 外・投影失敗・FOV 境界・大きな screen-space jump では、必ず segment を切る。

やること:

* adaptive subdivision
* discontinuity 判定
* clip
* invalid segment の破棄

やってはいけないこと:

* invalid point を含むまま polygon / ribbon 化すること
* 無効点を飛び越えて 1 本の線としてつなぐこと

### 保証するもの

* 完全な見た目一致ではない
* **同じ対応位置を通ること**
* **消しゴム / mask が同じ対応領域に作用すること**

### 保証しないもの

* 球面歪み込みの完全一致
* すべての view で同一ブラシ縁形状
* ピクセル単位の同一性

優先順位:

1. 作用範囲一致
2. 空間対応の一貫性
3. 見た目の近さ

---

## 9. モーダル内の振る舞い詳細

## 9-1. カーソルモード

* 既存の選択・移動・調整と共存
* paint/mask ツール時は描画優先
* cursor ツール時のみ通常のオブジェクト操作優先

## 9-2. paint モード

* 下部ツールバーに paint 用コントロールを出す
* 現在の view に応じた target 判定を行う
* panorama / unwrap では `ERP_GLOBAL`
* frame view では `FRAME_LOCAL(activeFrameId)`

## 9-3. mask モード

* 下部ツールバーに mask 用コントロールを出す
* 基本挙動は paint と同じ
* ただし layerKind は `mask`
* mask は paint の一部として混ぜない
* durable state でも raster cache でも完全独立レイヤーとして扱う
* backend では最後の materialization 段階でのみ使う
* 色付きオーバーレイは UI 表示専用であり、mask の意味は常に白黒独立実体である

## 9-6. 線幅の定義

線幅の基準は **現在 view の screen px** ではなく、stroke が属する **target space 上の半径** である。

* `ERP_GLOBAL` なら ERP 上の基準太さ
* `FRAME_LOCAL(frameId)` なら frame-local 上の基準太さ

禁止:

* `FOV` 変更で source 側の線が勝手に細くなったり太くなったりすること
* 中心線だけ投影して fixed screen-width で描くこと

正しい扱い:

* source 側では「中心線 + 半径」を持つ stroke geometry として扱う
* view 側では、その基準半径を投影して見かけ太さを求める
* panorama 中央と周辺で見かけ幅が異なるのは正しい
* ただし source 半径が変わるのではなく、投影結果としてそう見えるだけである

## 9-7. sample 単位の太さ

1 ストローク 1 本の固定 screen 幅で描かない。

各 sample 点ごとに:

* 局所接線
* 局所法線
* source 半径

を持ち、target view での見かけ半径を計算して stroke を描くこと。

これにより:

* `FOV` 変更時の線幅破綻
* panorama 中央/周辺での見かけ幅差
* shot/view 差による太さ崩れ

を防ぐ。

## 9-8. raw input / processed stroke

将来の手ぶれ補正と疑似筆圧に備えて、`x,y,t` の生入力だけを最終形にしない。

少なくとも次を分ける:

* raw input points
* processed/render points

ルール:

* `t` は必須維持
* 将来 `widthScale` / `pressureLike` を点ごとに持てる余地を残す
* 速度ベースの線幅変化や smoothing は raster 後ではなく stroke geometry 段階で処理する

## 9-9. 線品質の責務分離

今の簡易 ribbon 実装を商用品質の前提にしない。

少なくとも線品質改善では、次を責務として分けて考える:

* 入力補正
* resample
* width smoothing
* join / cap
* coverage / AA

注意:

* 「点列をそのまま太く塗る」だけでは商用品質に届かない
* `freehand line` / `rect fill` / `lasso fill` を同じ描画経路に無理やり押し込まない

## 9-4. image_add

### Stickers

* 目立たせる
* 主役ボタン扱い

### Cutout

* 存在してよいが、主役にしない

## 9-5. frame_add

`Cutout` のみに存在。

* 左バーに置く
* 追加後、自然に frame 編集へ導く
* 必要なら frame tab へ遷移する

---

## 10. 履歴・トランザクション設計

## 10-1. 1操作 = 1履歴

以下はすべて 1 action group。

* 1本の筆描き
* 1回の消しゴムストローク
* 1回の矩形塗り
* 1回の lasso fill
* 1回の image add
* 1回の frame add
* 1回の Clear All

## 10-2. 内部多段処理の扱い

たとえば:

* seam 跨ぎで内部的に複数 segment へ分割
* frame clipping 用の内部処理
* preview path と commit path の二段階

これらがあっても、Undo/Redo では1つとして扱う。

## 10-3. Clear All の履歴

* 必ず巻き戻せること
* Undo で全復元できること
* Redo で再消去できること

---

## 11. Codex 実装方針

Codex は次の順で作ること。

### 絶対ルール

* 先に UI を増やしてから内部を考えない
* 先に座標系と target space を作る
* 先に action group を作る
* 既存コードを継ぎ足しで無理やり延命しない
* source of truth と cache を混同しない

---

## 12. 実装チェックリスト（順番固定）

### Phase 1: target space とデータモデル確定

* [ ] `ERP_GLOBAL` と `FRAME_LOCAL(frameId)` の概念を導入する
* [ ] view 座標を永続化しないルールを明文化する
* [ ] `StrokeRecord` と `StrokePoint` の型を定義する
* [ ] `layerKind` / `toolKind` / `actionGroupId` を含む最小モデルを作る
* [ ] 旧ペイント実装の断片依存を切る

完了条件:

* panorama / unwrap / frame のどれで描いても、保存先が target space で説明できる

### Phase 2: action group / history 基盤

* [ ] global undo/redo history を作る
* [ ] 1ストローク=1履歴 を保証する transaction API を作る
* [ ] Clear All を履歴化できるようにする
* [ ] seam 分割や clip 分割が1履歴にまとまる仕組みを入れる

完了条件:

* 「内部では複数処理、履歴では1回」が成立する

### Phase 3: 共通ペイントエンジン基盤

* [ ] source of truth を stroke records に固定する
* [ ] derived raster cache 層を別概念として切り出す
* [ ] paint / mask を別レイヤーとして扱う
* [ ] ブラシ preset の差分を shape/描画則で表現できる構造にする

完了条件:

* 「保存本体」と「表示用キャッシュ」が分離されている

### Phase 4: ERP_GLOBAL の native 描画

* [ ] unwrap 上で `ERP_GLOBAL` へ描けるようにする
* [ ] panorama 上で同じ `ERP_GLOBAL` を描けるようにする
* [ ] unwrap と panorama が同じ実体を見ていることを確認する
* [ ] ERP seam 跨ぎ処理を入れる

完了条件:

* unwrap で描いたものが panorama に現れ、その逆も成り立つ

### Phase 5: FRAME_LOCAL の native 描画

* [ ] frame-local stroke 保存を実装する
* [ ] frame view で native 描画できるようにする
* [ ] frame 外まで入力してもストローク処理が継続するようにする
* [ ] ただし描画結果は矩形クリップされるようにする

完了条件:

* Affinity 的な「入力は続くが、結果だけ矩形クリップ」が成立する

### Phase 6: 空間間再投影

* [ ] frame 由来 stroke を panorama/unwrap に再投影表示できるようにする
* [ ] ERP 由来 stroke を frame 側へ必要に応じて再投影表示できるようにする
* [ ] ラスタ再投影をしていないことを確認する

完了条件:

* 見た目は多少違っても、同じ対応領域に作用している

### Phase 7: 基本ツール実装

* [ ] paint pen
* [ ] paint marker
* [ ] paint brush
* [ ] paint eraser
* [ ] mask pen
* [ ] mask eraser
* [ ] lasso_fill（paint のみ）

完了条件:

* paint/mask 基本機能が全 target で動く

### Phase 8: UI 共通骨格

* [ ] 左縦ツールバーへ移行する
* [ ] 共通順序を守る
* [ ] paint 選択時だけ paint footer を出す
* [ ] mask 選択時だけ mask footer を出す
* [ ] ツール別サイズ記憶を入れる
* [ ] 色UIにプリセット + ホイール + スポイト + 透明度を入れる

完了条件:

* ツール選択と下部コントロール表示の規則が一貫する

### Phase 9: ノード別 UX 分岐

* [ ] Stickers で image_add を強調する
* [ ] Stickers に frame tab を出さない
* [ ] Cutout に frame_add を追加する
* [ ] Cutout に frame tab を持たせる
* [ ] frame 0件時は frame tab を非アクティブにする
* [ ] frame 追加直後の遷移を自然にする

完了条件:

* 一目で Stickers と Cutout の役割差が分かる

### Phase 10: Clear All / 確認ダイアログ / 最終履歴確認

* [ ] Clear All の確認ダイアログを実装する
* [ ] 本当に全 target / 全 layer が消えることを確認する
* [ ] Undo/Redo で完全復元できることを確認する

完了条件:

* Clear All が安全かつ強力に機能する

### Phase 11: 仕上げ

* [ ] 不要な旧ペイント経路を整理する
* [ ] target space の説明とコメントを残す
* [ ] source of truth / cache / reprojection の責務をコードコメントで固定する
* [ ] view 座標永続化が残っていないか確認する

完了条件:

* 実装が継ぎ足しではなく、次に拡張できる構造になっている

---

## 13. 受け入れ条件

次が満たされていれば受け入れ可能。

### 13-1. 共通

* どの view でも左縦バーから paint / mask を選べる
* paint / mask で footer 内容が切り替わる
* Undo/Redo が一貫している
* Clear All に確認がある

### 13-2. panorama / unwrap

* 同じ ERP 実体を共有する
* 一方で描いた内容が他方で見える
* seam で極端な破綻がない

### 13-3. frame

* frame 外へカーソルが出ても不自然に停止しない
* ただし描画は矩形で綺麗に切られる
* frame 由来の編集が他 view でも対応位置に見える

### 13-4. 消しゴム / mask

* 見た目完全一致は不要
* ただし同じ領域に作用している感覚がある
* 「同じところが消える」が守られる

### 13-5. ノード差

* Stickers は画像追加の道具として分かる
* Cutout はフレーム作成・編集の道具として分かる
* 片方の都合で他方のUIが濁っていない

---

## 14. 禁止事項

Codex は以下をしてはいけない。

* view 座標を保存する
* 完成済みラスタ画像を別空間へ再投影して source of truth 扱いする
* paint と mask を同じ内部実体として雑に混ぜる
* 1操作を複数 Undo 項目に割る
* node 統合のために公開 UI を無理に揃える
* 旧ペイント経路にさらに場当たり的 if を足す

---

## 15. 実装後にコードへ残すべき説明

以下はコメントとしてコードに残すこと。

1. `panorama / unwrap` は同じ `ERP_GLOBAL` を共有している
2. `frame view` は `FRAME_LOCAL(frameId)` を編集している
3. source of truth はストロークであり、cache ではない
4. view 切り替えでは stroke geometry を再投影する
5. Clear All は全 target / 全 layer を消す
6. 1ユーザー操作 = 1 action group である

---

## 16. 最後に

今回の再設計の核心は、ブラシの見た目より先に、**どの空間のどこに何が作用したか** を明確にすることである。

優先順位は次の通り。

1. target space の明確化
2. source of truth の明確化
3. action group の明確化
4. view 間の一貫性
5. その後にブラシ表現とUIの洗練

