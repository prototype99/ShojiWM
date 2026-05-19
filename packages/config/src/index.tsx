import {
    AppIcon,
    Box,
    Button,
    ClientWindow,
    Image,
    ShaderEffect,
    Label,
    WINDOW_MANAGER,
    WindowBorder,
    backdropSource,
    compileEffect,
    compileWindowEffect,
    dualKawaseBlur,
    type SSDStyle,
    type WaylandWindow,
    animationVariable,
    seconds,
    cubicBezier,
    computed,
    useState,
    shaderStage,
    loadShader,
    windowSource,
    ManagedWindow,
    createWindowState,
    createWindowStack,
    createManagedPoll,
    type PollHandle,
} from "shoji_wm";
import type { DecorationRenderable, ManagedWindowRect, WindowPosition } from "shoji_wm/types";

const NOCTALIA_SHELL_PATH = "/home/bea4dev/Documents/development/noctalia-shell-shojiwm";

/*
WINDOW_MANAGER.output.applyDisplayConfig((display) => {
    for (let displayName of WINDOW_MANAGER.output.list) {
        display[displayName] = {
            resolution: "best",
            position: "auto",
            scale: 2,
        };
    }
});*/

WINDOW_MANAGER.process.once("fcitx5", {
    command: ["fcitx5", "-d"],
    runPolicy: "once-per-session",
});
WINDOW_MANAGER.process.once("shell", {
    command: ["qs", "--path", NOCTALIA_SHELL_PATH],
    runPolicy: "once-per-session",
});


WINDOW_MANAGER.key.bind("terminal", "Super+T", () => {
    WINDOW_MANAGER.process.spawn({ command: ["kitty"] });
});
WINDOW_MANAGER.key.bind("launcher", "Super+A", () => {
    WINDOW_MANAGER.process.spawn({ command: ["qs", "--path", NOCTALIA_SHELL_PATH, "ipc", "call", "launcher", "toggle"] });
});
WINDOW_MANAGER.key.bind("clipboard", "Super+V", () => {
    WINDOW_MANAGER.process.spawn({ command: ["qs", "--path", NOCTALIA_SHELL_PATH, "ipc", "call", "launcher", "clipboard"] });
});
WINDOW_MANAGER.key.bind("screenshot", "Super+P", () => {
    WINDOW_MANAGER.process.spawn({ command: "hyprshot -m region --raw | swappy -f -" });
});
WINDOW_MANAGER.key.bind("screenshot-freeze", "Super+Ctrl+P", () => {
    WINDOW_MANAGER.process.spawn({ command: "hyprshot -m region --freeze --raw | swappy -f -" });
});


WINDOW_MANAGER.output.applyDisplayConfig((display) => {
    display["eDP-1"] = {
        resolution: "best",
        position: "auto",
        scale: 1.25,
    };
    display["DP-4"] = {
        resolution: "best",
        position: "auto",
        scale: 1.5,
    };
    display["DP-2"] = {
        resolution: "best",
        position: "auto",
        scale: 1.6,
    };
});

const openAnimation = animationVariable("window.open");

WINDOW_MANAGER.effect.background_effect = compileEffect({
    input: backdropSource(),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        dualKawaseBlur({ radius: 4, passes: 2 }),
    ]
});
/*
const windowShadowEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    outsets: { left: 72, right: 72, top: 56, bottom: 96 },
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        shaderStage(loadShader("./src/window-shadow.frag"), {
            uniforms: {
                shadow_color: [0.45, 0.45, 0.45],
                shadow_opacity: 0.5,
                shadow_offset_px: [24.0, 24.0],
            },
        }),
    ],
});

const windowFrontEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    outsets: { left: 72, right: 72, top: 56, bottom: 96 },
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
    pipeline: [
        shaderStage(loadShader("./src/window-shadow.frag"), {
            uniforms: {
                shadow_color: [0.45, 0.45, 0.45],
                shadow_opacity: 0.5,
                shadow_offset_px: [-24.0, -24.0],
            },
        }),
    ],
});

const windowReplaceEffect = compileWindowEffect({
    input: windowSource({ include: "full" }),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 4 },
    pipeline: [
        shaderStage(loadShader("./src/window-grayscale.frag")),
    ],
});

WINDOW_MANAGER.effect.window = (window) => ({
    behindRootSurface: windowShadowEffect,
    inFront: windowFrontEffect,
    replace: windowReplaceEffect,
});*/

const OPEN_CLOSE_ANIMATION_DURATION = seconds(1.0)

const DEFAULT_WINDOW_RECT: WindowPosition = { x: 100, y: 200, width: 1000, height: 700 };
const WINDOW_STATE_RECT = createWindowState<ManagedWindowRect>("rect", {
    default: (window) => window.rect ?? DEFAULT_WINDOW_RECT,
});
const WINDOW_STATE_HOCKEY_TINT = createWindowState<number>("hockeyTint", {
    default: 0,
});
const windowStack = createWindowStack();

// Lower values keep momentum longer. Increase this when the hockey windows feel too slippery.
let HOCKEY_FRICTION_PER_SECOND = 0.16;
const HOCKEY_POLL_INTERVAL_MS = 8;
const HOCKEY_STOP_SPEED = 18;
const HOCKEY_MAX_SPEED = 3600;

interface HockeyBody {
    window: WaylandWindow;
    vx: number;
    vy: number;
    lastMs: number;
}

interface HockeyDragSample {
    x: number;
    y: number;
    timeMs: number;
    vx: number;
    vy: number;
}

const hockeyBodies = new Map<string, HockeyBody>();
const hockeyDragSamples = new Map<string, HockeyDragSample>();
let hockeyPoll: PollHandle | null = null;

function startHockeyPoll() {
    if (hockeyPoll && !hockeyPoll.cancelled) {
        return;
    }

    hockeyPoll = createManagedPoll(HOCKEY_POLL_INTERVAL_MS, (poll) => {
        if (hockeyBodies.size === 0) {
            poll.cancel();
            hockeyPoll = null;
            return;
        }

        for (const [windowId, body] of Array.from(hockeyBodies)) {
            const rectSignal = body.window.state[WINDOW_STATE_RECT];
            const rect = rectSignal.peek();
            const nowMs = poll.nowMs;
            const dt = Math.min(0.05, Math.max(1 / 240, (nowMs - body.lastMs) / 1000));
            body.lastMs = nowMs;

            const bounds = hockeyPlayArea(rect);
            let nextX = rect.x + body.vx * dt;
            let nextY = rect.y + body.vy * dt;
            let bounced = false;

            const minX = bounds.left;
            const minY = bounds.top;
            const maxX = Math.max(minX, bounds.right - rect.width);
            const maxY = Math.max(minY, bounds.bottom - rect.height);

            if (nextX < minX) {
                nextX = minX + (minX - nextX);
                body.vx = Math.abs(body.vx);
                bounced = true;
            } else if (nextX > maxX) {
                nextX = maxX - (nextX - maxX);
                body.vx = -Math.abs(body.vx);
                bounced = true;
            }

            if (nextY < minY) {
                nextY = minY + (minY - nextY);
                body.vy = Math.abs(body.vy);
                bounced = true;
            } else if (nextY > maxY) {
                nextY = maxY - (nextY - maxY);
                body.vy = -Math.abs(body.vy);
                bounced = true;
            }

            nextX = clamp(nextX, minX, maxX);
            nextY = clamp(nextY, minY, maxY);

            if (bounced) {
                const tint = body.window.state[WINDOW_STATE_HOCKEY_TINT];
                tint.set(tint.peek() > 0.5 ? 0 : 1);
            }

            const damping = Math.exp(-HOCKEY_FRICTION_PER_SECOND * dt);
            body.vx *= damping;
            body.vy *= damping;

            const speed = Math.hypot(body.vx, body.vy);
            if (speed < HOCKEY_STOP_SPEED) {
                hockeyBodies.delete(windowId);
            }

            rectSignal.set({
                x: nextX,
                y: nextY,
                width: rect.width,
                height: rect.height,
            });
        }
    }, "none");
}

function hockeyPlayArea(rect: WindowPosition) {
    const outputs = Object.values(WINDOW_MANAGER.output.current)
        .filter(output => output.resolution && output.scale > 0);

    if (outputs.length === 0) {
        return {
            left: 0,
            top: 0,
            right: Math.max(1920, rect.x + rect.width),
            bottom: Math.max(1080, rect.y + rect.height),
        };
    }

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;

    for (const output of outputs) {
        const resolution = output.resolution!;
        const outputLeft = output.position.x;
        const outputTop = output.position.y;
        const outputRight = outputLeft + resolution.width / output.scale;
        const outputBottom = outputTop + resolution.height / output.scale;
        left = Math.min(left, outputLeft);
        top = Math.min(top, outputTop);
        right = Math.max(right, outputRight);
        bottom = Math.max(bottom, outputBottom);
    }

    return { left, top, right, bottom };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function clampVelocity(value: number) {
    return clamp(value, -HOCKEY_MAX_SPEED, HOCKEY_MAX_SPEED);
}

const hockeyTintEffectFor = (window: WaylandWindow) => compileWindowEffect({
    input: windowSource({ include: "full" }),
    invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 4 },
    pipeline: [
        shaderStage(loadShader("./src/hockey-tint.frag"), {
            uniforms: {
                tint_phase: window.state[WINDOW_STATE_HOCKEY_TINT],
            },
        }),
    ],
});

WINDOW_MANAGER.effect.window = (window) => ({
    replace: hockeyTintEffectFor(window),
});

WINDOW_MANAGER.event.onOpen((window) => {
    windowStack.add(window);
    window.state[WINDOW_STATE_RECT].set(window.rect ?? DEFAULT_WINDOW_RECT);
    window.state[WINDOW_STATE_HOCKEY_TINT].set(0);
    window.setCloseAnimationDuration(OPEN_CLOSE_ANIMATION_DURATION);
    window.animation.start(openAnimation, {
        duration: OPEN_CLOSE_ANIMATION_DURATION,
        to: 1,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });
});

WINDOW_MANAGER.event.onStartClose((window) => {
    window.animation.start(openAnimation, {
        duration: OPEN_CLOSE_ANIMATION_DURATION,
        to: 0,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });
});

WINDOW_MANAGER.event.onClose((window) => {
    windowStack.remove(window);
    hockeyBodies.delete(window.id);
    hockeyDragSamples.delete(window.id);
});

WINDOW_MANAGER.event.onFocus((window, focused) => {
    if (focused) {
        windowStack.raise(window);
    }
    /*
    window.animation.start(focusAnimation, {
        duration: seconds(0.5),
        to: focused ? 1 : 0.9,
        easing: cubicBezier(0.1, 0.93, 0.1, 0.93)
    });*/
});

WINDOW_MANAGER.event.onWindowResize((event) => {
    event.window.state[WINDOW_STATE_RECT].set(event.currentRect);
});

WINDOW_MANAGER.pointer.bindWindowMoveModifier("Super");

WINDOW_MANAGER.event.onWindowMove((event) => {
    const rectSignal = event.window.state[WINDOW_STATE_RECT];
    rectSignal.set(event.currentRect);

    if (event.phase === "start") {
        hockeyBodies.delete(event.window.id);
        hockeyDragSamples.set(event.window.id, {
            x: event.currentRect.x,
            y: event.currentRect.y,
            timeMs: event.timestamp,
            vx: 0,
            vy: 0,
        });
        return;
    }

    const previous = hockeyDragSamples.get(event.window.id);
    if (event.phase === "update") {
        if (!previous) {
            hockeyDragSamples.set(event.window.id, {
                x: event.currentRect.x,
                y: event.currentRect.y,
                timeMs: event.timestamp,
                vx: 0,
                vy: 0,
            });
            return;
        }

        const dt = Math.max(1 / 240, (event.timestamp - previous.timeMs) / 1000);
        const vx = clampVelocity((event.currentRect.x - previous.x) / dt);
        const vy = clampVelocity((event.currentRect.y - previous.y) / dt);
        hockeyDragSamples.set(event.window.id, {
            x: event.currentRect.x,
            y: event.currentRect.y,
            timeMs: event.timestamp,
            vx: previous.vx * 0.35 + vx * 0.65,
            vy: previous.vy * 0.35 + vy * 0.65,
        });
        return;
    }

    if (event.phase === "end") {
        const sample = hockeyDragSamples.get(event.window.id);
        hockeyDragSamples.delete(event.window.id);
        if (!sample || Math.hypot(sample.vx, sample.vy) < HOCKEY_STOP_SPEED) {
            return;
        }

        hockeyBodies.set(event.window.id, {
            window: event.window,
            vx: sample.vx,
            vy: sample.vy,
            lastMs: event.timestamp,
        });
        startHockeyPoll();
        return;
    }

    if (event.phase === "cancel") {
        hockeyBodies.delete(event.window.id);
        hockeyDragSamples.delete(event.window.id);
    }
});

WINDOW_MANAGER.decoration = (window: WaylandWindow) => {
    const openVariable = window.animation.signal(openAnimation);
    const opacity = openVariable;
    const translateY = openVariable(variable => (1 - variable) * 200);
    const rect = computed(() => {
        const base = window.state[WINDOW_STATE_RECT]();
        const dy = translateY();
        return {
            x: base.x,
            y: base.y + dy,
            width: base.width,
            height: base.height,
        };
    });

    const borderColor = window.isFocused(focused => focused ? "#d7ba7d" : "#4f5666");
    const titlebarBackground = window.isFocused(focused => focused ? "#1f243080" : "#2a2f3a80");
    const titleColor = window.isFocused(focused => focused ? "#f5f7fa" : "#c9d1d9");

    const titlebarStyle: SSDStyle = {
        height: 30,
        paddingX: 8,
        gap: 8,
        alignItems: "center",
        background: titlebarBackground,
    };

    const backgroundShader = compileEffect({
        input: backdropSource(),
        invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
        pipeline: [
            dualKawaseBlur({ radius: 2, passes: 2 }),
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    glass_radius_px: 10.0,
                    distortion_depth: 0.2,
                    distortion_strength: 0.15,
                    chromatic_shift_px: 3.0,
                    glass_tint: 0.9,
                },
            }),
        ],
    });

    const titleOnlyShader = compileEffect({
        input: backdropSource(),
        invalidate: { kind: "on-source-damage-box", antiArtifactMargin: 8 },
        pipeline: [
            dualKawaseBlur({ radius: 2, passes: 2 }),
            shaderStage(loadShader("./src/liquid-glass.frag"), {
                uniforms: {
                    glass_radius_px: 10.0,
                    distortion_depth: 0.3,
                    distortion_strength: 0.1,
                    chromatic_shift_px: 3.0,
                    glass_tint: 0.9,
                },
            }),
        ],
    });

    const appIcon = (<AppIcon icon={window.icon} style={{ width: 16, height: 16 }} />);
    const label = (
        <Label
            text={window.title}
            style={{
                color: titleColor,
                fontFamily: ["Noto Sans CJK JP", "Noto Color Emoji"],
                fontSize: 13,
                fontWeight: 600,
                flexGrow: 1,
                flexShrink: 1,
                minWidth: 0,
            }}
        />
    );
    const closeButton = (<CloseButton window={window} />);

    var innerComponents = (
        <Box direction="column">
            <ShaderEffect shader={titleOnlyShader} direction="row" style={titlebarStyle}>
                {appIcon}
                {label}
                {closeButton}
            </ShaderEffect>
            <ClientWindow />
        </Box>
    );

    const TERMINALS = ["kitty", "ghostty"];

    if (TERMINALS.includes(window.appId() ?? "")) {
        innerComponents = (
            <ShaderEffect shader={backgroundShader} direction="column">
                <Box direction="row" style={titlebarStyle}>
                    {appIcon}
                    {label}
                    {closeButton}
                </Box>
                <ClientWindow />
            </ShaderEffect>
        );
    }

    return (
        <ManagedWindow
            rect={rect}
            zIndex={windowStack.zIndex(window)}
            clipToRect
            opacity={opacity}
        >
            <WindowBorder
                style={{
                    border: { px: 2, color: borderColor },
                    borderRadius: 10,
                    background: "#10131900",
                    padding: 0,
                    paddingX: 0,
                    paddingRight: 0,
                }}
            >
                <Box direction="row">
                    {innerComponents}
                </Box>
            </WindowBorder>
        </ManagedWindow>
    );
};

const CloseButton = ({ window }: { window: WaylandWindow }) => {
    const [hover, setHover] = useState(false);

    const background = hover(hover => hover ? "#F08080" : "#F0808080");

    var icon: DecorationRenderable | null = null;
    if (hover()) {
        icon = (
            <Image
                src="./assets/x.svg"
                style={{
                    width: 16,
                    height: 16,
                    position: "absolute",
                    zIndex: 1,
                    pointerEvents: "none"
                }}
            />
        );
    }

    return (
        <Box style={{ position: "relative", flexShrink: 0 }}>
            <Button
                onHoverChange={setHover}
                style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: background,
                    border: { px: 1, color: "#f5f7fa" },
                }}
                onClick={window.close}
            />
            {icon}
        </Box>
    )
};

export { WINDOW_MANAGER };
