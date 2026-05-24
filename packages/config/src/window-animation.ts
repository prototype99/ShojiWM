import {
    type AnimationVariable,
    type WaylandWindow,
    type WindowStateKey,
    animationVariable,
    computed,
    read,
} from "shoji_wm";
import type { ManagedWindowRect } from "shoji_wm/types";

// One animation variable per rect-state key. Sharing across windows is fine
// because window.animation is per-window — same id, isolated progress.
// Different state keys get different vars so concurrent animations don't
// trample each other's progress.
const rectAnimationVariableByStateKey = new Map<symbol, AnimationVariable>();

// Per-(window, state-key) teardown for the currently-running rect animation.
// WeakMap on the window so entries vanish when the window does.
const activeRectAnimations = new WeakMap<WaylandWindow, Map<symbol, () => void>>();

function getRectAnimationVariable(stateKey: symbol): AnimationVariable {
    let variable = rectAnimationVariableByStateKey.get(stateKey);
    if (!variable) {
        variable = animationVariable(`rect-anim:${stateKey.description ?? "anon"}`);
        rectAnimationVariableByStateKey.set(stateKey, variable);
    }
    return variable;
}

/**
 * Drive `window.state[windowRectState]` from its current rect to `to` over
 * `duration` ms, applying `easing` to the progress. The state is replaced
 * once with per-field computed signals, so each animation frame only updates
 * the animation variable instead of also writing the window state signal.
 *
 * Calling again while an animation is in flight cancels the previous one
 * and retargets from the rect's current (possibly mid-lerp) value — so
 * `playRectAnimation(window, KEY, A, ...)` followed immediately by
 * `playRectAnimation(window, KEY, B, ...)` slides smoothly toward B
 * without snapping.
 *
 * Both `to` and the current state may use `MaybeSignal<number>` fields;
 * they are resolved to plain numbers at the moment the animation starts.
 */
export function playRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
    to: ManagedWindowRect,
    easing: (progress: number) => number,
    duration: number,
): void {
    const variable = getRectAnimationVariable(windowRectState);

    let perWindow = activeRectAnimations.get(window);
    if (!perWindow) {
        perWindow = new Map();
        activeRectAnimations.set(window, perWindow);
    }
    perWindow.get(windowRectState)?.();

    const currentRect = window.state[windowRectState]();
    const from = {
        x: read(currentRect.x),
        y: read(currentRect.y),
        width: read(currentRect.width),
        height: read(currentRect.height),
    };
    const target = {
        x: read(to.x),
        y: read(to.y),
        width: read(to.width),
        height: read(to.height),
    };

    // Snap the variable to 0 *before* subscribing so the first effect tick
    // writes the from-rect verbatim. Without this, a prior animation that
    // ended at 1 would cause a one-frame jump to the target.
    window.animation.set(variable, 0);

    const progress = window.animation.signal(variable);
    window.state[windowRectState].set({
        x: computed(() => from.x + (target.x - from.x) * progress()),
        y: computed(() => from.y + (target.y - from.y) * progress()),
        width: computed(() => from.width + (target.width - from.width) * progress()),
        height: computed(() => from.height + (target.height - from.height) * progress()),
    });

    const teardown = () => {
        clearTimeout(timer);
        if (perWindow!.get(windowRectState) === teardown) {
            perWindow!.delete(windowRectState);
        }
    };
    // Small slack to let the final frame land before we unsubscribe.
    const timer = setTimeout(teardown, duration + 32);
    perWindow.set(windowRectState, teardown);

    window.animation.start(variable, {
        duration,
        from: 0,
        to: 1,
        easing,
    });
}

export function stopRectAnimation(
    window: WaylandWindow,
    windowRectState: WindowStateKey<ManagedWindowRect>,
): void {
    activeRectAnimations.get(window)?.get(windowRectState)?.();
}
