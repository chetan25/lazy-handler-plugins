// src/adapters/webpack/index.js
"use strict";

const nuggetRegistry = require("../../core/registry");

const DEFAULT_OPTIONS = {
  // JSX event prop names to auto-extract
  eventProps: [
    "onClick", "onChange", "onSubmit", "onBlur", "onFocus",
    "onKeyDown", "onKeyUp", "onMouseEnter", "onMouseLeave",
    "onScroll", "onPointerDown", "onDrop", "onDragStart",
  ],
  // Skip handlers with fewer lines than this (leave trivial one-liners inline)
  minHandlerLines: 3,
  // Automatically inject the nugget runtime (~600 bytes) into the entry bundle
  injectRuntime: true,
  // Pixel threshold — components rendered below this offset get data-nugget-lazy
  belowFoldThreshold: 600,
  // Output path for nugget chunks (relative to Webpack output.path)
  nuggetDir: "static/nuggets",
  // Disable in development — use normal bundles for fast HMR
  disabled: process.env.NODE_ENV === "development",
};

class LazyHandlerPlugin {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  apply(compiler) {
    if (this.options.disabled) return;

    const { eventProps, injectRuntime, nuggetDir, belowFoldThreshold } = this.options;
    const { webpack } = compiler;
    const { EntryPlugin, NormalModule, sources, DefinePlugin } = webpack;

    // Inject build-time constants into the runtime so it picks up the
    // user-configured directory, below-fold lookahead, and publicPath.
    // DefinePlugin substitutes literals at build time, so there is no
    // runtime lookup cost. __NUGGET_BASE__ is mapped to webpack's own
    // __webpack_public_path__ rewriter — an *unquoted* expression so the
    // value is the runtime publicPath, not the string "__webpack_public_path__".
    new DefinePlugin({
      __NUGGET_DIR__: JSON.stringify(nuggetDir),
      __NUGGET_ROOT_MARGIN__: JSON.stringify(`${belowFoldThreshold}px`),
      __NUGGET_BASE__: "__webpack_public_path__",
    }).apply(compiler);

    // ── Clear registry at the start of every build ─────────────────────────
    compiler.hooks.beforeRun.tap("LazyHandlerPlugin", () => {
      nuggetRegistry.clear();
    });

    // ── Inject our Babel loader for JSX/TSX source files ───────────────────
    // enforce: "pre" ensures it runs before babel-loader or ts-loader
    compiler.options.module.rules.push({
      test: /\.(jsx|tsx)$/,
      exclude: /node_modules/,
      enforce: "pre",
      use: [
        {
          loader: require.resolve("./loader"),
          options: {
            eventProps,
            minHandlerLines: this.options.minHandlerLines,
          },
        },
      ],
    });

    // ── Inject the tiny runtime as an additional entry ──────────────────────
    if (injectRuntime) {
      new EntryPlugin(
        compiler.context,
        require.resolve("../../runtime/nugget-runtime"),
        { name: undefined } // attach to existing entry rather than creating a new chunk
      ).apply(compiler);
    }

    compiler.hooks.thisCompilation.tap(
      "LazyHandlerPlugin",
      (compilation, { normalModuleFactory }) => {

        // ── Resolve nugget:// virtual module scheme ─────────────────────────
        normalModuleFactory.hooks.resolveForScheme
          .for("nugget")
          .tap("LazyHandlerPlugin", (resourceData) => {
            // nugget://nugget-a3f7c9b1 → resolved as a virtual resource
            resourceData.path = resourceData.resource;
            resourceData.query = "";
            resourceData.fragment = "";
            return true;
          });

        // ── No-op the loader list for nugget modules ────────────────────────
        // The source from readResource is already valid JS — no further
        // transformation needed (and nothing in the loader chain matches
        // the `nugget://...` resource anyway).
        normalModuleFactory.hooks.createModuleClass
          .for("nugget")
          .tap("LazyHandlerPlugin", (createData) => {
            createData.loaders = [];
          });

        // ── Serve virtual nugget source from the registry ───────────────────
        // resource looks like `nugget://nugget-a3f7c9b1`. Strip the scheme,
        // look up the registered source by chunk name, and hand it back.
        NormalModule.getCompilationHooks(compilation).readResource
          .for("nugget")
          .tapAsync("LazyHandlerPlugin", (loaderContext, callback) => {
            const chunkName = loaderContext.resource.replace(/^nugget:\/\//, "");
            const meta = nuggetRegistry.getByChunk(chunkName);
            if (!meta || typeof meta.source !== "string") {
              return callback(new Error(
                `[LazyHandler] No registered source for "${chunkName}". ` +
                `The loader did not register this nugget — possibly a stale chunk reference.`
              ));
            }
            callback(null, Buffer.from(meta.source, "utf8"));
          });

        // ── Mark all nugget- chunks as async-only (never in initial load) ───
        compilation.hooks.seal.tap("LazyHandlerPlugin", () => {
          for (const chunk of compilation.chunks) {
            if (chunk.name?.startsWith("nugget-")) {
              chunk.canBeInitial = () => false;
            }
          }
        });

        // ── Emit a nugget manifest JSON alongside the build assets ──────────
        compilation.hooks.processAssets.tap(
          {
            name: "LazyHandlerPlugin",
            stage: compilation.constructor.PROCESS_ASSETS_STAGE_SUMMARIZE,
          },
          () => {
            const registry = nuggetRegistry.getAll();
            const manifest = {
              version: 1,
              nuggetDir,
              handlers: Object.fromEntries(
                Object.entries(registry).map(([id, meta]) => [
                  id,
                  {
                    chunk: `${nuggetDir}/${meta.chunkName}.js`,
                    sourceFile: meta.sourceFile,
                    prop: meta.prop,
                  },
                ])
              ),
            };

            compilation.emitAsset(
              "nugget-manifest.json",
              new sources.RawSource(JSON.stringify(manifest, null, 2))
            );
          }
        );
      }
    );
  }
}

module.exports = LazyHandlerPlugin;
