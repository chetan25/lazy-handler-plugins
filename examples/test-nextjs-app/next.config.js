const LazyHandlerPlugin = require("lazy-handler-plugin");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  webpack(config, { isServer, dev, webpack }) {
    // Run the plugin on BOTH server and client compiles. The server pass
    // doesn't ship the nugget chunks, but it must run the JSX transform so
    // SSR HTML carries the `data-nugget-lazy` attributes — otherwise React's
    // hydration accepts the bare SSR DOM as authoritative and the runtime
    // IntersectionObserver finds nothing to preload. The runtime's
    // state-mutating functions are guarded with typeof-window so the
    // server-side render-body register calls are no-ops.

    // Don't run during `next dev`. Handler extraction defeats HMR — the
    // plugin's own `disabled` default already covers this via NODE_ENV, but
    // we short-circuit explicitly so the rule-rewriting doesn't fight HMR.
    if (dev) return config;

    // The chunkFilename override below only applies to client output —
    // server bundles don't emit nugget-* chunks, but the loader still needs
    // to run to produce the attribute on SSR output.
    if (isServer) {
      config.plugins.push(
        new LazyHandlerPlugin({
          eventProps: [
            "onClick", "onSubmit", "onChange", "onKeyDown", "onKeyUp",
            "onBlur", "onFocus", "onMouseEnter", "onMouseLeave",
            "onPointerDown", "onDrop", "onDragStart",
          ],
          minHandlerLines: 3,
          injectRuntime: false, // runtime is client-only
          nuggetDir: "static/nuggets",
        })
      );
      return config;
    }

    // Allow opting out for baseline-vs-plugin bundle comparisons.
    if (process.env.NUGGET_DISABLED === "1") return config;

    // Route nugget chunks to .next/static/nuggets/ so the runtime's
    // modulepreload (which uses webpack publicPath + "static/nuggets/...")
    // can find them. Other chunks keep Next.js' default naming.
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

    config.plugins.push(
      new LazyHandlerPlugin({
        eventProps: ["onClick", "onSubmit", "onChange", "onKeyDown"],
        minHandlerLines: 3,
        injectRuntime: true,
        nuggetDir: "static/nuggets",
      })
    );

    return config;
  },
};

module.exports = nextConfig;
