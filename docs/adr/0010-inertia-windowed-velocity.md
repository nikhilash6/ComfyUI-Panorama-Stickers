# ADR 0010: パノラマドラッグ慣性の速度計算を時間窓方式に変更

## Status

Accepted

## Date

2026-03-10

## Context

パノラマビューをドラッグで回転させる際、「マウスを止めたままボタンを離す」操作をすると慣性が発生してしまうという UX 上の問題があった。

### 原因

旧実装では `moveDrag()` 内で EMA（指数移動平均）を使って速度を蓄積していた。

```js
state.inertia.vx = state.inertia.vx * 0.4 + (dYaw / dt) * 0.6;
```

EMA は「過去の速度を記憶する」構造であるため、マウスが止まっても `moveDrag` が呼ばれなくなるだけで速度は保持され続ける。`endDrag()` はその蓄積された速度をそのまま慣性の初速に使うため、止めて離しても慣性が発動していた。

## Decision

`moveDrag()` で直近 100ms の位置履歴（`{ ts, yaw, pitch }`）をリングバッファとして保持する。`endDrag()` では直近 80ms 以内のサンプルのみを使って速度を算出する。

```
velocity = Δposition / Δtime  (直近 80ms 以内のサンプルの first → last)
```

サンプルが 2 点未満（= 80ms 以内に動きがない）の場合は速度 = 0 → 慣性なし。

### メリット

- 「止めて離す」で正確に停止する（EMA の記憶効果がない）
- 速い動きの慣性は従来通り正しく計算される
- iOS / Android の標準的なスクロール慣性と同じアルゴリズム

## 変更ファイル

- `web/pano_interaction_controller.js` — `state.velHistory`、`moveDrag()`、`endDrag()` を変更
- `web/pano_editor_core.js` — 同等の変更（レガシー互換用コピー）
