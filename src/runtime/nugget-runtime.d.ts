// Public typings for lazy-handler-webpack-plugin/runtime.
//
// The underscore-prefixed exports (__nuggetProxy, __nuggetCreateScope,
// __nuggetDestroyScope, __nuggetRegisterRef, __nuggetDeref, __nuggetHasScope)
// are wired by the build-time loader and aren't part of the public API. They
// are deliberately not typed here.

import type { ComponentType, ReactElement, ReactNode } from "react";

export interface NuggetLoadErrorDetail {
  /** Stable handler ID, e.g. `nugget_onClick_a3f7c9b1`. */
  id: string;
  /** The error that the dynamic `import()` rejected with. */
  error: unknown;
  /** 0 for the first failure, 1 for the retry failure. */
  attempt: number;
  /**
   * `true` if a retry is scheduled (the runtime will fire this listener
   * again, with attempt=1, after the retry delay). `false` when this is the
   * final, definitive failure.
   */
  willRetry: boolean;
}

/**
 * Register a listener that fires whenever a nugget chunk fails to load. The
 * runtime currently attempts one retry (500 ms after the first failure)
 * before giving up.
 *
 * The listener fires on both the initial failure and (if the retry also
 * fails) the final failure. Use `willRetry` to distinguish them when wiring
 * error-reporting / telemetry:
 *
 * ```ts
 * onNuggetLoadError((d) => {
 *   if (d.willRetry) return;            // skip transient failures
 *   Sentry.captureException(d.error, { tags: { handlerId: d.id } });
 * });
 * ```
 *
 * The runtime also dispatches a `nugget:load-error` `CustomEvent` on
 * `window` with the same detail shape — useful if your error-reporting SDK
 * already listens to window events without importing from this package.
 *
 * @returns an unsubscribe function.
 */
export function onNuggetLoadError(
  listener: (detail: NuggetLoadErrorDetail) => void
): () => void;

/**
 * Window event dispatched by the runtime with the same detail shape as
 * `onNuggetLoadError`. Declared on the global WindowEventMap so
 * `window.addEventListener("nugget:load-error", e => e.detail)` is typed.
 */
declare global {
  interface WindowEventMap {
    "nugget:load-error": CustomEvent<NuggetLoadErrorDetail>;
  }
}

// ─── NuggetLazy ─────────────────────────────────────────────────────────────

export interface NuggetLazyProps<P extends object = {}> {
  /**
   * Lazy-import factory. Must return a Promise resolving to a module with a
   * default-exported React component.
   */
  load: () => Promise<{ default: ComponentType<P> }>;
  /**
   * Props forwarded to the loaded component. Spread on the rendered element
   * once the dynamic import resolves.
   */
  props?: P;
  /**
   * `IntersectionObserver` rootMargin used for the mount-trigger sentinel.
   * Defaults to "300px" — start loading the chunk a third of a viewport
   * before the sentinel would actually scroll on-screen.
   */
  rootMargin?: string;
  /**
   * Rendered after the sentinel intersects but before the dynamic import
   * resolves. Use for a skeleton or spinner. Defaults to nothing.
   */
  loading?: ReactNode;
  /**
   * Called if the dynamic import rejects. The return value is rendered in
   * place of the lazy component. If omitted, errors render nothing (the
   * runtime also logs them in dev).
   */
  error?: (err: unknown) => ReactNode;
}

/**
 * Sentinel-mounted lazy component. Replaces the manual `useState + useRef +
 * useEffect + IntersectionObserver + dynamic()` pattern. SSR-safe: on the
 * server it renders the sentinel placeholder; hydration matches; the
 * intersection effect fires client-side only.
 *
 * @example
 * <NuggetLazy
 *   load={() => import("./Home.BelowFold")}
 *   props={{ posts, setPosts }}
 *   rootMargin="300px"
 *   loading={<div>Loading…</div>}
 *   error={(err) => <p>Failed to load: {String(err)}</p>}
 * />
 */
export function NuggetLazy<P extends object = {}>(
  props: NuggetLazyProps<P>
): ReactElement | null;
