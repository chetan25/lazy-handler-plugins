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
| `minHandlerLines` | `number` | `3` | Skip handlers shorter than this. Bypassed when `extractInlineFunctions` is on. |
| `extractInlineFunctions` | `boolean` | `false` | **Opt-in.** When `true`, ANY JSX attribute (not just `eventProps`) with an inline arrow/function value is a candidate, and the gate becomes "must capture at least one import or one same-file local function." Handlers whose only captures are props or plain state values are skipped. See [Opt-in: extractInlineFunctions](#opt-in-extractinlinefunctions). |
| `injectRuntime` | `boolean` | `true` | Auto-inject the runtime into the entry bundle |
| `belowFoldThreshold` | `number` | `600` | Pixel offset for below-fold detection |
| `nuggetDir` | `string` | `"static/nuggets"` | Output path for nugget chunks (must match your `output.chunkFilename` mapping) |
| `disabled` | `boolean` | webpack: `NODE_ENV === "development"`  ·  Vite/Rollup: `false` | Skip extraction entirely. See [Development mode](#development-mode). |

The full default `eventProps` list is `onClick, onChange, onSubmit, onBlur,
onFocus, onKeyDown, onKeyUp, onMouseEnter, onMouseLeave, onScroll,
onPointerDown, onDrop, onDragStart`. Pass an explicit array to narrow it.

---

## Development mode

The plugin works in dev for both bundlers, but the **defaults differ on purpose** because dev priorities differ (fast HMR vs production-parity testing).

### Behavior matrix

| Bundler | Default in dev | How to flip it |
|---|---|---|
| Webpack 5 (`webpack-dev-server`, `webpack --watch`) | **Disabled** — handlers ship inline, HMR is fast. | Pass `disabled: false` to the plugin constructor to extract in dev too. |
| Vite 5 (`vite dev`) | **Enabled** — handlers are extracted, dynamic-imported, and served by the Vite dev server as virtual modules. | Pass `disabled: command === 'serve'` from your `vite.config.ts` to skip extraction during `vite dev` while keeping it on for `vite build`. |
| Rollup 4 (`rollup -w`) | **Enabled** — same path as Vite production builds. | Pass `disabled: process.env.NODE_ENV !== 'production'` if you want to opt out. |

### How it works under the hood

In dev:
- The **Babel transform** runs on every JSX/TSX module the bundler asks us to process — same as production. Handlers get rewritten to proxy stubs; the registry is filled as transforms happen.
- For Vite, the dev server resolves our null-byte virtual id (`\0nugget:nugget-abc.js`) and exposes it at `/@id/__x00__nugget:nugget-abc.js`. The browser fetches it on first interaction.
- For webpack with `disabled: false`, `webpack-dev-server` serves the emitted chunk from its in-memory filesystem at `<publicPath>/static/nuggets/nugget-abc.js`.

On rebuild / HMR:
- **Webpack**: `compiler.hooks.watchRun` re-clears the registry, the loader re-runs on changed files, fresh hashes register, dev-server hot-replaces.
- **Vite**: `handleHotUpdate` evicts the changed file's registry entries, then `transform` re-runs and re-registers. Other files' nuggets are untouched.

### When to enable dev extraction

Lean toward leaving it **on for Vite** (the default) and **off for webpack** (the default) unless you have a specific reason to flip either:

- **Turn it on in webpack dev** when you're profiling click-to-first-paint latency, debugging the runtime's `__nuggetProxy` / `IntersectionObserver`, or testing in StrictMode and want production-shape modules served locally.
- **Turn it off in Vite dev** when you're iterating heavily on handler bodies — see the HMR caveat below.

### Caveats

These apply to either bundler when extraction is **on in dev**:

1. **Click latency on first interaction.** Each handler's first click waits for a single small chunk to fetch from the dev server. On localhost this is typically <10 ms; on a throttled-network DevTools profile it can be visible.
2. **HMR + hash-stable chunk names.** When you edit a handler's body, its content hash changes. The proxy stub now points at a *new* virtual id. The registry's old entry is dropped (Vite: via `handleHotUpdate`; webpack: via `watchRun`). The browser may briefly hold the old import URL after HMR if React's reconciler kept the old element — first click after save can show a 404 in the console; full reload always clears it.
3. **Source-map indirection.** Stepping into a handler from DevTools lands you in the synthesized nugget chunk (with the original body text, but no JSX attribute context). The original JSX `onClick={…}` site is replaced by the proxy stub. If you're chasing a handler bug, set a breakpoint in the *nugget chunk* not the source file.
4. **Persistent caching can stale-out the registry.** Webpack's `cache: { type: 'filesystem' }` and Vite's `node_modules/.vite` can skip the loader/transform on cached modules. Without the transform running, the registry has no entry for that file's `nugget://…` import, and the build fails with `No registered source for "…"`. Workaround: keep filesystem caching off when dev extraction is on, or delete the cache between sessions.

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

### Defensive guards (always on)

The plugin is conservative: when in doubt, it leaves the handler inline so
the app's behavior is preserved exactly. A candidate handler stays inline
when **any** of these are true — independent of `eventProps`,
`minHandlerLines`, or `extractInlineFunctions`:

- **Handler body contains JSX.** Nugget chunks bypass all loaders; JSX
  inside one would fail to parse and break the build. Hoist the inner JSX
  to a sibling component instead.
- **Handler lives inside a non-component callback** — `.map`, `.filter`,
  `.forEach`, or any function whose parent is a `CallExpression`. Injecting
  `useRef` / `useEffect` into that callback would trigger React's
  "Invalid hook call". Wrap the row in its own component (see
  [Recommendations](#recommendations)).
- **Handler uses `this`** at the top level (outside any nested function).
  After extraction, `this` resolves to `undefined` in the nugget module
  and behavior would silently change.
- **Handler is a generator** (`function* () {}`). The wrapper rebuild
  emits a plain arrow and would drop the generator semantics.
- **Captures reach outside the component's scope chain** — e.g. a `const`
  declared inside a nested helper function. The scope registry has no way
  to wire those through from the component body.
- **The enclosing function isn't recognizable as a component.** A function
  qualifies when its name is PascalCase, it's the default export, or it's
  wrapped in `memo` / `forwardRef` / `observer` / `lazy` (or their
  member-access forms like `React.memo`).

If a handler you expected to be extracted isn't, the manifest
(`nugget-manifest.json` next to your build output) will simply not list
it. The plugin emits no warning so it stays silent on intentional skips,
but you can grep the main bundle for the handler body to confirm it
shipped inline.

---

## Opt-in: `extractInlineFunctions`

The default mode only looks at `eventProps`. Turning on
`extractInlineFunctions` extends extraction in two ways:

1. **Scope widens to every JSX attribute.** Render props, custom callback
   props like `formatValue`, `renderRow`, `onCustomEvent`, anything with an
   inline arrow / function expression value is now a candidate.
2. **Gate switches from "length" to "captures a dep worth deferring."**
   The `minHandlerLines` heuristic is bypassed. Instead, the handler must
   capture at least one import OR one same-file local function (a
   `function decl`, a `const fn = () => …`, or a `const fn = function(){}`).
   Handlers whose captures are **only** props, only `useState` values, or
   only state setters are skipped — the proxy + chunk overhead would cost
   more bytes than they save.

```jsx
import { formatDate } from "date-fns";

function ItemRow({ item, onItemClick }) {
  const validate = (v) => v.length > 3;

  return (
    <Card
      // ✅ Extracted — captures `formatDate` (import).
      formatter={(v) => formatDate(v)}

      // ✅ Extracted — captures `validate` (local function).
      onBeforeSubmit={() => validate(item.name)}

      // ❌ Skipped — only captures `onItemClick` (prop).
      onActivate={() => onItemClick(item)}

      // ❌ Skipped — only captures state-shape values; nothing heavy to defer.
      onReset={() => { setX(0); setY(0); setZ(0); }}
    />
  );
}
```

Named-reference extraction (`onClick={handleX}`) stays scoped to
`eventProps` even when this option is on. The safety check that the
binding is referenced nowhere else only knows about event prop names; the
risk of removing a declaration referenced by some custom non-event prop
is too high.

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

## Recommendations

These tips help the plugin find more handlers to extract and keep builds
fast. None of them require you to abandon idiomatic React.

### Get more handlers extracted

- **Lift inline JSX out of handlers.** A handler that builds JSX inside
  itself (`setModal(<Confirm/>)`) is skipped because the nugget chunk would
  contain JSX that no loader will transform. Hoist the JSX into a sibling
  component or a separate constant; the handler is then a plain function
  call and becomes eligible.

- **Wrap rows in their own component instead of inlining handlers in
  `.map`.** The plugin can't extract a handler created inside a `.map`
  callback (hooks injection would crash). Hoist the iteration body:

  ```jsx
  // Before — handler made per iteration, not extracted
  {items.map(item => (
    <li onClick={() => doHeavyThing(item)}>{item.name}</li>
  ))}

  // After — Row is a component, handler IS extracted
  function Row({ item }) {
    return <li onClick={() => doHeavyThing(item)}>{item.name}</li>;
  }
  // …
  {items.map(item => <Row key={item.id} item={item} />)}
  ```

- **Move helpers you call from handlers to module level.** Helpers
  declared inside the component re-allocate on every render. Hoisting
  them to the module turns them into imports — first-class citizens of
  both the default extraction path and the new `extractInlineFunctions`
  filter.

- **Name components in PascalCase** and either export them or wrap them in
  `memo` / `forwardRef`. That naming is how the plugin recognizes "this
  function is a safe place to inject hooks."

- **Don't rely on JSX spread for handlers.** `<button {...handlers}/>`
  hides the prop name from the AST walker; those handlers stay inline.
  Name them on the element you want extracted.

- **Drop `useCallback` from handlers that don't need stable identity.**
  Wrapped handlers are skipped — the wrapper is intentionally read as
  "the author wants this exact identity." The proxy stub the plugin emits
  is itself stable enough for most reference-equality cases (it's the same
  function across renders).

- **Avoid `this` inside event handlers.** Modern React rarely needs it; if
  you have a class component pattern, refactor the handler to read state /
  props directly. Handlers using `this` are skipped.

### Get faster builds

- **Trim `eventProps` to the events you actually use.** A shorter list
  means fewer JSX attributes inspected per file. The default covers the
  React DOM event surface; remove what you don't need.

- **Keep `minHandlerLines` realistic for your codebase.** Lowering it to 1
  (default mode) extracts every single-line handler — those usually cost
  more in proxy/chunk overhead than they save. Under
  `extractInlineFunctions: true` the length gate is already bypassed, so
  there's no reason to touch `minHandlerLines` in that mode.

- **Watch `nugget-manifest.json`.** Emitted alongside your build, it lists
  every registered handler with its source file and prop name. It's the
  fastest way to confirm an extraction landed where you expected — and to
  spot files that contribute disproportionately many small handlers
  (often a sign the file should split into smaller components).

- **Disable filesystem caching while iterating.** Both webpack's
  `cache: { type: 'filesystem' }` and Vite's `node_modules/.vite` can skip
  the loader on cached modules. Without the loader running, the nugget
  registry has no entry for that file and the build fails with
  `No registered source for "…"`. See the Caveats under
  [Development mode](#development-mode).

- **Leave webpack dev extraction off (the default).** Inline handlers are
  much friendlier to HMR. Only flip `disabled: false` when you're
  specifically profiling production-shape behavior.

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
7. **Default behaviour in dev differs by bundler.** Webpack is off by default in `NODE_ENV === "development"`; Vite/Rollup are on by default in `vite dev` and `rollup -w`. Both are configurable via `disabled`. See [Development mode](#development-mode) for caveats and recipes.
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
