// src/adapters/rollup/index.js
// Rollup / Vite adapter. Works in:
//   * plain Rollup (the Vite-only hooks degrade to no-ops),
//   * Vite production builds (which use Rollup under the hood),
//   * Vite dev (which uses esbuild) — we short-circuit and pass through,
//     since handler extraction defeats Vite's on-demand module rewrites.
//
// Wires the bundler-neutral core transform into Rollup's plugin API:
//   buildStart   → clear registry
//   resolveId    → map `nugget://...` → virtual id we own
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
// resolver tries to re-handle the id later in the plugin chain. We strip
// it again in `load` to recover the chunk name.
const VIRTUAL_PREFIX = "\0nugget:";

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
  let isProduction = true;

  return {
    name: "lazy-handler-plugin",

    // Run before Vite's own JSX transform so the loader sees raw source.
    enforce: "pre",

    // ── Vite-only hook: detect dev vs build, inject defines ────────────────
    // Pure Rollup ignores this hook silently.
    config(config, env) {
      isViteDevServer = env && env.command === "serve";
      isProduction = !isViteDevServer;

      // Make build-time constants available to the runtime. Vite's `define`
      // does a straight text replacement, so we pass JS-expression strings
      // — the resulting source then references valid Vite globals
      // (`import.meta.env.BASE_URL`) or static literals.
      const define = {
        __NUGGET_DIR__: JSON.stringify(options.nuggetDir),
        __NUGGET_ROOT_MARGIN__: JSON.stringify(`${options.belowFoldThreshold}px`),
        __NUGGET_BASE__: "import.meta.env.BASE_URL",
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
              // mangles virtual-id names (\0nugget:nugget-abc becomes
              // _nugget_nugget-abc) before chunkFileNames is called.
              chunkFileNames: (chunkInfo) => {
                const id = chunkInfo.facadeModuleId || "";
                if (id.startsWith(VIRTUAL_PREFIX)) {
                  const chunkName = id.slice(VIRTUAL_PREFIX.length);
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

    resolveId(id) {
      if (options.disabled) return null;
      if (!id.startsWith("nugget://")) return null;
      // Strip the scheme and own the rest as a virtual id.
      return VIRTUAL_PREFIX + id.slice("nugget://".length);
    },

    load(id) {
      if (options.disabled) return null;
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      const chunkName = id.slice(VIRTUAL_PREFIX.length);
      const meta = nuggetRegistry.getByChunk(chunkName);
      if (!meta || typeof meta.source !== "string") {
        this.error(
          `[LazyHandler] No registered source for "${chunkName}". ` +
            `The core transform did not register this nugget — possibly a stale chunk reference.`
        );
        return null;
      }
      return { code: meta.source, map: null };
    },

    transform(code, id) {
      if (options.disabled) return null;
      if (isViteDevServer) return null;
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
