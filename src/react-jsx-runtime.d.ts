// React and its JSX runtime come from the web client.
declare module "react" {
  export function useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
}

declare module "react/jsx-runtime" {
  export function jsx(type: string, props: Record<string, unknown>, key?: string | number): unknown;
  export function jsxs(type: string, props: Record<string, unknown>, key?: string | number): unknown;
}
