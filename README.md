# lazy-handler-plugin

> Webpack / Rollup / Vite plugin that auto-extracts JSX event handlers into micro-chunks.
> Ships **zero handler JS** until the user triggers an interaction.

Inspired by [Qwik's resumability](https://qwik.dev/docs/concepts/resumable/) and SolidJS's fine-grained reactivity — implemented as a build-time AST transform with thin per-bundler adapters, so it works with **any existing React app (CRA, custom webpack, Next.js App Router, Vite, Rollup)** without migrating to a new framework.

> **Status — 0.1.0 (experimental).** React 18 only. Validated end-to-end against:
> - a custom webpack app ([`examples/test-react-app/`](./examples/test-react-app))
> - a Next.js 14 App Router app ([`examples/test-nextjs-app/`](./examples/test-nextjs-app))
> - a Vite 5 app ([`examples/test-vite-app/`](./examples/test-vite-app))

| Bundler | Adapter export | Status |
|---|---|---|
| Webpack 5 | `lazy-handler-plugin` (default) or `lazy-handler-plugin/webpack` | ✅ |
| Vite 5 | `lazy-handler-plugin/vite` | ✅ |
| Rollup 4 | `lazy-handler-plugin/rollup` | ✅ (same adapter as Vite) |

---

## How It Works

```
User writes normal React JSX
         ↓
LazyHandlerPlugin (Tapable)
         ↓
nugget-loader (Babel AST transform)
   • Finds inline JSX event handler props
   • Extracts handler bodies → virtual nugget modules
   • Rewrites props → dynamic import wrappers
   • Hoists e.preventDefault() before async boundary
         ↓
Webpack chunk splitting
   • Each nugget becomes a separate async chunk (~2–8 KB)
   • Main bundle contains only the proxy stub (~600 bytes runtime)
         ↓
Browser (runtime)
   • User clicks → proxy queues event, fetches chunk
   • Chunk loads → handler runs, queued events replayed
   • IntersectionObserver preloads below-fold chunks
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    BUILD PHASE (Webpack)                     │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌─────────┐ │
│  │ 1.Parse  │──▶│2.Detect  │──▶│3.Extract │──▶│4.Rewrite│ │
│  │ JS Parser│   │onClick…  │   │Virtual   │   │Babel    │ │
│  │ hook     │   │onChange… │   │modules   │   │AST      │ │
│  └──────────┘   └────┬─────┘   └──────────┘   └────┬────┘ │
│                      │                               │      │
│                      ▼                               ▼      │
│               ┌──────────┐                   ┌──────────┐  │
│               │6.Below   │                   │5.Chunk   │  │
│               │  fold    │                   │ split    │  │
│               │IO inject │                   │ async    │  │
│               └──────────┘                   └──────────┘  │
│                                                             │
│  ┌────────────────────────────┐                            │
│  │  LazyHandlerPlugin       │  (Tapable entry point)     │
│  │  normalModuleFactory hook  │                            │
│  │  thisCompilation hook      │                            │
│  │  seal hook                 │                            │
│  │  processAssets hook        │                            │
│  └────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              RUNTIME PHASE (browser, ~600 bytes)            │
│                                                             │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────┐ │
│  │  Event proxy    │  │ IntersectionObs. │  │  Handler  │ │
│  │  Queues events  │  │ Preloads below-  │  │  nuggets  │ │
│  │  while loading  │  │ fold chunks      │  │  2–8 KB   │ │
│  └─────────────────┘  └──────────────────┘  └───────────┘ │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │             Per-instance Scope Registry             │   │
│  │  scope_a1b2 → { setLoading: fn, setResults: fn }   │   │
│  │  scope_c3d4 → { setLoading: fn, setResults: fn }   │   │
│  │  Destroyed on unmount — no stale ref leaks          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Install

```bash
npm install --save-dev lazy-handler-plugin
```

**Peer dependencies** (install if not already present):
```bash
npm install --save-dev @babel/parser @babel/traverse @babel/generator @babel/types
```

---

## Usage

### Standalone Webpack

```js
// webpack.config.js
const path = require("path");
const LazyHandlerPlugin = require("lazy-handler-plugin");

module.exports = {
  // … your existing config
  output: {
    path: path.resolve(__dirname, "dist"),
    // Route nugget chunks to a known directory so the runtime can preload them
    // by URL. Any other chunks keep webpack's normal naming.
    chunkFilename: (pathData) => {
      const name = pathData.chunk && pathData.chunk.name;
      if (name && name.startsWith("nugget-")) {
        return "static/nuggets/[name].js";
      }
      return "static/chunks/[name].[contenthash:8].js";
    },
    publicPath: "/",
  },
  plugins: [
    new LazyHandlerPlugin({
      eventProps: ["onClick", "onSubmit", "onChange", "onKeyDown"],
      minHandlerLines: 3,
      injectRuntime: true,
      belowFoldThreshold: 600,
      nuggetDir: "static/nuggets",
    }),
  ],
};
```

A complete, runnable webpack example lives at
[`examples/test-react-app/`](./examples/test-react-app/).

### Next.js (App Router)

```js
// next.config.js
const LazyHandlerPlugin = require("lazy-handler-plugin");

module.exports = {
  reactStrictMode: true,
  webpack(config, { isServer, dev }) {
    // Handler extraction defeats HMR — skip in dev.
    if (dev) return config;

    // Route nugget chunks to `.next/static/nuggets/` so the runtime preload
    // (publicPath + nuggetDir + chunkId) resolves correctly.
    const originalChunkFilename = config.output.chunkFilename;
    config.output.chunkFilename = (pathData) => {
      const name = pathData.chunk && pathData.chunk.name;
      if (name && name.startsWith("nugget-")) {
        return "static/nuggets/[name].js";
      }
      return typeof originalChunkFilename === "function"
        ? originalChunkFilename(pathData)
        : originalChunkFilename;
    };

    // Run the plugin on BOTH server and client compiles. The server pass
    // doesn't ship the nugget chunks, but it must run the JSX transform so
    // SSR HTML carries the `data-nugget-lazy` attributes for hydration. The
    // runtime's state-mutating functions are guarded with typeof-window so
    // server-side `__nuggetRegisterRef` calls are no-ops.
    config.plugins.push(
      new LazyHandlerPlugin({
        eventProps: ["onClick", "onSubmit", "onChange", "onKeyDown"],
        minHandlerLines: 3,
        injectRuntime: !isServer, // runtime is client-only
        nuggetDir: "static/nuggets",
      })
    );
    return config;
  },
};
```

Components that hold extracted handlers must be **client components** —
the proxy wrappers reference React hooks (`useRef`, `useEffect`). Add
`"use client"` to the top of any file the plugin will touch:

```tsx
"use client";
import { useState } from "react";
// … your component
```

A complete, runnable Next.js example lives at
[`examples/test-nextjs-app/`](./examples/test-nextjs-app/).

### Vite (and pure Rollup)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import lazyHandler from "lazy-handler-plugin/vite";

export default defineConfig({
  plugins: [
    // Order matters: lazyHandler must see raw JSX before plugin-react
    // rewrites it. Its `enforce: "pre"` already ensures this, but listing
    // it first makes the intent obvious.
    lazyHandler({
      eventProps: ["onClick", "onSubmit", "onChange", "onKeyDown"],
      minHandlerLines: 3,
      belowFoldThreshold: 600,
      nuggetDir: "static/nuggets",
    }),
    react(),
  ],
});
```

The adapter:
- Routes `nugget-*` chunks to `<nuggetDir>/[name].js` via the build's
  `rollupOptions.output.chunkFileNames`.
- Injects `__NUGGET_BASE__ = import.meta.env.BASE_URL`, so the runtime
  preload URL respects Vite's `base` config.
- Skips itself during `vite dev` (esbuild, on-demand modules) — handler
  extraction defeats Vite's instant-update model.

For pure Rollup, import from `lazy-handler-plugin/rollup` instead; the
adapter is the same module under both subpaths and the Vite-only hooks
become no-ops.

A complete, runnable Vite example lives at
[`examples/test-vite-app/`](./examples/test-vite-app/).

---

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `eventProps` | `string[]` | `["onClick", "onChange", "onSubmit", …]` | JSX prop names to auto-extract |
| `minHandlerLines` | `number` | `3` | Skip handlers shorter than this |
| `injectRuntime` | `boolean` | `true` | Auto-inject the runtime into the entry bundle |
| `belowFoldThreshold` | `number` | `600` | Pixel offset for below-fold detection |
| `nuggetDir` | `string` | `"static/nuggets"` | Output path for nugget chunks (must match your `output.chunkFilename` mapping) |
| `disabled` | `boolean` | `NODE_ENV === "development"` | Disable entirely (fast HMR in dev) |

The full default `eventProps` list is `onClick, onChange, onSubmit, onBlur,
onFocus, onKeyDown, onKeyUp, onMouseEnter, onMouseLeave, onScroll,
onPointerDown, onDrop, onDragStart`. Pass an explicit array to narrow it.

---

## What Gets Extracted

The plugin only extracts **inline function handlers** — it leaves identifier references alone:

```jsx
// ✅ Extracted — inline arrow function with 3+ lines
onClick={async () => {
  setLoading(true);
  const res = await fetch("/api/data");
  setData(await res.json());
  setLoading(false);
}}

// ✅ Extracted — inline function expression
onClick={function(e) {
  e.preventDefault();
  handleComplexLogic(e.target.value);
  trackAnalytics("submit");
}}

// ✅ Extracted — identifier ref to a named handler declared in the same
// component, provided the binding is referenced ONLY from JSX event-prop
// attributes. The original declaration is removed from the main bundle.
const handleClick = async () => {
  setLoading(true);
  await doWork();
  setLoading(false);
};
// ...later...
<button onClick={handleClick}>Click me</button>

// ❌ Not extracted — too short (below minHandlerLines)
onClick={() => setOpen(true)}

// ❌ Not extracted — `handleClick` is also referenced outside JSX (here
// in a useEffect dep array), so removing the original would break the
// other site. The plugin leaves the declaration alone.
const handleClick = () => doWork();
useEffect(() => { /* uses handleClick */ }, [handleClick]);
<button onClick={handleClick}>Click me</button>

// ❌ Not extracted — useCallback-wrapped handlers (not yet supported)
const handleClick = useCallback(() => { ... }, []);

// ❌ Not extracted — member expressions (this.method, obj.method)
onClick={this.handleClick}

// ❌ Not extracted — imported handlers (already live in another module's
// bundle; moving them around makes the chunk graph confusing)
import { handleClick } from "./handlers";
onClick={handleClick}
```

---

## Transform Example

**You write:**
```jsx
function BuyButton({ productId }) {
  const [loading, setLoading] = useState(false);

  return (
    <button onClick={async () => {
      setLoading(true);
      await addToCart(productId);
      setLoading(false);
    }}>
      Add to cart
    </button>
  );
}
```

**Plugin emits (main bundle):**
```jsx
// Handler is gone from the main bundle — replaced with a small proxy stub.
<button
  data-nugget-lazy="nugget-a3f7c9"
  onClick={(...__nuggetRest) =>
    __nuggetProxy(
      "nugget_onClick_a3f7c9",
      () => import(/* webpackChunkName: "nugget-a3f7c9" */ "nugget://nugget-a3f7c9"),
      [...__nuggetRest],
      { scopeId: __scopeId, refs: ["setLoading"] }
    )
  }
>
  Add to cart
</button>
```

**Plugin emits (separate chunk, ~3KB, loads on first click):**
```js
// static/nuggets/nugget-a3f7c9.js
import { __nuggetDeref, __nuggetHasScope } from "lazy-handler-plugin/runtime";

export default async function nugget_onClick_a3f7c9(args, { scopeId }) {
  if (!__nuggetHasScope(scopeId)) return; // component unmounted
  const setLoading = __nuggetDeref(scopeId, "setLoading");
  const handler = async () => {
    setLoading(true);
    await addToCart(productId); // productId was a primitive — inlined
    setLoading(false);
  };
  return handler(...args);
}
```

---

## Closure & State Handling

### State setters (`useState`, `useReducer`)
Stored in a per-instance scope registry. Dereferenced at execution time — always gets the current setter, never a stale closure. Cleaned up automatically on unmount.

### Library imports (`marked`, `date-fns`, etc.)
The loader detects when an imported identifier is referenced *only* inside an extracted handler and **re-imports it from inside the nugget chunk**. The static import in the main file is pruned, so the library ships in the nugget — not the main bundle. In the included example apps, this moves `marked` (~30 KB) off the critical path entirely.

### Primitive captures (strings, numbers, booleans)
Inlined directly into the nugget file. No runtime overhead.

### `e.preventDefault()` / `e.stopPropagation()`
Detected at build time as **top-level statements of the handler body** and **hoisted before the async boundary** — called synchronously before the chunk fetch starts, so browser default behavior is still preventable. Nested calls (e.g. inside `setTimeout`) are deliberately **not** hoisted; that would re-order side effects. The wrapper preserves the original handler's parameter binding so `e` resolves at runtime.

### Object / array / function captures
Treated exactly like state setters: registered into the per-instance scope registry on every render, dereferenced inside the nugget at execution time. The loader does not inspect the captured value's shape — a `config` object, a `prices` array, and a `setCount` function all flow through the same path. There is no extraction-skip path and no build warning for these today.

Because the nugget reads the registry at *click time*, not at render time, it always sees the **latest** value — even if the user clicked while a previous render's value was still on screen. For state setters this is what you want; for objects whose identity matters (e.g. a value the handler later passes to a `useMemo` key) this means the chunk's network latency can delay observed identity changes by one paint. In practice this only matters for handlers that hand a captured object straight back to React.

### JSX spread attributes are not seen
The loader walks `JSXAttribute` nodes only. Handlers passed via `<button {...handlers} />` are invisible to extraction and ship inline in the main bundle. If you rely on prop spreading for handlers, name them explicitly on the JSX element for the plugin to extract them.

### React 18 `<React.StrictMode>` compatibility

The loader emits scope wiring that survives StrictMode's dev-only artificial unmount-remount cycle. Three pieces matter:

1. **Lazy `useRef` init for the scope id.** Earlier versions called `__nuggetCreateScope()` as the argument to `useRef(...)`, which evaluated on every render and leaked one scope per render. The current form is idempotent across renders:

   ```js
   const __scopeRef = useRef(null);
   if (__scopeRef.current === null) __scopeRef.current = __nuggetCreateScope();
   const __scopeId = __scopeRef.current;
   ```

2. **Dual register — render body + `useEffect` with no deps.** StrictMode dev mode commits the second render pass, fires the destroy effect's cleanup during the artificial unmount (which deletes the scope), and then re-runs effects during the artificial remount. The committed JSX still holds the closure scope id, so the second register call resurrects the scope:

   ```js
   // Synchronous render-body register, placed right before return
   __nuggetRegisterRef(__scopeId, "setX", setX);

   // Re-installs on every render — also after StrictMode's artificial remount
   useEffect(() => {
     __nuggetRegisterRef(__scopeId, "setX", setX);
   });
   ```

3. **`__nuggetRegisterRef` lazy-creates the scope entry.** This is what makes step 2 work after the destroy cleanup has wiped the scope from the registry — the next register effect re-fires and re-creates the entry with the current values.

The combination means the plugin is correct under StrictMode dev double-mount **and** in production (no double-mount), with no per-render scope leak in either path. The one residual is StrictMode dev mode: pass-1 of the initial mount creates a scope that is never destroyed (no effect runs for the discarded pass). That's a one-scope-per-mount leak visible only in dev, not in production.

---

## Runtime API

The runtime exposes two public APIs that consumers can import directly. Everything else (the `__nugget*` symbols) is wired by the loader and not part of the API surface.

### `<NuggetLazy>` — sentinel-mounted lazy component

A drop-in replacement for the manual `useState + useRef + useEffect + IntersectionObserver + React.lazy` pattern most apps end up writing to defer a below-fold section.

```tsx
import { NuggetLazy } from "lazy-handler-plugin/runtime";

<NuggetLazy
  load={() => import("./Home.BelowFold")}
  props={{ posts, setPosts }}
  rootMargin="300px"
  loading={<div>Loading…</div>}
  error={(err) => <p>Failed: {String(err)}</p>}
/>
```

SSR-safe: on the server it renders the sentinel placeholder; hydration matches; the intersection effect fires client-side only.

### `onNuggetLoadError(listener)` — chunk-fetch failure hook

Subscribe to failed nugget loads — typically for telemetry / error reporting. The runtime retries once after 500 ms before declaring a definitive failure; the listener fires on both the initial failure (`willRetry: true`) and the final one (`willRetry: false`).

```ts
import { onNuggetLoadError } from "lazy-handler-plugin/runtime";

const unsubscribe = onNuggetLoadError(({ id, error, willRetry }) => {
  if (willRetry) return; // skip transient blips
  Sentry.captureException(error, { tags: { handlerId: id } });
});
```

The runtime also dispatches a `nugget:load-error` `CustomEvent` on `window` with the same detail shape, for tools that listen to window events directly.

---

## Comparison

| Feature | This Plugin | Qwik | Astro Islands |
|---|---|---|---|
| Per-handler lazy loading | ✅ | ✅ native | ❌ |
| Works with existing React | ✅ | ❌ | ❌ |
| No framework migration | ✅ | ❌ | ❌ |
| Full closure serialization | ⚠️ partial | ✅ | N/A |
| Server resumability | ❌ | ✅ | partial |
| Maturity | 🧪 experimental | ✅ production | ✅ production |

---

## Limitations

The following are known sharp edges in 0.1.0. They are *not* bugs to file — they're choices we made to keep the loader small and predictable. We'll revisit them as the API stabilizes.

1. **React 18 only.** React 17 is untested. esbuild has no adapter (it doesn't expose the transform-pipeline hooks the loader needs).
2. **JSX spread props aren't extracted.** The loader matches `JSXAttribute` nodes — `<button {...handlers} />` slips past it. Name handlers explicitly on the element to make them extractable.
3. **`useCallback`-wrapped handlers aren't extracted.** The named-handler path looks for a function-shaped initializer (`const x = () => ...` or `function x() {...}`); a `CallExpression` wrapping the function — `const x = useCallback(() => ..., [])` — isn't recognized. Unwrap the function or accept that this handler won't be lazy.
4. **Captures are always read at click time, not bind time.** Object / array / function captures flow through the per-component scope registry and resolve to whatever was registered on the most recent render. If your handler's correctness depends on the *original* identity of a captured value, this plugin is the wrong tool — wrap that value in a `useRef` and read `.current` yourself.
5. **Handlers must live inside named React components.** The loader injects `useRef` / `useEffect` into the enclosing function. If that function isn't a React component (e.g. a render helper called like a plain function), the injected hooks will throw "Invalid hook call" at runtime. Components that follow the standard `function Foo() { … }` / `const Foo = () => { … }` shape are safe.
6. **Persistent bundler caching can stale-out the registry.** The plugin's source registry is rebuilt at each compile; if webpack/Vite restores a JSX module from its filesystem cache without re-running the loader, the `nugget://...` import in that module has no registered source and the build will fail with `No registered source for "..."`. Until we persist the registry alongside the bundler's module cache, disable filesystem caching (`cache: false` in webpack, drop `node_modules/.vite` between Vite builds) for builds that include this plugin.
7. **Default-disabled in development.** For the webpack adapter, `NODE_ENV === "development"` short-circuits the loader so HMR stays fast. The Vite adapter is always disabled in `vite dev` (esbuild path) and active in `vite build`. Force-enable webpack with `disabled: false` if you specifically want to test extraction locally.
8. **`preventDefault` hoisting only fires for the first statements of the handler body.** Branched or nested `e.preventDefault()` calls are left in place inside the handler chunk — which means they execute *after* the async fetch resolves. If sync prevention matters, keep the call as the first line of the handler.
9. **Destructuring patterns in handler params disable hoisting.** `onClick={({ target }) => { … }}` works, but a `preventDefault` inside it won't be hoisted. Use `onClick={(e) => { e.preventDefault(); … }}` for the hoist to apply.

---

## Project Structure

```
lazy-handler-plugin/
├── src/
│   ├── core/                            # bundler-agnostic
│   │   ├── transform.js                 # Babel AST transform — handler extraction
│   │   └── registry.js                  # build-time nugget registry (singleton)
│   ├── adapters/
│   │   ├── webpack/
│   │   │   ├── index.js                 # Tapable plugin — Webpack integration
│   │   │   └── loader.js                # thin loader shim → core.transform
│   │   └── rollup/
│   │       └── index.js                 # Rollup/Vite plugin → core.transform
│   └── runtime/
│       ├── nugget-runtime.js            # Browser runtime (~600 bytes gzipped)
│       └── nugget-runtime.d.ts          # Public typings (NuggetLazy / onNuggetLoadError)
├── examples/
│   ├── test-react-app/                  # Custom-webpack React 18 demo
│   ├── test-nextjs-app/                 # Next.js 14 App Router demo
│   ├── test-vite-app/                   # Vite 5 + React 18 demo
│   ├── webpack.config.js                # Minimal webpack config snippet
│   └── SearchBox.jsx                    # Inline before/after of the transform
└── package.json
```

---

## License

MIT
