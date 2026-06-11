import { signal, type ReadonlySignal, type Signal } from "./signals";
import { withoutCompositionOwnership } from "./runtime-hooks";
import type { WaylandWindow } from "./types";

export type WindowStackPlacement = "front" | "back";

export interface WindowStackOptions {
  baseZIndex?: number;
  step?: number;
}

export interface WindowStackAddOptions {
  at?: WindowStackPlacement;
}

export interface WindowStack {
  add(window: WaylandWindow, options?: WindowStackAddOptions): void;
  remove(window: WaylandWindow): void;
  has(window: WaylandWindow): boolean;
  raise(window: WaylandWindow): void;
  lower(window: WaylandWindow): void;
  moveBefore(window: WaylandWindow, target: WaylandWindow): void;
  moveAfter(window: WaylandWindow, target: WaylandWindow): void;
  zIndex(window: WaylandWindow): ReadonlySignal<number>;
  zIndexValue(window: WaylandWindow): number;
  windows(): readonly WaylandWindow[];
  ids(): readonly string[];
  front(): WaylandWindow | undefined;
  back(): WaylandWindow | undefined;
  clear(): void;
}

export function createWindowStack(options: WindowStackOptions = {}): WindowStack {
  const baseZIndex = options.baseZIndex ?? 0;
  const step = options.step ?? 1;
  let order: string[] = [];
  const windowsById = new Map<string, WaylandWindow>();
  const zIndexById = new Map<string, Signal<number>>();

  const normalize = (window: WaylandWindow): string => {
    windowsById.set(window.id, window);
    return window.id;
  };

  const uniqueOrder = (nextOrder: string[]): string[] => {
    const seen = new Set<string>();
    return nextOrder.filter((id) => {
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
  };

  const zIndexSignal = (id: string): Signal<number> => {
    let existing = zIndexById.get(id);
    if (!existing) {
      existing = withoutCompositionOwnership(() => signal(baseZIndex));
      zIndexById.set(id, existing);
    }
    return existing;
  };

  const zIndexForId = (id: string): number =>
    zIndexById.get(id)?.peek() ?? baseZIndex;

  const edgeZIndex = (
    remaining: readonly string[],
    placement: WindowStackPlacement,
  ): number => {
    if (remaining.length === 0) {
      return baseZIndex;
    }
    const edgeId =
      placement === "front" ? remaining[remaining.length - 1] : remaining[0];
    return zIndexForId(edgeId) + (placement === "front" ? step : -step);
  };

  const moveTo = (window: WaylandWindow, placement: WindowStackPlacement): void => {
    const id = normalize(window);
    const currentIndex = order.indexOf(id);
    const targetIndex = placement === "front" ? order.length - 1 : 0;
    if (currentIndex >= 0 && currentIndex === targetIndex) {
      return;
    }

    const without = order.filter((candidate) => candidate !== id);
    zIndexSignal(id).set(edgeZIndex(without, placement));
    order = placement === "front" ? [...without, id] : [id, ...without];
  };

  const rebalance = (nextOrder: string[]): void => {
    order = uniqueOrder(nextOrder);
    for (const [index, id] of order.entries()) {
      zIndexSignal(id).set(baseZIndex + index * step);
    }
  };

  return {
    add(window, addOptions = {}) {
      const at = addOptions.at ?? "front";
      moveTo(window, at);
    },
    remove(window) {
      windowsById.delete(window.id);
      zIndexById.delete(window.id);
      order = order.filter((id) => id !== window.id);
    },
    has(window) {
      return order.includes(window.id);
    },
    raise(window) {
      moveTo(window, "front");
    },
    lower(window) {
      moveTo(window, "back");
    },
    moveBefore(window, target) {
      const id = normalize(window);
      const targetId = normalize(target);
      const without = order.filter((candidate) => candidate !== id);
      const targetIndex = without.indexOf(targetId);
      if (targetIndex < 0) {
        rebalance([...without, id]);
        return;
      }
      rebalance([
        ...without.slice(0, targetIndex),
        id,
        ...without.slice(targetIndex),
      ]);
    },
    moveAfter(window, target) {
      const id = normalize(window);
      const targetId = normalize(target);
      const without = order.filter((candidate) => candidate !== id);
      const targetIndex = without.indexOf(targetId);
      if (targetIndex < 0) {
        rebalance([...without, id]);
        return;
      }
      rebalance([
        ...without.slice(0, targetIndex + 1),
        id,
        ...without.slice(targetIndex + 1),
      ]);
    },
    zIndex(window) {
      const id = normalize(window);
      // Long-lived per-window signal: must outlive the composition pass it
      // was first requested from. See animation.ts for the same pattern.
      return zIndexSignal(id);
    },
    zIndexValue(window) {
      return zIndexForId(window.id);
    },
    windows() {
      return order
        .map((id) => windowsById.get(id))
        .filter((window): window is WaylandWindow => window !== undefined);
    },
    ids() {
      return [...order];
    },
    front() {
      return windowsById.get(order[order.length - 1] ?? "");
    },
    back() {
      return windowsById.get(order[0] ?? "");
    },
    clear() {
      windowsById.clear();
      zIndexById.clear();
      order = [];
    },
  };
}
