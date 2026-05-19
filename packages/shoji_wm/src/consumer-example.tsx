import { type WaylandWindow } from "shoji_wm";
import { defaultWindowComposition } from "shoji_wm/default-composition";

export const exampleComposition = (window: WaylandWindow) =>
  defaultWindowComposition(window);
