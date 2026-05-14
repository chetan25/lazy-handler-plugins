// src/adapters/webpack/loader.js
// Webpack loader shim — forwards to the bundler-agnostic core transform.
// The plugin (./index.js) injects this loader into module.rules with the
// user-supplied options.
"use strict";

const { nuggetTransform } = require("../../core/transform");

module.exports = function nuggetLoader(source) {
  const callback = this.async();
  try {
    const { code, map } = nuggetTransform(source, this.resourcePath, this.getOptions());
    callback(null, code, map);
  } catch (err) {
    callback(err);
  }
};
