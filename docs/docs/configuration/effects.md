---
sidebar_position: 10
---

# Effects

ShojiWM can run GPU shader effects in four places, configured via
`COMPOSITOR.effect`:

| Field | Type | Applies to |
| --- | --- | --- |
| `background_effect` | `CompiledEffectHandle \| null` | Behind client-requested regions (`ext-background-effect-v1`) |
| `window` | `(window) => WindowEffectAssignment \| null` | Per toplevel window |
| `layer` | `(layer) => LayerEffectAssignment \| null` | Per layer-shell surface (bars, docks) |
| `popup` | `(popup) => PopupEffectAssignment \| null` | Per popup (menus, tooltips) |

You can also apply an effect to a region inside the composition with
[`<ShaderEffect/>`](./components.md#shadereffect).

## Background effect

`background_effect` is the effect the compositor renders **behind the regions a
client requests through the `ext-background-effect-v1` Wayland protocol** (a
`blur_region` declared on its surface). It is **not** a global full-screen
backdrop: a window or layer-shell surface opts in via the protocol, and the
compositor applies this effect behind that region only — for example a
translucent app or panel that asks the compositor to blur whatever is behind it.
Set `null` to disable.

```ts
import {COMPOSITOR, compileEffect, backdropSource, dualKawaseBlur} from 'shoji_wm';

COMPOSITOR.effect.background_effect = compileEffect({
  input: backdropSource(),
  invalidate: {kind: 'on-source-damage-box', antiArtifactMargin: 8},
  pipeline: [dualKawaseBlur({radius: 4, passes: 2})],
});
```

## Per-window / layer / popup effects

Each factory is called per surface and returns an assignment, or `null`/`{}` for
no effect. Layer and popup assignments use `behind` to render the effect beneath
the surface (the default config blurs everything behind bars and menus):

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

## Building an effect

An effect is **a source input + a pipeline of stages**. Compile it with the
function matching where it will be used:

| Compiler | Produces | For |
| --- | --- | --- |
| `compileEffect(opts)` | `CompiledEffectHandle` | background, `<ShaderEffect/>` |
| `compileWindowEffect(opts)` | `WindowEffectHandle` | `COMPOSITOR.effect.window` |
| `compileLayerEffect(opts)` | `LayerEffectHandle` | `COMPOSITOR.effect.layer` |
| `compilePopupEffect(opts)` | `PopupEffectHandle` | `COMPOSITOR.effect.popup` |

Options:

| Option | Type | Meaning |
| --- | --- | --- |
| `input` | source handle | What the pipeline reads from (e.g. `backdropSource()`) |
| `pipeline` | stage array | Stages applied in order |
| `invalidate` | policy | When to re-render (see below) |
| `alpha` | `"opaque" \| "preserve"` | Keep transparency through to display (default `"opaque"`) |
| `outsets` | `EffectOutsets` | (window effects) render beyond the window bounds |

### Sources

| Source | Reads |
| --- | --- |
| `backdropSource()` | The composited scene behind the target |
| `windowSource()` | The window's own surface |
| `layerSource()` | The layer surface's own content |
| `popupSource()` | The popup's own content |
| `imageSource(path)` | A static image file |

### Stages

| Stage | Purpose |
| --- | --- |
| `dualKawaseBlur({radius, passes})` | Fast, wide blur |
| `shaderStage(shader, {uniforms, textures})` | Run a custom GLSL fragment shader |
| `noise({...})` | Add film-grain style noise |
| `save(name)` / `blend(input, {...})` | Save/composite intermediate results |

`shaderStage` takes a shader (a path, or a `loadShader(path)` handle) plus
`uniforms` (numbers/colors passed to the shader) and `textures` (extra source
handles bound by name).

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

### Invalidation policy

`invalidate` controls when the effect re-renders, trading freshness for cost:

- `{kind: 'on-source-damage-box', antiArtifactMargin: N}` — re-render only the
  region that changed, padded by `N` px to avoid edge artifacts. The usual choice.
- `'always'` — re-render every frame (expensive; for animated shaders).
- A manual policy you invalidate yourself.

### Alpha

Set `alpha: 'preserve'` when the pipeline's output is meant to be transparent
(e.g. a blur clipped to a layer's own alpha mask), so the transparency survives
to the display pass instead of being forced opaque.

---

## Writing custom shaders

When the built-in stages aren't enough, you can write your own **fragment
shader** and run it with `shaderStage`. A fragment shader is a small program the
GPU runs **once for every pixel** of the region; its job is to compute that
pixel's final color. ShojiWM shaders are written in **GLSL ES 1.00** (the same
dialect as WebGL 1 / OpenGL ES 2.0) and live in `.frag` files next to your
config.

:::tip[New to shaders?]
If you have never written a shader before, the per-pixel mindset takes a moment
to click. These are excellent, beginner-friendly introductions — read one first,
then come back:

- [The Book of Shaders](https://thebookofshaders.com/) — the gentlest start
- [Shadertoy](https://www.shadertoy.com/) — experiment live in the browser
- [Khronos GLSL ES quick reference](https://www.khronos.org/files/opengles_shading_language.pdf) — the built-in functions

The GLSL you write for ShojiWM is the same language; only the entry point and a
few provided variables (below) differ.
:::

### The `shader_main` contract

You don't write a full GLSL program — you write **one function**:

```glsl
vec4 shader_main(vec2 uv, vec2 rect_size) {
    // compute and return this pixel's color
    return vec4(1.0, 0.0, 0.0, 1.0); // opaque red
}
```

ShojiWM wraps your file with this preamble before compiling, so you don't have to
write any of it yourself:

```glsl
#version 100
precision highp float;

uniform sampler2D tex;   // the input source (e.g. the backdrop)
uniform vec2 rect_size;  // region size in pixels
varying vec2 v_coords;   // passed to you as `uv`

// ...your file is inserted here...

void main() {
    gl_FragColor = shader_main(v_coords, rect_size);
}
```

That gives you these built-ins for free inside `shader_main`:

| Name | Type | Meaning |
| --- | --- | --- |
| `uv` (first arg) | `vec2` | Normalized coordinate, `0.0`–`1.0`, spanning the region. `(0,0)` and `(1,1)` are opposite corners. |
| `rect_size` (second arg) | `vec2` | The region's size in pixels — useful to convert `uv` to pixels (`uv * rect_size`). |
| `tex` | `sampler2D` | The pipeline's input source for this stage (e.g. `backdropSource()`). Sample it with `texture2D(tex, uv)`. |

Return the pixel color as a `vec4(r, g, b, a)` with components in `0.0`–`1.0`.

### A first shader: a solid color

The simplest possible shader ignores everything and returns one color:

```glsl
// shaders/white.frag
vec4 shader_main(vec2 uv, vec2 rect_size) {
    return vec4(1.0, 1.0, 1.0, 1.0); // opaque white
}
```

Wire it into an effect with `loadShader` + `shaderStage`, then use that effect
anywhere an effect is accepted (here, a [`<ShaderEffect/>`](./components.md#shadereffect)):

```tsx
import {compileEffect, backdropSource, shaderStage, loadShader} from 'shoji_wm';

const white = compileEffect({
  input: backdropSource(),
  pipeline: [shaderStage(loadShader('./shaders/white.frag'))],
});

<ShaderEffect shader={white} style={{width: 100, height: 40}} />
```

### Reading the source texture

Usually you want to transform what's *behind* the region rather than paint a flat
color. Sample the source with `texture2D(tex, uv)`. This shader desaturates the
backdrop to grayscale:

```glsl
// shaders/grayscale.frag
vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    float gray = dot(source.rgb, vec3(0.299, 0.587, 0.114));
    return vec4(vec3(gray), source.a);
}
```

`texture2D(tex, uv)` returns the source pixel under the current fragment as a
`vec4` (RGBA). From there it's ordinary math.

### Parameters: uniforms

To make a shader configurable, declare `uniform` variables and pass their values
from `shaderStage`. A uniform is the same value for every pixel in a draw.

```glsl
// shaders/tint.frag
uniform vec3 tint;       // an RGB color
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

The TypeScript value type maps to the GLSL uniform type by length:

| `uniforms` value | GLSL type |
| --- | --- |
| `number` | `float` |
| `[number, number]` | `vec2` |
| `[number, number, number]` | `vec3` |
| `[number, number, number, number]` | `vec4` |

### Animating a shader

Every uniform value (each component) may be a **signal**, so you animate a shader
by feeding it a changing value — there is no built-in `time`. Drive a `phase`
uniform from an [animation variable](./animations.md) or any signal, and set the
effect's [`invalidate`](#invalidation-policy) to `'always'` so it re-renders each
frame:

Here `window` comes from the composition function's argument (a per-window effect
factory, `COMPOSITOR.effect.window = (window) => {…}`, gives you a `window` the
same way):

```tsx
import {animationVariable} from 'shoji_wm';

const pulse = animationVariable('pulse');

COMPOSITOR.window.composition = (window: WaylandWindow) => {
  // start the loop somewhere, e.g. on open:
  // window.animation.start(pulse, {duration: 1000, repeat: 'ping-pong'});

  const glow = compileEffect({
    input: backdropSource(),
    invalidate: 'always',
    pipeline: [
      shaderStage(loadShader('./shaders/glow.frag'), {
        uniforms: {
          phase: window.animation.variable(pulse), // a signal → animates
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
uniform float phase;     // 0..1, animated from TS
uniform float intensity;

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 source = texture2D(tex, uv);
    float k = 1.0 + intensity * phase;
    return vec4(source.rgb * k, source.a);
}
```

### Extra textures

Beyond the implicit `tex`, you can bind more textures: declare each as a
`uniform sampler2D`, and pass a source handle by the same name in `textures`.
This is how a layer's own content is used as a mask:

```glsl
// shaders/layer-mask.frag
uniform sampler2D layer_mask;
uniform float opacity_threshold;
uniform float mask_feather;

vec4 shader_main(vec2 uv, vec2 rect_size) {
    vec4 blurred = texture2D(tex, uv);           // the implicit source
    float a = texture2D(layer_mask, uv).a;       // the extra texture
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

### GLSL ES 1.00 reminders

A few things to keep in mind in this dialect (it's older than desktop GLSL):

- Sample textures with **`texture2D(...)`**, not `texture(...)`.
- `precision highp float;` is already declared — don't redeclare it.
- Don't use `in` / `out` / `layout`; just write and `return` from `shader_main`.
- `for` loops need a **constant** loop bound (no dynamic length).
- Handy built-ins: `mix`, `clamp`, `smoothstep`, `step`, `length`, `dot`,
  `fract`, `floor`, `abs`, `min`, `max`, `sin`, `cos`, `pow`.

### Iterating

Shaders are loaded from disk by path, so editing a `.frag` and triggering a
config reload re-compiles it — no full restart needed. Start from a shader that
samples `tex` and returns it unchanged, then change one line at a time.
