// examples/webpack.config.js
const path = require("path");
const LazyHandlerPlugin = require("lazy-handler-plugin");

module.exports = {
  entry: "./src/index.jsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].[contenthash:8].js",
    // Nugget chunks MUST be emitted under `nuggetDir` and named by their
    // chunk name (the `[name]` token), because the runtime preload URL is
    // `publicPath + nuggetDir + chunkName + ".js"`. Everything else can use
    // your normal chunk-naming scheme.
    chunkFilename: (pathData) => {
      const name = pathData.chunk && pathData.chunk.name;
      if (name && name.startsWith("nugget-")) {
        return "static/nuggets/[name].js";
      }
      return "static/chunks/[name].[contenthash:8].js";
    },
    publicPath: "/",
    clean: true,
  },
  resolve: {
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  module: {
    rules: [
      {
        test: /\.(jsx|tsx)$/,
        exclude: /node_modules/,
        use: "babel-loader",
      },
    ],
  },
  plugins: [
    new LazyHandlerPlugin({
      // Prop names to auto-extract (add more as needed)
      eventProps: ["onClick", "onSubmit", "onChange", "onKeyDown"],

      // Skip handlers with fewer lines (leave one-liners inline)
      minHandlerLines: 3,

      // Inject the ~600 byte runtime automatically
      injectRuntime: true,

      // Auto-preload chunks for elements > 600px from top
      belowFoldThreshold: 600,

      // Output path for nugget chunks
      nuggetDir: "static/nuggets",

      // Automatically disabled in development for fast HMR
      // disabled: process.env.NODE_ENV === "development",
    }),
  ],
  optimization: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        // Keep nugget chunks isolated from vendor/app chunks
        nuggets: {
          test: /nugget-/,
          priority: 30,
          reuseExistingChunk: false,
        },
      },
    },
  },
};
