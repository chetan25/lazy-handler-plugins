// src/adapters/rollup/index.js
// Rollup / Vite adapter. Works in:
//   * plain Rollup (the Vite-only hooks degrade to no-ops),
//   * Vite production builds (which use Rollup under the hood),
//   * Vite dev (which uses esbuild) — we short-circuit and pass through,
//     since handler extraction defeats Vite's on-demand module rewrites.
//
// Wires the bundler-neutral core transform into Rollup's plugin API:
//   buildStart   → clear registry
//   resolveId    → map `nugget:...` → virtual id we own
//   load         → serve registered nugget source for those ids
//   transform    → run JSX/TSX through the core
//   generateBundle → emit nugget-manifest.json
//
// The runtime is auto-prepended to every JSX/TSX module via the core's
// own import injection — same shape as the webpack adapter — so no
// separate entry-injection step is needed here.
"use strict";

const path = require("path");
const { nuggetTransform } = require("../../core/transform");
const nuggetRegistry = require("../../core/registry");

const DEFAULT_OPTIONS = {
  eventProps: [
    "onClick", "onChange", "onSubmit", "onBlur", "onFocus",
    "onKeyDown", "onKeyUp", "onMouseEnter", "onMouseLeave",
    "onScroll", "onPointerDown", "onDrop", "onDragStart",
  ],
  minHandlerLines: 3,
  injectRuntime: true,
  belowFoldThreshold: 600,
  nuggetDir: "static/nuggets",
  disabled: false,
};

// Rollup convention for virtual modules: prefix with a null byte so no
// resolver tries to re-handle the id later in the plugin chain.
//
// IMPORTANT: append a `.js` suffix to the virtual id. Without it:
//   * Rollup's chunk-emit path complains when computing default chunk
//     filenames for an extensionless facade.
//   * Vite's esbuild-driven import analyzer treats the module as an unknown
//     asset and skips parsing its source — bare-string `import` lines in
//     the nugget chunk go un-resolved and references to "lazy-handler-
//     plugin/runtime" or to the user's relative deps fail to bind.
// Adding `.js` makes the id look like a real JS module to every downstream
// consumer; we strip both the prefix and the suffix in load() to recover
// the chunk name we registered.
const VIRTUAL_PREFIX = "\0nugget:";
const VIRTUAL_SUFFIX = ".js";

function virtualIdFor(chunkName) {
  return VIRTUAL_PREFIX + chunkName + VIRTUAL_SUFFIX;
}

function chunkNameFromVirtualId(id) {
  return id.slice(VIRTUAL_PREFIX.length, id.length - VIRTUAL_SUFFIX.length);
}

function isJsxLike(id) {
  // Strip query strings (Vite appends ?vue-style ones, e.g. ?import).
  const clean = id.split("?")[0];
  return /\.(jsx|tsx)$/.test(clean);
}

function isUserCode(id) {
  return !id.includes("node_modules") && !id.startsWith("\0");
}

module.exports = function lazyHandlerRollup(userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  let isViteDevServer = false;

  return {
    name: "lazy-handler-plugin",

    // Run before Vite's own JSX transform so the loader sees raw source.
    enforce: "pre",

    // ── Vite-only hook: detect dev vs build, inject defines ────────────────
    // Pure Rollup ignores this hook silently. We track isViteDevServer for
    // diagnostics only — the `disabled` option is the sole gate on whether
    // extraction runs.
    config(config, env) {
      isViteDevServer = env && env.command === "serve";

      // Make build-time constants available to the runtime. Vite's `define`
      // does a straight text replacement.
      //
      // For the public base path we resolve `config.base` (or default "/")
      // and substitute a string literal — NOT `import.meta.env.BASE_URL`.
      // The latter would feed back into Vite's env-replacement pass, but
      // Vite skips env replacement for files served from `node_modules`,
      // and our runtime lives there (via the package's symlink). The
      // un-replaced `import.meta.env.BASE_URL` then crashed at runtime
      // with "Cannot read properties of undefined (reading 'BASE_URL')"
      // because `import.meta.env` was undefined in the preview bundle.
      const resolvedBase = (config && config.base) || "/";
      const isDev = env && env.command === "serve";
      const define = {
        __NUGGET_DIR__: JSON.stringify(options.nuggetDir),
        __NUGGET_ROOT_MARGIN__: JSON.stringify(`${options.belowFoldThreshold}px`),
        __NUGGET_BASE__: JSON.stringify(resolvedBase),
        // In Vite dev, nugget chunks are served only as virtual modules at
        // `/@id/__x00__nugget:...` URLs, NOT at the production URL shape
        // `<base><nuggetDir>/<chunkName>.js`. The IntersectionObserver
        // preload would otherwise 404-spam the console with the prod URLs.
        // Setting __NUGGET_DEV__ tells the runtime to skip preloading and
        // wait for the actual click-driven dynamic import (which Vite's
        // resolveId resolves correctly).
        __NUGGET_DEV__: JSON.stringify(!!isDev),
      };

      return {
        define: { ...(config.define || {}), ...define },
        build: {
          ...(config.build || {}),
          rollupOptions: {
            ...((config.build && config.build.rollupOptions) || {}),
            output: {
              ...((config.build &&
                config.build.rollupOptions &&
                config.build.rollupOptions.output) || {}),
              // Route nugget chunks to nuggetDir/<chunkName>.js so the
              // runtime's modulepreload URL resolves. We match by the
              // facade module id rather than chunk name because Rollup
              // mangles virtual-id names before chunkFileNames runs.
              chunkFileNames: (chunkInfo) => {
                const id = chunkInfo.facadeModuleId || "";
                if (id.startsWith(VIRTUAL_PREFIX) && id.endsWith(VIRTUAL_SUFFIX)) {
                  const chunkName = chunkNameFromVirtualId(id);
                  return `${options.nuggetDir}/${chunkName}.js`;
                }
                const existing =
                  (config.build &&
                    config.build.rollupOptions &&
                    config.build.rollupOptions.output &&
                    config.build.rollupOptions.output.chunkFileNames) ||
                  "assets/[name]-[hash].js";
                return typeof existing === "function"
                  ? existing(chunkInfo)
                  : existing;
              },
            },
          },
        },
      };
    },

    buildStart() {
      if (options.disabled) return;
      // Reset shared state at the top of every build.
      nuggetRegistry.clear();
    },

    // ── Vite HMR: drop stale registry entries for changed JSX files ────────
    // In dev (vite serve), buildStart only fires once at server startup, so
    // the registry would otherwise grow unbounded as edits accumulate. When
    // a JSX/TSX file changes, drop every nugget registered against it; the
    // re-transform that follows will re-register fresh entries with the new
    // hashes. Other files' nuggets are left alone.
    handleHotUpdate(ctx) {
      if (options.disabled) return;
      if (!isJsxLike(ctx.file)) return;
      const registry = nuggetRegistry.getAll();
      for (const [id, meta] of Object.entries(registry)) {
        if (meta.sourceFile === ctx.file) {
          nuggetRegistry.removeById(id);
        }
      }
    },

    resolveId(id) {
      if (options.disabled) return null;
      // Source emits `nugget:<chunkName>` (single colon, no `//`). The
      // double-slash form `nugget://...` was previously matched by Vite's
      // `isExternalUrl` heuristic (`^([a-z]+:)?\/\/`), which short-circuited
      // plugin resolution and caused the dev server to ship the literal URL
      // to the browser — fetch failed with an unknown-scheme/CORS error.
      // The single-colon form (RFC-3986 opaque) skips that heuristic.
      if (!id.startsWith("nugget:")) return null;
      // Strip the scheme and own the rest as a `.js`-suffixed virtual id.
      const chunkName = id.slice("nugget:".length);
      return virtualIdFor(chunkName);
    },

    load(id) {
      if (options.disabled) return null;
      if (!id.startsWith(VIRTUAL_PREFIX) || !id.endsWith(VIRTUAL_SUFFIX)) return null;
      const chunkName = chunkNameFromVirtualId(id);
      const meta = nuggetRegistry.getByChunk(chunkName);
      if (!meta || typeof meta.source !== "string") {
        this.error(
          `[LazyHandler] No registered source for "${chunkName}". ` +
            `The core transform did not register this nugget — possibly a stale chunk reference.`
        );
        return null;
      }
      // moduleSideEffects: "no-treeshake" — the nugget exports a default
      // function the bundler can't see being called (it's reached only via
      // dynamic import at runtime). Without this hint Rollup may treat the
      // module as side-effect-free, prune unreferenced helpers it imports,
      // and produce a stub chunk. Forcing inclusion keeps the body intact.
      return { code: meta.source, map: null, moduleSideEffects: "no-treeshake" };
    },

    transform(code, id) {
      // `disabled` is the only gate. Vite users who want fast HMR can pass
      // `disabled: command === 'serve'` from their vite.config; users who
      // want extraction in dev (parity testing, profiling) leave it off.
      if (options.disabled) return null;
      if (!isJsxLike(id) || !isUserCode(id)) return null;

      const filePath = id.split("?")[0];
      const result = nuggetTransform(code, filePath, {
        eventProps: options.eventProps,
        minHandlerLines: options.minHandlerLines,
      });
      // No handlers matched → core returned the input verbatim. Skip to let
      // other transforms run unchanged.
      if (result.code === code) return null;
      return result;
    },

    generateBundle() {
      if (options.disabled) return;
      const registry = nuggetRegistry.getAll();
      const manifest = {
        version: 1,
        nuggetDir: options.nuggetDir,
        handlers: Object.fromEntries(
          Object.entries(registry).map(([id, meta]) => [
            id,
            {
              chunk: `${options.nuggetDir}/${meta.chunkName}.js`,
              sourceFile: meta.sourceFile,
              prop: meta.prop,
            },
          ])
        ),
      };
      this.emitFile({
        type: "asset",
        fileName: "nugget-manifest.json",
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
};
