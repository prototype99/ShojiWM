import { createElementNode, normalizeChildren, renderComponent } from "./runtime";
import type {
  Component,
  ComponentProps,
  ClientWindowProps,
  ImageProps,
  ManagedWindowProps,
  ShaderEffectProps,
  CompositionChild,
  CompositionRenderable,
  CompositionNodeType,
} from "./types";

export function jsx(
  type: CompositionNodeType | Component<any>,
  props: ComponentProps,
  key?: string,
): CompositionRenderable {
  return createJsxNode(type, props, key);
}

export function jsxs(
  type: CompositionNodeType | Component<any>,
  props: ComponentProps,
  key?: string,
): CompositionRenderable {
  return createJsxNode(type, props, key);
}

export const Fragment = "Fragment" satisfies CompositionNodeType;

function createJsxNode(
  type: CompositionNodeType | Component<any>,
  props: ComponentProps = {},
  key?: string,
): CompositionRenderable {
  const normalizedProps = {
    ...props,
    children: normalizeChildren(props.children),
  };

  if (typeof type === "function") {
    return renderComponent(type, normalizedProps, key ?? null);
  }

  return createElementNode(type, normalizedProps, key);
}

export namespace JSX {
  export type Element = CompositionRenderable;
  export type ElementType = CompositionNodeType | Component<any>;
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface IntrinsicElements {
    Box: ComponentProps;
    Label: ComponentProps;
    Button: ComponentProps;
    AppIcon: ComponentProps;
    Image: ImageProps;
    ShaderEffect: ShaderEffectProps;
    ManagedWindow: ManagedWindowProps;
    ClientWindow: ClientWindowProps;
    Window: ComponentProps;
    WindowBorder: ComponentProps;
    Fragment: ComponentProps;
  }
}

export type { CompositionChild };
