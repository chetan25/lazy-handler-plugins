// src/runtime/nugget-runtime.js
// ~600 bytes gzipped — the only code this plugin ships to the browser.
// Provides:
//   1. Per-component-instance scope registry (avoids global ref collisions)
//   2. Event proxy — queues events while handler chunk loads, replays on arrival
//   3. IntersectionObserver — preloads below-fold component chunks

// ─── Scope Registry ──────────────────────────────────────────────────────────
// Each component instance gets a unique scope. State setters, callbacks, and
// other non-serializable captured vars are stored here by key, retrieved at
// handler execution time — never at queue time.
//
// Server-safety: the scope-mutating exports below are guarded with
// IS_BROWSER. The plugin runs on the server compile too (so SSR HTML can
// carry data-nugget-lazy attributes for the runtime IntersectionObserver to
// observe post-hydration), which means the loader-injected
// __nuggetRegisterRef / __nuggetCreateScope calls execute during render on
// the server. Without the guard they would mutate this module-level Map on
// every request — a per-process memory leak across requests AND an
// ever-growing __scopeCounter shared across unrelated sessions.

const IS_BROWSER = typeof window !== "undefined";
const __nuggetScopes = new Map();
let __scopeCounter = 0;

/** Called by the transformed component on mount (via useRef). */
export function __nuggetCreateScope() {
  if (!IS_BROWSER) return null;
  const id = `ns_${__scopeCounter++}`;
  __nuggetScopes.set(id, new Map());
  return id;
}

/** Called by useEffect cleanup on unmount — prevents stale ref access. */
export function __nuggetDestroyScope(scopeId) {
  if (!IS_BROWSER) return;
  __nuggetScopes.delete(scopeId);
}

/**
 * Called on every render to keep the scope current.
 * For stable refs (useState setters) this is a cheap identity check.
 * For unstable values (non-memoized callbacks) this ensures the scope always
 * holds the latest version.
 *
 * Lazily creates the scope entry if it's missing. This is what makes the
 * loader's register-effect resilient to React 18 StrictMode's dev-only
 * artificial unmount: that unmount fires the cleanup of the destroy effect
 * and removes the scope from the map, but the committed JSX still references
 * the same scope id. When the strict-remount re-fires this effect, we
 * resurrect the scope here so subsequent clicks find it alive.
 */
export function __nuggetRegisterRef(scopeId, key, value) {
  if (!IS_BROWSER || scopeId == null) return;
  let scope = __nuggetScopes.get(scopeId);
  if (!scope) {
    scope = new Map();
    __nuggetScopes.set(scopeId, scope);
  }
  scope.set(key, value);
}

/**
 * Called inside a nugget chunk at execution time.
 * Always returns the current value — never a stale closure capture.
 *
 * NOTE: A return of `null`/`undefined` here is AMBIGUOUS — it may mean
 * "scope is gone" OR "the registered value happens to be null/undefined".
 * Nugget chunks should use __nuggetHasScope() to detect unmount, and treat
 * the deref result as opaque.
 */
export function __nuggetDeref(scopeId, key) {
  const scope = __nuggetScopes.get(scopeId);
  if (!scope) return null;
  return scope.get(key);
}

/**
 * Cheap "is the scope still alive?" check. Used at the top of every nugget
 * chunk so 0 / "" / false / null state values don't get mistaken for the
 * unmount signal.
 */
export function __nuggetHasScope(scopeId) {
  return __nuggetScopes.has(scopeId);
}

// ─── Event Snapshot ──────────────────────────────────────────────────────────
// SyntheticEvents are nullified after the handler returns (React 16) and
// become stale after a tick (React 17+). We snapshot event data immediately
// and call time-sensitive methods (preventDefault) before the async chunk load.

function snapshotEvent(e) {
  if (!e || typeof e !== "object" || typeof e.preventDefault !== "function") {
    return e; // not an event — pass through
  }
  return {
    __isEventSnapshot: true,
    type: e.type,
    key: e.key,
    keyCode: e.keyCode,
    code: e.code,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
    clientX: e.clientX,
    clientY: e.clientY,
    button: e.button,
    target: e.target
      ? {
          value: e.target.value,
          checked: e.target.checked,
          name: e.target.name,
          id: e.target.id,
          tagName: e.target.tagName,
          dataset: e.target.dataset ? { ...e.target.dataset } : {},
        }
      : null,
    currentTarget: e.currentTarget
      ? { value: e.currentTarget.value, name: e.currentTarget.name }
      : null,
    // Preserve method references — the loader hoists these BEFORE the proxy call
    // so by the time we snapshot, the event is still alive for these calls.
    preventDefault: () => e.preventDefault?.(),
    stopPropagation: () => e.stopPropagation?.(),
  };
}

// ─── Event Proxy ─────────────────────────────────────────────────────────────

const __nuggetCache = new Map();   // chunkId → handler fn (loaded and ready)
const __nuggetQueue = new Map();   // chunkId → Array<{ safeArgs, capturedMeta }>
const __nuggetLoading = new Set(); // chunkIds currently fetching

// One retry catches transient failures (Wi-Fi flap, CDN edge cold-start,
// brief deploy gap) without making a permanently-broken chunk feel slow.
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 500;

const __nuggetErrorListeners = new Set();

/**
 * Register a listener that fires whenever a nugget chunk fails to load. The
 * listener is invoked once on the first failure (willRetry=true) and again
 * after the retry, if any, also fails (willRetry=false). Returns an
 * unsubscribe function.
 *
 * @param {(detail: { id: string, error: unknown, attempt: number, willRetry: boolean }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onNuggetLoadError(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("onNuggetLoadError expects a function");
  }
  __nuggetErrorListeners.add(listener);
  return () => __nuggetErrorListeners.delete(listener);
}

function emitNuggetLoadError(detail) {
  for (const fn of __nuggetErrorListeners) {
    try {
      fn(detail);
    } catch (listenerErr) {
      // A buggy listener must not break sibling listeners or the runtime.
      if (process.env.NODE_ENV !== "production") {
        console.error("[nugget] error listener threw:", listenerErr);
      }
    }
  }
  if (IS_BROWSER && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("nugget:load-error", { detail }));
  }
}

function __nuggetAttemptLoad(id, importFn, attempt) {
  importFn()
    .then((mod) => {
      const handler = mod.default;
      __nuggetCache.set(id, handler);
      __nuggetLoading.delete(id);

      // Drain queue — replay all pending invocations in order
      const queued = __nuggetQueue.get(id) ?? [];
      __nuggetQueue.delete(id);
      for (const { safeArgs: qArgs, capturedMeta: qMeta } of queued) {
        handler(qArgs, qMeta);
      }
    })
    .catch((err) => {
      const willRetry = attempt < MAX_RETRIES;
      emitNuggetLoadError({ id, error: err, attempt, willRetry });
      if (process.env.NODE_ENV !== "production") {
        console.error(
          `[nugget] Failed to load handler "${id}" (attempt ${attempt + 1}${willRetry ? ", retrying in " + RETRY_DELAY_MS + "ms" : ", giving up"}):`,
          err
        );
      }
      if (willRetry) {
        setTimeout(
          () => __nuggetAttemptLoad(id, importFn, attempt + 1),
          RETRY_DELAY_MS
        );
        return;
      }
      // Definitive failure — drop the loading bit and the queued events so
      // the user can click again later (e.g., after a deploy that restored
      // the chunk) and trigger a fresh load.
      __nuggetLoading.delete(id);
      __nuggetQueue.delete(id);
    });
}

/**
 * Called by every rewritten JSX event handler prop.
 *
 * @param {string}   id          - Stable handler ID (nugget_onClick_a3f7c9b1)
 * @param {Function} importFn    - () => import('nugget://nugget-a3f7c9b1')
 * @param {any[]}    args        - Raw event args (will be snapshotted)
 * @param {object}   capturedMeta - { scopeId, refs: string[] }
 */
export function __nuggetProxy(id, importFn, args, capturedMeta) {
  // Snapshot events before React nullifies them
  const safeArgs = args.map(snapshotEvent);

  if (__nuggetCache.has(id)) {
    // Already loaded — call synchronously, no queueing
    return __nuggetCache.get(id)(safeArgs, capturedMeta);
  }

  // Queue this invocation
  if (!__nuggetQueue.has(id)) __nuggetQueue.set(id, []);
  __nuggetQueue.get(id).push({ safeArgs, capturedMeta });

  if (__nuggetLoading.has(id)) return; // already fetching, just queued
  __nuggetLoading.add(id);

  __nuggetAttemptLoad(id, importFn, 0);
}

// ─── React Scope Hooks Helper ─────────────────────────────────────────────────
// Convenience export — components can import this instead of wiring manually.
// The Babel transform injects this automatically; direct use is optional.

export function useNuggetScope(refs) {
  // Dynamically require React to avoid making it a hard dependency of the runtime
  const { useRef, useEffect } = require("react");
  const scopeIdRef = useRef(null);

  if (scopeIdRef.current === null) {
    scopeIdRef.current = __nuggetCreateScope();
  }

  // Register/refresh all refs on every render
  for (const [key, value] of Object.entries(refs)) {
    __nuggetRegisterRef(scopeIdRef.current, key, value);
  }

  useEffect(() => {
    return () => __nuggetDestroyScope(scopeIdRef.current);
  }, []);

  return scopeIdRef.current;
}

// ─── IntersectionObserver — Below-fold preload ────────────────────────────────
// Elements with data-nugget-lazy="chunkId" get their chunk preloaded
// when they enter the viewport (200px lookahead).

if (typeof window !== "undefined" && typeof IntersectionObserver !== "undefined") {
  // eslint-disable-next-line no-undef
  const ROOT_MARGIN = typeof __NUGGET_ROOT_MARGIN__ !== "undefined"
    // eslint-disable-next-line no-undef
    ? __NUGGET_ROOT_MARGIN__
    : "200px";
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const chunkId = entry.target.dataset?.nuggetLazy;
        if (!chunkId) continue;

        if (__nuggetCache.has(chunkId) || __nuggetLoading.has(chunkId)) {
          observer.unobserve(entry.target);
          continue;
        }

        // Emit a modulepreload link — browser fetches but doesn't execute.
        // The URL is publicPath + nuggetDir + chunkId.js. The publicPath is
        // resolved at runtime so the plugin works in apps mounted under a
        // non-root path (Next.js serves at "/_next/", Vite previews at "/",
        // etc.). The nuggetDir is injected at build time via DefinePlugin —
        // we read it through a const so DefinePlugin can replace it.
        // eslint-disable-next-line no-undef
        const NUGGET_DIR = typeof __NUGGET_DIR__ !== "undefined"
          // eslint-disable-next-line no-undef
          ? __NUGGET_DIR__
          : "static/nuggets";
        const base =
          typeof __webpack_public_path__ !== "undefined"
            ? __webpack_public_path__
            : "/";
        const dir = NUGGET_DIR.replace(/^\/+|\/+$/g, "");
        const link = document.createElement("link");
        link.rel = "modulepreload";
        link.href = base + dir + "/" + chunkId + ".js";
        document.head.appendChild(link);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: ROOT_MARGIN } // start preload N px before entering viewport
  );

  function observeAll(root = document) {
    root
      .querySelectorAll?.("[data-nugget-lazy]")
      .forEach((el) => observer.observe(el));
  }

  // Initial observation
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => observeAll());
  } else {
    observeAll();
  }

  // Watch for dynamically added elements (SPA navigation, portals)
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) observeAll(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ─── NuggetLazy — sentinel-mounted lazy component ───────────────────────────
// Drop-in replacement for the manual `useState + useRef + useEffect + IO +
// dynamic()` boilerplate consumers would otherwise write to lazy-mount a
// below-fold component. The component itself is React-specific; the rest of
// this module is framework-neutral.
//
// Usage:
//   import { NuggetLazy } from "lazy-handler-webpack-plugin/runtime";
//   <NuggetLazy
//     load={() => import("./Home.BelowFold")}
//     props={{ posts, setPosts }}
//     rootMargin="300px"
//     loading={<div>Loading…</div>}
//     error={(err) => <p>Failed: {String(err)}</p>}
//   />

// Resolved lazily so the runtime can still be consumed in non-React contexts
// for its lower-level exports — the `require` only fires the first time
// NuggetLazy renders.
let __cachedReact = null;
function __getReact() {
  if (__cachedReact) return __cachedReact;
  __cachedReact = require("react");
  return __cachedReact;
}

export function NuggetLazy(props) {
  const React = __getReact();
  const { useState, useEffect, useRef, createElement } = React;
  const {
    load,
    props: childProps,
    rootMargin = "300px",
    loading = null,
    error,
  } = props;

  const [intersected, setIntersected] = useState(false);
  const [Comp, setComp] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const sentinelRef = useRef(null);

  // Stage 1: observe the sentinel and flip `intersected` once it nears the
  // viewport. IO unavailable (SSR or pre-2017 browsers) → mount immediately.
  useEffect(() => {
    if (intersected) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setIntersected(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIntersected(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    if (sentinelRef.current) io.observe(sentinelRef.current);
    return () => io.disconnect();
  }, [intersected, rootMargin]);

  // Stage 2: once intersected, fire the dynamic import. Re-render with the
  // resolved component as soon as it arrives.
  useEffect(() => {
    if (!intersected || Comp || loadError) return undefined;
    let cancelled = false;
    load()
      .then((mod) => {
        if (cancelled) return;
        if (!mod || typeof mod.default !== "function") {
          throw new Error(
            "NuggetLazy: loaded module has no default export (got " +
              typeof (mod && mod.default) +
              ")"
          );
        }
        setComp(() => mod.default);
      })
      .catch((err) => {
        if (cancelled) return;
        if (process.env.NODE_ENV !== "production") {
          console.error("[NuggetLazy] failed to load lazy component:", err);
        }
        setLoadError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [intersected, Comp, loadError, load]);

  if (loadError) {
    return typeof error === "function" ? error(loadError) : null;
  }
  if (Comp) {
    return createElement(Comp, childProps || {});
  }
  if (intersected) {
    // Post-intersection, pre-resolve — render the consumer's loading slot.
    return loading;
  }
  // Pre-intersection — render the sentinel. `min-height: 1px` keeps it from
  // collapsing to zero (zero-height elements never report as intersecting in
  // Chrome until laid out, even if they're inside the viewport).
  return createElement("div", {
    ref: sentinelRef,
    "aria-hidden": "true",
    "data-nugget-lazy-sentinel": "true",
    style: { minHeight: "1px" },
  });
}
