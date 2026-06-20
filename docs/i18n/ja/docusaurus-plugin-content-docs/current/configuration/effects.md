---
sidebar_position: 10
---

# エフェクト

ShojiWM は GPU シェーダーエフェクトを4箇所で実行でき、`COMPOSITOR.effect` で設定します。

| フィールド | 型 | 適用先 |
| --- | --- | --- |
| `background_effect` | `CompiledEffectHandle \| null` | 全ウィンドウの下のフルスクリーン背景 |
| `window` | `(window) => WindowEffectAssignment \| null` | トップレベルウィンドウごと |
| `layer` | `(layer) => LayerEffectAssignment \| null` | レイヤーシェルサーフェスごと（バー・ドック） |
| `popup` | `(popup) => PopupEffectAssignment \| null` | ポップアップごと（メニュー・ツールチップ） |

合成内の領域にエフェクトを適用することもできます
（[`<ShaderEffect/>`](./components.md#shadereffect)）。

## 背景エフェクト

すべての背後に描画されるコンパイル済みエフェクトを割り当てます。`null` で無効化。

```ts
import {COMPOSITOR, compileEffect, backdropSource, dualKawaseBlur} from 'shoji_wm';

COMPOSITOR.effect.background_effect = compileEffect({
  input: backdropSource(),
  invalidate: {kind: 'on-source-damage-box', antiArtifactMargin: 8},
  pipeline: [dualKawaseBlur({radius: 4, passes: 2})],
});
```

## ウィンドウ／レイヤー／ポップアップごとのエフェクト

各ファクトリーはサーフェスごとに呼ばれ、割り当てを返すか、エフェクト無しなら
`null`／`{}` を返します。レイヤーとポップアップの割り当ては `behind` を使って
サーフェスの背後にエフェクトを描画します（デフォルト設定はバーやメニューの背後を
すべてぼかします）。

```ts
const LAYER_BLUR = compileLayerEffect({
  input: backdropSource(),
  alpha: 'preserve',
  pipeline: [dualKawaseBlur({radius: 4, passes: 2})],
});

COMPOSITOR.effect.layer = (layer) => {
  if (layer.namespace() === 'no_blur') return {};
  return {behind: LAYER_BLUR};
};

COMPOSITOR.effect.popup = (popup) => {
  if (popup.parentKind === 'window') return {};
  return {behind: POPUP_BLUR};
};
```

## エフェクトを組み立てる

エフェクトは **ソース入力＋ステージのパイプライン**です。使う場所に応じたコンパイル
関数でコンパイルします。

| コンパイラ | 生成物 | 用途 |
| --- | --- | --- |
| `compileEffect(opts)` | `CompiledEffectHandle` | 背景・`<ShaderEffect/>` |
| `compileWindowEffect(opts)` | `WindowEffectHandle` | `COMPOSITOR.effect.window` |
| `compileLayerEffect(opts)` | `LayerEffectHandle` | `COMPOSITOR.effect.layer` |
| `compilePopupEffect(opts)` | `PopupEffectHandle` | `COMPOSITOR.effect.popup` |

オプション:

| オプション | 型 | 意味 |
| --- | --- | --- |
| `input` | ソースハンドル | パイプラインが読む対象（例: `backdropSource()`） |
| `pipeline` | ステージ配列 | 順に適用されるステージ |
| `invalidate` | ポリシー | 再描画のタイミング（下記参照） |
| `alpha` | `"opaque" \| "preserve"` | 透明度を表示まで維持（デフォルト `"opaque"`） |
| `outsets` | `EffectOutsets` | （ウィンドウエフェクト）ウィンドウ境界の外側に描画 |

### ソース

| ソース | 読み取る対象 |
| --- | --- |
| `backdropSource()` | 対象の背後に合成済みのシーン |
| `windowSource()` | ウィンドウ自身のサーフェス |
| `layerSource()` | レイヤーサーフェス自身の内容 |
| `popupSource()` | ポップアップ自身の内容 |
| `imageSource(path)` | 静的な画像ファイル |

### ステージ

| ステージ | 目的 |
| --- | --- |
| `dualKawaseBlur({radius, passes})` | 高速で広いブラー |
| `shaderStage(shader, {uniforms, textures})` | カスタム GLSL フラグメントシェーダーを実行 |
| `noise({...})` | フィルムグレイン風のノイズを追加 |
| `save(name)` / `blend(input, {...})` | 中間結果の保存／合成 |

`shaderStage` はシェーダー（パス、または `loadShader(path)` ハンドル）に加えて、
`uniforms`（シェーダーに渡す数値・色）と `textures`（名前で束縛する追加のソース
ハンドル）を取ります。

```ts
import {compileEffect, backdropSource, dualKawaseBlur, shaderStage, loadShader} from 'shoji_wm';

const liquidGlass = compileEffect({
  input: backdropSource(),
  invalidate: {kind: 'on-source-damage-box', antiArtifactMargin: 8},
  pipeline: [
    dualKawaseBlur({radius: 4, passes: 2}),
    shaderStage(loadShader('./src/liquid-glass.frag'), {
      uniforms: {
        glass_radius_px: 10.0,
        distortion_strength: 0.15,
        chromatic_shift_px: 3.0,
      },
    }),
  ],
});
```

### 無効化ポリシー

`invalidate` はエフェクトの再描画タイミングを制御し、新鮮さとコストのバランスを取ります。

- `{kind: 'on-source-damage-box', antiArtifactMargin: N}` — 変化した領域だけを、エッジの
  アーティファクトを避けるため `N` px 広げて再描画。通常はこれを選びます。
- `'always'` — 毎フレーム再描画（高コスト。アニメーションするシェーダー向け）。
- 自分で無効化を行う手動ポリシー。

### アルファ

パイプラインの出力が透明であるべき場合（例: レイヤー自身のアルファマスクでクリップした
ブラー）は `alpha: 'preserve'` を設定します。これにより透明度が不透明に強制されず、
表示パスまで維持されます。

---

## カスタムシェーダーを書く

組み込みステージだけでは足りないときは、自分で**フラグメントシェーダー**を書いて
`shaderStage` で実行できます。フラグメントシェーダーとは、領域の**ピクセルごとに1回**
GPU が実行する小さなプログラムで、そのピクセルの最終的な色を計算するのが役割です。
ShojiWM のシェーダーは **GLSL ES 1.00**（WebGL 1 / OpenGL ES 2.0 と同じ方言）で書き、
設定ファイルの隣の `.frag` ファイルに置きます。

:::tip[シェーダーは初めてですか？]
シェーダーを一度も書いたことがないと、「ピクセルごとに考える」という発想に慣れるまで
少し時間がかかります。次の入門サイトはどれもとても分かりやすいので、まず1つ読んでから
戻ってくると理解がスムーズです。

- [The Book of Shaders](https://thebookofshaders.com/) — もっとも易しい入り口
- [Shadertoy](https://www.shadertoy.com/) — ブラウザでライブに実験できる
- [Khronos GLSL ES クイックリファレンス](https://www.khronos.org/files/opengles_shading_language.pdf) — 組み込み関数一覧

ShojiWM 用に書く GLSL もまったく同じ言語です。違うのはエントリーポイントと、
あらかじめ用意されたいくつかの変数（後述）だけです。
:::

### `shader_main` の約束ごと

完全な GLSL プログラムを書くのではなく、**1つの関数**だけを書きます。

```glsl
vec4 shader_main(vec2 uv, vec2 rect_size) {
    // このピクセルの色を計算して返す
    return vec4(1.0, 0.0, 0.0, 1.0); // 不透明な赤
}
```

ShojiWM はコンパイル前に、あなたのファイルを次の前文（プリアンブル）で包みます。
そのため、これらを自分で書く必要はありません。

```glsl
#version 100
precision highp float;

uniform sampler2D tex;   // 入力ソース（例: 背景）
uniform vec2 rect_size;  // 領域のサイズ（ピクセル）
varying vec2 v_coords;   // `uv` として渡される

// ...ここにあなたのファイルが挿入される...

void main() {
    gl_FragColor = shader_main(v_coords, rect_size);
}
```

このおかげで、`shader_main` の中では次の組み込みが最初から使えます。

| 名前 | 型 | 意味 |
| --- | --- | --- |
| `uv`（第1引数） | `vec2` | 正規化座標 `0.0`〜`1.0`。領域全体にまたがり、`(0,0)` と `(1,1)` が対角のコーナー。 |
| `rect_size`（第2引数） | `vec2` | 領域のサイズ（ピクセル）。`uv` をピクセルに変換するのに便利（`uv * rect_size`）。 |
| `tex` | `sampler2D` | このステージの入力ソース（例: `backdropSource()`）。`texture2D(tex, uv)` でサンプリング。 |

ピクセルの色は、各成分が `0.0`〜`1.0` の `vec4(r, g, b, a)` で返します。

### 最初のシェーダー：単色

もっとも単純なシェーダーは、すべてを無視して1色を返します。

```glsl
// shaders/white.frag
vec4 shader_main(vec2 uv, vec2 rect_size) {
    return vec4(1.0, 1.0, 1.0, 1.0); // 不透明な白
}
```

`loadShader` ＋ `shaderStage` でエフェクトに組み込み、それをエフェクトが使える場所
（ここでは [`<ShaderEffect/>`](./components.md#shadereffect)）で利用します。

```tsx
import {compileEffect, backdropSource, shaderStage, loadShader} from 'shoji_wm';

const white = compileEffect({
  input: backdropSource(),
  pipeline: [shaderStage(loadShader('./shaders/white.frag'))],
});

<ShaderEffect shader={white} style={{width: 100, height: 40}} />
```

### ソーステクスチャを読む

たいていは単色を塗るのではなく、領域の*背後にあるもの*を加工したいはずです。ソースは
`texture2D(tex, uv)` でサンプリングします。次のシェーダーは背景をグレースケールに
脱色します。

```glsl
// shaders/grayscale.frag
vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    float gray = dot(source.rgb, vec3(0.299, 0.587, 0.114));
    return vec4(vec3(gray), source.a);
}
```

`texture2D(tex, uv)` は、いま処理しているピクセル位置のソースの色を `vec4`（RGBA）で
返します。あとは普通の計算です。

### パラメータ：ユニフォーム

シェーダーを設定可能にするには、`uniform` 変数を宣言し、その値を `shaderStage` から
渡します。ユニフォームは1回の描画の全ピクセルで同じ値です。

```glsl
// shaders/tint.frag
uniform vec3 tint;       // RGB の色
uniform float strength;  // 0..1

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    vec3 tinted = mix(source.rgb, tint, strength);
    return vec4(tinted, source.a);
}
```

```ts
shaderStage(loadShader('./shaders/tint.frag'), {
  uniforms: {
    tint: [0.84, 0.73, 0.49], // vec3
    strength: 0.3,            // float
  },
});
```

TypeScript 側の値の型は、長さによって GLSL のユニフォーム型に対応します。

| `uniforms` の値 | GLSL の型 |
| --- | --- |
| `number` | `float` |
| `[number, number]` | `vec2` |
| `[number, number, number]` | `vec3` |
| `[number, number, number, number]` | `vec4` |

### シェーダーをアニメーションする

ユニフォームの値（各成分）は**シグナル**にできるので、変化する値を渡すことで
シェーダーをアニメーションできます――組み込みの `time` はありません。`phase` のような
ユニフォームを[アニメーション変数](./animations.md)や任意のシグナルで駆動し、エフェクトの
[`invalidate`](#無効化ポリシー) を `'always'` にして毎フレーム再描画させます。

ここでの `window` は合成関数の引数から渡されます（per-window エフェクトを返す
`COMPOSITOR.effect.window = (window) => {…}` でも同じように `window` を受け取れます）。

```tsx
import {animationVariable} from 'shoji_wm';

const pulse = animationVariable('pulse');

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  // ループはどこかで開始します（例: ウィンドウを開いたとき）:
  // window.animation.start(pulse, {duration: 1000, repeat: 'ping-pong'});

  const glow = compileEffect({
    input: backdropSource(),
    invalidate: 'always',
    pipeline: [
      shaderStage(loadShader('./shaders/glow.frag'), {
        uniforms: {
          phase: window.animation.variable(pulse), // シグナル → アニメーション
          intensity: 0.8,
        },
      }),
    ],
  });

  return (
    <ManagedWindow rect={window.position}>
      <ShaderEffect shader={glow}>
        <ClientWindow />
      </ShaderEffect>
    </ManagedWindow>
  );
};
```

```glsl
// shaders/glow.frag
uniform float phase;     // 0..1、TS からアニメーション
uniform float intensity;

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    float k = 1.0 + intensity * phase;
    return vec4(source.rgb * k, source.a);
}
```

### 追加のテクスチャ

暗黙の `tex` 以外にも、テクスチャを追加でバインドできます。それぞれを
`uniform sampler2D` として宣言し、同じ名前で `textures` にソースハンドルを渡します。
レイヤー自身の内容をマスクとして使うのがこの方法です。

```glsl
// shaders/layer-mask.frag
uniform sampler2D layer_mask;
uniform float opacity_threshold;
uniform float mask_feather;

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 blurred = texture2D(tex, uv);           // 暗黙のソース
    float a = texture2D(layer_mask, uv).a;       // 追加のテクスチャ
    float mask = smoothstep(opacity_threshold - mask_feather,
                            opacity_threshold + mask_feather, a);
    return blurred * mask;
}
```

```ts
shaderStage(loadShader('./shaders/layer-mask.frag'), {
  textures: {layer_mask: layerSource()},
  uniforms: {opacity_threshold: 0.25, mask_feather: 0.04},
});
```

### GLSL ES 1.00 の注意点

この方言（デスクトップ GLSL より古い）で気をつけることをいくつか挙げます。

- テクスチャは **`texture2D(...)`** でサンプリングします（`texture(...)` ではない）。
- `precision highp float;` はすでに宣言済みです――再宣言しないでください。
- `in` / `out` / `layout` は使いません。`shader_main` を書いて `return` するだけです。
- `for` ループの回数は**定数**である必要があります（動的な長さは不可）。
- よく使う組み込み関数: `mix`・`clamp`・`smoothstep`・`step`・`length`・`dot`・
  `fract`・`floor`・`abs`・`min`・`max`・`sin`・`cos`・`pow`。

### 反復開発

シェーダーはパスでディスクから読み込まれるため、`.frag` を編集して設定をリロードすると
再コンパイルされます――フル再起動は不要です。まず `tex` をサンプリングしてそのまま返す
シェーダーから始め、1行ずつ変更していくのがおすすめです。
