const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const LazyHandlerPlugin = require("lazy-handler-plugin");

module.exports = {
  entry: "./src/index.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "[name].[contenthash:8].js",
    // Route nugget chunks to /static/nuggets/ (matches what the runtime preloads),
    // everything else goes to /static/chunks/.
    chunkFilename: (pathData) => {
      const name = pathData.chunk && pathData.chunk.name;
      if (name && name.startsWith("nugget-")) {
        return "static/nuggets/[name].js";
      }
      return "static/chunks/[name].[contenthash:8].js";
    },
    clean: true,
    publicPath: "/",
  },
  resolve: {
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  module: {
    rules: [
      {
        test: /\.(jsx|tsx|js|ts)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [
              ["@babel/preset-env", { targets: "defaults" }],
              ["@babel/preset-react", { runtime: "automatic" }],
              "@babel/preset-typescript",
            ],
          },
        },
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: "./public/index.html",
    }),
    new LazyHandlerPlugin({
      eventProps: [
        "onClick", "onSubmit", "onChange", "onKeyDown", "onKeyUp",
        "onBlur", "onFocus", "onMouseEnter", "onMouseLeave",
        "onPointerDown", "onDrop", "onDragStart",
      ],
      minHandlerLines: 3,
      injectRuntime: true,
      belowFoldThreshold: 600,
      nuggetDir: "static/nuggets",
      // Toggle off with NUGGET_DISABLED=1 for baseline comparison.
      disabled: process.env.NUGGET_DISABLED === "1" || process.env.NODE_ENV === "development",
    }),
  ],
  optimization: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        nuggets: {
          test: /nugget-/,
          priority: 30,
          reuseExistingChunk: false,
        },
      },
    },
  },
  devServer: {
    historyApiFallback: true,
    port: 3000,
    hot: true,
    open: false,
  },
};
