# Effect Invalidation

`compileEffect(...)` は `invalidate` を持てます。

```ts
const effect = compileEffect({
  input: backdropSource(),
  capturePadding: 96,
  invalidate: {
    kind: "on-source-damage-box",
    damagePadding: 96,
  },
  pipeline: [
    dualKawaseBlur({ radius: 4, passes: 3 }),
  ],
});
```

## Why It Lives On `compileEffect`

`invalidate` は `<ShaderEffect />` や `COMPOSITOR.effect.background_effect` の設定ではなく、
**effect 自体が source のどの変化に反応するか** を表します。

そのため、同じ effect を

- `<ShaderEffect />`
- `COMPOSITOR.effect.background_effect`

のどちらでも同じ意味で使えるように、`compileEffect(...)` 側で定義します。

## Supported Policies

### `always`

毎回再生成します。

```ts
invalidate: { kind: "always" }
```

### `manual`

source の更新では自動 invalidation しません。

```ts
invalidate: { kind: "manual" }
```

### `on-source-damage-box`

effect の表示領域を基準にした box と、source 側の damage box が交差した時だけ再生成します。

```ts
invalidate: {
  kind: "on-source-damage-box",
  damagePadding: 96,
}
```

## `damagePadding` とは

`damagePadding` は、effect の visible box の外側へ追加する invalidation 用の安全余白です。

これは UI や入力 texture の padding ではなく、**source damage の取りこぼしによる artifact を避けるための余白**です。

たとえば:

- blur
- refraction
- edge distortion
- `unit(...)` を含む nested effect
- shader 内で周辺 pixel を読む effect

では、見えている box の外側の source 変化も結果に影響します。

そのため `damagePadding` が小さすぎると、

- 下の window が端だけ更新された
- でも effect が dirty にならない
- 結果として blur / glass の端だけ古い内容が残る

という破綻が起こります。

逆に大きすぎると、不要な再生成が増えます。

## `capturePadding` との違い

`capturePadding` は visible box の周囲から実際に source pixel を追加で取り込みます。
パディング付き texture は pipeline の全 stage を通り、最後に一度だけ visible box へ
切り落とされます。blur や distortion が領域外の pixel を必要とする場合はこちらが必要です。

一方、`damagePadding` は damage の発火判定と再描画領域だけを広げます。入力 texture は
広がりません。多くの sampling effect では、両方に十分な値を指定します。

## Why ShojiWM Does Not Infer Them Automatically

ShojiWM は pipeline から `capturePadding` や `damagePadding` を自動推論しません。

理由:

- `dualKawaseBlur(...)` のような built-in stage だけでなく
- `shaderStage(...)`
- `blend(...)`
- `unit(...)`

まで含めると、pipeline 全体の sampling 範囲を正確に推論するのが難しいためです。

特に nested effect では、見た目の sampling 範囲と stage の並びが一致しないことがあります。

そのため、`compileEffect(...)` は black box として扱い、
**effect 作者が sampling 範囲と damage 範囲を指定する**方針にしています。

## Practical Guidance

### Simple tint / color adjustment only

```ts
invalidate: {
  kind: "on-source-damage-box",
  damagePadding: 0,
}
```

### Blur

blur の見た目に応じて、両方を十分大きめに取ってください。

```ts
capturePadding: 96,
invalidate: {
  kind: "on-source-damage-box",
  damagePadding: 96,
}
```

### Glass / distortion

blur より小さくてよいこともありますが、edge refraction があるなら余白が必要です。

```ts
capturePadding: 24,
invalidate: {
  kind: "on-source-damage-box",
  damagePadding: 24,
}
```

## Current Backend Behavior

`on-source-damage-box` では、

- effect の visible rect
- `damagePadding`

から damage query box を作り、
その box と source damage box が交差した時だけ cache を invalidation します。

これにより、

- unrelated source updates
- 下にあるが effect に影響しない damage

では cache reuse しやすくなります。
